# `v0.1.0-alpha.2` — Real Model Validation status

**Baseline:** `v0.1.0-alpha.1` (`c3a87381be63`) · **Provider #1:** Anthropic Messages (ADR-0010)

Status vocabulary is the same three values the M2 report uses. **PASS** means a
named automated test asserts it. **BLOCKED** means the work is complete but the
assertion requires something this environment does not have. **NOT DONE** means
it is not done.

> **The tag is blocked.** Everything that can be validated without a provider
> credential is done and green. Nothing that requires a live request has run,
> because no credential exists here — and §51 makes live validation a
> release-blocking item. See §"What blocks the tag" below.

---

## 1. Scope (§2.1 MUST)

| Item                                    | Status                              | Evidence                                                                       |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| exactly one real provider               | **PASS**                            | ADR-0010; `KERNEL_LIVE_PROVIDER` defaults to `anthropic`                       |
| authenticated real requests             | **BLOCKED**                         | `tests/live/model-live.test.ts` "authenticates and streams text" — never run   |
| real streaming                          | **BLOCKED**                         | same                                                                           |
| real text output                        | **BLOCKED**                         | same                                                                           |
| real tool-call streaming                | **BLOCKED**                         | live "streams a tool call and assembles its arguments"                         |
| fragmented tool argument assembly       | **PASS** offline                    | `adapter-conformance.test.ts` — 5-way fragment split, plus hostile chunk sizes |
| reasoning normalization                 | **PASS** offline                    | conformance: visible + signature, and redacted/opaque                          |
| finish reason normalization             | **PASS** offline                    | conformance: `end_turn`, `max_tokens`, unknown value                           |
| usage/token accounting                  | **PASS** offline                    | conformance + `src/model/usage.ts` provenance                                  |
| cancellation                            | **PASS** offline / **BLOCKED** live | `hardening.test.ts` mid-stream cancel; live case never run                     |
| retryable failures                      | **PASS** offline                    | conformance HTTP mapping                                                       |
| rate limits                             | **PASS** offline                    | `http-rate-limit.json` → `MODEL_RATE_LIMIT`, retryable                         |
| malformed/partial provider responses    | **PASS**                            | conformance: invalid JSON, stream cut mid-arguments                            |
| context overflow                        | **PASS** offline                    | `http-context-overflow.json` → `MODEL_CONTEXT_OVERFLOW`                        |
| provider metadata escape hatch          | **PASS**                            | `providerMetadata` retained; core never inspects it                            |
| model egress through EgressGate         | **PASS**                            | `HttpModelRuntime` has no other path; `pnpm lint` `no-raw-network`             |
| credentials through the Secret boundary | **PASS**                            | `SecretLease.applyAuthorization`; live isolation tests written                 |
| sanitized wire fixtures                 | **PASS**                            | 16 fixtures + a test that fails if one is unsanitized                          |
| live-provider integration tests         | **BLOCKED**                         | written, never executed                                                        |
| 12 real-model Golden Tasks              | **BLOCKED**                         | runner ready; `pnpm eval` against a live alias never run                       |
| trajectory/cost metrics                 | **PASS**                            | `EvalResult` schema, artifacts under `evals/results/`                          |
| complete regression against alpha.1     | **PASS**                            | 274 tests green                                                                |

## 2. Architecture (§4, §35, §36)

| Item                                | Status   | Evidence                                                                                                                          |
| ----------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| no provider code in Kernel Core     | **PASS** | `pnpm lint` `no-provider-names-in-core`, now scanning session, context, tools, policy, **security**, **execution**, edit, control |
| no provider types above the adapter | **PASS** | conformance: "no fixture produces a part carrying a vendor field name"                                                            |
| generic core changes have an ADR    | **PASS** | ADR-0010                                                                                                                          |
| architecture lint passes            | **PASS** | 9 rules, 0 violations                                                                                                             |

Kernel Core changed in exactly two places this milestone, both generic:

1. `model.request` / `model.response` became
   `model.request.started` / `.completed` / `.failed` (§42). The third did not
   exist; a failed request was recorded as a response carrying an error, which
   made §34 failure classification guess from payload shape.
2. Usage gained provenance and cost gained a configured price (§17, §18).

Neither mentions a provider.

## 3. Defects found while building this milestone

1. **Signed thinking was dropped on replay.** `toAnthropicMessages` required
   `opaque && signature`; visible extended thinking has `text` + `signature` and
   no `opaque`, so the block was silently omitted — and the API rejects a
   tool-turn follow-up whose thinking block is missing. Found by an offline
   fixture, before any live request. This is §26's entire argument.

2. **Accumulated usage always read `unknown`.** `addUsage` took the weaker
   provenance of both operands, so the empty accumulator poisoned the first real
   measurement. Every `usageProvenance` in an eval artifact would have said
   `unknown` while carrying correct numbers.

3. **The eval summary printed `$0.0000` for an unconfigured price.** A confident
   zero where the honest answer is "unknown". Now prints
   `unknown (no [pricing] configured)`.

## 4. Cost accounting is deliberately incomplete

§18 asks for `$/solved task`. The plumbing is done; the **prices are not
hard-coded**, and no default pricing ships.

That is a decision, not an omission. Provider prices change, vary by tier, and
differ between cached and fresh input. A number baked in here would produce
confident wrong costs in an artifact that looks authoritative. With no
`[pricing]` configured, cost is reported as `unknown` and the summary says so.

To get real figures, set prices in config and re-run — the arithmetic,
cache-aware splitting and provenance propagation are all in
`src/model/usage.ts` and tested.

## 5. What blocks the tag

`pnpm test:live:model` has never executed. It needs:

```bash
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY with KERNEL_LIVE_PROVIDER=openai
pnpm test:live:model                # sets KERNEL_LIVE=1 for you
```

The suite refuses to run without **both** `KERNEL_LIVE=1` and a credential, so a
plain `pnpm test` can never fire a billed request even on a machine with a key
exported. It skips with an explicit diagnostic rather than passing silently —
a missing key must never look like a green result.

In CI, use the `Live Model Validation` workflow (`workflow_dispatch`, protected
`live-model` environment). It runs the offline gates first, because there is no
point paying to discover the adapter was already broken.

Once it has run, the remaining checklist items in §50 of the milestone plan can
be marked from observed output, and only then does §51 permit
`git tag v0.1.0-alpha.2`.

## 6. Explicitly not claimed

- A second provider (§2.3 NON-GOAL).
- Parallel tool calls in production: fixtures cover them, §13 requires live
  validation before `supportsParallelTools` may be trusted.
- Real-VPS SSH validation — that is the milestone after this one (§60).
- OS-level isolation, unchanged from alpha.1.
