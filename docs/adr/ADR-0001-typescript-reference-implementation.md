# ADR-0001 — TypeScript on Node is the v0.1 reference implementation

**Status:** accepted · **Date:** 2026-08-12

## Context

The kernel needs streaming HTTP, an async agent loop, a CLI, and a plugin story.
It also needs to stay small enough to audit.

## Decision

TypeScript on Node ≥ 22.6, ESM, strict mode.

## Rationale

- `AsyncIterable` and streaming `fetch` map onto the agent loop with no framework.
- The CLI, skill, hook and MCP ecosystems are all native here.
- Node ≥ 22.6 strips types natively, so there is no build step between the source
  and what runs — which matters when the thing being audited is a security
  boundary.
- The reference implementations we study (OpenCode, Kimi Code, Clio) are close
  enough to compare against directly.

## Consequences

- `erasableSyntaxOnly` is on: no enums, no namespaces, no parameter properties.
  This is a real constraint and it shows up in every constructor.
- Type checking needs a separate `tsc` run; the runtime only strips types.
- The high-risk execution layer can later become a Rust sidecar behind
  `ExecutionBackend` without changing any kernel contract.
