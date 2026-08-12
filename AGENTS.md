# AGENTS.md — rules for programming agents working on this repository

1. `docs/kernel-v0.1-spec.md` is the **normative** specification. Code may reorganise
   internals freely, but must not bypass the security invariants, state machines or
   public interfaces defined there.
2. Never bypass `ToolExecution` / `PolicyEngine` / `EgressGate` / `SecretBroker`
   "for convenience". A shortcut through any of these is a release blocker.
3. `reference/**` is **read-only**. No agent may write into the reference tree, and
   reference-internal types must never become part of our public API.
4. Any change to a public interface requires a new ADR under `docs/adr/`.
5. Write or update the test first, then implement.
6. Do not introduce a new agent framework dependency without an ADR. v0.1 has
   **zero runtime dependencies** (see ADR-0009).
7. Provider-specific types must not leak into the session / context / tool layers.
   Only the internal IR (`TextPart`, `ReasoningPart`, `ToolCallPart`,
   `ToolResultPart`, `MediaPart`, `FinishReason`) crosses that boundary.
8. `spawn(..., { env: process.env })` is forbidden. Use `scrubEnv()`.
9. No raw network client outside `src/security/egress-gate.ts`. Everything else
   goes through `EgressGate.send()`.
10. If the secret canary test fails, stop all other development until it passes.

## Definition of done for a PR

- Which spec contract changed?
- Does it add provider-specific coupling?
- Does it add file / network / process capability?
- Could it let a secret reach model / tool / log / telemetry?
- Does it need an ADR?
- Is there a fake-provider test?
- Is there a security regression test?
- Does it change permission UX?
- Is it replayable?
- Is `reference/**` still read-only?

A PR that adds a capability without a matching `AccessRequest` + policy test must
not be merged.
