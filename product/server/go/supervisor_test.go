package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_QUACKLE_FAKE_WORKER") != "1" {
		return
	}
	ready := WorkerEvent{
		Protocol: protocolVersion,
		ID:       nil,
		Event:    "ready",
		Payload:  json.RawMessage(`{"worker_kind":"test","protocol_version":1,"board_id":"classic15","lexicon":{"id":"test"}}`),
	}
	emitFake(ready)
	if os.Getenv("QUACKLE_FAKE_NEVER_READ") == "1" {
		select {}
	}

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var req WorkRequest
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			os.Exit(2)
		}
		payload := struct {
			DelayMS   int    `json:"delay_ms"`
			Hang      bool   `json:"hang"`
			Crash     bool   `json:"crash"`
			Malformed bool   `json:"malformed"`
			Progress  bool   `json:"progress"`
			Marker    string `json:"marker"`
		}{}
		_ = json.Unmarshal(req.Payload, &payload)
		if payload.Marker != "" {
			_ = os.WriteFile(payload.Marker, []byte(req.ID), 0o600)
		}
		startedPayload, _ := json.Marshal(map[string]string{"op": req.Op})
		emitFake(WorkerEvent{Protocol: 1, ID: &req.ID, Event: "started", Payload: startedPayload})
		if payload.Crash {
			os.Exit(7)
		}
		if payload.Malformed {
			fmt.Println("not-json")
			continue
		}
		if payload.Hang {
			select {}
		}
		if payload.DelayMS > 0 {
			time.Sleep(time.Duration(payload.DelayMS) * time.Millisecond)
		}
		if payload.Progress {
			progressPayload, _ := json.Marshal(map[string]any{"fraction": 0.5, "elapsed_ms": payload.DelayMS})
			emitFake(WorkerEvent{Protocol: 1, ID: &req.ID, Event: "progress", Payload: progressPayload})
		}
		resultPayload, _ := json.Marshal(map[string]any{
			"op":         req.Op,
			"elapsed_ms": payload.DelayMS,
			"data":       map[string]any{"id": req.ID},
		})
		emitFake(WorkerEvent{Protocol: 1, ID: &req.ID, Event: "result", Payload: resultPayload})
	}
	os.Exit(0)
}

func emitFake(event WorkerEvent) {
	line, _ := json.Marshal(event)
	_, _ = os.Stdout.Write(append(line, '\n'))
}

func newTestSupervisor(t *testing.T, extraEnv ...string) *Supervisor {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	env := append(os.Environ(), "GO_WANT_QUACKLE_FAKE_WORKER=1")
	env = append(env, extraEnv...)
	s, err := StartSupervisor(ctx, SupervisorConfig{
		WorkerBin:      os.Args[0],
		DataDir:        "/test/data",
		LexiconID:      "nwl23",
		Dawg:           "/test/lexicon.dawg",
		Gaddag:         "/test/lexicon.gaddag",
		StartupTimeout: time.Second,
		RestartDelay:   5 * time.Millisecond,
		Logger:         log.New(io.Discard, "", 0),
		Stderr:         io.Discard,
		ExtraArgs:      []string{"-test.run=TestHelperProcess", "--"},
		Env:            env,
	})
	if err != nil {
		t.Fatalf("StartSupervisor: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

func testRequest(id string, deadlineMS int, payload string) WorkRequest {
	return WorkRequest{
		Protocol:   1,
		ID:         id,
		Op:         opGenerateMoves,
		DeadlineMS: deadlineMS,
		Seed:       1,
		Payload:    json.RawMessage(payload),
	}
}

func TestSupervisorSerializesRequests(t *testing.T) {
	s := newTestSupervisor(t)
	marker := filepath.Join(t.TempDir(), "started")
	firstDone := make(chan CallResult, 1)
	go func() {
		firstDone <- s.Do(context.Background(), testRequest("first", 1000, fmt.Sprintf(`{"delay_ms":150,"marker":%q}`, marker)))
	}()
	waitForFile(t, marker)

	started := time.Now()
	second := s.Do(context.Background(), testRequest("second", 1000, `{}`))
	elapsed := time.Since(started)
	first := <-firstDone
	if first.Status != 200 || second.Status != 200 {
		t.Fatalf("unexpected statuses: first=%d second=%d", first.Status, second.Status)
	}
	if elapsed < 100*time.Millisecond {
		t.Fatalf("second request was not serialized; completed in %s", elapsed)
	}
}

func TestSupervisorDeadlineKillsAndReplacesChild(t *testing.T) {
	s := newTestSupervisor(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	result := s.Do(ctx, testRequest("slow", 60, `{"hang":true}`))
	if result.Status != 504 || result.Event.Error == nil || result.Event.Error.Code != "deadline_exceeded" {
		t.Fatalf("deadline result = %#v", result)
	}
	waitForGeneration(t, s, 2)
	result = s.Do(context.Background(), testRequest("after-timeout", 1000, `{}`))
	if result.Status != 200 || result.Event.Event != "result" {
		t.Fatalf("request after replacement = %#v", result)
	}
}

func TestSupervisorDeadlineInterruptsBlockedStdinWrite(t *testing.T) {
	s := newTestSupervisor(t, "QUACKLE_FAKE_NEVER_READ=1")
	payload, err := json.Marshal(map[string]string{"padding": string(bytes.Repeat([]byte{'x'}, 1<<20))})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result := s.Do(ctx, testRequest("blocked-write", 50, string(payload)))
	if result.Status != 504 || result.Event.Error == nil || result.Event.Error.Code != "deadline_exceeded" {
		t.Fatalf("blocked write deadline result = %#v", result)
	}
}

func TestSupervisorCrashAndMalformedOutputAreReplaced(t *testing.T) {
	for name, payload := range map[string]string{
		"crash":     `{"crash":true}`,
		"malformed": `{"malformed":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			s := newTestSupervisor(t)
			result := s.Do(context.Background(), testRequest(name, 1000, payload))
			if result.Status != 503 {
				t.Fatalf("failure status = %d, want 503", result.Status)
			}
			waitForGeneration(t, s, 2)
			result = s.Do(context.Background(), testRequest("recovered", 1000, `{}`))
			if result.Status != 200 {
				t.Fatalf("recovery status = %d", result.Status)
			}
		})
	}
}

func TestSupervisorCancellationKillsActiveAnalysisAndIsIdempotent(t *testing.T) {
	s := newTestSupervisor(t)
	marker := filepath.Join(t.TempDir(), "started")
	request := testRequest("analysis-1", 10_000, fmt.Sprintf(`{"hang":true,"marker":%q}`, marker))
	request.Op = opAnalyze
	runDone := make(chan CallResult, 1)
	go func() { runDone <- s.Do(context.Background(), request) }()
	waitForFile(t, marker)

	cancel := CancelRequest{Protocol: 1, ID: "cancel-1", Op: opCancel, Payload: CancelPayload{TargetID: request.ID}}
	cancelResult := s.Cancel(context.Background(), cancel)
	if cancelResult.Status != 200 || cancelResult.Event.Event != "cancelled" {
		t.Fatalf("cancel result = %#v", cancelResult)
	}
	runResult := <-runDone
	if runResult.Status != 200 || runResult.Event.Event != "cancelled" {
		t.Fatalf("run result = %#v", runResult)
	}
	waitForGeneration(t, s, 2)

	cancel.ID = "cancel-2"
	cancelResult = s.Cancel(context.Background(), cancel)
	if cancelResult.Status != 200 || cancelResult.Event.Event != "cancelled" {
		t.Fatalf("idempotent cancel result = %#v", cancelResult)
	}
}

func TestHTTPInternalEndpoints(t *testing.T) {
	s := newTestSupervisor(t)
	server := httptest.NewServer(NewHTTPHandler(s, 1024))
	defer server.Close()

	for path, key := range map[string]string{
		"/internal/live":  "live",
		"/internal/ready": "ready",
	} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]bool
		decodeResponse(t, response, &body)
		if response.StatusCode != 200 || !body[key] {
			t.Fatalf("GET %s: status=%d body=%v", path, response.StatusCode, body)
		}
	}

	response, err := http.Get(server.URL + "/internal/meta")
	if err != nil {
		t.Fatal(err)
	}
	var meta SupervisorMeta
	decodeResponse(t, response, &meta)
	if response.StatusCode != 200 || !meta.Ready || meta.Generation != 1 || len(meta.Worker) == 0 {
		t.Fatalf("meta: status=%d body=%+v", response.StatusCode, meta)
	}

	requestBody := `{"protocol":1,"id":"http-1","op":"generate_moves","deadline_ms":1000,"seed":1,"payload":{}}`
	response = postJSON(t, server.URL+"/internal/moves/generate", requestBody)
	var event WorkerEvent
	decodeResponse(t, response, &event)
	if response.StatusCode != 200 || event.Event != "result" {
		t.Fatalf("generate: status=%d body=%+v", response.StatusCode, event)
	}

	validateBody := `{"protocol":1,"id":"validate-http","op":"validate_move","deadline_ms":1000,"seed":1,"payload":{}}`
	response = postJSON(t, server.URL+"/internal/moves/validate", validateBody)
	decodeResponse(t, response, &event)
	if response.StatusCode != 200 || event.Event != "result" {
		t.Fatalf("validate: status=%d body=%+v", response.StatusCode, event)
	}

	analysisBody := `{"protocol":1,"id":"analysis-http","op":"analyze","deadline_ms":1000,"seed":1,"payload":{"progress":true}}`
	response = postJSON(t, server.URL+"/internal/analysis/run", analysisBody)
	streamEvents := decodeStreamEvents(t, response)
	event = streamEvents[len(streamEvents)-1]
	if response.StatusCode != 200 || event.Event != "result" {
		t.Fatalf("analysis: status=%d body=%+v", response.StatusCode, event)
	}
	if len(streamEvents) < 3 || streamEvents[0].Event != "started" || streamEvents[1].Event != "progress" {
		t.Fatalf("analysis stream events = %+v", streamEvents)
	}

	response = postJSON(t, server.URL+"/internal/moves/validate", requestBody)
	decodeResponse(t, response, &event)
	if response.StatusCode != 400 || event.Error == nil || event.Error.Code != "invalid_request" {
		t.Fatalf("wrong route op: status=%d body=%+v", response.StatusCode, event)
	}

	response = postJSON(t, server.URL+"/internal/analysis/cancel", `{"protocol":1,"id":"cancel-http","op":"cancel","payload":{"target_id":"missing"}}`)
	decodeResponse(t, response, &event)
	if response.StatusCode != 200 || event.Event != "cancelled" {
		t.Fatalf("cancel: status=%d body=%+v", response.StatusCode, event)
	}
}

func TestHTTPAnalysisChildExitProducesTerminalError(t *testing.T) {
	s := newTestSupervisor(t)
	server := httptest.NewServer(NewHTTPHandler(s, defaultMaxRequestBytes))
	defer server.Close()

	response := postJSON(t, server.URL+"/internal/analysis/run", `{"protocol":1,"id":"analysis-child-exit","op":"analyze","deadline_ms":1000,"seed":1,"payload":{"crash":true}}`)
	events := decodeStreamEvents(t, response)
	terminal := events[len(events)-1]
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stream status = %d, want 200 headers with terminal protocol error", response.StatusCode)
	}
	if terminal.Event != "error" || terminal.Error == nil || terminal.Error.Code != "worker_unavailable" || !terminal.Error.Retryable {
		t.Fatalf("child-exit terminal event = %+v", terminal)
	}
	waitForGeneration(t, s, 2)
}

func TestHTTPAnalysisQueueGraceAllowsSerializedJobs(t *testing.T) {
	s := newTestSupervisor(t)
	server := httptest.NewServer(NewHTTPHandler(s, defaultMaxRequestBytes))
	defer server.Close()

	const count = 2
	results := make(chan struct {
		status int
		events []WorkerEvent
	}, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := fmt.Sprintf(`{"protocol":1,"id":"analysis-queue-%d","op":"analyze","deadline_ms":1000,"seed":1,"payload":{"delay_ms":1100}}`, i)
			response := postJSON(t, server.URL+"/internal/analysis/run", body)
			results <- struct {
				status int
				events []WorkerEvent
			}{status: response.StatusCode, events: decodeStreamEvents(t, response)}
		}(i)
	}
	wg.Wait()
	close(results)
	for result := range results {
		terminal := result.events[len(result.events)-1]
		if result.status != http.StatusOK || terminal.Event != "result" {
			t.Fatalf("serialized analysis result = status %d events %+v", result.status, result.events)
		}
	}
}

func TestHTTPAnalysisOverloadReturns503BeforeStreamingHeaders(t *testing.T) {
	s := newTestSupervisor(t)
	server := httptest.NewServer(NewHTTPHandler(s, defaultMaxRequestBytes))
	defer server.Close()

	marker := filepath.Join(t.TempDir(), "started")
	first := testRequest("first-http", 10_000, fmt.Sprintf(`{"op":"analyze","hang":true,"marker":%q}`, marker))
	first.Op = opAnalyze
	firstDone := make(chan CallResult, 1)
	go func() { firstDone <- s.Do(context.Background(), first) }()
	waitForFile(t, marker)

	secondCtx, cancelSecond := context.WithCancel(context.Background())
	secondDone := make(chan CallResult, 1)
	second := testRequest("second-http", 10_000, `{}`)
	second.Op = opAnalyze
	go func() { secondDone <- s.Do(secondCtx, second) }()
	time.Sleep(20 * time.Millisecond)

	response := postJSON(t, server.URL+"/internal/analysis/run", `{"protocol":1,"id":"third-http","op":"analyze","deadline_ms":1000,"seed":1,"payload":{}}`)
	var event WorkerEvent
	decodeResponse(t, response, &event)
	if response.StatusCode != http.StatusServiceUnavailable || event.Error == nil || event.Error.Code != "engine_overloaded" || !event.Error.Retryable {
		t.Fatalf("overload response: status=%d event=%+v", response.StatusCode, event)
	}

	cancelResult := s.Cancel(context.Background(), CancelRequest{Protocol: 1, ID: "cancel-first-http", Op: opCancel, Payload: CancelPayload{TargetID: first.ID}})
	if cancelResult.Status != 200 || cancelResult.Event.Event != "cancelled" {
		t.Fatalf("cancel result = %#v", cancelResult)
	}
	cancelSecond()
	if result := <-firstDone; result.Event.Event != "cancelled" {
		t.Fatalf("first result = %#v", result)
	}
	if result := <-secondDone; result.Event.Error == nil || result.Event.Error.Code != "request_cancelled" {
		t.Fatalf("second result = %#v", result)
	}
}

func TestHTTPValidationAndBodyLimit(t *testing.T) {
	s := newTestSupervisor(t)
	handler := NewHTTPHandler(s, 128)

	req := httptest.NewRequest(http.MethodPost, "/internal/moves/generate", stringsReader(`{}`))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("missing content type status = %d", recorder.Code)
	}

	oversized := `{"protocol":1,"id":"large","op":"generate_moves","deadline_ms":1000,"seed":1,"payload":{"padding":"` + string(bytes.Repeat([]byte{'x'}, 200)) + `"}}`
	req = httptest.NewRequest(http.MethodPost, "/internal/moves/generate", stringsReader(oversized))
	req.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestProtocolValidation(t *testing.T) {
	valid := []byte(`{"protocol":1,"id":"job","op":"generate_moves","deadline_ms":1000,"seed":0,"payload":{}}`)
	if _, err := decodeWorkRequest(valid, opGenerateMoves); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	for name, body := range map[string][]byte{
		"missing seed":  []byte(`{"protocol":1,"id":"job","op":"generate_moves","deadline_ms":1000,"payload":{}}`),
		"unknown field": []byte(`{"protocol":1,"id":"job","op":"generate_moves","deadline_ms":1000,"seed":0,"payload":{},"extra":true}`),
		"array payload": []byte(`{"protocol":1,"id":"job","op":"generate_moves","deadline_ms":1000,"seed":0,"payload":[]}`),
		"wrong op":      []byte(`{"protocol":1,"id":"job","op":"analyze","deadline_ms":1000,"seed":0,"payload":{}}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeWorkRequest(body, opGenerateMoves); err == nil {
				t.Fatal("invalid request was accepted")
			}
		})
	}
	if _, err := decodeCancelRequest([]byte(`{"protocol":1,"id":"cancel","op":"cancel","payload":{"target_id":"job","extra":true}}`)); err == nil {
		t.Fatal("cancel payload with unknown field was accepted")
	}
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func waitForGeneration(t *testing.T, s *Supervisor, generation uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.Meta().Generation >= generation && s.Ready() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for generation %d; meta=%+v", generation, s.Meta())
}

func postJSON(t *testing.T, url, body string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, stringsReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func decodeResponse(t *testing.T, response *http.Response, dst any) {
	t.Helper()
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(dst); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func decodeStreamEvents(t *testing.T, response *http.Response) []WorkerEvent {
	t.Helper()
	defer response.Body.Close()
	var events []WorkerEvent
	scanner := bufio.NewScanner(response.Body)
	for scanner.Scan() {
		var event WorkerEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatalf("decode streaming event: %v", err)
		}
		events = append(events, event)
		if event.Event == "result" || event.Event == "error" || event.Event == "cancelled" {
			return events
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("read streaming response: %v", err)
	}
	t.Fatal("stream ended before terminal event")
	return nil
}

func decodeStreamTerminal(t *testing.T, response *http.Response, dst *WorkerEvent) {
	events := decodeStreamEvents(t, response)
	*dst = events[len(events)-1]
}

func stringsReader(value string) io.Reader { return bytes.NewBufferString(value) }

func TestSupervisorRejectsWhenQueueFull(t *testing.T) {
	s := newTestSupervisor(t)
	marker := filepath.Join(t.TempDir(), "started")
	firstDone := make(chan CallResult, 1)
	go func() {
		firstDone <- s.Do(context.Background(), testRequest("first", 10_000, fmt.Sprintf(`{"hang":true,"marker":%q}`, marker)))
	}()
	waitForFile(t, marker)

	secondCtx, cancelSecond := context.WithCancel(context.Background())
	secondDone := make(chan CallResult, 1)
	go func() {
		secondDone <- s.Do(secondCtx, testRequest("second", 10_000, `{}`))
	}()
	time.Sleep(20 * time.Millisecond)
	third := s.Do(context.Background(), testRequest("third", 1000, `{}`))
	if third.Status != 503 || third.Event.Error == nil || third.Event.Error.Code != "engine_overloaded" {
		t.Fatalf("overload result = %#v", third)
	}

	cancelRequest := CancelRequest{Protocol: 1, ID: "cancel-first", Op: opCancel, Payload: CancelPayload{TargetID: "first"}}
	cancelResult := s.Cancel(context.Background(), cancelRequest)
	if cancelResult.Status != 200 || cancelResult.Event.Event != "cancelled" {
		t.Fatalf("cancel result = %#v", cancelResult)
	}
	cancelSecond()
	first := <-firstDone
	second := <-secondDone
	if first.Status != 200 || first.Event.Event != "cancelled" {
		t.Fatalf("first result = %#v", first)
	}
	if second.Status != 503 || second.Event.Error == nil || second.Event.Error.Code != "request_cancelled" {
		t.Fatalf("queued cancellation result = %#v", second)
	}
}
