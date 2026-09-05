<div align="center">

# MyCoder

**A coding agent kernel — small, verifiable, and explicit about where its security boundaries are.**

**English** · [简体中文](README.zh-CN.md)

<img src="docs/media/demo.gif" width="820" alt="A MyCoder session: a task is typed into the prompt, two files are read in parallel, and the answer streams back with a summary of what the turn did.">

<sub>A real session, recorded on an Ubuntu VM against DeepSeek. Nothing here is a mock-up.</sub>

</div>

---

The goal is not to reproduce a particular product's feature list. It is a kernel
that is **small, verifiable, and explicit about where its security boundaries
are** — and where they are not.

```
User / CLI
    ↓
Control Plane ──────────────────────────────┐
    ↓                                       │
Session / Turn Coordinator                  │
    ↓                                       │
Step Engine                                 │
 ┌──┼──────────────┐                        │
 ▼  ▼              ▼                        │
Context  Model Runtime  Tool Runtime        │
Engine        │              │              │
              ▼              ▼              │
        Egress Gate    Tool.resolve()       │
                             │              │
                             ▼              │
                       Policy Engine        │
                             ↓              │
                      Sandbox Planner       │
                             ↓              │
                      Executor / Backend ◄──┘
                             ↓
                       Audited Result
```

## What a session looks like

Everything below is a screenshot of a terminal, taken with `tmux capture-pane`
during the runs that also produced this milestone's evidence.

**It says what it is before it asks you for anything.** The model, the context
window, the profile, the approval mode, and — the row that is not decoration —
what the isolation actually is, in the words of the backend's own descriptor
rather than a reassuring literal.

<img src="docs/media/banner.png" width="820" alt="The startup banner: model, context window, profile, approval mode, isolation and working directory, with a column of tips beside it and the input box below.">

**A turn shows its work.** One line per tool call and one per result. When a step
calls several tools at once, each result names the call it belongs to — because
they come back in whatever order they finish, and reading them positionally is
not merely unhelpful, it is wrong.

<img src="docs/media/tools.png" width="820" alt="A turn in progress: parallel Read calls, each result line naming the file it belongs to and its size.">

**An approval is a decision, not a confirmation.** It shows what the tool wants
to do, to which files, over which network destination, and how long the grant
lasts. The highlight starts on `No`, and abandoning the prompt means no.

<img src="docs/media/approval.png" width="820" alt="The approval prompt: a framed box listing the tool, action, command, directory, network and scope, with four numbered answers below it and the highlight resting on No.">

**A turn ends by saying what it did**, counted from the events it emitted rather
than from the model's account of itself — and what it was refused, separately,
because a count that includes what did not happen is the dishonest half of a
summary.

<img src="docs/media/turn.png" width="820" alt="The end of a turn: files read, directories listed and files written, then a status line with the model, context window, request count, token count and cost.">

## Installing it

Node **22.18 or newer**, and nothing else — **zero runtime dependencies**
(ADR-0009). See `docs/installing.md` for the supported-platform matrix and the
first-run walkthrough.

```bash
npm install -g ./mycoder-0.1.0.tgz   # the artifact you were given
mycoder doctor                       # ready, or blocked with the exact remedy
```

Building that artifact is a maintainer step, not an install step: `pnpm release:pack`
in a checkout produces the `.tgz` above.

`doctor` reaches one of exactly two conclusions and never a third: ready, or
blocked while naming the file to create, the key to set and how to verify it. It
builds no session and changes nothing on disk, because it is the command you reach
for when `mycoder` itself will not start.

Exit codes are a contract — `3` is your config, `5` is your machine. See
`docs/cli-contract.md`.

## Running it from a checkout

```bash
node bin/mycoder.mjs --help
node bin/mycoder.mjs --print-config
node bin/mycoder.mjs -m fake "fix the failing test"      # offline, scripted model
node --test "tests/**/*.test.ts"
```

A checkout loads `src/*.ts` directly, which needs a Node built with type
stripping. Most are; Debian's and Ubuntu's are not, and the version number does
not say so — `mycoder` checks `process.features.typescript` and tells you which
of the two things is wrong, rather than dying on `ERR_UNKNOWN_FILE_EXTENSION`.
`npm run build` writes `dist/`, which any supported Node can load.

Type checking needs a compiler, the only thing this repo installs:

```bash
pnpm install        # typescript + @types/node, the sole devDependencies
pnpm typecheck
pnpm eval           # the golden tasks from spec §27.2
pnpm package:check  # what the artifact would actually contain
```

Node's type stripping only checks that syntax is erasable, so `pnpm typecheck`
is the only step that verifies types. Run it before opening a PR — CI does.

## What v0.1 does

- Session / Turn / Step lifecycle with an enforced state machine.
- Streaming model runtime over a protocol-neutral IR, with Anthropic Messages,
  OpenAI Responses and OpenAI-compatible Chat adapters — plus a `FakeModel` so
  the whole kernel is testable offline.
- Nine core tools: `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Delete`, `Move`,
  `Shell`, `GitDiff`, all behind the two-phase
  `ToolDefinition → ToolExecution → AccessRequest` contract. `Write` and `Delete`
  need a full-coverage read receipt; deletion is its own capability, so it asks
  where an ordinary write does not (ADR-0016).
- `WebFetch`, registered only when `[egress] web` names a host — GET only, no
  redirects followed, response treated as untrusted input (ADR-0017,
  `docs/web-access.md`).
- Permission profiles (`workspace-dev`, `read-only`, `review`) composed by
  capability **intersection**, so no layer can widen another.
- Secret path deny, content secret scanning, an in-memory secret broker whose
  leases cannot be stringified back into a value, and environment scrubbing.
- A single egress gate for every outbound byte, with per-channel host allowlists
  and a metadata-only telemetry channel.
- A freshness ledger: an `Edit` must cite the `Read` that showed the model the
  region it is changing.
- Atomic writes with unified diffs, rollback metadata and line-ending
  preservation.
- **Undo** — reverse an edit, a turn's edits, or a file's, restoring the exact
  prior bytes. It refuses rather than guessing when a file has changed since, it
  reverses all of a set or none of it, and every result enumerates what it did
  **not** cover: a foreign tool's writes, a shell command's side effects, and
  anything from before the journal starts.
- An append-only session event log that carries every mutation, and resume that
  rebuilds the edit journal from it — so an undo survives a crash — and
  synthesises results for interrupted tool calls. `mycoder -c` continues this
  workspace's last session; `mycoder -r` lists them by what each was asked to do,
  because a session id is not something anybody remembers.
- Control commands (`/model`, `/goal`, `/loop`, `/permissions`, `/status`,
  `/compact`, `/remote`, `/undo` and more — `/help` lists them all) that change
  kernel state directly, never via the model.
- **Approval modes**, cycled with Shift-Tab or set with `/mode`. `manual` asks
  about everything and is the default; `accept-edits` applies workspace edits
  without asking; `auto` also applies deletions and commands; `plan` intersects a
  read-only layer so mutation is _denied_ rather than merely declined. A mode
  only ever answers a question the policy engine already decided to raise, so no
  mode can permit what a layer denied — credentials, network, git history and
  MCP tools ask in every one of them, and privilege escalation stays refused.
  `[security] approval_mode` sets the starting mode, from your config only: a
  repository does not get to decide whether you are asked before its code runs.
- **Thinking effort** as a level rather than a token budget — `low` through
  `max`, per model profile, overridable with `[model] effort` or `/effort`. Each
  profile caps what it will send, so a global `max` cannot hand a small model a
  level it rejects, and a profile that does not think sends no parameter at all.
- Local, SSH and container execution backends behind one interface.
- Skill / agent / hook discovery, where a definition can only narrow.

## The terminal it does all that in

A **renderer, not a TUI**. Spec §1.3 keeps a full TUI as a non-goal, and there is
no alternate screen, no panes and no absolute cursor addressing: every escape
sequence is relative, nothing survives the process, and deleting the renderer
would leave the kernel behaving identically.

Three rules shape all of it. **Zero dependencies** — no `chalk`, no `ink`; the
escape codes are written out in one file with one switch. **Every byte of chrome
goes to stderr**, because stdout is a contract and `mycoder … | jq` must never
have to filter human text out of its input. **Plain when it is not a terminal**,
because styling a pipe writes escape codes into somebody's log file.

Within that: one warm accent, picked at 24-, 8- or 4-bit depending on what the
terminal says it can render; a box around the input that wraps by display column,
so a line of Chinese closes it in the same place a line of ASCII does; markdown
and syntax highlighting over the streamed answer; and live token and cost figures
on the spinner line rather than in a reserved bottom bar, because a scroll region
is terminal state that outlives a crash. `docs/terminal-surface-design.md` has
the reasoning, including the parts that were wrong the first time.

## What it deliberately does not do

MCP marketplace, agent teams, IDE plugins, a full TUI, browser use, embeddings,
PageRank repo maps, model routing, cloud session sync, and a remote daemon. Each
has a place to attach later; none is in the way now.

**And one thing it does not claim.** On the local and SSH backends this is
`policy-enforced`, not `os-isolated`: the kernel controls what tools may request
and redacts everything they emit, but a subprocess that runs can still reach the
filesystem and the network with your user's rights, and "network is off" is
_best-effort_.

`--backend container` (alpha.5, ADR-0014) changes that for the subprocess, and
only for the subprocess. Commands run in a container whose mounts are derived from
the granted capability, with host home and credential directories **absent**
rather than denied, no network unless a capability granted one, a read-only root
filesystem, dropped capabilities and `no-new-privileges`. What it still does not
claim: that `Read`/`Edit` are containerised — they are trusted kernel operations
on the host filesystem, and are reported as `policy-enforced`; that a _host
allowlist_ is enforced when network is granted — it is not, and the approval
prompt says so; or that a VM-backed Docker Desktop is equivalent to a native Linux
engine. `/status` prints one enforcement level per dimension rather than a single
reassuring word, and refuses to say "enforced" for anything that is policy.

## Layout

```
src/
├── cli/          argv parsing, shell-line parsing, the REPL, approval UI
├── control/      slash commands → structured ControlResult
├── session/      session, turn state machine, step freeze, event log, resume
├── model/        protocol-neutral IR, runtime, profiles, adapters/
├── context/      four planes, projector, freshness ledger, compaction
├── tools/        contract, registry, runtime, builtin/
├── edit/         edit engine, exact replace, atomic write, unified diff
├── policy/       access requests, policy engine, profiles, protected paths
├── security/     secret broker, secret scanner, egress gate, env scrub, redactor
├── execution/    backend interface, local, ssh, container (+ plan/validator),
│                 enforcement levels, sandbox planner, mutation detector
├── extensions/   skills, agents, hooks
├── config/       layered configuration, remotes
└── util/         ids, errors, paths, glob, text, toml, json schema, sse, walk
tests/
├── unit/         utilities, policy matrix, adapters
├── security/     canary suite, prompt injection, escalation, egress
└── integration/  the §31 trajectory, control plane, resume
docs/
├── adr/          architecture decision records
├── media/        the screenshots and the recording above
├── web-access.md how to enable WebFetch, and what it will not do
└── threat-model.md
```

## The test that matters most

Spec §31 says the kernel has a skeleton when this passes fully offline:

```
Fake task → Grep → Read → Edit → Shell(fails) → Read → Edit → Shell(passes) → final
```

It is in `tests/integration/agent-loop.test.ts`, and it runs 100 times to check
that no state leaks between sessions.

The second-most-important one is `tests/security/canary.test.ts`: a canary
credential is attacked eleven ways, and must appear zero times in the model
payload, the event log, the network capture, or the logs. Per AGENTS.md rule 10,
if that test fails, everything else stops.

Beyond the tests, the repository checks its own prose: `pnpm mirrors` compares
every enumeration in the code against the document that claims to list it, and
`pnpm evidence` refuses any `PASS` whose named evidence does not resolve.

## Reference repositories

`reference/**` is read-only, enforced by `ProtectedPaths`, and is for
understanding design decisions and edge cases — never for copying internal types
into our public API.
