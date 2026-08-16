# v0.1.0-alpha.6 — status

**Date:** 2026-08-15
**Milestone:** scoped subprocess egress enforcement & adversarial assurance
**Baseline:** `v0.1.0-alpha.5.1`
**Design:** ADR-0015

---

## What actually ran

| Gate                  | Result                                                       |
| --------------------- | ------------------------------------------------------------ |
| `pnpm typecheck`      | clean                                                        |
| `pnpm test` (offline) | **855 tests · 784 pass · 0 fail · 71 skip**                  |
| `pnpm test:container` | **195 tests · 195 pass · 0 fail** — 4 consecutive clean runs |
| `pnpm lint`           | **16 rules · no violations**                                 |
| `pnpm lint:selftest`  | **133 tests · 133 pass · 0 fail**                            |
| real-network dogfood  | 7 steps, `evals/experiments/alpha6-egress-dogfood.ts`        |

**Native-Linux release tier (§37, §74) — the alpha.6 blocker is now cleared.**
Ubuntu 26.04 LTS aarch64, `docker.io` 29.1.3, kernel `7.0.0-29-generic`, Node
v22.20.0; `probeContainerRuntime` reports **`nativeLinux: true`**. Not Docker
Desktop, not a VM-backed daemon.

| Gate (native Linux, `KERNEL_CONTAINER_REQUIRED=1`) | Result                                                     |
| -------------------------------------------------- | ---------------------------------------------------------- |
| offline suite                                      | **855 · 784 pass · 0 fail · 71 skip** — identical to macOS |
| container + egress tier                            | **195 · 195 pass · 0 fail**, 6 consecutive runs            |
| egress + resources only                            | **30 · 30 pass · 0 fail**                                  |
| architecture lint                                  | 16 rules, no violations                                    |
| lint self-tests                                    | 133 · 133 pass                                             |
| scoped-egress setup latency                        | median **272 ms**, range 266–297 ms                        |
| real-network dogfood                               | repeated, outcomes identical to macOS                      |

`KERNEL_CONTAINER_REQUIRED=1` was set throughout, so a missing runtime would have
been a failure rather than a skip (§65).

Baseline was 737 · 666 pass · 71 skip. alpha.6 adds **118 tests and no new
skips**: 79 offline unit/security tests for the parsers, the decision function
and composition, 30 live tests for the attack matrix and resource limits, and 9
lint self-test fixtures.

Every gate was run on both platforms. The macOS numbers came first; the
native-Linux numbers are the ones the release claim rests on (§37).

## What is now enforced

The sentence alpha.5 could not write:

> When a containerized subprocess is approved for a bounded set of HTTP/HTTPS
> destinations, it cannot reach any other external destination by ignoring proxy
> environment variables, resolving another host, opening a raw socket, changing
> an HTTP Host header, using an HTTPS CONNECT tunnel for another domain, or
> selecting a different TLS SNI on a shared IP.

Concretely, `network = { hosts: [...] }` moved from a note in a policy record to
a topology:

```
alpha.5   { hosts: ["registry.npmjs.org"] }  →  --network bridge
                                             →  the whole internet
                                             →  networkAllowlist: best-effort

alpha.6   { hosts: ["registry.npmjs.org"] }  →  --internal network, no route
                                             →  one dual-homed kernel proxy
                                             →  networkAllowlist: container-enforced
```

The `networkAllowlist` dimension of the `EnforcementDescriptor` is the single
line in the codebase that summarises the milestone, and it moved from
`best-effort` to `container-enforced` **only** on the container backend, only for
the HTTP/HTTPS scope, and only alongside the mechanism. Local and SSH keep
`best-effort` and have a negative-control test that keeps them there.

Also closed:

- **`hosts: []` is no longer "the internet".** alpha.5's `network !== false` read
  an empty allowlist as a grant. It is now an invalid request.
- **Unrestricted is a mode you ask for by name**, with its own approval subject,
  its own prompt wording ("the entire internet") and its own audit record.
- **Memory and CPU limits have runtime evidence** (§62, §63). alpha.5 asserted
  docker argv; alpha.6 kills a process that allocates past 96 MiB and reads
  `cpu.max` out of the container's own cgroup.

## Defects found and fixed

Five, four of them in code written this milestone. Every one was found by
executing something — none by reading the code.

| ID     | Found by                                  | Severity | Status                             |
| ------ | ----------------------------------------- | -------- | ---------------------------------- |
| D-A6-1 | running the container suites concurrently | high     | fixed + regression                 |
| D-A6-2 | first real-network dogfood run            | medium   | fixed; attribution later corrected |
| D-A6-3 | diagnosing D-A6-2                         | medium   | fixed + regression                 |
| D-A6-4 | dogfood step 1                            | low      | recorded, not an egress defect     |
| D-A6-5 | first native-Linux container run          | medium   | fixed + diagnostics                |

**D-A6-1 — orphan collection deleted live topologies.** The startup garbage
collector removed every resource carrying the egress label, so a second session
starting mid-execution destroyed the first session's network. §47's "stale
resources owned by this Kernel namespace" cannot mean "carries our label" when
every concurrent kernel uses the same one. Fixed with a creation-timestamp label
and a 15-minute staleness threshold; an unparseable timestamp is treated as live,
because deleting a working topology is worse than leaving a stray network.

**D-A6-2 — this host's resolver maps public names into RFC 2544 space.**
`registry.npmjs.org` resolves to `198.18.1.160` here, which §23 correctly
classifies as non-global, so scoped egress denied the entire internet. The
classification is right and the deployment is unusual. `benchmarking` is now a
distinct address scope with a narrow, off-by-default opt-in for that one /15.
**Attribution corrected after the native-Linux run.** This was first written up as
a Docker Desktop / macOS trait. It is not: the Ubuntu VM, a different machine
running `docker.io`, resolves `registry.npmjs.org` to the _same_ `198.18.1.160`.
Both machines sit behind one resolver, so the cause is the network environment.
The consequence is worse than first recorded — **both available machines share
that resolver, so the real-internet path under the strict address policy cannot be
validated from here at all**, and every real-network result was produced with
`allowBenchmarkRange` enabled.
**Follow-up: the flag is not yet exposed in the TOML schema**, so a user on such
a host has no supported way to enable it.

**D-A6-3 — an HTTPS address denial was unreadable.** The proxy sent
`200 Connection Established` before classifying the resolved address, so a denial
had no way to send an HTTP error and tore down the tunnel — the workload saw
`SSL_ERROR_SYSCALL` for something that was never a TLS problem. Resolution moved
before the `200`. Nothing is weakened: the address is still only used after the
SNI check, so no packet reaches the destination before its identity is verified.

**D-A6-5 — the proxy readiness timeout had zero measured headroom.** The first
container run on the freshly-provisioned VM failed 2 of 195 tests, and one test
took 31 s against a 30 s readiness budget. The stall was not in the egress path —
the sidecar reported 266–315 ms across 20 executions, and the same scenario in
isolation took 1.3 s — it was contention on a 4-CPU VM where containerd was still
doing first-run work. The defect is the missing headroom, not the stall: a gate
whose budget equals its observed worst case goes red for reasons unrelated to what
it guards. Budget raised to 90 s, and the timeout now reports elapsed time, poll
count and the proxy's last stderr line. 195/195 on six subsequent runs.

**D-A6-4 — a scoped-egress install fails on writes before it reaches the
network.** `npm install <pkg>` needs to create `node_modules/` and rewrite
`package.json`; the workspace base is read-only by design (ADR-0014 §12). The
resulting `EROFS`/`ENOENT` says nothing about the network, and a user debugging a
scoped-egress install would reasonably suspect the proxy first. Recorded, not
fixed — it is the mount model working, and the fix belongs with alpha.5's D-007
error-mapping work.

## Defects in old composed paths

Two, both in test infrastructure rather than in the kernel, and both worth
naming because they were making a release gate lie.

- **A pre-existing macOS bind-unmount race** made `container-composition.test.ts`
  fail roughly one run in four under the full suite: the daemon unmounts a bind
  after the container exits, and removing the former mount target inside that
  window fails with `EACCES`. The shared harness already retried for exactly
  this; that one test did its own cleanup and did not. Now retried — 4/4 clean
  runs since.
- **An alpha.5 test asserting the alpha.6 gap.** `container-live.test.ts` asserted
  `plan.network === 'bridge'` and `networkAllowlist === 'best-effort'` for a
  host-scoped profile. Both were accurate descriptions of alpha.5 and both are now
  wrong; they were rewritten to assert the new behaviour, with a comment saying
  what they used to assert and why the line moved.

Two more test-side errors were caught by the tests themselves and are worth
recording because each one would have produced a vacuous PASS:

- The **live SNI test drove `curl`**, which derives the CONNECT authority from the
  URL — so the request was refused by the _host_ check and the SNI enforcement
  was never exercised. The test was green and proved nothing. Rewritten to open
  the tunnel by hand: `CONNECT allowed.test:443` (approved) followed by a TLS
  handshake for `denied.test`, with a matching-SNI positive control that
  establishes a real session.
- A **`curl` exit-code assertion** on a denied host: `curl` exits 0 on a 403, so
  the assertion would have passed whether the proxy denied the request or served
  it. Replaced with assertions on the status, the reason in the body, and the
  absence of the denied target's marker.

## What remains parked

Unchanged from the plan, and none of it blocks the tag:

- direct OpenAI validation and clean cross-model delegation attribution (§71)
- billing-grade cost reconciliation; monetary figures remain **estimated** (§72)
- Windows container validation — **NOT TESTED**, not claimed (§73)
- generic TCP egress, UDP, QUIC, TLS MITM, wildcard domains, private-network
  allowlisting (§7)

## What is not established

The honest ceiling on this milestone's evidence.

**The real-internet path under the strict address policy.** This is the one gap
the native-Linux run did _not_ close, and it got worse rather than better: both
available machines sit behind the same resolver, which maps public hostnames into
`198.18.0.0/15` (D-A6-2). Every real-network result on both platforms was
therefore produced with `allowBenchmarkRange` enabled. The strict address check is
fully exercised by the controlled §56 topology — including the rebinding and
metadata cases, with paired controls — but "an approved public host resolves to a
genuinely global address and is reached" has not been executed anywhere. It needs
a machine on an unfiltered resolver.

**A hostname-based metadata attack against a real cloud endpoint.** The controlled
suite covers it by construction; no real cloud instance was used.

**A redirect that genuinely crosses hosts.** §68 wanted a workflow that discovers
a second hostname on its own. The dogfood demonstrates the two-request version
(deny → expand → succeed); none of the approved hosts redirected off-host, so the
single-command `curl -L` version is untested.

**The independent second VM (§74).** The native-Linux VM _is_ the independent
confirmation §74 asked for, so this is now done rather than skipped. There is no
third machine, which matters only for the resolver gap above.

## Release readiness

| Checklist area                           | State                                         |
| ---------------------------------------- | --------------------------------------------- |
| ADR-0015 accepted                        | yes                                           |
| network semantics unambiguous            | yes — three modes, empty list invalid         |
| topology, proxy hardening, fail-closed   | yes — §86/§87 items all covered               |
| HTTPS identity                           | yes — §88 items all covered, real fixtures    |
| adversarial matrix with reverse controls | yes — 15 attacks, every one paired            |
| resource evidence                        | yes — §62/§63 closed with runtime observation |
| composition                              | yes — algebra plus policy-engine mechanism    |
| evidence artifacts                       | yes — 4 documents, this one included          |
| **native-Linux evidence on this commit** | **done — 195/195 × 6, `nativeLinux: true`**   |

Everything the milestone asked for is implemented and evidenced, and the
native-Linux tier the headline claim rests on is green. `v0.1.0-alpha.6` is
taggable on this commit.

The one thing a reader should carry forward is not a missing feature but a
missing _environment_: the strict address policy has never been exercised against
a real public destination, because neither available machine has an unfiltered
resolver. That is an alpha.7 input, not an alpha.6 blocker — the check itself is
covered by the controlled topology with paired controls.
