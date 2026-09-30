# Changelog

## Unreleased

- Occupied board tiles now show their face-value points instead of a decorative
  dot; blank tiles show zero.
- Scenarios have editable browser-local names, and **Import game** is a first-
  class Scenarios action for GCG files and Cross-Tables URLs. Imports are
  validated and named before creating a new scenario.
- New share links capture the current scenario name as a separate,
  recipient-visible label. Renaming later changes future links only; existing
  URLs, snapshots, and recipient forks remain unchanged.
- Scenarios can be removed from this browser without revoking independent share
  links. The Share links tab retains removed sources while links/notices need
  management, prunes a source after an authorized check finds none, and hides
  new-link actions for removed scenarios. Dirty removals warn, Undo is
  time-limited, and cross-tab removals preserve drafts.
- New links can be created from saved scenarios; restoring or recreating and
  activating a removed scenario is required before using **Settings → Share
  scenario** again. Redemption removes bearer fragments before the request
  starts.
- Share creation keeps the one-time bearer URL visible and copyable without
  persisting it. Authorized use renews the session capability cookie; share
  URLs have no scheduled expiry and redemption remains independent of the owner
  cookie (per-session quota eviction may still remove the oldest link).
- Game replay shows both players' names and scores, the mover's recorded rack,
  the last move and notes, and can analyze any turn, marking the move played.
- Analysis no longer refuses boards containing an unchallenged phony; the words
  are reported as warnings, matching upstream Quackle.
- The HTTP contract documents origin, request-size, and admission-limit
  responses so clients can handle `403`, `413`, and `429` without changing the
  existing sharing or import workflows.
- Cross-Tables URL validation rejects embedded credentials, encoded host
  aliases, and nondefault HTTPS ports while continuing to accept ordinary
  HTTPS port 443 links.
- WebSocket reconnect may receive a current session snapshot when its event
  cursor is stale or the replay range is incomplete; job state remains
  authoritative through HTTP endpoints.
- The static PWA asset configuration adds standard security response headers
  and a CSP in report-only mode, without changing browser behavior.
- The production and preview Workers redirect plain HTTP requests on their
  public hosts to HTTPS. Production also serves baseline security headers with
  CSP in report-only mode.

- Board cells are sized from one container-query value, stay square when tiles
  are placed, and fit phones down to 320px without horizontal scrolling.
- Cross-Tables links import through `POST /api/v1/imports/cross-tables`, using
  the page's declared dictionary when the GCG omits `#lexicon`; otherwise an
  in-app NWL2023/CSW24 chooser replaces the browser confirm dialog.
- The native worker allows deep analysis for CSW24 with upstream Quackle's CSW
  strategy lookup.

## 0.1.0 — public source slice

- Published the mobile-first PWA and shared GCG/Cross-Tables utilities.
- Added the portable native NDJSON boundary and Go supervisor sources.
- Added provider-neutral API, deployment, security, licensing, and contribution
  documentation.
- Excluded account-specific infrastructure, credentials, generated lexica, and
  private runtime state.
