# ADR-0031 — A bounded, redacted preview of tool output

**Status:** accepted · **Date:** 2026-08-18 · **Milestone:** v0.1.0-alpha.12 (post-tag)

## Context

A tool result renders as one line:

```text
⏺ Read(src/cli/render.ts)
  ⎿ 4.2 kB
```

and a failure renders as rather less than one:

```text
  ⎿ STALE_FILE
```

There is no way, at any verbosity, to see what a tool returned or what an error
said. That is the better default — a transcript of forty tool calls stays readable —
and the worse floor: when something goes wrong the only recourse is to ask the model
what it saw, which is asking the least reliable witness in the room.

`reference/clio` collapses to one line too and gives you `Ctrl+O` to expand to a
hundred. The affordance is right and the mechanism is not ours to copy.

**Why this was not a renderer change.** `ToolResultPayload` carries `toolCallId`,
`name`, `isError`, `durationMs`, `contentBytes`, `truncated`, `errorCode` and
`artifactRef`. It does not carry the content, and neither does `ToolExecutionRecord`,
which is where the CLI's copy comes from. The comment above the `tool.error`
emission says why:

> Payload is a code and a count: nothing here carries content, so the §21.2 rule is
> unchanged.

So the content — and, it turns out, the error _message_ as well — sits on the far
side of a deliberate boundary. `docs/terminal-surface-design.md` §2 originally
claimed the error message was free to show. It was not, and that claim is corrected
there.

The boundary exists because **session events are persisted and replayed, and tool
output is the most secret-dense thing in the system.** A `Read` of a `.env`, a
`Shell` running `env`, a `WebFetch` of a response carrying a bearer token: all of it
arrives as tool output.

## Decision

**`ToolExecutionRecord` and `ToolResultPayload` gain an optional `preview`: at most
2 kB and 20 lines of the tool's output, redacted before it is truncated, produced
only when the CLI asked for it.**

Four constraints, each of which is the answer to a way this could have gone wrong.

### 1. Redact first, truncate second

Not the other way round. `Redactor.redact` matches known literals and scans for
secret shapes; truncating first can cut a secret in half, and half a token matches
no literal and no shape. It then survives redaction and is printed.

So: `redactor.redact(content)` then `truncateForModel(...)`. The cost is redacting
more text than is kept, which is a cost worth paying once per tool call.

### 2. The existing truncation, not a second one

`truncateForModel` in `src/util/text.ts` already exists, already cuts from the
middle — "the head explains what ran, the tail carries the error; dropping only the
tail is the classic way to hide a stack trace" — and is what A15 (unified
truncation) is about. The preview passes a smaller budget to that function rather
than introducing a rule of its own. A second truncation rule is how the two end up
disagreeing, which is the whole of A15's complaint.

### 3. Emitted to the host, never written to the log

**Revised after the fact, and the revision is stronger than what it replaces.** The
original decision put `preview` in the persisted event and relied on the four
constraints below to make that safe. It was safe and it was still a copy of tool
output sitting on disk for the life of the session.

`Session.append` emits to the host and _then_ writes to the store, so the two can
differ: `preview` is stripped on the way to `store.append` (`EPHEMERAL_FIELDS`). The
terminal gets the bytes; the file is byte-for-byte what it was before this feature
existed. The `tool.error` event written directly to the store in `kernel.ts` carries
no preview at all — that path never reaches the host, so a preview on it would have
been all of the exposure and none of the benefit.

What this costs: a preview cannot be recovered from a session log after the fact. That
was never the point of it, and the alternative was persisting tool output to buy a
debugging convenience nobody asked for.

### 4. Off unless asked

The preview is built only when the runtime was told the CLI wants it (`--verbose`,
or `/verbose` mid-session). A session that never asks carries no tool content in its
event log at all, so the default is byte-for-byte what it is today and the §21.2
posture is unchanged for anybody who does not opt in.

This is also why it is not a rendering-time filter: the honest version of "off" is
that the bytes were never put in the record, not that something declined to print
them.

### 5. Redacted where it is made, not where it is stored

`FileSessionStore.append` already redacts every event on its way to disk — "the last
line of defence". Relying on that would have been wrong here, because **the CLI
renderer does not read events from the store.** It receives them through `onEvent`,
in-process, before and independently of persistence. A preview redacted only by the
store would be redacted in the file and printed in the clear on the terminal.

So the redaction happens in `ToolRuntime`, which already holds a `Redactor`, at the
point the record is built. The store's redaction stays as the second layer it was
always meant to be.

## Consequences

**A new user-visible flag.** `--verbose` joins the contract surface, so
`docs/cli-contract.md` and its mirror gain a row, and `/verbose` joins the control
commands.

**No change to what is persisted at all.** `preview` never reaches the log, so replay
is untouched and there is no migration in either direction. The field is part of the
emitted event and of nothing else.

**A secret regression test, not just a unit test.** `tests/security/` gains a case
that puts a known credential in tool output, turns the preview on, and asserts the
secret appears in neither the record nor the rendered line. Per AGENTS.md rule 10
this is the test that stops other work if it fails.

**V09 and A15 are still open, and this is sequenced before them.** The design
document recommended the opposite, and the user directed otherwise. The coupling
argument was that all three concern how much tool output is kept and where it goes;
the mitigation taken here is constraint 2 — the preview does not invent truncation,
so when A15 unifies it there is one call site to change rather than one rule to
reconcile. V09's `artifactRef` path is untouched.

## Alternatives rejected

**Read the content back from `artifactRef`.** No schema change, but `artifactRef` is
populated only when output was large enough to spill, which is the opposite of the
common case — and V09 says that path is exercised by nothing today.

**Put the full content in the event.** The size is unbounded and the log is
persisted. The bound is the point.

**Render-time filtering of a full payload.** The bytes would exist in the record and
in the log regardless of the flag; "off" would be a rendering preference rather than
an absence. Constraint 3 exists to prevent exactly this.
