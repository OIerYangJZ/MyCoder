# alpha.12 — what defining the acceptance suite is predicted to find

**Date:** 2026-08-17 · **Milestone:** `v0.1.0-alpha.12` — the acceptance suite

> **This document is committed before the derivation it predicts.** That is its
> only purpose. A prediction written after the result is a description, and the
> distinction is invisible in the finished document — so the order is made part of
> the history instead: this file lands in its own commit, before
> `docs/acceptance-suite.md` exists.
>
> Being wrong here is informative and costs nothing. Quietly editing a prediction
> afterwards costs the whole exercise, so §3 records how the comparison is allowed
> to be made.

---

## 1. The five predictions

From the milestone plan §9, unchanged.

| #   | Prediction                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Several MUSTs are covered by tests that never name the MUST, so the mapping has to be built by reading rather than by grep — and **two of them will turn out to be covered by nothing**. |
| P2  | The invariants are better covered than the MUSTs, because the security work had paired controls and the feature work had a checklist.                                                    |
| P3  | At least one clause will be discovered to be untestable as written, and the honest fix is a specification erratum, not an acceptance item.                                               |
| P4  | T3 and T4 together will hold more of the specification than expected, which is the finding that makes the tiering worth the trouble.                                                     |
| P5  | The suite will want a "the product says what it cannot do" tier, and that is alpha.9 §25.3's rule arriving as an acceptance item.                                                        |

If the work finds none of these and finds something else, that is the better
outcome, and it is why the suite is derived from the specification rather than
assembled from what is already known.

## 2. One thing that was already found, and therefore is not a prediction

Read before this file was written, while locating the clauses to derive from:

```text
spec §28, "v0.1 Acceptance Criteria", already exists — 21 unticked checkboxes
across six groups, prefixed "只有全部满足才标记 v0.1.0" — and nothing in this
repository points at it. One source comment mentions it in passing. No matrix,
no checklist, no CI job.
```

> **This paragraph was wrong, and the mapping found it the same day.** "Nothing in
> this repository points at it" is false: `tests/integration/agent-loop.test.ts` is
> organised around §28 and covers five of the 21 criteria by name. What is true is
> that nothing ever _enumerated_ §28 — no matrix, no checklist, no CI job. The
> block above is left as written, per §3's first rule, and the correction lives
> here beside it. It was produced by a `grep` truncated at twenty lines and never
> re-run, which is a smaller version of the defect this whole milestone is about.

It is recorded here, in the predictions document, precisely so it cannot be
presented later as a prediction that came true. The milestone plan was written
believing the definition of done did not exist anywhere; a fifth of it existed in
the normative document and had never been read against the evidence. That is a
finding about how this project reads its own specification, and it is the reason
§1's P1 is stated in terms of _coverage_ rather than existence.

## 3. How the comparison is allowed to be made

Filled in by `docs/alpha12-status.md` after the derivation and the mapping, under
three rules:

```text
1.  the prediction text above is not edited — a wrong prediction stays wrong,
    in this file, with the result recorded beside it in the status document;
2.  "partly right" is not a verdict. Each one is right, wrong, or unresolved
    because the work that would settle it did not happen;
3.  a prediction that turns out to be unfalsifiable as written is recorded as
    unfalsifiable, and that is a defect in the prediction rather than a result.
```

## 4. What is deliberately not predicted

The number of uncovered clauses. A number predicted here would become a target,
and the one thing the mapping must not do is aim at a figure — the count is
whatever reading the clauses produces. The plan requires only that it be
**non-zero on the first run**, and that requirement is a stop condition on the
derivation rather than a prediction about the software: a suite that covers
everything on the day it is written was written from the answers.

## Model provenance

No model was involved in any statement in this document. Every prediction is about
documents and their relationship to a test tree, and the comparison in
`docs/alpha12-status.md` will be made by reading the same files.
