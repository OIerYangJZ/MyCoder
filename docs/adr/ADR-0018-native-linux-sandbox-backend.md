# ADR-0018 — Native Linux sandbox backend

**Status:** accepted · **Date:** 2026-08-15
**Note on numbering:** the alpha.7 plan §7 calls for "ADR-0016". That number and
0017 were taken by the tool-surface round earlier the same day, so this is 0018.

## Context

alpha.5 and alpha.6 established that a container can enforce the kernel's policy:
filesystem isolation, deny-all network, and host-scoped HTTP/HTTPS egress through
a proxy. All of it depends on the Docker daemon. The next unvalidated assumption
was not whether Docker can enforce the policy, but:

> Can the kernel apply Linux security primitives to an untrusted subprocess
> directly, without a container runtime in between?

The measurements below are from the evidence host: Ubuntu 26.04 aarch64, kernel
7.0.0-29-generic, Landlock **ABI 8**, `kernel.yama.ptrace_scope = 1`.

## Decision

### 1. Identity and no downgrade

`kind = 'linux-native'`, selected with `--backend linux-native`. `local` keeps
meaning what it means — policy-enforced, no OS isolation — because overloading it
would make an honest label ambiguous.

Selecting it either applies the sandbox or fails. No fallback to `local`, none to
Docker. `SANDBOX_UNSUPPORTED` carries the reason and a remedy.

### 2. A small in-tree C launcher

`native/mycoder-sandbox.c`, built by `pnpm build:sandbox` into `build/`. The
kernel resolves semantic capability first; the launcher receives an
already-validated plan and is the only component that knows Landlock masks.

It refuses raw masks, namespace flags, seccomp bytecode and privilege flags — the
plan protocol is `ro|rx|rw <absolute path>`, `net deny|unrestricted`, `seccomp 1`,
`nnp 1`. An unknown verb is a hard error, because silently ignoring a restriction
it does not understand would run the workload with less than the plan asked for.

The plan travels on a pipe (fd 3), not in argv: `ps` shows argv to every user on
the machine, and the plan is a list of exactly which paths this agent may touch.

**Build, not auto-build.** Compiling is running a compiler; a kernel that shelled
out to `cc` during a tool call would be doing the unaudited execution it exists to
prevent. The backend refuses to start if the binary is missing or older than its
source. ADR-0009 is intact: the _runtime_ dependency set is still empty; this adds
a build-time C compiler on Linux only.

### 3. Features are measured, never inferred

`--probe` reports the ABI and each capability separately. A distribution kernel can
carry the syscall with Landlock disabled at boot, and `uname` cannot tell you.
ABI 4 is the floor for any network claim; below it a network-denied execution is
refused rather than run unrestricted.

### 4. Filesystem: allowlist, and refuse what it cannot express

Rules derive from the same `readRoots` / `writeRoots` every other backend uses.
Two refusals rather than approximations:

- a **protected file inside a granted root** (Landlock has no "deny under an
  allow") — refused, pointing at the container backend, which masks instead;
- a **truncated protected-path scan** — refused, because a rule set that may have
  missed one is a guarantee that is not.

Rights are masked by inode type in the launcher: `READ_DIR` on a regular file is
`EINVAL`, so `ro /etc/ld.so.cache` would otherwise fail for a reason that has
nothing to do with policy.

### 5. procfs is granted nowhere

The obvious rule, `ro /proc/self`, measures well and is a trap: Landlock resolves
it once, at plan time, to _that pid's_ directory, and a pid does not survive
`fork`. The first process could read its own entry and every child it spawned
could not — an asymmetric guarantee nobody can reason about, and a shell hits it
immediately.

Granting `/proc` whole is worse: `/proc/<pid>/environ` of any same-uid process is
readable, which is the leak §22 exists to close (confirmed by measurement).

So neither. The compatibility sweep found node, python3 (ssl, json, subprocess),
git, grep and shell loops all work with no procfs at all. A PID namespace with its
own procfs mount is the complete answer and is **deferred**, recorded here rather
than half-built.

### 6. Descriptor hygiene is a release blocker, and its control is a build

Landlock restricts path _resolution_; a descriptor opened before the ruleset was
applied keeps working. The launcher closes everything above stderr — including the
plan pipe — via `close_range`, before it opens anything of its own.

The paired control (§21) is a **separately compiled binary**
(`-DMYCODER_NEGATIVE_CONTROL_KEEP_FDS`), never a runtime flag: a switch that
disabled hygiene would be reachable by anything that can shape an argv. Measured:
without hygiene the pre-opened fd reads the canary; with it the read fails with
`Bad file descriptor`.

### 7. Network: deny TCP, and say that is what it is

Landlock has no UDP or raw-socket rules. "No network" here means "no TCP", and the
enforcement descriptor says so in `platformNotes` rather than claiming a complete
boundary. A **host-scoped allowlist is refused** — Landlock rules are ports and
address families, not hostnames — which is the alpha.5 mistake (disclosure
presented as enforcement) not repeated.

### 8. seccomp: a measured deny list, with an attributable errno

Denies the process-inspection family (`ptrace`, `process_vm_readv/writev`) and the
privilege/namespace machinery §25 names. Not an allowlist: that is a compatibility
project and explicitly out of scope.

It returns **EACCES**, where Yama returns EPERM, so a test can assert _which_
mechanism refused. This matters because `kernel.yama.ptrace_scope` is the host's
setting and could be 0 elsewhere; without our own filter the claim would be a
property of the host's configuration rather than of the backend.

### 9. Enforcement claims

| Dimension           | Native Linux                            | Why                                  |
| ------------------- | --------------------------------------- | ------------------------------------ |
| `processFilesystem` | `os-enforced`                           | Landlock; no runtime in between      |
| `processNetwork`    | `os-enforced` when ABI ≥ 4, else `none` | TCP only, stated                     |
| `processPrivileges` | `os-enforced`                           | `no_new_privs` + seccomp             |
| `hostFileBroker`    | `policy-enforced`                       | Read/Edit are kernel-side, unchanged |
| `networkAllowlist`  | `none`                                  | refused rather than approximated     |

First backend in the tree to reach `os-enforced`, and only in the dimensions the
kernel actually covers.

## Consequences

- Strong Linux isolation for deny-all workloads no longer requires the Docker
  daemon. Scoped HTTP/HTTPS egress still does — that is the container backend's,
  and this backend says so instead of pretending.
- The sandbox has no procfs. Tools that require `/proc/self` will fail, visibly
  and consistently, rather than working for one process and not its children.
- `HOME` and `TMPDIR` are a synthetic directory inside the session's scratch
  space; the real home, with its ssh and cloud credentials, is not in any plan.
- Landlock is per-thread-group and additive: the launcher applies rules and execs,
  so nothing runs before the restrictions are in place.
- A PID namespace, a network namespace for complete deny-all, and the abstract
  UNIX socket / signal scopes available at ABI 6+ are all left for a later
  milestone, with the ABI already reported by the probe.
