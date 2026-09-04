# ADR-0029 — Resuming without remembering a session id

**Status:** accepted · **Date:** 2026-08-18 · **Milestone:** v0.1.0-alpha.12 (post-tag)

## Context

`-r` took a session id and nothing else. Getting one meant reading it off the
banner of a session you were no longer in, or listing `~/.local/state/mycoder/sessions/`
by hand. Typing `mycoder -r` on its own — the obvious thing, and the thing people
do — printed:

```text
error: --resume requires a value
```

`-c` was the escape hatch, and it had a defect of its own: it resumed **the most
recent session on the machine**, not in this directory. Continue a project you had
not touched since yesterday and you got somebody else's session — then the identity
check refused it, through a bare `throw`, which `toKernelError` turns into the one
code it has for anything untyped:

```text
INTERNAL_ERROR: Cannot resume this session:
  This session was created in /tmp/wsA, but the current workspace is /tmp/wsB.
exit 6
```

Exit 6 means "MyCoder's own defect". Running `-c` in a directory with a session of
its own waiting is not one.

Underneath both: **a session id identifies a session to the machine and to nobody
else.** `ses_0msy2bjyc_830a49e28425` is not something a person recognises, recalls
or transcribes. `SessionMetadata` has had a `title` field since alpha.2 and nothing
ever wrote it.

## Decision

**`-r` with no id lists this workspace's sessions and resumes the one you point
at.** The list is keyed by what each session was asked to do.

```text
$ mycoder -r
Sessions in ~/project:

  1  14m ago   fix the flaky ssh test
     gpt · 12 tool calls · ses_0msy2bjyc_830a49e28425
  2  2d ago    write the release notes for alpha 13
     fake · 3 tool calls · ses_0msy2bj2k_28c0f350f48f

Resume which? [1-2, Enter to cancel]
```

Four decisions inside that:

**The title is the first user turn**, captured at the first turn and never
rewritten — it is what the session is _about_, and a title that changed every turn
would be no easier to recognise than the id. It goes through the store's redactor
like everything else written to disk. A session that was started and never asked
anything says so; it does not show a blank column.

**The list is scoped to this workspace,** and so is `-c`. A session from another
directory cannot be resumed into this one, so offering it is offering a choice that
cannot be taken. Sessions elsewhere are counted in a footer, never listed as
options.

**Not a terminal, not a prompt.** Under a pipe or `--json` the list is printed (as
records, `type: "sessions"`) and the run exits without resuming: a picker needs a
person. Exit `1` for the human form — nothing was resumed — and `0` for `--json`,
where the list _is_ the answer the caller asked for.

**A session that cannot be resumed here is a usage error.** New code
`SESSION_NOT_RESUMABLE`, exit `2`, with a remedy that names `-r`. Nothing about the
installation is wrong; the invocation named the wrong session for this directory.

## Consequences

**`-r` is a contract flag and its argument is now optional.** ADR-0021 forbids
changing what a contract flag _means_; `-r <id>` means exactly what it meant, and
the only behaviour that changed is the one that used to be a usage error. A wrapper
that branched on `-r` with no value getting exit 2 will now get 1 (or 0 under
`--json`) — the flag is documented as `-r, --resume [id]` in `--help` and in
`docs/cli-contract.md`, and it is the only flag whose value is optional. That
asymmetry is deliberate and is worth the one sentence it costs to document: every
other flag rejecting a missing value is what makes a typo loud.

**Titles are a new thing written to `session.json`.** It is the user's own first
line, on a machine they control, in a file that already holds the workspace path and
the model — and it goes through the same redactor. It is _not_ sent anywhere: no
telemetry field carries it, and the model never sees the list.

**`-c` changes behaviour in one case:** where it used to reach into another
workspace and fail, it now finds this workspace's own session, or says there is
none. No case that previously worked behaves differently.

**The picker is the first thing that writes to the terminal**, which is why the
palette is resolved before it rather than after — otherwise it would have been the
one surface that ignored `NO_COLOR`.

## Alternatives considered

**A `mycoder sessions` subcommand.** Cleaner as a data model and worse as an
affordance: the person who wants this is already typing `-r` and getting an error.
It also adds a subcommand to a closed set that `docs/cli-contract.md` mirrors, for a
list that has exactly one use. `-r --json` covers the scripting case.

**Fuzzy-matching `-r <text>` against titles.** Rejected for v0.1. Resuming the wrong
session is not a cheap mistake — it puts a stale conversation in front of a model
that will act on it — and "did you mean this one?" is a much larger surface than a
numbered list of five.

**Making `-c` a synonym for the picker.** Rejected: `-c` is the one that does not
ask. Its whole value is that it is the fastest way back into the thing you were just
doing, and a prompt in the middle of that is a regression.
