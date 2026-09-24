# Contributing

Thanks for helping improve Quackle Web.

## Before you start

1. Read the public README and relevant docs.
2. Keep provider deployment glue, credentials, raw word lists, compiled lexica,
   and local runtime state out of the repository.
3. Preserve upstream notices and avoid changing product behavior to silently
   fall back to a different lexicon or fabricated analysis.

## Local checks

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:e2e
```

Changes to the native boundary should also run:

```sh
go -C product/server/go test -race ./...
```

## Pull requests

Explain the user-visible behavior and test coverage. Include screenshots only
when they contain no private session data, bearer links, or credentials. Keep
commits focused and update public documentation when the consumption contract
changes.
