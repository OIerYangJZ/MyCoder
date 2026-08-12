# ADR-0010 — Anthropic Messages is real provider #1

**Status:** accepted, **amended 2026-08-12** · **Milestone:** `v0.1.0-alpha.2`

> **Amendment.** Provider #1 for the _live_ validation is **DeepSeek via
> `openai-chat`**, not Anthropic. The maintainer holds no Anthropic or OpenAI
> credential, so validating either was not merely inconvenient — it was
> impossible, and §51 makes a live run release-blocking. Adding configurable
> provider endpoints was therefore _unblocking_ alpha.2, not the multi-provider
> breadth §2.3 rules out: there is still exactly one provider under live test.
>
> The Anthropic analysis below stands and its offline fixture suite remains in
> CI. Reasoning replay is now validated offline only; `openai-chat` normalises
> DeepSeek's `reasoning_content` into the same `ReasoningPart`, so §14 is
> exercised live while §15's signature replay is not. That gap is recorded in
> `docs/alpha2-status.md`.

## Context

alpha.2 §3 requires exactly one real provider, chosen as a **runtime conformance
test** rather than by coding quality. Three adapters already exist and are unit
tested against transcripts; one of them has to be driven by a real endpoint.

## Decision

**Anthropic Messages.** `openai-responses` and `openai-chat` remain implemented
and unit-tested, but are not validated live in this milestone.

## Rationale

Against §3's weighted criteria, the deciding factor is **reasoning semantics**,
which §3 ranks High and which alpha.2 §15 singles out:

- Extended thinking must be **replayed verbatim, with its signature**, across a
  tool turn or the follow-up request is rejected. That is the most demanding
  requirement in the milestone and the one most likely to leak into Kernel Core
  if handled badly — the Agent Loop must round-trip metadata whose purpose it is
  forbidden to understand (§15: "The Agent Loop must not know why the metadata
  is needed").
- Tool arguments stream as `input_json_delta` fragments, which is exactly the
  §11 assembly pipeline under test.
- Errors are typed (`error.type`), so §21/§22/§23 mapping is testable rather
  than inferred from prose.

Validating the harder protocol first means a second provider is a narrowing
problem, not a discovery problem.

**Disclosure of a possible bias.** This kernel is being implemented with the
help of an Anthropic model, so "pick Anthropic" deserves scrutiny rather than
assent. The reasoning-replay argument stands on its own — and it is already
proven to bite: writing the conformance fixtures found a real bug where signed
visible thinking was silently dropped on replay (see below), which would have
broken multi-turn tool use in production. If the maintainer prefers OpenAI
Responses, the change is `KERNEL_LIVE_PROVIDER=openai` plus a fixture directory;
nothing in Kernel Core depends on the choice, which is the property this
milestone exists to demonstrate.

## Consequences

- `tests/model/fixtures/anthropic/` holds sanitized wire fixtures; the offline
  conformance suite runs in ordinary CI with no credential (§26).
- Live validation is `pnpm test:live:model`, gated on `KERNEL_LIVE=1` **and** a
  credential, and reachable in CI only through `workflow_dispatch` (§27, §49).
- `supportsParallelTools` stays as profiled; §13 requires live validation before
  it can be claimed.

## What writing the fixtures already caught

`toAnthropicMessages` replayed a thinking block only when `opaque && signature`
were both present. Visible extended thinking arrives as `text` + `signature`
with **no** `opaque`, so it was dropped — and the API rejects a tool-turn
follow-up whose thinking block is missing. Offline fixtures found it before a
single live request was made, which is the argument for §26 in one sentence.
