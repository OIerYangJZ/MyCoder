# `v0.1.0-alpha.10` — Evidence Matrix

**Rule (alpha.3 §32.1, unchanged since):** a checklist item without named evidence
is not PASS.

`node scripts/evidence.ts` parses this table and every earlier milestone's, and
fails the build on any `PASS` with an empty evidence cell, any reference with no
recognised `kind:` prefix, any `test:`/`suite:` naming something that appears
nowhere under `tests/`, any `artifact:` pointing at a missing or untracked file,
and any matrix with no `Model provenance` section.

Evidence prefixes: `test:` `suite:` `ci:` `eval:` `artifact:` `live:` `manual:`.

> **Read §0 first.** Two rows are not PASS and both are deliberate: CLOSURE A is
> `NOT TESTED` and scheduled, and CLOSURE C is `NOT APPLICABLE` — downgraded this
> milestone from `NOT TESTED` after a fourth restatement was declined. Neither is
> omitted, because a matrix that lists only what was finished is the exact failure
> mode alpha.8 was about.

## Model provenance

**Most rows in this matrix are structural and model-independent.** A reversal
either restores the recorded bytes or it does not; a refusal either names the
path or it does not; an event either reaches the log or it does not. None of that
depends on which model is driving, and all of it is asserted by the offline suite
against `FakeModel`.

The exception is §8, which is behavioural and names two models explicitly:

- **Model 1 — `deepseek-chat`** (DeepSeek, `openai-chat`);
- **Model 2 — `gpt-5.6-terra`** through the relay at `api1.aisz.mom`
  (`openai-chat`) — a relay, and the write-up says so again.

Same fixtures, same prompts, same N=3, no per-model tuning. Reported side by side
and never averaged (alpha.8 §22). Full write-up: `docs/alpha10-undo-utility.md`,
which also states what the numbers do **not** support — and in this milestone
that section is longer than the results.

Host tier: offline suite on macOS arm64 (Darwin 25.5.0). Release gate on GitHub
runners, ubuntu-latest and macos-latest.

---

## 0. What this milestone reached, and the two things it did not

The MAIN is complete: the kernel can reverse what it did, refuses rather than
guessing, never writes a subset of what it was asked to reverse, and states what
it did not cover from the session's own state.

| Area                                                | State                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| CLOSURE B — the durable record of Write/Delete/Move | **done**, and generalised so a fifth tool cannot re-open it                   |
| the §9 audit, before any undo code                  | **done** — and it refuted §9's own prediction                                 |
| ADR-0025, ADR-0026                                  | **done**                                                                      |
| the journal rebuilt from the log on resume          | **done** — undo survives a crash                                              |
| reversal per kind, with the precondition check      | **done** — five kinds, eight refusal causes                                   |
| two-phase apply, all or nothing                     | **done**                                                                      |
| the uncovered set, derived from the session         | **done** — and it says so when the set is empty                               |
| undo as a tool and a control command                | **done** — one implementation, `ToolRuntime.executeControlCall`               |
| freshness invalidation                              | **done**                                                                      |
| the regression matrix with reverse controls         | **done** — 32 tests, every refusal paired with a control that must pass       |
| the two-arm experiment, both models                 | **done** — N=3 each, and the finding is a null one with a stated fixture flaw |
| CLOSURE C — the clean-resolver non-claim            | **decided**: downgraded to `NOT APPLICABLE` with the reason in ADR-0017       |
| CLOSURE A — a second operator                       | **OPEN**, scheduled, protocol committed before the run                        |

**Two things this milestone did not do**, both stated rather than omitted:

1. **CLOSURE A did not happen.** Fifth consecutive milestone. The protocol is
   `docs/alpha10-second-operator.md`, committed before the run so it cannot be
   written to match the outcome. Per alpha.9 §26's own rule, if it is still open
   after alpha.11 the project should stop adding capability until it is closed.
2. **The §17 experiment did not provoke the failure mode it was built for.** Both
   models avoided the difficulty rather than resisting it, so "no model reached
   for undo under pressure" is not what was measured. `docs/alpha10-undo-utility.md`
   says so at length and names the harness change that would fix it.

---

## 1. CLOSURE B — every mutation reaches the durable log (ADR-0025 §1)

| Requirement                                                | Status | Evidence                                                              | Notes                                                                |
| ---------------------------------------------------------- | ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Write` emits `file.edited` on create                      | PASS   | test:Write — creating a file emits file.edited                        | Produced no event at all before alpha.10                             |
| `Write` emits `file.edited` on overwrite, with both hashes | PASS   | test:Write — overwriting emits file.edited with both hashes           |                                                                      |
| `Delete` emits `file.edited` carrying the content          | PASS   | test:Delete — removing a file emits file.edited carrying the content  | The diff is the copy, which is why a deletion is reversible          |
| an **empty-directory** removal reaches the log             | PASS   | test:Delete — an empty directory reaches the log too                  | The one path that reached neither the journal nor the log            |
| `Move` emits `file.edited` naming both paths               | PASS   | test:Move — a rename emits file.edited naming both paths              | `movedFromPath` is new; `movedFrom` alone was a display string       |
| `Edit`, the one tool that worked, still does               | PASS   | test:Edit — the one tool that already worked still does               | Including `linesAdded`/`linesRemoved`, which the old payload carried |
| the guard is **generic**, not a list of four               | PASS   | test:no mutating builtin changes the workspace without journalling it | Enumerates the registry; it caught `Undo` on the first run           |
| a delegated child's edits are journalled and attributed    | PASS   | test:a child's edits are journalled under its delegation id           | ADR-0025 §7; the answer was in the code and had never been stated    |

---

## 2. The §9 audit — is the recorded diff actually reversible?

Run before any undo code was written, as §19 ordered. **It refuted §9's own
prediction**, which is the reason §19 put it second.

| Requirement                                                | Status | Evidence                                                                  | Notes                                                                |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| the audit exists and is executable                         | PASS   | artifact:scripts/audit-diff-reversibility.ts                              | 14 cases; `node scripts/audit-diff-reversibility.ts`                 |
| `overwrite` past the LCS ceiling round-trips byte-for-byte | PASS   | test:an overwrite of a large file — §9 said this was the lossy candidate  | 5000 unrelated lines each side; §9 suspected loss, and there is none |
| the cost of that is measured, not hand-waved               | PASS   | artifact:docs/adr/ADR-0025-the-edit-journal-as-a-durable-record.md        | 147,818 B of diff for 68,890 B of content — 2.1×. ADR-0025 §2        |
| a deletion round-trips byte-for-byte                       | PASS   | test:a delete — the content returns byte-for-byte                         |                                                                      |
| the real losses are identified                             | PASS   | artifact:docs/adr/ADR-0025-the-edit-journal-as-a-durable-record.md        | Redaction, mixed EOL, a whitespace-only change. ADR-0025 §3          |
| reversibility is **verified per entry**, never assumed     | PASS   | test:a redacted diff is reversible in-process and refused after a restart | Reconstruct → hash → compare with `oldHash` → write, or refuse       |

---

## 3. Reversal, per kind (ADR-0026 §2)

| Requirement                                  | Status | Evidence                                                                 | Notes                                                         |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `replace` — content and hash both return     | PASS   | test:a replace — the content and the hash both return                    |                                                               |
| `create` — the file is gone again            | PASS   | test:a create — the file is gone again                                   | Reversing a create is a deletion, and declares one            |
| `delete` — the content returns byte-for-byte | PASS   | test:a delete — the content returns byte-for-byte                        |                                                               |
| `move` — both paths are back                 | PASS   | test:a move — both paths are back where they were                        |                                                               |
| `overwrite` — including past the ceiling     | PASS   | test:an overwrite of a large file — §9 said this was the lossy candidate |                                                               |
| undo of an undo, by the ordinary mechanism   | PASS   | test:an undo of an undo, by the ordinary mechanism                       | The reversal is journalled, so this needs no second code path |
| undo with nothing to undo                    | PASS   | test:undo with nothing to undo says so, and still states the limits      | And still enumerates the limits                               |

---

## 4. Refusal — the interesting half (ADR-0026 §2, plan §10)

Every refusal row is paired with a reverse control that **must pass**. A denial
that cannot be made to succeed is not evidence (alpha.9's HTTP address check is
the model copied here).

| Requirement                                             | Status | Evidence                                                                          | Notes                                                              |
| ------------------------------------------------------- | ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| refuses when the file changed underneath, naming it     | PASS   | test:refuses when the file changed underneath, and names it                       | `[drifted]`, and the message names the three possible causes       |
| REVERSE CONTROL: it succeeds when nothing touched it    | PASS   | test:reverse control: the same undo succeeds when nothing touched the file        |                                                                    |
| refuses when the file was deleted underneath            | PASS   | test:refuses when the file was deleted underneath                                 | And writes nothing                                                 |
| refuses to restore a deletion onto an occupied path     | PASS   | test:refuses to restore a deleted file whose path is occupied again               | `[occupied]`                                                       |
| refuses a move-back whose source is occupied            | PASS   | test:refuses a move-back whose source is now occupied                             |                                                                    |
| REVERSE CONTROL: the move-back succeeds when it is free | PASS   | test:reverse control: the move-back succeeds when the source is free              |                                                                    |
| refuses a path that has become protected                | PASS   | test:it refuses a path that has become protected                                  | The policy engine refuses first, at the declared access — stronger |
| refuses a redacted diff, after a restart                | PASS   | test:a redacted diff is reversible in-process and refused after a restart         | The pair is the finding; neither half says it alone                |
| REVERSE CONTROL: the same rewrite without a secret      | PASS   | test:reverse control: the same rewrite without a secret is reversible             |                                                                    |
| refuses an entry from a pre-alpha.10 log, naming why    | PASS   | test:an edit recorded by a kernel older than alpha.10 is listed and refused       | `[legacy]`, and it is still listed for audit                       |
| refuses an entry whose diff exceeded the ceiling        | PASS   | test:an entry whose diff exceeded the size ceiling is refused, naming the ceiling | `[diff-omitted]`                                                   |

---

## 5. All or nothing (ADR-0026 §3) — the Silent Partial Stop

| Requirement                                            | Status | Evidence                                                               | Notes                                                              |
| ------------------------------------------------------ | ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| three files, one drifted: **nothing** is written       | PASS   | test:three files, one drifted: nothing is written                      | All three files asserted unchanged, not just the drifted one       |
| REVERSE CONTROL: all three reverse together            | PASS   | test:reverse control: with nothing drifted, all three reverse together |                                                                    |
| two edits to one file reverse in order                 | PASS   | test:two edits to one file reverse in order, back to the original      | Phase one projects its own effects, or the second reads as drifted |
| a mid-write failure is reported, never described as ok | PASS   | artifact:src/tools/builtin/undo.ts                                     | Not preventable, only reportable; the message lists what landed    |

---

## 6. Undo is an edit (ADR-0026 §5)

| Requirement                                          | Status | Evidence                                                                   | Notes                                                            |
| ---------------------------------------------------- | ------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| it declares `file.write` / `file.delete` per path    | PASS   | test:it refuses a path that has become protected                           | The policy engine rules on the declared set before any read      |
| it invalidates the freshness receipts it invalidated | PASS   | test:it invalidates the freshness receipts for the paths it reverted       | ADR-0026 §7                                                      |
| it appears in the log as an ordinary `file.edited`   | PASS   | test:it appears in the event log as an ordinary file.edited, marked undoOf | And `undoOf` points at the entry it reversed                     |
| the model may not undo its own undo                  | PASS   | test:an undo of an undo, by the ordinary mechanism                         | The loop guard; the operator may, and the same test shows it     |
| `/undo` and `Undo` share one implementation          | PASS   | artifact:src/tools/builtin/undo.ts                                         | `ToolRuntime.executeControlCall`, so neither can widen the other |

---

## 7. What undo cannot reach, enumerated in the product (plan §12)

| Requirement                                         | Status | Evidence                                                              | Notes                                                   |
| --------------------------------------------------- | ------ | --------------------------------------------------------------------- | ------------------------------------------------------- |
| a foreign tool call is counted and named            | PASS   | test:a foreign tool call is counted, named, and declared out of reach | Real `McpService`, real stdio server, `1 to "wiki"`     |
| a shell mutation is counted and named               | PASS   | test:a shell command that mutated source is counted and named         | `MutationDetector` already knew; nothing kept the total |
| the journal's boundary is stated after a resume     | PASS   | test:the resumed undo states that the journal has a boundary          |                                                         |
| an **empty** uncovered set says so                  | PASS   | test:with nothing uncovered, it says that, rather than saying nothing | A count of zero from state is evidence; silence is not  |
| it is derived from the session, never a constant    | PASS   | artifact:src/edit/uncovered.ts                                        | Counters fed from the callbacks that already fire       |
| `/status` reports the inventory and the same limits | PASS   | test:/status reports the inventory and the same limits                | One renderer, so the three surfaces cannot drift        |
| `/undo list` reverses nothing                       | PASS   | test:/undo list reverses nothing and shows the inventory              |                                                         |

---

## 8. Measurement — does having undo change what a model does (plan §17)

**Behavioural. Two models, named above, side by side, never averaged.**

| Requirement                                         | Status | Evidence                               | Notes                                                                      |
| --------------------------------------------------- | ------ | -------------------------------------- | -------------------------------------------------------------------------- |
| a two-arm experiment exists, control asserts itself | PASS   | eval:evals/experiments/undo-utility.ts | `ToolRegistry.unregister`; each arm checks the frozen catalogue            |
| the harness works without a model                   | PASS   | eval:evals/experiments/undo-utility.ts | `--scripted`, both arms solve 3/3                                          |
| model 1, N=3 per cell                               | PASS   | artifact:docs/alpha10-undo-utility.md  | `deepseek-chat`: `Undo` called 0/9; solve 9/9 both arms                    |
| model 2, N=3 per cell                               | PASS   | artifact:docs/alpha10-undo-utility.md  | `gpt-5.6-terra` via relay: `Undo` called 0/9; solve 9/9 both arms          |
| the alpha.7 friction finding is checked             | PASS   | artifact:docs/alpha10-undo-utility.md  | Does **not** reproduce for this tool; the write-up reads it as noise       |
| the fixture's own failure is stated                 | PASS   | artifact:docs/alpha10-undo-utility.md  | Both models avoided the difficulty, so §17's failure mode was not provoked |

---

## 9. CLOSURE C — the clean-resolver non-claim, decided (plan §15)

| Requirement                                              | Status         | Evidence                                                           | Notes                                                                                                                     |
| -------------------------------------------------------- | -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **strict egress on a genuinely global resolved address** | NOT APPLICABLE | artifact:docs/adr/ADR-0017-web-reads-through-the-egress-gate.md    | Downgraded from `NOT TESTED` this milestone. Both hosts NAT public names into 198.18/15, re-verified 2026-08-16 [open:A7] |
| the reason travels with the claim, in the ADR            | PASS           | artifact:docs/adr/ADR-0017-web-reads-through-the-egress-gate.md    | A new section, not a footnote; a reader of the ADR is who is entitled to know                                             |
| the alpha.6 and alpha.9 matrices are amended             | PASS           | artifact:docs/alpha9-evidence-matrix.md                            | Both rows restated, both naming alpha.10 §15 as the decision                                                              |
| the negative controls still pass                         | PASS           | test:denies every non-global IPv4 range the rebinding attack needs | Four scopes refused, each naming the scope; that half was never in doubt                                                  |

---

## 10. CLOSURE A — a second operator (plan §13)

| Requirement                                    | Status     | Evidence                                 | Notes                                                                                            |
| ---------------------------------------------- | ---------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **someone who is not the author has run this** | NOT TESTED | artifact:docs/alpha10-second-operator.md | Scheduled, not run. Fifth consecutive milestone open. Not simulated, which §13 forbids [open:A1] |
| a protocol exists, committed before the run    | PASS       | artifact:docs/alpha10-second-operator.md | Including what the author must not do, and how to read an empty findings list                    |
| the run exercises undo, not just installation  | PASS       | artifact:docs/alpha10-second-operator.md | Step 5. alpha.8 already measured the artifact; the variable here is the operator                 |
| it is named as the oldest open item            | PASS       | artifact:docs/alpha10-status.md          | And alpha.9 §26's "stop adding capability after alpha.11" is recorded as a commitment            |

---

## 11. Gates at the tagged commit

| Gate                     | Status | Evidence                        | Notes                                                     |
| ------------------------ | ------ | ------------------------------- | --------------------------------------------------------- |
| offline suite            | PASS   | artifact:docs/alpha10-status.md | See §1 of the status document for the exact counts        |
| architecture lint        | PASS   | artifact:docs/alpha10-status.md | 16 rules, self-tests                                      |
| evidence gate            | PASS   | artifact:docs/alpha10-status.md | 8 matrices, this one registered in `scripts/evidence.ts`  |
| package check            | PASS   | artifact:docs/alpha10-status.md | Nothing forbidden, no dependency on `research/`           |
| release gate, every tier | PASS   | artifact:docs/alpha10-status.md | At the exact commit being tagged; re-gated before the tag |
