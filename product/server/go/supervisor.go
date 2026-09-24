package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"sync"
	"time"
	"unicode/utf8"
)

const maxWorkerLineBytes = 4 << 20
const defaultMaxQueuedRequests = 1

type SupervisorConfig struct {
	WorkerBin      string
	DataDir        string
	LexiconID      string
	Dawg           string
	Gaddag         string
	StartupTimeout time.Duration
	RestartDelay   time.Duration
	ShutdownGrace  time.Duration
	Logger         *log.Logger
	Stderr         io.Writer
	ExtraArgs      []string
	Env            []string
	MaxQueued      int
}

type CallResult struct {
	Event  WorkerEvent
	Status int
}

type SupervisorMeta struct {
	Protocol       int             `json:"protocol"`
	Ready          bool            `json:"ready"`
	Generation     uint64          `json:"generation"`
	Restarts       uint64          `json:"restarts"`
	Worker         json.RawMessage `json:"worker,omitempty"`
	LastStartError string          `json:"last_start_error,omitempty"`
}

type workCall struct {
	ctx      context.Context
	request  WorkRequest
	progress func(WorkerEvent)
	response chan CallResult
}

type cancelCall struct {
	ctx      context.Context
	request  CancelRequest
	response chan CallResult
}

type Supervisor struct {
	cfg      SupervisorConfig
	requests chan workCall
	cancels  chan cancelCall
	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once

	lifecycleCtx    context.Context
	lifecycleCancel context.CancelFunc

	metaMu sync.RWMutex
	meta   SupervisorMeta
}

type childProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	events chan workerRead
	done   chan struct{}
	errMu  sync.Mutex
	err    error
}

type workerRead struct {
	event WorkerEvent
	err   error
}

func StartSupervisor(ctx context.Context, cfg SupervisorConfig) (*Supervisor, error) {
	if cfg.WorkerBin == "" {
		return nil, errors.New("worker binary is required")
	}
	if cfg.DataDir == "" {
		return nil, errors.New("worker data directory is required")
	}
	if cfg.LexiconID == "" {
		cfg.LexiconID = "nwl23"
	}
	if cfg.Dawg == "" {
		return nil, errors.New("worker DAWG path is required")
	}
	if cfg.Gaddag == "" {
		return nil, errors.New("worker GADDAG path is required")
	}
	if cfg.StartupTimeout <= 0 {
		cfg.StartupTimeout = 15 * time.Second
	}
	if cfg.RestartDelay <= 0 {
		cfg.RestartDelay = 50 * time.Millisecond
	}
	if cfg.ShutdownGrace <= 0 {
		cfg.ShutdownGrace = 500 * time.Millisecond
	}
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	if cfg.Stderr == nil {
		cfg.Stderr = cfg.Logger.Writer()
	}

	if cfg.MaxQueued <= 0 {
		cfg.MaxQueued = defaultMaxQueuedRequests
	}
	lifecycleCtx, lifecycleCancel := context.WithCancel(context.Background())
	s := &Supervisor{
		cfg:             cfg,
		requests:        make(chan workCall, cfg.MaxQueued),
		cancels:         make(chan cancelCall),
		stop:            make(chan struct{}),
		done:            make(chan struct{}),
		lifecycleCtx:    lifecycleCtx,
		lifecycleCancel: lifecycleCancel,
		meta:            SupervisorMeta{Protocol: protocolVersion},
	}

	child, ready, err := s.startChild(ctx)
	if err != nil {
		lifecycleCancel()
		return nil, err
	}
	s.recordStarted(ready, false)
	go s.run(child)
	return s, nil
}

func (s *Supervisor) Do(ctx context.Context, req WorkRequest) CallResult {
	return s.DoWithProgress(ctx, req, nil)
}

func (s *Supervisor) DoWithProgress(ctx context.Context, req WorkRequest, progress func(WorkerEvent)) CallResult {
	call := workCall{ctx: ctx, request: req, progress: progress, response: make(chan CallResult, 1)}
	select {
	case s.requests <- call:
	case <-ctx.Done():
		return contextResult(req.ID, ctx.Err())
	case <-s.done:
		return unavailableResult(req.ID, "engine supervisor is stopped")
	default:
		return overloadedResult(req.ID)
	}
	select {
	case result := <-call.response:
		return result
	case <-ctx.Done():
		return contextResult(req.ID, ctx.Err())
	case <-s.done:
		return unavailableResult(req.ID, "engine supervisor is stopped")
	}
}

func (s *Supervisor) Cancel(ctx context.Context, req CancelRequest) CallResult {
	call := cancelCall{ctx: ctx, request: req, response: make(chan CallResult, 1)}
	select {
	case s.cancels <- call:
	case <-ctx.Done():
		return contextResult(req.ID, ctx.Err())
	case <-s.done:
		return unavailableResult(req.ID, "engine supervisor is stopped")
	}
	select {
	case result := <-call.response:
		return result
	case <-ctx.Done():
		return contextResult(req.ID, ctx.Err())
	case <-s.done:
		return unavailableResult(req.ID, "engine supervisor is stopped")
	}
}

func (s *Supervisor) Ready() bool {
	s.metaMu.RLock()
	defer s.metaMu.RUnlock()
	return s.meta.Ready
}

func (s *Supervisor) Meta() SupervisorMeta {
	s.metaMu.RLock()
	defer s.metaMu.RUnlock()
	copy := s.meta
	copy.Worker = append(json.RawMessage(nil), s.meta.Worker...)
	return copy
}

func (s *Supervisor) Close() {
	s.stopOnce.Do(func() {
		s.setReady(false)
		close(s.stop)
		s.lifecycleCancel()
	})
	<-s.done
}

func (s *Supervisor) run(child *childProcess) {
	defer close(s.done)
	defer s.setReady(false)
	for {
		select {
		case <-s.stop:
			child.stopGracefully(s.cfg.ShutdownGrace)
			return
		case <-child.done:
			s.cfg.Logger.Printf("native worker exited: %v", child.exitError())
			s.setReady(false)
			var ok bool
			child, ok = s.restartChild()
			if !ok {
				return
			}
		case call := <-s.requests:
			if err := call.ctx.Err(); err != nil {
				call.response <- contextResult(call.request.ID, err)
				continue
			}
			result, replace := s.execute(child, call)
			call.response <- result
			if replace {
				s.setReady(false)
				child.terminate()
				var ok bool
				child, ok = s.restartChild()
				if !ok {
					return
				}
			}
		case call := <-s.cancels:
			call.response <- CallResult{Event: cancelledEvent(call.request.ID, call.request.Payload.TargetID), Status: 200}
		}
	}
}

func (s *Supervisor) execute(child *childProcess, call workCall) (CallResult, bool) {
	line, err := json.Marshal(call.request)
	if err != nil {
		return internalResult(call.request.ID, "could not encode worker request"), false
	}
	line = append(line, '\n')
	writeDone := make(chan error, 1)
	go func() {
		_, err := child.stdin.Write(line)
		writeDone <- err
	}()

	for {
		select {
		case <-s.stop:
			child.stopGracefully(s.cfg.ShutdownGrace)
			return unavailableResult(call.request.ID, "engine supervisor is stopping"), false
		case <-call.ctx.Done():
			child.terminate()
			return contextResult(call.request.ID, call.ctx.Err()), true
		case cancel := <-s.cancels:
			if cancel.request.Payload.TargetID != call.request.ID {
				cancel.response <- CallResult{Event: cancelledEvent(cancel.request.ID, cancel.request.Payload.TargetID), Status: 200}
				continue
			}
			child.terminate()
			cancel.response <- CallResult{Event: cancelledEvent(cancel.request.ID, call.request.ID), Status: 200}
			return CallResult{Event: cancelledEvent(call.request.ID, call.request.ID), Status: 200}, true
		case <-child.done:
			s.cfg.Logger.Printf("native worker exited while accepting %s: %v", call.request.ID, child.exitError())
			return unavailableResult(call.request.ID, "native worker exited before accepting the request"), true
		case err := <-writeDone:
			if call.ctx.Err() != nil {
				child.terminate()
				return contextResult(call.request.ID, call.ctx.Err()), true
			}
			if err != nil {
				s.cfg.Logger.Printf("native worker write failed: %v", err)
				return unavailableResult(call.request.ID, "native worker became unavailable"), true
			}
			goto awaitEvents
		}
	}

awaitEvents:
	for {
		select {
		case <-s.stop:
			child.stopGracefully(s.cfg.ShutdownGrace)
			return unavailableResult(call.request.ID, "engine supervisor is stopping"), false
		case <-call.ctx.Done():
			child.terminate()
			return contextResult(call.request.ID, call.ctx.Err()), true
		case cancel := <-s.cancels:
			if cancel.request.Payload.TargetID != call.request.ID {
				cancel.response <- CallResult{Event: cancelledEvent(cancel.request.ID, cancel.request.Payload.TargetID), Status: 200}
				continue
			}
			child.terminate()
			cancel.response <- CallResult{Event: cancelledEvent(cancel.request.ID, call.request.ID), Status: 200}
			return CallResult{Event: cancelledEvent(call.request.ID, call.request.ID), Status: 200}, true
		case <-child.done:
			s.cfg.Logger.Printf("native worker exited during %s: %v", call.request.ID, child.exitError())
			return unavailableResult(call.request.ID, "native worker exited before completing the request"), true
		case read, ok := <-child.events:
			if call.ctx.Err() != nil {
				child.terminate()
				return contextResult(call.request.ID, call.ctx.Err()), true
			}
			if !ok {
				return unavailableResult(call.request.ID, "native worker output closed before completing the request"), true
			}
			if read.err != nil {
				s.cfg.Logger.Printf("invalid native worker output: %v", read.err)
				return protocolResult(call.request.ID, "native worker emitted invalid NDJSON"), true
			}
			event := read.event
			if err := validateWorkerEvent(event, call.request.ID); err != nil {
				s.cfg.Logger.Printf("invalid native worker event: %v", err)
				return protocolResult(call.request.ID, err.Error()), true
			}
			switch event.Event {
			case "started", "progress":
				if call.progress != nil {
					call.progress(event)
				}
				continue
			case "result", "cancelled":
				return CallResult{Event: event, Status: 200}, false
			case "error":
				status := 422
				if event.Error != nil && event.Error.Code == "deadline_exceeded" {
					status = 504
				} else if event.Error != nil && event.Error.Retryable {
					status = 503
				}
				return CallResult{Event: event, Status: status}, false
			default:
				return protocolResult(call.request.ID, "native worker emitted an unexpected event"), true
			}
		}
	}
}

func validateWorkerEvent(event WorkerEvent, requestID string) error {
	if event.Protocol != protocolVersion {
		return errors.New("native worker protocol mismatch")
	}
	if event.ID == nil || *event.ID != requestID {
		return errors.New("native worker event id mismatch")
	}
	if err := validateID(*event.ID); err != nil {
		return fmt.Errorf("native worker event id: %w", err)
	}
	switch event.Event {
	case "started", "progress", "result", "cancelled":
		if !isJSONObject(event.Payload) {
			return fmt.Errorf("native worker %s event requires an object payload", event.Event)
		}
		if event.Error != nil {
			return fmt.Errorf("native worker %s event must not include error", event.Event)
		}
	case "error":
		if event.Error == nil {
			return errors.New("native worker error event requires an error")
		}
		if n := utf8.RuneCountInString(event.Error.Code); n < 1 || n > 64 {
			return errors.New("native worker error code must contain between 1 and 64 characters")
		}
		if utf8.RuneCountInString(event.Error.Message) > 1024 {
			return errors.New("native worker error message exceeds 1024 characters")
		}
		if len(event.Error.Details) > 0 && !isJSONObject(event.Error.Details) {
			return errors.New("native worker error details must be an object")
		}
	default:
		return fmt.Errorf("unknown native worker event %q", event.Event)
	}
	return nil
}

func (s *Supervisor) restartChild() (*childProcess, bool) {
	first := true
	for {
		select {
		case <-s.stop:
			return nil, false
		default:
		}
		if !first {
			timer := time.NewTimer(s.cfg.RestartDelay)
			select {
			case <-timer.C:
			case <-s.stop:
				timer.Stop()
				return nil, false
			}
		}
		first = false

		ctx, cancel := context.WithTimeout(s.lifecycleCtx, s.cfg.StartupTimeout)
		child, ready, err := s.startChild(ctx)
		cancel()
		if err == nil {
			s.recordStarted(ready, true)
			return child, true
		}
		s.recordStartError(err)
		s.cfg.Logger.Printf("native worker restart failed: %v", err)
		select {
		case <-s.stop:
			return nil, false
		default:
		}
	}
}

func (s *Supervisor) startChild(ctx context.Context) (*childProcess, json.RawMessage, error) {
	args := append([]string(nil), s.cfg.ExtraArgs...)
	args = append(args, "--data-dir", s.cfg.DataDir, "--lexicon-id", s.cfg.LexiconID,
		"--dawg", s.cfg.Dawg, "--gaddag", s.cfg.Gaddag)
	cmd := exec.Command(s.cfg.WorkerBin, args...)
	if s.cfg.Env != nil {
		cmd.Env = append([]string(nil), s.cfg.Env...)
	}
	cmd.Stderr = s.cfg.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, fmt.Errorf("open worker stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, fmt.Errorf("open worker stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("start worker: %w", err)
	}

	child := &childProcess{cmd: cmd, stdin: stdin, events: make(chan workerRead, 8), done: make(chan struct{})}
	go child.readEvents(stdout)
	go func() {
		err := cmd.Wait()
		child.errMu.Lock()
		child.err = err
		child.errMu.Unlock()
		close(child.done)
	}()

	select {
	case <-ctx.Done():
		child.terminate()
		return nil, nil, fmt.Errorf("worker readiness: %w", ctx.Err())
	case <-child.done:
		return nil, nil, fmt.Errorf("worker exited before ready: %w", child.exitError())
	case read, ok := <-child.events:
		if !ok {
			child.terminate()
			return nil, nil, errors.New("worker stdout closed before ready")
		}
		if read.err != nil {
			child.terminate()
			return nil, nil, fmt.Errorf("invalid worker ready NDJSON: %w", read.err)
		}
		event := read.event
		if ctx.Err() != nil {
			child.terminate()
			return nil, nil, fmt.Errorf("worker readiness: %w", ctx.Err())
		}
		if event.Protocol != protocolVersion || event.ID != nil || event.Event != "ready" || !isJSONObject(event.Payload) || event.Error != nil {
			child.terminate()
			return nil, nil, errors.New("worker did not emit a valid ready event first")
		}
		return child, append(json.RawMessage(nil), event.Payload...), nil
	}
}

func (p *childProcess) readEvents(stdout io.Reader) {
	defer close(p.events)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), maxWorkerLineBytes)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		if len(line) == 0 {
			select {
			case p.events <- workerRead{err: errors.New("blank worker output line")}:
			case <-p.done:
			}
			return
		}
		var event WorkerEvent
		if err := decodeWorkerEvent(line, &event); err != nil {
			select {
			case p.events <- workerRead{err: err}:
			case <-p.done:
			}
			return
		}
		select {
		case p.events <- workerRead{event: event}:
		case <-p.done:
			return
		}
	}
	if err := scanner.Err(); err != nil {
		select {
		case p.events <- workerRead{err: err}:
		case <-p.done:
		}
	}
}

func decodeWorkerEvent(line []byte, event *WorkerEvent) error {
	if err := requireJSONFields(line, "protocol", "id", "event"); err != nil {
		return err
	}
	if err := decodeStrict(line, event); err != nil {
		return err
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(line, &object); err != nil {
		return err
	}
	if event.Event == "error" {
		if _, ok := object["error"]; !ok {
			return errors.New("worker error event is missing error")
		}
		var errorObject map[string]json.RawMessage
		if err := json.Unmarshal(object["error"], &errorObject); err != nil || errorObject == nil {
			return errors.New("worker error must be an object")
		}
		for _, field := range []string{"code", "message", "retryable"} {
			if _, ok := errorObject[field]; !ok {
				return fmt.Errorf("worker error field %q is required", field)
			}
		}
	} else {
		if _, ok := object["payload"]; !ok {
			return fmt.Errorf("worker %s event is missing payload", event.Event)
		}
	}
	return nil
}

func (p *childProcess) stopGracefully(grace time.Duration) {
	select {
	case <-p.done:
		return
	default:
	}
	_ = p.stdin.Close()
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-p.done:
		return
	case <-timer.C:
		p.terminate()
	}
}

func (p *childProcess) terminate() {
	select {
	case <-p.done:
		return
	default:
	}
	_ = p.cmd.Process.Kill()
	<-p.done
}

func (p *childProcess) exitError() error {
	<-p.done
	p.errMu.Lock()
	defer p.errMu.Unlock()
	if p.err == nil {
		return errors.New("worker exited")
	}
	return p.err
}

func (s *Supervisor) recordStarted(ready json.RawMessage, restart bool) {
	s.metaMu.Lock()
	defer s.metaMu.Unlock()
	s.meta.Ready = true
	s.meta.Generation++
	if restart {
		s.meta.Restarts++
	}
	s.meta.Worker = append(json.RawMessage(nil), ready...)
	s.meta.LastStartError = ""
}

func (s *Supervisor) setReady(ready bool) {
	s.metaMu.Lock()
	s.meta.Ready = ready
	s.metaMu.Unlock()
}

func (s *Supervisor) recordStartError(err error) {
	s.metaMu.Lock()
	s.meta.Ready = false
	s.meta.LastStartError = err.Error()
	s.metaMu.Unlock()
}

func contextResult(id string, err error) CallResult {
	code := "request_cancelled"
	message := "request was cancelled"
	status := 503
	if errors.Is(err, context.DeadlineExceeded) {
		code = "deadline_exceeded"
		message = "request deadline exceeded"
		status = 504
	}
	return CallResult{Event: eventError(&id, code, message, true), Status: status}
}

func overloadedResult(id string) CallResult {
	return CallResult{Event: eventError(&id, "engine_overloaded", "native analysis queue is full", true), Status: 503}
}

func unavailableResult(id, message string) CallResult {
	return CallResult{Event: eventError(&id, "worker_unavailable", message, true), Status: 503}
}

func protocolResult(id, message string) CallResult {
	return CallResult{Event: eventError(&id, "worker_protocol_error", message, true), Status: 503}
}

func internalResult(id, message string) CallResult {
	return CallResult{Event: eventError(&id, "internal_error", message, false), Status: 500}
}
