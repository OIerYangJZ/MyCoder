# Using MyCoder

A walk through a real working session, in the order you meet things.

```sh
npm install -g mycoder-cli@alpha    # the package is mycoder-cli; the command is mycoder
# or
brew tap OIerYangJZ/mycoder && brew trust OIerYangJZ/mycoder && brew install mycoder

mycoder doctor
```

`docs/installing.md` covers the rest of getting it onto the machine and a provider
configured; this picks up from there and assumes `mycoder doctor` says **ready**. If
it does not, stop here — `doctor` names the file to create and the command that
proves it worked, and nothing below will make sense until it passes.

---

## 1. The first screen

```sh
cd your-project
mycoder
```

You get a banner and a prompt. The banner is not decoration — it is the session's
disclosure, and two of its lines are the ones to actually read:

```text
╭──────────────────────────────────────────────────────────────────────╮
│ ✻ MyCoder                                                      0.1.0 │
├──────────────────────────────────────────────────────────────────────┤
│ model      deepseek                                                  │
│ profile    workspace-dev                                             │
│ approvals  manual  (Shift-Tab cycles)                                │
│ isolation  policy only                                               │
│ cwd        ~/your-project                                            │
╰──────────────────────────────────────────────────────────────────────╯

  Policy is not a sandbox. Subprocesses are not OS-isolated: a process
  that runs can still reach the filesystem with your user rights.
```

**`profile`** is the ceiling on what this session can ever be approved to do.
**`isolation`** is what stops a command that gets approved anyway. On a plain
`mycoder` those are `workspace-dev` and `policy only`, which means: the policy
engine decides every tool call, and once a subprocess is running, nothing is
watching it. That is stated on the first screen rather than in a footnote because
it is the sentence people are surprised by later.

Type `/status` at any time to get the same information plus what has happened
since.

---

## 2. What you can type

Four kinds of line, told apart by their first character:

| You type          | What happens                                                                           |
| ----------------- | -------------------------------------------------------------------------------------- |
| `fix the parser`  | a task — goes to the model, which works until it is done or you stop it                |
| `@src/parser.ts`  | the file's contents travel with your message (up to 32 kB / 800 lines, then truncated) |
| `/status`         | a control command — the **kernel** answers it; the model never sees the command itself |
| `!npm test -- -w` | shows you how that line parses into argv. It does **not** run it                       |

`@` and `/` both complete on **Tab**: `/` offers control commands, `@` offers
paths under the workspace (`node_modules`, `.git`, `dist`, `build`, `coverage`
and `.mycoder` are skipped). An `@` pointing outside the workspace, or at
something that is not a file, stays literal text and says so on stderr rather
than failing.

`!` is deliberately inert. It exists so you can check what a command _would_
parse as before handing it to the agent as a task — the escalation to a real
shell is something you ask for explicitly, not something a leading character
does for you.

### The keys

| Key                 | What it does                                               |
| ------------------- | ---------------------------------------------------------- |
| **Enter**           | send                                                       |
| **Ctrl-J**          | newline without sending — a multi-line task is one message |
| **Shift-Tab**       | cycle the approval mode                                    |
| **Tab**             | complete a `/command` or an `@path`                        |
| **↑ / ↓**           | history; ↓ comes back to what you were typing              |
| **Ctrl-R**          | reverse history search                                     |
| **Ctrl-A / Ctrl-E** | start / end of line                                        |
| **Ctrl-W**          | delete the word before the cursor                          |
| **Ctrl-U / Ctrl-K** | delete to start / to end                                   |
| **Ctrl-Y**          | paste back what the last kill deleted                      |
| **Ctrl-Z**          | undo an edit to the line                                   |
| **Ctrl-L**          | redraw                                                     |
| **Ctrl-C**          | abandon the line — or, during a turn, cancel the turn      |
| **Ctrl-D**          | end the session                                            |

Pasting many lines pastes them; the newlines inside a paste do not submit.

---

## 3. Approvals

The first time a turn wants to do something the profile does not simply allow,
it stops and asks. This is the screen the whole design is pointed at, so it is
worth reading once slowly:

```text
╭──────────────────────────────────────────────────────────────────────╮
│ ✻ Approval required  high risk                                       │
│                                                                      │
│   tool      : Shell                                                  │
│   action    : Run npm install zod                                    │
│   command   : npm install zod                                        │
│   directory : .                                                      │
│   scope     : this call only, or the rest of this session for        │
│     exactly this action                                              │
╰──────────────────────────────────────────────────────────────────────╯

    1. Yes
    2. Yes, and don't ask again for: Run npm install zod
  ❯ 3. No
    4. No, and don't ask again for: Run npm install zod
    5. No, and tell it what to do differently
```

Move with the arrow keys, confirm with Enter. Three things are true of it and
none are accidental:

- **The highlight starts on `No`.** Pressing Enter without reading grants
  nothing.
- **Escape and Ctrl-C are `No`.** Walking away from the question is a refusal,
  not a hang and not a fall-through to the first item.
- **The lasting answers name what they remember**, and it is the _action_ — `Run
npm install zod` — not the tool. A session-scoped yes covers that one subject;
  the next `Shell` call is a fresh question.

Answer **5** and it asks for one line, which is sent to the model as the reason
for the refusal. Use it. Refusing without it means the model knows only that it
was blocked and will guess at the alternative; `use pnpm, not npm` costs you four
words and saves a step.

Without a terminal — a pipe, a script — you get the typed prompt instead
(`y` / `s` / `n` / `d` / `r`), and `--non-interactive` denies everything without
asking.

`/permissions show` lists what is in force. `/permissions explain <subject>`
reports a session-scoped decision you have already given, for a subject or a tool
call id — useful when something stopped asking and you want to know what you
agreed to. `/permissions reset-session` forgets all of them.

---

## 4. Modes: who answers the approval

**Shift-Tab** cycles four, in this order:

| Mode           | Answers on your behalf                      | Use it when                                                            |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `plan`         | nothing, and denies mutating tools          | you want it to look and think before anything changes                  |
| `manual`       | nothing — every approval reaches you        | the default; you are watching                                          |
| `accept-edits` | `file.write`                                | you have agreed the plan and the edits are the busywork                |
| `auto`         | `file.write`, `file.delete`, `process.exec` | a scratch repo, a long mechanical task, and you accept the consequence |

Mode is not permission. A mode can only answer a question the profile already
allowed to be asked — it never widens what is reachable, and nothing in this list
turns a `deny` into an `allow`.

`plan` is the one worth being precise about: it denies the mutating tools
outright, and no approval can reach them. It does **not** stop a shell command
from being asked about, and an approved command is a subprocess the policy engine
cannot follow once it starts.

---

## 5. A task, end to end

```console
❯ the CSV importer drops rows with quoted commas. find it and fix it, then run the tests

✻ Thinking
  the parser is probably splitting on comma before handling quotes; look at
  the importer and its tests first

⏺ Grep(csv in src)
  ⎿  312 B
⏺ Read(src/import/csv.ts)
  ⎿  4.0 kB

The split is on line 34: `line.split(',')` runs before any quote handling, so a
quoted field containing a comma becomes two fields and the row is discarded by
the arity check on line 51.

⏺ Edit(src/import/csv.ts)
  ⎿  186 B
⏺ Shell(npm test)
  ⎿  1.2 kB

All 34 tests pass, including the two that were failing.

✻ Worked for 41s
  read 1 file, searched for 1 pattern, ran 1 shell command, edited 1 file
  deepseek · 66k ctx · 5 requests · 22.1k tokens · $0.0031
```

Reading that screen:

- `⏺` is a call, `⎿` is its result, and by default the result is just how much
  came back. Results are keyed to the call they answer rather than to their
  position: when a step issues several calls at once they come back in completion
  order, and each result then names its own call, because position no longer says
  which is which.
- The `✻ Thinking` block is the model's reasoning, where the provider sends any.
  It goes to **stderr**, not to stdout, because it is the model working rather
  than the model concluding. `/thinking off` or `--no-thinking` silences it.
- The footer is counted from the session's own event log, not from the model's
  summary of itself. If it says it edited one file, one file was edited.
- Anything **refused** is counted separately from anything done, so a turn that
  got blocked cannot read as a turn that succeeded.

While a turn runs, the spinner line carries the live figures and the key that
stops it:

```text
✻ Thinking… (12s · 4.8k tokens · $0.0041 · ctrl-c to interrupt)
```

---

## 6. Seeing what it actually did

```sh
/diff             # every edit this session made, oldest first
/diff last        # just the last turn's
/diff src/csv.ts  # just that file's
```

`/diff` reads the same journal `/undo` reverse-applies, so what it shows and what
can be undone are the same set by construction. A change it cannot show is a
change `/undo` cannot reverse either, and it says so rather than omitting it.

```sh
/undo                  # the last edit
/undo last 3           # the last three
/undo turn             # everything the last turn changed
/undo path src/csv.ts  # every edit to that file
/undo list             # what is on the journal, newest first
```

An undo is all-or-nothing, and it always reports what it did **not** cover — a
shell command's side effects, and anything from before the journal starts. It
goes through the policy engine like any other edit, so `/undo` cannot reach
something the model's own `Undo` could not.

To see what a tool actually returned rather than just its size:

```sh
/verbose on
```

That attaches a bounded, redacted preview — 2 kB and 20 lines — **from the next
call**. It cannot show you the result you just read: with the preview off, the
bytes were never captured. Start a session with `--verbose` if you know you want
them.

---

## 7. Longer work

**Say what "done" means.**

```sh
/goal set make the CSV importer RFC 4180 compliant
/goal criteria every existing test still passes
/goal criteria quoted commas and escaped quotes both round-trip
```

The objective and the criteria are shown to the model on every step, so it does
not drift. Be clear about what that is and is not: **the kernel does not check
criteria.** They are prose, and the only thing here that reads prose is the model
whose stopping decision they are meant to shape. `/goal status` says so on the
same screen it prints them.

**Let it keep going, with a stop that is enforced.**

```sh
/loop start --max-steps 40 --max-time 20m --max-cost 1.50
```

That budget _is_ arithmetic the kernel does, and the turn stops when it runs out
whatever the model thinks. `/loop stop` ends it. This is the difference worth
internalising: the budget is a hard stop, the criteria are not.

**Watch the context.** The status line stays quiet until the conversation is
using 60% of what the model can actually hold, then says so:

```text
deepseek · 66k ctx (74% used) · 12 requests · 88.4k tokens · $0.0142
```

Yellow is "there is still room to finish"; red past 90% means compaction is close
enough to change what the next turn remembers. `/compact` summarises the older
conversation on demand, and reports when it could not.

**Switch models mid-session.** `/model list`, `/model use <alias>`. It takes
effect on the next step, and if the new model's window is smaller than the
conversation you are told before the switch rather than after the failure.
`/effort low|medium|high|xhigh|max` sets how hard it thinks, where the provider
supports that.

---

## 8. Narrowing a session

Three profiles, composed by intersection — a profile can only ever take away:

| `--profile`     | What it is                                                                             |
| --------------- | -------------------------------------------------------------------------------------- |
| `read-only`     | Inspect the workspace. No writes, no network, no VCS mutation.                         |
| `review`        | Read and run verification commands. No writes, no network.                             |
| `workspace-dev` | Edit the workspace and run local verification. Network and VCS mutation ask. (default) |

```sh
mycoder --profile review "does this PR handle the empty-input case?"
mycoder --read-only "explain how auth works in this codebase"
```

`--read-only` is a hard narrowing and beats `--profile`. If you pass both and
they conflict, the run **stops** with exit `2` rather than picking one — either
guess would run the session under permissions you did not ask for.

---

## 9. Running it somewhere other than here

```sh
mycoder --remote devbox           # tools run on a configured SSH host
mycoder --backend container       # tools run in a container
```

`--backend container` is a requirement, not a preference: if the runtime is
unusable the session **fails to start**. There is no `--backend auto`, because
"try the container and fall back" is the silent degradation of a security
decision. The same is true of `--backend linux-native`, which is experimental and
needs `mycoder build-sandbox` on the machine that will run it.

Whatever you pick, `/status` reports what that backend actually enforces, per
dimension, from the backend's own descriptor — not from a claim the CLI makes
about it. The row to look at is **host file broker**: `Read` and `Edit` are
trusted kernel operations on your real filesystem, and no backend in this product
containerises them.

---

## 10. Scripting it

```sh
mycoder --json --non-interactive "run the test suite and summarise failures"
```

`--json` puts one object per line on **stdout** and nothing else; all the chrome
goes to stderr, so `mycoder … | jq` never has to filter prose out of its input.
`--non-interactive` denies anything that would have asked, instead of hanging on
a prompt nobody is there to answer.

Branch on the exit code, not on the text:

```text
0  ok            1  incomplete   2  usage
3  config        4  denied       5  unavailable    6  internal
```

`1` is the model giving up, running out of budget, or the turn being cancelled —
the run worked, the task did not finish. `3` is your config file, `5` is your machine. There is nothing
above `6`.

Sessions are an append-only event log, so you can pick one back up:

```sh
mycoder -c                        # continue this workspace's most recent session
mycoder -r                        # list them by what each was asked, and pick
mycoder -r <session-id>           # resume that one
```

Resume rebuilds the edit journal from the log, so an undo survives a crash, and
synthesises results for tool calls that were interrupted. Both are scoped to the
current workspace: a session recorded elsewhere cannot be resumed into this one.

---

## 11. When something goes wrong

**It will not start.** `mycoder doctor`. It reaches one of exactly two
conclusions — ready, or blocked naming the file to create and the command that
proves it worked. It builds no session and writes nothing, which is what makes it
safe to run when nothing else works.

**It is doing the wrong thing.** Ctrl-C cancels the turn (not the process — the
turn still closes its tool calls and flushes its log). Then `/diff` to see what
it managed to change, and `/undo turn` to put it back.

**It keeps proposing things that get denied.** Look at `/permissions show`. The
model is told which profile it is under and that approvals are expected, but not
the rule table — so a profile narrower than the task produces exactly this, and
the answer is a different profile rather than a stream of approvals.

**Its answer contradicts the tool output.** Turn on `/verbose` and re-run the
step. The result lines carry a byte count by default; the preview carries what
was actually returned.

**Something is slower or more expensive than expected.** `/status` breaks down
requests, tokens and cost, and reports cost as `unknown` rather than `$0.0000`
when the model profile has no pricing — a zero that means "unpriced" is the kind
of number that gets believed.

---

## Where to go next

- `docs/installing.md` — platforms, tiers, the native sandbox, uninstall
- `docs/releasing.md` — how a release is cut, published and checked
- `docs/configuring-a-provider.md` — every field, and local models
- `docs/cli-contract.md` — what will not change inside `0.1.x`
- `docs/threat-model.md` — what this defends against, and what it does not
- `docs/web-access.md` — enabling `WebFetch`, and why it is off by default
- `docs/development.md` — for changing the kernel rather than using it
