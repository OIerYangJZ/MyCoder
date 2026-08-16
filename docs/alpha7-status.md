# alpha.7 status — native Linux sandbox & operational closure

**Baseline:** `f3826cb` (alpha.6, `alpha6-scoped-egress`, unmerged and untagged)
**Branch:** `alpha7-tool-surface` — carries the tool round, the measurement round
and this milestone; **uncommitted at the user's instruction**
**Evidence host:** Ubuntu 26.04 aarch64 · kernel 7.0.0-29-generic · Landlock ABI 8 ·
`kernel.yama.ptrace_scope = 1` · reachable as `linux-vm`

Gates at the time of writing:

| Gate                             | Result                                      |
| -------------------------------- | ------------------------------------------- |
| offline suite, macOS             | 961 tests · 868 pass · 0 fail · 93 skip     |
| **offline suite, evidence host** | **961 tests · 868 pass · 0 fail · 93 skip** |
| native sandbox (live)            | 20/20                                       |
| native composition (live)        | 3/3                                         |
| cross-backend conformance        | 35/35 (local + linux-native)                |
| lint / self-tests                | 16 rules · 133/133                          |
| evidence gate                    | green — 42 alpha.7 rows                     |

## Done

| Pillar                                            | State                                                            | Evidence                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ADR (§7)                                          | done, numbered **0018** — 0016/0017 were taken by the tool round | `docs/adr/ADR-0018-native-linux-sandbox-backend.md`                                                     |
| Native launcher + probe (§10–§13)                 | done, ABI measured at runtime                                    | `native/mycoder-sandbox.c`, `pnpm build:sandbox`                                                        |
| Landlock rule compiler (§14–§19)                  | done, refuses what it cannot express                             | `src/execution/linux-native/plan.ts`                                                                    |
| Backend identity, no downgrade (§8, §9)           | done                                                             | `--backend linux-native`, `SANDBOX_UNSUPPORTED`                                                         |
| FD hygiene + paired control (§20, §21)            | done                                                             | `test:NEGATIVE CONTROL: without hygiene, a pre-opened fd bypasses every path rule`                      |
| `/proc` + same-uid attacks (§22, §23)             | done — decided the architecture                                  | `test:another process environ is unreachable, and the control shows it would not be`                    |
| seccomp (§24, §25)                                | done, attributable by errno                                      | `test:ptrace and process_vm_readv are denied by our filter, not by the host sysctl`                     |
| Native network deny (§27, §28)                    | done, TCP-only and says so                                       | `test:a host-scoped allowlist is refused, not silently unenforced`                                      |
| Cancellation / process tree (§31)                 | done                                                             | `test:a timeout kills the whole process tree, not just the leader`                                      |
| **Closure C** — execution diagnosis (§46–§54)     | done                                                             | `src/execution/diagnosis.ts`, `tests/unit/diagnosis.test.ts` (19 cases)                                 |
| §24 privileged exec                               | done, with the control                                           | `test:no_new_privs is set, so a setuid exec cannot gain privilege`                                      |
| §38 unknown canary                                | done — the boundary holds by path, not by redaction              | `test:a secret the kernel has never been told about is still unreachable`                               |
| **Closure B** — `allow_benchmark_range` (§42–§45) | done                                                             | `test:a session with the opt-in on says so at startup`, `test:a project config cannot turn it on (§43)` |

## Open

| Item                                           | What is left                                                   |
| ---------------------------------------------- | -------------------------------------------------------------- |
| §33–§36 conformance and composition            | the suite and Subagent/Skill/Hook run on `linux-native`        |
| §55–§64 dogfood, evidence matrix, release gate | one native dogfood with the container contrast                 |
| **Closure A**                                  | see below — blocked on infrastructure, recorded as a non-claim |

## Explicit non-claim: strict public-address egress on a clean resolver (§39–§41, §64)

**alpha.7 makes no claim that the strict public-address egress policy has been
exercised end to end against genuinely global addresses.**

Why, precisely. Both available hosts sit behind a fake-IP proxy on the developer's
Mac, which intercepts DNS transparently: every public name resolves into RFC 2544
benchmarking space, and the VM is NAT'd through the same stack. Measured:

```
api.github.com      → 198.18.0.196
docs.python.org     → 198.18.2.236
registry.npmjs.org  → 198.18.1.160
# and, decisively, querying the public resolvers directly:
dig @1.1.1.1 api.github.com → 198.18.0.196
dig @8.8.8.8 api.github.com → 198.18.0.196
```

Connectivity itself is fine — `curl https://api.github.com` returns 200, connected
to 198.18.0.196, which the proxy NATs onward. What cannot be produced here is the
**positive control**: an approved host whose _resolved address_ is global, reached
under the strict §23 default with `allow_benchmark_range = false`. Every such
attempt on these hosts is denied for the right reason and therefore proves
nothing about the permitted path.

What was tried and rejected:

- **Pointing the VM at 1.1.1.1/8.8.8.8** — measured above; the interception is
  transparent, so the answer is unchanged.
- **Bridged networking** — attempted; the VM got no DHCP lease (bridging over
  Wi-Fi, where APs commonly drop frames from a second MAC). Reverted to NAT.
- **Host-only networking** — would remove internet access entirely, which deletes
  the positive control rather than fixing it.
- **Disabling the proxy for the run** — not available to this developer.

What would close it: any Linux host with Docker and Node on an ordinary network —
a cloud instance for an hour is enough, and is preferable to a borrowed machine
because the artifact can name the image, region and kernel for reproduction. The
run is `pnpm test:egress:live` plus the §39–§41 reverse-control matrix, roughly
half an hour including the image pull.

Until then, the honest statement is the one at the top of this section. The
benchmark-range relaxation (**Closure B**) is _not_ affected: it is configured,
merged trusted-layer-only and tested — `test:benchmarking space is refused by
default, and the message says how to opt in`, `test:the opt-in permits it, and
only it`.
