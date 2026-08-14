# `v0.1.0-alpha.4` — Delegated Execution status

**Baseline:** `v0.1.0-alpha.3` (`882cd4f`, now in `main` through the merge commit
`df6b29d`) · **Provider #1 (live-validated):** DeepSeek over `openai-chat` ·
**SSH composition validated against:** a **separate aarch64 Linux VM over the
network**, and again on loopback · **Trusted CI evidence:** the run for the
**exact tagged commit** on `main`, whose id is recorded in the annotated tag —
pre-merge runs [`31707435395`](https://github.com/OIerYangJZ/MyCoder/actions/runs/31707435395)
and [`31708209743`](https://github.com/OIerYangJZ/MyCoder/actions/runs/31708209743)
were both 20/20 green

Status vocabulary is the four values from alpha.3 §34. **PASS** means a named,
executable piece of evidence asserts it. **NOT TESTED** means it is not asserted
here, and the notes say why. **NOT APPLICABLE** means out of scope for this
milestone. Every claim below maps to a row in
`docs/alpha4-evidence-matrix.md`, which `node scripts/evidence.ts` checks
mechanically — over alpha.3's matrix as well as this one, because alpha.3's rows
are still the evidence for alpha.3's claims.

> **The headline is not the pass rate.** It is that turning the subagent and
> skill layers into executable runtime found **three defects that had nothing to
> do with delegation** — two of them in compaction, which had been shipped and
> "tested" since alpha.2, and one that made a documented `permissions.toml`
> capability inexpressible. §2 describes them. That is the same return alpha.3
> produced, from the same method: run the layer for real, and assert against what
> the log and the model request actually contain.

---

## 1. What was actually executed

| Gate                                         | Result                                                            |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm typecheck`                             | clean                                                             |
| `pnpm lint`                                  | 9 rules, 0 violations                                             |
| `pnpm lint:selftest`                         | 90/90                                                             |
| `pnpm format:check`                          | clean                                                             |
| `pnpm test`                                  | **633 tests, 562 pass, 0 fail, 71 skipped**                       |
| `pnpm test:delegation`                       | **44/44** (delegation, skills, replay, security harness)          |
| `pnpm test:soak` at `KERNEL_SOAK_REPEATS=50` | pass, 3.7s                                                        |
| `pnpm test:security`                         | 116/116                                                           |
| `pnpm test:ssh` — **real remote VM**         | **96 pass, 0 fail**                                               |
| `pnpm test:ssh` — loopback                   | **71 pass, 0 fail**                                               |
| `pnpm test:evals`                            | 30/30                                                             |
| `pnpm test:replay`                           | 13/13                                                             |
| determinism ×100                             | pass                                                              |
| `pnpm evidence`                              | alpha.3: 169 rows, 166 PASS · alpha.4: 119 rows, 108 PASS, 0 FAIL |
| `pnpm eval` (scripted)                       | 16/16; 0 secret-boundary violations                               |
| `pnpm test:live:model` (DeepSeek)            | 9/9                                                               |
| live delegation eval (DeepSeek, N=5)         | **15/15 solved, 0 violations**                                    |
| `main` CI after the alpha.3 merge            | green                                                             |
| `main` CI on the alpha.4 merge commit        | green on attempt 2; see the note below                            |
| CI on this milestone's tree                  | **20/20 jobs green** (runs `31707435395`, `31708209743`)          |

The 71 skipped tests are the SSH matrix under a plain `pnpm test`; it is opt-in
through `KERNEL_SSH=1` and runs as its own CI job. It skips with a stated reason,
not silently.

**One unexplained CI failure, recorded rather than smoothed over.** On the alpha.4
merge commit, `Platform / macos-latest` failed once at `pnpm test:platform` and
passed on re-run. The same job had passed three times on the pull request. The log
could not be read from the machine doing the release — GitHub serves job logs from
a blob host that was unreachable there — so **the cause is unknown**, and this line
exists because "green on attempt 2" is not the same claim as "green".

What was done instead of guessing: the suite was run five times locally on macOS
(246 pass, 0 fail each time), and the two timing-dependent tests this milestone
added were rewritten to be deterministic. Both cancelled a parent from a 1ms
`setTimeout` and then asserted on what the child had managed to do — a property
that depends on whether a timer beats a whole model exchange, which is exactly the
shape of test that passes locally and fails on a loaded runner. They now cancel
synchronously from inside the child's own request. That removes a real flake
whether or not it was this one.

Test count went 572 → 633. Nothing from alpha.3 was deleted or weakened.

## 2. What the new gates found

Three defects, none of them in delegation. All are fixed, and each has a
regression test that would have caught it with no subagent involved.

### 2.1 Automatic mid-turn compaction failed the turn

`Session.maybeCompact()` moved the turn into `compacting` and the loop then went
straight to `sampling`. The state machine (§5.2) forbids that transition, so the
turn died with `INTERNAL_ERROR: illegal turn transition: compacting → sampling`
at exactly the moment compaction was supposed to rescue it.

It had never run. Every compaction test in the repository used either `/compact`
from the control plane — which happens outside a turn — or the provider-overflow
path, which `continue`s to the top of the loop and re-enters `preparing` legally.
No test read enough inside a single turn to cross the context budget, so the one
path an ordinary long session actually takes was untested.

Found by the soak, which asserts that every turn _completes_ rather than merely
running. Same shape as the alpha.2 overflow defect: an enforced state machine
punishes a missing transition, and the punishment looks like an unrelated
internal error.

Fixed by returning to `preparing` after compaction. Pinned by
`test:automatic mid-turn compaction does not fail the turn`.

### 2.2 Compaction erased tool calls from the live half of the replay gate

`SessionTerminalState.toolCalls` was derived from `context.history()`. Compaction
_rewrites_ that history, so a tool exchange in the summarised head disappeared
from the live side while the event log kept it — and the replay gate reported a
divergence.

The gate's existing compaction case appended plain user text and never a tool
call, so the divergence had no way to appear. It surfaced first as a delegation
failure, which is misleading: it would have fired for any compacted tool call.

Fixed by accumulating issued and answered ids as they happen, which mirrors the
append-only log by construction rather than describing the current window. Pinned
by `test:a tool call that compaction summarised away is still in the live state`,
which involves no delegation at all.

A related consequence: a _resumed_ session could never have satisfied the gate,
because the live half started empty while the log held everything. The session now
seeds its terminal state from `replayTerminalState` and its token/cost totals from
the metadata snapshot. The soak checks the gate twice — before the shutdown, where
the pre-restart facts are compared independently, and after, where the seeded
state must still agree with everything the new process did.

### 2.3 `permissions.toml` could not express the new capability

`src/config/config.ts` carried a hand-written copy of the capability list. It fell
behind the moment `agent.invoke` was added, so a project rule naming it was
dropped with an "unknown capability" warning — making the one policy alpha.4 §11
asks a project to be able to write (`deny agent.invoke pattern = "release-bot"`)
inexpressible. A warning, not silence, which is a defect with better manners.

Fixed by deriving the list from `ALL_CAPABILITIES`. Pinned by
`test:every capability the policy layer knows is accepted in permissions.toml`,
with a negative control proving the parser still rejects a genuinely unknown one.

### 2.4 Two smaller ones

- **The `evals/results/release/` negation was inert.** `.gitignore` excluded the
  _directory_, and git cannot re-include anything under an excluded directory — so
  the released artifact the evidence gate insists must be tracked had to be
  `git add -f`ed by hand. Now excluded per-entry, which makes the rule true rather
  than aspirational.
- **Control-plane compaction was a second implementation.** `/compact` built its
  own `compact()` call in the kernel's control host and did not re-inject
  delegated work, so a user-triggered compaction could lose a child's result while
  an automatic one kept it. Both paths now go through `Session.compactNow()`.

### 2.5 Three test-premise bugs, worth recording

Not product defects, but the same failure mode as a bad test elsewhere: a case
that passes for the wrong reason. In each, the child's forbidden action was
refused with `TOOL_NOT_FOUND` because the agent definition had not listed the
tool — so the capability _intersection_ was never exercised. All three now put the
tool in the child's catalogue so the read-only policy layer is what refuses.

The general lesson is in the plan already (§44's negative controls) and now has
three concrete instances: a security test must assert _which mechanism_ stopped
the attack, or it will eventually be satisfied by the attack never happening.

## 3. What alpha.4 claims

> The Kernel supports real bounded Subagent execution and real Skill activation
> using the same model, tool, policy, Secret, egress, Hook, replay and execution
> infrastructure as the parent runtime. Delegated capabilities are proven
> narrower-or-equal at runtime, budgets and cancellation are bounded, delegation
> survives replay, resume and compaction, and long-running delegated sessions have
> passed deterministic and live validation.

Concretely, and each with a matrix row:

- A parent dispatches a child that **samples the real `ModelRuntime`** and
  **executes the real `ToolRuntime`**. Asserted against the child's own captured
  model requests and its `delegationId`-tagged `tool.call` events, not against
  `deriveSubagent()`.
- **Capability only narrows.** A read-only parent produces a read-only child even
  when the definition asks for `workspace-dev`; the child's catalogue is an
  intersection; a tool outside it is refused by the frozen step rather than by the
  registry.
- **Budget only narrows, and is charged back.** `min(default, parent remaining,
root ceiling, definition, active skills, request)`, then the child's usage is
  added to the parent's turn — so delegating cannot buy unbounded work.
- **Depth is 1 by default**, and a refused grandchild is a recorded
  `delegation.requested` → `delegation.denied` pair rather than a silently missing
  tool.
- **Cancellation propagates**, and nothing continues in the background: `run()`
  awaits the child and links the parent's `AbortSignal` to `child.cancel()`.
- **Context is referenced, not copied.** A non-secret parent-only marker never
  reaches a child prompt, with a negative control proving the capture could see it.
- **Skills are a runtime overlay**: instructions reach the real model request with
  `skill:<name>` provenance, tools and permissions narrow, `max_steps` clamps, and
  a skill declaring `network: true` gets nothing.
- **Delegation is auditable.** live == replay across completed, failed, denied and
  cancelled delegations, over compaction, and across a restart.
- **The child uses the session's backend**, proven by reading a file that exists
  only on a remote VM.

## 4. What alpha.4 measured, and what it does not know

> **Followed up after the tag, and the answer changed §7's advice.** A dedicated
> experiment pulled every lever available to the harness: three task sizes up to
> eighteen files with two independent faults, a second `Delegate` description, and a
> system-prompt sentence introducing delegation as a strategy. Counting the run below,
> DeepSeek was offered a verified tool **70 times and chose it zero times**, solving
> every attempt. All three candidate explanations are eliminated, which leaves the
> model itself — so a second provider is now the _only_ way left to learn whether the
> delegation runtime pays for itself, the opposite of what §7 concluded.
> `docs/delegation-utility-experiment.md`.

**Natural delegation: 0 out of 10.** On the two tasks where DeepSeek was told it
had subagents available and left to judge, it delegated **zero times** — and
solved all ten attempts anyway. The explicit-conformance suite, where delegation
is demanded, passed 5/5 with the child making 2–4 model requests and 1–4 tool
calls each time.

So the runtime works and the model does not currently want it, at least for
diagnosis and small-fix tasks at this size. That is a measurement, not a defect,
and it is the reason §36 says to collect evidence before optimising: there is
presently **no evidence that delegation improves solved-task probability**, and
alpha.5 should not assume one. The two suites are reported apart for exactly this
reason — averaging them would produce a number that answers neither question.

**Cost is measurable, and estimated.** The direct / delegated / total split is
implemented and reported: `$0.0171` direct against `$0.0036` delegated across 15
live attempts (183k input, 14k output tokens). Treat the dollars as an estimate
rather than a bill: the figures come from list prices configured locally, and
DeepSeek's pricing page no longer lists the `deepseek-chat` alias at all, so which
tier applies is not something the kernel can verify. It labels every derived figure
`costProvenance: "estimated"` for that reason. Token counts are exact.

**Delegation latency is high.** Median 10.7s per delegation against a 3–5s
parent-only turn, because a child is a whole model conversation. Sequential
dispatch makes that latency additive by construction, which is a deliberate
alpha.4 choice (§5) and the first thing a parallel-subagent milestone would have to
justify against it.

## 5. What alpha.4 does not claim

Every line here is a NON-GOAL in the plan (§5, §22) or an explicit NOT TESTED row:

- **No OS isolation of a child.** A subagent is a policy scope in the same
  process, with the same user rights. `describeSandbox` says so in the system
  prompt and `/status`; container isolation is the alpha.5 candidate.
- **No parallel subagents, no agent teams, no background agents.** Delegation is
  sequential and a child cannot outlive its parent's turn.
- **No recursive delegation.** Depth 1 by default, and depth > 1 is untested — a
  grandchild's usage would be charged to the _root's_ turn rather than its parent's,
  which is conservative and unreachable at the default ceiling (ADR-0013).
- **No second provider, no live Anthropic.** One provider is validated.
- **No automatic skill routing.** Activation is explicit: the control plane, an
  agent definition, or a bounded model request.
- **A tool-narrowing skill disables delegation** for as long as it is active,
  because it narrows every tool including `Delegate`. Correct, surprising, and
  documented in ADR-0013 and in the tests rather than discovered later.

## 6. Interfaces that changed

Three, all recorded in **ADR-0013**:

1. `AccessRequest` gains `agent.invoke` — the change AGENTS.md rule 4 and plan §11
   both require an ADR to make.
2. `KernelEvent` gains `delegationId`, and six `delegation.*` event types plus
   `skill.activated` / `skill.deactivated` join the log.
3. `ToolResolveContext` gains `delegation`, `loopBudget` and two optional
   callbacks (`delegate`, `activateSkill`). A wider seam for tools than before; the
   alternative was a module-level service locator, which is worse.

`SessionTerminalState` also gains `delegations`, which changes the replay gate's
comparison shape. That is internal, but it is the field a future divergence will
be reported in, so it is worth knowing where to look.

## 7. Suggested alpha.5 direction

The plan (§52) offers enforcement hardening or provider breadth, and says to
choose from measured uncertainty rather than feature visibility. What this
milestone measured points at **enforcement hardening**:

- The largest unvalidated claim left is isolation. Delegation made the _policy_
  boundary real and testable; the process boundary is still "same process, same
  uid, best-effort network", which every honest surface in the product already
  admits. A container or OS-sandbox backend is the only thing that would let the
  kernel say "cannot" instead of "may not".
- Provider breadth would buy less right now, because the one measurement that
  would justify a second provider — does model choice change delegation behaviour?
  — needs a delegation behaviour to compare against, and DeepSeek's is currently
  "never".
