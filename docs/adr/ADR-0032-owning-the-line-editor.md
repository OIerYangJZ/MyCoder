# ADR-0032 — Owning the line editor

**Status:** accepted · **Date:** 2026-08-18 · **Milestone:** v0.1.0-alpha.12 (post-tag)

## Context

Input is `readline.question()` with two rules drawn around it. That bought
correctness for free — wrapping, wide characters, paste, history, `Ctrl-A`/`Ctrl-E`
are all readline's problem — and it caps what the prompt can ever do. There is no
completion menu, no `@file` reference, no multi-line composition, no history search.
`ControlPlane.commandNames()` has always been able to answer "what commands exist"
and until ADR-0032's sibling work there was no way to ask it from the prompt.

**The ceiling is already being hit.** `keepFrame` re-draws the bottom rule on every
keypress because readline erases everything below its line on every refresh. That is
a workaround against the library, not with it, and every further affordance is
another one.

`reference/clio` owns its line editor: 1196 lines giving multi-line input, a styled
selection menu, `@file` completion, reverse history search, undo/redo and a kill
ring. It is the largest single usability gap between the two programs. It is also
clio's worst code — no tests at all, and at least six defects catalogued in
`docs/terminal-surface-design.md` §3.

## Decision

**Own the line editor**, in `src/cli/editor.ts`, replacing `readline` for the
interactive prompt only.

The six defects catalogued from clio become the acceptance criteria, because they
are what a hand-written editor gets wrong and they will not be rediscovered for free:

```text
1  a line longer than the terminal wraps; \r + erase-line clears one visual row,
   so every cursor calculation must account for wrapped rows
2  measure in columns, not characters — `visibleWidth` since alpha.12
3  bracketed paste (\x1b[?2004h), not "the chunk contained a newline"
4  one key-handling path, not two
5  restore terminal state on abnormal exit, not only on the clean path
6  testable without a terminal, or it will be untested like clio's
```

Criterion 6 shapes the module: the editor is a **pure state machine**
(`EditorState` + `applyKey`) with a thin driver that owns the stream and the
redraw. Every behavioural test drives the state machine directly; only the redraw
touches a terminal.

Criterion 1 is met by a redraw that computes rows from `visibleWidth` and the
terminal width, moves up by that count and rewrites — never by assuming one line is
one row. Criterion 3 is met by enabling bracketed paste and treating everything
between the markers as literal text, so paste is never confused with typing and
never auto-submits.

**Non-interactive input does not change.** A pipe still reads lines directly, as it
does today; there is no editor and no terminal state.

## Consequences

**A claim in `render.ts`'s header stops being true.** It says there is "no cursor
addressing beyond one line of spinner that erases itself". The editor addresses more
than one line. The sentence is updated rather than left to go quietly stale — it is
a claim about the program, and the program changed.

Spec §1.3's NON-GOAL is still met: no alternate screen, no panes, no mouse, no
absolute positioning. Every move remains relative and nothing survives the process.

**Terminal state must be restored on every exit path**, criterion 5, including a
crash. The driver installs its cleanup on `exit` **and on `SIGTERM`, `SIGHUP` and
`SIGQUIT`** — `exit` does not fire for a signal, and a signal is how a terminal
usually loses its foreground process. `SIGINT` is deliberately absent: in raw mode
Ctrl-C arrives as a byte and is the editor's own key. `SIGKILL` cannot be caught by
anything and is the one case no program can fix.

**A real terminal is part of the verification, not an optional extra.**
`tests/live/editor-pty.sh` (`pnpm test:editor:pty`) drives the built CLI through a
pty allocated by `script(1)`. It is a script rather than a `node --test` case because
allocating a pty without a dependency means a platform tool. It earns its place: it
found a regression 46 unit tests did not, because the defect was in the _meaning_ of
a return value rather than in any single function. `applyKey` resolved Ctrl-C and
Ctrl-D to the same `null`, so Ctrl-C exited the program — in a session whose banner
says "Ctrl-C cancels a turn, Ctrl-D exits". `read()` now returns a tagged outcome.

It then found a second one the same way: the caller's `submitted()` stepped up one
row to replace what had been typed, which was right when input was one readline row.
The editor's block is the prompt line, any wrapped rows and the rule, so stepping up
one left the prompt line on screen and every sent line appeared **twice** — once as
typed and once as the inverse block. The editor now takes its own block down
(`clearBlock`) and `submitted()` moves no cursor at all. Both defects were invisible
to a state-machine test because neither lived in a function; they lived in what two
functions each assumed about the other.

**The block is bounded by the window.** A redraw moves up by the rows it drew, and a
row that has scrolled off the top cannot be moved back to — so nothing draws more
rows than the terminal holds. The buffer has a viewport that follows the cursor; the
menu takes what is left and never more than half. This was shipped as a known limit
first ("a buffer taller than the window is on its own") and then closed, because a
limit recorded in a header is still a defect with a paper trail.

**One layout, not three.** `layout` is the only place a logical line becomes visual
rows. The arithmetic previously existed in `rowsUsed`, `cursorRowOf` and
`renderEditor`, which is three chances to disagree about where the block begins — and
a disagreement there is a redraw clearing somebody else's output. It also settles the
deferred-wrap question a terminal will not answer: a row filled to the last column
gets an empty row after it, and that row is really drawn, so the count matches the
screen rather than guessing which way the terminal went.

**A larger surface to keep correct.** This is the trade. It is taken because the
prompt is the one part of the program a user touches on every single turn, and
because the alternative was an unbounded series of workarounds against readline.

## Alternatives rejected

**Stay on readline and use its completer** (`docs/terminal-surface-design.md` §3,
Option A). Already done, and it is what makes this ADR optional rather than urgent:
Tab completion works today. It cannot give a styled menu, multi-line composition or
`@file`, and the frame workaround remains.

**A dependency.** ADR-0009: zero runtime dependencies. Unchanged.
