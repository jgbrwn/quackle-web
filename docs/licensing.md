# Licensing and data

This document describes repository policy, not legal advice.

## Source code

Unless a file states otherwise, original source is GPL-3.0-only. The native
adapter includes notices from the pinned Quackle project. Keep those notices with
any redistribution and mark modified upstream-derived files clearly.

## Quackle and dictionaries

Quackle is GPL software, while some dictionary files have separate restrictions.
This repository does not include Quackle binaries, DAWG/GADDAG files, raw word
lists, logos, or strategy data. The upstream commit and provenance metadata are
recorded for compatibility and reproducible local builds only.

NWL23 and CSW24 are names used by their respective rights holders. Their word
lists and notices are not a license grant. A hosted deployment must separately
verify the right to load, publish, or redistribute each artifact and must show
its exact source/disclosure in the product's About/Legal surface.

Custom word lists are user data. A compatible service should normalize and hash
inputs, bound their size, avoid raw retention by default, isolate compilation,
and never expose a public list/hash oracle.

## Attribution

The project is independent and makes no endorsement claim for Quackle, NASPA,
Collins, Cross-Tables, or any other referenced project or mark. See
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and the preserved files in
`product/server/engine-worker/notices/`.
