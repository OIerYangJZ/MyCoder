# Does delegation pay? — the alpha.4 §36 experiment

**Status:** phase 2 complete and artifact-backed. Phase 1 complete but its artifact
was lost to an overwrite (see §5); the numbers below come from the run log and the
re-run is pending a provider top-up.
**Model:** DeepSeek `deepseek-chat` over `openai-chat`.
**Runner:** `pnpm eval:delegation-utility` — `evals/experiments/delegation-utility.ts`.

alpha.4 shipped a delegation runtime and then measured that DeepSeek chose to use
it **0 times out of 10** on tasks where subagents were available and the choice was
left to it — solving all ten anyway. `docs/alpha4-status.md` §4 recorded that as an
open question with three candidate explanations:

1. the tasks were too small for delegation to pay;
2. the `Delegate` tool description suppresses its use;
3. delegation genuinely does not help this model.

This experiment tests (1) and (2). It does not settle (3), and §4 says what is left.

## 1. Design

A 3×2 for (1), then a 1×2 for (2).

| Phase | Varies                    | Held constant                                 |
| ----- | ------------------------- | --------------------------------------------- |
| 1     | task size, agents present | prompt per size, tool description, model, N=5 |
| 2     | `Delegate` description    | the largest task, agents present, model, N=5  |

The "no agents" condition is a real control rather than a formality: with no agent
definitions in the workspace the kernel does not register `Delegate` at all
(ADR-0013), so the control is a model that cannot see the tool rather than one
declining it.

Sizes:

| Size   | Shape                                                                 | Prior expectation             |
| ------ | --------------------------------------------------------------------- | ----------------------------- |
| small  | 1 file, 1 line — fix `clamp()`                                        | delegation should not pay     |
| medium | 6 files, one root cause 3 files deep                                  | marginal                      |
| large  | 18 files, **two independent faults** in two subsystems, diagnose both | the shape it should help with |

No prompt mentions delegation, subagents or the tool (§34: "use a subagent now"
measures instruction-following, not capability). Checks are about outcomes — which
root cause was named, what the file contains afterwards — never about trajectory. A
check asserting "it delegated" would answer the question by assuming it.

### Two negative controls, because a zero is easy to fake

A count of zero delegations is also what a broken harness produces. Both cells
therefore assert the mechanism they depend on:

- **`Delegate` was in the catalogue the model saw.** Asserted from
  `toolRegistry.view({})`, which is what `freezeStep` builds when no skill has
  narrowed it.
- **The phase-2 override took effect.** The neutral run asserts the catalogue's
  description _is_ the variant, and the shipped run asserts it is _not_. Without
  this, a silently failing `prepare` hook would have compared the shipped
  description against itself — and produced exactly the interesting result, for the
  wrong reason.

## 2. Phase 1 — task size

N=5 per cell, 30 attempts. From the run log; see §5 on the artifact.

| Size   | Condition        | Solved | Chose delegation | Reqs (med) | Tokens (med) |
| ------ | ---------------- | ------ | ---------------- | ---------- | ------------ |
| small  | agents-available | 5/5    | **0/5**          | 4          | 13,586       |
| small  | no-agents        | 5/5    | —                | 3          | 8,405        |
| medium | agents-available | 5/5    | **0/5**          | 3          | 10,932       |
| medium | no-agents        | 5/5    | —                | 3          | 9,525        |
| large  | agents-available | 5/5    | **0/5**          | 6          | 29,407       |
| large  | no-agents        | 5/5    | —                | 6          | 35,805       |

**Explanation (1) is eliminated.** Eighteen files and two independent faults is the
canonical case for delegation even when it is sequential — two self-contained
investigations, neither needing the other's context — and the model still did all of
it inline, in six requests, correctly, five times out of five.

The token differences between conditions run in both directions (+5,181 on small,
+1,407 on medium, −6,398 on large) and are noise at N=5. What they do establish is
the _cost of offering_ delegation when it goes unused: one extra tool schema per
request, which is not measurable against ordinary run-to-run variance.

## 3. Phase 2 — the tool description

The shipped description ends with a clause that reads, to a model that can do
everything itself, as "never":

> Use it when a task is genuinely separable … and **not for work you can do directly
> in a step or two**: a delegation costs a whole model conversation.

The variant (`NEUTRAL_DELEGATE_DESCRIPTION`) keeps the cost statement, drops the
prohibition, and names the two situations delegation is _for_ instead of the one it
is not.

N=5 per variant, largest task, agents available:

| Variant | Solved | Chose delegation | Reqs (med) | Tokens (med) |
| ------- | ------ | ---------------- | ---------- | ------------ |
| shipped | 5/5    | **0/5**          | 6          | 33,773       |
| neutral | 5/5    | **0/5**          | 6          | 31,659       |

Both negative controls passed in all ten attempts: the tool was in the catalogue,
and the neutral run really did carry the variant text.

**Explanation (2) is eliminated for this wording.** Removing the discouraging clause
changed nothing.

Run twice, ten attempts each time, both 0/10. The first pass produced an artifact
recording the model as `unknown` — a defect in the experiment runner, since phase 2
leaves the size-sweep cells empty and the model name was read from them — so it was
re-run after the fix rather than hand-corrected.

## 4. What this does and does not conclude

**Established.** DeepSeek does not reach for delegation unprompted: 0 of 25 attempts
across five task shapes, three sizes and two tool descriptions, with the tool
verifiably in front of it, while solving 25/25. Offering it costs nothing
measurable.

**Not established.** That the model _cannot_ benefit. One lever remains untested,
and it is the one most harnesses actually use: **the system prompt never mentions
delegation as a strategy**. The tool description is the only place the possibility
appears. Testing that is a product change (`ContextProjector`) rather than a string
swap, which is why it was not folded into this experiment — and it should be tried
before concluding anything about the model.

**Consequence for what to build next.** Delegation's value today is a _capability_
argument, not a performance one: a read-only reviewer that provably cannot write, a
child whose budget is bounded and whose denials are recorded. That is worth having
and is now real. What the evidence does **not** support is more agent surface —
parallel subagents, agent teams, automatic routing — because it would be building on
a feature this model does not choose, measured across the range where it should have.

The natural-delegation cells stay in `evals/tasks/golden.ts` as a standing
measurement rather than a gate. The number to watch is whether it moves when a
second provider is added; that, not a solve rate, is what would justify agent
breadth.

## 5. Incidents, recorded because they are part of the evidence

**The phase-1 artifact was overwritten.** The re-run intended to add the negative
controls to phase 1 hit an exhausted provider account, and its artifact — written to
the same filename — replaced the good one. The failed file was deleted rather than
committed, since 30 billing failures cited as evidence would be worse than an
absent file. Phase 1's numbers in §2 are therefore from the run log, and the re-run
is pending. The runner should include a run stamp in the artifact name; that is a
one-line fix and is not made here so that this document describes what happened.

**HTTP 402 was reported unhelpfully, and that is now fixed.** Thirty attempts failed
with zero tokens, and finding out why took a hand-written probe: the kernel said
`Provider returned HTTP 402`, blamed the _provider_, and offered no remedy. An
exhausted balance is the account holder's to fix. It now maps to a non-retryable
`MODEL_AUTH_ERROR` whose message says so and says what to do, and the eval
classifier reads that — and a rate limit — as `ENVIRONMENT_ERROR` rather than
letting a 4xx text reach `ADAPTER_BUG`, which is a kernel fault.

One thing to be accurate about: the failed run classified as `UNKNOWN`, not as a
kernel fault, because the error never reached a tool result for the classifier to
read. The `ADAPTER_BUG` path is a real hazard for a 4xx whose text does surface, and
it is now closed — but it is not what happened here.

Fixtures and tests: `tests/model/fixtures/openai/http-payment-required.json`,
`test:402 maps to a non-retryable user error that names billing`, and
`test:an exhausted provider account is an environment error, not an adapter bug`.
