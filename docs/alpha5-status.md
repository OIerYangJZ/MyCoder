# `v0.1.0-alpha.5` — Container Enforcement Hardening status

**Baseline:** `v0.1.0-alpha.4`, plus four follow-up PRs, at `main` = `7663484`
(recorded at kickoff; nothing moved the alpha.4 tag) · **Provider #1
(live-validated):** DeepSeek over `openai-chat` · **Container validation:**
macOS Docker Desktop (docker 29.7.2, `linux/arm64`, kernel `6.12.76-linuxkit`)
executed locally; native Linux Docker Engine through the new fail-closed CI job ·
**alpha.4.1:** not cut — no consumer needed a named release of the post-tag fixes,
and §58 makes it optional

Status vocabulary is the four values from alpha.3 §34. **PASS** means a named,
executable piece of evidence asserts it. **NOT TESTED** means it is not asserted
here, and the notes say why. **NOT APPLICABLE** means out of scope. Every claim
below maps to a row in `docs/alpha5-evidence-matrix.md`, which
`node scripts/evidence.ts` checks mechanically — over alpha.3's and alpha.4's
matrices as well, because those rows are still the evidence for those claims.

> **The headline.** For the first time the kernel can say that an arbitrary
> subprocess _cannot reach_ a host credential, rather than that it _will be
> refused_. `cat ~/.ssh/id_rsa` inside a session now fails with
> `No such file or directory` from the kernel of the machine, not with a policy
> denial — and `python3`, `node fs.readFileSync`, `find /`, and `tar | base64` all
> fail the same way, because the file is not in the mount namespace.
> `network: false` is enforced by the absence of a route, verified against a
> literal IP so DNS cannot be mistaken for the boundary.
>
> **The second headline is smaller and more useful.** The milestone's four real
> defects were: a cancel that did not cancel, a composition test that passed while
> asserting nothing, a cost total that disagreed with itself across a restart, and
> a teardown race that made the new gate flaky. Only the first was in the new
> code.

---

## 1. What was actually executed

| Gate                                                 | Result                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                     | clean                                                                                                           |
| `pnpm lint`                                          | **12 rules** (9 + 3 new), 0 violations                                                                          |
| `pnpm lint:selftest`                                 | **112/112** — every new rule has must-fail and must-pass fixtures                                               |
| `pnpm format:check`                                  | clean                                                                                                           |
| `pnpm test`                                          | **732 tests, 661 pass, 0 fail, 71 skipped** (was 643/572/0/71)                                                  |
| `pnpm test:container` (macOS Docker Desktop)         | **143 pass, 0 fail**, twice consecutively                                                                       |
| — `tests/unit/container-plan.test.ts`                | 51 pass — mount planning, argv, validator, enforcement, error mapping                                           |
| — `tests/live/container-live.test.ts`                | 55 pass — the §59 attack matrix and the §35 negative controls                                                   |
| — `tests/live/container-composition.test.ts`         | 8 pass — Subagent, Skill, Hook, mutation audit, replay, resume                                                  |
| — `tests/integration/backend-conformance.test.ts`    | 29 pass — 14 semantic cases × local and container, plus one identity check                                      |
| `pnpm test:security`                                 | green, unchanged                                                                                                |
| `pnpm test:replay`                                   | green, unchanged                                                                                                |
| `pnpm test:soak` at `KERNEL_SOAK_REPEATS=50`         | green, unchanged                                                                                                |
| `pnpm evidence`                                      | alpha.3: 169 rows · alpha.4: 119 rows · alpha.5: **110 rows, 100 PASS, 0 FAIL, 5 NOT TESTED, 5 NOT APPLICABLE** |
| live dogfood (DeepSeek, container backend)           | 5 turns across a restart, suite green, **0 canary leaks**                                                       |
| CI job `Container Enforcement (native Linux Docker)` | added, fail-closed via `KERNEL_CONTAINER_REQUIRED=1`                                                            |

The 71 skipped tests are the SSH matrix under a plain `pnpm test`; it remains
opt-in through `KERNEL_SSH=1`. The container suites skip the same way, with a
stated reason — **except** where `KERNEL_CONTAINER_REQUIRED=1` is set, which is
what the CI job sets, and which turns a missing runtime into a failure rather
than a skip (§65).

---

## 2. What the new gates found

Four real defects and one observation, all in `docs/alpha5-dogfood.md` with
ledger entries. Summarised here because the pattern is the point:

**D-001 — a cancel that did not cancel (container).** Cancelling a containerised
command returned control after the command finished on its own: 120 seconds for a
`sleep 120` that was cancelled at 2.5 s. `docker run` forwards SIGTERM rather than
exiting, and the workload is PID 1 in its own namespace, where SIGTERM is ignored
unless a handler is installed. Killing the client was a no-op at both ends. Fixed
by removing the _container_ on teardown; the client's exit follows. The regression
asserts a **latency bound**, because `timedOut: true` was already being set
correctly while the defect was live.

This is the same shape as alpha.3's SSH defect, reached by a different route.
Worth naming as a category: **when the transport is a process you do not own,
signalling it is not the same as stopping the work.**

**D-002 — a test that passed while asserting nothing (evidence).** The Hook +
Container gate used `[[hook]]` where the loader expects `[[hooks]]`, so no hook
was registered, no output was produced, and the test's "no output means it was
contained" branch reported success. It would have stayed green with the feature
deleted. Fixed, and the test now asserts the hook **ran** before asserting what it
saw.

**D-003 — a cost total that disagreed with itself (replay).** After a restart,
`/status` printed `usage … $0.0033` directly above `cost: $0.0006 total`.
`usage.costUsd` was restored from the session metadata on resume; the
direct/delegated breakdown was not. The replay gate compares terminal state, not
cost, and the fake model reports no cost — so every offline resume test compared
0 against 0 and agreed. It took a resumed session with a **real** provider for the
two numbers to differ. Fixed by persisting the delegated share alongside the
total, with a regression confirmed to fail against the unfixed code.

**D-004 — a model schema mistake, not a kernel defect.** The model omitted
`$.mode` on an `Edit` and recovered in one step, because the error named the
missing field. Recorded for what it says about message quality.

**D-005 — a teardown race under parallel container suites (test infrastructure).**
`rm -rf` of a former bind-mount target returns `EACCES` on macOS while the daemon
is still unmounting it, which made the combined container run fail roughly one
test in seventy. Fixed with a bounded retry in both test harnesses and confirmed
by two consecutive clean 143/143 runs. Recorded rather than absorbed, because
"flaky in the configuration CI uses" is a defect in the gate.

---

## 3. What is new in the kernel

```
src/execution/enforcement.ts     six enforcement dimensions, ordered levels,
                                 and a derived summary label
src/execution/container-plan.ts  mount planner, plan validator, docker argv,
                                 path translation — all pure functions
src/execution/container.ts       the backend: probe, image resolution, transport,
                                 error mapping, capability executor
```

and, threaded through the existing graph: `EnvironmentDescriptor.enforcement`,
a `[container]` config section (user config only), `--backend container`,
`backendDetail()` on the control host, eight new structured error codes, and the
`delegatedCostUsd` field D-003 required.

Three architecture lint rules were added, each with self-test fixtures:
`no-docker-cli-outside-container-backend`, `no-container-escape-flags`,
`no-enforcement-overclaim`.

---

## 4. The claim, stated precisely

`v0.1.0-alpha.5` claims:

> The kernel has a real Container `ExecutionBackend` that preserves the
> backend-neutral runtime contract. On the strongest validated platform, arbitrary
> subprocesses execute with capability-derived host mounts, protected host
> resources absent, scrubbed environment, restricted privileges, and
> runtime-enforced default network denial. Container enforcement is measured
> separately from policy enforcement, platform-specific limitations are reported
> explicitly, and Agent/Skill/Hook/replay/resume behaviour remains correct under
> the new backend.

It does **not** claim: container or kernel zero-day resistance, VM-level
isolation, native-Linux-equivalent isolation on macOS or Windows, host-scoped
network allowlist enforcement, a production multi-tenant sandbox, Docker daemon
compromise resistance, billing-grade delegated cost, parallel agents, automatic
delegation, or clean direct-OpenAI behavioural validation. Each has a row in the
matrix saying so.

---

## 5. The three sentences worth reading twice

**Enforcement is six values, not one.** A container makes the subprocess's
filesystem view a kernel fact, leaves the trusted file broker exactly as
policy-enforced as before, enforces network _denial_ absolutely and a host
_allowlist_ not at all. `/status` prints all six lines; the summary label is
derived from the weakest process-facing one, so no backend can claim a label its
enforcement does not support.

**`Read` and `Edit` are still host operations, deliberately.** §28 and §30 rule
out re-implementing the edit protocol as `docker exec sed`, so the freshness
ledger, the atomic write and the diff all still run on the host — and are reported
as `policy-enforced`, not upgraded by association.

**A granted network is broader than the hostnames named.** `--network none` is a
real boundary. Bridge networking is not a hostname filter, so approving
`{"hosts":["registry.npmjs.org"]}` approves the internet for that command. The
approval prompt says exactly that, in those words, because that prompt is the last
point at which a human can decline.

---

## 6. Cross-platform

| Platform                 | Status                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Linux (native Docker)    | The CI job runs the identical suites and fails rather than skips                                          |
| macOS (Docker Desktop)   | Executed here: 143/143, twice. **Not** called equivalent to native Linux                                  |
| Windows (Docker Desktop) | NOT TESTED. No trustworthy runner; the offline suites still run and skip the container ones with a reason |

---

## 7. Loose ends, stated rather than closed

- **Host-scoped egress is still unenforced for subprocesses.** It is reported as
  `best-effort` in the descriptor, in `/status`, in the system prompt and in the
  approval prompt. An egress proxy inside the container network namespace is the
  fix, and it is alpha.6 option A.
- **Resource limits are configured but only partly stress-tested.** `--pids-limit`
  has a fork-bomb case; memory and CPU are asserted in the argv, not exercised to
  their bounds. The matrix says "truthful", not "tested", for those two.
- **Latency is worse.** One container start per command, roughly 250–800 ms on
  Docker Desktop against ~20 ms locally. §27 says to change the one-container-per-
  execution design only with measured evidence; this is the measurement to beat.
- **Windows containers are untested**, and the plan permits that.
- **Billing-grade cost** remains parked from alpha.4 §57; every monetary value is
  still labelled `estimated`.

---

## 8. What alpha.6 should weigh (§75)

Not pre-committed. The dogfood's failure-layer distribution — one defect in the
new layer, one in the oldest layer the new one perturbed, one in the evidence
itself, none in policy, context or tools — is the input §75 asks to weigh more
heavily than feature visibility.

That points at **A (stronger enforcement)**: host-scoped egress would close the
one dimension still reported `best-effort`, and a Linux namespace backend would
make `os-enforced` reachable. **B (provider breadth)** remains blocked on a clean
instrument, unchanged since alpha.4. **C (productization)** has no evidence
arguing for it yet.
