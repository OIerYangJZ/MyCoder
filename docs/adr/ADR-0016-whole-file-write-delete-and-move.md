# ADR-0016 — Whole-file write, delete and move

**Status:** accepted · **Date:** 2026-08-15

## Context

ADR-0006 shipped `Edit` with two modes — exact `replace` and `create` — and said
plainly that delete and rename were absent because "a half-version now would mean
a migration later". Two milestones of dogfooding later, the migration argument is
still right and the absence has a measurable cost:

- a file that must be rewritten wholesale (a generated fixture, a config the model
  is regenerating rather than patching) has to be expressed as a chain of exact
  replaces, and every failed match costs a step;
- a file that must go away can only go away through `Shell rm`, which is an
  approval for _executing a program_ rather than for _deleting a file_. The
  policy layer sees `process.exec rm`, the approval prompt says "run rm -f
  src/old.ts", and nothing in the kernel knows a file was deleted;
- the same is true of a rename, which additionally loses the one property a
  rename has and a copy-then-delete does not: it is atomic.

Routing destructive filesystem work through `Shell` is the worst of the available
options, because it is the one path where the kernel's own record of what
happened is a command string.

## Decision

Three tools, one new capability, two new backend operations.

**`Write { path, content, receiptId? }`** creates a file, or overwrites one that
exists. Overwriting requires a `receiptId` whose coverage is `full`: replacing
every byte of a file the model has only seen 40 lines of is precisely the
hallucinated-context failure ADR-0006's coverage rule exists to stop, and it is
worse here because there is no `oldString` that could fail to match. Creating is
unchanged from `Edit`'s `create` mode and needs no receipt.

**`Delete { path, receiptId? }`** removes a single file, or an empty directory.
A file requires a full-coverage receipt, for the same reason `Write` does: the
model must have seen what it is destroying. Recursive directory removal is _not_
implemented — see Consequences.

**`Move { from, to }`** renames a file or a directory. It refuses to overwrite an
existing destination, checked at resolve time and again immediately before the
rename.

**`file.delete`** joins the capability list. Deleting could have been modelled as
a `file.write`, and that is exactly what makes it the wrong model: every builtin
profile allows `file.write` inside the workspace outright, so a deletion would
have been silent. It is a distinct capability so that a profile can say something
different about it — `deny` under `read-only` and `review`, `ask` under
`workspace-dev` — and so that `permissions.toml` can express "this project never
deletes" as one rule. `Move` declares `file.delete` on the source and
`file.write` on the destination, which is what a rename is.

**`FileSystemBackend`** gains `remove(path, { directory })` and
`rename(from, to)`. Both are implemented by all three backends and both are
re-checked against the granted write roots inside the constrained executor, so a
bug in a tool cannot become a path escape (ADR-0007's rule: one interface, every
backend implements all of it).

## Rationale

The receipt requirement is the load-bearing part. Everything else here is
plumbing that could reasonably have been written several ways; "you cannot
destroy content you have not read in full" is the property that makes these three
tools no more dangerous than the `Edit` that preceded them, and it is enforced by
the same ledger, with the same failure codes, so a model that has learned to
recover from `STALE_FILE` already knows how to recover from these.

Deletion as its own capability is the second. The alternative — a `destructive`
flag on `FileWriteAccess` — would have kept the access-request union smaller and
made the policy engine's job harder: rules match on capability, so a flag would
have needed a matching rule field, and every profile that already says something
about `file.write` would have silently covered deletion until someone remembered
to update it. Failing closed here means a new capability with no rule falls to
the profile's fallback, which is `ask` under `workspace-dev` and `deny` under the
read-only profiles.

## Consequences

- **Recursive delete is still absent.** `Delete` refuses a non-empty directory
  and says so. Removing a tree remains a `Shell` command with an exec approval,
  which is honest: the kernel cannot show a meaningful prompt for "delete 400
  files", and a tool that walks a tree deleting things is a different risk class
  from one that unlinks a named file.
- `Edit`'s `create` mode and `Write`'s create path overlap. `Edit` keeps it so
  that existing trajectories and replayed sessions behave identically; both tool
  descriptions name the other, so the model is not guessing.
- Undo of a delete is possible from the journal — the recorded diff of a deletion
  contains the whole file — but no `/undo` command consumes it yet.
- `Move` invalidates receipts for both paths. A receipt names a path, and after a
  rename that path either does not exist or is a different file.
