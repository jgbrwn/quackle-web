# Development

## Requirements

- Node.js 22.14 or newer
- pnpm 10.34 or newer
- Python 3.12 or newer for lexicon-tool tests
- Go 1.27 for the optional native supervisor
- CMake, Ninja, a C++ compiler, and Qt 6 only for the optional C++ worker

## Frontend

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm web:dev
```

The Vite server serves the PWA from `product/web`. Browser requests use the
same-origin API paths documented in [`api.md`](api.md). Without a compatible API,
the shell can still be inspected, while session-dependent actions remain offline
or unavailable.

## Checks

```sh
pnpm web:test
pnpm web:build
pnpm test:e2e
pnpm test:lexicon
```

The checked-in Playwright app suite intercepts the session API and does not need
credentials, hosted infrastructure, or dictionary files. The optional upstream
GCG compatibility tests are skipped unless `UPSTREAM_GCG_FIXTURES=1` is set.

For the Go supervisor:

```sh
go -C product/server/go test -race ./...
```

## Native worker

The native worker deliberately depends on a separately obtained Quackle checkout
and separately approved lexicon artifacts. Follow
[`local-engine.md`](local-engine.md); never commit those inputs.

## Security hygiene

Do not create `.env` files containing credentials, paste service tokens into issue
comments, or force-add ignored files. Before a pull request:

```sh
git diff --check
git status --short
git ls-files | rg -i '(token|secret|password|credential|\.pem$|\.key$|\.dawg$|\.gaddag$)' || true
```
