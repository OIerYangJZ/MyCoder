# Configuration audit — what can weaken a boundary

**alpha.8 §12.** Every configuration key, audited against one rule:

> A key that weakens a boundary must be user-layer only, be disclosed at startup,
> be visible in `/status`, and say what remains denied.

`[egress] allow_benchmark_range` (alpha.7) is the reference implementation. §12
asks for every existing key measured against it and the result **recorded as
evidence, not as a claim** — so the table below is generated from
`src/config/weakening.ts`, which is also what drives the startup disclosures and
what `tests/unit/config-weakening.test.ts` asserts against `mergeConfig` itself.
A row here that were merely prose could go stale; this one fails the build.

## The finding

Almost nothing in this configuration surface can weaken anything, and that is not
luck. Security-relevant fields do not use last-write-wins — they **intersect**
(spec §22). `strictBoolean` makes the safe value sticky, `min` makes a ceiling a
ceiling, and `unionPatterns` makes a deny list one that can only grow. A key that
merges strictly _cannot_ be a weakening, whatever a repository writes in it.

So the audit is really a search for the exceptions, and they come in exactly two
shapes:

- a key that **opens** something which was closed, merged so only the user layer
  can open it;
- a key whose value is a **destination** or an **interpreter**, where the danger
  is not "weaker" but "elsewhere".

## Keys that can relax a boundary

| Key                              | What it opens                                                                                                               | What stays denied                                                                                                                                                                                                                                                                                                                                       | Layers        | Confined by                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `[egress] allow_benchmark_range` | the §23 address check for web reads: RFC 2544 benchmarking space (198.18.0.0/15) is treated as reachable                    | loopback, RFC1918, link-local and cloud-metadata addresses remain denied                                                                                                                                                                                                                                                                                | **user only** | strictBoolean in mergeConfig — a project layer can turn it off and can never turn it on         |
| `[egress] <kind>`                | the default of no egress at all: each named host becomes reachable for that channel                                         | every host not named; the per-host approval, the granted capability profile and the EgressGate all still have to agree, and a redirect is never followed to a host the list never saw                                                                                                                                                                   | any layer     | intersectHosts in mergeConfig — a project layer can only narrow the user list, never add to it  |
| `[shell] default_network`        | the default that a shell command gets no network                                                                            | the host allowlist and the per-command approval still apply; on the container and native backends the network boundary is still enforced by the OS                                                                                                                                                                                                      | any layer     | strictBoolean with safe value false — any layer may turn it off, none may turn it on for others |
| `[model.provider.*] base_url`    | nothing, directly — but it decides where every prompt, and every file the model has read, is sent                           | a project config may never declare one; the host is added to the model egress allowlist only when the _user_ layer declared it                                                                                                                                                                                                                          | **user only** | loadConfig drops project-declared providers with a warning                                      |
| `[container] image`              | nothing about the boundary — but it chooses which code exists _inside_ it, i.e. the interpreter that runs the project       | read-only root, dropped capabilities, no-new-privileges, no host namespaces and no extra mounts are properties of every plan and are not configurable at all                                                                                                                                                                                            | **user only** | loadConfig drops a project-declared container.image with a warning                              |
| `[container] pull_if_missing`    | the rule that fetching an image is a setup action, never a side effect                                                      | a project layer may not trigger it, and a tool call never triggers it                                                                                                                                                                                                                                                                                   | **user only** | strictBoolean, plus loadConfig dropping it from a project layer                                 |
| `[security] permission_profile`  | appears to widen permissions by naming a broader profile                                                                    | nothing, in practice — the policy engine intersects the resulting rule sets, so a broader name cannot actually widen anything a stricter layer denied                                                                                                                                                                                                   | any layer     | capability intersection in PolicyEngine; the profile name is an input, not an authority         |
| `[mcp.servers.*] command / url`  | the property that held for every tool until alpha.9 — that the kernel wrote the tool and knew what it touched before it ran | a project config may never declare one; a stdio server is a subprocess under the session sandbox and an HTTP server is egress through the allowlist, so a server cannot exist outside the boundaries its transport belongs to. What the server does _internally_ is not enforced at all, which is why the descriptor reports `foreignToolEffects: none` | **user only** | loadConfig drops a project-declared `[mcp] servers` table with a warning                        |
| `[mcp.servers.*] credential_ref` | nothing — it is the mechanism that keeps a credential out of a tool argument                                                | the value is brokered by SecretBroker and never enters a tool argument, a description, the model's context or the event log; a literal `credential`/`api_key` key is refused outright                                                                                                                                                                   | **user only** | parseMcp warns on and discards a literal; SecretBroker owns the value                           |
| `[mcp.servers.*] optional`       | alpha.8 §10's rule that a first run refuses rather than degrades — a session may start with a declared server missing       | the absence is still loud: a warning on stderr and an `mcp.server.unavailable` event. The default is to fail the session, and the user had to type this per server to change that                                                                                                                                                                       | **user only** | the default is false; only a user-config layer can set it                                       |
| `[mcp] use`                      | nothing — it can only narrow the user-declared server set                                                                   | a name not present in the user layer is dropped with a warning rather than created; a project selects among servers, it cannot conjure one                                                                                                                                                                                                              | any layer     | loadConfig intersects `use` against the final user-declared server set                          |

Two of those rows never produce a startup warning, and the reason is worth
stating: `base_url` and `container.image` are not relaxations you switch on, they
are values every working install has. They appear here because they answer §12's
question — _can a repository move this?_ — and the answer had to be checked. It is
no, in both cases, enforced by `loadConfig` dropping a project-declared value with
a warning.

## Keys the system ceiling pins regardless of configuration

These look like they could weaken something and cannot, because
`applySystemCeiling` overwrites them after every layer has had its say.

- [security] secret_redaction — forced true by applySystemCeiling
- [security] telemetry_content / [telemetry] content — forced false; content telemetry is never permitted
- [security] trace_upload / [telemetry] trace_upload — forced false
- [loop] max_steps / max_tool_calls / max_model_requests / max_wall_time_ms / max_repeated_failures / max_cost_usd — merged by Math.min then clamped by SYSTEM_CEILING; a layer may only lower them
- [loop] max_delegation_depth — clamped to 1, the only depth alpha.4 validated
- [security] extra_secret_paths — union; a layer may add a deny pattern, never remove one
- [container] pids_limit / memory_bytes / cpus — Math.min; a layer may only tighten
- [container] privileged / network_mode / extra_mounts / cap_add — not a configuration surface at all; warned and ignored
- [mcp.servers.\*] credential / api_key — not a configuration surface at all; a literal credential is warned about and discarded, and only credential_ref is honoured

## What this is not

It is not a claim that the configuration surface is safe by inspection. It is the
claim that every key has been _looked at_, that the table cannot silently fall
behind the parser — `tests/unit/config-weakening.test.ts` derives the key set from
`src/config/schema.ts` and fails when a key appears in neither list — and that
every relaxation this configuration actually enables is printed at startup and
visible in `/status` before the session does anything.
