# Working on MyCoder

Everything in this file is for people changing the kernel. If you are trying to
_use_ it, `README.md` is the one you want.

## Running it from a checkout

```bash
node bin/mycoder.mjs --help
node bin/mycoder.mjs --print-config
node bin/mycoder.mjs -m fake "fix the failing test"      # offline, scripted model
node --test "tests/**/*.test.ts"
```

A checkout loads `src/*.ts` directly, which needs a Node built with type
stripping. Most are; Debian's and Ubuntu's are not, and the version number does
not say so — `bin/mycoder.mjs` checks `process.features.typescript` and reports
which of the two things is wrong rather than dying on
`ERR_UNKNOWN_FILE_EXTENSION`. `npm run build` writes `dist/`, which any supported
Node can load.

## The checkout toolchain

TypeScript is the only thing this repository installs.

```bash
pnpm install        # typescript + @types/node + prettier, the only devDependencies
pnpm typecheck
pnpm test
pnpm lint           # architecture invariants, not ESLint
pnpm format:check
```

Node's type stripping only checks that syntax is erasable, so `pnpm typecheck` is
the only step that verifies types. Run it before opening a PR — CI does. It is how
a `ReferenceError` in `PolicyEngine.combine` was found, on a path the tests reached
but never executed.

## The gates, from a checkout

CI runs more than the test suite, and each of these can be run alone:

```bash
pnpm eval           # the golden tasks (§27.2), scripted and offline
pnpm evidence       # every PASS in an evidence matrix names evidence that resolves
pnpm mirrors        # every enumeration in the code matches the document listing it
pnpm package:check  # what the artifact would actually contain
pnpm lint:selftest  # the architecture linter's own tests
```

`pnpm mirrors` and `pnpm evidence` are the two that make this repository check its
own prose. A milestone document claiming a test exists, or a list in a document
that has drifted from the list in the code, fails the build rather than quietly
going stale — which is the failure mode most of the corrections in this history
are about.

The remaining CI jobs need hardware this list cannot assume: a native Linux
Docker engine for container enforcement, a Linux kernel with Landlock for the
native sandbox, and an `sshd` for the SSH matrix.

## Building the artifact, from a checkout

```bash
pnpm release:pack   # produces mycoder-0.1.0.tgz
```

That is a maintainer step, not an install step. `pnpm package:check` reports what
would go in, and fails on a packaged document that tells its reader to run
something an installed package does not have.

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
├── integration/  the §31 trajectory, control plane, resume
├── lint/         the architecture linter and the mirror checks
└── live/         the ones needing a real pty, a real sshd or a real engine
evals/
├── tasks/        the golden set
└── experiments/  the utility studies each milestone ran
docs/
├── adr/          architecture decision records
├── media/        the screenshots and the recording in README
└── alpha*/       one status report and one evidence matrix per milestone
```

## The shape of the thing

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

The two-phase tool contract is the load-bearing part:
`ToolDefinition → ToolExecution → AccessRequest`. A tool declares what it wants
before it does anything, so the policy engine decides on a described intention
rather than on a side effect already in progress. Permission profiles compose by
**intersection**, which is what makes "a definition can only narrow" true of
skills, subagents, hooks and foreign tools alike.

## The test that matters most

Spec §31 says the kernel has a skeleton when this passes fully offline:

```
Fake task → Grep → Read → Edit → Shell(fails) → Read → Edit → Shell(passes) → final
```

It is in `tests/integration/agent-loop.test.ts`, and it runs 100 times to check
that no state leaks between sessions.

The second-most-important is `tests/security/canary.test.ts`: a canary credential
is attacked eleven ways and must appear zero times in the model payload, the event
log, the network capture, or the logs. Per AGENTS.md rule 10, if that test fails,
everything else stops.

## The terminal surface

A **renderer, not a TUI**. Spec §1.3 keeps a full TUI as a non-goal, and there is
no alternate screen, no panes and no absolute cursor addressing: every escape
sequence is relative, nothing survives the process, and deleting the renderer
would leave the kernel behaving identically.

Three rules shape all of it. **Zero dependencies** — no `chalk`, no `ink`; the
escape codes are written out in one file with one switch. **Every byte of chrome
goes to stderr**, because stdout is a contract and `mycoder … | jq` must never
have to filter human text out of its input. **Plain when it is not a terminal**,
because styling a pipe writes escape codes into somebody's log file.

`docs/terminal-surface-design.md` has the design and the corrections, including
the claims that were wrong the first time and the one that survived for a while
as a passing test.

## Reference repositories

`reference/**` is read-only, enforced by `ProtectedPaths`, and is for
understanding design decisions and edge cases — never for copying internal types
into our public API.
