# Cross-model validation (alpha.8 §19–§23)

Every behavioural number this project has published came from **one** model. This
document is what happened when a second one ran the same suites.

## The two models

|                | Model 1                                 | Model 2                       |
| -------------- | --------------------------------------- | ----------------------------- |
| Model          | `deepseek-chat`                         | `gpt-5.6-terra`               |
| Endpoint       | `api.deepseek.com` (first-party)        | `api1.aisz.mom` (**a relay**) |
| Protocol       | `openai-chat`                           | `openai-chat`                 |
| Configured via | user config only                        | user config only              |
| Role           | every alpha.2–alpha.7 behavioural claim | the replication attempt       |

**Provenance caveat, stated once and meant.** Model 2 is reached through a relay,
not a first-party endpoint. That is a caveat on _provenance_ — we cannot prove
which weights served the request — and not on the result: whatever answered
behaved measurably differently from model 1 on the same fixtures, which is the
question §20 asks. It is recorded here rather than buried because a reader
deciding how much weight to give these numbers needs it.

The first choice was OpenAI directly. It returned `insufficient_quota` — the
account has no credit — which is an **`ENVIRONMENT_ERROR`** under §23's taxonomy:
the account's, not ours and not the model's. It did produce a finding anyway; see
"What model 2 found before it ran" below.

## §21 fairness, as executed

```text
same fixtures          the files in evals/experiments/*-fixtures.ts, unchanged
same prompts           byte-identical; no per-model tuning of any kind
same N                 5 per cell, as model 1
same arms              the control arm is a model that cannot see the tool /
                       the agents, via ToolRegistry.unregister and an empty
                       agent set — not a model choosing not to use them
adapter differences    none. Both models speak openai-chat through the same
                       adapter, so no plumbing difference has to be recorded.
profile differences    context_window 65536 vs 128000, max_output 8192 vs 8192.
                       Recorded because it is a real difference; neither run came
                       close to either ceiling.
```

---

## 1. Delegation utility — **the claim does not replicate**

This is the headline result, and it corrects the record.

alpha.4 concluded that the model never chose to delegate: **0 of 25** attempts,
and **0 of 70** after the system-prompt guidance lever was pulled. `docs/alpha4-status.md`
treats that as a finding about delegation. It is a finding about **one model**.

| Task shape                                                  | Model 1 delegated | Model 2 delegated       | Solve rate (M1 / M2) |
| ----------------------------------------------------------- | ----------------- | ----------------------- | -------------------- |
| **small** — one file, one line; delegation should _not_ pay | 0/5               | **0/5**                 | 5/5 / 5/5            |
| **medium** — six files, one root cause three deep           | 0/5               | **5/5**                 | 5/5 / 5/5            |
| **large** — eighteen files, two independent faults          | 0/5               | **5/5** (8 delegations) | 5/5 / 5/5            |

Model 2 delegated in **10 of 15** attempts where it was available, and — this is
the part that matters — **declined on the small task**, which is the one where
delegating would have been waste. It is not delegating indiscriminately. It is
discriminating by task shape, which is precisely the behaviour alpha.4 concluded
was absent.

**What replicates, and what does not:**

- **Does not replicate:** "the model does not choose delegation". That was
  single-model, and it is now known to be.
- **Replicates:** "delegation did not pay". Solve rate is 5/5 in _both_ arms on
  _both_ models — delegation never fixed something the direct path failed — and
  on model 2 it costs more: +10,058 median tokens on medium, +12,583 on large,
  for no additional solve. alpha.4's _utility_ conclusion survives its
  behavioural premise being wrong.

The honest restatement, which now belongs in the record:

> Delegation was measured on two models. One never chose it; the other chose it
> for the task shapes it was designed for and declined for the one it was not. On
> neither model did choosing it improve the solve rate, and on the model that did
> choose it, it cost 50–100% more tokens.

Artifacts: `evals/results/experiments/delegation-utility-deepseek-chat-5x.json`,
`evals/results/experiments/delegation-utility-gpt-5.6-terra-5x-2026-08-16T05-06-16-979Z.json`.

---

## 2. Tool utility — **the claim replicates, and strengthens**

|                                          | Model 1     | Model 2     |
| ---------------------------------------- | ----------- | ----------- |
| solved, tools available                  | 15/15       | 15/15       |
| solved, tools withheld                   | 15/15       | 15/15       |
| attempts that used the new tools         | 12/15       | **15/15**   |
| median tool calls (available / withheld) | 8 / 8       | 9 / 10      |
| wasted-call ratio (available / withheld) | 3.7% / 1.8% | 2.3% / 0.7% |
| `Edit` rejections, tools-available arm   | 0           | 0           |

- **"The new tools get used when they exist" replicates**, and more strongly:
  15/15 versus 12/15.
- **"Neither arm fails" replicates.** Write/Delete/Move did not change _whether_
  either model solved these tasks — on model 2 the withheld arm needed one more
  median tool call, which is the whole measured benefit.
- **The alpha.7 `mode` fix holds on a model it was not tuned against.** The defect
  the friction metric found — adding `Write` made the model drop `Edit`'s required
  `mode` in 10 of 20 calls — shows **zero** `Edit` rejections on both models after
  the inference fix. Model 2 also shows zero in the _withheld_ arm, where model 1
  still produced two `TOOL_INVALID_ARGS`: the surface is fine on both, and model 1
  is somewhat more sensitive to it.

Artifacts: `evals/results/experiments/tool-utility-deepseek-chat-5x-2026-08-15T11-12-43-197Z.json`,
`evals/results/experiments/tool-utility-gpt-5.6-terra-5x-2026-08-16T04-45-57-312Z.json`.

---

## 3. Golden set (live)

See the appended section — filled in from the run recorded in
`evals/results/release/`.

---

## What model 2 found before it ran: an adapter defect (§23)

The OpenAI attempt failed with `insufficient_quota`, and the _way_ it failed was
a defect in this kernel.

The API streams a well-formed frame:

```json
{ "type": "error", "error": { "code": "insufficient_quota", "message": "You exceeded your current quota…" } }
```

The `openai-responses` adapter read `payload.message` — one level above where the
message lives — found nothing, and reported:

```text
MODEL_INVALID_RESPONSE: Provider stream error.      blame: provider
```

Every part of that points somewhere wrong. The provider is working exactly as
documented, the account is unpaid, and "invalid response" invites the reader to go
and debug a parser. It now classifies from the correct nesting, using the same
vocabulary the non-streaming path already used, and reports `MODEL_AUTH_ERROR`,
`blame: user`, not retryable, exit 3.

**Attribution, per §23:** the _failure_ is `ENVIRONMENT_ERROR` — the account's.
The _defect it exposed_ is `ADAPTER_BUG` — ours. Those are two different things
and this document keeps them apart, because collapsing them is how "the provider
is flaky" gets written down about an unpaid invoice.

No fixture had ever contained a streamed error and no live run had reached one:
alpha.2 validated this protocol against a funded account. It took a second
provider, and specifically one that _failed_, to reach the path at all.

Regression: `tests/unit/adapters.test.ts`, "a streamed provider error is
attributable", five cases plus a negative control asserting that the old nesting
level really did find nothing.

---

## What may and may not be concluded (§22)

**May:**

- Delegation choice is a property of the model, not of the kernel or the prompt.
  Two models, same fixtures, same prompts: 0/25 and 10/15.
- Delegation's _lack of utility_ is not model-specific: neither model improved its
  solve rate by delegating.
- Tool friction on this surface is not model-specific: the `mode` fix holds on a
  model it was never tuned against.

**Must not, and is not done anywhere in this document:**

- No number here is averaged with model 1's. Every table has two columns.
- No alpha.2–alpha.7 claim is retro-fitted as multi-model. Those matrices now
  carry a `Model provenance` section saying, explicitly, that they are
  single-model — and the evidence gate fails a matrix that lacks one.
- Nothing is concluded about models in general from two of them.

## Cost

```text
model 2, tool-utility        30 runs
model 2, delegation-utility  30 runs
model 2, golden set          see the appended section
```

Model 1's figures are historical and were not re-run: its artifacts are from the
same fixture versions, which is what §21 requires.
