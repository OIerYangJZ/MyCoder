# `v0.1.0-alpha.3` — SSH Backend Validation

**Artifact required by alpha.3 §22.** Generated from a run of
`pnpm test:ssh` (`tests/live/ssh-live.test.ts`).

## What was validated, and against what

**Two targets. Both real OpenSSH; one is a real remote machine.**

|                                     | Target A — real remote VM                       | Target B — loopback                      |
| ----------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| Host                                | **separate aarch64 Linux VM over the network**  | `127.0.0.1`, sshd started by the fixture |
| Remote OS                           | Ubuntu, `Linux 7.0.0-29-generic aarch64`        | Darwin 25.5.0                            |
| `sshd`                              | OpenSSH_10.2p1 Ubuntu-2ubuntu3.5, OpenSSL 3.5.5 | OpenSSH_10.2p1, LibreSSL 3.3.6           |
| `ssh` client                        | OpenSSH_10.2p1, LibreSSL 3.3.6 (macOS)          | same                                     |
| Separate machine / uid / filesystem | **yes**                                         | no                                       |
| Network hop                         | **yes**                                         | no                                       |
| Workspace                           | `/home/<user>/workspaces/kernel-ssh-fixture`    | temp directory                           |
| Result                              | **49 pass, 0 fail, 1 skipped**                  | **50 pass, 0 fail**                      |
| Wall time                           | 43.5 s                                          | 161.8 s                                  |

Backend in both cases: `SshExecutionBackend`, `sandboxStrength: policy-enforced`.

The one skip on Target A is `a host-key mismatch is a distinct, non-retryable
error`, which is loopback-only by design — reproducing it needs the fixture to
control the host key, and tampering with a real host's key is not something a
test suite should do to someone's machine. It is covered on Target B.

### Why both, and what each one is for

Target A answers the question §11.1 actually asks: _does the backend contract
survive real OpenSSH, across a network, against a different machine?_ It is the
authoritative run.

Target B exists because it needs no infrastructure. It runs on any developer
machine and in ordinary CI, so an SSH regression is caught the day it lands
rather than the next time someone has a VM to hand. Two of the three kernel
defects below were found on Target B before a VM was available.

### What Target A adds that loopback could not

- a genuine network hop, so `ConnectTimeout`, `ControlPersist` and the
  cancellation path are exercised against real latency;
- a **different OS and CPU architecture** (Ubuntu/aarch64 remote, macOS client),
  which is what makes the `stat` GNU-vs-BSD fallback and the shell snippets
  meaningful rather than assumed;
- a separate uid and filesystem, so "the remote environment is built from
  nothing" is a claim about a real account rather than about the same one.

The **timeout fix is confirmed on real latency**: a command with a 2000 ms
timeout settled in **2105 ms**. Before the `ControlMaster` fix below, the same
shape took 20017 ms.

### What Target A still does not prove

- **Cross-host OS isolation.** The remote is a different machine, but the
  workspace jail is still a path check — see "Known uncertainty" below. A remote
  shell can read outside it.
- **Hostile-network behaviour.** No packet loss, no MITM, no flaky link. The
  host-key mismatch case that would exercise the MITM shape is the one skipped
  here.

### Running it against a real host

This is the runbook that produced Target A. The suite is unchanged between
targets — only the environment differs:

```bash
# 1. In ~/.ssh/config, as a non-root user on a disposable machine:
#
#   Host alpha3-test
#     HostName <ip>
#     User agent-test
#     IdentityFile ~/.ssh/id_ed25519_agent_test
#     IdentitiesOnly yes
#
# 2. Trust the host key once, so StrictHostKeyChecking=yes can succeed:
ssh-keyscan -H <ip> >> ~/.ssh/known_hosts

# 3. Create the remote workspace:
ssh alpha3-test 'mkdir -p /home/agent-test/workspaces/kernel-ssh-fixture'

# 4. Run the matrix:
KERNEL_SSH_REMOTE=alpha3-test \
KERNEL_SSH_WORKSPACE=/home/agent-test/workspaces/kernel-ssh-fixture \
  pnpm test:ssh
```

### What the suite does to the remote machine

Read this before pointing it at a host you care about.

**It creates:** the workspace directory (if absent), files inside it, a git
repository inside it, a canary at `$HOME/.agent-test-secret`, and one file
beside the workspace (`kernel-alpha3-plain.txt`, for the §16 enforcement-level
case).

**It deletes, on teardown:** the _contents_ of the workspace — including
dotfiles, so the `.git` it created goes too — plus the canary and the tracked
file beside the workspace. The workspace directory itself is kept, in case you
created it with particular ownership. Nothing else on the machine is touched.

**`KERNEL_SSH_WORKSPACE` is checked before anything is created**, because that
deletion is driven by an environment variable. `checkRemoteWorkspace` refuses:

| Refused                                                                          | Why                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/`, or an empty/unexpanded variable                                             | the original `startsWith('/')` check accepted `/`, which would have meant `rm -rf /*` |
| fewer than three path segments                                                   | `/home/agent` is a whole account; `/srv` is a mount point                             |
| anything under `/etc /usr /var /root /bin /sbin /lib /boot /dev /proc /sys /run` | system locations                                                                      |
| the home directory itself                                                        | the canary lives there, and its neighbours are your dotfiles                          |
| any path containing `..`                                                         | traversal would let the effective target escape every check above                     |

`tests/live/ssh-workspace-guard.test.ts` asserts each of those rejections and a
matching acceptance, offline, on every commit — so the guard cannot be quietly
loosened, and equally cannot be "hardened" into one that refuses everything and
disables the suite instead.

`$HOME` is asked of the remote rather than derived from the workspace path. The
earlier version guessed it from the first two segments, which is right for
`/home/user/...` and wrong for `/opt/...` — and being wrong meant writing the
canary into a system directory.

**Teardown was verified on the real host after the Target A run**, because these
are claims about someone else's machine and the code making them had never
executed before. Checked directly over `ssh`, not inferred:

| Claim                                         | Observed                                    |
| --------------------------------------------- | ------------------------------------------- |
| workspace contents removed, dotfiles included | 0 entries remaining                         |
| the `.git` the git test created is gone       | absent — this was the actual bug            |
| canary at `$HOME/.agent-test-secret` removed  | absent                                      |
| the tracked file beside the workspace removed | absent                                      |
| the workspace directory itself kept           | present                                     |
| nothing else touched                          | a neighbouring directory was left untouched |

The machine should still be disposable — §12.

The kernel never reads a private key (§13). Authentication is OpenSSH's job,
resolved from the alias; `~/.ssh/id_*` is in the protected-path set and is
unreachable from a session.

---

## Defects this validation found

Four defects, three in the kernel and one in this fixture. All were invisible to
the previous fixture-based tests, and two of the kernel ones meant the backend
did not work against real OpenSSH at all. This is the return on §11.1.

### 1. `-o SendEnv=` is a syntax error — no SSH connection could ever succeed

```
command-line line 0: no argument after keyword "sendenv"
```

The backend emitted `-o SendEnv=` to express "send no environment variables".
OpenSSH rejects that: `SendEnv` requires at least one pattern, and an empty
argument aborts the connection before it is attempted. Every remote connection
failed, and the failure surfaced as `REMOTE_UNAVAILABLE` — i.e. reported as
though the _host_ were at fault.

Fixed by using the documented negation syntax, `-o SendEnv=-*`, which clears any
list a system-wide or user `ssh_config` may have set. The property the original
line was reaching for is preserved and now actually holds; `test:the security
options are on the command line, not left to ssh_config` asserts the emitted
form, and `test:NEGATIVE CONTROL: the host process really does carry these
variables` asserts the effect, by setting the host variables on purpose first.

### 2. `ControlPath` exceeded the unix-socket limit on macOS

```
ControlPath too long ('/var/folders/tg/.../agent-ssh-XXXX/cm-<40 hex>' >= 104 bytes)
```

A `ControlPath` is a unix domain socket path, bounded by `sun_path` — 104 bytes
on macOS, 108 on Linux. The backend built it from `os.tmpdir()`, which on macOS
is a ~50-character `/var/folders/…` path, plus `%C`, which _expands_ to a 40-hex
digest rather than the two characters it resembles. The result was over the
limit, so connection multiplexing — on by default — failed every connection.

Fixed by building the socket under `/tmp` where it exists, using a two-character
filename (the containing directory is already unique per transport via
`mkdtemp`, which is what `%C` would otherwise be for), and **dropping
multiplexing rather than the connection** if it still does not fit. Losing
connection reuse costs a handshake per command; losing the connection costs the
session.

### 3. Timeout and cancellation did not take effect under `ControlMaster`

Measured, before the fix:

| `controlMaster`      | requested timeout | actual       |
| -------------------- | ----------------- | ------------ |
| `true` (the default) | 1500 ms           | **20017 ms** |
| `false`              | 1500 ms           | 1503 ms      |

`ProcessResult.timedOut` was set correctly the whole time — nothing was
listening yet. The transport settled on the child's `close` event, which fires
only once every stdio stream has ended, and the persisted `ControlMaster` holds
duplicates of those descriptors for its whole `ControlPersist` window. Killing
the client therefore did not settle the promise; the remote command running to
completion did.

Since multiplexing is the default, this applied to essentially every remote
command: **§18 cancellation and §19 timeouts were both ineffective in the
default configuration.**

Fixed by treating `exit` as the authoritative signal — the client is gone and
will write nothing further — with a 100 ms grace period for buffered output, and
`close` as an optimisation that usually arrives first. After the fix,
`controlMaster: true` settles in 1605 ms.

### 4. The fixture's own VPS path had an unguarded `rm -rf /*`

In the fixture rather than the kernel, but worth recording here because it is the
same failure mode and it was aimed at a _user's machine_.

Teardown deletes the workspace contents, and the target comes from
`KERNEL_SSH_WORKSPACE`. The only validation was `startsWith('/')` — which `/`
satisfies. An unset or mistyped variable would have run `rm -rf /*` on the remote
host. The same never-executed function also guessed `$HOME` from the first two
path segments (wrong for `/opt/...`, which meant writing the canary into a system
directory), used a glob that missed dotfiles so `.git` survived every teardown,
and left one file beside the workspace uncollected.

Fixed with `checkRemoteWorkspace()` — refusing `/`, paths under three segments,
system prefixes, the home directory and any `..` — plus asking the remote for
`$HOME`, a teardown that sees dotfiles, and a `trackForCleanup()` registry.
`tests/live/ssh-workspace-guard.test.ts` covers it offline, 25 cases, each
rejection paired with an acceptance.

**Since executed, and correct.** When this was written the function had never
run, and the note here predicted the first real-host attempt would surface
something. It did not: Target A exercised the `$HOME` probe, the teardown command
and the litter registry, and all three behaved as intended — verified item by
item in the table above. The prediction was wrong, which is the better outcome,
but it was worth making: the guard and the three fixes were written _before_
anything was pointed at a real machine, which is the only order in which a
`rm -rf /*` gets caught by reading rather than by running.

---

## Matrix

Statuses are the four from §34. `PASS` means a named test in
`tests/live/ssh-live.test.ts` asserts it, **on Target A (the real remote VM)**
unless noted; the full mapping is in `docs/alpha3-evidence-matrix.md` §2.

### Connection (§14)

| Case                                                         | Status |
| ------------------------------------------------------------ | ------ |
| connect by configured alias                                  | PASS   |
| `StrictHostKeyChecking=yes` genuinely in force               | PASS   |
| unknown host key fails safely                                | PASS   |
| host-key mismatch fails safely, non-retryably                | PASS   |
| authentication/connection failure becomes a structured error | PASS   |
| connection timeout is bounded                                | PASS   |

### File system (§14)

| Case                                           | Status     |
| ---------------------------------------------- | ---------- |
| Read remote file                               | PASS       |
| binary content preserved (base64 channel)      | PASS       |
| line endings preserved                         | PASS       |
| Glob / directory listing, dotfiles included    | PASS       |
| Grep remote workspace                          | PASS       |
| Edit remote file                               | PASS       |
| atomic-write semantics preserved               | PASS       |
| failed write leaves no temp file               | PASS       |
| remote external mutation invalidates freshness | PASS       |
| partial Read creates a valid SourceReceipt     | NOT TESTED |

`partial Read` is a tool-layer concern rather than a backend one; it is covered
locally by the Read tool's own tests and was not re-exercised over SSH.

### Process (§14)

| Case                                      | Status                    |
| ----------------------------------------- | ------------------------- |
| Shell command                             | PASS                      |
| test/lint/build command (`git`)           | PASS                      |
| non-zero exit preserved                   | PASS                      |
| stdout/stderr kept separate               | PASS                      |
| argument quoting is not injectable        | PASS                      |
| stdout/stderr truncation preserved        | PASS                      |
| stdout/stderr redaction preserved         | PASS                      |
| idle timeout preserved                    | PASS                      |
| cancellation reaches the local client     | PASS                      |
| cancellation reaches the _remote_ process | **UNCERTAIN — see below** |

### Git (§14)

| Case                | Status |
| ------------------- | ------ |
| GitDiff works       | PASS   |
| git status/log work | PASS   |
| no implicit commit  | PASS   |
| no implicit push    | PASS   |

### Workspace jail (§15)

| Case                                                                 | Status                               |
| -------------------------------------------------------------------- | ------------------------------------ |
| `../` traversal denied                                               | PASS                                 |
| deep traversal denied                                                | PASS                                 |
| traversal through a real subdirectory denied                         | PASS                                 |
| absolute path outside the remote root denied                         | PASS                                 |
| remote working directory outside the jail denied                     | PASS                                 |
| symlink from workspace to an outside file                            | **policy-enforced only — see below** |
| `enforcement level` reported as `policy-enforced`, not `os-isolated` | PASS                                 |

### Secret boundary (§16)

Canary `REMOTE_CANARY_SECRET_93af…` at `~/.agent-test-secret`, outside the
workspace. Attacked through `cat`, `grep -r`, `base64`, `tar`, `rev`, plus
attempts on `/etc/shadow` and `~/.ssh`.

| Sink                                | Occurrences |
| ----------------------------------- | ----------- |
| every recorded remote stdout/stderr | **0**       |

Blocking layer per attack: `redacted`. Negative controls assert (a) the canary
file really exists and is readable by a remote shell, and (b) the redactor is
selective — an ordinary value of similar shape passes through untouched.

### Environment forwarding (§17)

| Case                                                                                                                            | Status                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `AWS_*`, `SSH_AUTH_SOCK` absent remotely | PASS                    |
| host variables were genuinely set before the assertion                                                                          | PASS (negative control) |
| remote environment is constructed, not inherited                                                                                | PASS                    |
| no ssh agent reachable from the remote                                                                                          | PASS                    |
| `ForwardAgent=no`, `SendEnv` cleared, on the command line                                                                       | PASS                    |

### Resume and hooks (§20, §21)

| Case                                    | Status     |
| --------------------------------------- | ---------- |
| remote interrupted-session resume       | NOT TESTED |
| real remote Hook execution              | NOT TESTED |
| replay validity after remote operations | NOT TESTED |

These need a full kernel session driven over SSH rather than the backend in
isolation. The backend-level pieces they depend on — workspace identity,
freshness re-derivation, event-log replay — are covered locally by
`pnpm test:replay`. Wiring a kernel session onto the SSH backend end-to-end is
the natural next step and is deliberately not claimed here.

---

## Known uncertainty and limitations

**Remote process termination after cancellation is not guaranteed.** §18 says to
surface this rather than claim success, so the suite _measures_ it: it starts a
remote command that writes a marker file after a delay, cancels locally, waits
past the delay, and records whether the marker appeared. What the kernel
guarantees is the local half — the turn ends, the tool exchange closes, the
executor is disposed. Whether the orphaned remote process dies depends on the
remote shell noticing the closed channel, which is OpenSSH and remote-OS
behaviour rather than something the backend controls.

**The workspace jail is a path check, not a boundary.** `SshFileSystem.jail()`
confines Read/Edit/Glob to the remote workspace, and `SshProcess.exec` confines
the working directory. Neither constrains which absolute paths a _shell command_
may name: `cat /etc/hostname` runs. A symlink from inside the workspace to a
file outside it resolves and is read. What keeps a secret out of the model is
the Redactor, and the Redactor only strips values it has been told about or can
recognise heuristically. `test:the enforcement level for an UNREGISTERED
out-of-workspace file is recorded, not overstated` asserts this explicitly, so
that if the backend ever gains real containment the test fails and this document
gets upgraded rather than quietly remaining pessimistic.

This is exactly what `sandboxStrength: 'policy-enforced'` claims and exactly
what `os-isolated` would not. §15 forbids the latter claim, and it is not made.

**No credentials appear in this document,** and none were read by the kernel:
`~/.ssh/**` is in the protected-path set, and authentication is performed by
OpenSSH from the alias.
