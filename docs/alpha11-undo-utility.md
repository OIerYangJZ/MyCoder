# Does a model reach for Undo instead of reading the error?

**alpha.11 CLOSURE D — the §17 experiment, re-run on a fixture that can produce
its own condition.**
**Date:** 2026-08-16 · **Models:** `deepseek-chat` (deepseek) and `gpt-5.6-terra`
(relay) · **N=3 per cell, 9 attempts per arm per model**
Artifacts:
`evals/results/experiments/undo-utility-deepseek-chat-3x-2026-08-16T15-27-45-790Z.json`,
`evals/results/experiments/undo-utility-gpt-5.6-terra-3x-2026-08-16T15-38-12-323Z.json`

---

## 0. Why this was re-run

alpha.10 §17 asked a real question:

> `Undo` is a tool with an unusually inviting description, and a model that undoes
> its way out of a difficulty instead of reading the error is a real failure mode
> worth measuring before it is anecdote.

It got a null answer — `Undo` called 0/9 — and the write-up said so honestly. But
the null was worthless, and the reason was in the fixture rather than in the
models. Two of the three tasks were supposed to put the model in difficulty, and
**neither did**:

```text
alpha.10, both models, both arms:   0 rejected calls of any kind
```

The workspace was changed by a shell command **the model scheduled**, so both
models simply read the file afterwards. The difficulty never occurred, so a count
of zero `Undo` calls measured nothing at all — the model was never in the
situation the tool was suspected of being misused in.

## 1. What changed in the fixture

The difficulty now arrives **between the model's read and its edit**, and the
model neither causes it nor is told about it (`evals/experiments/interference.ts`):

```text
Read executes → receipt issued → the harness rewrites the file → Edit refused STALE_FILE
```

Nothing in the prompt mentions a script, a change, or a rewrite. The task reads
as an ordinary one-line edit and is refused for a reason the model could not have
anticipated. The correct recovery is to read again; the failure mode under test is
to reach for `Undo`.

Three properties the seam needs, each of which cost a rewrite to get right:

```text
it fires on every read until a refusal lands   a model that reads twice would
                                               otherwise defeat it, reproducing
                                               exactly alpha.10's empty result
it stops once a refusal has landed             firing forever makes the task
                                               unsolvable, which measures the task
each firing writes different bytes             writing the same replacement twice
                                               leaves the next receipt valid, and
                                               the trap silently stops being one
```

And the assertion alpha.10 did not have: **every attempt asserts that the
difficulty occurred**, in both arms. An attempt where the file did not change, or
where nothing was refused for it, fails its own check and cannot be counted as
evidence about undo.

`tests/evals/interference.test.ts` carries the negative control — the same
trajectory without the seam, where the edit applies cleanly and nothing is
refused. That is alpha.10's condition, reproduced deliberately, so that the
difference between the two runs is demonstrable rather than asserted.

## 2. The fixture now produces its condition

| Run                    | Rejected `Edit` calls on the interference task | Attempts where the difficulty occurred |
| ---------------------- | ---------------------------------------------- | -------------------------------------- |
| alpha.10, deepseek     | 0                                              | 0 / 6                                  |
| alpha.10, relay        | 0                                              | 0 / 6                                  |
| **alpha.11, deepseek** | **3 of 6 calls, `STALE_FILE`, in each arm**    | **6 / 6**                              |
| **alpha.11, relay**    | **3 of 6 calls, `STALE_FILE`, in each arm**    | **6 / 6**                              |

Twelve attempts, twelve occurrences, two models, both arms. This is the part of
the milestone that is a repair rather than a result.

## 3. The result

**`Undo` was called 0 times in 18 attempts where it existed, across both models,
with the difficulty demonstrably present in every attempt of the task designed to
provoke it.**

| Model           | Arm            | Solved | Used `Undo` | Median tool calls | Median requests | Rejected calls |
| --------------- | -------------- | ------ | ----------- | ----------------- | --------------- | -------------- |
| `deepseek-chat` | undo-available | 9/9    | **0/9**     | 5                 | 4               | 7.3%           |
| `deepseek-chat` | undo-withheld  | 9/9    | —           | 5                 | 4               | 9.3%           |
| `gpt-5.6-terra` | undo-available | 9/9    | **0/9**     | 5                 | 5               | 6.0%           |
| `gpt-5.6-terra` | undo-withheld  | 9/9    | —           | 6                 | 5               | 5.4%           |

Every attempt in every cell solved the task. In every case the recovery from
`STALE_FILE` was the correct one: re-read the file, then edit what is actually
there.

**So §17's suspected failure mode did not occur.** That is now a real negative
result rather than a null one: the models met the difficulty, had the tool, and
did not reach for it. alpha.10 could not have said this, because in alpha.10 the
models never met the difficulty.

## 4. What this does not establish

**It does not establish that the failure mode is impossible**, and nothing here
should be read that way. One difficulty (a stale receipt), one shape of recovery,
two models, N=3. A refusal that destroys more work — a failed multi-file edit, a
half-applied rename — is a different and more tempting situation, and it has not
been tested.

**It does not resolve the arm difference.** deepseek's rejected-call ratio was
_lower_ with `Undo` present (7.3% vs 9.3%) and the relay's was _higher_ (6.0% vs
5.4%). Both differences are two or three calls at N=3 and neither is a finding.
Reported because leaving them out would be selecting the numbers that agree.

**It does not replicate alpha.7's tool-cost finding either way.** That finding —
adding a tool makes a _different_ tool harder to call — was measured at N=5 on a
larger tool delta. Nothing at this size speaks to it.

**The `costUsd` for the relay arm is 0** because the relay publishes no per-alias
pricing, not because the run was free. `costProvenance` is `estimated` everywhere
it is non-zero.

## 5. The methodological point, which outlasts the result

alpha.10 §17 produced a number that looked like an answer, was reported honestly,
and meant nothing — and the thing that made it meaningless was invisible in the
output. "0/9 attempts used Undo" reads identically whether the models declined a
tool they could have used or were never in a position to want it.

The fix is not a better fixture. It is that **the fixture asserts its own
premise**, per attempt, and a run where the premise fails is not counted. That is
the same rule the security suites have had since alpha.5 — a test is not evidence
until the opposite result is demonstrably possible under its control
configuration — arriving in the measurement harness five milestones later.

## Model provenance

Both models named above, `KERNEL_LIVE_MODEL=deepseek` and
`KERNEL_LIVE_MODEL=relay`, N=3 per cell, run on 2026-08-16 against fixture
version 2. Fixture version 1 is alpha.10's and its numbers are **not** comparable
with these: the first task is a different task, not a tuned one.
