# Does a foreign tool surface pay? — alpha.9 §17, §18

**Experiment:** `evals/experiments/mcp-utility.ts`
**Fixtures:** `evals/experiments/mcp-utility-fixtures.ts`
**Design:** 3 golden tasks × 2 arms × N=3, two models, reported side by side.

## The question

Not "does MCP work" — the regression matrix answers that. The question §17 names:

> Does a foreign tool surface make the model **better, worse, or merely busier**?

alpha.7 already found that adding a tool can make a **different** tool harder to
call, so the headline number here is deliberately not the foreign tools' own
friction. It is `builtinWasted`: the fraction of calls to _the kernel's own_
tools that were rejected, measured separately in each arm. If that rises when a
server is attached, the cost of MCP is not paid by MCP.

The arms differ by exactly one thing — whether a stdio MCP server is attached —
and each arm asserts its own premise before the turn runs, because a `prepare`
that silently failed would compare the control against itself and produce a
beautifully clean null result.

## Results, side by side, never averaged

|                               | **Model 1 — `deepseek-chat`** |               | **Model 2 — `gpt-5.6-terra`** |               |
| ----------------------------- | ----------------------------- | ------------- | ----------------------------- | ------------- |
|                               | server attached               | server absent | server attached               | server absent |
| solved                        | 9/9                           | 8/9           | 9/9                           | 9/9           |
| attempts using a foreign tool | **0**                         | 0             | **0**                         | 0             |
| builtin wasted-call ratio     | **7.89%**                     | 5.00%         | **6.35%**                     | 5.17%         |

Artifacts:

- `evals/results/experiments/mcp-utility-deepseek-3x-2026-08-16T09-58-54-218Z.json`
- `evals/results/experiments/mcp-utility-relay-3x-2026-08-16T10-09-49-762Z.json`

Model provenance: **Model 1** is `deepseek-chat` (DeepSeek, `openai-chat`).
**Model 2** is `gpt-5.6-terra` served through the relay at `api1.aisz.mom`
(`openai-chat`) — a relay, and this document says so again, as alpha.8 §23
requires. Same fixtures, same prompts, same N, no per-model tuning.

## What this supports

**Neither model called the foreign tool, once, in eighteen attempts.** Zero is a
real answer — alpha.4's "0 of 25 delegations" is the standing proof of that — and
here it is the _expected_ one, for a reason stated in the next section.

**Both models spent more calls on the kernel's own tools when a server was
attached.** 7.89% against 5.00% on model 1; 6.35% against 5.17% on model 2. The
direction is the same on both, and it is alpha.7's finding again: a bigger
catalogue makes the tools that were already there slightly harder to call.

**And that is the part worth keeping**, because it is where this differs from
alpha.4. The delegation finding did not replicate across models — 0 of 25 on one,
10 of 15 on another — which is why §18 exists at all. This one does replicate, in
direction, on both. A single-model version of this write-up would have been worth
much less, and would have looked identical.

## What this does NOT support

**Not "MCP tools are useless".** The fixture server offers `echo`, which is not
useful for a bug fix, a test-driven fix or a rename. Zero uses is therefore
partly _by construction_, and the honest reading is narrower: this measures what
an **irrelevant** foreign tool costs — catalogue noise — not whether a model
would reach for a relevant one. A server offering something the task needs is a
different experiment and has not been run.

**Not a significant difference.** N=3 per cell, 18 attempts per model, and the
ratios differ by two to three percentage points on denominators in the dozens.
That is suggestive and it is consistent across two models; it is not significant,
and no arithmetic in this document makes it so.

**Not a solve-rate claim.** 8/9 against 9/9 on model 1 is one attempt, and the
arm that "lost" is the one _without_ the server. Reporting it as "MCP improves
solve rate" would be reading noise in the flattering direction.

## Why the numbers are what they are

The mechanism behind the friction rise is not mysterious and is worth naming so a
future reader does not have to re-derive it: every attached tool adds a labelled,
untrusted description to the catalogue the model sees each step, and ADR-0024's
label is deliberately verbose. More catalogue is more to choose from, and the
observed cost lands on the tools that were already there.

That cost is the price of the honesty, not an accident of it. A shorter label
would measure better and say less.

## What would change the conclusion

- A server whose tools are **relevant** to the tasks. Then "0 uses" becomes a
  finding about model behaviour rather than about fixture design.
- N large enough to separate 5% from 8%. At these denominators that is a much
  bigger run than three.
- A third-party server, which is §5's dogfood and has not been run.
