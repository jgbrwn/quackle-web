package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

const protocolVersion = 1

const (
	opValidatePosition = "validate_position"
	opGenerateMoves    = "generate_moves"
	opValidateMove     = "validate_move"
	opAnalyze          = "analyze"
	opCancel           = "cancel"
)

type WorkRequest struct {
	Protocol   int             `json:"protocol"`
	ID         string          `json:"id"`
	Op         string          `json:"op"`
	DeadlineMS int             `json:"deadline_ms"`
	Seed       uint32          `json:"seed"`
	Payload    json.RawMessage `json:"payload"`
}

type CancelRequest struct {
	Protocol int           `json:"protocol"`
	ID       string        `json:"id"`
	Op       string        `json:"op"`
	Payload  CancelPayload `json:"payload"`
}

type CancelPayload struct {
	TargetID string `json:"target_id"`
}

type WorkerError struct {
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	Retryable bool            `json:"retryable"`
	Details   json.RawMessage `json:"details,omitempty"`
}

type WorkerEvent struct {
	Protocol int             `json:"protocol"`
	ID       *string         `json:"id"`
	Event    string          `json:"event"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	Error    *WorkerError    `json:"error,omitempty"`
}

func decodeWorkRequest(data []byte, expectedOp string) (WorkRequest, error) {
	var req WorkRequest
	if err := requireJSONFields(data, "protocol", "id", "op", "deadline_ms", "seed", "payload"); err != nil {
		return req, err
	}
	if err := decodeStrict(data, &req); err != nil {
		return req, err
	}
	if req.Protocol != protocolVersion {
		return req, errors.New("protocol must be 1")
	}
	if err := validateID(req.ID); err != nil {
		return req, fmt.Errorf("id: %w", err)
	}
	if req.Op != expectedOp {
		return req, fmt.Errorf("op must be %q", expectedOp)
	}
	if req.DeadlineMS < 1 || req.DeadlineMS > 60_000 {
		return req, errors.New("deadline_ms must be between 1 and 60000")
	}
	if !isJSONObject(req.Payload) {
		return req, errors.New("payload must be an object")
	}
	return req, nil
}

func decodeCancelRequest(data []byte) (CancelRequest, error) {
	var req CancelRequest
	if err := requireJSONFields(data, "protocol", "id", "op", "payload"); err != nil {
		return req, err
	}
	if err := decodeStrict(data, &req); err != nil {
		return req, err
	}
	if req.Protocol != protocolVersion {
		return req, errors.New("protocol must be 1")
	}
	if err := validateID(req.ID); err != nil {
		return req, fmt.Errorf("id: %w", err)
	}
	if req.Op != opCancel {
		return req, errors.New(`op must be "cancel"`)
	}
	if err := validateID(req.Payload.TargetID); err != nil {
		return req, fmt.Errorf("payload.target_id: %w", err)
	}
	return req, nil
}

func decodeStrict(data []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if dec.More() {
		return errors.New("invalid JSON: multiple values")
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("invalid JSON: multiple values")
		}
		return fmt.Errorf("invalid JSON: %w", err)
	}
	return nil
}

func requireJSONFields(data []byte, fields ...string) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if object == nil {
		return errors.New("invalid JSON: expected an object")
	}
	for _, field := range fields {
		if _, ok := object[field]; !ok {
			return fmt.Errorf("field %q is required", field)
		}
	}
	return nil
}

func validateID(id string) error {
	n := utf8.RuneCountInString(id)
	if n < 1 || n > 128 {
		return errors.New("must contain between 1 and 128 characters")
	}
	return nil
}

func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	var object map[string]json.RawMessage
	return json.Unmarshal(trimmed, &object) == nil && object != nil
}

func eventError(id *string, code, message string, retryable bool) WorkerEvent {
	return WorkerEvent{
		Protocol: protocolVersion,
		ID:       id,
		Event:    "error",
		Error: &WorkerError{
			Code:      code,
			Message:   message,
			Retryable: retryable,
		},
	}
}

func cancelledEvent(id, targetID string) WorkerEvent {
	payload, _ := json.Marshal(CancelPayload{TargetID: targetID})
	return WorkerEvent{Protocol: protocolVersion, ID: &id, Event: "cancelled", Payload: payload}
}
