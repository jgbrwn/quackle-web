# Native engine worker

This directory defines the C++ NDJSON boundary around one fixed Quackle
configuration. It supports `validate_position`, `generate_moves`,
`validate_move`, and a bounded deep-worker-only `analyze` operation with progress
and cancellation events.

The worker does not provide networking or persistence. It receives one
self-contained request at a time and writes versioned NDJSON to stdout. Diagnostics
are written to stderr.

Set `QUACKLE_WORKER_KIND=deep` (or pass `--worker-kind deep`) to enable
`analyze`. Fast workers deliberately reject that operation. The worker accepts
`--lexicon-id nwl23|csw24` plus matching `--dawg` and `--gaddag` paths. Startup
fails closed when artifacts are missing or the GADDAG's embedded DAWG hash does
not match.

The build applies `patches/deterministic-rng.patch` so an explicit request seed
also reseeds Quackle's simulation threads between jobs.

```sh
cmake -S product/server/engine-worker -B /tmp/quackle-worker-build -G Ninja \
  -DQUACKLE_ROOT=/path/to/quackle-at-pinned-commit \
  -DQUACKLE_BUILD_DIR=/path/to/quackle-build \
  -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/quackle-worker-build --target quackle-engine-worker
```

The Quackle build must provide `libquackle.a` and `libquackleio.a`. Runtime data
must contain the matching English alphabet, DAWG, GADDAG, strategy files, and
copyright metadata. Keep those artifacts outside Git.

## Protocol test

```sh
QUACKLE_ENGINE_WORKER=/tmp/quackle-worker-build/bin/quackle-engine-worker \
QUACKLE_DATA_DIR=/path/to/quackle/data \
QUACKLE_LEXICON_ID=nwl23 \
QUACKLE_DAWG=/path/to/nwl23.dawg \
QUACKLE_GADDAG=/path/to/nwl23.gaddag \
python3 product/server/engine-worker/test_worker.py
```

`notices/` carries the upstream Quackle license/header and lexicon copyright
notice. Preserve them in any distribution.
