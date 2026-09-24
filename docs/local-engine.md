# Local native engine

This repository contains a portable NDJSON boundary and Go supervisor for local
experimentation. It does not vendor Quackle or any dictionary artifact.

## Obtain and build Quackle

Use the pinned upstream commit recorded in
[`references/upstream-pin.json`](../references/upstream-pin.json). Build Quackle's
library and the utilities needed by the worker in a separate checkout and build
directory. Keep that checkout outside this repository.

The exact Quackle build flags can vary by platform. The worker CMake project
expects paths to the Quackle source and the completed Quackle build:

```sh
cmake -S product/server/engine-worker -B /tmp/quackle-worker-build -G Ninja \
  -DQUACKLE_ROOT=/path/to/quackle-at-pinned-commit \
  -DQUACKLE_BUILD_DIR=/path/to/quackle-build \
  -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/quackle-worker-build --target quackle-engine-worker
```

Provide a matching alphabet, DAWG, GADDAG, and strategy data through explicit
paths/environment variables. The worker rejects missing or mismatched artifacts.
Generated binaries and raw definitions are restricted build inputs, not source
repository contents.

## Run the Go supervisor

```sh
go -C product/server/go run .
```

Set `QUACKLE_WORKER_BIN`, `QUACKLE_DATA_DIR`, `QUACKLE_DAWG`,
`QUACKLE_GADDAG`, and `QUACKLE_LEXICON_ID` for a real engine run. The service
uses an argv vector, parses only NDJSON on child stdout, serializes work through
one child, and replaces a child after protocol failure, cancellation, or a hard
deadline.

Health endpoints:

- `GET /internal/live`
- `GET /internal/ready`
- `GET /internal/meta`

The full request/response shape is in
[`contracts/worker-protocol.schema.json`](../contracts/worker-protocol.schema.json).
