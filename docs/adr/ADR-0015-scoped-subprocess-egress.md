# ADR-0015 — Scoped subprocess egress enforcement

**Status:** Accepted
**Date:** 2026-08-15
**Milestone:** v0.1.0-alpha.6
**Supersedes nothing. Extends:** ADR-0007 (one execution backend interface),
ADR-0009 (zero runtime dependencies), ADR-0014 (container execution backend).

## Context

ADR-0014 gave the container backend a real network boundary in exactly one
direction. `network: false` becomes `--network none`, and a process in a network
namespace with no interfaces cannot reach anything: that is a kernel fact, and
alpha.5 reported it as `container-enforced`.

The other direction was disclosure only. `network: { hosts: ["registry.npmjs.org"] }`
became `--network bridge` — ordinary Docker networking with a default route —
and the host list travelled into the approval prompt, the audit record and
`/status` without anything imposing it. alpha.5 was explicit about this: the
`networkAllowlist` dimension of the `EnforcementDescriptor` reported
`best-effort`, and `describeEnforcement` emitted the sentence "a host allowlist
is not enforced on subprocesses: enabling network is broader than the hostnames
named."

That sentence is honest and it is also the largest remaining gap in the
capability model. A user who approves `registry.npmjs.org` is shown one host and
given the internet. Every other capability in the kernel narrows to the thing
that was approved — a granted `file.write` on `src/auth.ts` becomes a write root
of exactly that path, not its directory — and network was the one place where the
grant and the enforcement were different sizes.

The obvious cheap fix does not work. Setting `HTTP_PROXY` on an ordinary bridge
network is a request, not a boundary: the workload is untrusted code, and it can
`unset HTTP_PROXY`, open a raw socket, resolve any name it likes and connect. The
enforcement has to be in the topology, not in the environment.

## Decision

### 1. Three network modes, named and distinct

```ts
type ProcessNetworkMode =
  { kind: 'deny-all' } | { kind: 'allowlist'; targets: EgressTarget[] } | { kind: 'unrestricted' };
```

`CapabilityProfile.network` gains a third state to match:
`false | { hosts } | { unrestricted: true }`.

**`{ hosts: [] }` is invalid.** It is refused by `normalizeNetworkMode`, which
returns `deny-all` _and_ a problem. An empty allowlist is the one input where
"allow nothing" and "allow everything" are equally plausible readings, and
alpha.5's `network !== false` test read it as everything. The kernel does not
pick; it makes the caller say which it meant.

### 2. `{ hosts: [...] }` means exact hosts, HTTP and HTTPS, ports 80 and 443

Exact-host matching (§21): `registry.npmjs.org` does not permit
`foo.registry.npmjs.org`, `npmjs.org`, or `evilregistry.npmjs.org`. Wildcards are
a later feature with their own design; a policy language that grows a wildcard by
accident is worse than one that has none.

Port scope (§22): the public tool schema names a host and not a port, so _some_
port policy has to be invented. Inventing "all of them" would mean an approval for
`registry.npmjs.org` also approved its SSH port. The enforced scope is exactly the
protocols whose destination identity the proxy can validate — HTTP on 80 and
HTTPS on 443 — and every other port and protocol in scoped mode is denied.
Workflows that genuinely need more use unrestricted mode, with its own approval.

### 3. The enforcement is a private network plus a dual-homed proxy

For allowlist mode the backend creates a per-execution Docker network
`mycoder-egress-<id>` with `--internal`, which has no gateway to the outside. The
workload is attached to that network and to nothing else. A proxy sidecar is
attached to _both_ that network and an egress-capable one.

```
                    external network
                           ▲
                           │
                    ┌──────┴───────┐
                    │ egress proxy │   (dual-homed, trusted, kernel-owned)
                    └──────┬───────┘
                           │
                private internal network
                           │
                    ┌──────┴───────┐
                    │   workload   │   (private interface only)
                    └──────────────┘
```

The workload's `HTTP_PROXY`/`HTTPS_PROXY` point at the sidecar's private address.
Unsetting them does not help: there is no route to anywhere else. That is the
substantive difference from the `HTTP_PROXY`-on-bridge design, and it is why the
raw-socket, `curl --noproxy '*'`, `node net.connect` and `python socket` bypass
tests fail by topology rather than by cooperation.

The sidecar is an **application proxy, not a router**. It gets no `NET_ADMIN`, no
`--privileged`, no host network and no IP forwarding. It also gets no workspace
mount, no credential environment, no user home and no container socket — it is
the one component that can reach the internet, so it is the one component that
must have nothing worth exfiltrating.

### 4. Workload DNS is not an escape hatch

In allowlist mode the workload does not need to resolve external names: the proxy
resolves them. The workload is started with `--dns 127.0.0.1`, so Docker's
embedded resolver has no upstream to forward to and external lookups fail. The
proxy is addressed by IP, discovered by the kernel from `docker inspect` and
passed in the environment; the model never chooses this address.

This is the one dimension where the claim is scoped rather than absolute. Docker's
embedded DNS behaviour differs across engine versions and platforms, so the
release evidence asserts what was _measured_ on the validated platform rather than
asserting a universal property.

### 5. Every IP the proxy connects to is validated, and it connects to that IP

```
resolve hostname → validate the selected address → connect to that address
```

not

```
check the hostname → connect(hostname) → a second, unchecked resolution
```

The second form is the DNS-rebinding hole: the name is checked once and resolved
twice, and the two resolutions need not agree. Retaining the original hostname for
HTTP `Host` and TLS SNI identity is what keeps this from breaking virtual hosting.

Addresses outside global scope are denied by default: IPv4 loopback, RFC1918,
link-local (with `169.254.169.254` classified separately as `metadata`, because
that is the single most important address this check refuses), CGNAT, multicast,
`0.0.0.0/8` and the reserved ranges; IPv6 loopback, ULA, link-local, multicast and
unspecified. `allowPrivateAddresses` exists for the controlled test topology of
§56 and is reachable only from the kernel-side harness — not from configuration
and not from a tool argument.

### 6. HTTPS is enforced by CONNECT authority **and** TLS SNI

CONNECT authority alone is insufficient, and the reason is virtual hosting: a
shared IP hosts many names, so `CONNECT allowed.example:443` followed by a
ClientHello carrying `SNI: denied.example` reaches the denied virtual host through
a tunnel the proxy authorised. So for a domain-based HTTPS target:

```
normalized SNI == normalized CONNECT host == allowed host
```

or the connection is refused before any application payload crosses it.

The proxy does **not** terminate TLS. No custom CA, no MITM, no certificate
injection. It reads the ClientHello — which is plaintext by construction — checks
the name, and then relays bytes it cannot decrypt.

Where the ClientHello has no usable SNI, is malformed, or exceeds the parser's
byte budget, strict domain-enforced mode **fails closed**. The same applies to
Encrypted ClientHello: if ECH prevents destination identity verification, the
answer is "denied / unsupported", never "downgrade quietly while still reporting
strong host enforcement".

### 7. Guarantee-bearing limits fail closed

This is alpha.5's D-006 lesson (§3.1) applied to the network layer. A limit on a
path that carries a guarantee must fail closed when exceeded, never silently
reduce the guarantee:

| limit                  | exceeded →                                        |
| ---------------------- | ------------------------------------------------- |
| request-header bytes   | `NETWORK_PROTOCOL_UNSUPPORTED`, connection closed |
| ClientHello bytes      | denied — **not** "skip the SNI check"             |
| policy host count      | invalid request — **not** "keep the first N"      |
| DNS answer count       | denied — **not** "use the unchecked remainder"    |
| concurrent connections | refused — **not** "stop tracking them"            |

### 8. Approval subjects are host-scoped

`subjectKeyOf` for `network.connect` now includes the normalised host, the scope
(`scoped` vs `unrestricted`) and the port. A session approval for one host cannot
become a general network permission, an `unrestricted` approval is never
interchangeable with a `scoped` one for the same host, and a host that does not
normalise gets a subject that cannot match a normalised one.

### 9. Unrestricted mode stays, and says so

Some workflows need arbitrary networking. Removing that option would make people
run the agent without a container, which is worse. So unrestricted mode keeps a
separate approval, a separate subject, a separate `/status` line and a separate
audit record, and its prompt says "This command may reach the entire internet."

### 10. Fail closed, never fall back

If the network cannot be created, the proxy cannot start, or the proxy fails its
health check, the execution fails with `NETWORK_ENFORCEMENT_SETUP_FAILED`. There
is no code path from "scoped egress setup failed" to "ordinary bridge
networking". This is ADR-0014's §40 rule — a security decision must not degrade
into a warning nobody reads — restated for the network.

### 11. Per-execution lifecycle, no reuse optimisation

One network and one proxy per execution, torn down in `finally`. A shared proxy
would need a mutable policy, which is the property this design most wants to avoid.
Resources are labelled `mycoder.egress=1` so that orphans from a kernel crash can
be garbage-collected by label — never with a broad `docker system prune`, which
would delete resources this kernel does not own.

### 12. Platform claim levels

`networkAllowlist` becomes `container-enforced` **only** on the container backend,
**only** in allowlist mode, and **only** for the HTTP/HTTPS scope described above.
`LocalBackend` and `SSHBackend` keep `best-effort`; they have no equivalent
mechanism, and copying the claim across backends would be the exact overclaim
ADR-0014's enforcement descriptor exists to prevent.

### 13. What remains unenforced

Stated here so that no release note has to be read as implying otherwise:

- generic TCP allowlisting, UDP, QUIC/HTTP-3
- TLS payload inspection or any form of DLP — this ADR governs **where bytes may
  go**, not what approved-destination bytes contain
- protection from exfiltration to a host the user explicitly approved
- TLS ECH (denied, not supported)
- wildcard-domain policy
- private-network allowlisting
- full URL-path allowlisting
- host firewall rules, nftables, Kubernetes network policy, service mesh
- Windows containers
- Docker daemon or kernel zero-day resistance

## Consequences

**A strict allowlist is visibly stricter.** A redirect to a CDN hostname now
fails, and the user has to approve the second host. That friction is the feature —
it is what makes the first approval mean something — but it is friction, and
§68/§70 require it to be measured and written down rather than discovered by
users.

**Setup cost per execution.** Creating a network, starting a sidecar and health
checking it is added latency on every scoped-egress command. §65 requires it to be
measured and reported, and explicitly forbids weakening the topology to improve it
in this milestone.

**The proxy is new trusted code.** It is in-tree, dependency-free, built on Node
built-ins, and reviewed as a security boundary: bounded parsers, no content
logging, no TLS termination. A third-party proxy stack would be a supply-chain
surface in the one process that can reach the internet, which ADR-0009 exists to
avoid.

**`docker` grows a larger surface.** The backend now calls `network create`,
`network connect`, `network rm`, `run -d`, `logs` and `inspect` in addition to
`run`. All of it stays inside `src/execution/`, and the `no-docker-cli-outside-container-backend`
lint rule is extended rather than relaxed.

## Alternatives considered

**`HTTP_PROXY` on an ordinary bridge network.** Rejected: not a boundary. The
workload is untrusted and can ignore it. This is the design the milestone exists
to replace.

**iptables/nftables rules in the workload's namespace.** Would need `NET_ADMIN` in
the workload container, which is a far larger grant than the one being enforced,
and it enforces on IPs rather than names — so it cannot express "this hostname"
at all, and it re-opens rebinding.

**A transparent TCP proxy with TLS MITM.** Would allow generic TCP allowlisting
and payload inspection, at the cost of a custom CA in the workload's trust store
and a proxy that can read every byte of every approved connection. That is a much
larger trusted component for a guarantee this milestone does not claim. Explicitly
a non-goal (§7).

**A shared long-lived proxy per session.** Faster; requires a mutable policy and
cross-execution host-set leakage. Deferred to a later ADR with measured need (§66).

**A third-party proxy image (Squid, tinyproxy, mitmproxy).** Rejected under
ADR-0009. The one process on the internet-facing side of the boundary is the last
place to introduce an unaudited dependency, and none of them enforce SNI/authority
agreement out of the box anyway.
