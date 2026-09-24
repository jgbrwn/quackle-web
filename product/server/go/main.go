package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

func main() {
	logger := log.New(os.Stderr, "quackle-go: ", log.LstdFlags|log.Lmicroseconds)
	workerBin := os.Getenv("QUACKLE_WORKER_BIN")
	dataDir := os.Getenv("QUACKLE_DATA_DIR")
	lexiconID := envOrDefault("QUACKLE_LEXICON_ID", "nwl23")
	dawg := envOrDefault("QUACKLE_DAWG", filepath.Join(dataDir, "lexica", lexiconID+".dawg"))
	gaddag := os.Getenv("QUACKLE_GADDAG")
	if gaddag == "" {
		gaddag = filepath.Join(dataDir, "lexica", lexiconID+".gaddag")
	}
	if workerBin == "" || dataDir == "" || dawg == "" || gaddag == "" {
		logger.Fatal("QUACKLE_WORKER_BIN and QUACKLE_DATA_DIR are required; lexicon artifacts could not be resolved")
	}
	addr := envOrDefault("QUACKLE_HTTP_ADDR", ":8080")
	maxRequestBytes := envInt64("QUACKLE_MAX_REQUEST_BYTES", defaultMaxRequestBytes, logger)
	shutdownGraceMS := envInt64("QUACKLE_CANCEL_GRACE_MS", 500, logger)
	maxQueue := envInt64("QUACKLE_MAX_QUEUE", 1, logger)
	workerKind := envOrDefault("QUACKLE_WORKER_KIND", "fast")
	workerBuild := envOrDefault("QUACKLE_WORKER_BUILD", "development")
	if workerKind == "" || workerBuild == "" {
		logger.Fatal("QUACKLE_WORKER_KIND and QUACKLE_WORKER_BUILD must not be empty")
	}
	startupCtx, startupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	supervisor, err := StartSupervisor(startupCtx, SupervisorConfig{
		WorkerBin:      workerBin,
		DataDir:        dataDir,
		LexiconID:      lexiconID,
		Dawg:           dawg,
		Gaddag:         gaddag,
		StartupTimeout: 15 * time.Second,
		RestartDelay:   100 * time.Millisecond,
		ShutdownGrace:  time.Duration(shutdownGraceMS) * time.Millisecond,
		Logger:         logger,
		Stderr:         os.Stderr,
		MaxQueued:      int(maxQueue),
		ExtraArgs: []string{
			"--worker-kind", workerKind,
			"--worker-build", workerBuild,
		},
	})
	startupCancel()
	if err != nil {
		logger.Fatalf("native worker startup failed: %v", err)
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           NewHTTPHandler(supervisor, maxRequestBytes),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      80 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          logger,
	}

	signalCtx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-signalCtx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Printf("HTTP shutdown: %v", err)
		}
		supervisor.Close()
	}()

	logger.Printf("listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		supervisor.Close()
		logger.Fatalf("HTTP server failed: %v", err)
	}
	if signalCtx.Err() != nil {
		<-shutdownDone
	} else {
		supervisor.Close()
	}
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt64(name string, fallback int64, logger *log.Logger) int64 {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		logger.Fatalf("%s must be a positive integer", name)
	}
	return parsed
}
