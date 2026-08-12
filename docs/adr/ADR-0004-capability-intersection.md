# ADR-0004 — Permissions compose by intersection, not override

**Status:** accepted · **Date:** 2026-08-12

## Context

Six things claim authority over permissions: system ceiling, session, user
config, project config, agent profile, skill profile. A checked-in project file
must not be able to widen what the user narrowed.

## Decision

Every layer votes on every `AccessRequest`, and the **strictest vote wins**:
`HARD_DENY > DENY > ASK > ALLOW`. Adding a layer is the only way to change the
effective set, and `PolicyEngine.narrow()` is the only way to add one.

## Rationale

Invariant 14 — "Agent/Skill/Hook/Subagent can only narrow" — becomes structural
rather than a rule someone has to remember. There is no widening code path to
audit, because there is no widening code path.

Within a single profile the **most specific** rule wins instead, so
`allow network registry.npmjs.org` stays meaningful next to `ask network *`.
Specificity counts literal text and penalises wildcards and brace alternatives —
scoring by raw pattern length made a fifty-way alternation outrank an exact name.

## Consequences

- A skill naming an unknown profile gets deny-all plus a visible note, never a
  silent fallback to the session profile.
- Host allowlists intersect across config layers; budgets take the minimum;
  deny-pattern lists union.
- An ambiguous profile (two equally specific rules) fails closed.
