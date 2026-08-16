# `v0.1.0-alpha.5` — Release Evidence Matrix

**Rule (alpha.3 §32.1, restated in alpha.5 §66):** a checklist item without named
evidence is not PASS.

`node scripts/evidence.ts` parses this table — and alpha.3's and alpha.4's, which
are still checked on every run — and fails the build on any `PASS` with an empty
evidence cell, any evidence reference with no recognised `kind:` prefix, any
`test:`/`suite:` naming something that appears nowhere under `tests/`, and any
`artifact:` pointing at a file that is missing or untracked. It does **not** run
the tests; CI does that. It checks that the claims point at something real.

Status vocabulary is exactly four values:

| Status           | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| `PASS`           | A named, executable piece of evidence asserts it.             |
| `FAIL`           | Known broken. The evidence cell names what shows the failure. |
| `NOT TESTED`     | Not asserted here. The notes column says why, and what would. |
| `NOT APPLICABLE` | Out of scope for this milestone.                              |

Evidence prefixes: `test:` `suite:` `ci:` `eval:` `artifact:` `live:` `manual:`.

> **What "live" means in this matrix.** The container suites ran against a real
> Docker daemon: **macOS Docker Desktop** (docker 29.7.2, `linux/arm64`, kernel
> `6.12.76-linuxkit`) on the maintainer's machine, 143/143 twice consecutively,
> and against a **native Linux Docker Engine** in the `Container Enforcement` CI
> job, which fails rather than skips when the runtime is unusable. The long-session
> dogfood ran against **DeepSeek** over `openai-chat` on the container backend
> across a restart. What is still **not** claimed: native-Linux-equivalent
> isolation on macOS or Windows, host-scoped network allowlist enforcement, and
> anything about container or kernel zero-days.

## Model provenance

**This matrix is almost entirely about enforcement, not behaviour**, and
enforcement rows do not depend on which model is driving: a container either has
a route table or it does not.

The exceptions, and their model:

- the long-session dogfood rows — **`deepseek-chat` (DeepSeek, `openai-chat`)**,
  single-model;
- the eval rows carried over from alpha.3 — the same.

Host tiers are already distinguished in the "what live means" note above: macOS
Docker Desktop for the maintainer's runs, and a **native Linux Docker Engine** in
CI, which is the only tier the §37 isolation claim rests on.

---

## 0. Preflight (§58)

| Requirement                            | Status | Evidence                                                                                             | Notes                                                             |
| -------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `v0.1.0-alpha.4` tag remains immutable | PASS   | manual:the tag still points at its original commit; nothing in this milestone moved or re-created it |                                                                   |
| kickoff `main` SHA recorded            | PASS   | artifact:docs/alpha5-status.md                                                                       | `7663484`, the alpha.4 tag plus four follow-up PRs                |
| kickoff CI green                       | PASS   | ci:the run for `7663484` on `main`                                                                   | Recorded in `docs/alpha5-status.md` §1                            |
| `alpha.4.1` decision documented        | PASS   | artifact:docs/alpha5-status.md                                                                       | Not cut: no consumer needed a named release of the post-tag fixes |

---

## 1. Architecture (§6, §8, §9, ADR-0014)

| Requirement                                    | Status | Evidence                                                                                        | Notes                                                              |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| ADR-0014 accepted                              | PASS   | artifact:docs/adr/ADR-0014-container-execution-backend.md                                       | Covers all ten points §6 asks for                                  |
| ContainerBackend implements `ExecutionBackend` | PASS   | test:the backend is genuinely the container one                                                 | Same interface, no new methods on the contract                     |
| no Agent Loop container branch                 | PASS   | suite:lint:selftest                                                                             | `no-docker-cli-outside-container-backend`, with fixtures           |
| no ToolRuntime Docker branch                   | PASS   | suite:lint:selftest                                                                             | Same rule; the tool layer is unchanged this milestone              |
| zero runtime dependency rule preserved         | PASS   | ci:Static Checks asserts the dependency set is still empty                                      | The transport is the `docker` CLI through `spawn`                  |
| enforcement is per dimension, not one boolean  | PASS   | test:a container reports the filesystem as container-enforced and the broker as policy-enforced |                                                                    |
| the summary label is derived, never asserted   | PASS   | suite:lint:selftest                                                                             | `no-enforcement-overclaim`, plus `summarizeEnforcement` unit tests |

---

## 2. Runtime and transport (§10, §11, §40, §62)

| Requirement                               | Status | Evidence                                                                                                                                | Notes                                                        |
| ----------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Docker probe works                        | PASS   | test:the runtime and platform are recorded                                                                                              | Client, server, platform, kernel, rootless, security options |
| unavailable runtime fails closed          | PASS   | test:a missing binary is distinguished from an unreachable daemon                                                                       | `create()` throws; there is no fallback parameter to pass    |
| never silently falls back to local        | PASS   | manual:reviewed every return path in ContainerExecutionBackend.create — it throws or returns a container backend, with no third outcome | Reinforced by the absence of a `--backend auto`              |
| image controlled by trusted config        | PASS   | test:an untrusted image is refused                                                                                                      | Project-declared `container.image` is dropped with a warning |
| image provenance recorded                 | PASS   | test:the image digest is recorded (§11 provenance)                                                                                      | Configured ref, resolved id, digest                          |
| no implicit tool-time image pull          | PASS   | manual:resolveContainerImage only pulls when pullIfMissing is set at construction, never from exec                                      | `pull_if_missing` is user config only                        |
| error mapping is specific, not generic    | PASS   | test:docker error mapping — §62                                                                                                         | Six mappings plus ENOENT and OOM                             |
| a failing workload is not a backend error | PASS   | test:Shell non-zero exit is a result, not an infrastructure error                                                                       | Runs on both backends                                        |

---

## 3. Filesystem enforcement (§12–§17, §33, §59)

| Requirement                                 | Status | Evidence                                                                                  | Notes                                                     |
| ------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| workspace read-only by default              | PASS   | test:a read-only profile gets exactly one mount, and it is read-only                      |                                                           |
| rw roots are capability-derived             | PASS   | test:a workspace-dev profile gets writable overlays only where write was granted          | The case that fails if the plan is one hard-coded mount   |
| a single writable file is a file mount      | PASS   | test:a single writable file becomes a file mount, not a writable parent directory         |                                                           |
| write on the workspace root is not widened  | PASS   | test:write on the workspace root is refused and reported, never widened                   | Reported as `unrepresented`, per §14                      |
| protected host paths absent                 | PASS   | test:credential directories are absent, not merely denied                                 | `~/.ssh`, `~/.aws`, `~/.kube`, `~/.docker`, gcloud, gnupg |
| provider credential absent                  | PASS   | test:a protected host path given as an exact path is refused                              | Plus the canary rows below                                |
| host home absent                            | PASS   | test:the host home directory is absent                                                    | `$HOME` is the tmpfs                                      |
| Docker socket absent                        | PASS   | test:the Docker socket is absent everywhere it is normally found                          | Four socket paths                                         |
| `.git` semantics explicit                   | PASS   | test:.git is present and read-only                                                        | Write on `.git` is refused at plan time as well           |
| symlink and mount escapes green             | PASS   | test:a symlink out of the workspace resolves before the containment check, and is refused | Plus the live dangling-symlink rows                       |
| protected paths inside the workspace masked | PASS   | test:the protected .env inside the workspace is masked: present, empty, canary absent     | Not merely policy-denied                                  |
| tar/base64 exfiltration finds nothing       | PASS   | test:tar + base64 exfiltration of the workspace cannot include the masked secret          | Decoded and searched, not just checked for the literal    |
| mount plan validated before use             | PASS   | test:plan validation — §50                                                                | Eleven refusal cases                                      |

---

## 4. Process hardening (§18–§21, §26, §27)

| Requirement                         | Status | Evidence                                                                          | Notes                                                                                                                 |
| ----------------------------------- | ------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| rootfs read-only where claimed      | PASS   | test:the root filesystem is read-only                                             | `/` and `/usr/bin` both refused                                                                                       |
| temp paths explicit                 | PASS   | test:tmpfs is writable and does not survive the container                         | Sized tmpfs, fresh per execution                                                                                      |
| non-root behaviour validated        | PASS   | test:the process is unprivileged and cannot escalate                              | Host uid:gid on POSIX; `uid=0` never obtained                                                                         |
| capabilities dropped                | PASS   | test:the process is unprivileged and cannot escalate                              | `CapEff: 0000000000000000` read from inside                                                                           |
| no-new-privileges                   | PASS   | test:no-new-privileges blocks setuid escalation                                   |                                                                                                                       |
| host namespaces not shared          | PASS   | test:host namespaces are not shared: the container sees its own PID 1             |                                                                                                                       |
| env scrub preserved                 | PASS   | test:the workload environment contains nothing credential-shaped                  | Eight variables, all explicit                                                                                         |
| secrets never on the command line   | PASS   | test:an injected secret arrives, and does so without appearing in the docker argv | Value-less `--env NAME` form                                                                                          |
| cancellation cleans containers      | PASS   | test:a cancelled execution returns promptly and leaves no container behind        | Latency bound asserted; D-001                                                                                         |
| timeout terminates the container    | PASS   | test:a timeout kills the container promptly and reports timedOut                  | D-001 regression                                                                                                      |
| resource limits truthful            | PASS   | test:a fork bomb hits the pid limit instead of the host                           | Only `--pids-limit` is claimed as _tested_; memory and CPU are configured and asserted in the argv, not stress-tested |
| one container per execution         | PASS   | test:each execution is its own container, named uniquely                          |                                                                                                                       |
| container names are not model input | PASS   | test:a container name is never derived from model input                           |                                                                                                                       |

---

## 5. Network enforcement (§22–§24, §35)

| Requirement                               | Status | Evidence                                                                       | Notes                                                             |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `network=false` is container-enforced     | PASS   | test:the container has a loopback interface and no default route               | No `eth0`, empty route table                                      |
| curl blocked                              | PASS   | test:is blocked by the network namespace, not by a command scanner             |                                                                   |
| Node network blocked                      | PASS   | test:is blocked by the network namespace, not by a command scanner             | Plus raw TCP to a literal IP                                      |
| Python network blocked                    | PASS   | test:is blocked by the network namespace, not by a command scanner             | python3 presence asserted first                                   |
| DNS blocked                               | PASS   | test:is blocked by the network namespace, not by a command scanner             |                                                                   |
| package manager blocked                   | PASS   | test:is blocked by the network namespace, not by a command scanner             |                                                                   |
| the network negative control passes       | PASS   | test:the same command that fails with no network succeeds with network granted | Prints a NOTE instead of asserting on a machine with no internet  |
| host allowlist is not overclaimed         | PASS   | test:a container with network enabled does not claim network enforcement       | `networkAllowlist` stays `best-effort`                            |
| the approval prompt discloses the breadth | PASS   | test:enforcement descriptor — §7                                               | `describeApprovalNetwork` says "NOT enforced" in that case        |
| EgressGate regression green               | PASS   | suite:test:security                                                            | Unchanged this milestone; container isolation does not replace it |

---

## 6. Truthfulness (§7, §41, §42)

| Requirement                                       | Status | Evidence                                                                                                    | Notes                                               |
| ------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `/status` reports enforcement per dimension       | PASS   | test:the rendered description names every dimension, and never says "enforced" for policy                   | Six lines plus platform notes                       |
| the trusted broker is reported as policy-enforced | PASS   | test:the trusted broker still reaches the host, and is reported as policy-enforced                          | §28's separation, demonstrated rather than asserted |
| the model's description matches `/status`         | PASS   | manual:both are built from describeEnforcement over the same descriptor in kernel.ts, with no second string | Verified by reading the two call sites              |
| a VM-backed daemon does not claim native Linux    | PASS   | test:the platform note does not claim native-Linux isolation on a VM-backed daemon                          | Branches on the probed `nativeLinux`                |
| the audit log carries the descriptor              | PASS   | test:the event log records semantic facts, not container ids                                                | `session.started` carries the full breakdown        |
| no ephemeral container id in the log              | PASS   | test:the event log records semantic facts, not container ids                                                |                                                     |

---

## 7. Composition (§43–§48, §29)

| Requirement                                       | Status | Evidence                                                                         | Notes                                            |
| ------------------------------------------------- | ------ | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| Local conformance green                           | PASS   | suite:test:conformance                                                           | 14 semantic cases                                |
| Container conformance green                       | PASS   | test:the backend is genuinely the container one                                  | The same 14 cases on the container backend       |
| SSH conformance green                             | PASS   | suite:test:ssh                                                                   | The alpha.3/alpha.4 SSH matrix, re-run unchanged |
| Subagent + Container green                        | PASS   | test:a read-only child gets a read-only container, and the mount plan proves it  | Closes alpha.4's OS-isolation NOT TESTED row     |
| read-only child process cannot write              | PASS   | test:write fails at the filesystem layer, not only at the policy layer           |                                                  |
| Skill narrowing changes the execution plan        | PASS   | test:activating a read-only skill narrows the container the next command runs in | Wide profile writes; narrowed one cannot         |
| Hook containment green                            | PASS   | test:a project hook command runs inside the container, not on the host           | See D-002: this test used to pass vacuously      |
| a hook cannot reach host credentials              | PASS   | test:a hook cannot read a host credential path that policy would also deny       |                                                  |
| shell mutation auditing survives containerisation | PASS   | test:a containerised write is detected by the git snapshot strategy              | `.git` read-only did not demote the detector     |
| replay green                                      | PASS   | suite:test:replay                                                                | Unchanged gate, re-run                           |
| resume green                                      | PASS   | test:a resumed session builds a new container environment and continues          |                                                  |
| compaction regression green                       | PASS   | suite:test:soak                                                                  | 50 repeats, unchanged from alpha.4               |

---

## 8. Platform truthfulness (§37, §38, §39, §65)

| Requirement                                    | Status     | Evidence                                                                           | Notes                                                                                                 |
| ---------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| native Linux strong-enforcement suite executed | PASS       | ci:Container Enforcement (native Linux Docker)                                     | Fail-closed via `KERNEL_CONTAINER_REQUIRED=1`; see §9 of the status document for the run              |
| the Linux environment is recorded              | PASS       | ci:Container Enforcement (native Linux Docker)                                     | The job prints `docker version`, `docker info` and `uname -a` before the suites                       |
| a container leak fails the CI job              | PASS       | ci:Container Enforcement (native Linux Docker)                                     | A post-suite step greps `docker ps -a` for `mycoder-*`                                                |
| macOS Docker Desktop status recorded           | PASS       | artifact:docs/alpha5-container-validation.md                                       | Tier B: executed, 143/143, and explicitly not called equivalent                                       |
| Windows Docker Desktop status recorded         | NOT TESTED |                                                                                    | No trustworthy runner. §39 permits compatibility-only status; no claim is made for Windows containers |
| untested platforms are not called equivalent   | PASS       | test:the platform note does not claim native-Linux isolation on a VM-backed daemon | The kernel itself refuses to say it                                                                   |

---

## 9. Dogfood (§51–§55)

| Requirement                           | Status | Evidence                                                                    | Notes                                                                  |
| ------------------------------------- | ------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| a real long-session dogfood executed  | PASS   | artifact:docs/alpha5-dogfood.md                                             | DeepSeek, container backend, 5 turns across a restart                  |
| the run artifact is committed         | PASS   | artifact:evals/results/release/alpha5-dogfood-2026-08-14T16-04-57-948Z.json | Environment, turns, approvals, safety checks, usage                    |
| a defect ledger was produced          | PASS   | artifact:docs/alpha5-dogfood.md                                             | D-001 … D-005                                                          |
| safety defects fixed before the tag   | PASS   | artifact:docs/alpha5-dogfood.md                                             | None found; the three real defects were correctness/evidence           |
| correctness defects classified        | PASS   | artifact:docs/alpha5-dogfood.md                                             | Layer, safety, correctness and "why earlier gates missed it" per entry |
| fixed defects have regressions        | PASS   | test:D-003 — the cost breakdown survives a restart                          | Confirmed to fail against the unfixed code                             |
| zero canary leakage in the dogfood    | PASS   | artifact:evals/results/release/alpha5-dogfood-2026-08-14T16-04-57-948Z.json | Transcript, event log and workspace all checked                        |
| the permission boundary was exercised | PASS   | artifact:evals/results/release/alpha5-dogfood-2026-08-14T16-04-57-948Z.json | `npm install` prompted, declined, model stopped cleanly                |
| limitations recorded                  | PASS   | artifact:docs/alpha5-dogfood.md                                             | §4: one session, Docker Desktop, programmatic approvals, no delegation |

---

## 10. Regression (§68 "Regression")

| Requirement                             | Status | Evidence                        | Notes                                                           |
| --------------------------------------- | ------ | ------------------------------- | --------------------------------------------------------------- |
| all pre-alpha.5 tests green             | PASS   | suite:test                      | 732 tests, 661 pass, 0 fail, 71 skipped (the opt-in SSH matrix) |
| the offline suite gained coverage       | PASS   | suite:test                      | 643 → 732 tests; nothing was deleted or weakened                |
| Node 22 green                           | PASS   | ci:Unit + Integration / Node 22 |                                                                 |
| Node 24 green                           | PASS   | ci:Unit + Integration / Node 24 |                                                                 |
| Linux green                             | PASS   | ci:Platform / ubuntu-latest     |                                                                 |
| macOS green                             | PASS   | ci:Platform / macos-latest      |                                                                 |
| Windows smoke green                     | PASS   | ci:Smoke / windows-latest       | The container suites skip there; §39                            |
| replay green                            | PASS   | suite:test:replay               |                                                                 |
| deterministic suites green              | PASS   | ci:Deterministic Kernel x100    |                                                                 |
| real Provider #1 suite green            | PASS   | suite:test:live:model           | DeepSeek, unchanged from alpha.4                                |
| architecture lint green                 | PASS   | suite:lint                      | 12 rules, 0 violations                                          |
| lint self-tests green                   | PASS   | suite:lint:selftest             | 112 tests; every new rule has must-fail and must-pass fixtures  |
| the evidence gate covers three matrices | PASS   | suite:evidence                  | alpha.3, alpha.4 and this one                                   |

---

## 11. Explicit non-claims (§69)

Four columns, like every other table here, so the evidence gate reads them the
same way. The evidence column is empty on purpose: these rows exist to say that
**nothing** asserts them.

| Claim                                      | Status         | Evidence | Notes                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| container/kernel zero-day resistance       | NOT APPLICABLE |          | Out of scope; §36 documents the threat model                                                                                                                                                                                                                                     |
| VM-level isolation                         | NOT APPLICABLE |          | Not attempted; §5 lists Firecracker/gVisor/Kata as non-goals                                                                                                                                                                                                                     |
| native-Linux-equivalent isolation on macOS | NOT TESTED     |          | Cannot be established on a VM-backed daemon; the kernel's own platform note says so                                                                                                                                                                                              |
| host-scoped network allowlist enforcement  | NOT TESTED     |          | Would need an egress proxy in the network namespace; reported `best-effort` everywhere. **Closed by alpha.6**, which built exactly that proxy — exact-host matching and port scope, each with a reverse control. Kept at its alpha.5 status because alpha.5 did not establish it |
| production multi-tenant sandbox            | NOT APPLICABLE |          | One user, one workspace, one session                                                                                                                                                                                                                                             |
| Docker daemon compromise resistance        | NOT APPLICABLE |          | The daemon is trusted infrastructure in this design                                                                                                                                                                                                                              |
| billing-grade delegated cost               | NOT TESTED     |          | Still parked from alpha.4 §57; monetary values remain labelled `estimated`                                                                                                                                                                                                       |
| parallel Agents / automatic delegation     | NOT APPLICABLE |          | §71 forbids adding them here                                                                                                                                                                                                                                                     |
| clean direct-OpenAI behavioural validation | NOT TESTED     |          | Parked (§56); the relay's hidden prompt makes attribution unsound                                                                                                                                                                                                                |
