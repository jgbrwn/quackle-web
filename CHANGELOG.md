# Changelog

## Unreleased

- Scenarios can be removed from this browser without revoking independent share
  links. A separate Share links tab preserves source management handles; dirty
  removals warn, Undo is time-limited, and cross-tab removals preserve drafts.
- Owners can create a new one-time link from a retained source handle after
  removing its local scenario; it shares server-saved state, not discarded local
  edits.
- The Share links manager keeps zero-link sources available for replacement
  links, and redemption removes bearer fragments before the request starts.
- Share creation keeps the one-time bearer URL visible and copyable without
  persisting it. Authorized use renews the session capability cookie; share
  URLs have no scheduled expiry and redemption remains independent of the owner
  cookie (per-session quota eviction may still remove the oldest link).
- Game replay shows both players' names and scores, the mover's recorded rack,
  the last move and notes, and can analyze any turn, marking the move played.
- Analysis no longer refuses boards containing an unchallenged phony; the words
  are reported as warnings, matching upstream Quackle.

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
