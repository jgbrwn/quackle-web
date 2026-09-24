package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
)

const defaultMaxRequestBytes int64 = 256 << 10
const analysisQueueGrace = 15 * time.Second

type HTTPService struct {
	supervisor      *Supervisor
	maxRequestBytes int64
}

func NewHTTPHandler(supervisor *Supervisor, maxRequestBytes int64) http.Handler {
	if maxRequestBytes <= 0 {
		maxRequestBytes = defaultMaxRequestBytes
	}
	service := &HTTPService{supervisor: supervisor, maxRequestBytes: maxRequestBytes}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/live", service.live)
	mux.HandleFunc("GET /internal/ready", service.ready)
	mux.HandleFunc("GET /internal/meta", service.meta)
	mux.HandleFunc("POST /internal/moves/generate", service.work(opGenerateMoves))
	mux.HandleFunc("POST /internal/moves/validate", service.work(opValidateMove))
	mux.HandleFunc("POST /internal/analysis/run", service.work(opAnalyze))
	mux.HandleFunc("POST /internal/analysis/cancel", service.cancel)
	return mux
}

func (s *HTTPService) live(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"live": true})
}

func (s *HTTPService) ready(w http.ResponseWriter, _ *http.Request) {
	status := http.StatusOK
	ready := s.supervisor.Ready()
	if !ready {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]bool{"ready": ready})
}

func (s *HTTPService) meta(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.supervisor.Meta())
}

func (s *HTTPService) work(expectedOp string) http.HandlerFunc {
	if expectedOp == opAnalyze {
		return s.streamAnalysis
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if !hasJSONContentType(r.Header.Get("Content-Type")) {
			writeProtocolError(w, nil, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json", false)
			return
		}
		body, err := readBoundedBody(w, r, s.maxRequestBytes)
		if err != nil {
			status := http.StatusBadRequest
			code := "invalid_request"
			if errors.Is(err, errBodyTooLarge) {
				status = http.StatusRequestEntityTooLarge
				code = "request_too_large"
			}
			writeProtocolError(w, nil, status, code, err.Error(), false)
			return
		}
		req, err := decodeWorkRequest(body, expectedOp)
		if err != nil {
			writeProtocolError(w, optionalID(req.ID), http.StatusBadRequest, "invalid_request", err.Error(), false)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(req.DeadlineMS)*time.Millisecond)
		defer cancel()
		result := s.supervisor.Do(ctx, req)
		writeJSON(w, result.Status, result.Event)
	}
}

func (s *HTTPService) streamAnalysis(w http.ResponseWriter, r *http.Request) {
	if !hasJSONContentType(r.Header.Get("Content-Type")) {
		writeProtocolError(w, nil, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json", false)
		return
	}
	body, err := readBoundedBody(w, r, s.maxRequestBytes)
	if err != nil {
		status := http.StatusBadRequest
		code := "invalid_request"
		if errors.Is(err, errBodyTooLarge) {
			status = http.StatusRequestEntityTooLarge
			code = "request_too_large"
		}
		writeProtocolError(w, nil, status, code, err.Error(), false)
		return
	}
	req, err := decodeWorkRequest(body, opAnalyze)
	if err != nil {
		writeProtocolError(w, optionalID(req.ID), http.StatusBadRequest, "invalid_request", err.Error(), false)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeProtocolError(w, &req.ID, http.StatusInternalServerError, "streaming_unavailable", "analysis streaming is unavailable", true)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(req.DeadlineMS)*time.Millisecond+analysisQueueGrace)
	defer cancel()
	progress := make(chan WorkerEvent, 16)
	done := make(chan struct{})
	var closeDone sync.Once
	defer closeDone.Do(func() { close(done) })
	callback := func(event WorkerEvent) {
		select {
		case progress <- event:
		case <-done:
		case <-ctx.Done():
		}
	}
	result := make(chan CallResult, 1)
	go func() {
		result <- s.supervisor.DoWithProgress(ctx, req, callback)
	}()

	writeEvent := func(event WorkerEvent) bool {
		line, marshalErr := json.Marshal(event)
		if marshalErr != nil {
			cancel()
			return false
		}
		if _, writeErr := w.Write(append(line, '\n')); writeErr != nil {
			cancel()
			return false
		}
		flusher.Flush()
		return true
	}
	writeHeaders := func() {
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
	}

	headersWritten := false
	for {
		if !headersWritten {
			select {
			case event := <-progress:
				writeHeaders()
				headersWritten = true
				if !writeEvent(event) {
					return
				}
			case terminal := <-result:
				select {
				case event := <-progress:
					writeHeaders()
					headersWritten = true
					if !writeEvent(event) {
						return
					}
					for {
						select {
						case event := <-progress:
							if !writeEvent(event) {
								return
							}
						default:
							_ = writeEvent(terminal.Event)
							return
						}
					}
				default:
					writeJSON(w, terminal.Status, terminal.Event)
					return
				}
			case <-ctx.Done():
				writeProtocolError(w, &req.ID, http.StatusGatewayTimeout, "deadline_exceeded", "request deadline exceeded", true)
				return
			}
			continue
		}
		select {
		case event := <-progress:
			if !writeEvent(event) {
				return
			}
		case terminal := <-result:
			_ = writeEvent(terminal.Event)
			return
		case <-ctx.Done():
			return
		}
	}
}

func (s *HTTPService) cancel(w http.ResponseWriter, r *http.Request) {
	if !hasJSONContentType(r.Header.Get("Content-Type")) {
		writeProtocolError(w, nil, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json", false)
		return
	}
	body, err := readBoundedBody(w, r, s.maxRequestBytes)
	if err != nil {
		status := http.StatusBadRequest
		code := "invalid_request"
		if errors.Is(err, errBodyTooLarge) {
			status = http.StatusRequestEntityTooLarge
			code = "request_too_large"
		}
		writeProtocolError(w, nil, status, code, err.Error(), false)
		return
	}
	req, err := decodeCancelRequest(body)
	if err != nil {
		writeProtocolError(w, optionalID(req.ID), http.StatusBadRequest, "invalid_request", err.Error(), false)
		return
	}
	result := s.supervisor.Cancel(r.Context(), req)
	writeJSON(w, result.Status, result.Event)
}

var errBodyTooLarge = errors.New("request body exceeds configured limit")

func readBoundedBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	reader := http.MaxBytesReader(w, r.Body, limit)
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, errBodyTooLarge
		}
		return nil, errors.New("could not read request body")
	}
	return body, nil
}

func hasJSONContentType(value string) bool {
	if value == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && strings.EqualFold(mediaType, "application/json")
}

func optionalID(id string) *string {
	if id == "" {
		return nil
	}
	return &id
}

func writeProtocolError(w http.ResponseWriter, id *string, status int, code, message string, retryable bool) {
	writeJSON(w, status, eventError(id, code, message, retryable))
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
