# M2 Hardening Report

**Date:** 2026-08-12 · **Scope:** next-phase plan P0–P7 · **Suite:** 246 tests, all passing

Status vocabulary is exactly three values, as the plan requires. **PASS** means a
named automated test asserts it. **FAIL** means a test asserts it and the
assertion does not hold. **NOT TESTED** means there is no automated assertion —
regardless of whether the code looks correct. "Probably fine" is not a status.

Reproduce with:

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm format:check
pnpm test && pnpm eval
KERNEL_TRAJECTORY_REPEATS=100 pnpm test:trajectory
```

---

## 1. Release-blocking security invariants (spec §25)

| #   | Invariant                                                     | Status   | Evidence                                                                                                                                 |
| --- | ------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every tool call produces a real or synthetic result           | **PASS** | `agent-loop.test.ts` "every tool call has a matching result"; `replay-gate.test.ts` `unansweredToolCalls` on every path                  |
| 2   | StepContext immutable during a model request                  | **PASS** | `assertStepUnchanged` + `step.ts` hashes; `control-plane.test.ts` "/model … takes effect on the next step"                               |
| 3   | Edits go through the Freshness Ledger                         | **PASS** | `agent-loop.test.ts` stale / coverage / non-unique; `hardening.test.ts` receipt expiry                                                   |
| 4   | Persistent edits produce a diff tied to a tool call           | **PASS** | `agent-loop.test.ts` "records the edit with both hashes and a diff"; `hardening.test.ts` "applying the journal diff reproduces the file" |
| 5   | Permission ≠ Sandbox; no false isolation claims               | **PASS** | `cli.test.ts` "states the isolation honestly" asserts `os-isolated` never appears on the local backend                                   |
| 6   | Provider quirks stay out of the agent loop                    | **PASS** | `adapters.test.ts` (3 protocols → identical IR); `pnpm lint` rule `no-provider-names-in-core`                                            |
| 7   | Model Profile separate from provider endpoint                 | **PASS** | `adapters.test.ts` "an alias resolves to both, independently"                                                                            |
| 8   | Compaction is replayable and preserves tool-call closure      | **PASS** | `agent-loop.test.ts` "never splits a tool call from its result"; `replay-gate.test.ts` compaction boundary                               |
| 9   | Large tool output is budgeted and artifact-referenced         | **PASS** | `util.test.ts` truncation; `ToolRuntime` artifact spill asserted in `control-plane.test.ts` event-log checks                             |
| 10  | Every autonomous loop has a hard budget                       | **PASS** | `agent-loop.test.ts` "a step budget stops the turn"; "/loop cannot raise a budget above the ceiling"                                     |
| 11  | Secret paths cannot enter model context                       | **PASS** | `canary.test.ts`, `attacks.test.ts` (14 attacks, all six sinks)                                                                          |
| 12  | Secret values cannot reach model/telemetry/hook/plugin egress | **PASS** | `attacks.test.ts` six-sink assertion; `policy.test.ts` egress gate suite                                                                 |
| 13  | Child processes do not inherit the host environment           | **PASS** | `boundaries.test.ts` env scrub; `assertNoCredentialEnv` before every spawn; `pnpm lint` rule `no-ambient-env-spawn`                      |
| 14  | Agent/Skill/Hook/Subagent can only narrow                     | **PASS** | `boundaries.test.ts` escalation suite; `attacks.test.ts` skill + agent fixtures                                                          |
| 15  | Reference repositories are read-only                          | **PASS** | `attacks.test.ts` "write into the reference tree" + "the reference tree was not modified"                                                |

**No invariant is FAIL or NOT TESTED.**

---

## 2. P0 — CI (plan §3.5)

| DoD item                       | Status   | Evidence                                                                      |
| ------------------------------ | -------- | ----------------------------------------------------------------------------- |
| PR triggers CI                 | **PASS** | `.github/workflows/ci.yml` `on.pull_request`                                  |
| push to `main` triggers CI     | **PASS** | `on.push.branches: [main]`                                                    |
| typecheck blocking             | **PASS** | `static` job → `pnpm typecheck`                                               |
| lint blocking                  | **PASS** | `static` job → `pnpm lint` (see §6 for why it is not ESLint)                  |
| format blocking                | **PASS** | `static` job → `pnpm format:check`                                            |
| unit/integration blocking      | **PASS** | `test` job, Node 22 + 24 matrix                                               |
| security blocking              | **PASS** | `security` job                                                                |
| deterministic ×100 blocking    | **PASS** | `deterministic` job, `KERNEL_TRAJECTORY_REPEATS=100`                          |
| Linux smoke                    | **PASS** | `smoke` job, ubuntu-latest                                                    |
| macOS smoke                    | **PASS** | `smoke` job, macos-latest                                                     |
| Windows smoke                  | **PASS** | `smoke` job, windows-latest → `pnpm test:smoke` (15 tests)                    |
| CI needs no real model API key | **PASS** | `static` job asserts no `*_API_KEY` / `*_TOKEN` / `AWS_*` is set              |
| token read-only by default     | **PASS** | `permissions: contents: read`; `persist-credentials: false` on every checkout |

**Caveat, stated rather than hidden:** the CI file has never been executed on
GitHub — this repository is not a git repository, so there has been no run to
observe. Every command it invokes has been run locally on macOS. **Node 22 has
not been exercised at all** (only Node 25 is available here); that is the reason
for the 22 + 24 matrix.

---

## 3. P1 — M2 Kernel Hardening (plan §4.7)

| DoD item                      | Status   | Evidence                                                                                                                  |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| deterministic trajectory ×100 | **PASS** | `agent-loop.test.ts` "repeats without state leaking between runs" — 100 runs, one event shape                             |
| replay == live terminal state | **PASS** | `replay-gate.test.ts`, 11 tests over success / edit / failure / budget / cancel / goal / denial / compaction / multi-turn |
| model cancellation            | **PASS** | `hardening.test.ts` "cancelling while sampling ends the turn as cancelled and runs no tool"                               |
| tool cancellation             | **PASS** | `agent-loop.test.ts` "cancelling mid-turn ends in cancelled with every call answered"                                     |
| freshness regression          | **PASS** | stale / coverage / non-unique / concurrent-modification tests                                                             |
| atomic edit regression        | **PASS** | `agent-loop.test.ts` "a failed atomic write leaves no partial file"                                                       |
| CRLF preserved                | **PASS** | `agent-loop.test.ts` "a CRLF file stays CRLF after an edit"                                                               |
| secret canary                 | **PASS** | `canary.test.ts` (17) + `attacks.test.ts` (11)                                                                            |
| symlink / path traversal      | **PASS** | `attacks.test.ts` symlink + traversal attacks                                                                             |
| permission escalation         | **PASS** | `boundaries.test.ts` + `attacks.test.ts` skill/agent/project-config fixtures                                              |
| reference tree read-only      | **PASS** | `attacks.test.ts`                                                                                                         |
| Shell mutation detector       | **PASS** | `hardening.test.ts` §4.6 — tool result, context fact, and `workspace.mutation` event                                      |
| all 15 invariants             | **PASS** | §1 above                                                                                                                  |

### Replay coverage (plan §4.2)

`SessionTerminalState` is computed twice — once from memory, once from
`events.jsonl` alone — and compared field by field:

| Required by §4.2        | Reconstructed                                 | Status   |
| ----------------------- | --------------------------------------------- | -------- |
| Session state           | turn list with terminal states                | **PASS** |
| Turn terminal state     | `completed` / `failed` / `cancelled` per turn | **PASS** |
| Goal state              | `goal.changed` events, including clears       | **PASS** |
| tool-call closure       | `toolCalls` vs `answeredToolCalls`            | **PASS** |
| dirty-file facts        | `file.edited` events                          | **PASS** |
| relevant error state    | error code per failed turn                    | **PASS** |
| loop usage/budget facts | model requests, tool call count               | **PASS** |

---

## 4. Defects this phase found and fixed

Recorded because a hardening report that lists only passes is not a hardening
report.

1. **`PolicyEngine.combine` threw `ReferenceError`.** A refactor removed the
   `strictest` import while the function still called it. Every project-hook
   execution would have crashed. Found by the first real `tsc --noEmit` run;
   nothing in 179 passing tests reached it, because hook _parsing_ was tested and
   hook _execution_ was not. Fixed, and `hooks.test.ts` now exercises the path.

2. **`turn.fail()` inside the loop emitted no `turn.failed` event.** Budget
   exhaustion, provider errors and repeated-failure termination all set the turn
   to `failed` in memory while the event log showed a turn that never ended.
   Found by the replay gate. Terminal-event emission is now in exactly one place.

3. **`forceCompact` recorded no boundary event.** A provider-overflow compaction
   was invisible to replay, violating §20.3. Fixed.

4. **`sh -c 'tar cf - .env | base64'` exfiltrated the secret.** The argv path
   scanner looked at each argv element as a unit, so a whole command line inside
   a `-c` string was never searched for paths. The tar was base64-encoded, and
   redaction cannot recognise a secret re-encoded at an arbitrary byte offset —
   so the canary left the process. Found by adding the "archive workspace" attack
   from §26.1 to the harness. The scanner now splits embedded command lines, and
   the attack is refused at the path layer.

5. **`<root>/**` did not match the workspace root itself.** Grep and Glob against
   the root silently became approval prompts. Found by the permission matrix
   test.

6. **Rule specificity was scored by pattern length.** A fifty-way
   `{node,npm,…}` alternation outranked an exact `git`, so `git status` prompted
   and **`npm install` ran without asking**. Found by the Appendix A matrix test.

7. **Readline over a pipe swallowed stdin.** Piped slash commands did nothing.
   Found by adding subprocess CLI tests.

---

## 5. P3–P7 status

WP8–WP11 were implemented ahead of this plan's schedule, so these are reported
against the plan's DoD lists rather than as future work.

### P3 — Control Plane / CLI (plan §7.4)

| DoD item                                  | Status   | Evidence                                                 |
| ----------------------------------------- | -------- | -------------------------------------------------------- |
| startup flags usable                      | **PASS** | `cli.test.ts`, `control-plane.test.ts`                   |
| `/model` changes next-Step model          | **PASS** | `control-plane.test.ts`                                  |
| `/goal` sets structured GoalState         | **PASS** | `control-plane.test.ts`, `replay-gate.test.ts`           |
| `/loop` sets a bounded budget             | **PASS** | `control-plane.test.ts` clamp test                       |
| `/permissions` shows effective capability | **PASS** | `control-plane.test.ts`                                  |
| `/status` reflects real kernel state      | **PASS** | `control-plane.test.ts`, `cli.test.ts`                   |
| control commands bypass the model         | **PASS** | asserted via `fakeModel.callCount` staying flat          |
| approval cache is subject-scoped          | **PASS** | `policy.test.ts` "remembered against a concrete subject" |

### P4 — Resume / Replay (plan §8)

| DoD item                                  | Status   | Evidence                                                                 |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------ |
| clean resume                              | **PASS** | `cli.test.ts` `-c`; `control-plane.test.ts` replay                       |
| interrupted sampling recovery             | **PASS** | `control-plane.test.ts` synthetic result test                            |
| interrupted tool closure                  | **PASS** | same                                                                     |
| append-only log                           | **PASS** | `agent-loop.test.ts` contiguous `seq`                                    |
| workspace identity check                  | **PASS** | `control-plane.test.ts` "resuming into a different workspace is refused" |
| freshness rebuild                         | **PASS** | receipts deliberately not restored; asserted                             |
| stale receipt invalidated                 | **PASS** | `hardening.test.ts`                                                      |
| uncertain destructive action not repeated | **PASS** | synthetic result says the outcome is unknown; asserted                   |

**NOT TESTED:** a genuine mid-turn `SIGKILL` followed by `agent -r`. Resume is
tested by replaying a log written with an unclosed tool call, which is the same
state a kill produces, but the kill itself is not exercised.

### P5 — Skills / Agents / Hooks (plan §9)

| DoD item                                  | Status   | Evidence                                                    |
| ----------------------------------------- | -------- | ----------------------------------------------------------- |
| Skill discovery                           | **PASS** | `attacks.test.ts` finds the fixture skill                   |
| malformed metadata rejected               | **PASS** | `util.test.ts` frontmatter errors                           |
| Skill cannot escalate                     | **PASS** | `boundaries.test.ts`, `attacks.test.ts`                     |
| Agent cannot escalate                     | **PASS** | same                                                        |
| Hook uses scrubbed env                    | **PASS** | `hooks.test.ts`                                             |
| Hook output redacted                      | **PASS** | `hooks.test.ts`, `attacks.test.ts`                          |
| Hook network via EgressGate               | **PASS** | hooks run through the executor; no raw client (`pnpm lint`) |
| extensions cannot change reference policy | **PASS** | `attacks.test.ts`                                           |

| lifecycle invocation from the turn loop | **PASS** | `hook-lifecycle.test.ts` (14 tests) |

**Lifecycle wiring: PASS.** Hooks are invoked from the turn loop at all eight
lifecycle points — `SessionStart`, `UserPromptSubmit`, `BeforeStep`,
`PreToolUse`, `PostToolUse`, `PermissionRequest`, `TurnEnd`, `SessionEnd`. The
asserted properties are that a hook fires at the right point with `{path}`
substituted; fires on failure and cancellation as well as success; cannot fail
the turn (a non-zero exit, a missing binary and an unparsable `hooks.toml` are
each reported, not fatal); is injected with `injection` provenance rather than as
the user; is audited even when policy refuses it; and still cannot escalate or
see an unscrubbed environment. The replay gate and the attack harness both now
run with hooks active, so hook injections are proven not to break tool-call
closure or the live/replay equality.

### P6 — SSH backend (plan §10)

| DoD item                                                                      | Status         | Evidence                                                                                                                                          |
| ----------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ForwardAgent disabled                                                         | **PASS**       | `boundaries.test.ts`, `attacks.test.ts`                                                                                                           |
| host secrets not forwarded                                                    | **PASS**       | `validateRemoteConfig` refuses `forward_env`                                                                                                      |
| StepContext backend frozen                                                    | **PASS**       | `/remote connect` refuses mid-session switching                                                                                                   |
| remote connect / read / grep / shell / GitDiff / path jail / output redaction | **NOT TESTED** | No live SSH host. Config validation and argv construction are tested; the filesystem-over-POSIX-snippets path has never run against a real remote |

### P7 — Compaction (plan §11)

| DoD item                                 | Status   | Evidence                                                                                        |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| prune old large output first             | **PASS** | `agent-loop.test.ts` L0 applied                                                                 |
| recent tail preserved                    | **PASS** | same                                                                                            |
| summary sees redacted input only         | **PASS** | redaction happens at read/tool-result time, before append; `attacks.test.ts` six-sink assertion |
| Goal reinjected                          | **PASS** | `compact()` L3                                                                                  |
| dirty-file facts survive                 | **PASS** | `EditJournal.summary()` reinjected                                                              |
| boundary event recorded                  | **PASS** | `replay-gate.test.ts`                                                                           |
| overflow retry bounded                   | **PASS** | loop budget; `forceCompact` runs once per overflow                                              |
| resume after compaction                  | **PASS** | `replay-gate.test.ts` compaction test                                                           |
| deterministic/security suites stay green | **PASS** | full run                                                                                        |

---

## 6. Known limitations

These are properties the kernel does **not** have. They are listed so nobody has
to discover them from a failing assumption.

1. **`policy-enforced`, not `os-isolated`.** A subprocess runs with the user's
   rights. The kernel controls what it is handed and redacts what it emits; it
   does not confine it. See `docs/threat-model.md`.

2. **A subprocess can re-encode a secret past redaction.** Fix #4 above closed
   the `tar | base64` route by refusing the path, but redaction fundamentally
   cannot recognise a value the process transformed. Path-level denial is the
   defence; redaction is the backstop, not the boundary.

3. **Argv path extraction is heuristic.** It now covers embedded command lines,
   quoted strings and flag values. It cannot cover a path the program computes
   at runtime.

4. **SSH is untested against a live host** (see P6 above).

5. **Windows runs the smoke suite only.** The full suite assumes POSIX tooling.

6. **No real provider has been contacted.** P2 requires credentials this
   environment does not have; the three adapters are tested against recorded
   transcripts, not live endpoints.

---

## 7. Gate for `v0.1.0-alpha.1`

Plan §5 requires P0 + P1 green. They are, with the caveats in §2 and §6.

The tag itself **cannot be created**: this tree is not a git repository, so there
is no history to tag and no commit hash to record. See
`docs/release-checklist-alpha1.md` for the sequence to run once it is one.
