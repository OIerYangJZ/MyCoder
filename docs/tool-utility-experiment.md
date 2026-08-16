# Do the new file tools pay? — the §B measurement

**Status:** complete, artifact-backed, and it found and fixed a defect in the tools it was measuring.
**Model:** DeepSeek `deepseek-chat` over `openai-chat`.
**Runner:** `pnpm eval:tool-utility` — `evals/experiments/tool-utility.ts`.

alpha.6 closed with a stated gap: security had 1,050 tests and four evidence
documents, and the tool surface had two dogfoods and **zero usability metrics**.
"Zero tool defects across every dogfood" was true and unfalsifiable — the surface
was small enough that it read as _little to go wrong_ rather than _proven_.

This is the first measurement of the tool surface as a surface. It asks one
question with a control, and it answers a second one it was not designed to ask.

## 1. Design

Three tasks × two arms × N=5, live.

| Arm               | Catalogue                                          |
| ----------------- | -------------------------------------------------- |
| `tools-available` | the shipped catalogue, including Write/Delete/Move |
| `tools-withheld`  | the same, with those three **unregistered**        |

The control is a model that _cannot see_ the tools, not one told to avoid them —
`ToolRegistry.unregister`, mirroring the delegation experiment, where the control
was a workspace with no agents and therefore no `Delegate`. Each arm asserts its
own premise from `session.effectiveAllowedTools` before the turn runs, because a
`prepare` that silently failed would compare an arm against itself and produce a
beautifully clean null result.

The tasks are ordinary work whose natural solution uses a new tool: regenerate a
generated file, delete a dead module and its import, rename a module file and fix
the import. All three are **solvable either way** — the withheld arm's scripted
trajectory does them with `Edit`, `Shell rm` and `Shell mv`, which is what the
pre-ADR-0016 kernel forced — so the comparison is between two possible paths, not
between possible and impossible.

Checks are outcomes only: file contents, what is gone, what the code says. No
check asserts that a particular tool was used; that would answer the question by
assuming it.

## 2. The metric that was missing

`toolCalls: 14` cannot distinguish fourteen useful calls from seven useful ones
and seven rejections. The kernel recorded `tool.call` (with the name) and
`tool.result` (with `isError`) and **nothing that carried the error code**, so
"which tool wasted how many steps, and why" was unanswerable from a session log.

One event closes it — `tool.error { name, errorCode, durationMs }`, emitted from
the tool runtime's own record — and the runner aggregates the log into a friction
table:

```
Edit          20 calls   10 err   0 repeat  TOOL_INVALID_ARGS 10
```

`repeats` counts identical calls (same tool, same argument hash) issued more than
once: a rejection the model could not act on. The table is printed next to the
solve rate and never folded into it — a rejected call is not a failed task, and a
solve rate that hid ten of them would be the tool-side version of the single
number §24 exists to prevent.

## 3. First run — and the defect it exposed

`artifact: evals/results/experiments/tool-utility-deepseek-chat-5x-2026-08-15T11-06-08-419Z.json`

| Arm               | Solved | Used new tools | Reqs (med) | Tools (med) | Tokens (med) | Rejected calls |
| ----------------- | ------ | -------------- | ---------- | ----------- | ------------ | -------------- |
| `tools-available` | 15/15  | **14/15**      | 7          | 9           | 26,529       | **9.9%**       |
| `tools-withheld`  | 15/15  | 0/15           | 6          | 9           | 20,401       | 4.3%           |

Two things stand out, and the second is the interesting one.

**The model reaches for the tools.** 14 attempts out of 15, unprompted. That is
the opposite of the delegation result (0 out of 70) and worth stating plainly:
these tools did not need to be sold to the model.

**The arm with the tools was _worse_ at using `Edit`.** Ten rejections against
four. `EVAL_DUMP_ERRORS=1` gave the reason in one line, identically every time:

```
error: TOOL_INVALID_ARGS
Arguments for Edit did not match its schema: $.mode is required.
```

`Edit` required a `mode` discriminator. `Write` — shipped one day earlier, in the
same round — has no `mode`, takes `content`, and sits next to it in the
catalogue. The two argument shapes blurred, and every omission cost a step to a
schema rejection whose message named the missing field but not what to do
instead. **Adding a tool made a neighbouring tool harder to use**, which is
exactly the class of defect a per-tool friction table exists to surface and which
"12/12 tasks solved" would never show.

## 4. The fix, and the same experiment again

`mode` is now optional and inferred where the arguments are unambiguous —
`oldString` means replace, `content` means create — and refused with a message
naming `Write` where they are not. No change to the edit strategy: ADR-0006's
exact replace and its receipt discipline are untouched.

`artifact: evals/results/experiments/tool-utility-deepseek-chat-5x-2026-08-15T11-12-43-197Z.json`

| Arm               | Solved | Used new tools | Reqs (med) | Tools (med) | Tokens (med) | Rejected calls | `Edit` rejections |
| ----------------- | ------ | -------------- | ---------- | ----------- | ------------ | -------------- | ----------------- |
| `tools-available` | 15/15  | 12/15          | 5          | 8           | 18,549       | **3.7%**       | **0** (was 10)    |
| `tools-withheld`  | 15/15  | 0/15           | 6          | 8           | 20,104       | 1.8%           | 2 (was 4)         |

The unambiguous result is the count: **`Edit` went from 10 rejections in 20 calls
to 0 in 14**, and the withheld arm improved too (4→2), which is what a fix to a
shared defect should look like. Those are counts of an identified cause, not a
distribution.

The token and request medians moved in the same direction (26.5k → 18.5k on the
available arm), and they are **not** offered as evidence of the fix: at N=5 the
per-cell spread is wide enough that a 30% median shift is not separable from
run-to-run variance. The delegation experiment made the same distinction and it
holds here.

## 5. What this concludes

**Established: the model uses the tools, and they cost nothing in outcome.** Both
arms solved 15/15 in both runs. Whatever these tools are worth, they are not
worth a regression, and the model does not have to be told to reach for them.

**Established: they were not free at first.** The first run's `tools-available`
arm rejected 9.9% of its calls against the control's 4.3%, and the whole
difference was one required field. A tool surface is not the sum of its tools —
adding one changed how a neighbour was called — and that is now a measured
statement rather than a suspicion.

**Not established: that they save steps.** Median tool calls were 9 vs 9, then 8
vs 8. On fixtures this size the new tools are a _convenience_ — one call instead
of an exact-replace of an entire file, or a `Shell rm` under an exec approval —
and the honest reading is that their value is in what the approval _means_
(`file.delete` on a named path, not "run `rm`") rather than in step count. That
was ADR-0016's stated reason for existing, and this experiment neither confirms
nor refutes it; it only rules out the easy claim that they make tasks cheaper.

**Not established: anything about a second model.** Same limitation as the
delegation experiment, same remedy: the arms are one command.

## 6. A second defect, found by the fixture

The web task (`read-docs-then-fix`, golden set) fetches a documentation page from
a loopback fixture and fixes a call to match it. One attempt came back classified
`KERNEL_BUG` — a release-blocking class — on a run where the kernel had done
nothing wrong.
`artifact: evals/results/deepseek-deepseek-chat-2026-08-15T11-14-29-123Z.json`
(2/3, one false `KERNEL_BUG`), against
`artifact: evals/results/deepseek-deepseek-chat-2026-08-15T11-16-22-022Z.json`
(3/3 after the fix — and the first live evidence that a real model can drive
`WebFetch` at all: three fetches, zero rejections).

The cause: the classifier looks for `TypeError` in the transcript as a sign of a
runtime fault, and the fixture _page_ documents a `TypeError`. Once a tool can
pull third-party text into the transcript, **every heuristic over the transcript
is reading attacker-chosen input**. A page containing `INTERNAL_ERROR` could make
a release run report a kernel regression.

The fix is `stripUntrustedContent`: the classifier's corpus has the
`--- begin/end untrusted web content ---` blocks removed first. The boundary
`WebFetch` prints for the model's benefit turned out to be what made this
fixable, which is an argument for machine-recognisable markers over prose. The
fixture deliberately keeps the word `TypeError`, so the regression test is the
fixture itself:
`test:a page that names a kernel error does not produce a kernel fault`, with a
negative control asserting a real `TypeError` outside the block still classifies.

## 7. Cost

Two live runs of 30 attempts plus diagnostics: **under $0.15** and about 25
minutes of wall clock. The expensive part of this measurement was never the
model.
