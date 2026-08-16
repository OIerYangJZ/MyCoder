# `v0.1.0-alpha.8` — Release Evidence Matrix

**Rule (alpha.3 §32.1, unchanged since):** a checklist item without named evidence
is not PASS.

`node scripts/evidence.ts` parses this table — and every earlier milestone's,
which are still checked on every run — and fails the build on any `PASS` with an
empty evidence cell, any reference with no recognised `kind:` prefix, any
`test:`/`suite:` naming something that appears nowhere under `tests/`, any
`artifact:` pointing at a missing or untracked file, and, new in alpha.8, any
matrix with no `Model provenance` section.

Evidence prefixes: `test:` `suite:` `ci:` `eval:` `artifact:` `live:` `manual:`.

## Model provenance

**Structural rows here are model-independent** — a package either contains
`tests/**` or it does not, a launcher either verifies or it does not, an exit code
either is 3 or is not. Most of this matrix is that kind of row.

The behavioural rows are in §8, and they name two models explicitly:

- **Model 1 — `deepseek-chat`** (DeepSeek, `openai-chat`), the model every
  behavioural number in alpha.2–alpha.7 was measured on;
- **Model 2 — `gpt-5.6-terra`** served through the relay at `api1.aisz.mom`
  (`openai-chat`), configured through user config only, run under §21's fairness
  rules: same fixtures, same prompts, same `fixtureVersion`, same N, no per-model
  prompt tuning.

Results are reported **side by side and never averaged** (§22). Where they differ,
the finding is that the earlier claim was single-model — a correction to the
record, not a regression.

Host tiers: offline suite on macOS arm64 (Darwin 25.5.0) and the native-Linux
evidence host (Ubuntu 26.04 aarch64, kernel 7.0.0-29-generic). The install dogfood
ran on the latter, from a packaged artifact, with no development tree present.

---

## 0. Preflight — the backlog (§17)

The milestone's first requirement, and the one that found a defect before any new
code was written.

| Requirement                                      | Status | Evidence                                                                                                       | Notes                                                                                  |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| the 65-file working tree is committed            | PASS   | manual:three commits on alpha7-tool-surface, 6237a98 / e189e1e / 1a5bfe8                                       | Tool round, measurement round, native sandbox                                          |
| each unit is green on its own                    | PASS   | manual:each commit checked out into a worktree and run: 914/841, 922/849, 961/868, 0 fail each                 | Splitting was worth it on its own; see the merge commit                                |
| alpha.6 merged to main and tagged                | PASS   | manual:merge ec6ec93, tag v0.1.0-alpha.6 on d9ba966                                                            | The tag points at the _fixed_ commit, not the merge — see the row below                |
| alpha.7 merged to main and tagged                | PASS   | manual:merge de37640, tag v0.1.0-alpha.7                                                                       |                                                                                        |
| evidence re-run **at** each tagged commit        | PASS   | artifact:docs/alpha8-status.md                                                                                 | alpha.6: 855 · 784 pass · 0 fail · 71 skip. alpha.7: 961 · 868 pass · 0 fail · 93 skip |
| **a previously-PASS row went red and was fixed** | PASS   | manual:pnpm evidence at f3826cb failed on a renamed container test; fixed in d9ba966 before the tag was placed | Defect 1. See §27's Evidence Stop — it was fixed, not restated                         |
| no tag points at a working tree                  | PASS   | manual:git describe --exact-match on both tags resolves to a commit                                            |                                                                                        |

---

## 1. Distribution artifact (§8, §9, ADR-0019)

| Requirement                                         | Status | Evidence                                                                                                | Notes                                                           |
| --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ADR-0019 accepted, all six questions answered       | PASS   | artifact:docs/adr/ADR-0019-distribution-and-runtime-version-policy.md                                   | §1 was decided, refuted by the dogfood, and re-decided in place |
| an installable artifact exists                      | PASS   | manual:pnpm release:pack produced mycoder-0.1.0.tgz, installed with npm install -g on the evidence host | 360 files                                                       |
| **the published form actually runs when installed** | PASS   | manual:npm install -g on a host with no checkout, then mycoder --version and a full session             | Defect 2 — see §8 below; this row was FAIL before it            |
| package contains nothing forbidden                  | PASS   | test:contains nothing forbidden and nothing is missing                                                  | A content assertion on `npm pack`, not an `.npmignore` review   |
| every forbidden rule can actually reject something  | PASS   | test:NEGATIVE CONTROL: every forbidden rule rejects something                                           | Nine rules, nine planted paths                                  |
| a missing required file is detected                 | PASS   | test:NEGATIVE CONTROL: a missing required file is reported                                              |                                                                 |
| `reference/**` and `research/**` never ship         | PASS   | test:NEGATIVE CONTROL: every forbidden rule rejects something                                           | spec §23 on a consumer's disk                                   |
| `tests/**` never ships                              | PASS   | test:NEGATIVE CONTROL: every forbidden rule rejects something                                           | The canary fixtures are deliberately credential-shaped          |
| the artifact records the commit it was built from   | PASS   | artifact:scripts/pack.ts                                                                                | `build-info.json`; `--release` refuses a dirty tree             |
| a supported-platform matrix is documented           | PASS   | artifact:docs/installing.md                                                                             | Tier 1 Linux/macOS, tier 2 Windows, with what "supported" means |

---

## 2. Runtime-version policy (§8)

| Requirement                                         | Status | Evidence                                                                            | Notes                                                              |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| an unsupported runtime fails with a named error     | PASS   | test:an older Node is refused, and the message names problem, version and remedy    | `RUNTIME_UNSUPPORTED`, not `SyntaxError`                           |
| the message names the required version and a remedy | PASS   | test:an older Node is refused, and the message names problem, version and remedy    | And how to verify                                                  |
| problem, reason and remedy appear in that order     | PASS   | test:the message is the one a user would act on, not a description of one           | A remedy above the problem reads as a suggestion                   |
| the boundary is inclusive and numeric               | PASS   | test:the boundary is inclusive: exactly the floor is supported                      | `22.9.0 < 22.18.0` — a lexical compare would refuse a good runtime |
| the entry point parses without type stripping       | PASS   | test:the shim parses with type stripping disabled                                   | `node --no-experimental-strip-types --check`                       |
| **the control: the kernel entry does NOT**          | PASS   | test:NEGATIVE CONTROL: the kernel entry point does NOT parse without type stripping | Without it the shim proves nothing about why it exists             |
| the floor is declared in exactly one place          | PASS   | test:the declared engine floor is the one the shim enforces                         | `engines.node`; two copies is one that goes stale                  |
| an unparseable version fails **open**               | PASS   | test:an unparseable version is allowed through rather than blocking a valid runtime | Ergonomics, not a boundary                                         |
| the exit code is UNAVAILABLE                        | PASS   | test:the exit code is UNAVAILABLE, not a generic failure                            | 5, so a wrapper can branch on it                                   |

---

## 3. First run and credential safety (§10, §11)

| Requirement                                                | Status | Evidence                                                                   | Notes                                                  |
| ---------------------------------------------------------- | ------ | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| **a fresh install no longer runs the fake model silently** | PASS   | test:no provider configured exits CONFIG (3), with a remedy and no session | Defect 3 — it used to answer and exit 0                |
| blocked names the file to create                           | PASS   | test:nothing configured: blocked, naming file, keys and verify command     |                                                        |
| blocked names the keys to set                              | PASS   | test:nothing configured: blocked, naming file, keys and verify command     | A copy-pasteable TOML block                            |
| blocked names the command to verify                        | PASS   | test:nothing configured: blocked, naming file, keys and verify command     | `mycoder doctor`                                       |
| never a stack trace                                        | PASS   | test:no provider configured exits CONFIG (3), with a remedy and no session | Asserted as an absence                                 |
| never a silently degraded session                          | PASS   | test:no provider configured exits CONFIG (3), with a remedy and no session | Asserted as an absence                                 |
| one discoverable provider is usable, and says so           | PASS   | test:one alias and no default: usable, because a provider was discoverable | §10's first outcome                                    |
| two providers and no default is blocked, not guessed       | PASS   | test:two aliases and no default: blocked rather than guessed               | Guessing means silently choosing where prompts go      |
| a deliberate `fake` still works                            | PASS   | test:fake chosen deliberately is ready — the offline suite depends on it   | _Chosen_ versus _defaulted into_                       |
| **an unusable credential blocks the start**                | PASS   | test:a missing credential blocks the start and names the variable          | Was a warning + a first-turn failure; §10 forbids that |
| a credential is never written world-readable               | PASS   | test:writes 0600 from a pipe and never echoes the value                    | Asserted against the filesystem, not the report        |
| a credential is never echoed                               | PASS   | test:writes 0600 from a pipe and never echoes the value                    | Absent from both streams                               |
| a terminal is refused rather than read from                | PASS   | test:refuses a terminal rather than reading a key from one                 | No raw-mode path to get subtly wrong                   |
| a credential is never written inside the workspace         | PASS   | test:refuses to write inside the workspace, before writing anything        | **Before** writing — see the defect note               |
| an existing key is never clobbered                         | PASS   | test:refuses to clobber an existing key without --force                    |                                                        |
| `--force` still lands on 0600                              | PASS   | test:--force replaces the file and still lands on 0600                     | `open` mode applies only on creation                   |
| setup never produces a file the kernel refuses             | PASS   | test:the whole path works end to end: setup, then doctor says ready        | §11's own rule, across two processes                   |
| `doctor` changes nothing on disk                           | PASS   | test:changes nothing on disk                                               |                                                        |
| `doctor` works when the kernel will not start              | PASS   | test:doctor emits the same envelope and a machine-readable verdict         | It builds no kernel                                    |

---

## 4. Configuration truthfulness (§12)

| Requirement                                         | Status | Evidence                                                                 | Notes                                               |
| --------------------------------------------------- | ------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| every key audited, recorded as evidence not a claim | PASS   | artifact:docs/configuration-audit.md                                     | Generated from `src/config/weakening.ts`            |
| each weakening key says what it opens               | PASS   | test:every audited key documents what it opens and what stays denied     |                                                     |
| each says what remains denied                       | PASS   | test:every audited key documents what it opens and what stays denied     | §12's fourth requirement, the one usually skipped   |
| a user-only key cannot be opened by a project       | PASS   | test:a user-only key cannot be turned on by a project config             | With the reverse control: the user layer _can_      |
| a project cannot add an egress host                 | PASS   | test:a project cannot add an egress host the user did not name           |                                                     |
| a project cannot open a new egress channel          | PASS   | test:a project cannot open a channel the user never enabled              |                                                     |
| a project cannot grant shell network                | PASS   | test:a project cannot grant shell network by default                     |                                                     |
| every set key is disclosed at startup               | PASS   | test:every set weakening key produces exactly one startup disclosure     | Reaches `/status` through `config.warnings`         |
| the control: no relaxation discloses nothing        | PASS   | test:a configuration with no relaxation discloses nothing                |                                                     |
| the ceiling pins what it claims to                  | PASS   | test:the ceiling pins what it claims to pin                              | 8 keys, listed in `CEILING_PINNED`                  |
| a lowered limit is still honoured                   | PASS   | test:a lowered limit is honoured — the ceiling is a ceiling, not a value |                                                     |
| **the audit cannot fall behind the parser**         | PASS   | test:the audit covers every key the parser understands                   | Derived from `schema.ts`; a new key fails the build |
| the control: an unaudited key would be detected     | PASS   | test:NEGATIVE CONTROL: an unaudited key would be detected                |                                                     |

---

## 5. CLI contract (§14, §15, ADR-0021)

| Requirement                                     | Status | Evidence                                                                          | Notes                                             |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| ADR-0021 accepted                               | PASS   | artifact:docs/adr/ADR-0021-cli-contract-stability.md                              |                                                   |
| a user-facing statement of it exists            | PASS   | artifact:docs/cli-contract.md                                                     |                                                   |
| every error code maps to a documented exit code | PASS   | test:every error code maps to a documented exit code                              | Exhaustive `Record<ErrorCode, ExitCode>`          |
| the six meanings are distinct                   | PASS   | test:the six meanings are distinct and none collides with a shell code            | And none collides with 127 or >=128               |
| CONFIG and UNAVAILABLE are not conflated        | PASS   | test:CONFIG and UNAVAILABLE are not conflated — the user file vs the user machine | The distinction a retrying wrapper needs          |
| a denial is not an incompletion                 | PASS   | test:a denial is not an incompletion                                              |                                                   |
| a turn reports its denial, not generic failure  | PASS   | test:a completed turn is 0; a turn that carried a denial reports the denial       |                                                   |
| usage errors exit 2                             | PASS   | test:an unknown flag exits USAGE (2)                                              | Also verified from the installed binary on the VM |
| configuration errors exit 3                     | PASS   | test:no provider configured exits CONFIG (3), with a remedy and no session        |                                                   |
| `--json` carries a schema tag                   | PASS   | test:every line on stdout under --json parses as JSON                             | `mycoder.v1`                                      |
| an error under `--json` is an object            | PASS   | test:an error under --json is a JSON object on stdout, not prose on stderr        | Never English on stderr for a machine consumer    |
| stdout under `--json` is only JSON              | PASS   | test:every line on stdout under --json parses as JSON                             |                                                   |
| every accepted flag has a declared stability    | PASS   | test:every flag the parser accepts is classified as contract or experimental      | Derived from the parser's own `case` labels       |
| `--help` marks the experimental ones            | PASS   | test:--help marks the experimental flags as experimental                          |                                                   |
| `--help` documents the exit codes               | PASS   | test:--help documents the exit codes                                              |                                                   |

---

## 6. Native launcher distribution (§16, ADR-0020)

| Requirement                                                | Status | Evidence                                                                                                             | Notes                                            |
| ---------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| ADR-0020 accepted, all four questions answered             | PASS   | artifact:docs/adr/ADR-0020-native-launcher-distribution.md                                                           | Explicit build step; never `postinstall`         |
| a missing launcher is refused                              | PASS   | test:a missing binary is refused, and the remedy is the build command                                                | Also live on the VM, exit 5                      |
| a binary with no manifest is refused                       | PASS   | test:a binary with no manifest is refused rather than assumed fine                                                   | No provenance is not "probably fine"             |
| a replaced binary is refused as `mismatched`               | PASS   | test:a replaced binary is mismatched, and the remedy says to find out what did it                                    |                                                  |
| a stale launcher is refused                                | PASS   | test:a launcher built from older source is stale, and says what it would enforce                                     | Also live on the VM by editing the shipped `.c`  |
| **staleness survives packaging**                           | PASS   | test:a launcher rebuilt from changed source is stale even when its mtime is newer                                    | Defect 4 — mtime could not answer this           |
| extraction order does not produce a false stale            | PASS   | test:extraction order does not make a good launcher look stale                                                       | The mirror case; would have broken every install |
| a corrupt manifest is refused                              | PASS   | test:a corrupt manifest is refused, not treated as absent                                                            |                                                  |
| a manifest without real digests is refused                 | PASS   | test:a manifest without real digests is refused                                                                      |                                                  |
| **no refusal offers a weaker backend**                     | PASS   | test:every refusal names a remedy, and none of them suggests a fallback                                              | alpha.7 §9 survives packaging                    |
| the user can verify the launcher matches the kernel        | PASS   | test:--sandbox-status renders both the ok and the refused case                                                       | Both hashes and the verdict                      |
| a packaged install refuses rather than degrading, for real | PASS   | manual:on the evidence host, with the launcher removed, --backend linux-native exited 5 and started no local session | §27's Launcher Stop, exercised                   |
| the identity check runs on every platform                  | PASS   | suite:test:unit                                                                                                      | It is two SHA-256s; Landlock is irrelevant to it |

---

## 7. Release engineering and CI (§18)

| Requirement                                          | Status     | Evidence                                 | Notes                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ---------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI runs typecheck, lint, self-tests, format          | PASS       | ci:the `static` and `lint-selftest` jobs | Unchanged from alpha.3                                                                                                                                                                                                                               |
| CI runs the offline suite on both tier-1 platforms   | PASS       | ci:the `test` and `platform` jobs        | Node 22 and 24                                                                                                                                                                                                                                       |
| the evidence gate runs in CI                         | PASS       | ci:the `evidence` job                    |                                                                                                                                                                                                                                                      |
| the package contents assertion runs in CI            | PASS       | ci:the `packaging` job                   | New in alpha.8                                                                                                                                                                                                                                       |
| the container tier runs with `_REQUIRED`             | PASS       | ci:the `container` job                   | `KERNEL_CONTAINER_REQUIRED=1`                                                                                                                                                                                                                        |
| **the native tier runs with `_REQUIRED`**            | PASS       | ci:the `native-sandbox` job              | New in alpha.8; `KERNEL_NATIVE_REQUIRED=1`                                                                                                                                                                                                           |
| a release gate exists that runs at an exact commit   | PASS       | artifact:.github/workflows/release.yml   | Triggers on a tag; checks out that ref                                                                                                                                                                                                               |
| **a release cannot pass by skipping a tier**         | PASS       | artifact:.github/workflows/release.yml   | The `gate` job asserts every tier reported `success`; a skip is not a pass                                                                                                                                                                           |
| the release gate installs and drives the artifact    | PASS       | artifact:.github/workflows/release.yml   | Into a clean prefix, asserting doctor exits 3 and names the file                                                                                                                                                                                     |
| the release gate blocks when a tier fails            | PASS       | artifact:docs/alpha8-status.md           | Observed twice on real runs, for two different causes                                                                                                                                                                                                |
| offline gates run at an exact commit in CI           | PASS       | artifact:docs/alpha8-status.md           | Run `31931750015`: ubuntu **and** macOS, both success                                                                                                                                                                                                |
| the container tier runs `_REQUIRED` on a real runner | PASS       | artifact:docs/alpha8-status.md           | Run `31931750015`: success                                                                                                                                                                                                                           |
| the native tier runs `_REQUIRED` on a real runner    | PASS       | artifact:docs/alpha8-status.md           | Run `31931750015`: success — GitHub's ubuntu image carries Landlock, so it ran, not skipped                                                                                                                                                          |
| the artifact job passes in CI                        | NOT TESTED | artifact:docs/alpha8-status.md           | Three defects found by running it (13, 14, 15), all fixed; the verifying run never started — the account's Actions spending limit was reached. ENVIRONMENT_ERROR under §23, not a code state. The same path was driven by hand on the evidence host. |
| **an end-to-end green Release Gate**                 | NOT TESTED | artifact:docs/alpha8-status.md           | Four of five tiers green; blocked only on the row above                                                                                                                                                                                              |

---

## 8. Cross-model validation (§19–§23)

Reported side by side, never averaged. Full write-up: `docs/alpha8-cross-model.md`.

| Requirement                                              | Status     | Evidence                                                                                             | Notes                                                                                                                              |
| -------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| a second provider is configured through user config only | PASS       | artifact:docs/alpha8-cross-model.md                                                                  | `gpt-5.6-terra` over `openai-chat`; a relay, and the document says so                                                              |
| every behavioural claim names its model                  | PASS       | artifact:scripts/evidence.ts                                                                         | The gate fails a matrix with no `Model provenance` section; it fired on all five                                                   |
| the tool-utility experiment is re-run                    | PASS       | artifact:evals/results/experiments/tool-utility-gpt-5.6-terra-5x-2026-08-16T04-45-57-312Z.json       | N=5, same fixtures, same prompts, no per-model tuning                                                                              |
| the delegation-utility experiment is re-run              | PASS       | artifact:evals/results/experiments/delegation-utility-gpt-5.6-terra-5x-2026-08-16T05-06-16-979Z.json | N=5, same three task shapes                                                                                                        |
| the golden set is re-run live                            | PASS       | artifact:docs/alpha8-cross-model.md                                                                  | See the appended section for the numbers                                                                                           |
| results are reported side by side, never averaged        | PASS       | artifact:docs/alpha8-cross-model.md                                                                  | Every table has two columns                                                                                                        |
| **a claim is found NOT to replicate, and is restated**   | PASS       | artifact:docs/alpha8-cross-model.md                                                                  | alpha.4's "0 of 25 delegations" is single-model: model 2 chose 10 of 15                                                            |
| the non-replication is a correction, not a regression    | PASS       | artifact:docs/alpha8-cross-model.md                                                                  | §22: the finding is that the earlier claim was single-model                                                                        |
| a claim IS found to replicate                            | PASS       | artifact:docs/alpha8-cross-model.md                                                                  | Tool utility: new tools used 12/15 → 15/15; `Edit` rejections 0 on both                                                            |
| delegation's _lack of utility_ replicates                | PASS       | artifact:docs/alpha8-cross-model.md                                                                  | Solve 5/5 in both arms on both models; model 2 pays +10k–12k median tokens for it                                                  |
| model 2 declines delegation where it would not pay       | PASS       | artifact:evals/results/experiments/delegation-utility-gpt-5.6-terra-5x-2026-08-16T05-06-16-979Z.json | 0/5 on `small`, 5/5 on `medium` and `large` — discrimination, not enthusiasm                                                       |
| every failure is attributable                            | PASS       | artifact:docs/alpha8-cross-model.md                                                                  | `insufficient_quota` = ENVIRONMENT_ERROR (the account's); the defect it exposed = ADAPTER_BUG (ours)                               |
| the adapter defect has a regression test                 | PASS       | test:an unpaid account is the account holder, not the provider                                       | Five cases plus a control                                                                                                          |
| the control: the old nesting really did find nothing     | PASS       | test:NEGATIVE CONTROL: reading the old, wrong nesting level finds nothing                            | Otherwise the fix would be describing a problem that did not exist                                                                 |
| no alpha.2–alpha.7 claim is retro-fitted as multi-model  | PASS       | artifact:docs/alpha8-cross-model.md                                                                  | The five earlier matrices say "single-model" in their own words                                                                    |
| **the first-choice provider could not be used**          | NOT TESTED | artifact:docs/alpha8-cross-model.md                                                                  | OpenAI directly returned `insufficient_quota`; the account has no credit. Recorded as ENVIRONMENT_ERROR rather than worked around. |

---

## 9. Outstanding non-claims (§24)

| Requirement                                      | Status     | Evidence                       | Notes                                                                                                                                                                                            |
| ------------------------------------------------ | ---------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| strict public-address egress on a clean resolver | NOT TESTED | artifact:docs/alpha8-status.md | Restated, not closed. Both available hosts NAT public names into 198.18.0.0/15; the positive control cannot be produced here. Unchanged from alpha.7 §39–§41.                                    |
| a **live-model** dogfood on the native backend   | NOT TESTED | artifact:docs/alpha8-status.md | Partially closed: a packaged install ran a real session on the native backend (§6), but with the fake model. Placing a provider credential on that host is the user's decision, not the agent's. |
