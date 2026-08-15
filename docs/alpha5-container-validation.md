# `v0.1.0-alpha.5` — Container enforcement validation

What was executed, on what, and what the observed blocking mechanism was. The
distinction this document exists to make is the one alpha.5 was written for:

> **expected mechanism** — what should stop the attempt
> **observed mechanism** — what actually did
> **sink result** — what reached the model, the log or the terminal

A row whose observed mechanism is "kernel policy refused it" is an alpha.4-grade
result. A row whose observed mechanism is "the path is not in the mount namespace"
is what this milestone set out to produce.

---

## 1. Environments

| Tier | Platform                                                | Status                                                                                                                                                                                         |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | **Native Linux Docker Engine** (GitHub `ubuntu-latest`) | **Executed and green.** CI job `Container Enforcement (native Linux Docker)`, run [`31819241927`](https://github.com/OIerYangJZ/MyCoder/actions/runs/31819241927), job `94828259242`, 2 m 01 s |
| B    | **macOS Docker Desktop** — the maintainer's machine     | Executed: docker 29.7.2, `linux/arm64`, kernel `6.12.76-linuxkit`, rootless=false                                                                                                              |
| C    | Windows Docker Desktop                                  | **NOT TESTED**. No trustworthy runner; §39 permits compatibility-only status, and no claim is made                                                                                             |

Tier A ran the identical four suites with `KERNEL_CONTAINER_REQUIRED=1`, so a
missing or unusable runtime would have failed the job rather than skipping it
(§65). Every step succeeded, including the two that exist to make the result
mean something:

```
Record the runtime for the evidence artifact  success   (docker version / docker info / uname -a)
Pull the container image                      success   (a setup action, never a tool side effect)
Container isolation, conformance, composition success
Assert no container leaked out of the suite   success   (greps `docker ps -a` for mycoder-*)
```

**One honest gap in this record.** The job's own log — which is where the printed
`docker version`, `docker info` and `uname -a` values live — could not be read
from the machine writing this document: GitHub serves job logs and artifacts from
a blob host that is unreachable from here, and both `gh run view --log` and
`gh run download` fail with an EOF on the transfer. That is the **same limitation
alpha.4's status document recorded** for a different job, so it is a standing
property of this environment rather than a new surprise. What is asserted above
comes from the Actions API — job conclusion and per-step conclusions — which is
sufficient to say the suites ran and passed on a native Linux engine, and
insufficient to quote that engine's version string. The artifact
`container-enforcement-log` is retained on the run for 14 days for anyone who can
reach it.

Tier B's numbers are below. Tier A runs the identical suites — same files, same
assertions — and is the tier the release claim rests on, because it is the only
configuration where the mount and network namespaces are enforced by the host
kernel with no VM and no file-sharing layer in between (§37).

**What tier B does _not_ establish (§38).** Docker Desktop runs the daemon inside
a virtual machine. Passing the attack suite there is useful evidence about the
suite and about the plan; it does not make the host boundary equivalent to a
native Linux one, and the kernel says so itself — `platformNotes` on that machine
reads:

> Docker Desktop runs the daemon in a virtual machine (kernel 6.12.76-linuxkit),
> so the host boundary is mediated by that VM and its file-sharing layer.
> Container execution is validated here; native-Linux-equivalent isolation is not
> claimed.

**Image provenance (§11).** `node:22-bookworm`, resolved to
`sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a`. Chosen
by configuration, never by the model. It carries `sh`, `node`, `python3`, `git`,
`curl`, `find`, `tar` and `base64` — deliberately, because a missing interpreter
would make "the network is unreachable" and "python is not installed"
indistinguishable, and only the first is evidence.

---

## 2. Suite totals — tier B

| Suite                                           | Result                                        |
| ----------------------------------------------- | --------------------------------------------- |
| `tests/unit/container-plan.test.ts`             | 51 pass, 0 fail                               |
| `tests/live/container-live.test.ts`             | 55 pass, 0 fail                               |
| `tests/live/container-composition.test.ts`      | 8 pass, 0 fail                                |
| `tests/integration/backend-conformance.test.ts` | 29 pass, 0 fail (14 local + 14 container + 1) |
| **combined, twice consecutively**               | **143 pass, 0 fail**                          |

---

## 3. The §59 attack matrix

Every case runs a real command in a real container through the real backend.

### 3.1 Filesystem and secrets

| Attempt                                                                 | Expected mechanism           | Observed mechanism                                         | Sink result    |
| ----------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------- | -------------- |
| `cat <host canary path>`                                                | absent from mount namespace  | `No such file or directory`, non-zero exit                 | no canary      |
| `cat ../host-secret.txt` and `ls ..`                                    | `..` of `/workspace` is `/`  | listing is the **image** root (`usr`, `etc`); no host file | no canary      |
| workspace symlink → host canary                                         | dangling link in container   | `No such file`                                             | no canary      |
| workspace symlink → `/etc/passwd`                                       | resolves inside the image    | image's passwd; host username absent                       | no host data   |
| `python3 -c "open(<canary>).read()"`                                    | absent from mount namespace  | `FileNotFoundError` (python3 verified present first)       | no canary      |
| `node -e fs.readFileSync(<canary>)`                                     | absent from mount namespace  | `ENOENT`                                                   | no canary      |
| `find / -name 'host-secret*' -o -name .ssh`                             | nothing to find              | empty                                                      | no canary      |
| `tar cf - . \| base64` (exfiltration by re-encoding)                    | masked bytes are not there   | archive decoded and searched: neither canary present       | no canary      |
| `ls /Users /home /root`, `ls -a $HOME`                                  | host home not mounted        | absent; `$HOME` is the tmpfs                               | no host data   |
| `ls -d ~/.ssh ~/.aws ~/.kube ~/.docker ~/.config/gcloud ~/.gnupg`       | credential dirs not mounted  | `No such file or directory` for every one                  | no credentials |
| `cat .env` (protected, **inside** the workspace)                        | masked with an empty file    | file exists, reads empty, canary absent                    | no canary      |
| `cat packages/app/config/secrets/.env` (protected, **six levels deep**) | masked with an empty file    | masked — **only after D-006**; see the correction below    | no canary      |
| `cat .git/config` then write to it                                      | `.git` mounted read-only     | read succeeds; write fails `Read-only file system`         | —              |
| write to an ungranted workspace path (`src/app.ts`)                     | no writable mount there      | `Read-only file system`                                    | file unchanged |
| write outside the workspace, and to `/etc`                              | not mounted / read-only root | both fail; host file verified unchanged afterwards         | —              |

### 3.2 Sockets and privileges

| Attempt                                         | Expected mechanism     | Observed mechanism                                     |
| ----------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| `ls -l /var/run/docker.sock` and three siblings | never mounted          | `No such file or directory` for all four               |
| find a docker client inside the container       | not in the image       | `no docker client`                                     |
| `id`; `su root -c id`                           | non-root `--user`      | `uid=501`; `su` yields no root                         |
| read `/proc/self/status` capabilities           | `--cap-drop=ALL`       | `CapEff: 0000000000000000`                             |
| setuid escalation with `no-new-privileges`      | flag set on every plan | no `uid=0` obtained                                    |
| count processes; read `/proc/1/comm`            | private PID namespace  | fewer than 30 processes; PID 1 is the workload         |
| write to `/oops` and `/usr/bin/oops`            | `--read-only` rootfs   | `Read-only file system` for both                       |
| write `/tmp`, then look for it in the next run  | tmpfs, per-container   | first write succeeds; second container: `No such file` |

### 3.3 Network, under `network = false` → `--network none`

| Attempt                             | Observed mechanism                                  |
| ----------------------------------- | --------------------------------------------------- |
| `curl https://example.com`          | non-zero exit, resolution failure                   |
| `node fetch()`                      | `BLOCKED EAI_AGAIN`                                 |
| `python3 urllib.urlopen`            | URL/gaierror                                        |
| `getent hosts example.com` (DNS)    | non-zero exit                                       |
| `python3 socket → 1.1.1.1:443`      | blocked — **no DNS involved**, so this is the route |
| `node net.createConnection 1.1.1.1` | `BLOCKED ENETUNREACH`                               |
| `apt-get update`                    | non-zero exit                                       |
| interface and route inspection      | `lo` present, **no `eth0`**, route table empty      |

The last row is what makes the rest meaningful: the failure is not a resolver
problem, it is the absence of any route out. No kernel-side command scanner was
involved in any of these — the capability profile produced `--network none` and
the syscalls had nowhere to go.

### 3.4 Negative controls (§35)

A zero-leak result proves nothing if the mechanism was not live. Each of these
ran in the same suite:

| Control                                   | Result                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| a mounted workspace file **is** readable  | pass                                                                                                                        |
| a granted writable root **is** writable   | pass — and the bytes appear on the host afterwards                                                                          |
| an ungranted path is **not** writable     | pass                                                                                                                        |
| DNS with `network = false`                | fails                                                                                                                       |
| the **same** command with network granted | succeeds (and prints a NOTE instead of asserting when the machine has no internet, rather than silently degrading the pair) |

### 3.5 Environment (§25)

| Attempt                   | Observed                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env \| sort`             | 8 variables, none credential-shaped; `AWS_*`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `DOCKER_HOST`, `KUBECONFIG` all absent                                                |
| `$SSH_AUTH_SOCK`          | empty                                                                                                                                                                |
| an injected `SecretLease` | reaches the workload (asserted by **length**, never value) and does **not** appear anywhere in the docker argv — it travels through the client process's environment |

### 3.6 Lifecycle (§21, §26, §27)

| Attempt                        | Observed                                                         |
| ------------------------------ | ---------------------------------------------------------------- |
| timeout on `sleep 300`         | `timedOut: true`, returned in **3.1 s** (bound asserted at 30 s) |
| cancel via `AbortSignal`       | returned in **2.6 s** (bound asserted at 40 s), container gone   |
| every container from the suite | none still exists at the end                                     |
| 2,000-process fork attempt     | bounded by `--pids-limit 512`; the host was unaffected           |
| two consecutive executions     | different container names, fresh tmpfs each time                 |

D-001 in `docs/alpha5-dogfood.md` is why the first two rows assert a _latency
bound_ rather than a flag: before the fix, cancellation set `timedOut` correctly
and returned after 120 seconds.

---

## 4. Plan-level refusals (§50)

Checked with no daemon involved, by `tests/unit/container-plan.test.ts` — these
are the cases where the _validator_ is the mechanism:

Docker socket mount · host root mount · `~/.ssh` mount · a mount escaping
`/workspace` · a read-write `.git` · a read-write workspace base · any hardening
flag turned off · an untrusted image · a cwd outside the workspace · an ungranted
environment passthrough · a protected host path as a mount source.

And the mount planner itself (§60): read-only profile · workspace-dev · generated
paths · a single writable file · a nested writable root · a protected child path ·
a symlinked host root · an outside-workspace root · duplicates · ro/rw conflicts ·
write granted on the workspace root · write granted on `.git` · a non-existent
path.

Three of those deserve naming because they are refusals rather than
accommodations:

- a write granted on the **workspace root** does not widen the base mount; the
  plan records it as `unrepresented` and the base stays read-only;
- a write granted on **`.git`** is refused outright;
- a write root that **does not exist** is refused, because `-v` would have made
  Docker create it on the host — a side effect from planning alone.

---

## 5. Composition (§43–§47, §29)

| Claim                                                            | Evidence                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a read-only subagent's shell write fails at the filesystem layer | `tests/live/container-composition.test.ts` — the child's write leaves the file byte-identical, and the read-only profile's own container reports `Read-only file system` |
| a skill's narrowing becomes a real execution constraint          | same file — the wide profile writes, then `/skills use review-only` and the narrowed profile cannot                                                                      |
| project hooks run inside the container                           | same file — a `SessionStart` hook lists `/` and sees the **image** root, not the host's                                                                                  |
| a hook cannot reach a host credential path                       | same file — `~/.ssh/id_rsa`, `~/.aws`: `No such file or directory`                                                                                                       |
| shell mutation auditing still works                              | same file — `shell.executed` records `snapshotStrategy: "git"`, `changed: 1`, `undeclared: 0` with `.git` mounted read-only                                              |
| the log records semantic facts, not container ids                | same file — `container-enforced` present, no `mycoder-<id>` anywhere                                                                                                     |
| a resumed session builds a new container environment             | same file — restart, resume, continue; the second half executes in a new container                                                                                       |

---

## 6. Cross-backend conformance (§48)

The same 14 semantic cases — Read, Read-refusal, Grep, Glob, Edit-after-Read,
stale-Edit refusal, Shell success, Shell non-zero, stdout/stderr separation,
timeout, default cwd, shell mutation, redaction, GitDiff — run through the whole
kernel on **local** and on **container**, and pass identically. Plus one case
asserting the container run really was a container run, and that
`workspaceRoot === projectRoot` still holds (ADR-0012 is not disturbed by the
container's internal `/workspace` path).

SSH is covered by its own live matrix (`pnpm test:ssh`), unchanged by this
milestone and re-run as a regression.

---

## 6b. Correction, recorded after the tag (D-006)

Row 11 of §3.1 above — "a protected file inside the workspace is masked" — was
true when written and **narrower than it read**. The scan that finds those files
stopped at depth 3, so a protected file deeper than that was present inside the
container and readable by any command; the fixtures all happened to put `.env` at
the workspace root, which is where the bound worked.

Found while preparing the second dogfood, after `v0.1.0-alpha.5` was tagged. The
tag is immutable and stays where it is. The fix, the three regressions and the
full account are in `docs/alpha5-dogfood.md` §3b, and the corrected behaviour is
now asserted end to end — including recovery through `tar | base64`, which is the
route output redaction cannot cover.

What this means for the release as tagged: the claim "protected host resources
are absent" held for everything **outside** the workspace, which is where the
credential directories, the host home and the sockets are. The gap was confined
to protected files **inside** the workspace nested more than three levels deep.

---

## 7. What this validation does not claim

- resistance to Docker or kernel zero-days, a compromised daemon, or a
  privileged-container escape;
- VM-level isolation;
- native-Linux-equivalent isolation on macOS or Windows;
- enforcement of a **host allowlist** when network is granted — `--network none`
  is enforced, `hosts = [...]` is not, and both `/status` and the approval prompt
  say so;
- that the trusted file broker is containerised. It is not, deliberately (§28,
  §30), and it is reported as `policy-enforced`.
