# alpha.6 evidence matrix

**Date:** 2026-08-15
**Milestone:** `v0.1.0-alpha.6` — scoped subprocess egress enforcement
**Rule:** no PASS without named, executable evidence. For every security row,
no PASS without a **mechanism assertion** and a **paired control** (§81, §3.2).

The third and fourth columns are the ones that distinguish this matrix from a
checklist. §59: _"A failure for the wrong reason is not evidence."_ A row that
only says "the attack failed" would pass equally well on a machine where the
attack path was never live, so each security row records what the mechanism was
observed to be, and what proves the path was real.

---

## Legend

| Column           | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| Primary evidence | the test that asserts the property                            |
| Positive control | the same path, permitted, working                             |
| Contrast control | the same target reachable under a different configuration     |
| Mechanism        | the reason code actually observed, not merely a non-zero exit |

`live` = requires a docker daemon (`pnpm test:container`).
`offline` = runs in the default `pnpm test`.

---

## 1. Network semantics (A6-1)

| Property                          | Primary evidence                                                                                                   | Positive control                    | Contrast                | Mechanism                                       | Status   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------- | ----------------------------------------------- | -------- |
| three modes are distinct          | `egress-proxy.test.ts` "maps the three profile shapes" (offline)                                                   | each mode maps to its own kind      | —                       | `deny-all` / `allowlist` / `unrestricted`       | **PASS** |
| `hosts: []` is refused            | `egress-proxy.test.ts` "refuses an empty host list" (offline)                                                      | a non-empty list yields `allowlist` | —                       | `ok:false`, mode `deny-all`                     | **PASS** |
| over-long list fails closed       | `egress-proxy.test.ts` "refuses an over-long host list" (offline)                                                  | 64 hosts accepted                   | —                       | refusal, not truncation                         | **PASS** |
| one bad host refuses the grant    | `egress-proxy.test.ts` "refuses the whole grant when one host is unusable" (offline)                               | all-good list accepted              | —                       | `ok:false`                                      | **PASS** |
| host set is a value, not an order | `egress-proxy.test.ts` "normalises, de-duplicates and sorts" (offline)                                             | —                                   | —                       | sorted, de-duplicated                           | **PASS** |
| exact-host matching               | `egress-proxy.test.ts` "denies every near-miss" (offline) + live "denies every near-miss of the approved hostname" | approved host succeeds              | unrestricted reaches it | `host-not-allowed`                              | **PASS** |
| port scope is 80/443              | live "denies CONNECT to an approved host on a port outside the scope"                                              | 443 CONNECT succeeds                | —                       | `port-not-allowed` (**not** `host-not-allowed`) | **PASS** |

## 2. Normalisation and address policy (A6-1, A6-3)

| Property                                | Primary evidence                                                                                                 | Positive control                              | Contrast                                           | Mechanism                                          | Status   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- | -------- |
| one normaliser everywhere               | `egress-host.test.ts` (20 cases, offline)                                                                        | canonical forms accepted                      | —                                                  | identical output for all spellings of one name     | **PASS** |
| IDNA → ASCII                            | `egress-host.test.ts` "converts an internationalised name"                                                       | `münchen.example` → `xn--mnchen-3ya.example`  | asserted **≠** `munchen.example`                   | punycode via platform UTS-46                       | **PASS** |
| alternate IPv4 spellings refused        | `egress-host.test.ts` "refuses the alternate IPv4 spellings"                                                     | dotted quad accepted                          | —                                                  | rejection, incl. `0x7f.0.0.1` (found by this test) | **PASS** |
| IPv4-mapped IPv6 folds                  | `egress-host.test.ts` "classifies the IPv4-mapped form"                                                          | global v6 allowed                             | —                                                  | `::ffff:169.254.169.254` → `metadata`              | **PASS** |
| private/loopback/metadata denied        | `egress-proxy.test.ts` "denies an approved host that resolves into private space"                                | global address allowed                        | `allowPrivateAddresses` permits the _same_ address | `address-not-global` + scope                       | **PASS** |
| DNS rebinding blocked live              | live "denies an approved host that resolves into private space when §23 is on"                                   | the same host/proxy with the flag on succeeds | strict and permissive backends compared directly   | `address-not-global`, scope `private`              | **PASS** |
| resolve-then-connect (no second lookup) | `proxy.ts` `resolveAndCheck` returns the literal to dial; `egress-proxy.test.ts` "picks the first global answer" | mixed answers → global one used               | —                                                  | dial target == checked target                      | **PASS** |
| resolver answer budget                  | `DEFAULT_PROXY_LIMITS.maxDnsAnswers`, `defaultResolve` throws above it                                           | —                                             | —                                                  | `resolution-failed`, never partial use             | **PASS** |

## 3. Topology (A6-2)

| Property                             | Primary evidence                                                           | Positive control                                          | Contrast                                                                  | Mechanism                                       | Status   |
| ------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- | -------- |
| private per-execution network        | live "plans a private network with the proxy as the only exit"             | plan names `mycoder-egress-*`                             | asserted **≠** `bridge`                                                   | `--internal` network in the plan                | **PASS** |
| no direct external route             | live "cannot bypass the proxy with curl --noproxy"                         | approved request via proxy works                          | **unrestricted mode reaches the same target**                             | connection refused by topology, no proxy record | **PASS** |
| raw socket blocked                   | live "cannot bypass the proxy with a raw Node socket"                      | —                                                         | **live "CONTRAST: the same raw socket connects under unrestricted mode"** | `RAW-BLOCKED`/`RAW-TIMEOUT`                     | **PASS** |
| python socket blocked                | live "cannot bypass the proxy with a raw Python socket"                    | —                                                         | same contrast row                                                         | `PY-BLOCKED`                                    | **PASS** |
| unsetting proxy vars changes nothing | live "unsetting the proxy variables changes nothing"                       | —                                                         | unrestricted contrast                                                     | non-zero exit, no marker                        | **PASS** |
| no external DNS in the workload      | live "has no external DNS inside the workload"                             | proxy resolves on the far side (steps 1–3 of the dogfood) | —                                                                         | `DNS-BLOCKED`                                   | **PASS** |
| setup failure blocks the workload    | live "fails closed rather than falling back"                               | valid grants run                                          | —                                                                         | `NETWORK_ENFORCEMENT_SETUP_FAILED`              | **PASS** |
| no bridge fallback exists in source  | `pnpm lint` rule `no-scoped-egress-bridge-fallback` + 4 self-test fixtures | must-pass fixtures                                        | —                                                                         | static, plus `validateNetworkPlan` at runtime   | **PASS** |

## 4. Proxy hardening (A6-3)

| Property                                                        | Primary evidence                                                                                                                      | Status   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| no workspace mount                                              | `pnpm lint` `no-egress-proxy-workspace-mount` (+ fixtures); sidecar argv mounts only `egress/`, `egress-proxy/`, `policy.json`        | **PASS** |
| no secret env / no broker                                       | `pnpm lint` `no-egress-proxy-secret-env` (+ fixtures)                                                                                 | **PASS** |
| no docker socket, cap-drop, no-new-privileges, read-only rootfs | `egress-sidecar.ts` argv; `no-container-escape-flags` lint                                                                            | **PASS** |
| bounded proxy memory/PIDs                                       | `PROXY_MEMORY_BYTES` 256 MiB, `PROXY_PIDS` 64 in the sidecar argv                                                                     | **PASS** |
| policy is kernel-owned and re-validated                         | `parseProxyPolicy` on the sidecar side; `egress-proxy.test.ts` "rejects a policy document naming a port outside the enforced scope"   | **PASS** |
| logs are content-free                                           | `egress-proxy.test.ts` "never records a path, a query or a header" — asserts a planted token/path/credential is absent from the audit | **PASS** |
| content-logging is statically refused                           | `pnpm lint` `no-egress-content-logging` (+ must-pass fixture for legitimate forwarding)                                               | **PASS** |

## 5. HTTP enforcement (A6-3)

| Property                               | Primary evidence                                                                                    | Positive control           | Mechanism                             | Status   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------- | -------- |
| absolute-form required                 | `egress-proxy.test.ts` "refuses origin-form"                                                        | absolute form parses       | destination cannot come from a header | **PASS** |
| authority/Host agreement               | live "refuses a Host header that disagrees"                                                         | matching pair succeeds     | `authority-mismatch`                  | **PASS** |
| mismatch refused **both ways**         | `egress-proxy.test.ts` "refuses a mismatch in both directions"                                      | —                          | never prefers a field                 | **PASS** |
| userinfo / backslash refused           | `egress-proxy.test.ts` "refuses userinfo and backslashes"                                           | —                          | parse rejection                       | **PASS** |
| smuggling primitives refused           | `egress-proxy.test.ts` "rejects header smuggling primitives", "rejects conflicting framing headers" | well-formed requests pass  | 400                                   | **PASS** |
| header budget fails closed             | `egress-proxy.test.ts` "refuses more headers than the budget"                                       | under-budget passes        | 431, not truncation                   | **PASS** |
| hop-by-hop + proxy credential stripped | `egress-proxy.test.ts` "strips hop-by-hop headers"                                                  | `Accept` survives verbatim | `Proxy-Authorization` absent          | **PASS** |

## 6. HTTPS identity (A6-4)

| Property                         | Primary evidence                                                                                                                                 | Positive control                                                                       | Contrast                                                               | Mechanism                           | Status   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------- | -------- |
| real ClientHello parsed          | `egress-tls.test.ts` "extracts the server name from a ClientHello a real TLS client produced" — fixture generated by Node's own TLS stack (§88)  | —                                                                                      | fragmented delivery reassembles                                        | `sni` + name                        | **PASS** |
| **SNI mismatch denied**          | live "refuses a CONNECT tunnel whose TLS SNI names another host"                                                                                 | **live "CONTRAST: the same tunnel with a matching SNI completes"** (`TLS-ESTABLISHED`) | certificate covers _both_ names, so only the proxy can tell them apart | `sni-mismatch`                      | **PASS** |
| missing SNI fails closed         | `egress-proxy.test.ts` "fails closed on every unverifiable ClientHello"; live "refuses a CONNECT tunnel carrying no TLS at all"                  | matching case succeeds                                                                 | —                                                                      | `sni-missing` / `sni-malformed`     | **PASS** |
| malformed ClientHello denied     | `egress-tls.test.ts` — 9 malformed fixtures                                                                                                      | hand-built valid hello parses                                                          | —                                                                      | `malformed`, never "skip the check" | **PASS** |
| **oversized ClientHello denied** | `egress-tls.test.ts` "denies rather than skips when the hello exceeds the parser budget"                                                         | under-budget hello parses                                                              | —                                                                      | `too-large` → `sni-too-large`       | **PASS** |
| duplicate server_name refused    | `egress-tls.test.ts` "rejects two server_name extensions rather than choosing one"                                                               | single name accepted                                                                   | —                                                                      | `malformed`                         | **PASS** |
| ECH denied, not downgraded       | `egress-tls.test.ts` "reports Encrypted Client Hello"; `egress-proxy.test.ts` ECH case                                                           | non-ECH hello allowed                                                                  | —                                                                      | `sni-encrypted`                     | **PASS** |
| no TLS termination / no CA       | no certificate, key or CA anywhere in `src/security/egress-proxy/`; live HTTPS uses `-k` against a self-signed fixture the proxy never validates | —                                                                                      | —                                                                      | proxy relays opaque bytes           | **PASS** |

## 7. Approval, audit, composition (A6-1, A6-8)

| Property                                             | Primary evidence                                                                                                                           | Status   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| approval subject includes host, port, scope, channel | `egress-composition.test.ts` "gives every distinct destination a distinct subject"                                                         | **PASS** |
| host spellings share one subject                     | `egress-composition.test.ts` "treats spellings of one host as one subject"                                                                 | **PASS** |
| unnormalisable host cannot share a subject           | `egress-composition.test.ts` "never lets an unnormalisable host share a subject"                                                           | **PASS** |
| unrestricted prompt is unmistakable                  | `egress-composition.test.ts` "describes unrestricted network in words that cannot be mistaken" — asserts "entire internet"                 | **PASS** |
| child cannot widen the host set                      | `egress-composition.test.ts` algebra (7 cases) **and** policy-engine layer test "a child layer cannot add a host the parent lacks"         | **PASS** |
| child cannot upgrade scoped → unrestricted           | `egress-composition.test.ts` "refuses to let a child upgrade a scoped session to unrestricted"                                             | **PASS** |
| skill can narrow, cannot add                         | `egress-composition.test.ts` "a child layer can remove a host the parent had"; `skills.ts` refuses a `network:` key                        | **PASS** |
| empty intersection is deny-all                       | `egress-composition.test.ts` "collapses an empty intersection to deny-all"                                                                 | **PASS** |
| Local/SSH keep `best-effort`                         | `container-plan.test.ts` "a backend without the mechanism still gets the old, honest sentence" — negative control for the enforced wording | **PASS** |

## 8. Lifecycle (A6-5)

| Property                           | Primary evidence                                                                                                                 | Status   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| workload waits for proxy readiness | `waitForReady` gates workload start; a proxy that exits is detected immediately rather than timing out                           | **PASS** |
| cleanup after every execution      | live "removes the network and the proxy when the execution finishes" — asserts zero networks and zero labelled containers remain | **PASS** |
| cleanup after failure              | `EgressSidecar.start` tears down partial topology before throwing                                                                | **PASS** |
| orphan collection is stale-only    | fixed under **D-A6-1**; timestamp label + 15-minute threshold; unparseable timestamp treated as live                             | **PASS** |
| never `docker system prune`        | label-filtered `ps`/`network ls` only; asserted by reading `collectOrphanedEgressResources`                                      | **PASS** |

## 9. Resource evidence (A6-7)

| Property                               | Primary evidence                                                                                                                                                                              | Status   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| PID limit bounds a fork bomb           | live "bounds a fork bomb at the PID limit" — asserts the kernel's refusal (`Cannot fork`) and that 400 processes were **not** created                                                         | **PASS** |
| **memory limit terminates at runtime** | live "terminates a process that allocates past the memory limit" — 1 GiB attempted under 96 MiB; asserts `chunk0` ran (so the process was real) and `ALLOCATED-ALL` never printed. Closes §62 | **PASS** |
| **CPU quota observed in cgroup**       | live "reports the CPU quota the plan asked for" — reads `cpu.max`, asserts `quota/period == 1.5` exactly. Closes §63                                                                          | **PASS** |
| memory limit observed in cgroup        | live "reports the memory limit in the container cgroup" — exact byte match                                                                                                                    | **PASS** |
| resource kill classified correctly     | live "classifies a resource kill as a resource error" — 137 → `CONTAINER_RESOURCE_LIMIT`                                                                                                      | **PASS** |

**§62 explicitly forbids argv-only evidence, and none of these rows use it.**

## 10. Real-network dogfood (A6-9)

See `docs/alpha6-egress-dogfood.md`.

| Property                                | Result                                                                               | Status   |
| --------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| real package install over scoped egress | `npm install --no-save is-number@7.0.0` → added 1 package in 8s                      | **PASS** |
| real Git HTTPS over scoped egress       | `git ls-remote https://github.com/nodejs/node.git` → exit 0                          | **PASS** |
| second host denied before expansion     | `curl https://github.com/` → `CONNECT tunnel failed, response 403`                   | **PASS** |
| expanded approval then succeeds         | same request, two approved hosts → `status=200`                                      | **PASS** |
| unknown canary to a denied host         | 403 at CONNECT; body never written                                                   | **PASS** |
| metadata endpoint denied                | `169.254.169.254` → 403                                                              | **PASS** |
| setup latency measured                  | median 253 ms, range 215–456 ms                                                      | **PASS** |
| defects found and fixed                 | D-A6-1, D-A6-2, D-A6-3 fixed with regressions; D-A6-4 recorded, not an egress defect | **PASS** |

## 11. Gate results

| Gate                  | Result                                                       |
| --------------------- | ------------------------------------------------------------ |
| `pnpm test` (offline) | **855 tests · 784 pass · 0 fail · 71 skip**                  |
| `pnpm test:container` | **195 tests · 195 pass · 0 fail** (4 consecutive clean runs) |
| `pnpm lint`           | **16 rules · no violations** (4 new in alpha.6)              |
| `pnpm lint:selftest`  | **133 tests · 133 pass · 0 fail**                            |
| `pnpm typecheck`      | clean                                                        |

Baseline was 737 tests · 666 pass · 71 skip; alpha.6 adds 118 tests and no skips.

**Native Linux — the release-evidence tier (§37, §74).** Ubuntu 26.04 LTS
aarch64, `docker.io` 29.1.3, kernel `7.0.0-29-generic`, Node v22.20.0;
`probeContainerRuntime` reports `nativeLinux: true`.

| Gate (`KERNEL_CONTAINER_REQUIRED=1`) | Result                                                     |
| ------------------------------------ | ---------------------------------------------------------- |
| offline suite                        | **855 · 784 pass · 0 fail · 71 skip** — identical to macOS |
| container + egress tier              | **195 · 195 pass · 0 fail**, 6 consecutive runs            |
| egress + resource suites alone       | **30 · 30 pass · 0 fail**                                  |
| architecture lint / self-tests       | 16 rules clean · 133/133                                   |
| scoped-egress setup latency          | median 272 ms, range 266–297 ms                            |
| real-network dogfood                 | repeated, outcomes identical to macOS                      |

Every live row in sections 1–10 was re-executed on this tier and produced the
same result, so no row above depends on a VM-backed daemon.

## 12. NOT ESTABLISHED

Rows deliberately absent above, so that nothing here is read as covering them.

**Given a status column by alpha.11 §7.2.** This table was two columns wide and
therefore invisible to the evidence gate, which reads tables by their `Status`
header. Two of its entries — Windows container enforcement, and the real-internet
path under the strict policy — are open claims that `docs/open-evidence.md` names
as living _here_, in rows the gate could not see. The last row said "billing-grade
cost, direct-OpenAI attribution", which is two claims against two different
index entries, so it is now two rows.

| Claim                                                       | Status         | Evidence | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| real-internet path under the **strict** address policy      | NOT APPLICABLE |          | **The one gap the native-Linux run did not close, and it widened.** _Downgraded from `NOT TESTED` to `NOT APPLICABLE` on 2026-08-16, after a fourth restatement was declined; see ADR-0017 and `docs/alpha10-evidence-matrix.md` §CLOSURE C. `NOT TESTED` implies "we will get to it", and after three milestones that implication was false._ Both available machines sit behind the same resolver, which maps public hostnames into `198.18.0.0/15` (D-A6-2) — it is the network, not the daemon. Every real-network result on both platforms therefore used `allowBenchmarkRange`. The strict check is fully covered by the controlled §56 topology _with paired controls_; what has not been executed anywhere is "an approved public host resolves to a genuinely global address and is reached". Needs a machine on an unfiltered resolver. [open:A7] |
| `allowBenchmarkRange` reachable from configuration          | NOT APPLICABLE |          | Backend API only; not in the TOML schema. Recorded as a follow-up in the dogfood. [scope]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Windows container enforcement                               | NOT TESTED     |          | Not run, not claimed (§73). Needs a Windows machine. [open:A6]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| generic TCP / UDP / QUIC allowlisting                       | NOT APPLICABLE |          | Out of scope by §7. [scope]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| payload inspection / DLP / exfiltration to an approved host | NOT APPLICABLE |          | Out of scope by §42, and the controlled suite asserts the limit deliberately. [scope]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TLS ECH support                                             | NOT APPLICABLE |          | Denied, not supported (§30). [scope]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| wildcard-domain policy                                      | NOT APPLICABLE |          | Not implemented (§21). [scope]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| private-network allowlisting                                | NOT APPLICABLE |          | Test-only flag; not a user capability (§23). [scope]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Local / SSH host enforcement                                | NOT APPLICABLE |          | Unchanged `best-effort`, with a negative-control test that keeps it that way. [scope]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| billing-grade delegated cost                                | NOT TESTED     |          | Parked (§71). Needs a vendor invoice or per-alias published pricing. [open:A5]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| direct-OpenAI cost attribution                              | NOT TESTED     |          | Parked (§72). The relay's hidden prompt makes attribution unsound, and the direct account has no credit. [open:A4]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## Model provenance

**Added by alpha.11 §7.** This matrix was not registered in the evidence gate
until alpha.11, so it never had to answer alpha.8 §19's question. The answer is:
**this matrix makes no live-model behavioural claims.** Every row is a network,
topology or resource enforcement property measured against the kernel, the proxy
and a Docker daemon — host allowlisting, address classification, DNS rebinding,
port scope, cgroup limits. None of them involves a model deciding anything.

The alpha.6 dogfood (`docs/alpha6-egress-dogfood.md`) is a separate document and
is single-model by construction; nothing here depends on it.
