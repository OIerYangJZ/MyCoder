# Installing MyCoder

## Requirements

**Node >= 22.18.0.** MyCoder ships TypeScript sources and lets Node strip the
types at runtime — that is on by default from 22.18.0, and below it the package's
type annotations are a syntax error. The `mycoder` command checks this before it
loads anything and tells you what to install if it is not met (ADR-0019).

Nothing else. There are zero runtime dependencies (ADR-0009).

## Supported platforms

"Supported" means the offline suite runs on this platform in CI, and a defect
found there blocks a release.

| Platform          | Tier | What is tested                                                   | Backends available             |
| ----------------- | ---- | ---------------------------------------------------------------- | ------------------------------ |
| Linux x64 / arm64 | 1    | full offline suite, container tier, native tier                  | local, container, linux-native |
| macOS arm64 / x64 | 1    | full offline suite; container tier is not release evidence (§38) | local, container               |
| Windows x64       | 2    | smoke suite only                                                 | local                          |

Tier 2 is a known limitation rather than a silent one. The full suite assumes
POSIX — the local backend spawns `sh`, and fixtures use `grep` and `cat`. On
Windows, `--backend container` and `--backend linux-native` **refuse**; they never
quietly become `local`.

macOS is tier 1 for the kernel and deliberately **not** an evidence host for
container isolation. Docker Desktop runs a Linux VM, and alpha.5 §38 declines to
call that equivalent to a native Linux Engine.

## Install

```sh
npm install -g ./mycoder-0.1.0.tgz     # from a release artifact
mycoder --version
```

Verify what you installed:

```sh
mycoder --version --json
# { "schema": "mycoder.v1", "type": "version", "version": "0.1.0" }
```

A packed artifact carries `build-info.json` with the exact commit it was built
from. Every evidence document in this repository is re-runnable at that commit —
that is the point of recording it (ADR-0019 §6).

## First run

```sh
cd your-project
mycoder doctor
```

`doctor` reaches one of exactly two conclusions, and never a third:

- **ready** — a provider was found and its credential is usable;
- **blocked** — naming the file to create, the keys to set, and how to verify.

It builds no session, changes nothing on disk, and repairs nothing. It is the
command to run when `mycoder` itself will not start.

### Configure a provider

`doctor` prints this block filled in with your paths. Providers may only be
declared in **user** config — a checked-in project config that could set
`base_url` would decide where every prompt, and every file the model has read,
gets sent.

```toml
# ~/.config/mycoder/config.toml

[model.provider.myprovider]
protocol     = "openai-chat"              # or anthropic-messages / openai-responses
base_url     = "https://api.example.com"
api_key_file = "secrets/provider.key"     # relative to this config directory

[model.profile.myprofile]
context_window = 128000

[model.alias.mymodel]
provider = "myprovider"
model    = "the-model-id"
profile  = "myprofile"

[model]
default = "mymodel"
```

If you declare exactly one alias you may omit `[model] default` — MyCoder uses it
and says at startup that it inferred it. With two or more it refuses rather than
guessing, because guessing means silently sending your prompts to one provider
rather than another.

### Put the key somewhere the kernel will accept

```sh
mkdir -p ~/.config/mycoder/secrets
printf %s "$YOUR_API_KEY" | mycoder setup-credential ~/.config/mycoder/secrets/provider.key
```

The key is read from a **pipe**, never from the terminal: typing it would mean
either echoing it to your screen or driving raw-mode input correctly on every
terminal — and the second fails with a real credential on display. The value never
appears in `argv`, so it is not in `ps` output either.

`setup-credential` writes `0600`, refuses to overwrite an existing key without
`--force`, refuses any path inside your workspace _before_ writing anything, and
then runs the kernel's own acceptance check — removing what it wrote if that
refuses it. A setup flow that produces a file the kernel then rejects is worse
than no setup flow at all.

You can of course write the file yourself. The rules the kernel enforces:

```text
mode 0600 or stricter      another local account must not be able to read it
owned by you               a file someone else owns is one they can rewrite
a regular file, not a link the link target is what holds the bytes
outside the workspace      a key there is one `git add` from being published
```

The kernel never repairs any of these. `chmod` on a path you chose is an
unrequested change to something outside the workspace, and a tool that silently
fixes a permission problem trains people not to look at it.

## The native Linux sandbox

`--backend linux-native` runs commands under a Landlock/seccomp launcher applied
by the host kernel. It needs one build step, on the machine that will run it:

```sh
mycoder build-sandbox      # needs a C compiler
mycoder --sandbox-status   # does the built launcher match this kernel?
```

This is deliberately **not** a `postinstall` hook. Running a C compiler as a side
effect of `npm install` is unaudited code execution triggered by dependency
resolution, in the place users are least likely to read the output — and a kernel
whose point is that it does not execute things you did not ask for cannot do that
(ADR-0020).

If the launcher is missing, was built from different source, or is not the binary
its manifest describes, `--backend linux-native` **refuses to start**. It never
falls back to `local`. Being told "the sandbox is not available" is worse than
"it just works"; being given the word "sandbox" and none of the isolation is
worse than both.

If `build/` is not writable — a root-owned global install — build elsewhere:

```sh
MYCODER_SANDBOX_BIN=$HOME/.local/lib/mycoder-sandbox mycoder build-sandbox
```

## Exit codes

```text
0  ok            1  incomplete   2  usage
3  config        4  denied       5  unavailable    6  internal
```

`3` is your file, `5` is your machine. See `docs/cli-contract.md`.

## Uninstall

```sh
npm uninstall -g mycoder
rm -rf ~/.config/mycoder                       # config, remotes, secrets you put there
rm -rf ~/.local/share/mycoder                  # sessions (Linux)
rm -rf ~/'Library/Application Support/mycoder' # sessions (macOS)
```

Nothing is written outside those and the workspace's own `.mycoder/`.
