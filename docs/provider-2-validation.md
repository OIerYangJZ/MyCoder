# Provider #2 — what a relay could and could not validate

**Status:** protocol validation done via a relay. The behavioural question is
**parked**, with a reason that is not "no time".
**Target:** an OpenAI-compatible relay (`api1.aisz.mom`) serving `gpt-5.6-terra`
over both `/v1/chat/completions` and `/v1/responses`.
**Not yet run:** direct `api.openai.com` (account unfunded at the time).

Two things were wanted from a second provider. `docs/delegation-utility-experiment.md`
§5 argued the second one had become the only way to make progress:

1. **Protocol validation.** `openai-responses` had never seen real traffic — only
   offline fixtures — so ADR-0002's claim (a protocol-neutral IR with provider
   quirks confined to adapters) had never been tested against a second wire format.
2. **The delegation question.** Does a _different model_ choose to delegate, when
   DeepSeek chose it 0 times out of 70?

The relay delivered the first and cannot deliver the second.

## 1. What was validated

`pnpm test:live:model` against the relay, both protocols, **9/9 each**:

| Claim (spec §)                                     | `openai-chat` | `openai-responses` |
| -------------------------------------------------- | ------------- | ------------------ |
| authenticates and streams text (§10)               | pass          | pass               |
| reports usage, provenance says `reported` (§17)    | pass          | pass               |
| streams a tool call and assembles arguments (§11)  | pass          | pass               |
| cancellation aborts, is not retried (§19)          | pass          | pass               |
| bad credential → `MODEL_AUTH_ERROR`, no echo (§22) | pass          | pass               |
| credential never reaches a Shell subprocess (§7)   | pass          | pass               |
| credential never reaches the log or store (§28)    | pass          | pass               |

The `openai-responses` column is the new information, and the pass is meaningful in
a specific way: that adapter switches on `response.*` event names —
`response.output_text.delta`, `response.function_call_arguments.delta`,
`response.completed`. Nothing would have parsed if the wire format had not been
genuinely responses-shaped, so the tool-call test passing _is_ evidence that real
responses-protocol events were assembled into the IR.

Then the delegation runtime over that protocol, `delegate-read-only-review` at N=3:
**3/3 solved**, one delegation per attempt, child success 100%, each child making
2–3 model requests and 1–2 tool calls. So a child scope samples, executes tools and
reports back over a wire protocol that had never carried a real request before this.

**What a pass through a relay does not establish.** Whether the relay proxies
OpenAI verbatim or normalises events on the way through is not observable from here.
A pass therefore proves our adapter handles _this_ relay's responses-shaped stream;
direct-endpoint confirmation is still worth having, and is one command once the
account is funded.

## 2. Why the behavioural question is parked

The relay injects **~4,388 tokens of its own prompt into every request**, on both
protocols. Measured, not inferred:

| Request                       | Reported input tokens |
| ----------------------------- | --------------------- |
| ~3-token prompt, chat         | 4,388                 |
| the same + ~500 tokens filler | 4,894                 |
| ~3-token prompt, responses    | 4,388                 |
| the same + ~500 tokens filler | 4,889                 |

The delta tracks the added content, so the counter is real and the prefix is
constant. Asked whether hidden instructions were present, the model refused to quote
them and said they "include guidance about tools and agent behavior" — a model's
self-report, so weak evidence, but pointing the same way as the token count.

That is disqualifying for the one question the relay was wanted for. An
uninspectable prompt containing tool and agent guidance sits exactly on the variable
under test. A nonzero delegation rate could not be credited to the model, and a zero
could not either. A number produced under those conditions is worse than no number,
because it looks like data.

It does **not** disqualify the protocol work: a 4.4k prefix does not change whether
SSE parses, whether fragmented tool-call arguments reassemble, or whether the
credential stays out of the tool plane.

Two smaller notes on the same instrument:

- It answers "model not available" with **HTTP 503**, not 404. Three conformance
  tests failed opaquely until the model list was checked: it serves
  `codex-auto-review`, `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and not
  the `gpt-5.6-luna` the config had named.
- It serves an unauthenticated `GET /models` at the root, so a 200 there says
  nothing about the API base. The base was established instead by probing without a
  credential and reading 401 as "route exists" — with a negative control
  (`/v1/definitely-not-a-real-endpoint` → 404) proving 401 was not simply what every
  path returned.

## 3. The defect this found in alpha.4

The delegated run reported ~5,000 tokens per task across 4.3 model requests, when
every request was demonstrably ~4.4k. That arithmetic does not work, and the reason
was ours.

`Session.recordDelegation` rolled up a child's **model requests, tool calls and
cost** — and silently not its **tokens**. So a root session reported a request count
that included its children beside a token count that did not, wherever the two are
shown together: `/status`, the eval artifact, and any arithmetic derived from tokens.
Cost was unaffected, because a child computes its own cost from its own tokens before
the roll-up — so the two numbers disagreed with each other, which is how it surfaced.

Fixed: `DelegationUsage` carries `inputTokens`, `outputTokens` and
`cachedInputTokens`, the service populates them from the child's snapshot, and
`recordDelegation` adds them. Pinned by
`test:tokens roll up, not only requests and cost`, which also asserts the
consistency that was broken — the root's request count must equal the requests
actually made.

**Consequence for the alpha.4 record.** The token figure in
`docs/alpha4-status.md` §4 (183k input / 14k output across 15 live attempts)
**understates** the five delegated attempts by their children's tokens. The
direction is known; the magnitude is not recoverable, because those runs' session
stores were temporary. The cost figures in the same paragraph are unaffected. No
evidence-matrix row becomes false — §36's metric list names child cost, requests and
tool calls, and all three were rolled up correctly.

## 4. What is still owed

- **Direct `api.openai.com`.** The responses-protocol validation against the real
  endpoint, which is the only thing that settles whether the relay was normalising
  events. Needs a funded account.
- **The delegation question, on a clean instrument.** Any provider that does not
  inject an unknown prompt. Direct OpenAI qualifies; this relay does not, at any
  sample size.
