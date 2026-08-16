# alpha.11 evidence matrix — the debts

**Date:** 2026-08-16
**Milestone:** `v0.1.0-alpha.11` — the debts
**Rule:** no PASS without named, executable evidence. And, new this milestone:
no check without a fixture that makes it fail.

> **Read §0 first.** The MAIN of this milestone is `NOT TESTED` and says so.
> alpha.11 was organised around CLOSURE A — a second operator — and no second
> operator was available. Nothing here simulates one, which §6 and §13 forbid,
> and the release documents say so in those words rather than omitting the row.

---

## 0. What this milestone did and did not close

| Closure                                      | Outcome                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **MAIN — CLOSURE A, the second operator**    | **NOT TESTED.** No operator was available. Sixth consecutive milestone open              |
| CLOSURE B — the evidence corpus as a gate    | **closed**: three checks, each with a fixture that fails it, plus four defects           |
| CLOSURE C — the procurable non-claims        | **partial**: see §5 for what the machines allowed and what they did not                  |
| CLOSURE D — a fixture that produces its case | **closed**: the seam exists, fails closed, and both models were re-run                   |
| §1.1's commitment                            | **binds**: CLOSURE A is open after alpha.11, so capability work stops until it is closed |

---

## 1. CLOSURE B — one claim, one status (§7.1)

| Requirement                                                       | Status | Evidence                                                                    | Notes                                                          |
| ----------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| two matrices disagreeing about one claim are refused              | PASS   | test:the same claim with two statuses is refused                            | the alpha.10 defect verbatim, as a fixture                     |
| NEGATIVE CONTROL: two matrices agreeing are accepted              | PASS   | test:NEGATIVE CONTROL: two matrices agreeing about one claim are accepted   | a check that cannot pass is not a check either                 |
| a later row that names the earlier milestone is accepted          | PASS   | test:the later row naming the earlier milestone is accepted                 | the corpus spans time; what is forbidden is saying so silently |
| claims worded differently but sharing an index entry are compared | PASS   | test:claims worded differently but pointing at one index entry are compared | see §7 — this is where the check exceeds the plan              |
| one disagreement is reported once, not once per key               | PASS   | test:a disagreement is reported once, not once per key                      | two grouping keys, one defect                                  |
| normalisation ignores emphasis and trailing section references    | PASS   | test:normalisation ignores emphasis and a trailing section reference        | `**X** (§39–41)` and `x` are one claim                         |
| normalisation does not merge two different claims                 | PASS   | test:normalisation does not merge two genuinely different claims            | a false failure is how a gate gets switched off                |

## 2. CLOSURE B — every open claim is in the index (§7.2)

| Requirement                                                 | Status | Evidence                                                              | Notes                                                          |
| ----------------------------------------------------------- | ------ | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| a non-PASS row with no index marker is refused              | PASS   | test:a non-PASS row with no marker is refused                         | fails closed: the row nobody marked is the row that goes stale |
| a row naming an entry the index does not define is refused  | PASS   | test:a row naming an entry the index does not define is refused       | one direction                                                  |
| an index entry with no live row is refused                  | PASS   | test:an index entry with no live row is refused                       | the other, and it fails differently                            |
| a row carrying two markers is refused                       | PASS   | test:a row carrying two markers is refused                            | open, closed or out of scope — not two of them                 |
| NEGATIVE CONTROL: a marked row with a matching entry passes | PASS   | test:NEGATIVE CONTROL: a marked row with a matching entry is accepted |                                                                |
| an out-of-scope row needs no index entry                    | PASS   | test:an out-of-scope row needs no index entry                         | 25 NON-GOALs in the index would drown the nine real items      |
| a PASS row needs no marker                                  | PASS   | test:a PASS row needs no marker                                       | the checks are about non-claims                                |
| the index refuses an entry with no id                       | PASS   | test:the index refuses an entry with no id                            | `docs/open-evidence.md` is now parsed, not maintained          |
| the index refuses a duplicate id                            | PASS   | test:the index refuses a duplicate id                                 |                                                                |
| the shipped index parses with no problems                   | PASS   | test:the shipped index parses, and every entry is reachable           | run against the real document, not a fixture                   |

## 3. CLOSURE B — a closed claim cannot keep saying it is open (§7.3)

| Requirement                                                       | Status | Evidence                                                                  | Notes                                                               |
| ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| a closed row with no readable closure is refused                  | PASS   | test:a closed row with no readable closure is refused                     | `**Closed by alpha.N**`; the marker alone is for the gate           |
| a row whose closure milestone disagrees with the index is refused | PASS   | test:a row whose closure milestone disagrees with the index is refused    | two accounts of when a thing closed is the same defect, further out |
| a row indexed as open while claiming to be closed is refused      | PASS   | test:a row indexed as open while claiming to be closed is refused         | the literal §7.3 sentence                                           |
| NEGATIVE CONTROL: a correctly closed row is accepted and counted  | PASS   | test:NEGATIVE CONTROL: a closed row that says so is accepted, and counted |                                                                     |
| open, closed and out-of-scope rows are counted separately         | PASS   | test:open, closed and out-of-scope rows are counted separately            | so a reader's count and the gate's count are the same number        |
| the gate prints both counts side by side                          | PASS   | artifact:docs/alpha11-status.md                                           | `9 open item(s) indexed — 19 row(s) point at them`                  |
| a section C entry that names no milestone is refused              | PASS   | test:a section C entry that names no milestone is refused                 |                                                                     |

## 4. CLOSURE B — the four defects the checks found on first run

Every one of these was in the corpus before this milestone, in a repository
whose evidence gate was green.

| Requirement                                                    | Status | Evidence                                                          | Notes                                                                                   |
| -------------------------------------------------------------- | ------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **D1** `docs/alpha6-evidence-matrix.md` was never gated        | PASS   | test:every evidence matrix in docs/ is registered in the gate     | 83 rows, ungated for five milestones, cited by the index as home to two open claims     |
| **D1** the status-last table shape is read rather than skipped | PASS   | test:the status-last table shape is read, not skipped             | the gate read column 2; alpha.6's status is column 6                                    |
| **D2** two alpha.6 rows carried an invented status             | PASS   | artifact:docs/alpha6-evidence-matrix.md                           | `PASS — §62 closed` and `PASS — §63 closed`; the annotation moved to the evidence cell  |
| **D3** the alpha.6 matrix had no `Model provenance` section    | PASS   | artifact:docs/alpha6-evidence-matrix.md                           | alpha.8 §19 has applied since alpha.8; the matrix was outside the gate that enforces it |
| **D4** alpha.6's non-claims table was invisible to the gate    | PASS   | artifact:docs/alpha6-evidence-matrix.md                           | two columns, no `Status`; two open claims lived in it. Now eleven gated rows            |
| **D4** one row carried two claims against two index entries    | PASS   | artifact:docs/alpha6-evidence-matrix.md                           | "billing-grade cost, direct-OpenAI attribution" → A5 and A4, split                      |
| a table with no `Status` column is skipped, not misread        | PASS   | test:a table with no Status column is skipped rather than misread | legends stay legends                                                                    |
| one table's layout does not leak into the next                 | PASS   | test:one table layout does not leak into the next table           |                                                                                         |
| the gate is green on the repository as it stands               | PASS   | artifact:docs/alpha11-status.md                                   | §1 records the counts                                                                   |

## Model provenance

**This matrix makes one live-model behavioural claim**, and it is §6's: the §17
undo-utility re-run, measured on `deepseek-chat` and on `gpt-5.6-terra` through
the relay, N=3 each, both named in the rows themselves and in
`docs/alpha11-undo-utility.md`.

Every other row is a property of the evidence corpus, the test harness or the
release machinery, measured directly and with no model involved.
