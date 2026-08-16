# ADR-0021 — The CLI is a contract: flags, exit codes, and a versioned `--json`

**Status:** accepted · **Date:** 2026-08-16 · **Milestone:** v0.1.0-alpha.8

## Context

The consumer of `--json` is a script somebody writes once and runs for a year.
Today the kernel emits an unversioned object shape, and every failure — a
malformed config, a denied tool, a model that gave up, an unreachable Docker
daemon — exits `1`. A wrapper script cannot tell "your configuration is wrong"
from "the model gave up" without matching English prose, which is the CLI
equivalent of moving a tag (alpha.8 §14).

alpha.8 §14 and §15 ask for four decisions.

## Decision

### 1. Which flags are contract, and which are experimental

**Contract.** Semantics will not change within `0.1.x`. Removing or repurposing
one requires an ADR.

```text
[prompt]              -c/--continue     -r/--resume <id>    -m/--model <alias>
--profile <name>      --cwd <path>      --remote <name>     --read-only
--no-telemetry        --json            --non-interactive   --print-config
--log-level <level>   -h/--help         -v/--version        --
--backend local|container
```

**Experimental.** May change or disappear in any release. Listed under an
`Experimental:` heading in `--help` so the distinction is visible where people
actually look, and reported as experimental by `--help --json`.

```text
--backend linux-native    ADR-0018's enforcement descriptors are still settling;
                          the *refusal* behaviour is contract, the descriptor
                          vocabulary is not
--sandbox-status          new in alpha.8 (ADR-0020); output shape not yet frozen
```

`--read-only` deserves a note: it is contract, and it is a _hard narrowing_ that
wins over `--profile`. Reported as a conflict rather than resolved silently,
because either guess would run the session under permissions the user did not
ask for.

### 2. Exit codes

Six meanings, contiguous from zero. A wrapper must be able to branch on them
without reading a message.

| Code | Name          | Means                                                                                                                             |
| ---- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `OK`          | The run completed. For a turn: the model finished the task.                                                                       |
| `1`  | `INCOMPLETE`  | The model did not complete the task — gave up, hit a loop budget, cancelled.                                                      |
| `2`  | `USAGE`       | The command line is wrong. Unknown flag, missing value, conflicting flags.                                                        |
| `3`  | `CONFIG`      | The configuration is wrong. Unparseable file, no provider, insecure credential file.                                              |
| `4`  | `DENIED`      | Policy denied something the run needed, and the run stopped because of it.                                                        |
| `5`  | `UNAVAILABLE` | The environment cannot provide what was asked. Runtime too old, container runtime absent, launcher missing, provider unreachable. |
| `6`  | `INTERNAL`    | A defect in the kernel. Anything unmapped lands here.                                                                             |

The split that matters most is `3` from `5`: **`CONFIG` is the user's file,
`UNAVAILABLE` is the user's machine.** One is fixed by editing something, the
other by installing or starting something, and a script that retries is right to
retry `5` and wrong to retry `3`.

`1` versus `4` is the second: a model that gave up is not a boundary that said
no. Conflating them is how "the agent is unreliable" gets reported for a session
that was working exactly as configured.

Anything above `6` is not ours: `>=128` is a signal death, and `127` is the
shell's "command not found".

### 3. `--json`: a versioned shape

Every object emitted on stdout under `--json` carries a schema tag:

```json
{ "schema": "mycoder.v1", "type": "turn", "state": "completed", "steps": 3, "text": "..." }
{ "schema": "mycoder.v1", "type": "control", "ok": true, "message": "..." }
{ "schema": "mycoder.v1", "type": "error", "code": "CONFIG_INVALID", "exit": 3, "message": "...", "remedy": "..." }
```

Within `mycoder.v1`:

```text
may change:  new fields added; new `type` values; new `code` values
may NOT:     a field removed, renamed, or given a different type
             an existing `type` or `code` value repurposed
             the meaning of an exit code
```

A change that cannot be made under those rules bumps the tag to `mycoder.v2`,
which is a breaking change and gets an ADR. The tag exists so a consumer can
_detect_ that rather than discover it.

One rule with teeth: **stdout under `--json` carries only JSON, one object per
line.** Warnings, status and prompts go to stderr. A script doing
`mycoder --json ... | jq` must never have to filter human text out of its input;
today `/status` and config warnings already go to stderr, and this makes that a
contract instead of an accident.

Errors are emitted as a JSON object too. A `--json` run that failed by writing
English to stderr and exiting non-zero forces the wrapper back to prose parsing
for exactly the cases it most needs to distinguish.

### 4. What a patch release may change

```text
may:      the wording of any human-readable message
          new optional JSON fields, new `type`/`code` values
          new experimental flags, or the removal of an experimental flag
          anything under `--log-level debug`/`trace`
may not:  the meaning of an exit code
          the shape of `mycoder.v1` beyond additions
          the semantics of a contract flag
```

## Rationale

- Six codes rather than three: the distinctions cost nothing to emit and cannot
  be recovered afterwards. A script that only cares about pass/fail still works
  with `!= 0`.
- A schema tag rather than a version _number_ per field: the consumer wants one
  cheap check at the top of the loop, not per-field negotiation.
- Marking `--backend linux-native` experimental is not hedging about whether it
  refuses correctly — that is contract, and it is the security property. It is
  about the _vocabulary_ the descriptors use, which alpha.7 built and alpha.8 has
  not yet had a second consumer for. Freezing a vocabulary with one user is how
  you get a vocabulary you cannot fix.

## Consequences

- `main()` stops returning ad-hoc `0`/`1`/`2` and returns a named code from
  `src/cli/exit-codes.ts`. Every error path is mapped explicitly; the default is
  `INTERNAL`, so an unmapped path is loud rather than indistinguishable from a
  model that gave up.
- `KernelError.blame` (`user` / `model` / `kernel` / `environment`) already
  encodes most of this distinction internally, and the mapping is derived from it
  rather than re-decided per call site.
- The regression matrix (§26) gains one case per documented exit code, asserting
  the code _and_ that the message names problem and remedy.
- `docs/cli-contract.md` is the user-facing statement of this ADR, and the
  evidence matrix points at it.
