# alpha.7 evidence matrix — native Linux sandbox & operational closure

**Date:** 2026-08-15
**Milestone:** `v0.1.0-alpha.7` — native Linux sandbox, plus three closures
**Evidence host:** Ubuntu 26.04 aarch64 · kernel 7.0.0-29-generic · **Landlock ABI 8** ·
`kernel.yama.ptrace_scope = 1`
**Rule:** no PASS without named, executable evidence. Every security row also
names its **reverse control**, because a failure for the wrong reason is not
evidence (alpha.6 §59, carried forward).

`live` = requires Linux with Landlock (`KERNEL_NATIVE=1`).
`offline` = runs in the default `pnpm test`.

## Model provenance

**This matrix makes no live-model behavioural claims.** Every row is an
enforcement or conformance property measured directly against the kernel and the
host: Landlock ABI, seccomp errno attribution, descriptor hygiene, cross-backend
conformance, and the diagnosis classifier's 19 unit cases. None of them involves a
model deciding anything, so none of them is single-model.

The two numbers that could be mistaken for behavioural are not:

- **20/20 native sandbox, 3/3 composition** — scripted trajectories driving the
  backend, not a model choosing actions;
- **+0.3 ms per exec** — a measurement of the launcher, over 20 runs.

Host tier for every live row: **Ubuntu 26.04 aarch64, kernel 7.0.0-29-generic,
Landlock ABI 8**, reachable as `linux-vm`. Not macOS, and the difference is not
cosmetic — Landlock does not exist there.

The live-model dogfood on this backend remains an explicit non-claim; see
`docs/alpha7-status.md` and alpha.8 §24.

## 1. The sandbox itself

| Requirement                                               | Status | Evidence                                                                    | Notes                                         |
| --------------------------------------------------------- | ------ | --------------------------------------------------------------------------- | --------------------------------------------- |
| Features are measured, not inferred                       | PASS   | test:reports a measured ABI rather than inferring one                       | ABI read from the kernel at startup           |
| The descriptor claims only what the ABI carries           | PASS   | test:the enforcement descriptor claims only what the ABI carries (§13, §30) | `networkAllowlist: none`, TCP-only note       |
| POSITIVE CONTROL: a granted path works                    | PASS   | test:POSITIVE CONTROL: a granted path is readable and writable              | without it every denial below is vacuous      |
| A path outside every granted root is denied by the kernel | PASS   | test:a path outside every granted root is denied by the kernel              | `Permission denied`, not a policy message     |
| Writing outside the granted roots is denied               | PASS   | test:writing outside the granted roots is denied                            |                                               |
| A read-only workspace cannot be written                   | PASS   | test:a read-only workspace cannot be written (§50)                          |                                               |
| The runtime base grants no broad root, home or `/etc`     | PASS   | test:the runtime base grants no broad root, home or /etc (§18)              | §18 policy asserted, not assumed              |
| A protected file inside a granted root refuses the plan   | PASS   | test:a protected file inside a granted root refuses the plan                | Landlock cannot carve a leaf out of a subtree |
| A truncated protected-path scan refuses the plan          | PASS   | test:a truncated protected-path scan refuses the plan                       | §17: complete or fail closed                  |

## 2. Descriptor hygiene — the release blocker (§20, §21)

| Requirement                         | Status | Evidence                                                                         | Notes                                      |
| ----------------------------------- | ------ | -------------------------------------------------------------------------------- | ------------------------------------------ |
| REVERSE CONTROL: the bypass is real | PASS   | test:NEGATIVE CONTROL: without hygiene, a pre-opened fd bypasses every path rule | a **separate build**, never a runtime flag |
| The production launcher closes it   | PASS   | test:the production launcher closes it, and the same read fails                  | `Bad file descriptor`                      |

## 3. Process inspection (§22, §23)

| Requirement                                                | Status | Evidence                                                                           | Notes                                                  |
| ---------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Another process's environ is unreachable, with its control | PASS   | test:another process environ is unreachable, and the control shows it would not be | the control reads it successfully outside the sandbox  |
| procfs is absent entirely, not present for one process     | PASS   | test:procfs is absent entirely, rather than present for one process (§18)          | a per-pid rule would be asymmetric — ADR-0018 §5       |
| ptrace / `process_vm_readv` denied **by our filter**       | PASS   | test:ptrace and process_vm_readv are denied by our filter, not by the host sysctl  | EACCES (seccomp) vs EPERM (Yama) — mechanism assertion |

## 4. Privilege and network (§24, §27, §28)

| Requirement                                   | Status | Evidence                                                         | Notes                                        |
| --------------------------------------------- | ------ | ---------------------------------------------------------------- | -------------------------------------------- |
| `no_new_privs` is set, with the control       | PASS   | test:no_new_privs is set, so a setuid exec cannot gain privilege | the same binary outside reports 0            |
| A setuid binary confers nothing               | PASS   | test:a setuid binary confers nothing under the sandbox           |                                              |
| TCP is denied when the profile denies network | PASS   | test:TCP is denied when the profile denies network               | Landlock net rules, ABI 4+                   |
| A host-scoped allowlist is refused, not faked | PASS   | test:a host-scoped allowlist is refused, not silently unenforced | §27; the alpha.5 mistake not repeated        |
| UDP is **not** claimed                        | PASS   | test:reports a measured ABI rather than inferring one            | `networkUdp: false` is asserted, not implied |

## 5. Secrets (§38)

| Requirement                                       | Status | Evidence                                                                | Notes                                              |
| ------------------------------------------------- | ------ | ----------------------------------------------------------------------- | -------------------------------------------------- |
| An unregistered secret is unreachable by **path** | PASS   | test:a secret the kernel has never been told about is still unreachable | nothing downstream would have masked it; + control |

## 6. Composition and conformance (§31, §33–§36)

| Requirement                                                 | Status | Evidence                                                                         | Notes                                       |
| ----------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- | ------------------------------------------- |
| Cancellation kills the process tree                         | PASS   | test:a timeout kills the whole process tree, not just the leader                 | the child ignores SIGTERM                   |
| The same conformance cases pass on `linux-native`           | PASS   | suite:backend conformance: linux-native                                          | 35/35 with local; caught the §51 divergence |
| The backend is genuinely native and claims what it enforces | PASS   | test:the backend is genuinely the native one, and claims only what it enforces   | `os-isolated`, `networkAllowlist: none`     |
| A read-only subagent is stopped by the kernel               | PASS   | test:a read-only child's write fails at the kernel, not only at the policy layer | the bytes on disk are the assertion         |
| A read-only skill narrows the plan, not just the catalogue  | PASS   | test:a read-only skill narrows the sandbox plan, not just the catalogue          | with the writable control                   |
| A hook cannot become a host escape                          | PASS   | test:a project hook cannot read a host credential the sandbox does not grant     |                                             |

## 7. Closure B — supported `allow_benchmark_range` (§42–§45)

| Requirement                                        | Status | Evidence                                                                          | Notes                                           |
| -------------------------------------------------- | ------ | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| Off by default, and the message says how to opt in | PASS   | test:benchmarking space is refused by default, and the message says how to opt in |                                                 |
| It permits that range and nothing else             | PASS   | test:the opt-in permits it, and only it                                           | loopback stays refused with the flag on         |
| A project config cannot enable it                  | PASS   | test:a project config cannot turn it on (§43)                                     | `strictBoolean`; the user layer can             |
| Enabling it is disclosed at startup                | PASS   | test:a session with the opt-in on says so at startup                              | §44; NEGATIVE CONTROL asserts silence otherwise |

## 8. Closure C — execution diagnosis (§46–§54)

| Requirement                                    | Status | Evidence                                                                                      | Notes                                      |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| The regression matrix (11 categories)          | PASS   | suite:§54 regression matrix: structured errors are authoritative                              | category, blame, retryability, hint        |
| A missing executable is one semantic answer    | PASS   | test:from the local backend wording, test:from a shell exit code, with no error object at all | §51                                        |
| The first blocker is named, not the last error | PASS   | test:a read-only workspace with a working network reads as a write problem                    | §50, the plan's own scenario               |
| Stderr-derived answers are never authoritative | PASS   | test:stderr-derived diagnoses are capped at medium confidence                                 | §49                                        |
| An unexplained failure stays `unknown`         | PASS   | test:the same stderr with network granted is NOT diagnosed as a denial                        | the control against confident misdiagnosis |
| Diagnosis never authorises                     | PASS   | test:no diagnosis carries anything that could act                                             | §53, asserted structurally                 |

## 9. Performance (§55)

| Requirement                         | Status | Evidence                                                     | Notes                                                                         |
| ----------------------------------- | ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Native sandbox overhead is measured | PASS   | manual:20 execs per backend on the evidence host, 2026-08-15 | median 0.5 ms local → 0.8 ms native; **+0.3 ms per exec**                     |
| Contrast with the container backend | PASS   | suite:backend conformance: linux-native                      | the same cases take ~10–30 ms locally/natively and ~400–800 ms in a container |

## 10. Not claimed

| Requirement                                               | Status         | Evidence | Notes                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Strict public-address egress on a clean resolver (§39–41) | NOT APPLICABLE |          | both hosts sit behind a transparent fake-IP resolver; see `docs/alpha7-status.md` for the measurement. **Downgraded from `NOT TESTED` by alpha.10 §15** — after three restatements the promise of a fourth attempt was false. Reason in ADR-0017 |
| A live-model dogfood on the native backend (§57)          | NOT TESTED     |          | needs the provider credential on the Linux host, which is the user's decision to make rather than the agent's                                                                                                                                    |
| PID / network namespaces, ABI 6 scopes                    | NOT APPLICABLE |          | explicitly deferred in ADR-0018; the probe already reports the ABI that would carry them                                                                                                                                                         |
| UDP or raw-socket denial                                  | NOT APPLICABLE |          | Landlock has no such rules; the descriptor says so rather than rounding up                                                                                                                                                                       |
