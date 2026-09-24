# Quackle Web

Quackle Web is a mobile-first PWA for editing, importing, sharing, and analyzing
classic 15×15 crossword-game positions. It brings Quackle-compatible concepts to
a responsive browser workspace: a board-first editor, rack and blank handling,
ranked move previews, GCG interoperability, offline drafts, and accessible touch
and keyboard controls.

This repository is the public source and consumption slice. It intentionally does
**not** contain hosted-service credentials, account-specific resource names,
provider state, container images, private runtime state, dictionary binaries, or
raw word lists. The hosted session/API service is a separate deployment boundary.

## What is included

- `product/web/` — Preact/Vite PWA, responsive board/rack UI, import/export, and
  browser tests with a mocked session API.
- `product/shared/` — bounded GCG parsing/replay/export and Cross-Tables URL
  validation helpers.
- `product/server/engine-worker/` — the portable C++ NDJSON boundary around a
  pinned Quackle build, including upstream notices.
- `product/server/go/` — the portable Go supervisor for one isolated native
  worker process.
- `product/lexicon-tools/` — deterministic input normalization/build tooling;
  generated and restricted lexicon artifacts are not included.
- `contracts/` — public HTTP and native-worker protocol contracts.
- `docs/` — public development, API, UX, licensing, deployment, and local-engine
  notes.

## Quick start

Requirements: Node.js 22.14+, pnpm 10.34+, and Python 3.12+.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm web:dev
```

Open <http://localhost:5173>. By default, browser API requests use the same
origin. For a compatible separately hosted service, set
`VITE_QUACKLE_API_BASE_URL` when building (for example,
`https://api.example.test`). Keep credentials/capability cookies scoped to a
trusted origin and do not put tokens in this variable.

The public browser test suite mocks the API and can run without credentials or
provider access:

```sh
pnpm test
pnpm test:e2e
```

See [`docs/development.md`](docs/development.md) for local API, native-worker,
and test details.

## Local native engine boundary

The native adapter is optional for frontend development. To build it, obtain the
pinned Quackle source separately, build its library/test targets, and provide only
explicit artifact paths to the worker. No Quackle checkout, compiled dictionary,
raw word list, or generated artifact belongs in this repository.

```sh
cmake -S product/server/engine-worker -B /tmp/quackle-worker-build -G Ninja \
  -DQUACKLE_ROOT=/path/to/quackle-at-pinned-commit \
  -DQUACKLE_BUILD_DIR=/path/to/quackle-build \
  -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/quackle-worker-build --target quackle-engine-worker

go -C product/server/go test -race ./...
```

The native protocol is documented in
[`contracts/worker-protocol.schema.json`](contracts/worker-protocol.schema.json).

## Product boundaries

The public repository does not promise a self-contained hosted backend. The
browser UI and parsers are reusable; session authorization, durable job state,
lexicon publication, and production routing remain service-level concerns. Do not
add deployment credentials or provider-specific configuration to this repository.

The current product is position-analysis focused. Full opponent/bag turn
progression is not yet a goal of the public browser slice.

## Licensing and data

Unless a file states otherwise, original source in this repository is licensed
under **GPL-3.0-only**; see [`LICENSE`](LICENSE). Quackle attribution and notices
are preserved in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and
`product/server/engine-worker/notices/`.

This repository does not distribute NWL23, CSW24, or any other dictionary asset.
Dictionary names, word lists, logos, and related copyrights belong to their
respective owners. See [`docs/licensing.md`](docs/licensing.md).

Quackle Web is an independent project and is not endorsed by Quackle, NASPA,
Collins, Cross-Tables, or other referenced services.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a change. Please keep
secrets, deployment state, generated lexica, and provider-specific infrastructure
out of commits. Security reports belong in [`SECURITY.md`](SECURITY.md), not in a
public issue.
