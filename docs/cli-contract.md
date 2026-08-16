# The CLI contract

What a script may rely on, and what it may not. The normative decision is
ADR-0021; this is the version you can hand to someone writing a wrapper.

The audience here is a script somebody writes once and runs for a year. Breaking
it silently is the CLI equivalent of moving a tag.

## Exit codes

| Code | Name          | Means                                                                                                        |
| ---- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `0`  | `OK`          | The run completed. For a turn: the model finished the task.                                                  |
| `1`  | `INCOMPLETE`  | The model did not complete it — gave up, hit a loop budget, was cancelled.                                   |
| `2`  | `USAGE`       | The command line is wrong: unknown flag, missing value, conflicting flags.                                   |
| `3`  | `CONFIG`      | The configuration is wrong: unparseable file, no provider, insecure credential.                              |
| `4`  | `DENIED`      | Policy denied something the run needed, and the run stopped because of it.                                   |
| `5`  | `UNAVAILABLE` | The environment cannot provide it: runtime too old, no container runtime, no launcher, provider unreachable. |
| `6`  | `INTERNAL`    | A defect in MyCoder. Anything unmapped lands here.                                                           |

Two distinctions carry most of the value:

**`3` versus `5` — your file versus your machine.** One is fixed by editing
something, the other by installing or starting something. A wrapper that retries
is right to retry `5` and wrong to retry `3`.

```sh
mycoder --json "$TASK"
case $? in
  0) ;;                                   # done
  1) notify "the model gave up" ;;        # not a boundary, not a bug
  3) notify "fix the config"; exit 1 ;;   # do not retry
  5) sleep 30; retry ;;                   # the machine may recover
  4) notify "policy denied it" ; exit 1 ;;
  *) notify "report this" ; exit 1 ;;
esac
```

**`1` versus `4` — the model gave up versus a boundary said no.** Conflating them
is how "the agent is unreliable" gets reported for a session that was doing
exactly what it was configured to do.

Nothing above `6` is ours: `127` is the shell's "command not found" and `>=128` is
a signal death.

## `--json`

One JSON object per line on **stdout**, and nothing else on stdout. Warnings,
`/status` and prompts go to stderr, so `mycoder --json … | jq` never has to filter
human text out of its input.

Every object carries a schema tag:

```json
{ "schema": "mycoder.v1", "type": "turn", "state": "completed", "steps": 3, "text": "…", "exit": 0 }
{ "schema": "mycoder.v1", "type": "control", "ok": true, "message": "…" }
{ "schema": "mycoder.v1", "type": "error", "code": "PROVIDER_NOT_CONFIGURED", "exit": 3, "message": "…", "remedy": "…" }
{ "schema": "mycoder.v1", "type": "doctor", "ok": false, "exit": 3, "findings": [ … ] }
{ "schema": "mycoder.v1", "type": "sandbox-status", "ok": false, "problem": "stale", … }
{ "schema": "mycoder.v1", "type": "version", "version": "0.1.0" }
```

Within `mycoder.v1`:

```text
may change:  new fields; new `type` values; new `code` values
may NOT:     a field removed, renamed, or retyped
             an existing `type` or `code` repurposed
             the meaning of an exit code
```

A change those rules forbid bumps the tag to `mycoder.v2`. Check the tag once at
the top of your loop; that is what it is for.

A failure under `--json` is a JSON object, not English on stderr. A `--json` run
that failed by writing prose would push you back to parsing prose for exactly the
cases you most need to tell apart.

## Flags

### Contract

Semantics will not change within `0.1.x`. Removing or repurposing one needs an ADR.

```text
[prompt]              -c/--continue     -r/--resume <id>    -m/--model <alias>
--profile <name>      --cwd <path>      --remote <name>     --read-only
--no-telemetry        --json            --non-interactive   --print-config
--log-level <level>   --backend         -h/--help           -v/--version    --
```

`--backend local` and `--backend container` are contract values.

`--read-only` is a hard narrowing and wins over `--profile`. The conflict is
_reported_, not silently resolved, because either guess would run the session
under permissions you did not ask for.

### Experimental

May change or disappear in any release.

```text
--backend linux-native   the refusal behaviour is contract — it never degrades to
                         local — but ADR-0018's enforcement-descriptor vocabulary
                         has had one consumer, and freezing a vocabulary with one
                         user is how you get a vocabulary you cannot fix
--sandbox-status         output shape not yet frozen
--force                  a modifier of `setup-credential`
```

## Subcommands

None of these start a session, and none of them builds a kernel — every question
they answer is one you ask when the kernel will _not_ start.

```text
mycoder doctor                    is this installation ready? names every remedy. 0 or 3
mycoder setup-credential <path>   write an API key from stdin. 0, 2 or 3
mycoder build-sandbox             build the native launcher. 0 or 5
```

## What a patch release may change

```text
may:      the wording of any human-readable message
          new optional JSON fields, new `type`/`code` values
          new experimental flags, or removing one
          anything under `--log-level debug` / `trace`

may not:  the meaning of an exit code
          the shape of `mycoder.v1` beyond additions
          the semantics of a contract flag
```
