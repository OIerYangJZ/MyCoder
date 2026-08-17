# Open evidence — everything this project has not established

**Gated from 2026-08-16 (alpha.11).** One index for every claim that is not
`PASS` anywhere in the evidence corpus, what would close it, and who can unblock
it.

> **This file is read by `scripts/evidence.ts`, not merely by people.** Every
> non-`PASS` row in every matrix names an entry here — `[open:A3]` — or declares
> that it is not a claim about the world at all — `[scope]` — or that a later
> milestone closed it — `[closed:C1]`, with `**Closed by alpha.N**` in its own
> notes for a human to read. The gate fails if an entry here has no row, if a row
> names an entry that is not here, if one claim carries two statuses, or if a
> closed claim still says it is open. Editing this file by hand is still how it
> changes; what has changed is that getting it wrong is now a red build.
>
> The ids are load-bearing. Renumbering an entry orphans every row that names it.

## Why this file exists

Three times now, a row has been closed by a later milestone and the original left
saying `NOT TESTED`, because nothing reconciled the matrices against each other:

```text
OS-level isolation of a child      alpha.4 said NOT TESTED; alpha.5 closed it and said so
host-scoped network allowlist      alpha.5 said "needs a proxy"; alpha.6 built the proxy
tool usability harness             alpha.7's own §B is the harness it says does not exist
```

And once, the opposite: the same claim carried `NOT APPLICABLE` in three matrices
and `NOT TESTED` in two, an hour after being downgraded.

`scripts/evidence.ts` alone caught neither. It checks that a claim **points at
something that exists**; on its own it did not check that a closed claim was
back-annotated, or that one claim carried one status. Both were legal states of a
legal document, and both were found by a person reading rather than by a build.

`scripts/evidence-corpus.ts` is the reconciliation, and this index is its
authority. The rule is unchanged and is now enforced: **an item leaves this file
only when the row that carried it is annotated in its own matrix.** Deleting from
here without that now fails the build, rather than starting the drift again.

What is still done by hand, and cannot be otherwise, is deciding **which** entry a
new non-`PASS` row belongs to. The gate insists that the row say; it cannot know
whether the answer is right.

---

## A. Blocked on a person or a machine — these are bought, not built

The whole of this section is procurable. None of it is a technical limit.

| #   | Claim                                                            | Needs                                                                  | Cost                            | Carried in                                                                                                                                             |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | **A second operator has run this** (CLOSURE A)                   | One person who is not the author, on a machine that is not this one    | ~1 hour of their time           | alpha.10 §10, alpha.12 §7 — and now **T4 of the acceptance suite**: items `R01`, `R02`, `R03`, which ADR-0027 §3 makes a precondition of `v0.1.0-rc.1` |
| A2  | Hostile-network behaviour: packet loss, link flapping            | root on a Linux host to inject with `tc`/`netem`                       | one sudo password, an afternoon | alpha.3                                                                                                                                                |
| A4  | Clean direct-OpenAI behavioural validation                       | A funded OpenAI account (the current one returns `insufficient_quota`) | account top-up                  | alpha.5 §56, alpha.8                                                                                                                                   |
| A5  | Billing-grade delegated cost                                     | A vendor invoice, or per-alias published pricing, to compare against   | one account query               | alpha.4, alpha.5                                                                                                                                       |
| A6  | Windows container enforcement / Docker Desktop status            | A Windows machine                                                      | one machine                     | alpha.5, alpha.6                                                                                                                                       |
| A7  | Strict egress on a genuinely global resolved address (CLOSURE C) | One Linux host on an ordinary resolver — not behind the 198.18/15 NAT  | ~30 min once a host exists      | alpha.6/7/8/9, alpha.10 §9                                                                                                                             |

**A7 is now `NOT APPLICABLE`, not `NOT TESTED`** — alpha.10 §15 declined a fourth
restatement. It is listed here anyway because a host would still close it, and
because ADR-0017 says the paragraph should be **deleted rather than amended** if
one appears. Re-verified on `linux-vm` on 2026-08-16 during alpha.11:
`api.deepseek.com` resolves to `198.18.1.159` there. It is the network, not the
host, and a second machine behind the same resolver is not a second data point.

**A3 was closed by alpha.11** and has moved to §C. It is the only item this
section has ever lost to a machine becoming available.

### Priority, if you are only getting one thing

**A1**, and by a wider margin than before. It is the only item on this list that
can _falsify a claim the project has already made_, it has now been open across
five milestones, and alpha.11 was organised around it and could not run it.
Everything else confirms or denies something already suspected; A1 can surprise.

It is also the item that has stopped the project moving: alpha.9 §26's rule —
recorded as a commitment by alpha.10 and now in force — is that no capability is
added until A1 is closed. One hour of somebody else's time is the whole price.

**As of alpha.12 it is no longer only a row.** ADR-0027 makes it T4 of the
acceptance suite and makes T4 a precondition of `v0.1.0-rc.1`, and ADR-0027 §5
makes `v0.1.0-alpha.12` the last tag cut while it is open. A row can be carried
indefinitely — seven milestones is the proof — and a tier that gates the release
candidate cannot. `docs/second-operator-invitation.md` is the one page a stranger
can be sent, which is the only part of this that was ever the author's to make
cheaper.

Second used to be A3. A3 is closed. Second is now **A4**, because it is the only
remaining item that a payment closes rather than a person.

---

## B. Not possible, and should never be marked otherwise

| #   | Claim                                      | Why not                                                                                                                                    |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | Native-Linux-equivalent isolation on macOS | Docker Desktop runs a Linux VM. Establishing this would require macOS to be Linux. Not hard — false.                                       |
| B2  | Fetched content cannot inject instructions | Proving a negative. Labelling, script-stripping and size caps reduce the surface and are tested; nothing closes it. `docs/threat-model.md` |

These two should stay `NOT TESTED` **forever**, and a future milestone that
"closes" them has misunderstood them. B1's honest form is already in the product:
`/status` reports the platform note itself.

---

## C. Closed elsewhere, annotated, kept for history

Not open. Listed so a reader counting `NOT TESTED` rows does not count them twice.

| #   | Claim                                      | Closed by                                        |
| --- | ------------------------------------------ | ------------------------------------------------ |
| C1  | OS-level isolation of a child              | alpha.5 — "Subagent + Container green"           |
| C2  | host-scoped network allowlist enforcement  | alpha.6 — the scoped egress proxy                |
| C3  | Tool usability: success rate, step counts  | alpha.7 §B — the friction table and the runner   |
| C4  | a release tag whose own gate is green      | alpha.9 CLOSURE A — `v0.1.0-alpha.8.1`           |
| C5  | a live-model dogfood on the native backend | alpha.11 — `docs/alpha11-native-live-dogfood.md` |

---

## D. Uncovered by the acceptance suite — nothing is in the way but the work

**New in alpha.12**, and a different kind of item from everything above. §A is
blocked on a person or a machine and §B is impossible; these are clauses of the
normative specification that **nothing checks**, where the only thing standing in
the way is that nobody has done it. Filing them under §A would have made "these
are bought, not built" false.

All five were found by deriving `docs/acceptance-suite.md` from the specification
and then looking for the evidence, rather than by reading the tests and describing
them. None is being closed in alpha.12: the milestone defines the suite, and the
no-capability commitment (ADR-0027 §5) means the work they name belongs to a later
one.

| #   | Claim                                                                      | Suite item | What would close it                                                                                                |
| --- | -------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| D1  | Hook network egress goes through the unified egress policy                 | `M09`      | One test that gives a hook a network capability and asserts the gate decided it — the shape `mcp-http` already has |
| D2  | `FakeExecutor` and `FakeFileSystem` exist                                  | `M17`      | Build them, or a specification erratum saying the guarantee is met by a temp directory and the local backend       |
| D3  | **`StepContext` is immutable during a model request** (invariant 2)        | `V02`      | One test that mutates a live `StepContext` mid-request and asserts the step still sees its snapshot                |
| D4  | **Large tool output has a budget and an artifact reference** (invariant 9) | `V09`      | One test asserting a >budget output is truncated, reported truncated, and reachable through the artifact it names  |
| D5  | stdout/stderr truncation is uniform across backends                        | `A15`      | A truncation case in `tests/integration/backend-conformance.test.ts`, which is where "unified" means anything      |

**D3 and D4 are release-blocking invariants.** Spec §25 says violating any of its
fifteen means do not release, and these two have never been exercised. That is the
most serious thing in this file, and it was invisible for twelve milestones because
every gate here checks claims that _were_ made and none looked for claims that were
never made at all.

`scripts/acceptance.ts` reconciles this section with the suite in both directions:
an uncovered item named nowhere here fails the build, and an entry here that names
only items which have since been covered fails too — the second is how an index
outlives its findings and stops being read.

---

## The gate that made this file checkable

Done in alpha.11, as `scripts/evidence-corpus.ts`. The three checks are §7 of
that milestone's plan and they are described at the top of this file.

The paragraph that used to be here said the gate should not be added in the same
commit as the list it gates, "because a gate added in the same commit as the list
it gates has never been run against a repository that violates it". That concern
was met a different way, and a better one: each check ships with a fixture that
**violates** it and a fixture that satisfies it
(`tests/lint/evidence-corpus.test.ts`), so every check has been run red before it
was ever run green.

It also found four things on its first run against this repository, which is the
answer to whether the corpus was clean:

```text
D1  docs/alpha6-evidence-matrix.md had never been gated at all — 83 rows,
    five milestones, and this index named it as the home of two open claims
D2  two of its rows carried the invented status "PASS — §62 closed"
D3  it had no Model provenance section, required since alpha.8
D4  its non-claims table had no Status column, so the two open claims in it
    were invisible; one row carried two claims against two different entries
```

**What the gate still does not do** is decide whether a claim is _true_. It
checks that this project's account of itself is internally consistent. A row can
say `PASS`, point at a test that exists, agree with every other row, and be
wrong; nothing here would notice, and pretending otherwise would be the overclaim
this file exists to prevent.
