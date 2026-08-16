# A third-party MCP server — alpha.9 §5

**Script:** `evals/experiments/alpha9-mcp-dogfood.ts`
**Server:** `@modelcontextprotocol/server-filesystem` (2026.7.10), the reference
implementation from the protocol's own authors, fetched from npm at run time.
**Date:** 2026-08-16. **Host:** macOS arm64, local backend.

Deliberately **not vendored**. A copy in this repository would be a copy this
repository controls, which defeats the point: every other MCP test here talks to
`tests/fixtures/mcp-server.mjs`, a server written to be tested. That fixture is
the right way to produce five hundred tools and a mutating catalogue. It is the
wrong way to find out whether the client works.

## Result

```text
protocol: negotiated, 14 tool(s) listed
tools: read_file, read_text_file, read_media_file, read_multiple_files,
       write_file, edit_file, create_directory, list_directory,
       list_directory_with_sizes, directory_tree, move_file, search_files,
       get_file_info, list_allowed_directories
registered: 14 foreign name(s), Read intact: true
unlabelled descriptions: 0 (must be 0)
longest description: 570 chars
called list_directory: ok
  saw hello.txt: true
  saw .env:      true
descriptor: effects inside MCP servers: none
```

## The finding, stated plainly

Look at the tool list, then at the last three lines.

That server offers `read_file`, `write_file`, `edit_file`, `move_file` and
`directory_tree`. It listed a `.env` file in the workspace, and it would read it.
**MyCoder's own `Read` hard-denies that path** — `PROTECTED_PATH`, no approval
can lift it, and there is a golden task and a canary suite that prove it.

Both of those sentences are true at the same time, in the same session.

This is not a defect and there is no patch for it. It is
`foreignToolEffects: none` made concrete, and it is the sentence ADR-0023 §6 was
written to force the product to say out loud:

> The kernel cannot enforce a boundary inside somebody else's process.

The kernel decided whether that server could be asked to run `list_directory`.
Everything the server then did — which directory it walked, which files it
returned, whether it respected a `.env` that MyCoder treats as unreachable — was
outside every boundary `/status` reports. A user attaching a filesystem MCP
server has, in effect, granted a second file broker that does not share the first
one's rules, and they are entitled to know that before typing a task.

What the kernel _did_ do correctly here is refuse to pretend otherwise: the
descriptor reports `none`, the caveat says so in prose, and every one of those 14
descriptions arrived labelled as unverified.

## alpha.9 defect 4 — found by this dogfood, on the first attempt

The first run failed:

```text
CONFIG_INVALID: MCP server "fs" could not be started, so this session refused to
begin. MCP server "fs" did not answer "initialize" within 10000ms.
```

The refusal fired correctly, named the server, named the cause and named the
remedy. It was still a defect, because **the remedy did not work**: the config
already said `timeout_ms = 60000`, and `HANDSHAKE_TIMEOUT_MS` was a hardcoded
10 s that the per-server setting could not raise. A ceiling nobody can raise is
not a default.

The cause is ordinary and would hit any real user: `npx -y <package>` _downloads
the package_ before the server process exists. On a cold cache that is well over
ten seconds, exactly once.

Fixed: the configured `timeout_ms` now governs startup as well as calls.

This is the shape §5 exists to produce. Nothing in the fixture server could have
found it — the fixture starts instantly, because it is a local file, because it
was written to be tested.

## What this dogfood does not cover

- **One server, one transport.** stdio only; no third-party HTTP server was
  attached.
- **One platform.** macOS arm64, local backend. Not run under `--backend
container` or `--backend linux-native`, so the §9 question — is the server
  inside the sandbox the user selected — is answered by construction
  (`StdioTransport` refuses a backend with no `session()`) rather than by
  observation on those backends.
- **No model drove it.** This is a client-level dogfood. What a model does with
  fourteen foreign filesystem tools is `docs/alpha9-mcp-utility.md`'s question,
  and that experiment used the fixture server rather than this one.
