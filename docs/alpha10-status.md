# `v0.1.0-alpha.10` — Status

**Date:** 2026-08-16
**Milestone:** Undo, and the second operator
**Baseline:** `v0.1.0-alpha.9.2` at `7d3abd7`

> A claim in this document is only as good as the evidence named beside it in
> `docs/alpha10-evidence-matrix.md`. Two rows there are not `PASS`, on purpose,
> and §5 below is about them.

---

## 1. Gates

| Gate                     | Result                                                 |
| ------------------------ | ------------------------------------------------------ |
| offline suite            | 1199 tests · 1106 pass · 0 fail · 93 skip (287 suites) |
| architecture lint        | 16 rules, no violations · 144/144 self-tests           |
| evidence gate            | 8 matrices, all claims resolve                         |
| package check            | 392 files, nothing forbidden, nothing dangling         |
| release gate, every tier | recorded below, at the exact commit tagged             |

Baseline at the start of the milestone was 1159 · 1066 pass · 0 fail · 93 skip.
The 40 new tests are the §16 regression matrix (26), the resume matrix (6) and
the CLOSURE B audit-trail suite (8).

---

## 2. What was built

**Undo.** The kernel can now reverse what it did. Five kinds — `replace`,
`create`, `overwrite`, `delete`, `move` — each with a precondition checked before
anything is written, all-or-nothing across a multi-file set, and a reversal that
is itself an ordinary journalled edit so undoing an undo needs no second code
path. It exists as a model-facing `Undo` tool and as `/undo`, sharing one
implementation through `ToolRuntime.executeControlCall`, so neither can reverse
something the other would refuse.

**The journal became durable.** It was a private array that died with the
process. It is now written to the event log for all four mutating tools and
rebuilt from that log on resume, so a session that crashed can still undo.

**Every undo says what it did not cover.** Foreign tool calls by server, shell
commands that changed source, the journal's own start boundary, and the count
already reversed — all derived from the session's state, never from a constant,
and stated even when the set is empty.

ADR-0025 and ADR-0026 record the decisions. `docs/alpha10-evidence-matrix.md`
records the evidence.

---

## 3. The three findings worth the milestone

### 3.1 Three of the four mutating tools were not in the audit trail

The dispatch read `record.name === 'Edit'`. `Write`, `Delete` and `Move` — the
three tools ADR-0016 added, the three whose mistakes are the _least_ recoverable
— changed the workspace and produced no `file.edited` event. `Delete` on an empty
directory reached neither the log nor the journal.

This had been true since alpha.7 shipped those tools, through two milestones and
two release gates. Nothing noticed because nothing asked the log this question.
ADR-0008 makes the log the audit trail, so this was a gap in a first-class
guarantee, not a missing convenience — it would have been worth fixing if undo
were never built, which is why the plan made it a closure rather than part of the
MAIN.

The fix keys on the journal entry rather than the tool's name, and the regression
enumerates the registry rather than a list of four. It caught `Undo` on its first
run, which is the behaviour a hardcoded list could not have had.

### 3.2 The §9 audit refuted its own premise, and found the real losses elsewhere

§19 ordered this second, before any undo code, because a negative answer would
change everything after it. §9 suspected `overwrite` of being lossy:

> a diff between two large unrelated contents is not obviously smaller than the
> content — so either the journal is carrying the content already under another
> name, or the reversal is lossy for some inputs.

`scripts/audit-diff-reversibility.ts` answers: **the first, emphatically.** A
coarse overwrite of a 5000-line file produces 147,818 bytes of diff for 68,890
bytes of content — 2.1× — because every old line is a `-` and every new line a
`+`. It is not lossy at all. It is expensive, which ADR-0025 §5 caps at 1 MiB per
entry with the audit fields retained and the reversal visibly lost.

The genuine losses are three the plan did not name: a **redacted** diff, **mixed
line endings**, and a change the differ cannot see at all (a file gaining a final
newline produces an empty diff).

And redaction turned out to be narrower still, which only building it revealed:
the redactor runs on the way into the **log**, not into the in-memory journal, so
the same edit is reversible before a restart and refused after one. Both halves
are held by a test pair, because neither says it alone. ADR-0025 §3 carries the
correction in the open.

The design consequence is the one that matters: **reversibility is verified, not
assumed.** Every reversal reconstructs the prior content, hashes it, and compares
against the recorded `oldHash` before writing. A loss mechanism nobody has thought
of yet produces a refusal, not a corrupted file, which makes the plan's Corruption
Stop structural rather than aspirational.

### 3.3 Undo refuses far more often than it succeeds, and that is the feature

Eight distinct refusal causes: `drifted`, `missing`, `protected`, `occupied`,
`not-reconstructible`, `diff-omitted`, `legacy`, `already-undone`. Most sessions
in a dirty workspace will meet at least one.

The plan's §10 called refusal "the interesting half" and it was right for a
reason that only became visible in the tests: the refusal messages are where the
product stops being able to lie. "`a.ts` changed after that edit — by you, by a
shell command, or by a tool the kernel cannot see" is a sentence that names the
alpha.9 hole in the course of declining to make it worse.

---

## 4. The measurement, and why it is weaker than it looks

Two models, N=3, three tasks, two arms. **Neither model called `Undo` once in
eighteen attempts.** Solve rate 9/9 in every arm.

And the fixture failed at the thing it was built for. Two tasks were meant to
create a difficulty — an edit refused for a stale receipt — where the tempting
wrong move is to reverse something. Both models read the file _after_ the script
that rewrote it, so the difficulty never occurred. What was measured is a tool
that was not needed, not a tool declined under pressure.

alpha.7's finding that adding a tool makes another harder to call does **not**
reproduce for `Undo`: flat on model 1, inverted on model 2, and the write-up reads
that as noise at N=3 rather than as a result.

Full write-up, including the harness change that would fix the fixture:
`docs/alpha10-undo-utility.md`.

---

## 5. What is not closed

### 5.1 CLOSURE A — a second operator: OPEN, fifth consecutive milestone

Everything from alpha.8 onward has been used once, by its author, on one machine.
That is still true.

A run is scheduled and the protocol is committed **before** it, in
`docs/alpha10-second-operator.md`, so it cannot be written to match the outcome.
It was not simulated with a fresh VM and the author's own hands, which §13
forbids explicitly and for a good reason: alpha.8 already measured the artifact
that way and found two real defects doing it. The variable here is the operator,
and an author on a clean VM holds it constant.

alpha.9 §26 predicted this item would be skipped. It has now been open across
alpha.8, alpha.8.1, alpha.9 and alpha.10, and the rule the plan set for itself is
recorded here as a commitment rather than a suggestion:

> if it is still open after alpha.11, the project should stop adding capability
> until it is closed.

### 5.2 CLOSURE C — decided, by downgrade

Three milestones carried "strict egress on a genuinely global resolved address"
as `NOT TESTED`. Both available hosts NAT every public name into
`198.18.0.0/15`, re-verified on both on 2026-08-16:

```text
github.com   → 198.18.1.168
example.com  → 198.18.2.134
```

alpha.10 §15 gave two options and option 1 needs a host that does not exist here,
so the claim is downgraded to `NOT APPLICABLE` with the reason attached — in
ADR-0017 as a section of its own, and in the alpha.6 and alpha.9 matrices. The
negative controls are unaffected and still pass: four non-global scopes refused,
each naming the scope. What has never been demonstrated end to end is the
positive case.

This is not a defeat and it is not progress. It is the vocabulary catching up
with the facts: `NOT TESTED` promises a fourth attempt this project has no way to
make. **A claim restated for the fourth time is not being tracked; it is being
avoided.**

---

## 6. Release

`v0.1.0-alpha.10`, tagged at the commit whose gate is recorded below.

Three ways to get the last step wrong, all documented in this repository and two
already fallen into: `release.yml`'s dispatch `ref` needs a full 40-character
SHA (an abbreviated one fails every tier at checkout, which looks like a
catastrophic regression); a docs-only commit after a green gate means the tag
points at an ungated commit; and never edit a document with an unasserted string
replacement. The exact commit was re-gated before tagging.

| Item                 | Value                                      |
| -------------------- | ------------------------------------------ |
| tagged commit        | see the tag; the gate below ran against it |
| release gate run     | recorded at tag time                       |
| offline, 2 platforms | pass                                       |
| container tier       | `KERNEL_CONTAINER_REQUIRED=1`              |
| native Linux tier    | `_REQUIRED`                                |

---

## 7. Likely alpha.11

Not pre-committed, and alpha.10's defect distribution should be read with the
same correction alpha.9 §26 needed: a milestone that builds undo will find
first-attempt defects in undo, and that says nothing about whether undo was the
right thing to build.

On current evidence the candidates are unchanged from the plan's §21 — `Read`
media, native network breadth, MCP breadth — with one reordering this milestone
earned: **the second operator is no longer a candidate among four.** It is the
oldest open item, it is the only one that can falsify a claim already made, and
the project has now written down what happens if it slips again.
