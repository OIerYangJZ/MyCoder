# Does delegation pay? — the alpha.4 §36 experiment

**Status:** complete. All three phases artifact-backed.
**Model:** DeepSeek `deepseek-chat` over `openai-chat`.
**Runner:** `pnpm eval:delegation-utility` — `evals/experiments/delegation-utility.ts`.

alpha.4 shipped a delegation runtime and then measured that DeepSeek chose to use
it **0 times out of 10** on tasks where subagents were available and the choice was
left to it — solving all ten anyway. `docs/alpha4-status.md` §4 recorded that as an
open question with three candidate explanations:

1. the tasks were too small for delegation to pay;
2. the `Delegate` tool description suppresses its use;
3. nothing in the prompt ever introduced delegation as a _strategy_;
4. the model simply does not choose it.

This experiment tests the first three. All three are eliminated, which leaves the
fourth — and the fourth is not something a harness can fix.

## 1. Design

A 3×2 for (1), then a 1×2 for each of (2) and (3).

| Phase | Varies                                     | Held constant                                 |
| ----- | ------------------------------------------ | --------------------------------------------- |
| 1     | task size, agents present                  | prompt per size, tool description, model, N=5 |
| 2     | `Delegate` description                     | the largest task, agents present, model, N=5  |
| 3     | whether the system prompt names delegation | the largest task, agents present, model, N=5  |

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

N=5 per cell, 30 attempts.
`artifact: evals/results/experiments/delegation-utility-deepseek-chat-5x.json`

| Size   | Condition        | Solved | Chose delegation | Reqs (med) | Tokens (med) | Cost (med) |
| ------ | ---------------- | ------ | ---------------- | ---------- | ------------ | ---------- |
| small  | agents-available | 5/5    | **0/5**          | 3          | 9,538        | $0.0012    |
| small  | no-agents        | 5/5    | —                | 3          | 8,258        | $0.0010    |
| medium | agents-available | 5/5    | **0/5**          | 4          | 14,918       | $0.0015    |
| medium | no-agents        | 5/5    | —                | 3          | 9,486        | $0.0013    |
| large  | agents-available | 5/5    | **0/5**          | 6          | 33,850       | $0.0034    |
| large  | no-agents        | 5/5    | —                | 6          | 28,732       | $0.0035    |

Run twice, thirty attempts each time. The first pass agreed on everything that
matters (0/15, 30/30) and its artifact was lost to the incident in §5; the table
above is the second, which is the committed one.

**Explanation (1) is eliminated.** Eighteen files and two independent faults is the
canonical case for delegation even when it is sequential — two self-contained
investigations, neither needing the other's context — and the model still did all of
it inline, in six requests, correctly, five times out of five.

The token differences between conditions were mixed in the first pass (+5,181,
+1,407, −6,398) and uniformly positive in the second (+1,280, +5,432, +5,118), which
is what noise at N=5 looks like from two directions. What they do establish is that
the _cost of offering_ delegation when it goes unused — one extra tool schema per
request — is not separable from ordinary run-to-run variance at this sample size.

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

## 4. Phase 3 — does the system prompt have to say it?

A tool description introduces a _tool_. The remaining hypothesis was that a strategy
has to be introduced somewhere else — and nothing in the system prompt had ever
mentioned that delegation was an option. That is the lever most harnesses actually
use, so it was implemented as a product option rather than a test hook:
`[loop] delegation_guidance`, default on when the project defines agents, adding one
sentence to the "How this environment works" section.

N=5 per variant, largest task, agents available.
`artifact: evals/results/experiments/delegation-guidance-deepseek-chat-5x.json`

| Variant      | Solved | Chose delegation | Reqs (med) | Tokens (med) |
| ------------ | ------ | ---------------- | ---------- | ------------ |
| guidance-on  | 5/5    | **0/5**          | 5          | 26,141       |
| guidance-off | 5/5    | **0/5**          | 6          | 30,320       |

The negative control here matters more than in phase 2, because a flag that failed to
reach the prompt would look exactly like a model ignoring advice. Each arm reads the
_projection the model was given_ and asserts the sentence is present or absent
accordingly. Both arms passed in all ten attempts.

**Explanation (3) is eliminated.** Being told, in the system prompt, that subagents
exist and when they help did not produce a single delegation.

## 5. What this does and does not conclude

**Established: this is not a prompting problem.** Counting alpha.4's own natural
delegation eval, DeepSeek was offered a verified `Delegate` tool **70 times** across
five task shapes, three sizes, two tool descriptions and two prompt conditions, and
chose it **zero times** — while solving every attempt. Every lever available to the
harness has been pulled.

**Not established: that delegation has no value.** Two things the experiment cannot
see:

- **Other models.** The obvious remaining variable is the model itself, and it is the
  only one left. This is a reversal of what `docs/alpha4-status.md` §7 argued: it said
  a second provider would buy little because there was no delegation behaviour to
  compare against. That is exactly backwards now — with every harness-side
  explanation eliminated, a second provider is the _only_ way left to learn whether
  the delegation runtime pays for itself.
- **Tasks larger than one context.** Every fixture here fits comfortably in
  DeepSeek's 64k window, so the model never had to delegate. The case delegation is
  ultimately for — work that cannot fit at all — is not represented, and building it
  as a fixture is a bigger job than this experiment was.

**What it means for the runtime that exists.** Delegation's demonstrated value today
is a _capability_ argument, not a performance one: a reviewer that provably cannot
write, a child whose budget is bounded and whose denials are recorded, an approval
prompt that names the agent that asked. All of that is real, tested, and useful to
someone who wants a narrower scope for a piece of work — and none of it depends on
the model preferring it.

What the evidence does **not** support is more agent surface: parallel subagents,
agent teams, automatic routing. Each would be building on a choice this model does
not make, measured across the whole range where it should have.

**Why the guidance line ships anyway.** It costs 91 tokens, about 1.7% of the large
task, and did nothing measurable for the one model validated here. It stays on by
default for two reasons — it is the standard mechanism and other models may respond
to it, and the A/B is now built so re-testing it against a second provider is one
command. That is a judgement call, and the evidence behind it is "no effect for one
model", not "no effect". `[loop] delegation_guidance = false` turns it off without
touching the tool.

The natural-delegation cells stay in `evals/tasks/golden.ts` as a standing
measurement rather than a gate. The number to watch is whether it moves when a
second provider is added; that, not a solve rate, is what would justify agent
breadth.

## 6. Incidents, recorded because they are part of the evidence

**The phase-1 artifact was overwritten, then regenerated.** The re-run intended to add
the negative controls to phase 1 hit an exhausted provider account, and its artifact —
written to the same filename — replaced the good one. The failed file was deleted
rather than committed, since 30 billing failures cited as evidence would be worse than
an absent file, and phase 1 was re-run once the account was topped up. The artifact
name still has no run stamp, so the same overwrite is still possible; the fix is one
line and is left undone deliberately, so that this document describes the hazard
rather than implying it was designed away.

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
