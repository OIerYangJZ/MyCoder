# ADR-0006 — ExactReplace is the only v0.1 edit strategy

**Status:** accepted · **Date:** 2026-08-12

## Context

Edit strategies range from exact string replacement to fuzzy patch application.
Fuzzier strategies fail less often, which is the argument for them.

## Decision

v0.1 ships exact string replacement plus file creation. No fuzzy matching, no
whitespace tolerance, no nearest-match recovery. Every replace must cite a
`receiptId` from a `Read`, and must match uniquely unless `replaceAll` is set.

## Rationale

A fuzzy strategy that edits the almost-right location produces a diff that looks
plausible and is wrong, and neither the model nor the reviewer has a signal that
anything went astray. `NON_UNIQUE_MATCH` costs one extra step and cannot corrupt
a file.

The freshness requirement addresses the other half: without coverage checking, a
model that read lines 1–50 can confidently "remember" a function at line 300 and
rewrite code nobody looked at.

## Consequences

- Delete and rename are absent until ApplyPatch arrives; a half-version now would
  mean a migration later.
- `EditEngine.plan()` / `apply()` is the seam for future strategies.
- Line endings are preserved: matching happens on LF-normalised text, and the
  file's dominant style is restored on write.
