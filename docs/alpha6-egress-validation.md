# alpha.6 scoped-egress validation

**Date:** 2026-08-15
**Scope:** what was built, how it was tested, and precisely what it does and does
not enforce.
**Normative design:** `docs/adr/ADR-0015-scoped-subprocess-egress.md`.

---

## 1. Platform under test

```
host        macOS 25.5.0, darwin/arm64
docker      client & server 29.7.2
daemon      Docker Desktop, kernel 6.12.76-linuxkit  → NOT native Linux
image       node:22-bookworm, Node v22.23.2
image tools curl, python3, git, openssl present; nc absent
```

Every live result in this document was produced on a **VM-backed daemon**. §37
and §38 are unambiguous that this is not equivalent to native Linux, and the
release-evidence tier for the alpha.6 claim is native-Linux CI on the exact
tagged commit. Nothing here should be read as native-Linux evidence.

## 2. Network topology

```
                      external network
                             ▲
                             │  (docker bridge — the only egress leg)
                    ┌────────┴─────────┐
                    │  egress proxy     │  mycoder-egress-proxy-<id>
                    │  node, in-tree    │  read-only rootfs, cap-drop=ALL,
                    │  port 3128        │  no-new-privileges, 256 MiB, 64 PIDs
                    └────────┬─────────┘  no workspace, no home, no secrets
                             │
              mycoder-egress-<id>   (docker network create --internal)
                             │
                    ┌────────┴─────────┐
                    │    workload       │  --dns 127.0.0.1
                    │                   │  HTTP(S)_PROXY → proxy's private IP
                    └───────────────────┘  no other interface, no route out
```

Verified directly (`docker network create --internal`, spike and live suite):

| From the workload                               | Result                       |
| ----------------------------------------------- | ---------------------------- |
| `getent hosts registry.npmjs.org`               | **fails** — no external DNS  |
| raw TCP to a public address                     | **fails** — no route         |
| raw TCP to a fixture container's bridge address | **fails** — no route         |
| TCP to the proxy's private address:3128         | **succeeds** — the only path |

The proxy is the only dual-homed component. It is an application proxy: no
`NET_ADMIN`, no `--privileged`, no host network, no IP forwarding.

## 3. Proxy identity and provenance

```
source      src/security/egress-proxy/{main,proxy,http,tls,decide}.ts
            src/security/egress/{host,network-mode}.ts
runtime     node --experimental-strip-types, inside the same trusted image
deps        none — node:net, node:dns, node:fs only (ADR-0009)
mounted     the two source directories + policy.json, all read-only
policy      written by the kernel at mode 0444, re-validated by the sidecar
            with parseProxyPolicy before the listener opens
readiness   one line on stdout; the workload does not start until it appears
audit       one JSON record per line on the same stdout, collected by docker logs
```

The source directory is resolved from the module's own location, not from
`process.cwd()` or configuration, so the proxy that runs is always the one that
was reviewed alongside the policy it enforces.

## 4. Protocol scope

| Protocol      | Port | Enforced how                                                     |
| ------------- | ---- | ---------------------------------------------------------------- |
| HTTP          | 80   | absolute-form target + `Host` agreement + resolved-address check |
| HTTPS         | 443  | CONNECT authority + resolved-address check + TLS SNI agreement   |
| anything else | any  | **denied** — `port-not-allowed` / `protocol-not-allowed`         |

There is no transparent TCP mode and no fallback. `CONNECT allowed.example:22`
is refused even though the host is approved.

## 5. Normalisation semantics

One function, `normalizeHost`, used by the policy builder, the approval subject,
the HTTP path, the CONNECT path and the SNI check. Verified over 20 cases.

```
lower-cased                   REGISTRY.NPMJS.ORG → registry.npmjs.org
single terminal dot stripped  registry.npmjs.org. → registry.npmjs.org
IDNA → ASCII                  münchen.example → xn--mnchen-3ya.example
IPv6 canonicalised            [2001:DB8:0:0:0:0:0:1] → 2001:db8::1
IPv4-mapped folded            ::ffff:127.0.0.1 → 127.0.0.1

rejected: userinfo, scheme, path, query, fragment, backslash, control chars,
          whitespace, empty labels, >63-char labels, >253-char names,
          leading/trailing hyphens, wildcards, host:port in a host position,
          IPv6 zone identifiers, and every alternate IPv4 spelling
          (0177.0.0.1, 2130706433, 127.1, 0x7f.0.0.1)
```

The last group matters: `getaddrinfo` reads all four as `127.0.0.1`. Accepting
them would let a policy string and a connected address name different things.
`0x7f.0.0.1` in particular was accepted as a _domain_ by the first
implementation and was caught by the unit test.

## 6. Address policy

Default: only globally-routable addresses. Denied by scope:

```
IPv4   loopback, RFC1918, link-local, metadata (169.254.169.254), CGNAT,
       0.0.0.0/8, multicast, 240/4, TEST-NET-1/2/3, benchmarking (198.18/15)
IPv6   unspecified, loopback, ULA, link-local, multicast, ::/8,
       metadata (fd00:ec2::254), 2001:db8::/32, NAT64, discard-only
```

`metadata` is a scope of its own rather than part of `link-local`, so the audit
line for the single most important denial says what it stopped.

Two documented, off-by-default exceptions:

| Flag                    | Purpose                                                                    | Reachable from                                    |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| `allowPrivateAddresses` | the controlled §56 test topology                                           | kernel-side harness only                          |
| `allowBenchmarkRange`   | deployments whose resolver NATs public names into `198.18.0.0/15` (D-A6-2) | backend API only — **not yet in the TOML schema** |

Neither is reachable from configuration or from a tool argument, and both are
recorded in the frozen policy the proxy re-validates.

### Rebinding

```
resolve hostname → classify the selected address → connect to *that address*
```

There is no second resolution between the check and the connection. Verified
live: an approved host whose name resolves to `127.0.0.1` is denied
`address-not-global` with scope `loopback`, and the fixture origin records zero
hits. A name with mixed answers uses the first global one, so a private address
in a legitimate CDN answer does not take the whole name down.

## 7. HTTPS identity semantics

```
CONNECT allowed.example:443
  → authority normalised and checked against the policy
  → resolved, address classified            ← before the 200 (D-A6-3)
  → 200 Connection Established
  → ClientHello read, bounded at 16 KiB
  → SNI normalised
  → SNI == CONNECT authority == approved host, or DENY
  → connect to the validated address, relay opaque bytes
```

Fail-closed outcomes, all four of them denials rather than skipped checks:

| ClientHello                                                     | Verdict                                          |
| --------------------------------------------------------------- | ------------------------------------------------ |
| SNI ≠ authority                                                 | `sni-mismatch`                                   |
| no SNI (domain target)                                          | `sni-missing`                                    |
| malformed / not TLS / not a ClientHello / duplicate server_name | `sni-malformed`                                  |
| larger than 16 KiB                                              | `sni-too-large`                                  |
| Encrypted ClientHello                                           | `sni-encrypted` — denied, never downgraded (§30) |

The proxy does not terminate TLS. There is no certificate, key or CA in the
kernel. The live positive control establishes a real TLS session through the
tunnel; the mismatch case uses a fixture certificate covering **both** names, so
the only thing that can distinguish them is the proxy.

## 8. Attack matrix

All live, all on the controlled §56 topology, all asserting a reason code.

| #   | Attack                                                        | Result                | Mechanism                                      |
| --- | ------------------------------------------------------------- | --------------------- | ---------------------------------------------- |
| 1   | request a host that was not approved                          | denied                | `host-not-allowed` (403 + reason in body)      |
| 2   | request a near-miss (`sub.allowed.test`, `allowed.test.evil`) | denied                | `host-not-allowed`                             |
| 3   | `curl --noproxy '*'` direct to the denied target's IP         | denied                | no route — never reached the proxy             |
| 4   | raw Node socket to the denied target                          | denied                | no route                                       |
| 5   | raw Python socket to the denied target                        | denied                | no route                                       |
| 6   | `unset HTTP_PROXY …` then connect directly                    | denied                | no route                                       |
| 7   | resolve an external name inside the workload                  | denied                | no upstream resolver                           |
| 8   | `Host:` header disagreeing with the absolute target           | denied                | `authority-mismatch`, origin saw 0 hits        |
| 9   | `CONNECT allowed.test:443` then `SNI: denied.test`            | denied                | `sni-mismatch`                                 |
| 10  | CONNECT tunnel carrying plaintext HTTP                        | denied                | `sni-malformed` / `sni-missing`                |
| 11  | `CONNECT allowed.test:22`                                     | denied                | `port-not-allowed`                             |
| 12  | approved host resolving to a private address                  | denied                | `address-not-global`, scope `private`          |
| 13  | redirect / second host discovered mid-workflow                | denied until approved | `host-not-allowed`                             |
| 14  | POST an unknown canary to a denied host                       | denied                | `host-not-allowed`; target's receive log empty |
| 15  | `hosts: []` (ambiguous grant)                                 | execution refused     | `NETWORK_ENFORCEMENT_SETUP_FAILED`             |

## 9. Reverse controls (§58)

Every row above is paired. The controls are what make the matrix evidence rather
than a list of things that did not happen.

| Property      | Positive control                                                          | Contrast                                                                     |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| allowlist     | approved host returns the fixture's marker                                | **unrestricted mode reaches the denied target** — proving the target is live |
| direct bypass | the proxy path works in the same session                                  | **the same raw socket connects under unrestricted mode**                     |
| SNI           | **a matching SNI completes a real TLS handshake** through the same tunnel | one certificate covers both names, so only the proxy can distinguish them    |
| private IP    | the same host/address pair succeeds with `allowPrivateAddresses`          | strict and permissive backends compared directly, same topology              |
| redirect      | the first host succeeds in the same command                               | the second succeeds once approved (dogfood step 5)                           |
| canary        | **the same canary reaches an approved destination**                       | asserts §42's limit rather than over-claiming                                |
| TLS parser    | real ClientHello from Node's TLS stack parses                             | 9 malformed fixtures denied; oversized denied, not skipped                   |

The canary row is worth restating. The suite asserts that an approved host _does_
receive the canary. That is a deliberate negative result: it keeps the release
claim from drifting into "the container cannot exfiltrate".

## 10. Guarantee-bearing limits (§60, §61)

| Limit                      | Value  | On exceeding                            |
| -------------------------- | ------ | --------------------------------------- |
| policy hosts               | 64     | grant refused — not "first 64"          |
| request head               | 32 KiB | 431, connection closed                  |
| request line / header line | 8 KiB  | 414 / 431                               |
| header count               | 100    | 431                                     |
| ClientHello                | 16 KiB | **denied** — not "skip SNI"             |
| TLS extensions             | 128    | `malformed`                             |
| DNS answers                | 16     | `resolution-failed` — never partial use |
| concurrent connections     | 64     | 503 — not "stop tracking"               |
| head / connect timeout     | 15 s   | denial                                  |
| idle timeout               | 120 s  | teardown                                |

Each of these was written as a refusal, and the two that a shortcut would be most
tempting on — the ClientHello budget and the policy host count — have explicit
tests asserting the refusal rather than a truncation.

## 11. Performance (§65)

Per-execution topology setup, from the live suite (n=19) and the dogfood (n=7):

```
live suite   median 225 ms, range 189–464 ms
dogfood      median 253 ms, range 215–456 ms

breakdown    network create → proxy start → attach → readiness → inspect
```

Paid once per execution. ~3% of an 8.7 s npm install; ~35% of a 0.7 s denied
request. No topology change was made to improve it: §65 forbids weakening the
design for performance in this milestone, and §66 defers the shared-proxy
optimisation until there is measured need.

## 12. Limitations

Stated here so that section 8 cannot be read as covering them.

1. **Not native-Linux evidence.** Docker Desktop on macOS. The release tier is CI.
2. **Docker daemon trust.** The boundary is the container runtime's. A daemon or
   kernel vulnerability is out of scope, as it was in alpha.5.
3. **Destinations, not payloads.** An approved host can be sent anything. HTTPS
   bodies are opaque after the SNI check by design (§42).
4. **HTTP/HTTPS only.** No TCP, UDP, QUIC, HTTP/3, SSH-over-proxy.
5. **Exact hosts only.** No wildcards, no URL-path scoping.
6. **ECH is denied, not supported.**
7. **DNS claim is scoped.** `--dns 127.0.0.1` was verified to block external
   resolution on _this_ daemon. Docker's embedded-resolver behaviour varies by
   engine version and platform; the claim is what was measured, not a universal.
8. **`allowBenchmarkRange` is a real weakening** of the address check for one /15
   when enabled, and it is not yet exposed in configuration.
9. **Windows containers: NOT TESTED.**
10. **The proxy is new trusted code.** In-tree, dependency-free and bounded, but
    it is the one process with a route to the internet, and it is a first
    release.
