# ADR-0007 — Local and SSH implement one ExecutionBackend

**Status:** accepted · **Date:** 2026-08-12

## Context

Tools must not know whether they are running locally, over SSH, or in a
container. They also must not be able to widen their own capabilities.

## Decision

One `ExecutionBackend` interface with `fs`, `process`, `environment` and
`enforce(profile)`. `enforce()` returns a `CapabilityExecutor` — a backend
already narrowed to the granted roots, with no accessor for the unconstrained
backend underneath.

## Rationale

Two properties fall out. The agent loop is backend-agnostic, so `--remote` is not
a second code path. And the constrained executor re-checks every path at the
point of use, so a bug in a tool cannot become a jail escape.

## Consequences

- `EnvironmentDescriptor.sandboxStrength` is part of the interface, so the UI can
  report `policy-enforced` versus `os-isolated` honestly (invariant 5).
- The SSH backend implements the filesystem with small POSIX snippets over a
  ControlMaster connection; `ForwardAgent=no`, empty `SendEnv` and strict host
  key checking are passed explicitly so a permissive `~/.ssh/config` cannot relax
  them.
- A future container backend is a new file, not a refactor.
