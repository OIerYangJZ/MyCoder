# The v0.1 acceptance suite

**Date:** 2026-08-17 · **Defined in:** `v0.1.0-alpha.12` · **Authority:** ADR-0027

This is the definition of what this software must do to be called `v0.1`. It is
derived from the normative specification, clause by clause; every item carries the
clause it came from, the tier that can check it, and the evidence that does.

> **The derivation happened before the mapping, and the history is the proof.**
> The commit that created this file had no `Status` and no `Evidence` column at
> all — 62 items, each a quoted clause and a tier, and nothing pointing at a test.
> The columns arrived afterwards. A suite derived from the test tree is a
> description of the test tree, green on the day it is written and
> indistinguishable, once finished, from a suite that means something.

**Result of the first run: 54 of 62 items covered, 8 not.** The uncovered eight are
§9, and they are the most valuable part of this document.

---

## 1. Where the clauses come from

`docs/kernel-v0.1-spec.md` is a pointer; the normative document is
`../research/kernel_v0.1_technical_spec.md`, which is in no version control and
will be deleted when development finishes. So the clauses are **quoted here**, in
the original, and the derivation is pinned to a specific state of that file:

```text
spec sha256   aa583717cbf70719cfb005a278f3dd57998e3e9554fac1f19a1ab288a64e462a
spec lines    2330
derived from  §1.1 MUST (17) · §1.2 SHOULD (6) · §25 invariants (15) · §28 acceptance (21)
clauses       59
items         62  — the 59 clauses, plus three T4 items no specification contains (§7)
```

`scripts/acceptance.ts` compares that hash against the specification **when the
file is present**, and re-derives the clause list from it: an edited spec fails the
check rather than silently orphaning the suite. On a machine where `research/` is
absent — CI, or any consumer of the package — the hash cannot be checked, and the
gate prints that it could not rather than passing quietly.

Two of these four sources were not in the milestone plan's list, and finding them
is the first result of deriving from the specification instead of from what was
already known:

**§25** — fifteen release-blocking security invariants. Cited by number throughout
`src/` ("invariant 5", "invariant 13") and by `scripts/lint.ts`, and never
enumerated against evidence in one place until now.

**§28** — "v0.1 Acceptance Criteria", 21 unticked checkboxes prefixed
`只有全部满足才标记 v0.1.0`. **This is the acceptance suite the plan said did not
exist**, and it has been in the normative document since before alpha.1.

### A correction, made in the same milestone that got it wrong

The first version of this section, and ADR-0027's context section with it, said
that **nothing** in this repository pointed at §28 but one passing source comment.
That was wrong, and the mapping in §3–§6 is what found it.

`tests/integration/agent-loop.test.ts` is organised around §28: its header says
"the acceptance criteria in §28", two of its `describe` blocks are named for it,
and it covers five of the 21 criteria (A01, A04, A05, A06, A07) deliberately and
by name. The claim that survives is narrower and more useful:

```text
5 of 21   covered by a test that names §28
16 of 21  covered by tests that never mention it, or not at all
0         enumerated in any evidence matrix, release checklist or CI job
```

The wrong version was written from a `grep` that was truncated at twenty lines and
never re-run. It is corrected here rather than quietly fixed, because it is the
same defect as everything else in this milestone — a plausible claim, checked by
nobody — and it happened _inside_ the document whose purpose is to catch that.

### The count that was wrong

Every milestone plan since alpha.7 has said **"MUST 18 of 18 implemented"**. §1.1
contains **17** bullets. Nobody re-derived the number for five milestones. It never
entered this repository — it lives only in the plan documents under `research/`,
which is why no gate here could have caught it.

## 2. Tiers, and what each one costs

Per ADR-0027 §2. A suite that can only run where everything is available is a
suite that never runs.

| Tier   | What it needs                                          | Items | Who can run it       |
| ------ | ------------------------------------------------------ | ----- | -------------------- |
| **T0** | nothing — `pnpm test`, no credential, no daemon        | 53    | anyone, every CI job |
| **T1** | a local daemon: a Docker runtime, or an OpenSSH server | 5     | most machines        |
| **T2** | native Linux with Landlock + seccomp, no container     | 0     | a Linux host         |
| **T3** | a provider credential, and money                       | 1     | whoever pays         |
| **T4** | a person who did not write this                        | 3     | nobody, so far       |

**T2 has no items, and that is a finding rather than an oversight.** See §10: the
specification lists a cross-platform strong sandbox under §1.3 NON-GOALS, so
nothing in v0.1's definition of done can require native-Linux enforcement. Three
milestones of this project's strongest work sits _above_ this suite, not on it —
and ADR-0027's "T0–T2 green" gate is, as written, vacuous in its T2 half.

**T1 was widened while this was being derived**, and the amendment is in ADR-0027
§2 with its reason, rather than made quietly here.

### The tier rule, stated so a reader can disagree with a specific line

> **An item's tier is the lowest tier at which the clause, read plainly, is
> established.** Where a higher tier makes it stronger, the note says so.

The judgement calls are all the same shape: does 支持 / 默认无网络 / 可工作的 mean
the code path exists, or that it has been observed against a real provider, daemon
or kernel? Where the clause is about the kernel's own logic, the answer is T0.
Where the plain reading is a statement about the world — an adapter that works, a
shell that genuinely cannot reach the network — the tier is the one that can
observe it. Five items sit above T0 on that reading, and each says why.

### What gates `v0.1.0-rc.1`

> **T0–T2 green, and T4 executed at least once.** T3 may be partial, with what is
> missing named.

T4 has never been executed. That is why it is here: a release candidate asserts the
software is ready for someone else, and no one else has ever used it.

## 3. §1.1 — v0.1 MUST

| Id  | Clause (spec §1.1, verbatim)                                                              | Tier | Status     | Evidence                                                                                                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------- | ---- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | Session / Turn / Step 三层生命周期。                                                      | T0   | PASS       | test:runs eight steps and leaves the file correct test:the turn transitions only through legal states                                                                | The §31 vertical slice drives all three layers; the state machine is asserted separately                                                                                                                                                                                                                                                                  |
| M02 | 流式 Model Runtime 接口。                                                                 | T0   | PASS       | test:text streaming test:tool call streaming test:normalized event vocabulary                                                                                        | Adapter conformance streams all three protocol families. Strengthened at T3 by `test:live provider`                                                                                                                                                                                                                                                       |
| M03 | 至少一个可工作的模型 Adapter；内部 IR 不绑定任何厂商。                                    | T3   | PASS       | artifact:docs/provider-2-validation.md artifact:docs/alpha8-cross-model.md artifact:docs/alpha11-native-live-dogfood.md                                              | T3 because 可工作 read plainly means it worked against the vendor, not against a fixture. IR neutrality is T0: `pnpm lint` rule `no-provider-names-in-core`                                                                                                                                                                                               |
| M04 | Read / Grep / Glob / Edit / Shell / GitDiff 六个核心工具。                                | T0   | PASS       | suite:test:conformance test:GitDiff behaves consistently whether or not git is present artifact:docs/tool-surface-evidence-matrix.md                                 | All six appear as conformance cases run against every backend                                                                                                                                                                                                                                                                                             |
| M05 | ToolDefinition → ToolExecution → AccessRequest 的两阶段工具契约。                         | T0   | PASS       | test:Appendix A permission matrix test:rule specificity and layering test:a non-unique match is rejected rather than guessed                                         | The two-phase split is what every policy test exercises; no test names the contract, which is P1's shape                                                                                                                                                                                                                                                  |
| M06 | workspace 级 Permission Policy。                                                          | T0   | PASS       | test:Appendix A permission matrix test:configuration layering test:session approvals                                                                                 |                                                                                                                                                                                                                                                                                                                                                           |
| M07 | Secret path deny + 内容级 Secret redaction。                                              | T0   | PASS       | test:protected paths test:secret scanner and redactor test:the canary is not in the redactor output for any channel                                                  | Both halves, and the encodings                                                                                                                                                                                                                                                                                                                            |
| M08 | Env scrub；子进程不得默认继承 `process.env`。                                             | T0   | PASS       | test:environment scrubbing suite:lint:selftest                                                                                                                       | The lint rule `no-ambient-env-spawn` is the second half: the defect cannot be written, not merely cannot pass                                                                                                                                                                                                                                             |
| M09 | Egress Gate；模型请求、Telemetry、Hook 网络、插件网络均走统一出口策略。                   | T0   | NOT TESTED | test:egress gate test:telemetry with only allowlisted fields is sent test:an HTTP server goes through the EgressGate                                                 | **Three of four routes.** Model, telemetry and plugin (MCP) egress are established. **The hook-network route is exercised by nothing** — `src/extensions/hooks.ts` claims it in a comment (§18.3) and no test pairs a hook with the gate or asserts its network capability. Not rounded up                                                                |
| M10 | Freshness Ledger；Edit 必须绑定新鲜文件版本。                                             | T0   | PASS       | test:a stale edit is rejected test:receipts expire when the file changes test:Edit without a Read is refused for staleness                                           | On every backend, per the conformance case                                                                                                                                                                                                                                                                                                                |
| M11 | Atomic edit + unified diff + rollback metadata。                                          | T0   | PASS       | test:a failed atomic write leaves no partial file and no stray temp file test:the recorded diff matches the bytes on disk test:undo is an edit, with no special case | Rollback metadata is ADR-0025's journal, exercised by the undo suites                                                                                                                                                                                                                                                                                     |
| M12 | Append-only Session Event Log。                                                           | T0   | PASS       | test:the event log is append-only with a contiguous sequence suite:test:replay                                                                                       | The replay gate is the stronger form: the log reproduces terminal state                                                                                                                                                                                                                                                                                   |
| M13 | `/model`、`/goal`、`/loop`、`/permissions`、`/status`、`/compact` 控制命令的 Kernel API。 | T0   | PASS       | test:command dispatch test:/status and /compact test:/permissions                                                                                                    | One `describe` per command in the control-plane suite                                                                                                                                                                                                                                                                                                     |
| M14 | Local ExecutionBackend。                                                                  | T0   | PASS       | test:backend conformance: local suite:test:conformance                                                                                                               |                                                                                                                                                                                                                                                                                                                                                           |
| M15 | SSH ExecutionBackend 的稳定接口和最小可用实现。                                           | T1   | PASS       | test:SSH connection test:SSH process execution artifact:docs/alpha3-ssh-validation.md                                                                                | T1: needs a real `sshd`. CI starts one on loopback; the authoritative run was a separate Linux VM, and the artifact says which is which                                                                                                                                                                                                                   |
| M16 | Skill / Agent / Hook 的发现和配置格式；v0.1 可只实现核心生命周期子集。                    | T0   | PASS       | test:skill and agent discovery search both directories, new first test:lifecycle points are reached test:HookRunner                                                  | Discovery, format and the lifecycle subset the clause permits                                                                                                                                                                                                                                                                                             |
| M17 | FakeModel / FakeExecutor / FakeFileSystem，保证 Kernel 单测不依赖外部 API。               | T0   | NOT TESTED | test:fake model plumbing suite:test                                                                                                                                  | **Two of the three do not exist.** `FakeModel` is `src/model/adapters/fake.ts`; `FakeExecutor` and `FakeFileSystem` appear nowhere in `src/` or `tests/` — the suites use the real local backend against a temp directory. The guarantee holds (1145 offline tests, no credential, no network); the clause as written does not. Erratum candidate, see §9 |

## 4. §1.2 — v0.1 SHOULD

| Id  | Clause (spec §1.2, verbatim)                                                       | Tier | Status | Evidence                                                                                                     | Notes                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------- | ---- | ------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | 支持 OpenAI Responses、Anthropic Messages、OpenAI-compatible Chat 中至少两类协议。 | T0   | PASS   | test:Anthropic Messages adapter test:OpenAI Chat adapter test:OpenAI Responses adapter                       | All three, not two. Live coverage is uneven and A4 in `docs/open-evidence.md` tracks the gap: direct OpenAI has never been exercised on a funded account         |
| S02 | 提供 `workspace-dev`、`read-only`、`review` 三个默认权限 Profile。                 | T0   | PASS   | test:Appendix A permission matrix test:maps the three profile shapes onto the three modes                    | The matrix test iterates all three by name                                                                                                                       |
| S03 | `Shell` 默认无网络；请求网络必须显式声明。                                         | T1   | PASS   | test:network mode narrowing algebra test:scoped egress enforcement artifact:docs/alpha6-egress-validation.md | T1 because 默认无网络 read plainly is enforcement, not policy. **On the local backend it is policy only** — that is invariant 5, and `/status` says so (see V05) |
| S04 | Reference tree 通过配置被标记为 `read-only + no-shell-write`。                     | T0   | PASS   | test:reference trees are readable but never writable test:the reference tree was not modified                | The adversarial suite checks the tree afterwards, which is the stronger form                                                                                     |
| S05 | 支持 Session resume。                                                              | T0   | PASS   | test:resume test:a session resumed from the log can undo test:remote resume                                  | Local, and over SSH at T1                                                                                                                                        |
| S06 | 支持 user/project 两级 Skills、Agents、Hooks。                                     | T0   | PASS   | test:skill and agent discovery search both directories, new first test:configuration layering                | Skills and agents by search path; hooks by config layering rather than a search path, which is why no test names this clause. P1's shape again                   |

## 5. §25 — security invariants (release-blocking)

`以下 15 条是 v0.1 发布阻断项` — violate any one of them: do not release. So an
uncovered row here is worth more than an uncovered row anywhere else in this
document.

| Id  | Clause (spec §25, verbatim)                                              | Tier | Status     | Evidence                                                                                                                                                        | Notes                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------ | ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V01 | 任意 tool call 必须产生真实或 synthetic tool result。                    | T0   | PASS       | test:every tool call has a matching result test:an unknown tool still produces a result test:an interrupted tool call gets a synthetic result on replay         | Asserted in the live context and again in the persisted log                                                                                                                                                                                                                 |
| V02 | StepContext 在 model request 期间不可变。                                | T0   | NOT TESTED | —                                                                                                                                                               | **Covered by nothing.** `StepContext` exists in `src/tools/runtime.ts` and `src/session/session.ts` and appears in no test in the repository. Nothing asserts immutability across a model request. See §9                                                                   |
| V03 | Edit 必须通过 Freshness Ledger。                                         | T0   | PASS       | test:a stale edit is rejected test:Edit without a Read is refused for staleness, on every backend                                                               | Same evidence as M10, deliberately: one claim, one status                                                                                                                                                                                                                   |
| V04 | 所有 persistent source edit 必须可生成 diff 并关联 tool call。           | T0   | PASS       | test:the log records the edit with both hashes and a diff test:every mutating tool reaches the event log                                                        | Including the shell-mutation route, which is the one that could have been silent                                                                                                                                                                                            |
| V05 | Permission 不等于 Sandbox；UI 不得虚假声称 best-effort policy 是强隔离。 | T0   | PASS       | test:enforcement descriptor test:descriptor hygiene suite:lint                                                                                                  | The lint rule `no-enforcement-overclaim` makes the overclaim unwriteable outside the descriptor. Strengthened at T1/T2 where the descriptor is checked against a real kernel                                                                                                |
| V06 | Provider quirks 不进入 Agent Loop。                                      | T0   | PASS       | suite:lint suite:lint:selftest                                                                                                                                  | `no-provider-names-in-core`, with must-fail and must-pass fixtures                                                                                                                                                                                                          |
| V07 | Model Profile 与 Provider endpoint 分离。                                | T0   | PASS       | test:model profiles are separate from provider endpoints test:project config may NOT define a provider endpoint                                                 |                                                                                                                                                                                                                                                                             |
| V08 | Compaction 可 replay，且不破坏 tool-call closure。                       | T0   | PASS       | test:never splits a tool call from its result suite:test:replay test:a turn whose context outgrows the window compacts and keeps going                          |                                                                                                                                                                                                                                                                             |
| V09 | 大型 tool output 有预算和 artifact 引用。                                | T0   | NOT TESTED | —                                                                                                                                                               | **Covered by nothing at T0.** The mechanism exists — `artifactRef` and `fullOutput` in `src/tools/runtime.ts`, `maxOutputBytes` in the executors — and `artifactRef` appears in no test. The only truncation _assertion_ in the repository is the SSH one (see A15). See §9 |
| V10 | 任意自治循环有硬 budget。                                                | T0   | PASS       | test:a step budget stops the turn test:the doom-loop guard stops an identical repeated failure test:a provider that always reports overflow cannot spin forever | Three different runaway shapes                                                                                                                                                                                                                                              |
| V11 | Secret path 不能进入 Model Context。                                     | T0   | PASS       | test:canary secret boundary test:the kernel loads a credential file and then hides it test:a configured credential path is protected                            |                                                                                                                                                                                                                                                                             |
| V12 | Secret value 不能进入 Model/Telemetry/Hook/Plugin egress。               | T0   | PASS       | test:egress secret boundary test:telemetry refuses content and refuses a secret outright test:the environment route                                             | All four sinks, including the MCP routes alpha.9 added                                                                                                                                                                                                                      |
| V13 | 子进程默认不继承宿主完整环境。                                           | T0   | PASS       | test:environment scrubbing suite:lint                                                                                                                           | Same pair as M08                                                                                                                                                                                                                                                            |
| V14 | Agent/Skill/Hook/Subagent 只能收窄权限，不能扩大 Session ceiling。       | T0   | PASS       | test:capability never widens across the delegation boundary test:a skill can only narrow test:hooks cannot impersonate kernel hooks                             | All four actors                                                                                                                                                                                                                                                             |
| V15 | Reference 仓库默认只读。                                                 | T0   | PASS       | test:reference trees are readable but never writable test:a credential inside a reference tree is rejected                                                      | Same evidence as S04                                                                                                                                                                                                                                                        |

## 6. §28 — v0.1 acceptance criteria

`只有全部满足才标记 v0.1.0`.

### Agent Loop

| Id  | Clause (spec §28, verbatim)                            | Tier | Status | Evidence                                                                                                                                         | Notes                                                                                             |
| --- | ------------------------------------------------------ | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| A01 | fake-provider 8-step trajectory 100 次重复无状态泄漏。 | T0   | PASS   | test:repeats without state leaking between runs ci:Deterministic Kernel x100                                                                     | The CI job pins 100; the file's default is 100 too, so a plain `node --test` satisfies the clause |
| A02 | cancel 可在 model stream 和 tool execution 中止。      | T0   | PASS   | test:cancellation during the model stream test:cancelling mid-turn ends in cancelled with every call answered test:cancellation is not a timeout | Both halves the clause names, plus the distinction from a timeout                                 |
| A03 | interrupted tool call resume 后产生 synthetic result。 | T0   | PASS   | test:an interrupted tool call gets a synthetic result on replay test:an interrupted delegation resumes safely                                    | Same evidence as V01's third reference                                                            |

### Context / Edit

| Id  | Clause (spec §28, verbatim)        | Tier | Status | Evidence                                                                             | Notes                                                     |
| --- | ---------------------------------- | ---- | ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| A04 | stale file edit 被拒绝。           | T0   | PASS   | test:a stale edit is rejected                                                        | Named as a §28 criterion by the test file itself          |
| A05 | partial read coverage 不足被拒绝。 | T0   | PASS   | test:an edit outside the read window is rejected for insufficient coverage           | Named as a §28 criterion by the test file itself          |
| A06 | atomic edit 失败不留下半写文件。   | T0   | PASS   | test:a failed atomic write leaves no partial file and no stray temp file             | And no stray temp file, which the clause does not ask for |
| A07 | CRLF 文件修改后保持 CRLF。         | T0   | PASS   | test:a CRLF file stays CRLF after an edit test:parsers do not depend on line endings | The smoke suite runs the second one on Windows            |

### Permission / Security

| Id  | Clause (spec §28, verbatim)                              | Tier | Status | Evidence                                                                                                                                                                                       | Notes                                                             |
| --- | -------------------------------------------------------- | ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A08 | protected secret paths 100% hard deny。                  | T0   | PASS   | test:protected paths test:protected paths hold on native paths test:protected paths cannot be deleted                                                                                          | Including the deletion surface, and on APFS/NTFS path shapes      |
| A09 | symlink/path traversal 不可绕过。                        | T0   | PASS   | test:traversal is collapsed before any check runs test:canonicalize resolves a symlink to its target test:a symlink out of the workspace resolves before the containment check, and is refused | Three layers: lexical, filesystem, and container path translation |
| A10 | Secret canary 不进入 model/telemetry/network/event log。 | T0   | PASS   | test:canary secret boundary test:egress secret boundary test:base64 and hex encodings of the canary are also redacted                                                                          | AGENTS.md rule 10 stops all work if this fails                    |
| A11 | env scrub 单测覆盖常见凭证变量。                         | T0   | PASS   | test:environment scrubbing test:credential shapes are detected and redacted                                                                                                                    | `CREDENTIAL_ENV_PATTERNS` is the list under test                  |
| A12 | Skill/Agent/Hook 无法扩大 Session ceiling。              | T0   | PASS   | test:a skill can only narrow test:capability never widens across the delegation boundary test:the system ceiling bounds delegation depth                                                       | Same evidence as V14                                              |

### Tools

| Id  | Clause (spec §28, verbatim)                                         | Tier | Status     | Evidence                                                                                                                                    | Notes                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------- | ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A13 | Read/Grep/Glob/Edit/Shell/GitDiff 全部经过 ToolExecution contract。 | T0   | PASS       | suite:test:conformance test:Read of a path outside the workspace is refused test:GitDiff behaves consistently whether or not git is present | The conformance table runs every tool through the contract on every backend                                                                                                                                                                                                                  |
| A14 | 所有 tool result 有 call id。                                       | T0   | PASS       | test:every tool call has a matching result                                                                                                  | The test walks the event log pairing `toolCallId`s and never uses the words "call id" — P1, exactly                                                                                                                                                                                          |
| A15 | stdout/stderr 有统一 truncation + redaction。                       | T0   | NOT TESTED | test:output is truncated at the declared limit rather than growing unbounded test:the debug log sink is wired and redacts                   | **The redaction half is established; the 统一 half is not.** The only truncation assertion in the repository is the SSH one, at T1. `tests/integration/backend-conformance.test.ts` — the suite whose entire purpose is identical behaviour across backends — has no truncation case. See §9 |

### SSH

| Id  | Clause (spec §28, verbatim)           | Tier | Status | Evidence                                                                                 | Notes                                                                                              |
| --- | ------------------------------------- | ---- | ------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A16 | remote host 通过 OpenSSH alias 连接。 | T1   | PASS   | test:SSH connection test:SSH configuration safety artifact:docs/alpha3-ssh-validation.md | The alias comes from the operator's own `~/.ssh/config`; no host key or auth is reimplemented      |
| A17 | ForwardAgent 默认关闭。               | T0   | PASS   | test:ssh defaults                                                                        | T0: the argv the backend builds is assertable with no daemon. Strengthened at T1 by the live suite |
| A18 | 不转发宿主 env secrets。              | T1   | PASS   | test:SSH environment forwarding test:remote secret boundary                              | T1 because the honest form is a remote process printing its own environment back                   |
| A19 | remote path jail 生效。               | T1   | PASS   | test:remote workspace jail                                                               | Plus `tests/live/ssh-workspace-guard.test.ts` for the guard itself                                 |

### CLI

| Id  | Clause (spec §28, verbatim)                                                                      | Tier | Status | Evidence                                                                      | Notes                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ | ---- | ------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A20 | `-r/-c/-m/--profile/--remote` 可用。                                                             | T0   | PASS   | test:CLI flags test:flag stability is declared test:exit codes are a contract | ADR-0021 makes the flag set a contract; `docs/cli-contract.md` is now checked against it |
| A21 | `/model /goal /loop /permissions /status /compact /remote` 不经过模型解释即可改变 Kernel state。 | T0   | PASS   | test:command dispatch test:/remote test:/goal                                 | Seven commands here against §1.1's six; `/remote` arrived with the SSH backend           |

## 7. T4 — the claim a tag makes

**Not derived from a clause**, and this section says so rather than implying a
specification that does not exist. Source: ADR-0027 §3. The specification is silent
about the operator because a specification describes software; these three items are
what a release _candidate_ asserts, and they are the reason T4 exists.

The protocol is `docs/alpha10-second-operator.md`, unchanged. The page a stranger
can be sent is `docs/second-operator-invitation.md`, and the sheet they fill in
alone is `docs/second-operator-recording-sheet.md`.

| Id  | Item (source: ADR-0027 §3)                                                                          | Tier | Status     | Evidence                                    | Notes                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------- | ---- | ---------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| R01 | Somebody who did not write this installed the published artifact and configured a provider unaided. | T4   | NOT TESTED | artifact:docs/second-operator-invitation.md | Seventh consecutive milestone open. alpha.8 measured the artifact on a clean host; the variable here is the operator |
| R02 | The same person ran one real task in a repository the author never prepared.                        | T4   | NOT TESTED | artifact:docs/alpha10-second-operator.md    | Not simulated, which the protocol forbids in those words                                                             |
| R03 | The same person recovered a change they did not want, without being told how.                       | T4   | NOT TESTED | artifact:docs/alpha10-second-operator.md    | `/undo` and the `Undo` tool have been exercised by 32 tests and by nobody                                            |

## 8. Counts

Recomputed by `scripts/acceptance.ts` on every run and compared against these
numbers, so the document and the gate cannot drift apart.

```text
items                 62
  covered (PASS)      54
  uncovered           8   — 5 NOT TESTED at T0-T1, 3 at T4
  FAIL                0
  NOT APPLICABLE      0

by tier               T0 53 · T1 5 · T2 0 · T3 1 · T4 3
by source             §1.1 17 · §1.2 6 · §25 15 · §28 21 · ADR-0027 3
```

**And the sentence that has to sit next to those numbers:**

> "54 of 62 covered" is a count of one document against another. It is useful, it
> is checkable, and it is **not evidence about the software**. A clause can be
> mapped to a test that exists, passes, and does not establish it. Five of the
> eight uncovered items were found precisely because the mapping was done by
> reading rather than by matching names.

## 9. The uncovered eight

The output this milestone exists to produce. Each says what would close it; none is
being closed here, because alpha.12 defines the suite and does not add capability
(ADR-0027, and the commitment in force since alpha.11).

| Id  | What is missing                                                                  | What would close it                                                                                                   | Kind                  |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------- |
| M09 | The hook-network route through the egress gate is claimed in a comment only      | One test that gives a hook a network capability and asserts the gate decided it — the same shape as the MCP HTTP test | untested behaviour    |
| M17 | `FakeExecutor` and `FakeFileSystem` do not exist                                 | Either build them, or a spec erratum saying the guarantee is met by a temp directory and the local backend            | **erratum candidate** |
| V02 | Nothing asserts `StepContext` immutability during a model request                | One test that mutates a live `StepContext` mid-request and asserts the step sees its snapshot                         | untested invariant    |
| V09 | `artifactRef` — the large-output budget and its artifact reference — is untested | One test asserting a >budget output is truncated, reported truncated, and reachable through the artifact it names     | untested invariant    |
| A15 | Truncation is asserted for one backend; the conformance suite has no case for it | A truncation case in `backend-conformance`, which is where 统一 means anything                                        | untested behaviour    |
| R01 | No second operator                                                               | One hour of one person's time (`docs/second-operator-invitation.md`)                                                  | blocked on a person   |
| R02 | The same                                                                         | The same hour                                                                                                         | blocked on a person   |
| R03 | The same                                                                         | The same hour                                                                                                         | blocked on a person   |

Two of the five machine-closable items are **release-blocking invariants** (V02,
V09) — §25 says violating one means do not release, and neither has ever been
exercised. That is the single most useful line in this document, and no gate in this
repository could have produced it, because every gate here checks claims that were
made and none checked for claims that were never made at all.

`docs/open-evidence.md` indexes the three T4 items as A1, which it has carried for
seven milestones. The five machine-closable ones are **new**: they are not in that
index, because nothing had ever noticed them.

## 10. What the specification does not ask for

Reading §1.3 NON-GOALS while deriving produced the result that most changes how
this document should be read.

```text
spec §1.3, verbatim:
  production-grade macOS Seatbelt / Linux Landlock / Windows restricted-token
  全平台强沙箱  — 以下能力不得阻塞 v0.1 发布
```

**v0.1 does not require OS-level enforcement.** The container backend, the scoped
egress proxy and the native Landlock + seccomp sandbox — alpha.5, alpha.6 and
alpha.7, this project's three strongest milestones and most of its evidence corpus —
answer no clause in this suite. They appear here only where a clause needs them to
be read plainly (S03, and V05's strengthening), and T2 therefore has **zero items**.

Three consequences, and none of them is that the work was wasted:

1. **ADR-0027's `rc.1` gate is vacuous in its T2 half**, as written. It says
   "T0–T2 green" and there is nothing at T2 to be green. The honest repair is not
   to invent T2 items — that would be deriving from the answers — but to say that
   T2's content is `docs/alpha7-evidence-matrix.md` and the CI jobs that gate it,
   which stand on their own and outside this suite.
2. **The acceptance suite is not the whole record and must never be read as one.**
   A reader who takes "54 of 62" as the project's coverage will have missed the
   part with the most evidence behind it.
3. It is worth asking, once, whether a v0.1 that exceeds its specification by three
   milestones has a specification problem. Not answered here. Naming it is enough;
   the suite is derived _from_ the spec and a suite that edits its own source is not
   a measurement.

## 11. What this document is not

```text
not a test framework        `pnpm test` runs the tests; this is a document
                            plus a mapping
not a second evidence gate  the corpus checks in scripts/evidence-corpus.ts
                            exist and are enough; scripts/acceptance.ts runs
                            from inside the same gate
not a rewrite of the        they are the evidence this maps onto, and they stay
  evidence matrices         at their own milestones' statuses
not a new vocabulary        PASS / FAIL / NOT TESTED / NOT APPLICABLE, and the
                            kind: references the evidence gate already resolves
```

## Model provenance

This document makes one live-model claim, M03, and it points at three artifacts
that each name their model: `docs/provider-2-validation.md`,
`docs/alpha8-cross-model.md` (`deepseek-chat`, `gpt-5.6-terra`) and
`docs/alpha11-native-live-dogfood.md` (`deepseek-chat` on `linux-vm`). Every other
row is a property of the test tree or the specification, established by reading and
by running the suites named, with no model involved.
