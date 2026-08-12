# ADR-0005 — Secret Broker and Egress Gate are kernel services

**Status:** accepted · **Date:** 2026-08-12

## Context

"Do not leak secrets" cannot be a prompt instruction, and it cannot be a rule
each tool applies for itself.

## Decision

Two mandatory chokepoints:

- **SecretBroker.** The model sees `secret_ref://stripe/test`. A lease has no
  accessor that returns the string — only `injectInto(env, name)` and
  `applyAuthorization(headers, scheme)`. `toString()`, `toJSON()` and the Node
  inspect hook all return the reference.
- **EgressGate.** Every outbound byte, from any channel, goes through
  `send()`. Nothing else in the codebase may call `fetch`, and a test enforces
  that by scanning the source.

## Rationale

Getting a value out of the broker requires deliberately calling an injector,
which is greppable and testable. An accidental `console.log(lease)` prints a
reference.

## Consequences

- `InMemorySecretBroker` is the one component permitted to read a credential from
  the host environment.
- Every lease registers its value with the `Redactor` for the lease's lifetime,
  so a subprocess that echoes the credential has it stripped on the way back.
- Telemetry is metadata-only, re-validated against a field allowlist at the gate
  rather than trusted at the call site.
