# ADR-0022 — MCP client: transports, server declaration, lifecycle

**Status:** accepted · **Date:** 2026-08-16

## Context

Every tool in the catalogue up to alpha.8 shares one property that nobody has had
to think about, because it has never been false:

> The kernel wrote the tool. It knows what the tool touches before the tool runs.

`Read` declares `file.read` with a path the kernel canonicalised. `Shell` declares
`process.exec` with an argv the kernel parsed. `WebFetch` declares
`network.connect` with a host the kernel resolved. The `AccessRequest` is not the
tool's _claim_ about itself — it is the kernel's _derivation_ from arguments it
understands.

MCP breaks that at the root, and this ADR covers the plumbing: what a server is
made of, who is allowed to declare one, and when it lives and dies. What the
policy engine is asked instead is ADR-0023. What the model is told is ADR-0024.

Scope is `tools/list` and `tools/call`. Resources, prompts, roots and elicitation
are more surface for the same trust question. Sampling — a server asking the
_kernel_ to make a model call — inverts the direction of trust this milestone
exists to bound and is excluded on principle, not on schedule.

## Decision

### 1. Two transports, and neither gets a private path

```text
stdio   a program the kernel spawns.  It is a subprocess, and every rule
        alpha.4-alpha.7 established for subprocesses applies without exception.
http    a destination the kernel connects to.  It is egress, and it goes
        through EgressGate like everything else.
```

There is no third thing, no "infrastructure" exemption, and no new network
client. AGENTS.md rule 8 (`scrubEnv`) and rule 9 (no raw network client outside
`EgressGate`) have no carve-out for protocols we happen to like.

**stdio is a subprocess.** It runs under a capability profile, through the
`ExecutionBackend`, with a scrubbed environment, and when a sandbox is selected it
is inside that sandbox. Starting one is a `process.exec` access, declared and
ruled on like any other.

**HTTP is egress.** The host must be in the egress allowlist, the request goes
through `EgressGate.send({ kind: 'mcp' })` — `EgressKind` has carried `'mcp'`
since the first commit with no consumer — and ADR-0017 §23's address check
applies: every resolved address must be global. Starting one is a
`network.connect { via: 'mcp' }` access.

### 2. The backend contract gains a long-lived process (amends ADR-0007)

`ProcessBackend` is `exec(spec) → Promise<ProcessResult>`. That is request and
response: run a command, collect its output, done. A stdio MCP server is the
opposite shape — a process that outlives any single message and is spoken to over
its stdin while it answers on its stdout.

There were three ways to get one and only one of them is honest:

```text
spawn it directly from the MCP client        forbidden. It is precisely the
                                             "shortcut through ExecutionBackend
                                             for convenience" AGENTS.md rule 2
                                             calls a release blocker, and it
                                             would put the most capable
                                             component in the session outside
                                             whatever sandbox the user selected.
fake it with one exec() per JSON-RPC call    not MCP. The protocol is stateful;
                                             `initialize` establishes a session
                                             a later `tools/call` relies on.
extend the backend contract                  chosen.
```

So `ProcessBackend` gains:

```ts
session?(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessSession>;
```

returning a handle with `write()`, an async iterator over stdout chunks, `stderr`
collection, `exitCode`, and `kill()`. It is **optional on the interface** and that
is the load-bearing detail: a backend that cannot host a long-lived process says
so by not implementing it, and the MCP client refuses that backend rather than
falling back to a path around it.

A backend which implements `session()` must give it the same treatment as
`exec()`: the same profile check, the same `assertNoCredentialEnv` gate before
spawn, the same environment, the same sandbox.

### 3. Who may declare a server: user config only

`[mcp.servers.<name>]` in **user config**. The same rule as provider endpoints
(alpha.8 §19.2) and container images (alpha.5 §11), for the same reason and one
step worse.

A project-declared MCP server would let a repository add an **executable** to the
session — one whose tool descriptions go into the model's context and whose
implementation the kernel never sees. That is not a redirection vector. It is
arbitrary code execution with a configuration file's manners.

`loadConfig` drops a project-declared `[mcp]` table and warns, exactly as it does
for providers and images. A project may **reference** a server the user declared,
by name, to narrow which of them this project uses. It may not define one, and it
may not widen.

### 4. Lifecycle: start once, freeze the catalogue, never silently re-list

```text
session start     each declared server is started, `initialize`d, and asked
                  `tools/list` exactly once.
catalogue frozen  the tool set and every description are hashed and kept.  The
                  model is told about that catalogue and no other.
turn cancelled    in-flight calls are aborted and the process tree dies
                  (alpha.7 §31).
next use          the server may be restarted — and its `tools/list` is
                  re-fetched and compared against the frozen hash.
mismatch          the server is disabled for the rest of the session, loudly,
                  and its tools are unregistered.
```

**`tools/list` is a request, not a constant**, and that is the whole reason for
freezing. A session that fetched a benign catalogue and then acted on a different
one has been through a time-of-check/time-of-use gap. `notifications/tools/list_changed`
is recorded in the event log and otherwise ignored: a server may inform us that it
has changed, and the answer is that this session will not follow it.

Disabling rather than adopting is the strict choice, and it is the right one. The
alternative — re-registering the new catalogue — means the tool the model was told
about is not necessarily the tool it calls, which is the property ADR-0024 §13
exists to guarantee.

### 5. A server that will not start refuses the session

alpha.8 §10 established that a first run refuses rather than degrades. The same
applies here, and §16 of the alpha.9 plan is explicit that this needs deciding
rather than defaulting: _"a session that silently loses half its catalogue is a
session whose behaviour changed for a reason the user cannot see."_

```text
default            a declared server that fails to start, fails to initialize,
                   or negotiates an unsupported protocol version fails the
                   session with EXIT_CONFIG, naming the server and the cause.
optional = true    the session starts without that server, with a warning on
                   stderr and an `mcp.server.unavailable` event.  Explicit,
                   per-server, and the user had to type it.
```

Refusing by default is not pedantry. A model that is told a tool exists and then
finds it missing produces the worst failure mode this project has measured: a
wasted call, a retry, and a wrong conclusion about why.

### 6. Protocol version

The client sends its supported version in `initialize`. If the server responds
with a version the client does not implement, that is a startup failure under §5 —
refused, named, not approximated. Speaking a protocol version we have not
implemented against a process we cannot inspect is exactly the wrong direction to
guess in.

## Consequences

- **A new dimension of "it depends on the backend".** `session()` is implemented
  where it can be and absent where it cannot. `/status` must say which, because a
  user whose `--backend ssh` session silently has no MCP tools is in the same
  position as one whose server failed to start.
- **Zero runtime dependencies is preserved.** JSON-RPC 2.0 over a line-delimited
  stream is roughly two hundred lines; the official SDK is not worth an exception
  to ADR-0009, and taking one for an _MCP_ client — the feature whose entire
  premise is running code we did not write — would be difficult to say out loud.
- **A restarted server costs a re-list and a hash comparison.** Deliberate.
- **Freezing means a genuinely dynamic server is not supported.** Correct for
  v0.1. A server whose catalogue changes under a running session is asking for
  trust this milestone exists to withhold.

## Alternatives rejected

**Spawn the server outside the sandbox and note it in `/status`.** The plan
allows this as a fallback — "a `NOT TESTED` row and a loud `/status` line". It is
rejected because alpha.5's rule is stronger and older: refuse rather than
approximate. A session on `--backend container` that puts its most capable
component outside the container has not been given a caveat, it has been given a
different product.

**Start servers lazily, on first tool call.** Cheaper, and it makes the catalogue
unknowable before the first model call — so either the model is not told the tools
exist, or it is told about tools that may not materialise. Both are worse.

**Trust `notifications/tools/list_changed`.** It is the protocol's answer and it
is the TOCTOU gap in one message.
