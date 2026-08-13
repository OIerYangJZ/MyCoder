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

Eight defects: seven in the kernel and one in this fixture. All were invisible to
the previous fixture-based tests. Two meant the backend could not connect to real
OpenSSH at all, two more meant it could not read or write anything once
connected, and two were checks that existed but could never fire. **All are
fixed.** This is the return on §11.1.

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

### 5. `--remote` could not perform any file or process operation — FIXED (ADR-0012)

Found by driving a real model through the CLI onto the VM — the most
consequential defect of the milestone. **Fixed in ADR-0012**, and verified by
DeepSeek writing and running a file on the VM through `Edit` and `Shell`.

The kernel computes one workspace root, from the _local_ working directory, and
gives it to the policy engine, the permission profile, the tool runtime, the
repository plane and the mutation detector. The SSH backend jails against a
_different_ root — the remote `workspace` from `remotes.toml`. Measured:

```text
LOCAL  workspaceRoot         : /Users/yangjinsey/MyCoder/kernel
REMOTE backend workspaceRoot : /home/yangjinsey/Desktop/MyCoder
policy engine root           : /Users/yangjinsey/MyCoder/kernel   <- local
```

Those two path sets are disjoint, so **no path can satisfy both layers**. A
relative `hello.py` resolves against the local root, passes the local policy
check, and is then refused by `SshFileSystem.jail()`. An absolute remote path
fails the other way round.

Observed consequence, with DeepSeek driving:

```text
tool execution failed tool=Edit  code=PATH_OUTSIDE_WORKSPACE
tool execution failed tool=Shell code=PATH_OUTSIDE_WORKSPACE
... 16 model requests ...
LOOP_BUDGET_EXCEEDED: Turn stopped: step limit reached.
```

The model retried sensibly and could not win, because nothing it could have
sent would have worked. The loop budget did its job — the turn stopped rather
than running forever — but the feature is unusable.

**This contradicts spec §19.1**, whose diagram places fs operations, grep,
shell/test and git in the _remote_ workspace, with only the kernel and the model
local. The tool plane's root should therefore be
`backend.environment.workspaceRoot` whenever a remote backend is active.

Why every earlier test missed it: the §14–§21 matrix drives `SshExecutionBackend`
**directly**, with remote paths it constructs itself, so the jail is satisfied
and the policy engine is never consulted. Nothing exercised
CLI → ToolRuntime → policy → SSH. That is precisely the "full kernel session over
SSH" gap this document already listed as `NOT TESTED` under §20/§21 — the gap was
real, and it was hiding a total functional break rather than a rough edge.

**The fix.** Two explicitly separated roots — `projectRoot` (local: config,
hooks, skills, session store) and `workspaceRoot` (the tool plane's, derived as
`backend.environment.workspaceRoot`). Deriving rather than recomputing is the
point: the two layers that independently judge a path now read the same value and
agree by construction. Full rationale and the per-collaborator table in ADR-0012.

`tests/integration/backend-roots.test.ts` asserts the invariant offline, with no
SSH server, because agreement between two in-process objects is not a transport
property.

### 6. Remote paths were canonicalised against the _local_ filesystem — FIXED

Surfaced immediately after fixing §5, and it is the same mistake one layer down.
With the roots corrected, `Edit` still failed:

```text
/System/Volumes/Data/home/yangjinsey/Desktop/MyCoder/probe.txt
  denied by system-ceiling, not appealable
```

The tool runtime resolved every path with local `realpath`. macOS resolves
`/home` through autofs to `/System/Volumes/Data/home`, and `/System/**` is
hard-denied — so _every_ remote file path became a protected system location.

Only `Shell` worked, because it never asks for a canonical path. The first
"successful" Hello World on the VM was written through the shell, and the model
said so in its own reply: _"via the shell, since the Edit tool's path mapping
resolved to a protected system location."_ Worth recording: the model reported the
workaround accurately, and reading its message rather than just checking the file
is what caught this.

Fixed by canonicalising through the backend when it is not local — lexical
resolution locally, then `backend.fs.realpath()` and `backend.fs.stat()` for
symlinks and existence. Symlink resolution still happens, because a remote
`src/x -> ../../.ssh/id_ed25519` must still be caught; it now happens on the
machine that owns the symlink.

Also fixed alongside: `SshExecutionBackend` reported `homeDir` as the _workspace_.
It now probes the remote `$HOME` during connect, so every consumer of `homeDir`
stops being quietly wrong about the remote.

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

### Full kernel session, resume and hooks (§20, §21)

`tests/live/ssh-session.test.ts` drives the **whole kernel** over SSH —
`createKernel` → `Session.runTurn` → `ToolRuntime` → policy → SSH — rather than
the backend in isolation. 18 cases, green on both targets.

| Case                                                         | Status |
| ------------------------------------------------------------ | ------ |
| a full turn: Read → Edit → Shell, verified **on the remote** | PASS   |
| the two roots differ and both are correct                    | PASS   |
| replay reaches the same terminal state as the live run       | PASS   |
| the record names the ssh backend and the active remote       | PASS   |
| remote interrupted-session resume                            | PASS   |
| resume re-injects a freshness caveat                         | PASS   |
| the remote changing while offline is not assumed away        | PASS   |
| the session records a remote host identity                   | PASS   |
| resuming a remote session locally is refused                 | PASS   |
| real remote Hook execution                                   | PASS   |
| the remote hook sees a scrubbed environment                  | PASS   |
| remote hook output is redacted before reaching context       | PASS   |
| remote hook runs are auditable                               | PASS   |

Two of these deserve their method spelled out, because a weaker assertion would
have passed without proving anything.

**Hook locality** is proven by the hook's _side effect landing on the remote
filesystem_, not by its stdout — stdout would not distinguish a hook that ran
locally in a directory of the same name. On the real VM there is a second,
sharper proof: the hook writes `uname -s`, and the marker reads `Linux` while the
client is Darwin.

**"The remote did not hold still"** is tested by editing the remote from outside
while the kernel is shut down, then resuming and re-reading. A cached receipt
would have served the pre-interruption bytes, and an Edit against them would be
building on a file that no longer exists in that form. The assertion is that the
re-read sees the _new_ content.

---

### 7. `remoteIdentity` was read but never written — FIXED

`SessionMetadata.remoteIdentity` existed and `checkResumeIdentity` compared it,
producing "The remote host identity changed since this session was created."
Nothing ever set it, so the branch was unreachable and §20's "verify remote
identity" was not implemented — the same shape as the five dead lint rules.

`SshExecutionBackend` now probes a stable identifier at connect (hostname,
`uname -sm`, and the machine-id where one exists, hashed) and reports it as
`EnvironmentDescriptor.hostIdentity`. The kernel persists it into session
metadata and passes it to the resume check.

What it detects: the alias now points at a _different machine_ —
re-provisioned, DNS moved, container replaced. What it does **not** do:
authenticate the host. `StrictHostKeyChecking` does that, before this value is
ever read.

### 8. A non-canonical remote workspace refused every path — FIXED

Surfaced by the loopback fixture, and it would hit any user whose configured
`workspace` goes through a symlink — `/var/...` is `/private/var/...` on macOS,
and `/home` is frequently a link on Linux.

The jail compared against the path as written in `remotes.toml`, while the tool
layer canonicalised through the remote (correctly, after defect 6). Two spellings
of the same directory, so every path was refused as outside the workspace.

`connect` now resolves the workspace on the remote with `pwd -P` and jails
against that, so a symlinked `workspace` works instead of failing totally.

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
