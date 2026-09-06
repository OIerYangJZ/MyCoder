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
treatment, dim and behind a flag. Designed and built in §10, which differs from this
recommendation on one point and says why.

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

> The glyph and the layout both moved in §8 — the line reads
> `✻ Thinking… (12s · 3.2k tokens · $0.0041 · ctrl-c to interrupt)` now. The
> argument above is about _where the figures go_, and that part is unchanged.

The renderer already receives `model.request.completed` with usage and cost. The
spinner already takes a `write` and a clock and is already tested with an injected
one. This is a change to one format string plus a usage field on the spinner, it
carries no new terminal state, and it delivers most of what a persistent bar
delivers — the numbers, while they are changing.

Keep the per-turn `statusLine` as it is. And keep its abstention: it deliberately
prints **no context percentage**, because the authoritative figure lives on the
control-plane host and a second one computed here would disagree with `/status`.
Nothing in this section changes that.

> §11 revisits this and shows the share after all — by taking the host's figure
> rather than computing one, which removes the reason for the abstention instead of
> overruling it.

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

So the answers are a numbered list moved through with the arrow keys, the
highlighted one in the accent and the rest in grey, Enter to confirm. `No, and
don't ask again` is kept even though the menu would be tidier without it: it is an
answer somebody may be relying on, and dropping it would have removed a capability
to improve the look of a list.

The fifth answer, `No, and tell it what to do differently`, is the only one that
asks a follow-up. Refusing used to be a dead end — the model was told the call was
denied and nothing else, so it guessed, and the usual way to steer it was to let the
turn fail and start another. But somebody declining a command almost always knows
what they wanted instead. What is typed becomes `ApprovalOutcome.reason`, which
`src/tools/runtime.ts` already appended to the denial the model sees; the prompt was
the missing half. An empty answer is a plain refusal rather than an empty reason, so
changing your mind about explaining does not trap you in the prompt.

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

---

## 8. The visual pass — colour depth, the input box, and the things that were wrong

Written after items 1–8 landed, and unlike everything above it this section is not a
proposal: it describes what is in `src/cli/` now. Its trigger was an aesthetic
request rather than a defect report, which is worth saying plainly — but a pass over
a surface for how it _looks_ found four things that were also simply wrong, and
those are the ones this section spends its length on.

**The accent was blue, and is a warm terracotta (#d97757).** The change of hue is
taste. What is not taste is that the old palette had one depth: sixteen ANSI codes,
written as literals at every call site. `Palette` now carries a `ColourDepth`, `INK`
holds every colour at 4, 8 and 24 bits in one table, and `colourDepth()` reads
`COLORTERM`, `TERM` and `TERM_PROGRAM` to decide which column to use. The two
mistakes are not symmetric — guessing too high writes a truecolor sequence into a
terminal that prints it as garbage, guessing too low costs a duller accent — so
detection errs downward, and Apple's Terminal.app is deliberately treated as 8-bit
rather than letting it approximate a 24-bit sequence itself. `colourEnabled` still
decides the yes/no, so `NO_COLOR` keeps winning over everything.

`palette(true)` still means "four-bit", so every caller that has not measured its
terminal behaves exactly as before.

**The sent line was a slab of `47;30`, which is not inverse video.** §3's shape had
the user's own line redrawn under the prompt in inverse — except that `47;30` is
black-on-white _hardcoded_, not a swap of the user's own colours. On a dark terminal
it was the brightest thing on screen, brighter than the model's answer, drawing the
eye to the one line whose contents the reader already knows; on a light one it was
grey on grey. It also ran a column past the text at each end, so the width of the
slab varied with the length of what was typed. It is now `❯` in the accent with the
text left alone: the same question — which lines were mine — answered from the
corner of the eye, at a cost of one column. Every line of a multi-line send is
marked, which the slab did not do either.

**The input frame is closed on all four sides.** §3B shipped a top and bottom rule,
and `render.test.ts` recorded the reason as a test: "a right-hand border would need
the input line rewritten on every keystroke, which is the TUI spec §1.3 rules out."
Both halves of that were wrong by the time it was written. ADR-0032 replaced
readline with an editor that rewrites every row of its block on every keystroke
already, so the sides cost nothing extra; and §1.3 rules out an alternate screen and
absolute positioning, which a box drawn with relative moves is not. That claim
survived because it was written as a passing test, which is the most durable place a
stale claim can hide — a test asserting a thing is true is indistinguishable, from
the outside, from a test asserting it is _right_.

What the sides do cost is four columns of content width, and that is where the risk
lives: rows laid out against the terminal's width rather than the box's run under
the closing border. `viewport` subtracts the gutter in one place, `renderEditor`
pads by display columns so CJK closes the box where ASCII does, and there are cases
for both. The bare rule survives as `inputRule` and is still what a pipe and
`--no-colour` get — the frame is drawn only where it is being drawn live.

**The approval menu is numbered.** `approvalChoices` has said in its own comment
since it was written that "the answers are numbered as well as lettered", and that
was true of the typed prompt and of nothing else: `renderMenu` drew four unnumbered
rows. It is a small drift and exactly the kind this repository keeps finding — a
comment describing a sibling function's behaviour, correct when written, never
checked again. The unselected rows are also grey now rather than unstyled, because
four plain rows and one bold one makes the reader find the heavy row among equals.

**Smaller things, in one list.** The spinner is a star that swells and settles
rather than a Braille wheel — the same mark as the `✻` a finished turn prints, and a
dingbat rather than U+280B, which a font without a Braille face renders as a
replacement box of a _different width_, so the line the spinner erases is not the
line it drew. The verb rotates per turn, from a list of plain gerunds; a fixed
`Thinking` for ninety seconds reads as a hang. §4's figures moved into a bracket and
gained `ctrl-c to interrupt`, because the interrupt key is not discoverable while a
turn is in flight and the spinner is the only thing on screen during the window in
which somebody wants it. The banner's title moved to the left edge with the version
at the right; a centred title over a hard-left column of labels has nothing to line
up with. Headings in the model's answer are now distinguishable by level. And the
approval box's label column is padded from the widest label the request actually
produces, rather than by hand — `delegation:` is ten characters where `tool     :`
is nine, so the one screen a user is _required_ to read had its colons out of line
in exactly the delegated case, which is the one that has to be read most carefully.

**What did not change.** No new terminal state, no alternate screen, no absolute
positioning, no dependency. Every escape sequence is still relative and still
written out in `render.ts`. The isolation line, the caveat, the deny-by-default
highlight and the abstention from a context percentage are all untouched: nothing
here trades a claim for an appearance.

| #   | Item                                                        | Needs an ADR?                                                    | State    |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------- | -------- |
| 9   | Colour depth detection and the warm accent (§8)             | no — no new capability, no new terminal state                    | **done** |
| 10  | The input box, closed on four sides (§8)                    | no — ADR-0032 already owns the block; this changes what it draws | **done** |
| 11  | The sent line as a margin mark (§8)                         | no                                                               | **done** |
| 12  | Numbered menu rows, and the label column that lines up (§8) | no                                                               | **done** |

---

## 9. Tables

Everything else in `markdown.ts` renders one input line to one output line, which is
what lets it stream: a line arrives, it is drawn, it is gone. A table cannot do that.
Its column widths are a property of the whole block, so the first row cannot be drawn
until the last one has been read. Until this section, the fallback was to print the
source — rows of raw pipes, ragged, and worse than useless in the one construct a
model reaches for when it has something _comparable_ to say.

So the table is the single thing the renderer buffers. A row is held as a candidate
for exactly one line to find out whether a delimiter row follows it; if one does the
block is collected, and if one does not the candidate is printed as the ordinary line
it always was. That one-line latency is why the detection can afford to be permissive
— `a | b` in a sentence is a candidate and costs nothing, because prose is never
followed by `| --- | --- |`.

Having bought the buffering, the width is worth spending it on:

- **Columns are squeezed longest-first** until the frame fits `columns() - 1`, and a
  squeezed cell is cut with an ellipsis rather than wrapped. The cut is escape-aware:
  it copies sequences through without charging them width, and writes a reset when it
  cuts, because the cut may have thrown away the reset that closed a span — and the
  next thing that would have closed it is the end of the answer, so the frame, the
  rest of the row and everything after it would have come out cyan.
- **Below the floor it stops being a table.** Four columns on a phone-width terminal
  cannot be drawn at any width; wrapping one puts the borders through the middle of
  the text, which is worse than the raw pipes this replaced. Under `4` columns of
  room per column the block is re-rendered as one record per row, each field under
  its own heading. The data survives the frame.
- **Alignment comes from the delimiter row**, `:---`, `---:` and `:---:`, because a
  model that bothered to write them meant them, and a column of right-aligned numbers
  is the case where it matters.

Three glyphs were added — `topTee`, `bottomTee`, `cross` — with ASCII fallbacks, on
the same rule as the rest of the set. No new terminal state: the block is still
written top to bottom and never revisited.

| #   | Item                              | Needs an ADR?                                                 | State    |
| --- | --------------------------------- | ------------------------------------------------------------- | -------- |
| 13  | Tables in the model's answer (§9) | no — a rendering of bytes already arriving, as §1 already was | **done** |

---

## 10. Reasoning

`reasoning_delta` has arrived beside `text_delta` since the model layer was written,
and §1 rendered one of them. So a reasoning model spent forty seconds behind a
spinner that said `Thinking` and nothing else, while the bytes that would have said
what it was thinking about were being decoded, forwarded, and dropped by the
renderer's `default: return`.

§1 recommended "dim and behind a flag". Dim, yes. Behind a flag, no: **on by
default**, with `--no-thinking` and `/thinking off` to turn it off. A flag that is
off by default leaves the deltas dropped for everyone who never learns the flag
exists, which is the same outcome as not building it. The negative form is the
honest one — showing what arrived is the fix, and hiding it is the preference.

Three ways it is deliberately not §1's stream:

- **It is chrome, so it goes to stderr.** The answer is the payload and goes to
  stdout; `mycoder … > answer.md` must contain the answer and only the answer. The
  model itself is clear that reasoning is it working, not it concluding.
- **It is a line at a time, and never erased.** §1 buys immediacy with an
  echo-then-erase that is only correct below the wrap point. Reasoning is not worth
  that risk: a complete line is printed once, and until the newline arrives the
  spinner says exactly what it says today. The floor is the current behaviour.
- **It is not markdown.** Reasoning is a model talking to itself. Running a heading
  renderer over it would style whatever punctuation it happened to reach for. It is
  one grey column under a `✻ Thinking` mark — the same mark the spinner uses, so the
  block reads as the spinner's line growing rather than as a new kind of output.

The working is closed before the conclusion starts: a `text_delta` flushes the
reasoning block first, so the two never interleave even though they arrive
interleaved. It is still model bytes, so it is still sanitised by the same function
§1's text is.

`/thinking` reaches the renderer through a callback the kernel is given, not through
anything the kernel draws — and where no callback was supplied, `/thinking` reports
that there is nothing to show reasoning on rather than flipping a boolean nobody
reads. That is the same shape `/verbose` already had, and the same reason.

| #   | Item                               | Needs an ADR?                                         | State    |
| --- | ---------------------------------- | ----------------------------------------------------- | -------- |
| 14  | The model's reasoning, shown (§10) | no — a rendering of bytes already arriving, as §1 was | **done** |

---

## 11. Context pressure, without a second estimate

§4 refused a context percentage, and the reason was right: the authoritative figure
is `ControlHost.contextUsage()`, and a percentage computed in the renderer would be a
second estimate that disagrees with `/status`. That argument is against _computing_
one, though, not against _showing_ one. So `ControlPlane` exposes the same call
`/status` makes, `main.ts` passes what it returns into `StatusInfo`, and the line
shows the host's number or none at all. There is still exactly one estimate.

Two things it does not do:

- **It is silent below 60%.** A percentage on every turn is a number a reader learns
  to stop seeing, and then it is not there on the turn that mattered. The share
  appears when it is news: yellow while there is room to finish, red past 90%, where
  compaction is close enough to change what the next turn remembers.
- **It measures against the usable budget, not the window.** The reserved output is
  not available to the conversation. Measuring against the raw window would
  under-report by exactly the reservation — and would then disagree with `/status`,
  which is the thing this whole section is about not doing.

The share joins the window it is a share of — `200k ctx (74% used)` — rather than
becoming a second field, so the line does not grow and the number says what it is a
number of.

| #   | Item                                      | Needs an ADR?                                                    | State    |
| --- | ----------------------------------------- | ---------------------------------------------------------------- | -------- |
| 15  | Context pressure on the status line (§11) | no — one existing figure, read by a second reader, computed once | **done** |

---

## 12. Expanding a result after the fact — why this is still not done

`/verbose` attaches a bounded, redacted preview to every tool result **from the next
call**. That is the whole of it, and it is a worse fit for the moment somebody reaches
for it than it looks: the reason to want a preview is a result already on screen, and
that result was executed with the preview off, which means the bytes were never
captured. Turning it on and watching nothing appear reads, from outside, as a broken
feature.

Two halves, and only one of them is closed here:

- **Closed.** `/verbose` now says `from the next call`, and turning it off says that
  results already on screen keep what they were shown with. A test asserts both
  sentences, and a second test asserts the fact underneath them — that a call made
  before `/verbose on` carries no preview on its record.
- **Not closed.** Making it retroactive means retaining redacted previews for calls
  the user did not ask to preview. The content already exists in memory for the
  duration of the step, so the increment is _lifetime_, not exposure — but a
  retention window for tool output is a security-relevant default, `ToolExecutionRecord`
  documents the current one in as many words ("off means the bytes were never put
  here"), and §2 already sequenced this behind V09 and A15 with an ADR. It is not
  something to change in a rendering pass.

Recorded here rather than left as a known-worse experience nobody wrote down.

| #   | Item                                    | Needs an ADR?                                       | State    |
| --- | --------------------------------------- | --------------------------------------------------- | -------- |
| 16  | `/verbose` states its boundary (§12)    | no — a sentence about behaviour that did not change | **done** |
| 17  | Retroactive expansion of a result (§12) | **yes** — a retention window for tool output        | **open** |

---

## 13. Goal criteria — the claim, corrected, and the feature that would justify it

`/goal criteria <text>` appends a line to `GoalState.criteria`, and the projector
shows it to the model. That is the whole mechanism. Nothing evaluates it, nothing
can: the criteria are natural language, and the only thing in the system that reads
natural language is the model whose stopping decision they are supposed to constrain.

`/loop start` said the turn stops "when the budget or the goal criteria are met".
The first half is arithmetic the kernel does. The second half is prose the model is
shown. Saying them in one breath promises a stop nothing implements — and a user who
sets a criterion and walks away has been told the kernel is watching for them. That
sentence is now two, and they say which is which. `/goal criteria` and `/goal status`
say the same thing at the two other points somebody reads it.

**What would make the original claim true.** Not a model evaluating its own criteria
— that is the same trust boundary in a new place. A criterion the _kernel_ can check
has to be something the kernel can run: a command and an expected exit code, checked
by the existing tool runtime under the existing policy engine, with the result
projected as a fact rather than as a request. `pnpm test` exiting `0` is a criterion.
`the parser is finished` is not, and no amount of plumbing makes it one.

That is a real feature and it needs an ADR, for reasons none of which are rendering:
it runs a command the user did not approve at the moment it runs; it runs after every
step, so its cost is a budget question; and a criterion that fails has to not become
an infinite loop with `/loop`. Left open, and written down as open, rather than
half-built.

| #   | Item                                              | Needs an ADR?                                           | State    |
| --- | ------------------------------------------------- | ------------------------------------------------------- | -------- |
| 18  | `/loop` and `/goal` say who checks criteria (§13) | no — a claim corrected to match the code                | **done** |
| 19  | Verifiable, kernel-checked criteria (§13)         | **yes** — runs commands, on a schedule, inside a budget | **open** |
