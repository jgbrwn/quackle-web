# Changelog

## Unreleased

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
