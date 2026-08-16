# Does having undo change what the model does? (alpha.10 §17)

**Date:** 2026-08-16 · **Status:** measurement, not a gate
**Runner:** `evals/experiments/undo-utility.ts`, fixtures in
`evals/experiments/undo-utility-fixtures.ts`
**Artifacts:**
`evals/results/experiments/undo-utility-deepseek-chat-3x-2026-08-16T13-56-10-578Z.json`,
`evals/results/experiments/undo-utility-gpt-5.6-terra-3x-2026-08-16T14-07-00-985Z.json`

Three tasks × two arms × N=3, on two models, side by side and never averaged
(alpha.8 §20–§23). The arms differ by exactly one thing: whether `Undo` is in the
catalogue the model is shown. `ToolRegistry.unregister` removes it outright in the
control arm, and each arm asserts its own premise against the frozen catalogue
before the turn runs.

## The models

- **Model 1 — `deepseek-chat`** (DeepSeek, `openai-chat` protocol).
- **Model 2 — `gpt-5.6-terra`** through the relay at `api1.aisz.mom`
  (`openai-chat`). A relay, not OpenAI, and this document says so every time it
  is mentioned.

## The headline

```text
                              model 1 (deepseek-chat)    model 2 (gpt-5.6-terra, relay)
Undo called, where available        0 / 9                        0 / 9
solved, undo available              9 / 9                        9 / 9
solved, undo withheld               9 / 9                        9 / 9
median tool calls   avail / with    5 / 6                        5 / 5
median requests     avail / with    4 / 4                        5 / 5
median tokens       avail / with    14,595 / 14,670              13,878 / 12,852
rejected-call ratio avail / with    0.0% / 0.0%                  2.0% / 4.0%
```

**Neither model called `Undo` once, in eighteen attempts.** That is the same
shape of result as alpha.9's foreign-tool measurement, and the same caveat
applies with more force — see the limitation below, which is the most important
paragraph in this document.

## What §17 asked, and what came back

§17's worry was specific:

> Undo is a tool with an unusually inviting description, and a model that undoes
> its way out of a difficulty instead of reading the error is a real failure mode
> worth measuring before it is anecdote.

**Not observed.** In eighteen attempts across two models, no reversal was
attempted, including in the two tasks built to create a difficulty.

**And the fixture is why that is weak evidence.** `recover-from-a-stale-receipt`
was designed so the model would read a file, run a script that rewrites it, and
then meet `STALE_FILE` on its edit. Both models read the file _after_ running the
script, so the stale receipt never happened: the rejected-call ratio for that
task is 0% on model 1 and the one rejection on model 2 is a `TOOL_INVALID_ARGS`
on `Grep`. The difficulty the experiment exists to observe was avoided rather
than resisted.

So the honest statement is:

> Two models, given a tool whose description invites reversal, did not reach for
> it on three ordinary tasks — and the tasks did not put them in the position
> where the temptation would have been strongest, because both models sequenced
> their reads well enough to avoid it. This measures a tool that was not needed,
> not a tool that was declined under pressure.

A fixture that reliably produces the difficulty would need the workspace to
change _between_ the model's read and its edit without the model having caused
it — a background writer rather than a shell command the model schedules. That is
a harness change, and it is named here as the next version of this experiment
rather than claimed as done.

## The alpha.7 friction finding does not reproduce for this tool

alpha.7 found that adding a tool makes a _different_ tool harder to call, and
alpha.9 reproduced it on both models with an MCP server attached (builtin wasted
calls 7.89 vs 5.00 on model 1, 6.35 vs 5.17 on model 2).

Here the direction is flat on model 1 (0.0% vs 0.0%) and **inverted** on model 2
(2.0% with `Undo` present vs 4.0% without). Two readings, and only the second is
supportable:

1. `Undo` is cheap to carry because its schema is small and its purpose is
   orthogonal to the others. Plausible, and not shown by this data.
2. **The difference is noise.** Model 2's arms differ by one rejected call
   against fifty-odd calls. At N=3 that is not a measurement of anything.

The result to record is therefore the null one: **no friction cost from `Undo`
was detected on either model, and this experiment could not have detected a small
one.**

## Solve rate

9/9 in every arm on both models. The tasks are solvable without `Undo` by
construction — the withheld arm's scripted trajectory proves it — so this
confirms the experiment is comparing two possible worlds rather than a possible
one with an impossible one. It says nothing about whether `Undo` helps.

## What this does not support

- Any claim that `Undo` is safe from the loop failure mode. It was not exercised.
  The _structural_ guard against it — a model-issued `Undo` cannot reverse a
  reversal, and is capped at the current turn — is tested in
  `tests/integration/undo.test.ts`, which is a different kind of evidence and the
  one the guarantee rests on.
- Any claim about `Undo`'s effect on a long session. Every task here is a single
  turn.
- Any per-model comparison. Same fixtures, same N, reported side by side; the two
  columns are not to be subtracted.
- Cost. Model 1's three-run total was about $0.011. Model 2 runs through a relay
  with no configured pricing, so its `costUsd` is `0` — **absent, not free**
  (alpha.4 §18: never a fabricated figure).

## Reproducing

```bash
node evals/experiments/undo-utility.ts --scripted            # harness, no model
KERNEL_LIVE_MODEL=deepseek node evals/experiments/undo-utility.ts --runs=3
MYCODER_CONFIG_DIR=/tmp/x2cfg KERNEL_LIVE_MODEL=relay \
  node evals/experiments/undo-utility.ts --runs=3
```

The second config directory is a copy of the user's with `api_key_file` paths
made absolute; the eval runner reads the real config directory, so redirecting it
avoids editing the user's file.
