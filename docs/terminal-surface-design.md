# The terminal surface — what to take from `reference/clio`, and what not to

**Status:** items 1–6 of §7 are **implemented**, on the branch and untagged, at the
user's instruction and with ADR-0027 §5 noted rather than satisfied. Items 7 and 8
remain design only. The §7 table records which is which.

This document was written before any of it was built, which is why it still reads as
a design — and why §2 now carries a correction: one item it called free was not, and
the check that would have shown that was not run until the code was.

`reference/clio` is a Claude Code clone with a richer terminal surface than ours and
a much worse one underneath it. A comparison of the two found four axes on which it
is genuinely better to use — the line editor, the model's answer, what a tool result
tells you, and how live the figures are — and this is the design for each, **in our
idiom rather than its own**. The sections below do not map one-to-one onto those
four: the answer's rendering splits into a stream, markdown over it, and colour
inside its code blocks. `reference/**` stays read-only (AGENTS.md rule 3); nothing is copied, and
none of its types cross the boundary.

The constraints every design below is held to, none of which are new:

```text
renderer, not a TUI      spec §1.3. No alternate screen, no panes, no absolute
                         cursor addressing. Deleting the renderer must still
                         leave the kernel behaving identically
stdout is a contract     `--json` puts one object per line there. Chrome goes to
                         stderr; the answer is not chrome
zero dependencies        ADR-0009. No `ink`, no `chalk`, no grapheme library
plain when not a tty     styling a pipe writes escape codes into a log file
pure and testable        renderers return strings; a test asserts on the string
```

---

## 1. Streaming the assistant's text

**The gap.** A turn shows its tool calls as they happen and then goes quiet. The
answer arrives whole, after the model has finished, while the spinner has said
`Thinking` for forty seconds. clio streams token by token and feels an order of
magnitude more responsive for the same latency.

**The finding that makes this cheap.** The kernel already streams. `ModelRuntime`
decodes SSE into `ModelEvent`s, `src/model/ir.ts` has `text_delta` and
`reasoning_delta`, and `session.ts:939` already forwards every one of them to the
host as `model.stream`. `SessionRenderer.on()` has no case for `model.stream`, so
they fall through `default: return`. **No new event, no model-layer change, no new
capability — the bytes are already arriving and the renderer drops them.**

**Which stream it goes to: stdout.** Not stderr. The assistant's answer is the
payload, and it already goes to stdout today as `outcome.finalText`. Streaming it
means the same bytes arriving earlier. A reader redirecting stdout still gets the
answer and only the answer, because the tool-call lines are on stderr — the contract
is unchanged, not weakened.

**Its own styling gate.** `colour` is currently decided from `stderr.isTTY`. Text
going to stdout needs `stdout.isTTY` asked separately, or `mycoder … > answer.md`
gets escape codes in the file — the exact failure the header of `render.ts` warns
about. Two gates, not one.

**The spinner is the hazard.** It erases its line with `\r` + erase-to-end. A tick
landing in the middle of a streamed line eats it. So: the first `text_delta` stops
the spinner, and it does not restart until the next `tool.call` or
`model.request.started`. The renderer needs one boolean (`streaming`) and nothing
else.

**Do not print the answer twice.** `runOnce` writes `finalText` unconditionally. It
must write it only when the renderer did not stream — JSON mode, a pipe, a
non-interactive run. The renderer already owns the state, so it reports it:
`renderer.streamed(): boolean`, cleared at `turn.started`.

**Terminate the line on the way out.** A turn cancelled mid-sentence leaves the
cursor mid-line and `Turn cancelled.` lands inside the prose. `turn.cancelled`,
`turn.failed` and `turn.completed` each write a closing newline if `streaming`.

**Markdown is stage two, and it is optional.** Raw streamed text closes the whole
perceived-latency gap on its own. Markdown adds one real hazard, and clio has it:
it prints the partial line raw for immediacy, then erases with `\r` + erase-line and
re-renders when the newline arrives — and that erases **one visual row**, so a line
that wrapped leaves the rest of itself on screen. Two honest options:

- **Line-at-a-time.** Buffer until the newline, render, print. No erase, no residue.
  The cost is that text appears a line at a time rather than a character at a time.
- **Erase the right number of rows.** Keep the immediacy, and compute the rows the
  partial line occupies from `visibleWidth(line) / columns`. This is only correct
  now that `visibleWidth` counts columns rather than characters (alpha.12); with the
  old measurement it would have been wrong for exactly the CJK case that motivated
  the fix.

Recommend the second, because we can now afford it and it is the version that feels
like clio. Recommend shipping the first anyway if the second is not ready — either
beats what is there.

**Reasoning.** `reasoning_delta` arrives by the same route and wants the same
treatment, dim and behind a flag. Not designed here; noted so it is not rediscovered.

---

## 2. Tool results you can actually see

**The gap.** A result is one line — `⎿ 1.2 kB` — and a failure is one code —
`⎿ STALE_FILE`. There is no way, ever, to see what a tool returned or what an error
said. clio collapses to one line too, and gives you `Ctrl+O` to expand to a hundred.
Ours is the better default and the worse floor.

**The blocker, stated before the design.** `ToolResultPayload` carries
`toolCallId`, `name`, `isError`, `durationMs`, `contentBytes`, `truncated`,
`errorCode` and `artifactRef`. **It does not carry the content.** That is not an
oversight — session events are persisted and replayed, and tool output is the most
secret-dense thing in the system. So expansion is not a renderer change. It needs
one of:

- **(a) A bounded, redacted `preview` on the payload.** First N bytes after the
  `Redactor`, N small and fixed. This changes a persisted event schema, therefore
  replay, therefore it needs an ADR and a secret-canary test before anything else.
- **(b) Read from `artifactRef`.** Free of schema change, but only populated when
  the output was large enough to spill — which is the opposite of the common case,
  and `V09` (the large-output budget / `artifactRef` invariant) is itself still
  open and exercised by nothing. Do not build on it until V09 closes.

Recommend (a), sequenced after V09 and A15 (unified truncation) rather than beside
them — all three are the same subject and answering them separately is how the
answers end up disagreeing.

**Correction: there is no free version of this.** An earlier draft of this section
claimed that a failing tool could show its error _message_ for nothing, because the
message 'is available to the session'. It is not. `ToolExecutionRecord` carries
`errorCode` and no message, `tool.error`'s payload carries the same, and the comment
above the emission says why in as many words:

> Payload is a code and a count: nothing here carries content, so the §21.2 rule is
> unchanged.

So the error message is on the far side of the same boundary as the result body, and
the cheap item does not exist. Both halves of §2 need (a), and (a) needs an ADR. The
claim was written without checking and is corrected here rather than quietly dropped,
because the sequencing table below was built on it.

**Not `Ctrl+O`.** clio toggles verbose with a keypress because it owns the terminal
in raw mode. We are inside `readline`, which only reads between turns — a keypress
handler would fire while you are typing and be deaf during the turn you actually
wanted to expand. So the toggle is a `--verbose` flag and a `/verbose` control
command, taking effect from the next tool call. A key that works only when it is
useless is worse than no key.

---

## 3. Discoverability: completion

**The gap.** Every control command must be typed blind. The banner's `TIPS` exist
precisely to compensate — that is why each one is phrased as a command you can type
— and a tips column is not a substitute for Tab.

`ControlPlane.commandNames()` already returns the sorted list. The source of truth
exists; only the affordance is missing.

### Option A — readline's own completer (recommended)

`readline.createInterface` takes a `completer`. It gives Tab completion, common-prefix
insertion and a plain multi-column candidate list, for one function:

```text
completer(line) → [matches, line]
  line starts with '/'  → commandNames() filtered by prefix
  otherwise             → no completion (deliberately: see below)
```

Costs nothing structurally, adds no terminal state, keeps every degradation path,
and composes with the input frame that already exists. It is worse-looking than
clio's styled menu and it is the whole of the benefit.

One interaction to test rather than assume: readline prints candidates **below** the
input line, which is where the frame's bottom rule lives. `keepFrame` already
redraws that rule on every keypress; whether it fights the candidate list or fixes it
is an empirical question, and the answer belongs in a test, not in this paragraph.

### Option B — own the line editor

What clio did: 1196 lines of raw-mode editing giving multi-line input, a styled
selection menu, `@file` completion, reverse history search, undo/redo and a kill
ring. It is the largest single UX gap between the two programs and it is also
clio's worst code — untested, and carrying at least six defects we have already
catalogued.

If B is ever opened, these are its acceptance criteria, because they are what clio
got wrong and they will not be rediscovered for free:

```text
1  a line longer than the terminal wraps; \r + erase-line clears one visual row,
   so every cursor calculation must account for wrapped rows
2  measure in columns, not characters — we have visibleWidth for this since
   alpha.12; clio does not, and its input corrupts itself on CJK
3  bracketed paste (\x1b[?2004h), not "the chunk contained a newline". The
   heuristic misfires on a slow paste, and clio's auto-submits it
4  one key-handling path, not two. clio has a keybinding table *and* a parallel
   hardcoded switch, and most of the second is dead
5  restore terminal state on abnormal exit, not only on the clean path
6  it must be testable without a terminal, or it will be untested like clio's
```

**Recommendation: A now, B only behind its own ADR with a budget.** Note that B
also has to argue with the first line of `render.ts`'s header — "no cursor addressing
beyond one line of spinner that erases itself" is currently true, and B makes it
false. That sentence is a claim about the program, and changing the program means
changing the claim deliberately rather than letting it quietly go stale.

---

## 4. Live status, without a scroll region

**The gap.** clio keeps a persistent bottom bar — model, mode, cost, tokens,
session — visible at every moment. Ours prints one status line after each turn.

**Do not copy the mechanism.** clio reserves the bar with `DECSTBM`
(`\x1b[1;{rows-1}r`), which is absolute terminal state: it survives the process, so
a crash between setting it and restoring it leaves the user's terminal broken until
they run `reset`. It is also exactly the cursor addressing spec §1.3 rules out.

**Take the information, not the mechanism.** The spinner line already exists,
already erases itself, already holds live text, and already survives a crash without
a trace. Put the figures there:

```text
⠹ Thinking 12s · 3.2k tokens · $0.0041
⠹ Running Shell 4s · 3.2k tokens · $0.0041
```

The renderer already receives `model.request.completed` with usage and cost. The
spinner already takes a `write` and a clock and is already tested with an injected
one. This is a change to one format string plus a usage field on the spinner, it
carries no new terminal state, and it delivers most of what a persistent bar
delivers — the numbers, while they are changing.

Keep the per-turn `statusLine` as it is. And keep its abstention: it deliberately
prints **no context percentage**, because the authoritative figure lives on the
control-plane host and a second one computed here would disagree with `/status`.
Nothing in this section changes that.

---

## 5. Syntax highlighting inside code blocks

Stage three of §1: it has no meaning until markdown knows where a fenced block
starts and ends.

**The first draft of this document refused it**, on the grounds that clio's nine
hand-written keyword sets would become a new `UNGUARDED` enumeration per language
and an audit cost that recurs forever. That estimate was wrong twice, and the
correction is most of the design:

- **One table, not nine.** The audit's detector is syntactic — a top-level
  `const SCREAMING_SNAKE = [ | { | new Set`. A single `LANGUAGES` record keyed by
  language name is **one** enumeration however many languages it holds, and adding
  the tenth costs nothing further.
- **`CLOSED`, not `UNGUARDED`.** By §1 of the enumeration audit's own taxonomy, a
  keyword set is a vocabulary: there is no second copy in this repository to drift
  from. It is the same verdict a deny list gets. `UNGUARDED` would have claimed a
  mirror that does not exist.

So the recurring cost is one row saying `CLOSED · vocabulary`, and the objection
does not survive.

**The one property that has to be true.** Highlighting must be **presentation and
nothing else**: stripping the SGR codes from a highlighted line must return the input
byte for byte. A highlighter that eats a character, or that reorders one, has
silently altered what the model said — in a program whose entire output surface is
built on the claim that the renderer changes nothing. That is a single test over
every fixture in the table, and it is the test that matters more than any colour:

```text
for every language L and every fixture F:
    strip(highlight(F, L)) === F
```

Add the degenerate cases to the fixtures deliberately: an empty line, a line that is
only a string, an unterminated string, a line containing an SGR sequence already.

**It is a colouring heuristic, not a parser**, and the module header should say so in
those words. Nothing may ever branch on its output.

**Where it lives.** `src/cli/highlight.ts`, exporting one pure function:

```text
highlightLine(line: string, lang: string, p: Palette, state: BlockState) → string
```

`Palette` is threaded rather than imported-and-assumed, so `NO_COLOR`, `--json` and a
pipe turn highlighting off for free — the palette is already a no-op in those cases
and no second switch is needed.

**Carried state, because a stream is not a file.** clio highlights strictly per line,
so a `/* … */` spanning lines, or a Python triple-quoted string, colours as code from
the second line on. The markdown renderer already has to carry `inCodeBlock` and the
fence's language across `text_delta` boundaries; carrying one more field —
`inBlockComment` — costs nothing and removes the most visible class of wrong colour.
Multi-line constructs beyond that (here-docs, template literals with embedded
expressions) are out of scope and mis-colour; say so in the header rather than
pretending otherwise.

**Which languages, and how to choose.** Not "the nine clio has". The list should be
what actually appears in this repository's transcripts, which is knowable rather than
guessed: `ts`/`js`, `json`, `bash`/`sh`, `toml` (our config format — clio has no
entry for it, and it is the single most likely block to appear in a session about
MyCoder), `md`, `diff`, `python`, `rust`, `c` (`native/mycoder-sandbox.c`). Aliases
resolve into the same entry, and an unknown language renders unstyled rather than
guessing — an unknown fence is common and a wrongly-guessed one is worse than plain.

**What each entry holds.** Keywords, type names, the line-comment marker, the string
delimiters, and the block-comment pair when the language has one. That is enough for
keyword / string / comment / number colouring, which is the whole of the benefit; a
highlighter that tries to distinguish a function name from a variable needs a parser
and is out of scope by the paragraph above.

## 6. What is deliberately not taken

```text
the persistent bottom bar   §4. The mechanism leaks terminal state on a crash
                            and is the addressing spec §1.3 forbids

the raw-mode line editor    §3, Option B. Not "no", but "not without an ADR"

a parsing highlighter       §5 colours keywords, strings, comments and numbers.
                            Anything that needs to know a function name from a
                            variable needs a real parser per language, which is a
                            dependency (ADR-0009) or a second implementation of
                            nine grammars. The colour is not worth either

clio's permission model      `Allow Bash? [Y]es/[n]o/[a]lways` defaults to yes,
                            names a tool class rather than an action, and grants
                            that whole class forever. The *shape* of our prompt has
                            since changed (§6) but none of that has: the semantics
                            were already the better design by a wide margin
```

---

## 6. The approval prompt, as a menu

Not from clio — clio's permission prompt is the worst thing in its terminal surface,
and none of its _semantics_ are taken. What changed is the shape, and it changed
because typing `y`, `s`, `n` or `d` requires knowing in advance what four letters do.
`[y]` and `[s]` are indistinguishable on sight, and the difference between them is
how long the grant lasts, which is the entire decision.

So the four answers are a list moved through with the arrow keys, the highlighted one
in blue, Enter to confirm. Four, not three: `No, and don't ask again` is an answer
somebody may be relying on, and dropping it would have made the menu tidier by
removing a capability.

Three properties carried over from the typed prompt, none of them cosmetic:

- **The default is still denial.** The highlight starts on `No`, not on the first
  item. Enter without reading the box granted nothing before and grants nothing now.
- **Abandoning is denial.** Escape and Ctrl-C resolve to deny-once rather than
  leaving the turn hanging or falling through to the first item.
- **No terminal means no menu.** A piped or scripted run keeps the typed prompt.
  `select` has no fallback of its own and refuses instead, because the one thing a
  menu must never do is answer a security question by itself.

The widget is `src/cli/select.ts`, split into a pure half (`parseKeys`, `renderMenu`)
and a stream half, so the part with the logic is tested without a terminal. It is
still not the TUI §1.3 rules out: no alternate screen, no absolute positioning, and
every redraw is "up N rows, rewrite N rows" — the relative technique
`redrawBottomRule` already used. The one invariant that keeps that honest is that the
menu occupies exactly one row per item, so labels are cut to the terminal width
rather than allowed to wrap; a wrapped row would make the up-N count a lie and the
next redraw would clear a line of something else.

The resume picker (`-r`) still asks for a number. It is the obvious second caller for
this widget and was left alone: it is not a security decision, and it was not what
was asked for.

---

## 7. Sequence, and what needs an ADR

| #   | Item                                                | Blocked on | Needs an ADR?                                                                                                 | State               |
| --- | --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | ~~Error message line on a failed tool result~~ (§2) | —          | **withdrawn** — the message is not in the record; see the correction in §2                                    | withdrawn           |
| 2   | Streaming text to stdout, raw (§1)                  | nothing    | no — no new event, no new flag; but `docs/cli-contract.md` gains a sentence about when the answer is streamed | **done**            |
| 3   | Live figures on the spinner line (§4)               | nothing    | no                                                                                                            | **done**            |
| 4   | Markdown over the stream (§1, stage 2)              | 2          | no                                                                                                            | **done**            |
| 5   | Completion via readline's completer (§3A)           | nothing    | no                                                                                                            | **done**            |
| 6   | Syntax highlighting in code blocks (§5)             | 4          | no — one `CLOSED` row in the enumeration audit, and the round-trip test                                       | **done**            |
| 7   | Expandable tool results (§2a)                       | V09, A15   | **yes** — persisted event schema, replay, secret canary                                                       | **done** — ADR-0031 |
| 8   | Owning the line editor (§3B)                        | —          | **yes** — and it invalidates a claim in `render.ts`'s header                                                  | **done** — ADR-0032 |

Items 1–6 are each small, independent of everything except the dependency named,
and none of them adds a capability in the `AccessRequest` sense. They are still
**new user-visible behaviour**, so none may land while ADR-0027 §5 holds. Item 7
should not be started before V09 and A15 are answered, and item 8 should not be
started at all without someone deciding it is worth a milestone.

One bookkeeping consequence, so it is not a surprise at the gate: item 6 adds
`LANGUAGES` to `src/cli/highlight.ts`, and `pnpm mirrors` fails the build until
`docs/alpha12-enumeration-audit.md` gains its row and the headline count goes from
99 to 100. The row is `CLOSED · vocabulary`; §5 argues why.
