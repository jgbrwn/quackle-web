# API consumption

The browser client uses a same-origin `/api/v1` service. The public repository
ships the contract but not the hosted service implementation.

## Core endpoints

- `GET /api/v1/meta` — engine, board, capability, and lexicon metadata.
- `POST /api/v1/sessions` — create an anonymous analysis session.
- `POST /api/v1/moves/generate` — legacy stateless protocol-v1 generation using
  the default fast pool; new browser clients should use the session-bound
  generation endpoint.
- `GET`/`PUT /api/v1/sessions/{id}` — read or revision-update canonical state.
- `POST /api/v1/sessions/{id}/moves/generate` — request ranked static moves.
- `POST /api/v1/sessions/{id}/analysis/jobs` — create a durable deep-analysis job.
- `GET`/`DELETE /api/v1/sessions/{id}/analysis/jobs/{job}` — poll or cancel a job.
- `GET /api/v1/sessions/{id}/events` — optional WebSocket acceleration channel.
- `GET`/`POST /api/v1/sessions/{id}/share` — list safe per-link labels/metadata
  or create a snapshot-fork link with an optional recipient-visible label (the
  bearer URL is returned only when created).
- `DELETE /api/v1/sessions/{id}/share/{shareId}` — revoke one link; existing
  forks remain independent.
- `DELETE /api/v1/sessions/{id}/share-notices/{shareId}` — dismiss an automatic
  eviction notice.
- `POST /api/v1/shares/redeem` — redeem a fragment token and create an
  independent session/capability, returning the captured display label
  separately from canonical game state; the browser strips the fragment from
  history before the request begins.
- `POST /api/v1/imports/gcg` — validate imported GCG before session creation.
- `POST /api/v1/imports/cross-tables` — service-side import of one allowlisted
  Cross-Tables annotated game (Cross-Tables sends no CORS headers). The link
  must use HTTPS on the exact `cross-tables.com` or `www.cross-tables.com`
  hostname, with no encoded host alias, URL credentials, or nondefault port;
  explicit port 443 is accepted. Returns the validated GCG plus the page's
  declared dictionary.

HTTP job state is authoritative. WebSocket events are advisory acceleration and
clients must reconcile by revision/sequence after reconnecting.

## Security expectations

A compatible service must issue an authorization capability through a secure,
HttpOnly cookie or an equivalent mechanism. Session IDs are routing handles, not
credentials. Do not put capabilities, job leases, or raw uploaded lists in URLs.
The current browser service uses a per-session HttpOnly capability cookie with
a 30-day idle lifetime, renewed only after a successful authorized session HTTP
response. Share-fragment bearer URLs are separate: the owner cookie controls
management, not redemption, and its expiry does not expire the share URL.

Removing a local scenario is a browser-only IndexedDB action and does not call
a server-delete endpoint or revoke a snapshot share. Revocation remains a
separate owner-authorized `DELETE /api/v1/sessions/{id}/share/{shareId}` request.
The browser retains known source handles after the last link is revoked, so a
replacement link can be created from the Share links manager.
Scenario names are browser-local; a new link captures the current name as a
recipient-visible label. Renaming does not change existing links, snapshots,
or recipient forks.

All mutations use an expected revision or idempotency key. Imported files are
bounded text data, never filenames, paths, archives, commands, or configuration.

Browser clients should send cookie-authenticated mutations and WebSocket
upgrades from the same allowed application origin. Compatible services may
return `403` for an origin mismatch, `413` for oversized requests, or `429`
with `Retry-After` when admission limits are reached. An externally hosted
browser client requires an explicitly trusted origin and a separately
configured credentialed CORS policy; an Origin check alone does not enable
CORS. Do not use wildcard CORS with capability cookies.

See [`contracts/openapi.yaml`](../contracts/openapi.yaml) for the machine-readable
HTTP contract.
