# `v0.1.0-alpha.3` — Operational Readiness status

**Baseline:** `v0.1.0-alpha.2` (`4a9f86e`) · **Provider #1 (live-validated):**
DeepSeek over `openai-chat` · **SSH validated against:** a real OpenSSH server
on loopback, **not a VPS**

Status vocabulary is the four values from §34. **PASS** means a named,
executable piece of evidence asserts it. **NOT TESTED** means it is not asserted
here, and the notes say why. **NOT APPLICABLE** means out of scope for this
milestone. Every claim below maps to a row in
`docs/alpha3-evidence-matrix.md`, which `node scripts/evidence.ts` checks
mechanically.

> **The headline is not the pass rate.** It is that turning three checklist
> areas into executable gates found **four defects that all previous testing had
> missed** — two of which meant a shipped subsystem could not work at all. That
> is the return alpha.3 was designed to produce, and it is described in §2 below
> rather than buried.

---

## 1. What was actually executed

| Gate                                     | Result                                                              |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `pnpm typecheck`                         | clean                                                               |
| `pnpm lint`                              | 9 rules, 0 violations                                               |
| `pnpm lint:selftest`                     | 87/87 (70 linter fixtures + 17 evidence-gate)                       |
| `pnpm format:check`                      | clean                                                               |
| `pnpm test`                              | **509 tests, 459 pass, 0 fail, 50 skipped**                         |
| `pnpm test:ssh` (real OpenSSH, loopback) | **50/50**                                                           |
| `pnpm test:evals`                        | 23/23                                                               |
| `pnpm evidence`                          | 139 requirements — 130 PASS, 0 FAIL, 8 NOT TESTED, 1 NOT APPLICABLE |
| `pnpm eval` (scripted)                   | 12/12; 0 secret boundary violations                                 |
| `pnpm test:replay`                       | pass                                                                |
| determinism ×100                         | pass                                                                |

The 50 skipped tests are the SSH matrix under a plain `pnpm test`; it is opt-in
via `KERNEL_SSH=1` and runs as its own CI job. It skips with a stated reason, not
silently.

Test count went 308 → 509. Nothing from alpha.2 was deleted or weakened.

## 2. What the new gates found

### 2.1 The SSH backend could not connect to a real OpenSSH server

Two independent defects, both invisible to fixture-based testing, both fatal:

1. **`-o SendEnv=` is a syntax error.** OpenSSH requires at least one pattern;
   an empty argument aborts the connection before it is attempted, with
   `no argument after keyword "sendenv"`. Every remote connection failed, and it
   surfaced as `REMOTE_UNAVAILABLE` — reported as though the _host_ were at
   fault. Fixed with the documented negation form, `SendEnv=-*`.
2. **`ControlPath` exceeded the unix-socket limit on macOS.** A `ControlPath` is
   bounded by `sun_path` (104 bytes). The backend built it from `os.tmpdir()` —
   a ~50-character `/var/folders/…` path on macOS — plus `%C`, which _expands_
   to a 40-hex digest. Over the limit, so connection multiplexing, on by
   default, failed every connection. Fixed by using a short base, a short
   filename, and dropping multiplexing rather than the connection if it still
   does not fit.

### 2.2 SSH cancellation and timeouts were ineffective in the default configuration

Measured before the fix:

| `controlMaster`      | requested timeout | actual       |
| -------------------- | ----------------- | ------------ |
| `true` (the default) | 1500 ms           | **20017 ms** |
| `false`              | 1500 ms           | 1503 ms      |

The transport settled on the child's `close` event, which waits for every stdio
stream to end — and the persisted `ControlMaster` holds duplicates of those
descriptors for its whole `ControlPersist` window. `timedOut` was set correctly
the entire time; nothing was listening. Killing the client did not settle the
promise; the remote command finishing did.

So §18 cancellation and §19 timeouts were both effectively absent whenever
multiplexing was on, which is the default. Fixed by treating `exit` as
authoritative with a 100 ms drain for buffered output. Now settles in 1605 ms.

### 2.3 Five architecture lint rules could never fire

`scripts/lint.ts` blanks string literals before matching, which is right for a
rule about identifiers (`fetch(` inside a string is a mention, not a call) and
fatal for a rule whose subject _is_ a string. `explicit-ts-extension`,
`no-real-credentials-in-tests`, `no-child-process-outside-execution`, and half
each of `no-raw-network` and `no-provider-names-in-core` matched against a
projection where their target had been erased.

They reported zero violations, which is exactly what a clean repository reports.
`pnpm lint` had been saying "9 rules, no violations" while roughly half of them
were decorative — for as long as those rules had existed.

Fixed by giving rules two projections (`code` with strings blanked, `text` with
strings kept) and routing each rule to the right one. Reviving them surfaced
eight real sites, all of which turned out to be vendor names used as _data_ — a
secret-scanner pattern, an environment denylist, a default host allowlist. Those
now carry a `lint-allow` pragma with a written reason rather than being carved
out by file, so the rule stays live on the next line added to those files.

`tests/lint/lint-selftest.test.ts` is what makes this not happen again: every
rule needs a must-fail fixture, a must-pass fixture, and assertions on its
documented exceptions, and a new rule with no fixtures fails the suite.

### 2.4 A prompt fixture did not meet §30

`multi-file-rename` had no `livePrompt`, so a live run would have driven it with
`"Rename oldName to newName everywhere."` — a label for a scripted sequence, not
an instruction a model can act on. Caught by
`test:every model-capability task has a natural live prompt (§30)`.

## 3. What changed

### Pillar A — credential persistence

`api_key_file` in the provider endpoint block, validated and registered as a
protected path in the same operation. Precedence is
`session > file > env > none`; an insecure file does **not** silently fall back
to the environment. An inline `api_key` in config is refused loudly.

The path is hard-denied for read-to-model, for kernel-internal reads (so no
content hash reaches the event log), and for writes. A path that _failed_
validation is protected anyway. ADR-0011 records the design; `docs/threat-model.md`
records what `0600` does and does not buy, including the Windows gap.

### Pillar B — real SSH validation

`tests/live/ssh-harness.ts` starts a genuine `sshd` — real host key, real
public-key auth, real protocol, real remote `sh` — and the same suite targets a
real VPS via `KERNEL_SSH_REMOTE`. 50 cases covering §14–§21.

`RemoteConfig` gained `sshConfigFile`, so an alias can be resolved from an
explicit config file. It cannot weaken anything: the security options are
command-line `-o`, and OpenSSH keeps the first value it obtains.

### Pillar C — statistical eval

Two scoreboards that are never added together (§24). `MODEL_ACTION_OMISSION` and
`MODEL_WRONG_ACTION` distinguished by evidence — whether the target file still
holds what the fixture put there — rather than by guessing. Kernel Correctness
computed independently of task success, so a model's off run cannot read as a
runtime regression. `--runs=N` with median/range per task and the sample size
written into the artifact.

Live runs gate on kernel correctness and zero leaks, not on the solve rate.
Failing CI because a model forgot to re-run a grep would make the gate
meaningless within a week.

### Pillar D — evidence-backed gates

`docs/alpha3-evidence-matrix.md`, 139 requirements, and `scripts/evidence.ts`
which rejects `PASS` with no evidence, evidence with no recognised prefix, a
`test:` naming something that appears nowhere under `tests/`, an `artifact:`
pointing at a missing file, a status outside the four-value vocabulary, and a
`NOT TESTED` with no reason.

Writing the matrix immediately caught two dangling test references and a
reference to a doc that did not exist yet.

## 4. What is explicitly NOT claimed

- **Not validated against a real VPS.** Every SSH row came from loopback: same
  uid, same filesystem, no network hop. `docs/alpha3-ssh-validation.md` says so
  at the top, and the VPS-only rows are `NOT TESTED` with a runbook.
- **No live model run this milestone.** The eval methodology is implemented and
  verified offline; live repeated-run results are `NOT TESTED` and need a
  credential and a budget. alpha.2's live evidence still stands for alpha.2.
- **`Real Provider #1 authenticates via `api_key_file`** is `NOT TESTED`. The
  broker path is proven with a synthetic credential; the live half is not.
- **Remote resume, remote hooks, and replay-after-remote** are `NOT TESTED`.
  They need a full kernel session driven over SSH rather than the backend in
  isolation.
- **No OS-level isolation.** The remote workspace jail is a path check. A remote
  shell command can read outside it; redaction is the boundary. This is measured
  by a test that would fail if it ever became untrue, so the claim gets upgraded
  rather than silently staying pessimistic.
- **Remote process termination after cancellation is not guaranteed.** The local
  half is; the orphan's fate is OpenSSH and remote-OS behaviour, and is recorded
  as uncertainty per §18.
- **Windows permission checking on credential files does not exist.** No POSIX
  mode bits; the check is skipped and the gap is in the threat model.
- **No second provider, no Anthropic live validation, no live reasoning, no live
  parallel tools, no remote daemon, no hardware-backed credential storage.**

## 5. Stop conditions (§50)

| Condition                                                            | State                                                                                                    |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Credential Stop — a configured credential path becomes reachable     | not triggered                                                                                            |
| Secret Stop — a canary reaches an unauthorised sink                  | not triggered (0 local, 0 remote)                                                                        |
| SSH Stop — the remote jail can be escaped beyond the declared model  | not triggered; the declared model is `policy-enforced`, and §15's "do not claim os-isolated" is honoured |
| Replay Stop — remote execution causes live/replay divergence         | not evaluated; remote replay is `NOT TESTED`                                                             |
| Eval Stop — model stochasticity conflated with kernel correctness    | not triggered; separated by construction and tested                                                      |
| Evidence Stop — a release-blocking item marked PASS without evidence | not triggered; mechanically enforced                                                                     |

## 6. Tagging

**Not tagged.** §52 requires tagging the exact commit whose _trusted CI_
evidence is recorded, and CI has not run these jobs yet — the numbers above are
from a local run. The new jobs (`lint-selftest`, `evidence`,
`credential-security`, `ssh`, `eval-methodology`) need one green CI run on the
release commit first.

Two things should be decided before tagging:

1. Whether to run the SSH matrix against a real VPS and upgrade those rows, or
   ship with them `NOT TESTED` and the runbook.
2. Whether to spend a live eval run to populate the Pillar C rows, or ship the
   methodology with alpha.2's live evidence and no new numbers.

Both are scope calls, not blockers — the milestone's own success definition (§55)
is met either way, with the SSH clause reading "a real OpenSSH server" rather
than "a real isolated VPS".
