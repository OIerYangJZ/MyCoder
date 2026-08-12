# ADR-0008 — The event log is an append-only source of replay

**Status:** accepted · **Date:** 2026-08-12

## Context

Resume, audit and post-hoc debugging all need to reconstruct what happened.
Compaction rewrites the conversation the model sees.

## Decision

`events.jsonl` is append-only. Compaction appends a boundary event; it never
edits history. The store assigns `seq`, not the caller, and redacts the
serialised record on the way in.

## Rationale

Redacting the serialised form rather than the object catches a secret hiding in a
nested field nobody remembered to sanitise — and the store is the one component
that sees every event.

The log stores hashes and sizes, not content: `model.request` carries a payload
hash and byte count rather than the prompt, `file.read` carries a receipt rather
than the file. User input is the deliberate exception, so a resumed session can
show what was asked.

## Consequences

- Writes are serialised through a per-session promise chain, so concurrent tool
  completions cannot interleave partial lines.
- Replay reconstructs assistant text as a placeholder, because the content was
  never stored. This is the right trade: a log that would leak source code on
  disk is worse than a lossy replay.
- Resume synthesises results for interrupted tool calls, so invariant 1 survives
  a process kill.
