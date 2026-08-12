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
~/.config/agent/config.toml
```

**User config only.** A project's `.agent/config.toml` may _select_ an alias but
may never _define_ a provider — declaring an endpoint means declaring where every
prompt and every file the model has read gets sent, and a checked-in repository
file must not be able to decide that. A project that tries is ignored with a
warning. This is the same rule the spec applies to SSH remotes (§19.2).

## DeepSeek

```toml
# ~/.config/agent/config.toml

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
pnpm --dir /Users/yangjinsey/MyCoder/kernel agent -m deepseek "fix the failing test"
```

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

| Field           | Required | Notes                                                        |
| --------------- | -------- | ------------------------------------------------------------ |
| `protocol`      | yes      | one of the three above                                       |
| `base_url`      | yes      | absolute `http(s)`; trailing slashes trimmed                 |
| `api_key_env`   | no       | **variable name**; the schema has no field for a literal key |
| `auth_scheme`   | no       | `Bearer` (default), `x-api-key`, `none`                      |
| `extra_headers` | no       | table of string headers                                      |

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

## What happens automatically

- **The credential is registered by reference.** `api_key_env` names a variable;
  the SecretBroker reads it and hands the Model Runtime a short-lived lease.
  Shell, Hooks, Skills and Subagents never see it, and it never enters the event
  log, telemetry or the debug log.
- **The host joins the model egress allowlist** — but only for a provider _you_
  declared in _your_ config. A project-declared endpoint never does.
- **A missing key is a startup warning**, naming the variable, rather than a
  confusing `MODEL_AUTH_ERROR` on the first request.

## Verifying before you spend anything

```bash
pnpm --dir /path/to/kernel agent --print-config     # shows warnings, resolves config
pnpm --dir /path/to/kernel agent -m deepseek        # /status, then /model status
```

Then the bounded live suite — a handful of tiny requests:

```bash
KERNEL_LIVE_PROVIDER=deepseek \
KERNEL_LIVE_KEY_ENV=DEEPSEEK_API_KEY \
KERNEL_LIVE_MODEL=deepseek \
pnpm test:live:model
```

It refuses to run without both `KERNEL_LIVE=1` (set by that script) and the
credential, so a plain `pnpm test` can never fire a billed request even with the
key exported.
