# The v0.1 acceptance suite

**Date:** 2026-08-17 · **Defined in:** `v0.1.0-alpha.12` · **Authority:** ADR-0027

This is the definition of what this software must do to be called `v0.1`. It is
derived from the normative specification, clause by clause, and every item carries
the clause it came from.

> **This commit contains no evidence column, and that is the point.**
>
> The suite is written **before** it is satisfied. There is no `Status` and no
> `Evidence` here yet, so this document cannot have been assembled from the tests
> that happen to exist — a suite derived from the test tree is a description of the
> test tree, green on the day it is written, and indistinguishable to a reader from
> a suite that means something. The mapping is the next commit, and the order is
> recorded in the history rather than asserted in prose.

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
```

`scripts/acceptance.ts` compares that hash against the specification **when the
file is present**, and re-derives the clause list from it: an edited spec fails the
check rather than silently orphaning the suite. On a machine where `research/` is
absent — CI, or any consumer of the package — the hash cannot be checked and the
gate says so out loud instead of passing quietly.

Two of these four sources were not in the milestone plan's list, and finding them
is the first result of deriving from the specification instead of from what was
already known:

**§25** — fifteen release-blocking security invariants. Referenced by name
throughout `src/` ("invariant 5", "invariant 13") and by `scripts/lint.ts`, but
never enumerated against evidence in one place.

**§28** — "v0.1 Acceptance Criteria", 21 unticked checkboxes prefixed
`只有全部满足才标记 v0.1.0`. **This is the acceptance suite the plan said did not
exist.** It has been in the normative document since before alpha.1. Nothing in
this repository has ever pointed at it, one passing source comment aside. The
project did not lack a definition of done; it lacked anything that would notice one
going unread. Recorded in `docs/alpha12-predictions.md` §2, because it was found
before the predictions were committed and must not be sold as a prediction that
came true.

### The count that was wrong

Every milestone plan since alpha.7 has said **"MUST 18 of 18 implemented"**. §1.1
contains **17** bullets. The number is off by one, nobody re-derived it for five
milestones, and it never entered this repository — it lives only in the plan
documents under `research/`, which is why no gate could have caught it. It is
recorded here because it is the same defect as everything in CLOSURE B: a count
copied from a document, by hand, once.

## 2. Tiers, and what each one costs

Per ADR-0027 §2. A suite that can only run where everything is available is a
suite that never runs.

| Tier   | What it needs                                          | Who can run it       |
| ------ | ------------------------------------------------------ | -------------------- |
| **T0** | nothing — `pnpm test`, no credential, no daemon        | anyone, every CI job |
| **T1** | a local daemon: a Docker runtime, or an OpenSSH server | most machines        |
| **T2** | native Linux with Landlock + seccomp, no container     | a Linux host         |
| **T3** | a provider credential, and money                       | whoever pays         |
| **T4** | a person who did not write this                        | nobody, so far       |

**T1 was amended during this derivation**, and the amendment is recorded in
ADR-0027 §2 rather than made quietly here. The plan's tier list had a container
tier and no tier for a real SSH server, because it was written from the enforcement
work; §1.1's SSH clause and four of §28's need an `sshd` and no container at all.
That is a gap the derivation found in the tiering itself, which is a small piece of
evidence that deriving from clauses rather than from tests surfaces things.

### The tier rule, stated so a reader can disagree with a specific line

> **An item's tier is the lowest tier at which the clause, read plainly, is
> established.** Where a higher tier makes it stronger, the note says so.

The judgement calls are all of the same shape: does "支持" / "默认无网络" /
"可工作的" mean the code path exists, or that it has been observed against a real
provider, daemon or kernel? Where the clause is about the kernel's own logic, the
answer is T0. Where the plain reading is a statement about the world — a real
adapter that works, a shell that genuinely cannot reach the network — the tier is
the one that can observe it. Three items are tiered above T0 on exactly that
reading (M03, S03, and the SSH group), and each says why in its notes.

### What gates `v0.1.0-rc.1`

> **T0–T2 green, and T4 executed at least once.** T3 may be partial, with what is
> missing named.

T4 has never been executed. That is the whole point of putting it here: a release
candidate asserts the software is ready for someone else, and no one else has ever
used it.

## 3. §1.1 — v0.1 MUST

| Id  | Clause (spec §1.1, verbatim)                                                              | Tier |
| --- | ----------------------------------------------------------------------------------------- | ---- |
| M01 | Session / Turn / Step 三层生命周期。                                                      | T0   |
| M02 | 流式 Model Runtime 接口。                                                                 | T0   |
| M03 | 至少一个可工作的模型 Adapter；内部 IR 不绑定任何厂商。                                    | T3   |
| M04 | Read / Grep / Glob / Edit / Shell / GitDiff 六个核心工具。                                | T0   |
| M05 | ToolDefinition → ToolExecution → AccessRequest 的两阶段工具契约。                         | T0   |
| M06 | workspace 级 Permission Policy。                                                          | T0   |
| M07 | Secret path deny + 内容级 Secret redaction。                                              | T0   |
| M08 | Env scrub；子进程不得默认继承 `process.env`。                                             | T0   |
| M09 | Egress Gate；模型请求、Telemetry、Hook 网络、插件网络均走统一出口策略。                   | T0   |
| M10 | Freshness Ledger；Edit 必须绑定新鲜文件版本。                                             | T0   |
| M11 | Atomic edit + unified diff + rollback metadata。                                          | T0   |
| M12 | Append-only Session Event Log。                                                           | T0   |
| M13 | `/model`、`/goal`、`/loop`、`/permissions`、`/status`、`/compact` 控制命令的 Kernel API。 | T0   |
| M14 | Local ExecutionBackend。                                                                  | T0   |
| M15 | SSH ExecutionBackend 的稳定接口和最小可用实现。                                           | T1   |
| M16 | Skill / Agent / Hook 的发现和配置格式；v0.1 可只实现核心生命周期子集。                    | T0   |
| M17 | FakeModel / FakeExecutor / FakeFileSystem，保证 Kernel 单测不依赖外部 API。               | T0   |

## 4. §1.2 — v0.1 SHOULD

| Id  | Clause (spec §1.2, verbatim)                                                       | Tier |
| --- | ---------------------------------------------------------------------------------- | ---- |
| S01 | 支持 OpenAI Responses、Anthropic Messages、OpenAI-compatible Chat 中至少两类协议。 | T0   |
| S02 | 提供 `workspace-dev`、`read-only`、`review` 三个默认权限 Profile。                 | T0   |
| S03 | `Shell` 默认无网络；请求网络必须显式声明。                                         | T1   |
| S04 | Reference tree 通过配置被标记为 `read-only + no-shell-write`。                     | T0   |
| S05 | 支持 Session resume。                                                              | T0   |
| S06 | 支持 user/project 两级 Skills、Agents、Hooks。                                     | T0   |

## 5. §25 — security invariants (release-blocking)

`以下 15 条是 v0.1 发布阻断项` — violating any one of them: do not release.

| Id  | Clause (spec §25, verbatim)                                              | Tier |
| --- | ------------------------------------------------------------------------ | ---- |
| V01 | 任意 tool call 必须产生真实或 synthetic tool result。                    | T0   |
| V02 | StepContext 在 model request 期间不可变。                                | T0   |
| V03 | Edit 必须通过 Freshness Ledger。                                         | T0   |
| V04 | 所有 persistent source edit 必须可生成 diff 并关联 tool call。           | T0   |
| V05 | Permission 不等于 Sandbox；UI 不得虚假声称 best-effort policy 是强隔离。 | T0   |
| V06 | Provider quirks 不进入 Agent Loop。                                      | T0   |
| V07 | Model Profile 与 Provider endpoint 分离。                                | T0   |
| V08 | Compaction 可 replay，且不破坏 tool-call closure。                       | T0   |
| V09 | 大型 tool output 有预算和 artifact 引用。                                | T0   |
| V10 | 任意自治循环有硬 budget。                                                | T0   |
| V11 | Secret path 不能进入 Model Context。                                     | T0   |
| V12 | Secret value 不能进入 Model/Telemetry/Hook/Plugin egress。               | T0   |
| V13 | 子进程默认不继承宿主完整环境。                                           | T0   |
| V14 | Agent/Skill/Hook/Subagent 只能收窄权限，不能扩大 Session ceiling。       | T0   |
| V15 | Reference 仓库默认只读。                                                 | T0   |

## 6. §28 — v0.1 acceptance criteria

`只有全部满足才标记 v0.1.0` — the list that already existed, and that nothing has
ever been mapped onto.

### Agent Loop

| Id  | Clause (spec §28, verbatim)                            | Tier |
| --- | ------------------------------------------------------ | ---- |
| A01 | fake-provider 8-step trajectory 100 次重复无状态泄漏。 | T0   |
| A02 | cancel 可在 model stream 和 tool execution 中止。      | T0   |
| A03 | interrupted tool call resume 后产生 synthetic result。 | T0   |

### Context / Edit

| Id  | Clause (spec §28, verbatim)        | Tier |
| --- | ---------------------------------- | ---- |
| A04 | stale file edit 被拒绝。           | T0   |
| A05 | partial read coverage 不足被拒绝。 | T0   |
| A06 | atomic edit 失败不留下半写文件。   | T0   |
| A07 | CRLF 文件修改后保持 CRLF。         | T0   |

### Permission / Security

| Id  | Clause (spec §28, verbatim)                              | Tier |
| --- | -------------------------------------------------------- | ---- |
| A08 | protected secret paths 100% hard deny。                  | T0   |
| A09 | symlink/path traversal 不可绕过。                        | T0   |
| A10 | Secret canary 不进入 model/telemetry/network/event log。 | T0   |
| A11 | env scrub 单测覆盖常见凭证变量。                         | T0   |
| A12 | Skill/Agent/Hook 无法扩大 Session ceiling。              | T0   |

### Tools

| Id  | Clause (spec §28, verbatim)                                         | Tier |
| --- | ------------------------------------------------------------------- | ---- |
| A13 | Read/Grep/Glob/Edit/Shell/GitDiff 全部经过 ToolExecution contract。 | T0   |
| A14 | 所有 tool result 有 call id。                                       | T0   |
| A15 | stdout/stderr 有统一 truncation + redaction。                       | T0   |

### SSH

| Id  | Clause (spec §28, verbatim)           | Tier |
| --- | ------------------------------------- | ---- |
| A16 | remote host 通过 OpenSSH alias 连接。 | T1   |
| A17 | ForwardAgent 默认关闭。               | T0   |
| A18 | 不转发宿主 env secrets。              | T1   |
| A19 | remote path jail 生效。               | T1   |

### CLI

| Id  | Clause (spec §28, verbatim)                                                                      | Tier |
| --- | ------------------------------------------------------------------------------------------------ | ---- |
| A20 | `-r/-c/-m/--profile/--remote` 可用。                                                             | T0   |
| A21 | `/model /goal /loop /permissions /status /compact /remote` 不经过模型解释即可改变 Kernel state。 | T0   |

## 7. T4 — the claim a tag makes

**Not derived from a clause**, and the section says so rather than implying a
specification that does not exist. Source: ADR-0027 §3. The specification is silent
about the operator because a specification describes software; these three items
are what a release _candidate_ asserts, and they are the reason T4 exists at all.

The protocol is `docs/alpha10-second-operator.md`, unchanged. The invitation a
stranger can be sent is `docs/second-operator-invitation.md`.

| Id  | Item (source: ADR-0027 §3)                                                                          | Tier |
| --- | --------------------------------------------------------------------------------------------------- | ---- |
| R01 | Somebody who did not write this installed the published artifact and configured a provider unaided. | T4   |
| R02 | The same person ran one real task in a repository the author never prepared.                        | T4   |
| R03 | The same person recovered a change they did not want, without being told how.                       | T4   |

## 8. What this document is not

```text
not a test framework        `pnpm test` runs the tests; this is a document
                            plus a mapping
not a second evidence gate  the corpus checks in scripts/evidence-corpus.ts
                            exist and are enough
not a rewrite of the        they are the evidence this maps onto, and they stay
  evidence matrices         at their own milestones' statuses
not a new vocabulary        PASS / FAIL / NOT TESTED / NOT APPLICABLE, and the
                            kind: references the evidence gate already resolves
```

And the sentence a reader should hold onto once the mapping exists:

> **"N clauses covered, M uncovered" is a count of one document against another.**
> It is useful, it is checkable, and it is not evidence about the software. A
> clause can be mapped to a test that exists, passes, and does not establish it.

## Model provenance

No behavioural claim is made by this document. It maps clauses onto evidence that
other documents recorded, and each of those names the model it used. The mapping
itself was made by reading, with no model involved.
