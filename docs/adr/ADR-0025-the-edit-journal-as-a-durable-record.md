# ADR-0025 — The edit journal as a durable record

**Status:** accepted · **Date:** 2026-08-16

## Context

`EditJournal` (`src/edit/atomic-write.ts`) has existed since the first edit tool
shipped. Until alpha.10 it was a private array on an object constructed per
session:

```ts
export class EditJournal {
  private readonly entries: RollbackMetadata[] = [];
```

Append-only in the sense that nothing removes from it, and durable in no sense at
all. It dies with the process, so a session that crashes, is cancelled, or is
resumed tomorrow has no journal.

Worse, and this is what turns a convenience into an audit defect: of the four
mutating tools, only `Edit` reached the event log. The dispatch in `kernel.ts`
read

```ts
if (record.name === 'Edit' && typeof meta.newHash === 'string') {
```

so `Write`, `Delete` and `Move` — the three tools ADR-0016 added, the three whose
mistakes are least recoverable — produced **no `file.edited` event**. The durable
record of what a session did to a workspace covered one tool in four, and the
missing three overwrite whole files, remove them and rename them. `Delete` on an
empty directory reached neither the log nor the in-memory journal.

ADR-0008 makes the event log the audit trail. Three quarters of the mutations
were not in it. That is true independently of whether undo is ever built.

## Decision

### 1. Every mutation the kernel applies emits `file.edited`

One event type, not four. `FileEditedPayload` gains the fields that distinguish
the kinds, and the dispatch in `kernel.ts` keys on the presence of journal
metadata rather than on the tool's name:

```ts
kind: 'replace' | 'create' | 'overwrite' | 'delete' | 'move'
movedFrom / movedFromPath        for a move
directory: true                  for an empty-directory removal
finalNewline                     see §3
entryId                          stable identity, so an undo can name what it reversed
undoOf                           set when this edit was itself a reversal
```

A tool-name check was how the gap survived two milestones: adding a fifth
mutating tool would have re-created it. Keying on the metadata means a mutating
tool that forgets to emit journal metadata fails a test rather than silently
dropping out of the audit trail.

### 2. The event carries the diff, not the content — and the diff is enough,

which we measured rather than assumed

§9 of the alpha.10 plan suspected `overwrite` of being lossy: "a diff between two
large unrelated contents is not obviously smaller than the content — so either
the journal is carrying the content already under another name, or the reversal
is lossy for some inputs. Find out which before building on it."

`scripts/audit-diff-reversibility.ts` answers it. The result is the second
alternative for a _different_ reason than the one suspected, and the first
alternative outright:

```text
overwrite, 5000 unrelated lines, past the LCS ceiling   reversible, byte-identical
                                                        diff 147,818 B for 68,890 B
                                                        of content — 2.1× the file
delete, 20000 lines                                     reversible, byte-identical
                                                        diff 268,926 B for 248,890 B
```

So the journal **is** carrying the content already, under the name `diff`, and it
carries it _twice_ for a coarse overwrite — every old line as a `-` and every new
line as a `+`. It is not lossy for size, and the "no full copies" rule in
`atomic-write.ts` was never really holding for these two kinds. This ADR stops
pretending otherwise: for `delete` and for a coarse `overwrite`, the diff is a
full copy, and §4 puts a ceiling on it rather than a euphemism.

### 3. Three things the diff genuinely cannot carry, and one it can be robbed of

The same audit found four cases that do not round-trip. None is the case §9
predicted:

```text
a credential-shaped line, diff redacted   NOT reversible — the log stores
                                          [REDACTED:secret/<fp>], and writing that
                                          back would corrupt the file
mixed CRLF and LF in one file             NOT reversible — the diff is computed on
                                          LF-normalised text and re-applied with a
                                          single dominant style
a change only to the final newline        the diff is EMPTY — `splitLines` cannot
                                          distinguish "a\nb" from "a\nb\n", so
                                          neither can the differ
```

The first is not a bug to fix. `store.ts` redacts every event on the way in, and
that is the last line of defence for invariant 12. Undo will not be given a
private, unredacted channel to the session directory: _a convenience that cannot
be provided without weakening a boundary is not a convenience._ The entry is
recorded, and it is recorded as not reversible.

**Correction, from building it.** The first case is narrower than the audit
suggested, and the difference matters enough to state precisely. Redaction
happens on the way into the **log**, not into the in-memory journal, so a running
process still holds the real diff:

```text
same edit, same secret, in-process     reversible, byte-identical
same edit, after a restart             REFUSED — the log's copy is the only one
                                       left, and it holds the placeholder
```

Both halves are held by a test pair in `tests/integration/undo-resume.test.ts`,
because neither says it alone: the first without the second reads as "secrets are
fine", the second without the first as "undo cannot handle a file with a
credential in it". The true statement is that this edit survives a crash as an
audit record and not as a reversal, which is exactly the trade invariant 12 buys.

The second and third are addressed as far as they can be: `finalNewline` joins
the payload, because it is one bit and nothing else preserves it. Mixed EOL gets
no repair — `mixedEol` is recorded so the refusal can name the reason.

### 4. Reversibility is verified, never assumed

This is the load-bearing decision, and it is what makes §3 an enumeration rather
than a promise that the enumeration is complete.

Every reversal reconstructs the prior content, hashes it, and compares against
the `oldHash` the journal recorded at the time. A mismatch refuses the undo.

```text
reconstruct → sha256 → compare with the recorded oldHash → write, or refuse
```

The consequence is that the question "is this diff lossy?" stops being one this
code has to predict correctly for every input, and becomes one it _measures_, per
entry, at the moment of use. A loss mechanism nobody has thought of yet produces
a refusal, not a corrupted file. The Corruption Stop in the alpha.10 plan is
therefore structural rather than aspirational.

### 5. The size ceiling

A session that rewrites a 10 MB file forty times must not produce a 400 MB log.

```text
MAX_JOURNAL_DIFF_BYTES = 1 MiB
```

Above it the event is still written — the audit trail is not optional — but the
`diff` field is replaced by the empty string and `diffOmitted: true` is set with
the byte count that was dropped. The hashes, the kind, the path and the
identifiers all remain, so the log still answers "what changed, when, because of
which tool call". Only the reversal is lost, and it is lost _visibly_: `/undo`
lists the entry as not reversible and says the diff exceeded the ceiling.

A ceiling that dropped the whole event would trade an audit guarantee for disk,
which is the wrong direction. A ceiling that kept everything would let one loop
fill a disk. Keeping the metadata and dropping the payload is the only split that
preserves ADR-0008.

### 6. The journal is rebuilt from the log on resume

`rebuildJournal(store, sessionId)` replays `file.edited` in sequence order and
reconstructs `RollbackMetadata`. Three rules:

1. **An entry that cannot be fully reconstructed is retained and marked, never
   dropped.** A log written before alpha.10 has `file.edited` events with no
   `kind` and no `finalNewline`; those become entries with
   `reversible: false, reason: 'recorded by a kernel older than alpha.10'`. They
   still appear in the dirty-file list and in `/undo`'s inventory, because a user
   asking what happened to their workspace is owed the older edits too.
2. **A truncated or gap-ridden log yields a partial journal and a warning.**
   `readEvents` already stops at a torn final line; resume reports how many
   entries were recovered rather than presenting a partial journal as complete.
3. **An `undoOf` entry cancels its target.** Rebuild processes reversals so a
   resumed session's inventory of "what can still be undone" matches what a
   live session would have said.

### 7. A delegated child's edits enter the parent's journal, attributed

`src/session/delegation.ts` already emits `file.edited` with `delegationId` set
(alpha.4 §9: one event log per root session, the child's work tagged rather than
split). The answer that was in the code and never stated: **yes, and under the
child's delegation id, not the parent's turn.**

The alternative — a child's edits invisible to the parent's undo — is worse in
exactly the way alpha.4 §29 already worried about: a child that was interrupted
mid-task may have edited several files and reported none of them, and the parent
is the only thing left that can reverse them. `RollbackMetadata` gains an
optional `delegationId`, `/undo` shows it, and a reversal of a child's edit is
recorded as the parent's own edit, because the parent is who performed it.

### 8. What this ADR does not make durable

The journal records what **the kernel's own tools** did. It does not record, and
this ADR does not attempt to record:

```text
a shell command's side effects     MutationDetector sees that files changed, and
                                   workspace.mutation is in the log, but there is
                                   no prior content to restore
a foreign tool's writes            mcp.invoke carries no path (ADR-0023 §1); the
                                   kernel cannot see them
anything before this process       recoverable only as far as the log reaches
```

ADR-0026 §4 requires those to be enumerated at the point of use rather than left
to a reader of this document.

## Consequences

- The event log grows with the size of what is deleted and coarsely overwritten.
  Measured: 2.1× the file for a coarse overwrite, 1.08× for a deletion, bounded
  at 1 MiB per entry.
- Three of four mutating tools begin appearing in the audit trail for the first
  time, which changes what existing log-reading tests see. That is the fix, not a
  regression.
- A resumed session can undo. A session resumed from a pre-alpha.10 log cannot,
  and says so per entry.
- `EditJournal` is no longer a passive array: it exposes `restore()` for rebuild
  and `markUndone()` so the inventory stays accurate.

## Alternatives considered

**Store file copies in `sessions/<id>/journal/`.** Rejected. It puts unredacted
file content — including whatever secrets the file contains — in the session
directory, which is precisely what invariant 12 and `store.ts`'s redaction exist
to prevent. The audit shows the diff already carries the content for the two
kinds that need it, so the copies would buy only the redaction bypass, which is
the part we must not have.

**Give undo an unredacted side channel.** Rejected for the same reason, more
sharply: the redactor is the one component that sees every event, and an
exception to it for one feature is not an exception to it.

**Reconstruct the prior content optimistically and let the write fail.** Rejected.
There is no "fail" — writing wrong bytes succeeds. The hash comparison in §4 is
the only check that happens before the damage.
