package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestNativeWorkerHTTPIntegration exercises the real C++ worker when the same
// environment used to run the service is available. It is skipped in hermetic
// unit-test runs.
func TestNativeWorkerHTTPIntegration(t *testing.T) {
	workerBin := os.Getenv("QUACKLE_WORKER_BIN")
	dataDir := os.Getenv("QUACKLE_DATA_DIR")
	lexiconID := os.Getenv("QUACKLE_LEXICON_ID")
	if lexiconID == "" {
		lexiconID = "nwl23"
	}
	dawg := os.Getenv("QUACKLE_DAWG")
	if dawg == "" {
		dawg = filepath.Join(dataDir, "lexica", lexiconID+".dawg")
	}
	gaddag := os.Getenv("QUACKLE_GADDAG")
	if workerBin == "" || dataDir == "" || dawg == "" || gaddag == "" {
		t.Skip("QUACKLE_WORKER_BIN, QUACKLE_DATA_DIR, and lexicon artifacts are required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	supervisor, err := StartSupervisor(ctx, SupervisorConfig{
		WorkerBin:      workerBin,
		DataDir:        dataDir,
		LexiconID:      lexiconID,
		Dawg:           dawg,
		Gaddag:         gaddag,
		StartupTimeout: 15 * time.Second,
		Logger:         log.New(io.Discard, "", 0),
		Stderr:         io.Discard,
	})
	if err != nil {
		t.Fatalf("start real native worker: %v", err)
	}
	defer supervisor.Close()
	server := httptest.NewServer(NewHTTPHandler(supervisor, defaultMaxRequestBytes))
	defer server.Close()

	body := `{
		"protocol": 1,
		"id": "native-http-opening",
		"op": "generate_moves",
		"deadline_ms": 10000,
		"seed": 123456789,
		"payload": {
			"position": {
				"version": 1,
				"lexicon_id": "nwl23",
				"board": {"id": "classic15", "cells": []},
				"rack": "ADEIRST",
				"players": {
					"on_turn": {"score": 0},
					"opponent": {"score": 0, "rack": null}
				},
				"turn": {"number": 0, "scoreless_turns": 0},
				"unseen": {"mode": "derive"}
			},
			"options": {"limit": 5, "include_exchanges": true}
		}
	}`
	response := postJSON(t, server.URL+"/internal/moves/generate", body)
	var event struct {
		WorkerEvent
		Payload struct {
			Data struct {
				Count int `json:"count"`
				Moves []struct {
					Word  string `json:"word"`
					Score int    `json:"score"`
				} `json:"moves"`
			} `json:"data"`
		} `json:"payload"`
	}
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(&event); err != nil {
		t.Fatalf("decode native HTTP response: %v", err)
	}
	if response.StatusCode != 200 || event.Event != "result" {
		t.Fatalf("native HTTP response: status=%d event=%q error=%+v", response.StatusCode, event.Event, event.Error)
	}
	if event.Payload.Data.Count != 5 || len(event.Payload.Data.Moves) != 5 {
		t.Fatalf("native move count = %d/%d", event.Payload.Data.Count, len(event.Payload.Data.Moves))
	}
	if first := event.Payload.Data.Moves[0]; first.Word != "DISRATE" || first.Score != 70 {
		t.Fatalf("first native move = %+v, want DISRATE for 70", first)
	}
}
