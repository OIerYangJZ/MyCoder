# Configuring a model provider

Any endpoint speaking one of the three supported protocols can be added from
**user** configuration, with no code change.

| Protocol             | Use for                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `openai-chat`        | OpenAI-compatible Chat Completions — DeepSeek, Kimi, GLM, Groq, OpenRouter, vLLM, Ollama, LM Studio |
| `openai-responses`   | OpenAI's Responses API                                                                              |
| `anthropic-messages` | Anthropic Messages                                                                                  |

## Where the file goes

```
~/.config/mycoder/config.toml
```

**User config only.** A project's `.mycoder/config.toml` may _select_ an alias but
may never _define_ a provider — declaring an endpoint means declaring where every
prompt and every file the model has read gets sent, and a checked-in repository
file must not be able to decide that. A project that tries is ignored with a
warning. This is the same rule the spec applies to SSH remotes (§19.2).

## DeepSeek

```toml
# ~/.config/mycoder/config.toml

[model.provider.deepseek]
protocol    = "openai-chat"
base_url    = "https://api.deepseek.com"
api_key_env = "DEEPSEEK_API_KEY"      # the variable name, never the key itself

[model.profile.deepseek-chat]
context_window    = 65536
max_output_tokens = 8192
supports_reasoning      = false
supports_parallel_tools = false        # leave off until validated (§13)
tool_reliability  = "medium"
autonomy          = "normal"
# Optional. Without pricing, cost is reported as `unknown` rather than guessed.
# input_per_mtok  = 0.27
# output_per_mtok = 1.10

[model.alias.deepseek]
provider = "deepseek"
model    = "deepseek-chat"
profile  = "deepseek-chat"

[model]
default = "deepseek"
```

Then:

```bash
export DEEPSEEK_API_KEY=sk-...
cd /path/to/your/project
mycoder -m deepseek "fix the failing test"
```

> **Which command you type depends on how you installed.** `mycoder` is the
> installed command (`npm install -g`, see `docs/installing.md`). From a git
> checkout there is no `mycoder` on your `PATH`; use `node bin/mycoder.mjs` in its
> place, everywhere below. Every example in this document is written for the
> installed form, because that is the one a reader who is not the author has.

### Reasoning models

`deepseek-reasoner` streams its chain of thought as `reasoning_content`, which
the `openai-chat` adapter already normalises into `ReasoningPart`. Add a second
alias:

```toml
[model.profile.deepseek-reasoner]
context_window     = 65536
max_output_tokens  = 8192
supports_reasoning = true

[model.alias.deepseek-r]
provider = "deepseek"
model    = "deepseek-reasoner"
profile  = "deepseek-reasoner"
```

## Local models

```toml
[model.provider.ollama]
protocol = "openai-chat"
base_url = "http://localhost:11434/v1"
# no api_key_env — a local server usually needs none

[model.profile.local-small]
context_window = 32768
tool_reliability = "low"

[model.alias.local]
provider = "ollama"
model    = "qwen2.5-coder:14b"
profile  = "local-small"
```

`http://` is permitted only for loopback; anything else must be `https://`.

## Field reference

### `[model.provider.<id>]`

| Field           | Required | Notes                                                            |
| --------------- | -------- | ---------------------------------------------------------------- |
| `protocol`      | yes      | one of the three above                                           |
| `base_url`      | yes      | absolute `http(s)`; trailing slashes trimmed                     |
| `api_key_file`  | no       | **path to a 0600 file** holding the key. Wins over `api_key_env` |
| `api_key_env`   | no       | **variable name**; the schema has no field for a literal key     |
| `auth_scheme`   | no       | `Bearer` (default), `x-api-key`, `none`                          |
| `extra_headers` | no       | table of string headers                                          |

An `api_key` field does not exist. Writing one is warned about and ignored — a
config file is the one artifact people paste into issues and check into dotfile
repositories.

### `[model.profile.<name>]`

| Field                                                          | Required | Default                        |
| -------------------------------------------------------------- | -------- | ------------------------------ |
| `context_window`                                               | yes      | —                              |
| `max_output_tokens`                                            | no       | —                              |
| `reserved_output_tokens`                                       | no       | `min(max_output_tokens, 8000)` |
| `supports_reasoning`                                           | no       | `false`                        |
| `supports_parallel_tools`                                      | no       | `false`                        |
| `tool_reliability`                                             | no       | `medium`                       |
| `autonomy`                                                     | no       | `normal`                       |
| `input_per_mtok` / `output_per_mtok` / `cached_input_per_mtok` | no       | unset ⇒ cost `unknown`         |

`context_window` matters beyond bookkeeping: it drives when compaction fires.
A wrong value makes the agent compact at the wrong point.

## Persisting the credential (`api_key_file`)

`api_key_env` works, but it means exporting the key in every terminal. To set it
once:

```bash
mkdir -p ~/.config/mycoder/secrets
printf '%s\n' 'sk-your-key-here' > ~/.config/mycoder/secrets/deepseek.key
chmod 600 ~/.config/mycoder/secrets/deepseek.key
```

```toml
[model.provider.deepseek]
protocol     = "openai-chat"
base_url     = "https://api.deepseek.com"
api_key_file = "secrets/deepseek.key"    # relative to this config file
```

A relative path anchors to the **config directory**, not the workspace — which
is also the rule that stops the natural-looking `secrets/deepseek.key` landing
inside your repository.

The file must be a regular file, not a symlink, owned by you, mode `0600` or
stricter, and outside both the workspace and any reference tree. Anything else
is refused with `CREDENTIAL_FILE_INSECURE` naming the specific problem and the
remedy. The kernel never `chmod`s the file for you: a permission problem that
silently repairs itself is one nobody looks at twice.

**Configuring the path is what protects it.** The moment a credential file is
configured, its canonical path is hard-denied to Read, Grep, Glob, Shell, Hooks,
Skills and Subagents — a denial no profile, project rule or approval can lift.
A credential store the agent itself can read would defeat the purpose. `/status`
reports `credential source: file · credential configured: yes` and nothing more.

If both are set, the file wins and the unused variable is reported. If the file
is configured but insecure, the provider gets **no** credential — it does not
quietly fall back to the environment, because then you would never learn the
file was world-readable.

What this is and is not: local credential persistence, not a hardware-backed
vault. See `docs/threat-model.md` and ADR-0011.

## What happens automatically

- **The credential is registered by reference.** `api_key_file` names a path and
  `api_key_env` names a variable; either way the SecretBroker reads the value
  and hands the Model Runtime a short-lived lease.
  Shell, Hooks, Skills and Subagents never see it, and it never enters the event
  log, telemetry or the debug log.
- **The host joins the model egress allowlist** — but only for a provider _you_
  declared in _your_ config. A project-declared endpoint never does.
- **A missing or insecure key is a startup warning**, naming the variable or the
  specific file problem, rather than a confusing `MODEL_AUTH_ERROR` on the first
  request.

## Verifying before you spend anything

Neither of these sends a request to the provider, so neither costs anything:

```bash
mycoder --print-config     # resolves the config and prints every warning
mycoder doctor             # ready, or blocked while naming the exact remedy
```

`--print-config` is where a typo in `protocol`, an unreadable `api_key_file` or a
provider a _project_ config tried to declare will show up. `doctor` answers the
different question of whether this installation can start at all.

Then the smallest real request there is — one turn, one alias:

```bash
cd /path/to/your/project
mycoder -m deepseek "say hello and change nothing"
```

Inside the session, `/status` reports the model, the backend and whether a
credential is configured, and `/model status` reports the alias actually in use.

From a checkout there is also a bounded live suite, a handful of tiny requests:

```bash
# in a checkout only
KERNEL_LIVE_PROVIDER=deepseek \
KERNEL_LIVE_KEY_ENV=DEEPSEEK_API_KEY \
KERNEL_LIVE_MODEL=deepseek \
pnpm test:live:model
```

It refuses to run without both `KERNEL_LIVE=1` (set by that script) and the
credential, so an ordinary test run can never fire a billed request even with the
key exported.
