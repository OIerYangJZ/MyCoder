# `v0.1.0-alpha.3` — SSH Backend Validation

**Artifact required by alpha.3 §22.** Generated from a run of
`pnpm test:ssh` (`tests/live/ssh-live.test.ts`).

## What was validated, and against what

|                      |                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------- |
| Target               | **Loopback OpenSSH `sshd` on `127.0.0.1`**, started and torn down by the test fixture |
| Remote OS            | Darwin 25.5.0                                                                         |
| `sshd`               | OpenSSH_10.2p1, LibreSSL 3.3.6                                                        |
| `ssh` client         | OpenSSH_10.2p1, LibreSSL 3.3.6                                                        |
| Kernel commit        | `816a3da` + the SSH fixes recorded below                                              |
| Backend              | `SshExecutionBackend`, `sandboxStrength: policy-enforced`                             |
| Workspace root class | temp directory, disposable, recreated per run                                         |
| Result               | **50 / 50**                                                                           |

### The caveat, stated plainly

This is a **real OpenSSH server** — real host key, real public-key
authentication, real protocol, real remote `sh`, real `ControlMaster`. It is
**not a VPS**:

- no network hop;
- no second machine;
- no separate user account — the remote process runs as the **same uid** on the
  **same filesystem**.

So everything below is evidence that _the backend contract survives real
OpenSSH behaviour_, which is the question §11.1 asks. It is **not** evidence of
cross-host isolation, of behaviour under real network latency or packet loss, or
of anything that depends on the remote being a different security principal.
Those rows are `NOT TESTED` in `docs/alpha3-evidence-matrix.md`, and
`v0.1.0-alpha.3` must not claim them.

The value of running on loopback is that the whole matrix runs on every
developer machine and in ordinary CI, so an SSH regression is caught the day it
lands rather than the next time someone rents a server.

### Running it against a real VPS

The same suite, unchanged, targets a real host:

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

The fixture creates a canary at `~/.agent-test-secret` on the remote and removes
it, plus the workspace contents, on teardown. It touches nothing else. The
machine should still be disposable — §12.

The kernel never reads a private key (§13). Authentication is OpenSSH's job,
resolved from the alias; `~/.ssh/id_*` is in the protected-path set and is
unreachable from a session.

---

## Defects this validation found

All three were invisible to the fixture-based tests, and two of them meant the
backend did not work against real OpenSSH at all. This is the return on §11.1.

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

---

## Matrix

Statuses are the four from §34. `PASS` means a named test in
`tests/live/ssh-live.test.ts` asserts it; the full mapping is in
`docs/alpha3-evidence-matrix.md` §2.

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
