# alpha.6 scoped-egress dogfood

**Date:** 2026-08-15
**Runner:** `evals/experiments/alpha6-egress-dogfood.ts`
**Hosts:** two, and the second one matters —

1. macOS 25.5.0 (darwin/arm64), Docker Desktop 29.7.2, kernel `6.12.76-linuxkit` — `nativeLinux: false`
2. Ubuntu 26.04 LTS (aarch64), docker.io 29.1.3, kernel `7.0.0-29-generic` — **`nativeLinux: true`**

**Image:** `node:22-bookworm` (Node v22.23.2 / v22.20.0)
**Network:** real internet, real registry, real Git remote — not the controlled §56 topology

§70 asks for the friction as well as the result, in as many words: _"Do not hide
strict-egress friction."_ Two of the seven steps below failed the first time for
reasons that have nothing to do with the network, and one of them failed because
of something about the _network these machines are on_ rather than about the
kernel. All of it is written up.

---

## What ran

| #   | Step                                                      | Approved hosts                     | Outcome                               | Egress decision      |
| --- | --------------------------------------------------------- | ---------------------------------- | ------------------------------------- | -------------------- |
| 1   | `npm install --no-save is-number@7.0.0`                   | `registry.npmjs.org`               | **added 1 package in 8s**             | allowed              |
| 2   | `curl https://registry.npmjs.org/is-number`               | `registry.npmjs.org`               | `status=200 bytes=36183`              | allowed              |
| 3   | `git ls-remote https://github.com/nodejs/node.git`        | `github.com`                       | exit 0, refs returned                 | allowed              |
| 4   | `curl https://github.com/`                                | `registry.npmjs.org`               | `CONNECT tunnel failed, response 403` | **host-not-allowed** |
| 5   | the same request, approval expanded                       | `registry.npmjs.org`, `github.com` | `status=200`                          | allowed              |
| 6   | `POST` an unknown canary to `https://example.com/collect` | `registry.npmjs.org`               | `403`, nothing sent                   | **host-not-allowed** |
| 7   | `curl http://169.254.169.254/latest/meta-data/`           | `registry.npmjs.org`               | `403`                                 | **host-not-allowed** |

A real package install, a real Git fetch and a real registry read all completed
through the proxy with a single approved host each. Steps 4, 6 and 7 are the
milestone's point: the same session, the same proxy, a different destination, and
a refusal the workload cannot argue with.

**Native-Linux repeat** (Ubuntu 26.04, aarch64, docker.io 29.1.3): identical
outcomes throughout. `npm install` "added 1 package in 9s"; the registry GET
returned `status=200 bytes=36183` — byte-identical to the macOS run; `git
ls-remote` exit 0; steps 4, 6 and 7 all `403` with `host-not-allowed`; step 5
`status=200` after expansion. Topology setup median 274 ms, range 269–284 ms,
tighter than the macOS range. Nothing in the table is a Docker Desktop artefact.

## Approval expansion (§68)

Step 4 → step 5 is the strict-allowlist workflow end to end:

```
approved: registry.npmjs.org
→ curl https://github.com/
→ curl: (56) CONNECT tunnel failed, response 403
→ proxy audit: { decision: "denied", reason: "host-not-allowed", host: "github.com" }
→ expand approval to { registry.npmjs.org, github.com }
→ retry
→ status=200
```

The diagnostic names the denied host and nothing else — no path, no query, no
header. That is exactly the §45 shape: enough for the model to ask for the right
thing, nothing that could carry a token.

## Exfiltration attempt (§69)

`ALPHA6_DOGFOOD_CANARY_7d21f9ae` is not registered with `SecretBroker` and is not
matched by the redactor, so no content-based defence could have helped. The POST
to `example.com` was refused at the CONNECT, meaning the request body was never
written to any socket.

```
canary reached a denied host: no
```

Step 7 is the same attack pointed at the address that matters most in practice.
`169.254.169.254` was refused by the _host_ check before the address check even
ran, because an IP literal is a host like any other and it was not in the
approved set. Under a hostname that resolves there, the address check refuses it
instead — that path is covered by the controlled suite, which can make a name
resolve to the metadata address on purpose.

## Latency (§65)

Per-execution topology setup, measured across all seven steps:

```
median 253 ms
range  215–456 ms
```

Setup is: create an `--internal` network, start the proxy sidecar, attach it to
the private network, wait for its readiness line, read its address back from the
daemon. It is paid once per execution. Against an 8.7 s npm install that is ~3%;
against a 0.7 s denied request it is a third of the wall time, which is the
honest way to state it — the overhead is fixed, so it is proportionally worst on
the fastest commands.

No attempt was made to reduce it. §65 forbids weakening the topology for
performance in this milestone, and the obvious optimisation — a shared proxy —
is the one §66 defers pending measured need.

## Defect ledger

### D-A6-1 — orphan collection deleted live topologies

**Found:** running the container suites concurrently.
**Severity:** high — a second session could break the first.

`collectOrphanedEgressResources` removed every Docker resource carrying the
`mycoder.egress=1` label, and it runs at backend construction. A kernel starting
while another kernel was mid-execution deleted that kernel's live network, which
surfaced as `network mycoder-egress-… not found` during `network connect`.

§47's "clean only stale resources owned by this Kernel namespace" cannot mean
"carries our label", because every concurrent kernel uses the same label.

**Fix:** resources carry a `mycoder.egress.created` timestamp label and the
collector only removes those older than 15 minutes — comfortably longer than any
execution, comfortably shorter than a human noticing a leak. A resource whose
timestamp is unparseable is treated as _live_, because deleting a working
topology is worse than leaving a stray network.
**Regression:** `tests/live/container-egress.test.ts` — "removes the network and
the proxy when the execution finishes"; the concurrent-suite run that found it is
now the default `pnpm test:container` shape.

### D-A6-2 — the resolver maps public names into RFC 2544 space

> **Corrected 2026-08-15 after the native-Linux run.** This was first written up
> as a Docker Desktop / macOS trait. It is not. The Ubuntu 26.04 aarch64 VM, on a
> different machine with `docker.io` rather than Docker Desktop, resolves
> `registry.npmjs.org` to the _same_ `198.18.1.160`. Both machines sit behind one
> resolver, so the cause is the **network environment**, not the daemon or the OS.
>
> The consequence is worse than the original write-up implied: **both available
> machines share the resolver, so the real-internet path under the strict address
> policy cannot be validated from here at all.** Every real-network result in this
> document was produced with `allowBenchmarkRange` enabled. See the alpha.7 notes.

**Found:** first dogfood run — every approved host denied `address-not-global`.
**Severity:** medium — environmental, but it made scoped egress unusable here.

The resolver answers `registry.npmjs.org` with `198.18.1.160` and `github.com`
with `198.18.1.168`, on both the Mac and the Linux VM. `198.18.0.0/15` is RFC 2544
benchmarking space, which §23 correctly classifies as non-global and refuses.
Something in the network path — a DNS-interception VPN is the usual cause — uses
that range as NAT space for public destinations, so behind such a resolver the
strict address policy denies the entire internet.

The classification is not wrong. The deployment is unusual.

**Fix:** `benchmarking` is now a distinct `AddressScope` rather than part of
`reserved`, and `ProxyPolicy.allowBenchmarkRange` permits _only that /15_ when
explicitly enabled. Default off; off on the native-Linux release tier. The audit
line now says `benchmarking` rather than a generic `reserved`, so an operator can
tell "my resolver is unusual" from "something pointed a name at reserved space".
**Not done:** the flag is reachable from the backend API but is **not yet exposed
in the TOML configuration schema**. A user on such a host currently has no
supported way to turn it on. Follow-up.
**Regression:** `tests/unit/egress-host.test.ts` classification cases.

### D-A6-3 — an HTTPS address denial was unreadable

**Found:** first dogfood run, while diagnosing D-A6-2.
**Severity:** medium — usability of a security refusal, which is a security
property in practice: a refusal nobody can interpret gets worked around.

For HTTPS the proxy replied `200 Connection Established` first (as the protocol
requires) and only then resolved and classified the address. A denial at that
point has no way to send an HTTP error, so it tore down the tunnel — and the
workload saw `OpenSSL SSL_connect: SSL_ERROR_SYSCALL`. Seven steps of the first
dogfood run reported a TLS failure for something that was never a TLS problem.

**Fix:** resolution and address classification moved _before_ the `200`. Nothing
is weakened: the address is only used after the SNI check, so no packet reaches
the destination before its identity is verified (§57). A denied address now
produces `HTTP/1.1 403` with `X-Mycoder-Egress-Reason: address-not-global`.
**Regression:** `tests/unit/egress-proxy.test.ts` — the loopback rebinding case
asserts the 403 body; the live suite asserts the reason code.

### D-A6-4 — a scoped-egress install fails on writes before it reaches the network

**Found:** dogfood steps 1a and 1b.
**Severity:** low — pre-existing ADR-0014 behaviour, surfaced by a network task.

`npm install <pkg>` needs to create `node_modules/` and to rewrite
`package.json`. The workspace base is mounted read-only by design (ADR-0014 §12),
so the install fails with `ENOENT mkdir /workspace/node_modules` and then `EROFS
open /workspace/package.json` — _before_ any request is made. Neither error
mentions the network, and a user debugging a scoped-egress install would
reasonably start by suspecting the proxy.

**Not a regression, and not fixed here.** It is the mount model working. Recorded
because it is the most likely way a real user's first scoped-egress task fails,
and because "the install failed" reads like an egress problem when it is not.
The dogfood works around it with a declared generated path plus `--no-save`.
**Follow-up:** the container backend could notice that a write-shaped command
failed with `EROFS`/`ENOENT` under a read-only base and say so, the way D-007 in
alpha.5 turned an OCI error into "executable not found".

### D-A6-5 — the proxy readiness timeout had zero measured headroom

**Found:** the first native-Linux container run, on a VM where `docker.io` had
been installed thirty minutes earlier.
**Severity:** medium — a latent red CI, not a security defect.

The first container run on the fresh VM failed 2 of 195 tests. Investigating, one
test in the egress suite took **31 s** while every other test took under 600 ms —
and the proxy readiness timeout was 30 s.

The stall is not in the egress path. Across 20 consecutive executions the sidecar
reported topology setup at 266–315 ms, and reproducing the slow test in isolation
took 1.3 s end to end. The 31 s attached to whichever test ran _first_ and did not
recur; the VM was showing a load average of 2.5 on 4 CPUs with containerd still
doing first-run work after the fresh install.

So the cause was contention, not the code. The defect is that the timeout sat
exactly at the observed worst case: a security gate whose budget has no headroom
goes red for reasons unrelated to what it guards, and a gate people learn to
re-run is a gate nobody reads.

**Fix:** readiness budget raised 30 s → 90 s. The cost is bounded — this path only
waits when the proxy is genuinely not coming up, and `waitForReady` still exits
immediately when the container has died rather than waiting out the budget. The
timeout message now carries the elapsed time, the poll count and the proxy's last
stderr line, so the next occurrence is diagnosable instead of mysterious.
**Regression:** covered by the container suite, which ran 195/195 seven times
across both platforms after the change.

## Safety

```
canary to an unapproved destination        : denied, never written
canary to an approved destination          : delivered (expected — §42)
host-canary / workspace-canary regressions : green (alpha.5 suites, unchanged)
secret in a proxy log line                 : none — audit is host/port/reason only
safety violations                          : 0
```

The second line is not a failure. §42 is explicit that alpha.6 governs _where_
bytes go and not what an approved destination receives, and the controlled suite
asserts that limit deliberately so the release note cannot drift into claiming
otherwise.

## What this run did not cover

- **Native Linux.** This is Docker Desktop on macOS. The release-evidence tier is
  native-Linux CI, and D-A6-2's workaround is off there — so the real-internet
  path under the _strict_ address policy is validated by CI, not by this run.
- **A redirect that actually crosses hosts.** Step 4/5 exercises the second-host
  approval workflow with two separate requests. A single `curl -L` whose redirect
  target is a CDN hostname would be a stronger version of §68; none of the
  approved hosts here redirects off-host.
- **Non-HTTP protocols**, by design (§7).
