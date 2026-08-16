# ADR-0023 — Capabilities for tools the kernel did not write

**Status:** accepted · **Date:** 2026-08-16

## Context

This is the root problem of alpha.9, and it is worth stating once, precisely.

Every existing tool produces an `AccessRequest` the kernel **derived**:

```text
Read("src/app.ts")      → file.read     /abs/src/app.ts   (canonicalised)
Shell(["rm","-rf","/"]) → process.exec  argv              (parsed)
WebFetch("https://x/y") → network.connect x               (resolved)
```

An MCP tool produces:

```text
some_tool({ "anything": "the server defined this schema" })
                        → ???
```

The kernel cannot read the server's implementation. It cannot infer what the
arguments mean — the schema is the server's, and `{"path": "..."}` may denote a
file, a database row, a Jira ticket or nothing. And it must not ask the server,
because **a component that declares its own capabilities has not been constrained;
it has been asked politely.** A server that could declare its effects could
declare fewer than it has.

Every path from "the tool says it only reads" to "so we allow it to read" is the
same hole.

## Decision

### 1. The kernel grants access to a **server**, not to a resource

`mcp.invoke` is a new capability, and it means exactly what it says:

```ts
export interface McpInvokeAccess {
  kind: 'mcp.invoke';
  server: string; // the user-config name, never the server's self-report
  tool: string; // the bare tool name as listed
  display: string;
  transport: 'stdio' | 'http';
}
```

The match target is `server/tool`. The subject key is
`mcp.invoke:<server>/<tool>` — per server **and** per tool, so approving
"search the wiki" never spends as approval for "delete the wiki".

That is the whole derivation, and its honesty is the point. The kernel is not
claiming to know what the call does. It is recording the only fact it actually
has: this session permitted this server to be asked to run this tool.

**Say that plainly or do not ship it**, in the plan's words. `/status` and the
approval prompt both say it in as many words: _what the server does with the call
is outside every boundary this kernel enforces._

### 2. A server's own declaration of its effects permits nothing

Never, by any route. Not as a hint, not as a default, not as a tiebreak.

An MCP tool's `resolve()` produces **exactly one** `mcp.invoke` access and
nothing else. It cannot emit `file.write`, and there is a lint rule and a test
asserting that it does not, because a `file.write` on that path could only have
come from the server's own description of itself.

The server's declared schema is used for exactly two things, both of them
non-authorising: validating the model's arguments before they are sent (so a
malformed call fails here rather than there), and rendering the tool for the
model under ADR-0024's labelling. Neither can widen anything.

### 3. Starting a server is a different capability from calling its tools

This distinction does real work:

```text
starting a stdio server   process.exec  — argv the *user* wrote in their config
starting an HTTP server   network.connect { via: 'mcp' } — host from user config
calling any tool on it    mcp.invoke    — server + tool
```

The first two are derivable, because the user's configuration is something the
kernel can read. Only the third is opaque. Splitting them means the sandbox and
the egress allowlist govern the server's _existence_ with full strength, and only
the per-call grant is the weak one.

### 4. A profile says "this server, these tools, and nothing else"

`mcp.invoke` takes ordinary policy rules with the existing pattern machinery:

```toml
[[permissions.rules]]
capability = "mcp.invoke"
pattern    = "wiki/search_*"
action     = "allow"

[[permissions.rules]]
capability = "mcp.invoke"
pattern    = "*"
action     = "ask"
```

Defaults per builtin profile:

```text
read-only      deny   — a tool whose effects are unknown is not a read
review         deny   — same
workspace-dev  ask    — every server, every tool, first call in the session
yolo           allow
```

`deny` under `read-only` is the deliberate part. A foreign tool cannot be
classified as read-only, because `readOnly` would be the server's claim about
itself, and §2 says those are worth nothing. A profile whose promise is "this
session will not change anything" cannot keep that promise while calling code it
cannot see, so it does not call it.

### 5. An MCP tool is never granted a builtin capability

The plan asks whether it could ever be, and what that would have to mean. It
would have to mean the kernel had derived that capability from the call — which
is the thing it cannot do. So: **no, in v0.1, unconditionally.**

There is a coherent future version of this — a server that declares a path
argument, the kernel canonicalising it and adding a real `file.read` for that
path _in addition to_ `mcp.invoke*, so the protected-path rules bite. It needs the
kernel to understand a schema annotation it can trust, which means a signed or
kernel-authored manifest, which is its own ADR. Until then, adding a builtin
capability to a foreign call would mean the policy engine ruling on a target the
server chose.

### 6. The descriptor reports the region inside a server as `unenforced`

`EnforcementDescriptor` gains a seventh dimension:

```text
foreignToolEffects   what the kernel enforces about effects that occur *inside*
                     a server's process.
```

Its value is `'none'` whenever any MCP server is attached, and — following the
existing rule that a summary is derived and never asserted — it is derived from
the presence of servers rather than set by a caller.

It is a separate dimension rather than a downgrade of `processFilesystem` for a
reason. A `--backend linux-native` session with an MCP server attached genuinely
_does_ have `os-enforced` filesystem confinement for its subprocesses. Rounding
that down would be as dishonest as rounding the MCP region up. Both facts are
true at once, and a user is entitled to both:

```text
process filesystem:        os-enforced
process network:           os-enforced
effects inside MCP servers: none          ← the strongest boundary in this
                                            system does not cover the most
                                            capable tool in the catalogue
```

alpha.8 §13's rule applies unchanged: a convenience that cannot be provided
without weakening a boundary is not a convenience. MCP cannot be offered without
an honest `unenforced`, so the honest `unenforced` ships — not a softer word.

## Consequences

- **`read-only` and `review` sessions have no MCP tools.** Correct, and it will
  be inconvenient. The alternative is a profile that lies.
- **Every first call to every tool prompts under `workspace-dev`.** The subject
  key is per-tool by design; a server with thirty tools costs thirty approvals
  across a session. Cheaper than the alternative, which is one approval that
  covers twenty-nine tools the user never saw.
- **The friction cost is measurable and must be measured** (§17). A per-tool
  prompt is exactly the kind of thing alpha.7 found can make a _different_ tool
  harder to call.
- **`ALL_CAPABILITIES` grows**, so every exhaustive `switch` over `Capability`
  fails to compile until it handles `mcp.invoke`. Intended: the type system is
  the mechanism that stops a new capability from being silently unhandled by the
  profile layer.

## Alternatives rejected

**Derive capabilities from the tool's JSON schema.** A property named `path` is
a string the server named `path`. Treating it as a filesystem path means the
server chooses which of the kernel's rules apply to it.

**A per-server capability, not per-tool.** One approval for "the wiki server"
covers every tool it offers, including ones added on a restart. Rejected: it is
the same shape as a session-wide network approval, which alpha.6 §36 already
decided against for the same reason.

**Trust a server's `readOnly` hint for the `read-only` profile.** The one place
where the server's self-report would be most useful is the one place where
believing it costs the most.
