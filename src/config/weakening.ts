/**
 * Every configuration key that can weaken a boundary (alpha.8 §12).
 *
 * §12's rule, in full: a key that weakens a boundary must
 *
 *     be user-layer only
 *     be disclosed at startup
 *     be visible in /status
 *     say what remains denied
 *
 * and alpha.7's `allow_benchmark_range` is the reference implementation. §12 then
 * asks for **every existing key audited against it, recorded as evidence rather
 * than as a claim** — which is why this is a table in `src/` and not a paragraph
 * in `docs/`. A paragraph cannot be asserted against the merge function.
 *
 * The audit's own conclusion is worth stating, because it is the interesting
 * result: almost nothing in this config surface can weaken anything. That is not
 * luck. Security-relevant fields do not use last-write-wins — they intersect
 * (spec §22), so `strictBoolean` makes the safe value sticky, `min` makes a
 * ceiling a ceiling, and `unionPatterns` makes a deny list only grow. A key that
 * merges strictly *cannot* be a weakening, whatever a repository writes in it.
 *
 * So the audit is really a search for the exceptions, and there are exactly two
 * shapes of them:
 *
 *   - a key that opens something which was closed, merged so that only the user
 *     layer can open it (`allow_benchmark_range`, `[egress] <kind>`);
 *   - a key whose value is a *destination* or an *interpreter*, where the danger
 *     is not "weaker" but "elsewhere" (`base_url`, `container.image`).
 *
 * Both are handled the same way: dropped from a project layer with a warning,
 * and disclosed at startup when set.
 */

import type { KernelConfig } from './schema.ts';

export type Layer = 'user-only' | 'any-layer';

export interface WeakeningKey {
  /** The TOML path a user would search for. */
  key: string;
  /** What boundary it moves, in the words the disclosure will use. */
  weakens: string;
  /** What stays denied even so. §12's fourth requirement. */
  stillDenied: string;
  /** Which layers may set it, and what enforces that. */
  layer: Layer;
  enforcedBy: string;
  /** Is this key currently set to its weakening value? */
  isSet(config: KernelConfig): boolean;
  /** The startup disclosure, when set. */
  disclose(config: KernelConfig): string;
}

export const WEAKENING_KEYS: WeakeningKey[] = [
  {
    key: '[egress] allow_benchmark_range',
    weakens:
      'the §23 address check for web reads: RFC 2544 benchmarking space (198.18.0.0/15) is treated as reachable',
    stillDenied: 'loopback, RFC1918, link-local and cloud-metadata addresses remain denied',
    layer: 'user-only',
    enforcedBy: 'strictBoolean in mergeConfig — a project layer can turn it off and can never turn it on',
    isSet: (c) => c.egress.allowBenchmarkRange === true,
    disclose: () =>
      'Web reads accept RFC 2544 benchmarking addresses (198.18.0.0/15) because ' +
      '[egress] allow_benchmark_range is enabled in your user config. Loopback, RFC1918, link-local ' +
      'and cloud-metadata addresses remain denied.',
  },
  {
    key: '[egress] <kind>',
    weakens: 'the default of no egress at all: each named host becomes reachable for that channel',
    stillDenied:
      'every host not named; the per-host approval, the granted capability profile and the ' +
      'EgressGate all still have to agree, and a redirect is never followed to a host the list never saw',
    layer: 'any-layer',
    enforcedBy:
      'intersectHosts in mergeConfig — a project layer can only narrow the user list, never add to it',
    isSet: (c) => Object.values(c.egress.allowedHosts ?? {}).some((hosts) => hosts.length > 0),
    disclose: (c) => {
      const kinds = Object.entries(c.egress.allowedHosts ?? {})
        .filter(([, hosts]) => hosts.length > 0)
        .map(([kind, hosts]) => `${kind} → ${hosts.join(', ')}`);
      return `Egress is permitted to named hosts only: ${kinds.join('; ')}. Every other destination is denied.`;
    },
  },
  {
    key: '[shell] default_network',
    weakens: 'the default that a shell command gets no network',
    stillDenied:
      'the host allowlist and the per-command approval still apply; on the container and ' +
      'native backends the network boundary is still enforced by the OS',
    layer: 'any-layer',
    enforcedBy:
      'strictBoolean with safe value false — any layer may turn it off, none may turn it on for others',
    isSet: (c) => c.shell.defaultNetwork === true,
    disclose: () =>
      'Shell commands are granted network by default because [shell] default_network is true. ' +
      'The host allowlist and per-command approval still apply.',
  },
  {
    key: '[model.provider.*] base_url',
    weakens:
      'nothing, directly — but it decides where every prompt, and every file the model has read, is sent',
    stillDenied:
      'a project config may never declare one; the host is added to the model egress allowlist ' +
      'only when the *user* layer declared it',
    layer: 'user-only',
    enforcedBy: 'loadConfig drops project-declared providers with a warning',
    // Always "set" in any working install; disclosed by `/status` naming the
    // provider rather than by a warning, so this row is audit-only.
    isSet: () => false,
    disclose: () => '',
  },
  {
    key: '[container] image',
    weakens:
      'nothing about the boundary — but it chooses which code exists *inside* it, i.e. the interpreter that runs the project',
    stillDenied:
      'read-only root, dropped capabilities, no-new-privileges, no host namespaces and no extra ' +
      'mounts are properties of every plan and are not configurable at all',
    layer: 'user-only',
    enforcedBy: 'loadConfig drops a project-declared container.image with a warning',
    isSet: () => false,
    disclose: () => '',
  },
  {
    key: '[container] pull_if_missing',
    weakens: 'the rule that fetching an image is a setup action, never a side effect',
    stillDenied: 'a project layer may not trigger it, and a tool call never triggers it',
    layer: 'user-only',
    enforcedBy: 'strictBoolean, plus loadConfig dropping it from a project layer',
    isSet: (c) => c.container.pullIfMissing === true,
    disclose: () =>
      'A missing container image will be pulled at startup because [container] pull_if_missing is ' +
      'enabled in your user config. Pulling still never happens as a side effect of a tool call.',
  },
  // The strongest weakening in this table, and the one whose row is worth
  // reading twice. A provider endpoint redirects where prompts go; a container
  // image chooses the interpreter inside the boundary. This adds an *executable*
  // to the session whose tool descriptions enter the model's context and whose
  // implementation the kernel never reads (ADR-0022 §3).
  {
    key: '[mcp.servers.*] command / url',
    weakens:
      'the property that held for every tool until alpha.9 — that the kernel wrote the tool and ' +
      'knew what it touched before it ran',
    stillDenied:
      'a project config may never declare one; a stdio server is a subprocess under the session ' +
      'sandbox and an HTTP server is egress through the allowlist, so a server cannot exist ' +
      'outside the boundaries its transport belongs to. What the server does *internally* is not ' +
      'enforced at all, which is why the descriptor reports foreignToolEffects: none',
    layer: 'user-only',
    enforcedBy: 'loadConfig drops a project-declared [mcp] servers table with a warning',
    isSet: (c) => Object.keys(c.mcp.servers ?? {}).length > 0,
    disclose: (c) =>
      `MCP server(s) ${Object.keys(c.mcp.servers ?? {}).join(', ')} are attached. MyCoder decides ` +
      'whether a server may be asked to run a tool; it does not enforce what the server then does.',
  },
  {
    key: '[mcp.servers.*] credential_ref',
    weakens: 'nothing — it is the mechanism that keeps a credential out of a tool argument',
    stillDenied:
      'the value is brokered by SecretBroker and never enters a tool argument, a description, the ' +
      "model's context or the event log; a literal `credential`/`api_key` key is refused outright",
    layer: 'user-only',
    enforcedBy: 'parseMcp warns on and discards a literal; SecretBroker owns the value',
    isSet: () => false,
    disclose: () => '',
  },
  {
    key: '[mcp.servers.*] optional',
    weakens:
      "alpha.8 §10's rule that a first run refuses rather than degrades — a session may start " +
      'with a declared server missing',
    stillDenied:
      'the absence is still loud: a warning on stderr and an mcp.server.unavailable event. The ' +
      'default is to fail the session, and the user had to type this per server to change that',
    layer: 'user-only',
    enforcedBy: 'the default is false; only a user-config layer can set it',
    isSet: (c) => Object.values(c.mcp.servers ?? {}).some((s) => s.optional === true),
    disclose: (c) =>
      `MCP server(s) ${Object.entries(c.mcp.servers ?? {})
        .filter(([, s]) => s.optional)
        .map(([n]) => n)
        .join(', ')} are optional: the session will start without them if they fail.`,
  },
  {
    key: '[mcp] use',
    weakens: 'nothing — it can only narrow the user-declared server set',
    stillDenied:
      'a name not present in the user layer is dropped with a warning rather than created; a ' +
      'project selects among servers, it cannot conjure one',
    layer: 'any-layer',
    enforcedBy: 'loadConfig intersects `use` against the final user-declared server set',
    isSet: () => false,
    disclose: () => '',
  },
  {
    key: '[security] permission_profile',
    weakens: 'appears to widen permissions by naming a broader profile',
    stillDenied:
      'nothing, in practice — the policy engine intersects the resulting rule sets, so a broader ' +
      'name cannot actually widen anything a stricter layer denied',
    layer: 'any-layer',
    enforcedBy: 'capability intersection in PolicyEngine; the profile name is an input, not an authority',
    isSet: () => false,
    disclose: () => '',
  },
];

/**
 * Keys that look like a weakening and are not, because the ceiling refuses them.
 *
 * Recorded because "we checked and it cannot" is the audit result, and a key
 * absent from both lists is a key nobody looked at.
 */
export const CEILING_PINNED = [
  '[security] secret_redaction — forced true by applySystemCeiling',
  '[security] telemetry_content / [telemetry] content — forced false; content telemetry is never permitted',
  '[security] trace_upload / [telemetry] trace_upload — forced false',
  '[loop] max_steps / max_tool_calls / max_model_requests / max_wall_time_ms / max_repeated_failures / max_cost_usd — merged by Math.min then clamped by SYSTEM_CEILING; a layer may only lower them',
  '[loop] max_delegation_depth — clamped to 1, the only depth alpha.4 validated',
  '[security] extra_secret_paths — union; a layer may add a deny pattern, never remove one',
  '[container] pids_limit / memory_bytes / cpus — Math.min; a layer may only tighten',
  '[container] privileged / network_mode / extra_mounts / cap_add — not a configuration surface at all; warned and ignored',
  '[mcp.servers.*] credential / api_key — not a configuration surface at all; a literal credential is warned about and discarded, and only credential_ref is honoured',
];

/** Every disclosure this configuration owes the user at startup (§12). */
export function disclosures(config: KernelConfig): string[] {
  return WEAKENING_KEYS.filter((k) => k.isSet(config)).map((k) => k.disclose(config));
}
