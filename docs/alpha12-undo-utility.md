# CLOSURE C — a refusal that costs more

**Date:** 2026-08-17 · **Milestone:** `v0.1.0-alpha.12` · **Question:** alpha.10 §17, third asking

alpha.11 asked whether a model reaches for `Undo` instead of reading the error it
was handed, under a difficulty it could not have caused. The answer was a clean
negative: 12 of 12 attempts met the difficulty, `Undo` was called 0/18, and every
attempt recovered by re-reading. Its own write-up named what that could not settle:

> A refusal that destroys more work — a failed multi-file edit, a half-applied
> rename — is a different and more tempting situation, and it has not been tested.

That is this. The refusal now arrives **after two edits have already landed**, so
the workspace is in a state that never existed in the repository, and reversing
looks like the tidy answer.

---

## 1. The result

```text
48 live attempts · two models · four tasks · two arms · N=3
Undo available in 24 of them, and called in 0.
```

| Model           | Arm            | Solved | `Undo` called | Median tools | Median tokens | Rejected |
| --------------- | -------------- | ------ | ------------- | ------------ | ------------- | -------- |
| `deepseek-chat` | undo-available | 12/12  | **0/12**      | 6            | 19,576        | 9.3%     |
| `deepseek-chat` | undo-withheld  | 12/12  | —             | 4.5          | 16,065        | 9.6%     |
| `gpt-5.6-terra` | undo-available | 12/12  | **0/12**      | 7            | 15,609        | 6.5%     |
| `gpt-5.6-terra` | undo-withheld  | 12/12  | —             | 6.5          | 14,754        | 6.3%     |

And the task this milestone exists for, on its own:

| Task                                 | Model           | Arm            | Solved | `Undo` | Stale refusals |
| ------------------------------------ | --------------- | -------------- | ------ | ------ | -------------- |
| `finish-a-rename-that-broke-halfway` | `deepseek-chat` | undo-available | 3/3    | 0/3    | 3              |
| `finish-a-rename-that-broke-halfway` | `deepseek-chat` | undo-withheld  | 3/3    | —      | 3              |
| `finish-a-rename-that-broke-halfway` | `gpt-5.6-terra` | undo-available | 3/3    | 0/3    | 3              |
| `finish-a-rename-that-broke-halfway` | `gpt-5.6-terra` | undo-withheld  | 3/3    | —      | 3              |

**The premise held in every counted attempt**: the refusal arrived with two edits
already applied, asserted per attempt rather than assumed, and every attempt
finished by re-reading the third file and completing the rename. Neither model
touched `Undo` — not in the task where two correct edits were sitting on disk, and
not in the three tasks around it.

Artifacts:

```text
evals/results/experiments/undo-utility-deepseek-chat-3x-2026-08-17T09-54-22-074Z.json
evals/results/experiments/undo-utility-gpt-5.6-terra-3x-2026-08-17T10-12-33-460Z.json
```

## 2. What this does and does not establish

**Establishes:** with work already on disk and a refusal in hand, two models on two
protocols chose to re-read and finish, 24 times out of 24. The failure mode §17 was
written about — undoing your way out of a difficulty instead of reading the error —
did not occur even when the situation was built to invite it.

**Does not establish** that it never happens. N=3 per cell on two models is not a
distribution, the prompt tells the model to read the error if a call is refused —
carried unchanged from alpha.11 so the arms stay comparable — and both models are
recent frontier-class ones. A weaker model, a longer set, or a set whose earlier
edits were themselves wrong might all behave differently.

**And it is not a fact about `Undo` being unnecessary.** The tool exists for the
mistake a model makes and _does_ notice, which is a different situation from a
refusal it has just been handed. Nothing here measures that.

## 3. The seam, and the flaw the first live run found

The fixture is `evals/experiments/interference.ts`, unchanged in kind since
alpha.11: it changes a file underneath the model, unprovoked, between a read and an
edit. alpha.12 adds one parameter — `armAfterMutations` — so the trap holds off
until enough work has landed to be worth losing.

**Version 1 of that was wrong, and the first live run is what said so.**

```text
v1: arm on the read, once two mutations have landed
    deepseek-chat, N=3: 0/6 attempts produced the difficulty
```

Three attempts hit "the file was never changed underneath the model" and three hit
"the file changed once but nothing was refused". The cause is ordinary: a model that
reads `one.ts`, `two.ts` and `three.ts` **before** editing any of them has its
receipt for the target issued while the trap is still holding off — so the third
edit applied cleanly and the attempt measured nothing. The model was not evading
anything; it was batching its reads.

The repair is a **second trigger**: the file also changes the moment the threshold
is crossed, which invalidates a receipt that already exists. Between the two
triggers the condition no longer depends on the order the model happens to work in,
and `tests/evals/interference.test.ts` asserts both orderings —
`a model that reads everything before editing anything is still caught` is the
regression for exactly this.

`fixtureVersion` went to 2 for that task, so v1's numbers cannot be compared with
v2's. The v1 artifact is kept and cited, because a fixture that could not produce
its own condition is the defect alpha.11 spent a closure fixing, and finding it
again in a _new_ fixture — within an hour, from a live run rather than an argument —
is the most useful thing in this document:

```text
evals/results/experiments/undo-utility-deepseek-chat-3x-2026-08-17T09-48-19-530Z.json
```

**Note what caught it.** Not the scripted smoke test, which passed both versions:
the scripted trajectory reads and edits one file at a time, which is precisely the
ordering v1 could handle. A harness check that only ever sees its own idealised
trajectory validates the harness against itself.

## 4. Why the numbers are not compared with alpha.11's

The three tasks carried from alpha.11 are unchanged, at `fixtureVersion: 2`, and
their numbers are comparable. This milestone's task is new and its own version was
bumped mid-milestone. So:

```text
comparable    the three alpha.11 tasks, alpha.11 → alpha.12
NOT           the halfway-rename task, v1 → v2
NOT           anything against alpha.10, whose fixtures were version 1
```

The arm differences — 6 vs 4.5 median tool calls on `deepseek-chat`, 7 vs 6.5 on
`gpt-5.6-terra` — point the same way on both models this time, where alpha.11 found
them pointing in opposite directions. That is **reported, not claimed**: N=3 cannot
resolve a difference of one or two calls, and the withheld arm having one fewer tool
in its catalogue is a sufficient explanation on its own.

## 5. What was not done

```text
a third model                    two is what the credentials cover
N > 3                            the question was whether it happens at all,
                                 and a zero at N=3 across two models is the
                                 answer this milestone can afford
a set whose earlier edits were   a genuinely different experiment: it asks
themselves wrong                 whether the model can tell a bad edit from a
                                 stale receipt, which is worth doing and is not
                                 this
```

## Model provenance

Two models, both through the `openai-chat` protocol: `deepseek-chat` (DeepSeek,
direct) and `gpt-5.6-terra` (through the relay endpoint configured in the user's
own config). N=3 per cell, 4 tasks × 2 arms = 24 attempts each, 48 total. Every
number in §1 comes from the two artifacts named there; nothing in this document is
an estimate, and the cost figures those artifacts carry stay labelled `estimated`
for the reason `docs/open-evidence.md` A5 gives.
