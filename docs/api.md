# API consumption

The browser client uses a same-origin `/api/v1` service. The public repository
ships the contract but not the hosted service implementation.

## Core endpoints

- `GET /api/v1/meta` — engine, board, capability, and lexicon metadata.
- `POST /api/v1/sessions` — create an anonymous analysis session.
- `GET`/`PUT /api/v1/sessions/{id}` — read or revision-update canonical state.
- `POST /api/v1/sessions/{id}/moves/generate` — request ranked static moves.
- `POST /api/v1/sessions/{id}/analysis/jobs` — create a durable deep-analysis job.
- `GET`/`DELETE /api/v1/sessions/{id}/analysis/jobs/{job}` — poll or cancel a job.
- `GET /api/v1/sessions/{id}/events` — optional WebSocket acceleration channel.
- `POST /api/v1/imports/gcg` — validate imported GCG before session creation.

HTTP job state is authoritative. WebSocket events are advisory acceleration and
clients must reconcile by revision/sequence after reconnecting.

## Security expectations

A compatible service must issue an authorization capability through a secure,
HttpOnly cookie or an equivalent mechanism. Session IDs are routing handles, not
credentials. Do not put capabilities, job leases, or raw uploaded lists in URLs.

All mutations use an expected revision or idempotency key. Imported files are
bounded text data, never filenames, paths, archives, commands, or configuration.

See [`contracts/openapi.yaml`](../contracts/openapi.yaml) for the machine-readable
HTTP contract.
