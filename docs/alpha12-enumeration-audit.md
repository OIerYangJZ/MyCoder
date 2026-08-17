# The enumeration audit — every hand-maintained list, and whether anything would notice

**Date:** 2026-08-17 · **Milestone:** `v0.1.0-alpha.12` — CLOSURE B

> A hand-maintained list that mirrors something else will stop mirroring it. The
> question is never whether, only whether anything will say so.

alpha.6 shipped an evidence matrix that `scripts/evidence.ts`'s hardcoded
`MATRICES` list did not include. It stayed invisible for five milestones — inside
the mechanism whose entire purpose is catching drift, while `docs/open-evidence.md`
cited it as the home of two open claims. alpha.11 fixed that one list and added the
check that would have caught it. This is the obvious next question: **which other
lists are like that?**

**97 enumerations** in `src/` and `scripts/`. **22 guarded, 13 declared unguarded,
62 closed by design.** Two of the mirrors had already drifted, and one of those two
sits in a document that claims in its own words that it cannot.

---

## 1. What the verdicts mean

```text
GUARDED     something fails when the two sides stop agreeing, and that
            something has been run against a repository where they disagree
UNGUARDED   it mirrors something, nothing compares them, and the reason is
            written down here rather than left as an oversight
CLOSED      nothing mirrors it. A vocabulary, a deny list, a schema, a set of
            defaults — there is no second copy to drift from
```

**The deliverable is not "make them all checked".** A sweep that quietly guards the
easy ones and says nothing about the rest is the thing this closure exists to
prevent. `UNGUARDED` is a legitimate answer with a cost attached; an enumeration
absent from this document is not an answer at all, and
`checkAuditCoverage` in `scripts/mirrors.ts` fails the build for it.

**Both directions are checked**, for the reason alpha.11 gave: an enumeration with
no row here is one nobody classified, and a row here naming an enumeration that no
longer exists asserts that something is covered when the thing is gone. That is
what a rename leaves behind.

## 2. The two that had already drifted

Found by writing the checks, in a repository whose gates were green.

**`CEILING_PINNED` had nine entries and `docs/configuration-audit.md` listed
eight.** The missing one is `[mcp.servers.*] credential / api_key`, added in
alpha.9 — a literal credential in an MCP server config is warned about and
discarded, and only `credential_ref` is honoured. That is a security-relevant
statement about the configuration surface, it was recorded in the code, and the
document a reader consults did not have it. The same document says, of its own
tables:

> A row here that were merely prose could go stale; this one fails the build.

It did not. `tests/unit/config-weakening.test.ts` compares `WEAKENING_KEYS` and
`CEILING_PINNED` against **the parser** — which is a real and useful check, and is
not the document. Nothing read the markdown. The claim was true about the code and
false about the sentence it appeared in.

**`docs/cli-contract.md` was read by nothing at all.** ADR-0021 promises that
contract semantics will not change within `0.1.x`, and
`tests/integration/cli-contract.test.ts` asserts against `src/cli/args.ts` — the
code, against the code. A flag could be added, or moved from experimental to
contract, and the one document a script author reads would never have said so.
It is the document ADR-0021 exists to make trustworthy, and it was the least
verified file in the repository.

Both are `GUARDED` as of this milestone, each with a fixture that makes the check
fail.

## 3. Where the gate is

`tests/lint/mirrors.test.ts`, which runs under `pnpm test` and `pnpm lint:selftest`
— in CI and in the release gate. The pure comparisons live in
`scripts/mirrors.ts`, and `node scripts/mirrors.ts` prints the report for a human;
that entry point is **not** the gate, and the module header says so.

Seven mirrors are checked:

| Id                    | Sides                                                     | Note                                                       |
| --------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `cli-contract`        | `src/cli/args.ts` ↔ `docs/cli-contract.md`                | flags, backends and subcommands, both directions           |
| `exit-codes`          | `src/cli/exit-codes.ts` ↔ `docs/cli-contract.md`          | names **and** numbers; a wrapper branches on these         |
| `packaged-files`      | `scripts/package-check.ts` ↔ `package.json` `files`       | reachability, not equality — `files` names directories     |
| `configuration-audit` | `src/config/weakening.ts` ↔ `docs/configuration-audit.md` | the drift above                                            |
| `acceptance-tiers`    | `scripts/acceptance.ts` ↔ ADR-0027 §2                     | the ADR decides the tiers; the code must not invent one    |
| `hook-events`         | `src/extensions/hooks.ts` ↔ spec §18.1                    | the one mirror whose other side is outside this repository |
| `readme-tools`        | `src/tools/builtin/` ↔ `README.md`                        | one direction only; §4 says why                            |

**`hook-events` can be unavailable.** The normative specification lives in
`research/`, which is in no version control and will be deleted. When it is absent
the check reports **NOT CHECKED** rather than passing — the same rule
`KERNEL_CONTAINER_REQUIRED` exists for one layer down, and the same rule the
acceptance suite's clause coverage follows.

## 4. What is deliberately not guarded, and what it costs

**The eleven tool schemas.** Every builtin tool declares a `SCHEMA` — the JSON
schema the model is shown — beside a TypeScript `*Args` interface the code actually
uses. They mirror each other, and nothing compares them. A drifted schema either
advertises a parameter the code ignores or hides one it honours; the first wastes a
tool call, the second is worse, because the model never learns the parameter
exists. Guarding it needs type information at runtime and this repository has no
mechanism for that (ADR-0009: zero runtime dependencies, and a schema generator is
a dependency). Eleven declared rows and a named cost is the honest outcome.

**`TRUSTED_KERNEL_HOOKS` against spec §14.5.** A configuration naming one of these
is refused loudly, precisely because someone writing it believes they have
installed a security control. The list is therefore load-bearing for a refusal, and
nothing compares it with the specification that defines it. This one is cheap to
add and simply was not added; recording it beats guarding it quietly at the end of
a long milestone.

**`readme-tools`, in one direction.** Every tool README calls core must exist, and
the count it states must match the list it prints. The reverse — every builtin
appearing in README — is false by design: `WebFetch` is registered only when a host
is configured, `Delegate` only when something can be delegated, and `Undo` and
`Skill` are conditional too. So a _new_ core tool missing from README would not be
caught. Closing that needs a second hardcoded list of which builtins are
conditional, which is another mirror of exactly the kind this closure reduces.

## 5. What this audit does not cover

```text
the detector is syntactic     `const NAME = [ / new Set / {` at top level, with
                              a SCREAMING_SNAKE name. A list built by a function,
                              or bound to a lowercase name, is invisible to it —
                              and therefore invisible to this document
the classification is not     which of the 96 mirrors something else was decided
                              by reading. The gate insists every enumeration has
                              a verdict; it cannot know whether the verdict is right
tests/ and evals/             not walked. A fixture list that mirrors production
                              code is a real hazard and is out of scope here
markdown against markdown     `docs/` documents that mirror each other are the
                              evidence corpus's problem, and alpha.11 solved it
```

The first is the one to re-read in a year. It is the same shape as the defect this
closure is named after: a list that mechanism cannot see is a list nobody is
checking, and the honest response is to say where the blind spot is rather than to
imply there is none.

## 6. Every enumeration in `src/` and `scripts/`

Generated by `findEnumerations` in `scripts/mirrors.ts` — the same function the
gate uses, so this table cannot describe a different repository than the one being
checked.

### GUARDED

| Enumeration             | Where                      | Verdict | What checks it                                                                                                          |
| ----------------------- | -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `TIERS`                 | `scripts/acceptance.ts`    | GUARDED | mirror `acceptance-tiers` — ADR-0027 §2 is where tiers are decided                                                      |
| `SOURCES`               | `scripts/acceptance.ts`    | GUARDED | scripts/acceptance.ts — the suite's `by source` counts are recomputed from these prefixes and compared                  |
| `MATRICES`              | `scripts/evidence.ts`      | GUARDED | tests/lint/evidence-corpus.test.ts — every `*evidence-matrix.md` in docs/ is registered. The alpha.6 defect, as a check |
| `RULES`                 | `scripts/lint.ts`          | GUARDED | tests/lint/lint-selftest.test.ts — every rule has a must-fail and a must-pass fixture. **The model for all of these**   |
| `SKIP_DIRS`             | `scripts/lint.ts`          | GUARDED | exported and imported by `scripts/mirrors.ts`, so there is one copy rather than two                                     |
| `MIRRORS`               | `scripts/mirrors.ts`       | GUARDED | tests/lint/mirrors.test.ts — every id here appears in this audit, and every id here has a check                         |
| `REQUIRED`              | `scripts/package-check.ts` | GUARDED | mirror `packaged-files` — every required file must be reachable from `package.json` `files`                             |
| `SUBCOMMANDS`           | `src/cli/args.ts`          | GUARDED | mirror `cli-contract`                                                                                                   |
| `CONTRACT_FLAGS`        | `src/cli/args.ts`          | GUARDED | mirror `cli-contract` — **the one that mattered**; see §2                                                               |
| `EXPERIMENTAL_FLAGS`    | `src/cli/args.ts`          | GUARDED | mirror `cli-contract`                                                                                                   |
| `CONTRACT_BACKENDS`     | `src/cli/args.ts`          | GUARDED | mirror `cli-contract`                                                                                                   |
| `EXPERIMENTAL_BACKENDS` | `src/cli/args.ts`          | GUARDED | mirror `cli-contract`                                                                                                   |
| `EXIT`                  | `src/cli/exit-codes.ts`    | GUARDED | mirror `exit-codes` — the table a wrapper script branches on                                                            |
| `EXIT_NAMES`            | `src/cli/exit-codes.ts`    | GUARDED | `Record<ExitCode, string>`: `pnpm typecheck` refuses a missing or extra name                                            |
| `EXIT_FOR_ERROR`        | `src/cli/exit-codes.ts`    | GUARDED | `Record<ErrorCode, ExitCode>`: a new error code fails the typecheck until somebody decides its exit status              |
| `VALID_CAPABILITIES`    | `src/config/config.ts`     | GUARDED | the same test, from the other side                                                                                      |
| `WEAKENING_KEYS`        | `src/config/weakening.ts`  | GUARDED | mirror `configuration-audit`, plus tests/unit/config-weakening.test.ts against the parser                               |
| `CEILING_PINNED`        | `src/config/weakening.ts`  | GUARDED | mirror `configuration-audit` — **this one had already drifted**; see §2                                                 |
| `USER_HOOK_EVENTS`      | `src/extensions/hooks.ts`  | GUARDED | mirror `hook-events` — spec §18.1, and reported as unchecked when the spec is absent                                    |
| `ALL_CAPABILITIES`      | `src/policy/access.ts`     | GUARDED | tests/unit/policy.test.ts — 'the config parser and the capability list cannot drift apart'                              |
| `BUILTIN_PROFILES`      | `src/policy/profiles.ts`   | GUARDED | tests/unit/policy.test.ts — the Appendix A matrix iterates `workspace-dev`, `read-only` and `review` by name            |
| `DEFAULT_BLAME`         | `src/util/errors.ts`       | GUARDED | `Record<ErrorCode, Blame>`: exhaustive, enforced by the typecheck                                                       |

### UNGUARDED

| Enumeration            | Where                            | Verdict   | Why not, and what it mirrors                                                                                                                                                                                                                |
| ---------------------- | -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUSTED_KERNEL_HOOKS` | `src/extensions/hooks.ts`        | UNGUARDED | mirrors spec §14.5. A config naming one of these is refused loudly, so the list is load-bearing for a refusal — and nothing compares it with the specification. Cheap to add, not added this milestone, recorded instead of quietly guarded |
| `DEFAULT_ALIASES`      | `src/model/profiles.ts`          | UNGUARDED | mirrors nothing **today**: `docs/configuring-a-provider.md` shows a user writing their own alias rather than listing what ships. If that document ever lists the built-ins, this becomes a mirror and needs a check                         |
| `SCHEMA`               | `src/tools/builtin/delete.ts`    | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/edit.ts`      | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/git-diff.ts`  | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/glob.ts`      | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/grep.ts`      | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/move.ts`      | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/read.ts`      | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/shell.ts`     | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/undo.ts`      | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/web-fetch.ts` | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |
| `SCHEMA`               | `src/tools/builtin/write.ts`     | UNGUARDED | mirrors this tool's own `*Args` interface, in the same file — see §4                                                                                                                                                                        |

### CLOSED

| Enumeration                    | Where                                   | Verdict | Kind                                    |
| ------------------------------ | --------------------------------------- | ------- | --------------------------------------- |
| `CASES`                        | `scripts/audit-diff-reversibility.ts`   | CLOSED  | fixture list                            |
| `STATUSES`                     | `scripts/evidence.ts`                   | CLOSED  | vocabulary                              |
| `EVIDENCE_KINDS`               | `scripts/evidence.ts`                   | CLOSED  | vocabulary                              |
| `VERDICTS`                     | `scripts/mirrors.ts`                    | CLOSED  | vocabulary                              |
| `NUMBERS`                      | `scripts/mirrors.ts`                    | CLOSED  | lookup table                            |
| `FORBIDDEN`                    | `scripts/package-check.ts`              | CLOSED  | deny list                               |
| `LEGACY_PROJECT_DIRS`          | `src/app.ts`                            | CLOSED  | compatibility list                      |
| `TIPS`                         | `src/cli/render.ts`                     | CLOSED  | prose this file owns — the startup tips |
| `OPERATORS`                    | `src/cli/shell-parse.ts`                | CLOSED  | parser table                            |
| `VALID_ACTIONS`                | `src/config/config.ts`                  | CLOSED  | vocabulary                              |
| `SYSTEM_CEILING`               | `src/config/schema.ts`                  | CLOSED  | a ceiling this code owns                |
| `INSTRUCTION_FILES`            | `src/context/repository-plane.ts`       | CLOSED  | discovery list                          |
| `KINDS`                        | `src/edit/journal-log.ts`               | CLOSED  | vocabulary                              |
| `FORBIDDEN_MOUNT_SOURCES`      | `src/execution/container-plan.ts`       | CLOSED  | deny list                               |
| `FORBIDDEN_MOUNT_DESTINATIONS` | `src/execution/container-plan.ts`       | CLOSED  | deny list                               |
| `DEFAULT_CONTAINER_LIMITS`     | `src/execution/container.ts`            | CLOSED  | default this code owns                  |
| `BY_ERROR_CODE`                | `src/execution/diagnosis.ts`            | CLOSED  | mapping                                 |
| `MESSAGES`                     | `src/execution/diagnosis.ts`            | CLOSED  | presentation                            |
| `ORDER`                        | `src/execution/enforcement.ts`          | CLOSED  | vocabulary                              |
| `DIMENSION_LABELS`             | `src/execution/enforcement.ts`          | CLOSED  | presentation                            |
| `LAUNCHER_EXIT`                | `src/execution/linux-native/backend.ts` | CLOSED  | vocabulary                              |
| `CFLAGS`                       | `src/execution/linux-native/build.ts`   | CLOSED  | build flags                             |
| `RUNTIME_BASE`                 | `src/execution/linux-native/plan.ts`    | CLOSED  | sandbox plan                            |
| `TEST_PATTERNS`                | `src/execution/mutation-detector.ts`    | CLOSED  | classification                          |
| `DOC_PATTERNS`                 | `src/execution/mutation-detector.ts`    | CLOSED  | classification                          |
| `CONFIG_PATTERNS`              | `src/execution/mutation-detector.ts`    | CLOSED  | classification                          |
| `ACCEPTED_PROTOCOL_VERSIONS`   | `src/mcp/protocol.ts`                   | CLOSED  | vocabulary                              |
| `DEFAULT_PROFILES`             | `src/model/profiles.ts`                 | CLOSED  | defaults this code owns                 |
| `DEFAULT_ENDPOINTS`            | `src/model/profiles.ts`                 | CLOSED  | defaults this code owns                 |
| `DEFAULT_RETRY`                | `src/model/runtime.ts`                  | CLOSED  | default this code owns                  |
| `PRIVILEGE_ESCALATION`         | `src/policy/policy-engine.ts`           | CLOSED  | policy list                             |
| `STRICTNESS`                   | `src/policy/profiles.ts`                | CLOSED  | vocabulary                              |
| `DEV_EXECUTABLES`              | `src/policy/profiles.ts`                | CLOSED  | policy list                             |
| `PACKAGE_MUTATION_ARGV`        | `src/policy/profiles.ts`                | CLOSED  | policy list                             |
| `LOCKFILE_PATTERNS`            | `src/policy/profiles.ts`                | CLOSED  | policy list                             |
| `SECRET_FILE_PATTERNS`         | `src/policy/protected-paths.ts`         | CLOSED  | deny list                               |
| `SECRET_FILE_EXCEPTIONS`       | `src/policy/protected-paths.ts`         | CLOSED  | deny list                               |
| `SYSTEM_WRITE_DENY`            | `src/policy/protected-paths.ts`         | CLOSED  | deny list                               |
| `SYSTEM_READ_DENY`             | `src/policy/protected-paths.ts`         | CLOSED  | deny list                               |
| `EGRESS_KINDS`                 | `src/security/egress-gate.ts`           | CLOSED  | vocabulary                              |
| `NO_HOSTS`                     | `src/security/egress-gate.ts`           | CLOSED  | the empty default                       |
| `TELEMETRY_FIELD_ALLOWLIST`    | `src/security/egress-gate.ts`           | CLOSED  | allowlist                               |
| `HOP_BY_HOP`                   | `src/security/egress-proxy/http.ts`     | CLOSED  | protocol constant                       |
| `DEFAULT_PROXY_LIMITS`         | `src/security/egress-proxy/proxy.ts`    | CLOSED  | default this code owns                  |
| `DEFAULT_ENV_ALLOWLIST`        | `src/security/env-scrub.ts`             | CLOSED  | allowlist                               |
| `CREDENTIAL_ENV_PATTERNS`      | `src/security/env-scrub.ts`             | CLOSED  | detection rules                         |
| `SECRET_RULES`                 | `src/security/secret-scanner.ts`        | CLOSED  | detection rules                         |
| `PLACEHOLDERS`                 | `src/security/secret-scanner.ts`        | CLOSED  | detection rules                         |
| `ROOT_SCOPE`                   | `src/session/delegation.ts`             | CLOSED  | scope constant                          |
| `DEFAULT_CHILD_BUDGET`         | `src/session/delegation.ts`             | CLOSED  | default this code owns                  |
| `REPLAY_EVENT_TYPES`           | `src/session/events.ts`                 | CLOSED  | vocabulary                              |
| `DEFAULT_LOOP_BUDGET`          | `src/session/step.ts`                   | CLOSED  | default this code owns                  |
| `TERMINAL_STATES`              | `src/session/turn.ts`                   | CLOSED  | state machine                           |
| `TRANSITIONS`                  | `src/session/turn.ts`                   | CLOSED  | state machine                           |
| `TEXTUAL_TYPES`                | `src/tools/builtin/web-fetch.ts`        | CLOSED  | content types                           |
| `ERROR_CODES`                  | `src/util/errors.ts`                    | CLOSED  | vocabulary                              |
| `RETRYABLE`                    | `src/util/errors.ts`                    | CLOSED  | judgement about codes this file owns    |
| `DROPPED_ELEMENTS`             | `src/util/html.ts`                      | CLOSED  | sanitiser list                          |
| `NAMED_ENTITIES`               | `src/util/html.ts`                      | CLOSED  | lookup table                            |
| `ORDER`                        | `src/util/logger.ts`                    | CLOSED  | vocabulary                              |
| `DEFAULT_TOOL_OUTPUT_BUDGET`   | `src/util/text.ts`                      | CLOSED  | default this code owns                  |
| `DEFAULT_IGNORES`              | `src/util/walk.ts`                      | CLOSED  | walk exclusions                         |

## Model provenance

No model was involved. Every statement here is about source files and documents in
this repository, compared by `scripts/mirrors.ts` and by reading.
