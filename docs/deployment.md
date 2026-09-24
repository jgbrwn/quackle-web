# Cloud deployment reference

This is a provider-level deployment reference, not the deployment configuration
for any particular account. It contains no account IDs, zone names, bucket names,
custom domains, credentials, or production state.

The hosted architecture can be implemented with Cloudflare primitives while
keeping the native engine isolated:

```text
Browser / PWA
    |
    v
Workers static assets + API boundary
    |
    +--> session Durable Object: canonical state, revisions, jobs, WebSockets
    +--> private R2: immutable lexicon artifacts and manifests
    +--> named Container classes: Go supervisor -> one C++ worker per process
```

Containers are replaceable compute, not the owner of sessions, uploads, jobs, or
results. The public Worker is the only ingress. HTTP job state is authoritative;
WebSocket events accelerate UI updates and are replayed/reconciled by sequence.

## Environment separation

Use separate names and resources for development, preview, and production. Keep
all resource names, custom domains, and deployment choices in a private release
repository or deployment system. The public repository should contain only
provider-neutral examples and documentation.

A deployment should use:

- a Worker with Static Assets and API routing;
- separately migrated session Durable Objects;
- private R2 buckets with immutable, checksum-verified artifacts;
- bounded Container classes with explicit idle/shutdown behavior;
- deployment-time secrets supplied by the provider or CI secret store.

Do not put an API token in JSON, shell history, `.env` files, Docker build args,
client bundles, logs, screenshots, or GitHub issues. Prefer short-lived or
least-privilege credentials and rotate them after any accidental exposure.

## Generic deployment sequence

1. Build and test the browser bundle and native worker outside the provider.
2. Create environment-specific private artifact storage.
3. Validate the Worker bindings and additive Durable Object migrations against the
   installed CLI version.
4. Build/publish the native image only from pinned source and verified artifacts.
5. Deploy a non-production environment first.
6. Run API, reconnect, cold-start, lexicon-identity, and legal-notice smoke tests.
7. Promote the same reviewed source/image identities to production.
8. Record only non-sensitive release identifiers in public changelogs.

The exact Worker/DO implementation and environment configuration are deliberately
not included in this consumption repository. A private deployment repository can
consume the public contracts and browser bundle while keeping account-specific
infrastructure out of the public history.

## Credential-safe command shape

Use a secret manager or CI environment injection. The token value must never be
printed or persisted:

```sh
CLOUDFLARE_API_TOKEN="$DEPLOY_TOKEN" pnpm exec wrangler deploy --config "$WRANGLER_CONFIG"
```

`DEPLOY_TOKEN`, `WRANGLER_CONFIG`, and every resource value in that example are
placeholders supplied by the deployment environment. Do not add a real token,
account identifier, zone, bucket, route, or custom domain to this repository.
