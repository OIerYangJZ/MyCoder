# alpha.12 evidence matrix — the acceptance suite

**Date:** 2026-08-17
**Milestone:** `v0.1.0-alpha.12` — the acceptance suite
**Rule:** no PASS without named, executable evidence. And, unchanged from alpha.11:
no check without a fixture that makes it fail.

> **Read this first.** The MAIN of this milestone is a _definition_, and defining a
> gate is not passing it. "54 of 62 clauses covered" is a count of one document
> against another and is **not** evidence about the software; the rows below that
> matter most are the five that say a clause is checked by nothing, two of which are
> release-blocking invariants.

---

## 0. What this milestone did and did not close

| Closure                              | Outcome                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **MAIN — the Full Acceptance Suite** | **closed**: 62 items derived from the specification, tiered, mapped, gated, and run             |
| CLOSURE A — the second operator      | **NOT TESTED.** Seventh consecutive milestone. Now T4 of the suite and a precondition of `rc.1` |
| CLOSURE B — the enumeration audit    | **closed**: 96 enumerations classified, 7 mirrors checked, 2 pre-existing drifts found          |
| CLOSURE C — the costlier refusal     | **closed**: the seam produces a late refusal, and the answer is still a negative result         |
| ADR-0027 §5                          | **taken**: this is the last tag cut while CLOSURE A is open                                     |

## 1. MAIN — the suite is derived from the specification, not from the tests

| Requirement                                                           | Status | Evidence                                                                                            | Notes                                                                                                 |
| --------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| every clause of §1.1, §1.2, §25 and §28 is an item, exactly once      | PASS   | test:NEGATIVE CONTROL: a suite that covers every clause once is accepted                            | Re-derived against the specification on every gate run where it is present                            |
| a clause in the specification and in no item fails the gate           | PASS   | test:a clause with no item is refused                                                               | The direction that matters: the suite cannot quietly forget a requirement                             |
| an item quoting a clause the specification lacks fails the gate       | PASS   | test:an item quoting a clause the specification does not contain is refused                         | An invented requirement, or a quote that drifted while being copied                                   |
| two items claiming one clause fail the gate                           | PASS   | test:two items quoting one clause is refused                                                        |                                                                                                       |
| the derivation is pinned to a specific state of the specification     | PASS   | test:a specification that has changed since the derivation is refused                               | sha256 in the suite's §1; an edited spec invalidates the derivation rather than orphaning it          |
| a missing hash is refused, so it cannot be pinned to nothing          | PASS   | test:a missing hash is refused, so the derivation cannot be pinned to nothing                       |                                                                                                       |
| the derivation happened before the mapping                            | PASS   | artifact:docs/acceptance-suite.md                                                                   | Two commits: the first has no `Status` and no `Evidence` column at all                                |
| every item declares a tier the ADR defines                            | PASS   | test:an item with no tier is refused test:an unknown tier is refused                                | ADR-0027 §2, and `acceptance-tiers` checks the code against the ADR                                   |
| the suite's counts match its own rows                                 | PASS   | test:its own counts match its own rows test:a covered count that disagrees with the rows is refused | The summary is load-bearing rather than decorative                                                    |
| a covered item names evidence that resolves                           | PASS   | test:an item naming a test that exists nowhere is refused                                           | Borrowed whole from the evidence gate; no second vocabulary                                           |
| an uncovered item is legal, and counted separately                    | PASS   | test:an uncovered item that does not say why is refused                                             | `NOT TESTED` with a reason is the honest answer the suite exists to make visible                      |
| the uncovered count is not zero on the first run                      | PASS   | test:the uncovered count is not zero, or the suite was written from the answers                     | alpha.12's Green First Run Stop, as a falsifiable assertion                                           |
| every uncovered item reaches `docs/open-evidence.md`                  | PASS   | test:an uncovered item missing from the index is refused                                            | And an index entry whose items are all covered fails too — both directions                            |
| clause coverage says so when it could not be checked                  | PASS   | test:an absent specification reports that it did not check, and does not pass                       | CI has no `research/`; a silent skip would be the strongest check becoming a silence                  |
| the suite is checked from inside the existing evidence gate           | PASS   | suite:evidence artifact:docs/alpha12-status.md                                                      | Not a second gate: §7.5, and one command to forget instead of two                                     |
| **spec §28 already existed and nothing had enumerated it**            | PASS   | artifact:docs/acceptance-suite.md                                                                   | 21 unticked checkboxes, normative since before alpha.1. §1 of the suite records the finding           |
| **the first version of that finding was wrong, and says so**          | PASS   | artifact:docs/alpha12-predictions.md                                                                | `agent-loop.test.ts` names §28 and covers five criteria; the corrected claim is "enumerated"          |
| the "MUST 18 of 18" count in five plans was wrong                     | PASS   | artifact:docs/acceptance-suite.md                                                                   | §1.1 has 17 bullets. It never entered this repository, so no gate here could have caught it           |
| T2 has no items, and the `rc.1` gate says so instead of inventing any | PASS   | artifact:docs/adr/ADR-0027-acceptance-tiers-and-the-rc1-gate.md                                     | Spec §1.3 lists a cross-platform strong sandbox under NON-GOALS; three milestones sit above the suite |

## 2. The five clauses nothing checks

The milestone's most valuable output. Each is `NOT TESTED` here because it is
uncovered in the suite, and each names its entry in the index.

| Requirement                                                        | Status     | Evidence                                                        | Notes                                                                                                                              |
| ------------------------------------------------------------------ | ---------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **M09** hook network egress goes through the unified egress policy | NOT TESTED |                                                                 | Three of four routes are established; the hook route is claimed in a source comment and exercised by nothing [open:D1]             |
| **M17** `FakeExecutor` and `FakeFileSystem` exist                  | NOT TESTED |                                                                 | Neither appears in `src/` or `tests/`; the guarantee holds via a temp directory and the local backend. Erratum candidate [open:D2] |
| **V02** `StepContext` is immutable during a model request          | NOT TESTED |                                                                 | Release-blocking invariant 2. The identifier appears in no test in the repository [open:D3]                                        |
| **V09** large tool output has a budget and an artifact reference   | NOT TESTED |                                                                 | Release-blocking invariant 9. `artifactRef` exists in `src/tools/runtime.ts` and is named by no test [open:D4]                     |
| **A15** stdout/stderr truncation is uniform across backends        | NOT TESTED |                                                                 | Redaction is established; the only truncation assertion is the SSH one, and the conformance suite has no case [open:D5]            |
| the five are counted and named rather than rounded away            | PASS       | artifact:docs/open-evidence.md                                  | §D is a new section: not blocked on a person or a machine, just not done                                                           |
| none of the five was closed in this milestone                      | PASS       | artifact:docs/adr/ADR-0027-acceptance-tiers-and-the-rc1-gate.md | Closing them is capability work, and the commitment forbids it until CLOSURE A closes                                              |

## 3. CLOSURE A — carried, and still open

| Requirement                                                    | Status     | Evidence                                                        | Notes                                                                                                         |
| -------------------------------------------------------------- | ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **someone who is not the author has run this**                 | NOT TESTED | artifact:docs/alpha10-second-operator.md                        | Seventh consecutive milestone. No operator was available. Not simulated, which the protocol forbids [open:A1] |
| the ask is now one page a stranger can be sent                 | PASS       | artifact:docs/second-operator-invitation.md                     | No hints, no suggested task, nothing about what the product does — it refuses to answer "what is this?"       |
| the operator can record the run without the author in the room | PASS       | artifact:docs/second-operator-recording-sheet.md                | Three tables, and it says an empty sheet is not a good outcome                                                |
| the protocol was not softened to make it schedulable           | PASS       | artifact:docs/alpha10-second-operator.md                        | Unchanged. What got cheaper is the asking; the run costs exactly what it did                                  |
| A1 is a tier of the acceptance suite rather than only a row    | PASS       | artifact:docs/acceptance-suite.md                               | T4: `R01`, `R02`, `R03`, and ADR-0027 §3 makes T4 a precondition of `rc.1`                                    |
| **`v0.1.0-alpha.12` is the last tag while CLOSURE A is open**  | PASS       | artifact:docs/adr/ADR-0027-acceptance-tiers-and-the-rc1-gate.md | The user's decision, recorded as taken rather than left implicit (§5)                                         |
| A1 was not downgraded to `NOT APPLICABLE`                      | PASS       | artifact:docs/open-evidence.md                                  | The move that closed A7 honestly would be dishonest here: this one is possible, and it is an hour             |

## 4. CLOSURE B — the enumeration audit

| Requirement                                                               | Status | Evidence                                                                                                                                  | Notes                                                                                            |
| ------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| every enumeration in `src/` and `scripts/` has a verdict                  | PASS   | test:NEGATIVE CONTROL: the shipped audit classifies every enumeration exactly once                                                        | 96 of them: 22 guarded, 13 declared unguarded, 61 closed by design                               |
| an enumeration with no row fails the build                                | PASS   | test:an enumeration with no row is refused — the alpha.6 defect, one level up                                                             | The `MATRICES` failure, generalised                                                              |
| a row naming an enumeration that no longer exists fails the build         | PASS   | test:a row naming an enumeration that no longer exists is refused                                                                         | What a rename leaves behind: a claim that something is covered                                   |
| the audit's own totals are checked against its rows                       | PASS   | test:totals that disagree with the rows are refused                                                                                       | A number in a document is a mirror too                                                           |
| **`docs/configuration-audit.md` had already drifted**                     | PASS   | test:a key in the code and not in the document is refused                                                                                 | Five keys missing: four `[mcp…]` weakening keys and one ceiling-pinned key, all added in alpha.9 |
| **`docs/cli-contract.md` was read by nothing**                            | PASS   | test:NEGATIVE CONTROL: the shipped document and args.ts agree                                                                             | ADR-0021's own document; the existing test asserted `args.ts` against `args.ts`                  |
| flags, backends and subcommands are compared in both directions           | PASS   | test:a flag added to the code and not to the document is refused test:a flag promised by the document and absent from the code is refused | Different bugs, different messages                                                               |
| a flag promoted from experimental to contract is refused until documented | PASS   | test:a flag moved from experimental to contract is refused until the document moves too                                                   | The change ADR-0021 most needs noticed                                                           |
| exit-code numbers are compared, not just names                            | PASS   | test:a renumbered exit code is refused even though both sides have the name                                                               | A set comparison alone passes while every `case 4)` in every wrapper becomes wrong               |
| `REQUIRED` is reachable from `package.json` `files`                       | PASS   | test:a required file outside the packaged set is refused                                                                                  | Reachability, not equality; `files` names directories                                            |
| `TIERS` matches ADR-0027 §2                                               | PASS   | test:a tier the code invented is refused                                                                                                  | The ADR decides the tiers                                                                        |
| `USER_HOOK_EVENTS` matches spec §18.1, and says so when it cannot check   | PASS   | test:an event the specification does not list for v0.1 is refused test:an absent specification reports NOT CHECKED rather than passing    | The 后续 list is deliberately not read                                                           |
| README's core tool list names tools that exist, and counts them           | PASS   | test:a tool README calls core that does not exist is refused test:a count that disagrees with the list README prints is refused           |                                                                                                  |
| the one-directional gap in that check is recorded, not hidden             | PASS   | test:DELIBERATE GAP: a builtin missing from README is accepted                                                                            | Closing it needs a second hardcoded list of conditional builtins — another mirror                |
| the eleven tool schemas are declared unguarded with a reason              | PASS   | artifact:docs/alpha12-enumeration-audit.md                                                                                                | Guarding them needs runtime type information; ADR-0009 forbids the dependency                    |
| the detector's blind spots are named                                      | PASS   | artifact:docs/alpha12-enumeration-audit.md                                                                                                | §5: syntactic detection, `tests/` and `evals/` not walked, classification done by reading        |
| every mirror id has a check and a row, both ways                          | PASS   | test:every mirror id has a check and a row in the audit, both ways                                                                        | `MIRRORS` is itself a list mirroring a document                                                  |

## 5. CLOSURE C — a refusal that costs more

| Requirement                                                               | Status | Evidence                                                                                                                             | Notes                                                                                                    |
| ------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| the refusal arrives after edits have already landed                       | PASS   | test:the trap holds off until the declared number of edits has landed                                                                | Two of three renames applied, then the third file moves underneath the model                             |
| the task asserts that it arrived late, not merely that it arrived         | PASS   | test:the task asserts that the refusal arrived late, not merely that it arrived                                                      | Without it, a first-edit refusal would satisfy the check and answer alpha.11's question again            |
| NEGATIVE CONTROL: a threshold above the available work never fires        | PASS   | test:NEGATIVE CONTROL: a threshold higher than the work available never fires                                                        | Otherwise every attempt would satisfy "arrived late" by accident                                         |
| **the first version was defeated by ordering, and the live run found it** | PASS   | artifact:evals/results/experiments/undo-utility-deepseek-chat-3x-2026-08-17T09-48-19-530Z.json                                       | v1 armed on the read alone: a model that read all three files first met no difficulty in 3 of 6 attempts |
| a batched-read trajectory is caught by the second trigger                 | PASS   | test:a model that reads everything before editing anything is still caught                                                           | The fix, as a regression. `fixtureVersion` went to 2 so v1's numbers are not compared with v2's          |
| the alpha.11 tasks are unchanged by the addition                          | PASS   | test:the default is alpha.11 behaviour, so its three tasks are unchanged                                                             | `armAfterMutations` defaults to 0, so their numbers stay comparable across milestones                    |
| both arms can still finish, and neither needs `Undo`                      | PASS   | test:both arms can still finish it, and neither needs Undo to                                                                        | Read and Edit only; a task no model can complete measures the task                                       |
| the seam registers no new tool and does not ship                          | PASS   | test:it decorates existing tools rather than registering a new one test:the evals directory is not in the published package          | The Capability Creep Stop: alpha.12 adds no tool                                                         |
| **`Undo` was called 0/24 where it existed**                               | PASS   | artifact:docs/alpha12-undo-utility.md artifact:evals/results/experiments/undo-utility-deepseek-chat-3x-2026-08-17T09-54-22-074Z.json | 48 live attempts, 24 with the tool. **0/6 in the task with a half-applied set on disk**                  |
| the same, on the second model                                             | PASS   | artifact:evals/results/experiments/undo-utility-gpt-5.6-terra-3x-2026-08-17T10-12-33-460Z.json                                       | `gpt-5.6-terra` through the relay: 12/12 solved per arm, `Undo` 0/12, six stale refusals per arm         |
| the difficulty occurred in every counted attempt                          | PASS   | artifact:docs/alpha12-undo-utility.md                                                                                                | Attempts whose premise failed are reported as failures rather than counted as evidence                   |

## 6. The tiers, as actually run

| Requirement                                               | Status     | Evidence                                        | Notes                                                                                                                    |
| --------------------------------------------------------- | ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **T0** the offline suite, on this machine                 | PASS       | artifact:docs/alpha12-status.md                 | 1322 tests · 1229 pass · 0 fail · 93 skip                                                                                |
| **T1** the SSH tier, against a real `sshd`                | PASS       | suite:test:ssh                                  | 73 tests, loopback OpenSSH. The authoritative separate-host run is alpha.3's, and the matrices distinguish them          |
| **T1** the container tier                                 | PASS       | ci:Container Enforcement (native Linux Docker)  | Run by the release gate with `KERNEL_CONTAINER_REQUIRED=1`, on a native Linux kernel rather than Docker Desktop          |
| **T2** native Linux Landlock + seccomp                    | PASS       | ci:Native Linux Sandbox (Landlock + seccomp)    | Zero suite items sit here by construction; the tier's content is alpha.7's matrix and this job [scope]                   |
| **T3** a live provider                                    | PASS       | artifact:docs/alpha12-undo-utility.md           | `deepseek-chat` and `gpt-5.6-terra`, 24 live attempts each                                                               |
| **T4** a person who did not write this                    | NOT TESTED | artifact:docs/second-operator-invitation.md     | The tier that gates `rc.1`, and the one no amount of CI can produce [open:A1]                                            |
| the release gate is green end to end at the tagged commit | PASS       | ci:Release Gate artifact:docs/alpha12-status.md | dispatch 32019683827 and tag-push 32019900190, both at `16587267216b7e85532246ebe18cb688c2535e7c`, green on all six jobs |
| the remainder is named rather than rounded away           | PASS       | artifact:docs/acceptance-suite.md               | §9 lists the eight uncovered items and what would close each                                                             |

## 7. Found after the tag, and fixed on the branch

`v0.1.0-alpha.12` is tagged and **not moved**. These three landed afterwards, while
assembling a bundle for a second operator, and are gated by their own dispatch run —
recorded in `docs/alpha12-status.md` §8. They are documentation and one message
string: no capability, no new tool, nothing ADR-0027 §5 forbids.

| Requirement                                                                  | Status | Evidence                                                                | Notes                                                                                                                        |
| ---------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| a packaged document may not instruct a command a packaged install lacks      | PASS   | test:a fenced block telling the reader to run pnpm is refused           | `docs/configuring-a-provider.md` told the reader to run `pnpm --dir /Users/<author>/…`; their command is `mycoder`           |
| NEGATIVE CONTROL: a checkout-marked block, and prose about a maintainer step | PASS   | test:NEGATIVE CONTROL: a block marked as checkout-only is permitted     | The escape hatch is deliberate; a rule with no way to say "checkout only" is one somebody deletes                            |
| no packaged file names an absolute home path                                 | PASS   | test:an absolute home path is refused, in any packaged file             | There is no legitimate one, so this rule has no exception                                                                    |
| a decision record describing a `pnpm` script is not flagged                  | PASS   | test:an ADR describing a pnpm script is not flagged                     | ADRs document a repository; only what a reader is told to _type_ can strand them                                             |
| the shipped package instructs nothing unrunnable                             | PASS   | test:the shipped package tells nobody to run something they do not have | Run against the real `npm pack` list, and wired into `pnpm package:check`                                                    |
| every path `doctor` prints can be opened by the reader                       | PASS   | test:every path it prints is one the reader can actually open           | The footer pointed at a relative `docs/…` path that resolves only in a checkout; it now resolves from the installed location |

## Model provenance

**Two live-model behavioural claims**, both in §5, and both measured on
`deepseek-chat` (DeepSeek, `openai-chat` protocol) and `gpt-5.6-terra` (through the
relay, `openai-chat` protocol), N=3 per cell across four tasks and two arms —
24 attempts per model. The numbers, the failed-premise attempts and the per-arm
differences are in `docs/alpha12-undo-utility.md`, and the raw artifacts are cited
in the rows above.

Every other row is a property of the specification, the documents, the test tree or
the release machinery, established by reading and by running the suites named, with
no model involved.
