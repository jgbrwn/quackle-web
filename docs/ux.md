# Frontend and PWA

## Product surface

MVP components:

- responsive 15x15 board editor;
- rack editor with blank handling;
- scores/turn/unseen advanced drawer;
- default/custom lexicon selector with status;
- static move table and board preview;
- deep-analysis panel with cold-start/progress/cancel/interrupted states;
- local saved positions/sessions, with a browser-local recent-scenario list capped at
  the 100 most recent entries;
- About/Legal/engine metadata.

Use semantic HTML/CSS Grid and Pointer Events. Tap-to-place must be first class on mobile; drag/drop is an enhancement. All board actions require keyboard and accessible alternatives.

## Lessons from the legacy Quackle desktop reference

The Quackle 1.0 screenshot is useful for domain information architecture, not as
a visual/layout template. It confirms that the durable concepts users expect are:

- a central 15x15 board with coordinates and recognizable premium-square cues;
- a persistent rack and score/turn context;
- ranked candidate moves with score/equity and a clear selected-move preview;
- history/navigation and an explicit settings/lexicon surface.

Our implementation should translate those concepts instead of copying the fixed
multi-pane desktop chrome:

- desktop: board-first workspace with a move table beside or below it;
- mobile: board and rack remain primary, move results become a bottom sheet or
  collapsible panel, and settings/history use drawers;
- tap-to-place is the default interaction; drag/drop and hover affordances are
  enhancements only;
- keep the current move, rack, score, lexicon identity, and cold-start state
  visible without requiring a wide viewport;
- use large touch targets, safe-area padding, keyboard alternatives, and no
  horizontal scrolling for the core editing path.

## UX reconciliation review — 2026-09-24

The pinned Quackle GUI was reviewed before extending the PWA. Upstream's **New
Game** starts an empty board and draws a legal opening rack; position analysis
then works from turn/history snapshots. Its graphical board uses a placement
arrow and tentative move, while the rack editor supports set/shuffle and the
move table previews a selected candidate. The web product now separates these
ideas without copying the fixed Qt layout:

- **New game** is the primary fresh scenario: empty board, random seven-tile
  English rack, persisted in the local/server session. **Blank position** is a
  separate explicit setup path for historical or hypothetical analysis.
- Existing imports, replay, share forks, JSON/GCG export, offline drafts, and
  session reconnect remain separate scenario origins and are not replaced.
- The production UI no longer contains the deterministic `ADEIRST`/`DISRATE`
  fixture or fabricated candidate results. Candidates are empty until analysis
  succeeds, are cleared when the position changes, and can be selected for a
  non-destructive board preview.
- The board now uses the canonical classic premium layout, including triple
  letters; board editing has roving keyboard focus, across/down navigation,
  blank-letter selection, an in-app tile keyboard, rack editing/shuffle, and
  Pointer Events drag from rack to board. Buttons are used for mobile tile entry
  so editing does not summon the native keyboard.
- About/Legal is available from desktop and mobile and shows engine, lexicon,
  provenance/disclosure, offline behavior, and links to the data tools.

Reference behaviors were taken from pinned Quackle sources such as
`quacker/newgame.cpp`, `quacker/graphicalboard.cpp`, `quacker/rackdisplay.cpp`,
`quacker/movebox.cpp`, and `game.cpp`; the mobile interaction review treated
Woogles/ISC as behavioral references only and did not copy their code.

Do not show a generic spinner. Use honest phases:

1. `Restoring session`
2. `Starting analysis engine`
3. `Loading lexicon` when custom
4. `Analyzing`
5. terminal status

The user can continue editing a draft while an analysis request for the committed revision runs. Results are attached to their source revision; stale results are displayed as historical, never silently applied to a changed board.

## PWA

The architecture fully supports a PWA:

- app shell and icons cached;
- IndexedDB local drafts;
- installable manifest;
- offline editing/export;
- network required for native analysis.

Do not cache API responses or uploads through a generic service-worker strategy. Version IndexedDB and test migrations.

## Custom-list UX

Upload panel must say:

- accepted format and limits;
- list is normalized/deduplicated;
- raw source is not retained server-side by default;
- generated artifacts may be cached temporarily by content hash;
- custom lists are not official NWL;
- deep/equity features may be disabled or use generic strategy.

Show invalid lines with bounded examples, not the whole uploaded list. Let the user choose whether the browser retains the raw list locally for future rebuild.

## Export/import

Portable JSON export includes:

- schema version;
- board/rack/scores/history;
- lexicon manifest identity;
- optional embedded custom normalized words only with explicit choice;
- no cookies, capability secrets, job leases, or container IDs.

Import validates before changing the current session. A valid import creates a
new local scenario and leaves the previous scenario selectable. New scenarios,
future share-link forks, and imported games all use the same local scenario
registry; it stores only state/metadata and never capability cookies or share
secrets. If a matching server session is unavailable, the local copy remains
visible for recovery instead of being silently replaced.
