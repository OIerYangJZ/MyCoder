# v0.1.0-alpha.11 — status

**Milestone:** the debts · **Date:** 2026-08-16
**Baseline:** `v0.1.0-alpha.10` at `9ea00b754895e840929fe5848e3131de96dad02f`

> **The MAIN of this milestone did not happen.** alpha.11 was organised around
> CLOSURE A — one person who is not the author, using this software unaided — and
> no such person was available. It was not simulated, not automated, and not
> downgraded. Read §5 before reading anything else as a success.

---

## 1. Gates

```text
offline suite      1238 tests · 1145 pass · 0 fail · 93 skip
architecture lint  16 rules · no violations
lint self-tests    172 / 172
evidence gate      10 matrices · every claim resolves · corpus internally consistent
package check      392 files · nothing forbidden, missing or dangling
```

The evidence gate's own line, which is new and is the point of CLOSURE B:

```text
docs/open-evidence.md: 8 open item(s) indexed — 23 row(s) point at them,
                       6 closed elsewhere, 25 out of scope by decision
```

A reader counting open items in the index and the gate counting them now get the
same number, because the gate refuses to be green when they differ.

**Ten matrices, not nine.** alpha.10 reported eight. The ninth is
`docs/alpha6-evidence-matrix.md`, which had never been registered; the tenth is
this milestone's.

## 2. CLOSURE B — the evidence corpus as a gated artifact

Three checks, in `scripts/evidence-corpus.ts`, each with a fixture that makes it
fail (`tests/lint/evidence-corpus.test.ts`, 28 cases):

```text
1  one claim, one status          two matrices may not disagree about a claim
                                  unless the later names the earlier milestone
2  every open claim is indexed    and every index entry has a live row; neither
                                  list may grow a member the other does not have
3  a closed claim says so         **Closed by alpha.N**, agreeing with the index
                                  about which milestone closed it
```

Every non-`PASS` row in every matrix now declares what kind of non-claim it is —
`[open:A3]`, `[closed:C1]` or `[scope]` — and an unmarked row is a red build.
That is 54 rows across ten documents, and it fails closed: the row nobody
remembered to mark is exactly the row that goes stale.

### What the checks found on their first run

The corpus was **not** clean. Four defects, all pre-existing, all in a repository
whose evidence gate had been green for five milestones:

```text
D1  docs/alpha6-evidence-matrix.md had never been gated at all
D2  two of its rows carried the invented status "PASS — §62 closed"
D3  it had no Model provenance section, required of every matrix since alpha.8
D4  its non-claims table had no Status column, hiding two open claims, and one
    of its rows carried two different claims against two different index entries
```

**D1 is the one worth reading twice.** The alpha.6 matrix holds 83 rows of
enforcement claims — the whole scoped-egress milestone — and the evidence gate
had never read a line of it. Registering it would not have helped either: its
`Status` is the _sixth_ column and the parser read the second, so it would have
produced nonsense rather than coverage. The parser now reads tables by their
header. Meanwhile `docs/open-evidence.md` named that very document as the home of
two open claims, which means the index pointed at rows the gate could not see.

The mechanism built to catch drift had drift inside it, and the only reason it
was found is that alpha.11 wrote a check that asks "is every matrix in this
directory gated?" — a question nobody had asked in five milestones of asking
harder ones.

### Where the implementation exceeds the plan, deliberately

§7.1 says two rows whose **requirement text** matches must carry the same status.
Implemented that way, it would have caught two of the five occurrences of the
defect it is named after: the claim that carried two statuses was written five
different ways across five matrices, and only two of them match as strings. So
the check also groups by **index entry**, which is what actually makes two rows
one claim. Noted here rather than left as a silent improvement.

## 3. CLOSURE C — A3 closed, four left, counted and named

**A3 is closed.** `deepseek-chat` ran a real task in a real workspace on
`linux-vm`, on the native Linux backend — Landlock ABI 8, seccomp, no container
runtime — and the edits were read back off the host rather than taken from the
model's summary. The credential was placed through `mycoder setup-credential`
and removed afterwards. `docs/alpha11-native-live-dogfood.md`.

This is the first time the project's strongest enforcement claim has had a real
model behind it. alpha.7 built the backend, alpha.8 ran a packaged install on it
with the fake model, and the row said "partially closed" for three milestones.

**A7 was re-verified and is unchanged.** `api.deepseek.com` resolves to
`198.18.1.159` on `linux-vm`. It is the same resolver as the Mac's, so this is a
second machine and not a second data point. Still `NOT APPLICABLE` for the reason
in ADR-0017.

**Four remain, and are named rather than dropped:** A2 (root on a Linux host),
A4 (a funded OpenAI account), A5 (a vendor invoice), A6 (a Windows machine).
None is a technical limit and none was available.

## 4. CLOSURE D — the fixture that could not fail, fixed

alpha.10 §17 measured whether a model reaches for `Undo` instead of reading the
error, and got 0/9 — from two tasks that never put either model in difficulty. The
workspace was changed by a shell command _the model scheduled_, so both models
read afterwards and **not one call was rejected in the entire run**. A count of
zero from a fixture that could not have produced anything else is not a result.

`evals/experiments/interference.ts` moves the difficulty to where it has to be:

```text
Read executes → receipt issued → the harness rewrites the file → Edit refused STALE_FILE
```

The model neither causes it nor is warned about it. The seam fires on every read
until a refusal lands and then disarms, so a model that reads twice cannot
sidestep it and the task stays solvable. It decorates existing tools, registers
nothing, lives outside `src/`, and does not ship — each asserted, not stated.

**And every attempt now asserts its own premise.** An attempt where the file did
not change, or where nothing was refused for it, fails its own check.

### The result

```text
the difficulty occurred      12 / 12 attempts, both models, both arms
                             (alpha.10: 0 / 12)
Undo called                  0 / 18 attempts where it existed
solved                       9 / 9 in all four cells, every one by re-reading
```

§17's suspected failure mode **did not occur**, and that is now a negative result
instead of a null one: the models met the difficulty, had the tool, and did not
reach for it. What it does not establish is that the failure mode is impossible —
one difficulty, one recovery shape, N=3. `docs/alpha11-undo-utility.md` §4 lists
what is not claimed, including two arm differences that point in opposite
directions on the two models and are reported precisely because they disagree.

## 5. CLOSURE A — the MAIN, open, and what that now costs

`v0.1.0-alpha.11` ships with CLOSURE A **`NOT TESTED`**. Sixth consecutive
milestone. No operator was available.

What was done instead, none of which is the run:

```text
the §9 predictions committed before it, not after      five about the product,
                                                       two about the method
the protocol left exactly as written                   a protocol relaxed to fit
                                                       the available person
                                                       measures the person
the findings table saying "not run" in those words     §13 makes "empty because
                                                       not run" and "empty
                                                       result" different results
```

**alpha.9 §26's rule is now in force rather than restated.** alpha.10 recorded it
as a commitment against itself:

> if it is still open after alpha.11, the project should stop adding capability
> until it is closed.

It is still open. alpha.11 added no capability — no tool, no ADR that grants
anything — and **the next milestone does not add capability either**. That is not
a planner's preference; it was decided two milestones ago, in advance, precisely
so that it could not be re-argued by whoever was in a hurry.

The tempting move was available and was refused: A7 earned its `NOT APPLICABLE`
by being impossible on any machine here, and applying the same downgrade to A1
would tidy the corpus in one line. A1 is not impossible. It is one hour of
somebody else's time, and it is simply not done.

## 6. Defects found this milestone

| #   | Defect                                                                 | Where                 | Fixed                                                     |
| --- | ---------------------------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| 1   | `docs/alpha6-evidence-matrix.md` was never in the gate — 83 rows       | `scripts/evidence.ts` | registered; parser reads tables by header                 |
| 2   | the parser could not read a status-last table at all                   | `scripts/evidence.ts` | `readColumns` finds `Status` by name                      |
| 3   | two alpha.6 rows carried `PASS — §62 closed`, not a defined status     | alpha.6 matrix        | annotation moved to the evidence cell                     |
| 4   | the alpha.6 matrix had no `Model provenance` section                   | alpha.6 matrix        | added; it makes no behavioural claims and now says so     |
| 5   | alpha.6's non-claims table had no `Status`, hiding two open claims     | alpha.6 matrix        | eleven gated rows, each marked                            |
| 6   | one row carried two claims against two index entries                   | alpha.6 matrix        | split into A5 and A4                                      |
| 7   | the §17 fixture could not produce the condition it measured            | `evals/experiments/`  | the interference seam, with its own negative control      |
| 8   | uncited `--scripted` artifacts were committed, against the stated rule | `evals/results/`      | deleted; the rule is in `.gitignore` and was not followed |

Seven of the eight are about the project's account of itself rather than about
the product, which is what a milestone with no capability in it looks like when
it works.

## 7. What is not claimed

```text
that the corpus is TRUE          the three checks establish that it is
                                 internally consistent. A row can point at a
                                 real test, agree with every other row, and be
                                 wrong; nothing here would notice
that alpha.6's 83 rows are now   they are checked for status vocabulary and
fully checked                    corpus consistency. Their evidence lives in
                                 four columns of prose, not in the `kind:`
                                 vocabulary, and is not resolved
that the second operator run     it did not happen. Sixth milestone
happened in any form
that Undo is safe from misuse    one difficulty, one recovery shape, N=3
that A7 is closer to closing     both available hosts share one resolver
```

## 8. Release

Recorded after the tag, without moving it. Full 40-character SHA on the dispatch;
the exact commit being tagged is re-gated rather than a docs-only commit landing
after a green run.

```text
code commit          f68f8901d595e57a0e303e03a07e8cd9067bff64
gate at that commit  dispatch run 31956777900 — green on every tier
tag                  v0.1.0-alpha.11 -> f68f8901d595e57a0e303e03a07e8cd9067bff64
gate at the tag      tag-push run 31956907248 — green on every tier
```

### 8.1 Runs

Both runs, at the same commit, each green on all six jobs:

| Run           | Trigger             | Ref                                        | Result |
| ------------- | ------------------- | ------------------------------------------ | ------ |
| `31956777900` | `workflow_dispatch` | `f68f8901d595e57a0e303e03a07e8cd9067bff64` | green  |
| `31956907248` | tag push            | `v0.1.0-alpha.11`                          | green  |

Jobs in each: offline gates on ubuntu **and** macOS, `Container Tier @ exact
commit (REQUIRED)`, `Native Tier @ exact commit (REQUIRED)`, and the artifact
build. `_REQUIRED` on both enforcement tiers, so a missing runtime fails rather
than skips — a green run whose enforcement evidence silently skipped is the
thing release.yml exists to prevent.

**The tag does not move.** This section was written after both runs completed and
is committed on top of the tagged commit, which is why the tag points at
`f68f890` and this paragraph does not. A docs-only commit landing _before_ the
gate would have meant tagging an ungated tree; a docs-only commit landing _after_
it, as this one does, leaves the gated commit exactly as it was gated.
