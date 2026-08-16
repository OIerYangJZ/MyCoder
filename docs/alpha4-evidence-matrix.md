# `v0.1.0-alpha.4` — Release Evidence Matrix

**Rule (alpha.3 §32.1, restated in alpha.4 §42):** a checklist item without named
evidence is not PASS.

`node scripts/evidence.ts` parses this table — and alpha.3's, which is still
checked on every run — and fails the build on any `PASS` with an empty evidence
cell, any evidence reference with no recognised `kind:` prefix, any
`test:`/`suite:` naming something that appears nowhere under `tests/`, and any
`artifact:` pointing at a file that is missing or untracked. It does **not** run
the tests; CI does that. It checks that the claims point at something real.

Status vocabulary is exactly four values:

| Status           | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| `PASS`           | A named, executable piece of evidence asserts it.             |
| `FAIL`           | Known broken. The evidence cell names what shows the failure. |
| `NOT TESTED`     | Not asserted here. The notes column says why, and what would. |
| `NOT APPLICABLE` | Out of scope for this milestone.                              |

Evidence prefixes: `test:` `suite:` `ci:` `eval:` `artifact:` `live:` `manual:`.

> **What "live" means in this matrix.** The delegation eval ran against
> **DeepSeek** over `openai-chat`, N=5, 15/15 solved, 0 secret-boundary
> violations, and the artifact is committed. The SSH composition ran against a
> **separate aarch64 Linux VM over the network** (96 pass, 0 fail) and again
> against a loopback `sshd` (71 pass, 0 fail). What is still **not** claimed:
> OS-level isolation of a child — a subagent is a policy scope in the same
> process, not a sandbox — and any second provider.

## Model provenance

**Every behavioural number here was measured on `deepseek-chat` (DeepSeek,
`openai-chat`), N=5.** The delegation-utility result in particular — _0 of 25
delegations chosen_, and 0 of 70 after the system-prompt lever — is a
**single-model** finding.

That one matters more than most, because "the model never delegates" reads like a
property of the kernel and may be a property of one model. alpha.8 §20 re-ran the
experiment against a second model for exactly this reason; the side-by-side result
is in `docs/alpha8-evidence-matrix.md` and is reported next to this number, never
averaged with it.

Live tiers: local backend on macOS arm64, plus the `linux-vm` host for the SSH
rows.

---

## 0. Preflight: alpha.3 provenance (§0)

| Requirement                            | Status | Evidence                                                                                          | Notes                                          |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `882cd4f` is an ancestor of `main`     | PASS   | manual:ran `git merge-base --is-ancestor 882cd4f origin/main` after merging PR #1 and it exited 0 | PR #1 merged with a merge commit, not squashed |
| `v0.1.0-alpha.3` tag remains immutable | PASS   | manual:the tag still points at 882cd4f; nothing in this milestone moved or re-created it          |                                                |
| alpha.4 starts from verified `main`    | PASS   | manual:rebased the alpha.4 branch onto origin/main and confirmed main is an ancestor of HEAD      |                                                |
| `main` CI green after the merge        | PASS   | ci:CI run on the alpha.3 merge commit                                                             | Recorded in `docs/alpha4-status.md` §1         |

---

## 1. Subagent runtime (§43, §46 "Subagent Runtime")

| Requirement                                  | Status | Evidence                                                                            | Notes                                                        |
| -------------------------------------------- | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| real parent → child → parent dispatch exists | PASS   | test:the child samples the model and executes tools through the kernel              | Drives a real `Session`, not `deriveSubagent()`              |
| subagent actually invokes `ModelRuntime`     | PASS   | test:the child samples the model and executes tools through the kernel              | Asserts the child's own captured model requests              |
| subagent actually invokes `ToolRuntime`      | PASS   | test:the child samples the model and executes tools through the kernel              | Asserts a `tool.call` event tagged with the delegation id    |
| the child uses the existing kernel loop      | PASS   | test:a completed delegation replays identically, child work included                | Child turns appear as ordinary turn events                   |
| structured `DelegationResult` returns        | PASS   | test:a failing child becomes a structured result the parent can reason about        |                                                              |
| parent/child provenance recorded             | PASS   | test:provenance joins the child to the tool call that asked for it                  | requested/started/completed carry the same id and tool call  |
| child model resolution goes through policy   | PASS   | test:a project with agents gets it, and the schema names them                       | Alias must already be registered; `deriveSubagent` clamps    |
| delegation depth bounded                     | PASS   | test:a child cannot delegate again: depth is refused with a structured result       | `DELEGATION_DEPTH_EXCEEDED`, and the attempt is recorded     |
| child step/tool/request budgets bounded      | PASS   | test:the child's budget is bounded by what the parent has left, and is charged back |                                                              |
| parent cancellation propagates               | PASS   | test:cancelling the parent stops the child; nothing continues in the background     |                                                              |
| child failure contained                      | PASS   | test:a failing child becomes a structured result the parent can reason about        | Parent turn still completes                                  |
| child output origin is not `user`            | PASS   | test:the child's report reaches the parent as a tool result, never as the user      | Both directions: task in, report out                         |
| repeated failed delegation is bounded        | PASS   | test:repeating the same failed delegation is bounded                                | §32 doom-loop guard                                          |
| unknown agent refused, not invented          | PASS   | test:an unknown agent is denied, and the denial names what exists                   |                                                              |
| no `Delegate` tool without agents            | PASS   | test:a project with no agents gets no Delegate tool                                 | alpha.3 catalogues are unchanged for projects with no agents |
| `agent.invoke` is a real capability          | PASS   | test:delegation is refused by a project rule that names the agent                   | A project rule can deny one agent by name                    |

---

## 2. Delegated security (§37, §38, §46 "Security")

| Requirement                                       | Status | Evidence                                                                           | Notes                                                      |
| ------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| parent ceiling enforced in the real child runtime | PASS   | test:a read-only parent produces a read-only child, whatever the definition asks   | The file is unchanged afterwards                           |
| an agent definition cannot elevate                | PASS   | test:the agent definition could not widen the child                                | Definitions ask for workspace-dev and 999 steps            |
| child tools cannot widen                          | PASS   | test:the child catalogue is an intersection, and a tool outside it is not callable |                                                            |
| parent read-only → child write refused            | PASS   | test:parent read-only, child requests write                                        | Refused by the policy layer, not by a withheld tool        |
| child cannot read a protected secret              | PASS   | test:child reads the protected secret file                                         |                                                            |
| child cannot read the provider credential         | PASS   | test:child reads the provider credential file                                      | A real 0600 credential file outside the workspace          |
| child network cannot widen                        | PASS   | test:child asks for the network                                                    | A skill declaring `network: true` gets nothing             |
| child cannot dump the environment                 | PASS   | test:child asks for the raw environment                                            |                                                            |
| child cannot manufacture budget                   | PASS   | test:child asks for a huge budget                                                  | 9999 requested, child ceiling applied                      |
| child cannot delegate onward                      | PASS   | test:child delegates again                                                         |                                                            |
| parent-only context does not leak                 | PASS   | test:parent-only context never reaches a child prompt                              | Non-secret marker: isolation, separate from redaction      |
| the child never receives the parent conversation  | PASS   | test:a child never receives the parent conversation                                |                                                            |
| a child hook cannot elevate or exfiltrate         | PASS   | test:a hook running inside a child cannot exfiltrate either                        | Same definitions, child's engine (`HookRunner.withPolicy`) |
| delegated canary leakage = 0                      | PASS   | test:the delegated canary appears in no unauthorised sink                          | Random per run; seven sinks including the child's prompt   |
| the harness is not vacuous                        | PASS   | test:NEGATIVE CONTROL: the harness really ran children and captured their prompts  | Proves the capture could detect the marker                 |
| no child modified the workspace                   | PASS   | test:the workspace was not modified by any child                                   |                                                            |

---

## 3. Skill runtime (§21–§26, §46 "Skills")

| Requirement                               | Status | Evidence                                                                       | Notes                                                    |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| a skill activates in the real runtime     | PASS   | test:control-plane activation puts labelled instructions in the next request   | `/skills use`                                            |
| the model receives the skill instructions | PASS   | test:control-plane activation puts labelled instructions in the next request   | Asserted against the captured model request              |
| skill origin is injection, not user       | PASS   | test:control-plane activation puts labelled instructions in the next request   | Rendered as `Instructions from skill:<name>`             |
| model-requested activation is bounded     | PASS   | test:the model can activate a skill itself, and it applies from the next step  | Applies at the next step freeze (invariant 2)            |
| a skill narrows tools                     | PASS   | test:the model can activate a skill itself, and it applies from the next step  | `Edit` is present before and absent after                |
| a skill narrows permissions               | PASS   | test:a greedy skill gets none of what it asked for                             | Named `workspace-dev` under a read-only session          |
| a skill cannot increase budget            | PASS   | test:a greedy skill gets none of what it asked for                             | `max_steps: 999` clamped                                 |
| a malicious skill stays policy-contained  | PASS   | test:child asks for the network                                                | `network: true` + `dangerously_skip_permissions` ignored |
| a turn-scoped skill expires               | PASS   | test:a turn-scoped skill stops applying when the turn ends                     | Catalogue restored; `skill.deactivated` recorded         |
| an unknown skill changes nothing          | PASS   | test:an unknown skill changes nothing                                          |                                                          |
| skill state is replayable                 | PASS   | test:the model can activate a skill itself, and it applies from the next step  | `skill.activated` carries scope, source and notes        |
| skill + subagent composition works        | PASS   | test:an agent definition activates a skill inside the real child runtime       | Briefing → agent → skill → child catalogue               |
| a skill an agent names but is absent      | PASS   | test:a skill named by an agent that the session has not discovered is reported | Reported, not silently ignored                           |

---

## 4. Replay, compaction, resume (§28–§30, §46)

| Requirement                                     | Status | Evidence                                                                                 | Notes                                             |
| ----------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| delegation live == replay                       | PASS   | test:a completed delegation replays identically, child work included                     | Root totals include the child's                   |
| a delegated edit appears on both sides          | PASS   | test:a child edit lands in the root dirty list and in the delegation record              |                                                   |
| failed and denied delegations replay            | PASS   | test:a failed and a denied delegation both replay, and neither is orphaned               |                                                   |
| a cancelled delegation replays as cancelled     | PASS   | test:a cancelled delegation replays as cancelled                                         |                                                   |
| no orphan child tool call                       | PASS   | suite:test:replay                                                                        | `unansweredToolCalls` asserted in every gate case |
| no orphan delegation                            | PASS   | test:iteration(s) preserve every invariant                                               | started == finished, over the whole soak          |
| compaction preserves the active delegation      | PASS   | test:a compaction boundary keeps the delegation, its outcome and its files               | Anchor names the agent, its status and its files  |
| a child compaction is attributed to the child   | PASS   | test:a compaction inside a child is attributed to the child, not the root                |                                                   |
| interrupted delegation resumes safely           | PASS   | test:the delegating call is answered, the child is not restarted, and the risk is stated |                                                   |
| an uncertain child side effect is not repeated  | PASS   | test:the delegating call is answered, the child is not restarted, and the risk is stated | The synthetic result says so in those words       |
| a resumed session still satisfies the gate      | PASS   | test:iteration(s) preserve every invariant                                               | Checked before _and_ after the restart            |
| compaction does not erase a tool call from live | PASS   | test:a tool call that compaction summarised away is still in the live state              | **Defect found by this milestone**; see status §2 |
| automatic mid-turn compaction does not fail     | PASS   | test:automatic mid-turn compaction does not fail the turn                                | **Defect found by this milestone**; see status §2 |

---

## 5. Long-session soak (§31)

| Requirement                       | Status | Evidence                                   | Notes                                                       |
| --------------------------------- | ------ | ------------------------------------------ | ----------------------------------------------------------- |
| 20+ parent steps                  | PASS   | test:iteration(s) preserve every invariant | 23 per iteration, asserted rather than assumed              |
| 3+ delegations                    | PASS   | test:iteration(s) preserve every invariant | 4 per iteration                                             |
| 2+ skill activations              | PASS   | test:iteration(s) preserve every invariant | 2 per iteration                                             |
| 2+ compaction boundaries          | PASS   | test:iteration(s) preserve every invariant | 5 per iteration                                             |
| 1+ restart / resume               | PASS   | test:iteration(s) preserve every invariant | Same store, new kernel, `resumeSessionId`                   |
| 1+ child failure                  | PASS   | test:iteration(s) preserve every invariant |                                                             |
| 1+ denied child action            | PASS   | test:iteration(s) preserve every invariant | A policy denial, not a missing tool                         |
| 1+ successful edit / verify cycle | PASS   | test:iteration(s) preserve every invariant |                                                             |
| repeated stress N = 50            | PASS   | ci:Delegated Soak x50                      | 3.7s for fifty; `KERNEL_SOAK_REPEATS`                       |
| no state leak between iterations  | PASS   | test:iteration(s) preserve every invariant | Identical shape across iterations                           |
| live == replay every iteration    | PASS   | test:iteration(s) preserve every invariant |                                                             |
| budget accounting exact           | PASS   | test:iteration(s) preserve every invariant | Session counters compared against the log                   |
| capability never widens           | PASS   | test:iteration(s) preserve every invariant | The parent catalogue is checked on every step under a skill |
| canary leakage = 0                | PASS   | test:iteration(s) preserve every invariant | Fresh canary per iteration                                  |

---

## 6. Live delegation (§33–§36, §46 "Live")

| Requirement                                  | Status         | Evidence                                                                            | Notes                                                         |
| -------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Real Provider #1 drives a real delegation    | PASS           | artifact:evals/results/release/alpha4-deepseek-live-delegation-n5.json              | DeepSeek, N=5; child made 2–4 model requests per delegation   |
| explicit delegation conformance passes       | PASS           | artifact:evals/results/release/alpha4-deepseek-live-delegation-n5.json              | 5/5 solved, 5/5 kernel correct                                |
| natural delegation eval executed             | PASS           | artifact:evals/results/release/alpha4-deepseek-live-delegation-n5.json              | 10/10 solved — and 0/10 delegations chosen; see status §4     |
| the two suites are scored apart              | PASS           | test:NEGATIVE CONTROL: delegation evidence with no failure classifies as nothing    | `summariseDelegation` reports per-suite, never summed         |
| failure classification generated             | PASS           | test:a refused delegation is bad judgement by the model                             | Live run produced no failures; the classes are unit-tested    |
| parent + child cost reported                 | PASS           | artifact:evals/results/release/alpha4-deepseek-live-delegation-n5.json              | $0.0171 direct / $0.0036 delegated; estimated, see status §4  |
| delegation metrics recorded                  | PASS           | artifact:evals/results/release/alpha4-deepseek-live-delegation-n5.json              | §36: per-task, child success rate, latency, denials           |
| the live provider suite still passes         | PASS           | suite:test:live:model                                                               | 9/9 against DeepSeek; recorded in status §1                   |
| SSH + subagent composition, real remote      | PASS           | test:the child reads and greps the remote workspace, and the parent gets its report | Separate aarch64 Linux VM over the network                    |
| a read-only child cannot write to the remote | PASS           | test:a read-only child cannot write to the remote workspace either                  |                                                               |
| second provider validated live               | NOT APPLICABLE |                                                                                     | §5 NON-GOAL. Provider breadth is an alpha.5 candidate [scope] |
| Anthropic validated live                     | NOT APPLICABLE |                                                                                     | §5 NON-GOAL; no credential configured [scope]                 |

---

## 7. Permission UX and `/status` (§40, §41)

| Requirement                                   | Status | Evidence                                                                     | Notes                                                  |
| --------------------------------------------- | ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| an approval names the child that asked        | PASS   | test:a delegated approval names the agent, not the root session              | `renderApproval` prints agent, delegation id and depth |
| `/status` exposes the active delegation       | PASS   | test:/status names the active delegation and the cost split                  | Agent, id, depth, model, activity, budget left         |
| `/status` exposes active skills               | PASS   | test:/status names the active delegation and the cost split                  |                                                        |
| `/status` never exposes prompts or secrets    | PASS   | test:/status names the active delegation and the cost split                  | Asserts the task text is absent from the output        |
| `/agents` reports delegation history          | PASS   | test:/agents reports what ran and what it cost                               |                                                        |
| `/skills use` activates and reports narrowing | PASS   | test:control-plane activation puts labelled instructions in the next request |                                                        |

---

## 8. Regression (§46 "Regression")

| Requirement                      | Status | Evidence                     | Notes                                                |
| -------------------------------- | ------ | ---------------------------- | ---------------------------------------------------- |
| all alpha.3 tests pass           | PASS   | ci:Unit + Integration / Node | 627 tests, 556 pass, 0 fail, 71 skipped (SSH opt-in) |
| replay gate passes               | PASS   | suite:test:replay            |                                                      |
| determinism ×100 passes          | PASS   | ci:Deterministic Kernel x100 |                                                      |
| existing live model suite passes | PASS   | suite:test:live:model        | Against DeepSeek                                     |
| real SSH re-smoked               | PASS   | suite:test:ssh               | 96 pass on the real VM, 71 on loopback               |
| Node 22 green                    | PASS   | ci:Unit + Integration / Node |                                                      |
| Node 24 green                    | PASS   | ci:Unit + Integration / Node |                                                      |
| Linux green                      | PASS   | ci:Platform / ubuntu-latest  |                                                      |
| macOS green                      | PASS   | ci:Platform / macos-latest   |                                                      |
| Windows smoke green              | PASS   | ci:Smoke / windows-latest    | Full suite is still POSIX-only, as in alpha.3        |
| architecture lint green          | PASS   | ci:Static Checks             | 9 rules, 0 violations                                |
| lint self-tests green            | PASS   | ci:Linter Self-Tests         | 90 pass                                              |
| evidence gate green              | PASS   | ci:Release Evidence Gate     | Both matrices                                        |
| scripted golden tasks green      | PASS   | ci:Golden Tasks              | 16/16, 0 secret-boundary violations                  |
| security invariants green        | PASS   | ci:Security Invariants       | 116 pass                                             |
| zero runtime dependencies        | PASS   | ci:Static Checks             | ADR-0009 still holds                                 |

---

## 9. What alpha.4 does not claim

| Claim                                    | Status         | Evidence | Notes                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| parallel subagents                       | NOT APPLICABLE |          | §5 NON-GOAL. Delegation is sequential; the parent's step blocks [scope]                                                                                                                                                                                                                              |
| agent teams / swarm                      | NOT APPLICABLE |          | §5 NON-GOAL [scope]                                                                                                                                                                                                                                                                                  |
| unbounded recursive delegation           | NOT APPLICABLE |          | §12: depth 1 by default, and depth > 1 is not validated [scope]                                                                                                                                                                                                                                      |
| background independent agents            | NOT APPLICABLE |          | §19: a child cannot outlive its parent's turn [scope]                                                                                                                                                                                                                                                |
| OS-level isolation of a child            | NOT TESTED     |          | A child is a policy scope in the same process. `describeSandbox` says so; container isolation is the alpha.5 candidate. **Closed by alpha.5** — see its §169 row "Subagent + Container green", which says so explicitly. Kept at its alpha.4 status because alpha.4 did not establish it [closed:C1] |
| automatic semantic skill routing         | NOT APPLICABLE |          | §22 NON-GOAL. Activation is explicit: control, definition or a bounded model request [scope]                                                                                                                                                                                                         |
| remote `agentd`                          | NOT APPLICABLE |          | §5 NON-GOAL [scope]                                                                                                                                                                                                                                                                                  |
| delegated cost is a billed amount        | NOT TESTED     |          | Cost is _estimated_ from configured list prices; the pricing page does not list the `deepseek-chat` alias, so the tier cannot be verified. See status §4 [open:A5]                                                                                                                                   |
| grandchild budget attribution at depth>1 | NOT APPLICABLE |          | Closed by making it unreachable: `SYSTEM_CEILING.maxDelegationDepth = 1` clamps every layer, so no configuration reaches the state whose accounting was approximate. test:a config asking for depth 3 is clamped to 1 [scope]                                                                        |
