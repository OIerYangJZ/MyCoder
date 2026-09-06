<div align="center">

# MyCoder

**A coding agent kernel for the terminal — one process, no runtime dependencies, and an enforcement level it will not overstate.**

[![node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-3c873a)](https://nodejs.org)
[![runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-d97757)](package.json)
[![platforms](https://img.shields.io/badge/platforms-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-6c7086)](docs/installing.md)

**English** · [简体中文](README.zh-CN.md)

<img src="docs/media/demo.gif" width="820" alt="A MyCoder session: a task is typed into the prompt, two files are read in parallel, and the answer streams back with a summary of what the turn did.">

</div>

---

Point it at a repository and describe a task. It reads, edits, runs your tests and
checks its own work, and every tool call it makes is resolved into an
`AccessRequest` that a policy engine decides on **before** the tool does anything.
What that engine decides, and what it can actually enforce, are two different
questions — and MyCoder answers the second one on the first screen, per dimension,
in the vocabulary of the mechanism doing the enforcing.

## Install

Node **22.18+**. There are no runtime dependencies; that is the entire supply
chain.

```bash
npm install -g mycoder-cli@alpha    # the package is mycoder-cli; the command is mycoder
mycoder doctor
```

```bash
brew tap OIerYangJZ/mycoder
brew trust OIerYangJZ/mycoder   # Homebrew refuses to load a third-party tap without this
brew install mycoder
```

```bash
# from a checkout of this repository
pnpm install && pnpm build
node bin/mycoder.mjs doctor
```

<sub><code>@alpha</code> because this is one — every release so far is a
prerelease, and typing the tag is how you say you meant to install one. They are
published under the <code>alpha</code> dist-tag, but npm pins <code>latest</code>
to the first version a package ever publishes and will not let that be removed, so
<code>latest</code> points at an alpha too until there is a stable release to move
it to. The npm name is
<code>mycoder-cli</code> because <code>mycoder</code> on npm belongs to an
unrelated project. What you type afterwards is <code>mycoder</code>.
Releases are published from the tarball the release gate installed and ran, with
<a href="https://docs.npmjs.com/generating-provenance-statements">npm provenance</a>
— so the bytes on the registry are the bytes that were tested, and you can check
that rather than take it from here.</sub>

**New here?** [`docs/using-mycoder.md`](docs/using-mycoder.md) walks through a
real session end to end — the approval prompt, the four modes, seeing what it
changed, and steering a long task.

`doctor` reaches one of two conclusions and never a third — **ready**, or
**blocked** naming the file to create, the key to put in it, and the command that
proves it worked. It builds no session and writes nothing, because it is what you
run when `mycoder` will not start.

| Platform          | Tier | Backends available                   |
| ----------------- | ---- | ------------------------------------ |
| Linux x64 / arm64 | 1    | `local`, `container`, `linux-native` |
| macOS arm64 / x64 | 1    | `local`, `container`                 |
| Windows x64       | 2    | `local`                              |

## Configure a provider

Adapters for **Anthropic Messages**, **OpenAI Responses**, and the
**OpenAI-compatible Chat** API — DeepSeek, OpenRouter, Together, a local
llama.cpp. Plus a `fake` adapter, which is why the whole kernel is testable
offline.

The credential is read from stdin and never from a terminal, so it is not echoed
to your screen or into shell history:

```bash
printf %s "$YOUR_API_KEY" | mycoder setup-credential ~/.config/mycoder/secrets/deepseek.key
```

```toml
# ~/.config/mycoder/config.toml
[model.provider.deepseek]
protocol     = "openai-chat"
base_url     = "https://api.deepseek.com"
api_key_file = "secrets/deepseek.key"

[model.profile.deepseek-chat]
context_window    = 65536
max_output_tokens = 8192
input_per_mtok    = 0.14      # omit and cost is reported `unknown`, never guessed
output_per_mtok   = 0.28

[model.alias.deepseek]
provider = "deepseek"
model    = "deepseek-chat"
profile  = "deepseek-chat"

[model]
default = "deepseek"
```

## A session

```console
$ mycoder
❯ read src/bars.js and src/format.js, then explain how one chart row is laid out

⏺ Read(src/bars.js)
⏺ Read(src/format.js)
  ⎿  Read(src/bars.js) · 4.8 kB
  ⎿  Read(src/format.js) · 2.0 kB
One chart row is laid out in renderRows in bars.js as a single string made of
three fixed-width columns separated by single spaces: a left-aligned label column
(middle-truncated to labelW by truncateMiddle, then padded), a bar column holding
rune repeated scaleCells(row.value, max, barW) times and padded to barW, and a
right-aligned count column padded via padStart(countW). …

✻ Worked for 5s
  read 2 files
  deepseek · 66k ctx · 2 requests · 9.5k tokens · $0.0008
```

Results are keyed to their call, not to their position — a step that issues four
`Read`s gets four results back in completion order, and each one names the call it
answers. The footer is counted from the session's own event log rather than from
the model's summary of itself, and anything refused is reported separately from
anything done.

| Input               | Effect                                                              |
| ------------------- | ------------------------------------------------------------------- |
| `@src/thing.ts`     | attach a file; Tab completes paths under the workspace              |
| `/…`                | control command, resolved by the kernel and never sent to the model |
| `!npm test`         | print how that line would parse into argv — does not run it         |
| **Shift-Tab**       | cycle the approval mode                                             |
| **Ctrl-R**          | reverse history search                                              |
| **Ctrl-C / Ctrl-D** | cancel the turn / end the session                                   |

For automation, `--json` puts one object per line on stdout and nothing else —
chrome goes to stderr, so `mycoder … | jq` never has to filter prose out of its
input:

```console
$ mycoder --json "fix add()"
{"schema":"mycoder.v1","type":"turn","state":"completed","steps":1,"text":"…","exit":0}
```

## What is actually enforced

Six dimensions, five levels — `none`, `best-effort`, `policy-enforced`,
`container-enforced`, `os-enforced` — reported per backend, and derived from the
backend's own descriptor rather than asserted by the CLI. `/status` prints this;
so does the startup banner, in prose.

| Dimension                            | `local`         | `--remote` (SSH) | `--backend container` | `linux-native` (experimental)         |
| ------------------------------------ | --------------- | ---------------- | --------------------- | ------------------------------------- |
| Subprocess filesystem                | policy-enforced | policy-enforced  | container-enforced    | **os-enforced** (Landlock)            |
| Subprocess network                   | best-effort     | best-effort      | container-enforced ¹  | os-enforced (TCP only) ¹              |
| Subprocess privileges                | none            | none             | container-enforced ²  | os-enforced (seccomp, `no_new_privs`) |
| Environment isolation                | policy-enforced | policy-enforced  | container-enforced    | policy-enforced                       |
| **Host file broker** (`Read`/`Edit`) | policy-enforced | policy-enforced  | **policy-enforced**   | **policy-enforced**                   |
| Network host allowlist               | best-effort     | best-effort      | container-enforced    | none                                  |

<sub>¹ when a denial or a host list is in force; an unrestricted network is `none`. ² with a read-only root filesystem; without one, `best-effort`.</sub>

Read the bolded row across. The strongest sandbox in this product **does not cover
`Read` and `Edit`** — they are trusted kernel operations on your real filesystem,
and reporting them as containerised would be the overclaim the whole scheme exists
to prevent. Attach an MCP server and a seventh dimension appears,
`foreignToolEffects`, whose only honest value is `none`: the kernel cannot enforce
a boundary inside somebody else's process.

The `local` row in prose, printed before you type anything:

> …subprocesses are not OS-isolated: a process that runs can still reach the
> filesystem with your user rights. Network denial for subprocesses is
> best-effort, and weaker than it sounds: nothing inspects a command for network
> use, so a command that reaches the network is neither approved nor refused — it
> simply works.

## Permissions

A tool never acts and then reports. `ToolDefinition → ToolExecution →
AccessRequest` is two-phase on purpose: the execution declares what it intends —
`file.read`, `file.write`, `file.delete`, `process.exec`, `network.connect`,
`secret.use`, `env.read`, `vcs.mutate`, `remote.connect`, `agent.invoke`,
`mcp.invoke` — and the policy engine answers `allow` / `ask` / `deny` on the
description, before any side effect exists.

Profiles compose by **intersection**, so no layer can widen another:

| Profile         | Its own description                                                          |
| --------------- | ---------------------------------------------------------------------------- |
| `workspace-dev` | Edit the workspace and run local verification. Network and VCS mutation ask. |
| `read-only`     | Inspect the workspace. No writes, no network, no VCS mutation.               |
| `review`        | Read and run verification commands. No writes, no network.                   |

`--read-only` wins over `--profile`, and says so rather than silently resolving it.

An approval mode answers a question the engine had already decided to raise — it
cannot create permission that a profile denied. Shift-Tab cycles:

| Mode           | Answers for you, without asking                        |
| -------------- | ------------------------------------------------------ |
| `plan`         | nothing; intersects read-only, so mutation is _denied_ |
| `manual`       | nothing (default)                                      |
| `accept-edits` | `file.write` inside the workspace                      |
| `auto`         | plus `file.delete` and `process.exec`                  |

That table is the whole of it — `AUTO_ANSWERED` names three capabilities and no
mode reaches past them. So `secret.use`, `network.connect`, `vcs.mutate` and
`mcp.invoke` ask in **every** mode, `auto` included. So does a `file.read` that
needed approval in the first place: reading outside the workspace is never
answered for you. And `env.read` is a hard deny that can never become an approval
at all, in any mode.

The starting mode comes from your own configuration — `[security] approval_mode`
in a repository is ignored, because a repository does not get to decide whether
you are asked before its code runs.

<img src="docs/media/approval.png" width="820" alt="The approval prompt: a framed box listing the tool, action, command, directory, network and scope, with four numbered answers below it and the highlight resting on No.">

The prompt shows semantics, not the command string: which subject, which accesses,
and how long a grant lasts. A session grant is remembered against a concrete
subject key — `process.exec:npm:install` — never a capability class. The highlight
starts on **No**; Escape and Ctrl-C resolve to deny rather than leaving the turn
open.

## Tools

**Nine core tools:** `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Delete`, `Move`,
`Shell`, `GitDiff` — all behind the contract above.

| Tool                 | Declares                                                 | Notes                                                                                                                  |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Read` `Grep` `Glob` | `file.read`                                              | paths that hold credentials are denied outright, not redacted                                                          |
| `Edit`               | `file.write`                                             | must cite the `receiptId` of the `Read` that covered the region, or the call returns `STALE_FILE`                      |
| `Write`              | `file.write`                                             | overwriting an existing file needs full read coverage of it                                                            |
| `Move`               | `file.delete` + `file.write`                             | one call, two capabilities, both decided before anything moves                                                         |
| `Delete`             | `file.delete`                                            | its own capability, so it asks where an ordinary write does not (ADR-0016)                                             |
| `Shell`              | `process.exec`, and `file.read` per path-like argv token | argv, never a string — so `cat .env` is a hard deny rather than a redaction problem                                    |
| `GitDiff`            | `process.exec` + `file.read`                             | shells out to `git`; the diff is read, never written                                                                   |
| `WebFetch`           | `network.connect`                                        | registered only when `[egress] web` names a host. GET only, no redirects followed, response treated as untrusted input |

Writes are atomic, with a unified diff, rollback metadata and line endings
preserved. `/undo` reverses one edit, a turn's edits, or a file's — all of a set
or none of it — and enumerates what it did **not** cover: a shell command's side
effects, and anything from before the journal starts.

## Control plane

`/model` `/effort` `/goal` `/loop` `/mode` `/permissions` `/status` `/compact`
`/remote` `/skills` `/agents` `/hooks` `/diff` `/undo` `/cancel` `/verbose`
`/thinking` `/help` — each changes kernel state directly and is never routed
through the model. `/loop` sets a per-turn step, wall-clock and cost budget;
`/compact` summarises the older conversation and reports when it could not;
`/diff` shows what the session has changed, from the same journal `/undo`
reverses; `/permissions explain <subject>` says why a decision went the way it
did.

Sessions are an append-only event log. `mycoder -c` continues this workspace's
last one; `mycoder -r` lists them by what each was asked to do. Resume rebuilds
the edit journal from the log, so an undo survives a crash, and synthesises
results for tool calls that were interrupted.

## Exit codes

A contract within `0.1.x`, so a wrapper can branch without parsing English.

|                      |                                                   |                     |            |
| -------------------- | ------------------------------------------------- | ------------------- | ---------- |
| `0` ok               | `1` incomplete — gave up, hit a budget, cancelled | `2` usage           | `3` config |
| `4` denied by policy | `5` unavailable — runtime, backend, network       | `6` internal defect |            |

Nothing goes above 6: `127` and `128+` belong to the shell, and borrowing them
would make our failures indistinguishable from its. Tool-level failures carry
their own codes — `STALE_FILE`, `TOOL_DENIED`, `PROTECTED_PATH`,
`INSUFFICIENT_READ_COVERAGE`, `LOOP_BUDGET_EXCEEDED` — each with a fixed blame
attribution.

## Architecture

```
User / CLI  →  Control Plane
                    ↓
        Session / Turn Coordinator
                    ↓
              Step Engine
   ┌────────────┼────────────┐
   ▼            ▼            ▼
Context   Model Runtime  Tool Runtime
Engine          │             │
                ▼             ▼
          Egress Gate   Tool.resolve() → Policy Engine
                                              ↓
                                        Sandbox Planner
                                              ↓
                                        Executor / Backend
                                              ↓
                                         Audited Result
```

Every outbound byte crosses one egress gate, with a host allowlist per channel and
a metadata-only telemetry channel. Secrets live in a broker whose leases cannot be
stringified back into a value. Tool output is scanned before the model sees it.
Skills, subagents and hooks are discovered from the repository under one rule: a
definition may narrow what is permitted and may never widen it.

## Not in this version

MCP marketplace, agent teams, IDE plugins, a full TUI, browser control,
embeddings, repo maps, model routing, cloud session sync, a background daemon.
Each has a place to attach later; none is half-built and in the way now.

## Documentation

|                                  |                                                       |
| -------------------------------- | ----------------------------------------------------- |
| `docs/installing.md`             | platform tiers, and the first run in detail           |
| `docs/configuring-a-provider.md` | every field, local models, verifying before you spend |
| `docs/cli-contract.md`           | every flag and exit code, and what `0.1.x` guarantees |
| `docs/web-access.md`             | enabling `WebFetch`, and what it will not do          |
| `docs/threat-model.md`           | what this defends against, and what it does not       |
| `docs/development.md`            | building, testing, and how the repository is laid out |
