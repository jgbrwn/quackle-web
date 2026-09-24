# Publication model

This repository is the public projection of a separate canonical development
repository. It is intentionally published from a fresh, sanitized tree rather
than by exposing private Git history.

## Reconciliation

- Shared source changes flow **private → public** through the publication command.
- Public-only README, legal, CI, and documentation files are maintained as the
  publication overlay.
- Account-specific deployment files, credentials, runtime state, and restricted
  dictionary artifacts are never rendered.
- A public pull request touching a mirrored source path must be ported to the
  canonical repository first; it may be regenerated or superseded by the next
  publication.
- Public-only documentation changes should be copied into the canonical
  publication overlay before the next release.

The generated tree is reviewed, scanned, tested, committed, and pushed as a
normal public change. Publication does not automatically deploy the hosted
service.
