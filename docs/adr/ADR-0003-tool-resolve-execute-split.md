# ADR-0003 — Tools split into resolve() and execute()

**Status:** accepted · **Date:** 2026-08-12

## Context

Permission decisions need to happen before the effect, and the prompt shown to
the user needs to describe semantics rather than echo a command string.

## Decision

`resolve(args, ctx)` returns a `ToolExecution` carrying `accesses`,
`approvalSubject` and `display`. The policy engine rules on the accesses. Only
then does `execute(executor, signal)` run, with an executor already narrowed to
what was granted.

## Rationale

- The approval prompt can say "reaches registry.npmjs.org:443 and will modify
  package.json and the lockfile" because `resolve()` computed exactly that.
- An `Edit` can show its real diff before anything is written.
- A denied call costs nothing, because nothing happened yet.

## Consequences

- `resolve()` may read metadata but must not perform the effect. This is a
  discipline, not a mechanism, and it is the main thing to check in review.
- `execute()` cannot prompt, cannot read a global credential, and cannot reach
  the network except through the executor.
- Tools that need a path must use `ctx.canonicalize`, never the raw string.
