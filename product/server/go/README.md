# Go native-worker supervisor

This directory contains the local HTTP boundary in front of Quackle. It starts
exactly one `quackle-engine-worker`, waits for its protocol-v1 `ready` event,
serializes work through that child, and replaces the child after a crash, invalid
protocol output, request cancellation, or deadline expiry. It stores no session,
job, or result state.

The service uses `exec.Command` with an argv vector. It never invokes a shell.
Child stdout is parsed only as NDJSON; service logs go to stderr.

## Run locally

Go 1.27 is declared in `go.mod`.

```sh
go run .
```

Set `QUACKLE_WORKER_BIN`, `QUACKLE_DATA_DIR`, `QUACKLE_GADDAG`, and
`QUACKLE_HTTP_ADDR` for a real run. `QUACKLE_LEXICON_ID` selects an allowlisted
runtime profile (`nwl23` by default or `csw24`), while `QUACKLE_DAWG` selects the
matching verified DAWG. Queue and request limits are bounded by default.

Health and identity endpoints:

- `GET /internal/live`
- `GET /internal/ready`
- `GET /internal/meta`

Compute routes accept exact protocol-v1 request objects:

- `POST /internal/moves/generate`
- `POST /internal/moves/validate`
- `POST /internal/analysis/run`
- `POST /internal/analysis/cancel`

The analysis route streams `started`, optional `progress`, and one terminal
NDJSON event. Progress is advisory; callers must treat the terminal event as
authoritative.

## Tests

```sh
go test -race ./...
```

The default suite launches fake executable child processes to cover startup,
serialization, crash/protocol-error replacement, deadlines, cancellation, and
HTTP validation. The real C++ integration test requires the runtime environment
shown above.

The protocol definition is in
[`contracts/worker-protocol.schema.json`](../../../contracts/worker-protocol.schema.json).
