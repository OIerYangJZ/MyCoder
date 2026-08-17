# ADR-0027 — What v0.1 must do: acceptance tiers, and what gates `rc.1`

**Status:** accepted · **Date:** 2026-08-17 · **Milestone:** v0.1.0-alpha.12

## Context

The v0.1 feature scope has been full since alpha.7. Five milestones have shipped
since, every one of them green, and none of them could answer the question a
release candidate asks: **is this done?**

`research/kernel_v0.1_next_phase_plan.md` puts exactly one step between the last
milestone and `v0.1.0-rc.1` — a "Full Acceptance Suite". It appears three times in
that document and is never defined: not what it contains, not what it runs, not
what result permits `rc.1`, not who says so. A gate whose contents are undefined
is not a gate; it is a place where somebody later decides that whatever passed
that week was the acceptance suite.

Two further facts shape this decision.

**The specification already contains an acceptance list, and nothing in this
repository has ever pointed at it.** Spec §28, "v0.1 Acceptance Criteria", is 21
unticked checkboxes across six groups, prefixed "只有全部满足才标记 `v0.1.0`" —
only mark v0.1.0 when all of them hold. It has been in the normative document
since before alpha.1. One source comment mentions it in passing
(`src/execution/local.ts`). No evidence matrix, no release checklist and no CI
job refers to it. The project did not lack a definition of done so much as it
lacked any mechanism that would notice one going unread.

**The oldest open claim in the project is not mechanisable.** A1 — that somebody
who is not the author has run this — has been carried as a row in
`docs/open-evidence.md` across six milestones. Six release tags have asserted, by
being tags, that this software is ready for someone else. None of them was
checked. A row can be carried indefinitely; that is what six milestones
demonstrated.

## Decision

### 1. The acceptance suite is a document plus a mapping, and it is derived from the specification

`docs/acceptance-suite.md` is the definition of what this software must do to be
called v0.1. Every item in it is derived from a clause of the normative
specification — §1.1 (MUST), §1.2 (SHOULD), §25 (release-blocking security
invariants) and §28 (acceptance criteria) — and carries the clause text, so the
suite can be read and checked after `research/` is deleted.

The direction of derivation is fixed and it is the whole design: **the clause
produces the item, and then the item goes looking for its evidence.** An item with
no evidence is a finding, recorded as such. A suite derived from the existing test
tree would pass on the day it was written and would prove only that the tests that
exist are the tests that exist.

The suite is **not** a test framework, not a second evidence gate, and not a
rewrite of the evidence matrices. `pnpm test` runs the tests; the matrices are the
evidence the suite maps onto; the suite reuses their vocabulary
(`PASS` / `FAIL` / `NOT TESTED` / `NOT APPLICABLE`) and adds none.

### 2. Every item declares a tier, and every tier declares its price

An acceptance suite that can only run where everything is available is a suite
that never runs.

```text
T0  offline        `pnpm test` — any machine, no credentials, no daemon
T1  container      a Docker daemon; native Linux for the strong claims
T2  native Linux   Landlock + seccomp, no container runtime
T3  live model     a provider credential and money
T4  human          a person who did not write this
```

The tiering is not administrative. It records that some of what v0.1 claims
**cannot be established by any amount of CI**, which six milestones of green
builds have quietly obscured.

### 3. What gates `v0.1.0-rc.1`

> `v0.1.0-rc.1` requires **T0–T2 green** and **T4 executed at least once**. T3 may
> be partial, and what is missing must be named rather than rounded away.

T4 is in that list deliberately. A release _candidate_ is a claim that the thing
is ready for someone else, and no one else has ever used it. A suite that gated
`rc.1` on machines alone would formalise exactly the gap that has been open since
alpha.8.

### 4. A1 is a tier of the suite, not a row in an index

The item formerly tracked as A1 in `docs/open-evidence.md` is **T4 of the
acceptance suite**, and by decision 3 it is a precondition of `rc.1`. It remains
indexed in `docs/open-evidence.md` so the corpus checks can still see it; what has
changed is that it is no longer only a row.

This is the repair that was available this milestone: not closing A1 — that needs
a person — but making it impossible to reach v0.1.0 without closing it.

### 5. `v0.1.0-alpha.12` is the last tag cut while CLOSURE A is open

alpha.9 §26 predicted CLOSURE A would be skipped. alpha.10 recorded the
consequence as a commitment. alpha.11 shipped with it open — the sixth
consecutive milestone — so the commitment took effect: no capability is added
until A1 closes. alpha.11 added none and alpha.12 adds none. One no-capability
milestone has not moved A1, and an indefinite sequence of them is functionally
identical to never closing it.

> **`v0.1.0-alpha.12` is the last tag cut while CLOSURE A is open.** Work may
> continue on a branch afterwards. Nothing is tagged.

The line is drawn at the _tag_ rather than at the work because a release tag is
precisely the artifact that asserts "this is usable by someone else". Seven tags
will have made that assertion; none has been checked. Continuing to make it is the
part that stops. This was decided by the user on 2026-08-17 and is recorded here
as taken rather than left implicit, because a commitment that lives only in a
plan under `research/` has no history and can be amended silently — which is the
mistake alpha.9 §25 made and ADR-0017 exists to prevent repeating.

## Consequences

**What this ADR grants: nothing.** It adds no tool, no capability, no
configuration key and no permission. Every clause above either defines a document,
records a decision already taken, or withholds a tag. That is deliberate: the
no-capability commitment is in force, and an ADR is the easiest place to smuggle
an exception into.

**Defining the gate is not passing it.** This milestone writes the suite down and
runs it as far as the available machines allow. The first run is expected to be
red; a green first run is evidence that the derivation was taken from the answers,
and is a stop condition rather than a success.

**"N clauses covered, M uncovered" is not a measurement of the software.** It is a
count of one document against another. It is useful and it is checkable, and it is
not evidence about behaviour. The suite says so in its own words, in the place
where a reader would otherwise be tempted.

**The suite can now be wrong in a way that fails a build.** Its parse, its tier
declarations, its clause coverage and its evidence references are checked by
`scripts/acceptance.ts` from inside the existing evidence gate — not as a second
gate — and each check ships with a fixture that makes it fail.

## Alternatives considered

**Derive the suite from the test tree.** Rejected: it would be green by
construction, and indistinguishable to a reader from a suite that means something.
This is the alpha.2 failure — "PASS — implemented" reads exactly like
"PASS — test:overflow-retry-bounded" — one level of abstraction up.

**Gate `rc.1` on T0–T3 and leave T4 aspirational.** Rejected: that is the current
situation with a document wrapped around it. T4 is the only tier that can falsify
a claim the project has already made.

**Downgrade A1 to `NOT APPLICABLE`, as A7 earned.** Refused twice now, and the
refusal belongs in the record. A7 is impossible here — the resolver NATs every
name into 198.18/15, so no host on this network can close it. A1 is one hour of
somebody else's time. Those are not the same kind of thing, and marking them the
same way would make the index say less than it does today.

**Put the acceptance suite in `research/` beside the specification.** Rejected for
the reason alpha.11 §20 gave when it refused to move the spec the other way:
nothing shipped may depend on `research/` surviving. The suite quotes the clauses
it derives from, and a check asserts the quoted clause count against the
specification while both are present, so the copy cannot silently drift while
`research/` is still here.
