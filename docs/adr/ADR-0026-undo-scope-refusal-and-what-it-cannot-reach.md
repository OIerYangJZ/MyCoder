# ADR-0026 — Undo: scope, refusal, and what it cannot reach

**Status:** accepted · **Date:** 2026-08-16

## Context

Five milestones answered one question — _can the kernel stop something bad from
happening?_ — and none answered the other one: _something bad happened anyway,
now what?_ `Edit`, `Write`, `Delete` and `Move` all record rollback metadata and
nothing in this repository reverses any of it.

alpha.9 is what makes the gap urgent rather than untidy. ADR-0023 §6 says, in the
product's own voice, `effects inside MCP servers: none`. A user who attaches the
reference filesystem server has `write_file`, `edit_file` and `move_file` in
their catalogue, operating outside every boundary `/status` reports, producing no
journal entry and no diff. The milestone that made one class of damage impossible
to _prevent_ shipped in a project that had no way to _undo_ anything.

The root problem is not the reversal. Undo is easy to build and easy to build
**dishonestly**, and the dishonest version is the one that ships by default: it
says "undone" and means "I reversed the four edits I know about". In a session
with a foreign filesystem server attached, or one where a shell command ran a
code generator, the user's resulting belief is false and the product created it.

So the central decision is **what the word "undone" is allowed to mean**.

The precedent is exact and recent. ADR-0023 could have let an MCP tool declare
its own effects and been convenient; it said `unenforced` instead, and the
alpha.9 dogfood then demonstrated the limitation in the product's own output.

## Decision

### 1. The unit of undo is the tool call, and the default is the last one

```text
/undo                     reverse the most recent reversible entry
/undo last <n>            reverse the last n, newest first
/undo path <p>            reverse every entry for one path, newest first
/undo turn                reverse everything the current turn did
/undo list                reverse nothing; show the inventory and the limits
```

A tool call is the unit because it is the unit the user watched go past and the
unit the approval prompt named. A _turn_ is offered because "that whole attempt
was wrong" is the common case, and a _path_ because "leave the rest, put that
file back" is the other one. There is no "undo everything since the session
started" — a session-wide revert with no VCS underneath it is a restore, not an
undo, and it should look like one.

Order is always newest-first within the selection. Reversing an older edit before
a newer one on the same path would fail its own precondition, which is the
correct outcome but a confusing way to reach it.

### 2. What makes a reversal unsafe, and what the kernel does instead

Every entry has a precondition, and the kernel already had the machinery: the
recorded `newHash` is what the file should be _now_.

```text
current hash == newHash        reverse
current hash != newHash        REFUSE, naming the path, saying the file changed
                               after the edit — by the user, by a shell command,
                               or by a foreign tool
file is gone                   REFUSE
path is now protected          REFUSE — a .env that was writable when it was
                               written and is denied now is denied now
move-back target occupied      REFUSE
reconstruction != oldHash      REFUSE (ADR-0025 §4) — this is the one that
                               catches redaction, mixed EOL, an empty diff, and
                               every loss mechanism nobody has thought of yet
diff omitted for size          REFUSE, naming the ceiling
entry from an older kernel     REFUSE, naming the version boundary
```

A refusal is not an error the model should retry. It is information: something
else touched that file. The message says which file and which of the causes
above, and the exit code is the ordinary tool-failure code per ADR-0021.

### 3. Partial application is forbidden

A three-file undo where the second file drifted reverses **nothing**, reports
which file drifted, and leaves the workspace exactly as it found it.

The alternative — reverse what you can, report the rest — produces a workspace in
a state that never existed at any point in the session, which is worse than
either endpoint. _Reversing part of a set produces a state that never existed;
refusing produces one that did._

Mechanically this is two-phase: check every precondition and reconstruct every
target's content in memory, then write. The atomic-write machinery already gives
per-file atomicity; this adds the set. A failure _during_ phase two — a disk
error after the second of three files — is the one case the kernel cannot make
atomic, and it is reported as a partial application with the list of what was
written, rather than described as success. It is not silent, which is what the
Silent Partial Stop actually forbids.

### 4. Undo states what it did not cover, every time, from the session's own state

This is the clause the ADR exists for.

An undo result — the human's, and the model's — always ends with an enumeration
of what was **not** reversed, derived from the live session rather than from a
constant:

```text
mcp.invoke calls made this session   "N call(s) to server X are not covered:
                                      the kernel cannot see what a foreign tool
                                      wrote (ADR-0023)"
shell commands that mutated source   "N shell command(s) changed files without an
                                      Edit; their effects are not journalled"
edits from before this process       "this journal begins at <boundary>"
entries that are not reversible      each with its own reason (§2)
```

If the session did none of those, the statement says so — "nothing else in this
session touched the workspace" — because an empty enumeration derived from state
is evidence, and a missing enumeration is silence.

The model receives the same text. A model told "undone" that then reasons about a
workspace state which does not exist will produce a wrong plan confidently.

**A recovery mechanism that does not state its scope has not recovered anything;
it has moved the user's uncertainty somewhere they will not look for it.**

### 5. Undo is an edit

It writes files. Therefore it declares `file.write` per path (and `file.delete`
when reversing a `create`), the policy engine rules on it, protected paths apply,
it appears in the event log, it is itself journalled — so undoing an undo works
by the ordinary mechanism — and it invalidates the freshness receipts for every
path it touched.

There is no special case, and the temptation to make one — "undo is restoring,
not writing" — is the same temptation ADR-0016 refused when it made `file.delete`
a capability rather than a `file.write` with a flag.

### 6. Both a tool and a command, with a loop guard

The model may call `Undo`, and the user may issue `/undo`. Both route through one
implementation, so neither can reverse something the other would refuse.

The model gets it because the failure it repairs is the model's: an edit applied
to the wrong file, a rewrite that lost a section. Requiring the user to notice
first would make the kernel's only recovery mechanism depend on a human watching.

What stops an undo loop: **a reversal is never itself reversible by `Undo` called
from the model.** The entry an undo writes is journalled with `undoOf` set, and
model-issued `Undo` skips entries that have it. So `Edit → Undo → Undo` reverses
one edit and then reports "there is nothing further to undo", instead of
oscillating a file forever at one tool call per step. The _user_ may still
`/undo` a reversal, because a human asking twice means what it says.

The model's `Undo` is additionally capped at the current turn's entries.
Reversing work from three turns ago is a decision, and a decision belongs to the
person, not to a token predictor recovering from a stack trace.

### 7. What an undo does to freshness and to the model's context

Reverting a file the model has read makes its receipt stale in a way the model
did not cause, so `invalidatePath` runs for every reverted path and the tool
result says so explicitly: _re-read these files before editing them._ The next
`Edit` without a fresh receipt is rejected by the ordinary gate, which is the
correct behaviour — the model's picture of that file is now wrong.

The reverted paths are also added to the context as a critical fact, the same way
an undeclared shell mutation is, so the information survives into the next step
rather than living only in a tool result the model may compact away.

## Consequences

- The kernel can make a mistake cheap for the first time.
- Undo can refuse for eight distinct reasons, and most sessions in a dirty
  workspace will meet at least one. That is the honest shape of the feature.
- Every undo result is longer than "undone", permanently, by design.
- A foreign tool's write remains unreachable. ADR-0023 does not change; alpha.10
  makes the consequence visible at the moment it matters.

## Alternatives considered

**Use git.** Rejected, three reasons: the workspace may not be a repository; a
`git revert` mixes the agent's changes with the user's uncommitted ones and
cannot distinguish them; and a kernel that mutates git history to implement undo
has acquired `vcs.mutate` on a path the user never approved. The journal already
has everything needed and does not touch the user's VCS state.

**Snapshot the workspace per turn.** Rejected: it is the "no full copies" trade
at a much larger scale, it copies files the session never touched, and it puts
unredacted content on disk (ADR-0025, alternatives).

**Say "undone" and document the limits in the manual.** Rejected. This is the
dishonest version named in the context above. The limitation must be stated in
the product, not merely be true — the same standard alpha.9 §25.3 was amended to
meet.

**Reverse what is possible and report the rest.** Rejected; see §3.
