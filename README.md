# Kernel v0.1

A coding agent kernel implementing `research/kernel_v0.1_technical_spec.md`.

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

## Installing it

Node **22.18 or newer**, and nothing else — **zero runtime dependencies**
(ADR-0009). See `docs/installing.md` for the supported-platform matrix and the
first-run walkthrough.

```bash
pnpm release:pack                    # build the artifact
npm install -g ./mycoder-0.1.0.tgz
mycoder doctor                       # ready, or blocked with the exact remedy
```

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
- An append-only session event log, and resume that synthesises results for
  interrupted tool calls.
- Control commands (`/model`, `/goal`, `/loop`, `/permissions`, `/status`,
  `/compact`, `/remote`) that change kernel state directly, never via the model.
- Local, SSH and container execution backends behind one interface.
- Skill / agent / hook discovery, where a definition can only narrow.

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

## Reference repositories

`reference/**` is read-only, enforced by `ProtectedPaths`, and is for
understanding design decisions and edge cases — never for copying internal types
into our public API.
