# Lexicon tools

These Python tools normalize approved word-list inputs and build Quackle-compatible
lexicon artifacts in a temporary output directory. They are source tooling only:
this repository contains no raw definitions, DAWG/GADDAG binaries, or generated
manifests.

## Rules

- Treat source lists as restricted data and keep them outside Git.
- Normalize and hash input deterministically.
- Verify generated artifacts by loading them through Quackle and checking known
  accepted/rejected words.
- Preserve the exact source commit/checksum and copyright notice in any private
  build manifest.
- Do not infer redistribution rights from a public URL or a matching checksum.

The default and upstream builders require separately obtained Quackle utilities
such as `makeminidawg`, `makegaddag`, and the relevant test binary. See the script
help and [`docs/licensing.md`](../../docs/licensing.md) before building an asset.
