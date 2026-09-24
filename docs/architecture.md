# Public architecture

Quackle Web has two intentionally separate layers:

```text
Browser PWA
   |
   | same-origin session/API contract
   v
Hosted session service  --->  isolated native engine worker
   |
   +--> immutable, rights-reviewed lexicon artifacts
```

The browser owns drafts, local recovery, board editing, import/export, and the
user-facing interaction model. The service owns authorization, canonical session
revisions, analysis jobs, and authoritative results. The native worker is
replaceable compute: it receives self-contained protocol requests and stores no
user session or job state.

The public repository contains the browser, shared parsers, protocol contract,
and portable local native boundary. It does not contain the hosted service's
routing/authentication implementation or deployment configuration.

## Reproducibility

A native result is identified by the canonical position/history, options, seed,
engine protocol, and lexicon manifest. A worker restart must not change the
meaning of a request. Lexicon artifacts are content-addressed and must be loaded
and verified before use.

## Interaction model

- New game means an empty board plus a fresh legal opening rack.
- Blank position is a separate manual setup path.
- Tap-to-place is primary; drag is an enhancement.
- Candidate selection previews a move without mutating the editable position.
- Results are tied to the revision they analyzed and never silently overwrite a
  changed board.
- Offline drafts remain recoverable even when the service is unavailable.
