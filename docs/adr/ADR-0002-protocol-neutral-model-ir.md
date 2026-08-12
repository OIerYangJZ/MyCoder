# ADR-0002 — The agent loop only sees a protocol-neutral IR

**Status:** accepted · **Date:** 2026-08-12

## Context

Providers disagree about almost everything that touches the loop: how tool
arguments stream, whether tool results are user messages, what a finish reason is
called, whether reasoning must be replayed verbatim, and whether an empty
assistant message is legal.

## Decision

`TextPart`, `ReasoningPart`, `ToolCallPart`, `ToolResultPart`, `MediaPart` and
`FinishReason` are the only shapes above the adapter layer. Provider specifics
live in `rawFinishReason` and `providerMetadata`, which the loop treats as opaque.

## Rationale

Every quirk absorbed by an adapter is a conditional that never appears in the
state machine. The alternative — a loop that knows which provider it is talking
to — makes every provider change a change to the most safety-critical code.

## Consequences

- Adding a provider is one file plus a test transcript.
- Adapters must be pure: build a request, translate SSE records. No network, no
  secret access.
- Invariant 6 is testable: `tests/unit/adapters.test.ts` drives three protocols
  through realistic transcripts and asserts identical IR.
