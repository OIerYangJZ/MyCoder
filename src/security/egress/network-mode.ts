/**
 * Process network modes and the frozen proxy policy (alpha.6 §9, §19–§23, ADR-0015).
 *
 * alpha.5 shipped a capability profile whose network field was `false | { hosts }`,
 * and the container backend read it as one bit: `--network none` or
 * `--network bridge`. The hosts were carried into the approval prompt and the
 * audit record and then dropped on the floor, which is why §0 calls the alpha.5
 * allowlist "disclosure, not enforcement".
 *
 * This module is where that bit becomes three states. The important one is the
 * middle one, and the important property of the middle one is that it is
 * *closed*: `ProcessNetworkMode` is derived once, from a capability profile the
 * policy engine already ruled on, and then never widened. The proxy receives a
 * `ProxyPolicy` built from it and cannot be told anything else — not by the
 * workload, which has no channel to the proxy other than the requests it is
 * making, and not by the model, which never sees this type at all.
 *
 * Two decisions here look conservative and are load-bearing:
 *
 *   `hosts: []` is invalid.  An empty allowlist is the one input where "allow
 *   nothing" and "allow everything" are both plausible readings, and alpha.5's
 *   `network !== false` test read it as everything. §9 resolves it by refusing
 *   the request instead of picking (see `normalizeNetworkMode`).
 *
 *   ports are 80 and 443.  The public tool schema names a host and not a port,
 *   so any port policy at all has to be invented somewhere. Inventing "all of
 *   them" would mean an approval for `registry.npmjs.org` also approved its SSH
 *   port; §22 says the enforced scope is exactly the protocols the proxy can
 *   actually validate, and everything else is denied rather than tunnelled.
 */

import { normalizeHost } from './host.ts';

/** §61: a policy larger than this is refused, never truncated (§60). */
export const MAX_POLICY_HOSTS = 64;

export const HTTP_PORT = 80;
export const HTTPS_PORT = 443;

export type EgressProtocol = 'http' | 'https';

/**
 * One approved destination.
 *
 * Host *and* protocol/port, because "allow registry.npmjs.org" has to mean
 * something precise before it can be enforced, and the precise thing is
 * "HTTP on 80 and HTTPS on 443, with the identity checks each of those permits".
 */
export interface EgressTarget {
  /** Already normalised by `normalizeHost`. Never a raw user string. */
  host: string;
  kind: 'domain' | 'ipv4' | 'ipv6';
  ports: readonly number[];
  protocols: readonly EgressProtocol[];
}

export type ProcessNetworkMode =
  { kind: 'deny-all' } | { kind: 'allowlist'; targets: readonly EgressTarget[] } | { kind: 'unrestricted' };

/**
 * The capability profile's network field.
 *
 * Kept structurally compatible with alpha.5's `false | { hosts }` so that every
 * existing profile, test fixture and policy path continues to mean what it meant;
 * `{ unrestricted: true }` is the new third state and has to be asked for by
 * name. A profile cannot arrive at unrestricted by accident, which is §40's
 * requirement that broad egress have its own approval rather than being the
 * degenerate case of a narrow one.
 */
export type ProfileNetwork = false | { readonly hosts: readonly string[] } | { readonly unrestricted: true };

export interface NetworkModeResult {
  ok: boolean;
  mode: ProcessNetworkMode;
  /** Populated when `ok` is false; the mode is then `deny-all`. */
  problems: readonly string[];
}

export function isUnrestricted(network: ProfileNetwork): network is { readonly unrestricted: true } {
  return network !== false && 'unrestricted' in network && network.unrestricted === true;
}

/**
 * Turn a capability profile's network grant into an enforceable mode.
 *
 * Fails closed in every ambiguous case, and the failure is a `deny-all` mode
 * *plus* problems — so a caller that ignores `ok` still gets the safe outcome
 * rather than an exception it might catch into a permissive default.
 */
export function normalizeNetworkMode(network: ProfileNetwork): NetworkModeResult {
  if (network === false) return { ok: true, mode: { kind: 'deny-all' }, problems: [] };
  if (isUnrestricted(network)) return { ok: true, mode: { kind: 'unrestricted' }, problems: [] };

  const hosts = network.hosts;
  const problems: string[] = [];

  if (hosts.length === 0) {
    // §9: not "the internet", and not silently "nothing" either — the request
    // itself is malformed and the caller has to say which it meant.
    return {
      ok: false,
      mode: { kind: 'deny-all' },
      problems: ['an allowlist with no hosts is not a valid network grant (alpha.6 §9)'],
    };
  }
  if (hosts.length > MAX_POLICY_HOSTS) {
    // §60: keeping the first N would be a guarantee-bearing path silently
    // reducing its own coverage.
    return {
      ok: false,
      mode: { kind: 'deny-all' },
      problems: [`an allowlist of ${hosts.length} hosts exceeds the maximum of ${MAX_POLICY_HOSTS}`],
    };
  }

  const byHost = new Map<string, EgressTarget>();
  for (const raw of hosts) {
    const normalized = normalizeHost(raw);
    if (!normalized.ok) {
      problems.push(`host ${JSON.stringify(raw)} is not usable: ${normalized.reason}`);
      continue;
    }
    if (byHost.has(normalized.host)) continue;
    byHost.set(normalized.host, {
      host: normalized.host,
      kind: normalized.kind,
      ports: [HTTP_PORT, HTTPS_PORT],
      protocols: ['http', 'https'],
    });
  }

  if (problems.length > 0) {
    // One bad host does not silently become a smaller allowlist: a policy the
    // user approved and the kernel partially understood is exactly the kind of
    // quiet narrowing that makes an approval prompt untrustworthy in the other
    // direction.
    return { ok: false, mode: { kind: 'deny-all' }, problems };
  }

  return {
    ok: true,
    // Sorted so the mode is a value, not a value-plus-insertion-order: the
    // approval subject and the audit record both hash this.
    mode: { kind: 'allowlist', targets: [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host)) },
    problems: [],
  };
}

/**
 * Compose a child scope with its parent's (alpha.6 §50, §51, §52).
 *
 * The rule is one sentence — a child can only narrow — and the reason it is a
 * function rather than a convention is that "narrow" has four cases and three of
 * them are easy to get backwards:
 *
 *     parent deny-all      + anything      → deny-all
 *     parent allowlist     + unrestricted  → the parent's allowlist, not broad
 *     parent allowlist     + allowlist     → set intersection
 *     parent unrestricted  + allowlist     → the child's allowlist
 *
 * The second row is the one that matters. A Skill or a subagent asking for
 * unrestricted network inside a scoped session must not get it; it gets what the
 * session already had. `skills.ts` already refuses a `network:` key in front
 * matter for the same reason, and this is the same rule expressed over modes
 * rather than over front-matter keys.
 *
 * In the kernel as it stands this is belt and braces: a child's hosts are decided
 * by the policy engine through narrowing layers, so a child physically cannot
 * receive an `allow` for a host the parent's policy denies. This function exists
 * so that the property is *stated and tested* rather than only emergent, and so
 * that any future path which composes profiles directly has one correct
 * implementation to call.
 */
export function narrowNetworkMode(parent: ProcessNetworkMode, child: ProcessNetworkMode): ProcessNetworkMode {
  if (parent.kind === 'deny-all' || child.kind === 'deny-all') return { kind: 'deny-all' };
  if (parent.kind === 'unrestricted') return child;
  // parent is an allowlist from here: it is the ceiling.
  if (child.kind === 'unrestricted') return parent;

  const permitted = new Map(parent.targets.map((t) => [t.host, t] as const));
  const targets: EgressTarget[] = [];
  for (const target of child.targets) {
    const ceiling = permitted.get(target.host);
    if (!ceiling) continue; // the child named a host the parent never had
    targets.push({
      host: target.host,
      kind: target.kind,
      ports: target.ports.filter((p) => ceiling.ports.includes(p)),
      protocols: target.protocols.filter((p) => ceiling.protocols.includes(p)),
    });
  }
  // An intersection that empties out is deny-all, not "no constraint". This is
  // the same trap as `hosts: []`, and it gets the same answer.
  const usable = targets.filter((t) => t.ports.length > 0 && t.protocols.length > 0);
  if (usable.length === 0) return { kind: 'deny-all' };
  return { kind: 'allowlist', targets: usable.sort((a, b) => a.host.localeCompare(b.host)) };
}

/**
 * The immutable policy handed to the proxy sidecar (§19).
 *
 * Serialised to JSON, mounted read-only into the sidecar, and never read from
 * any other source. `allowPrivateAddresses` exists only so the controlled test
 * topology of §56 can point at a container on a private network; production
 * defaults to false, and the flag is not reachable from configuration or from a
 * tool argument — only from the kernel-side test harness.
 */
export interface ProxyPolicy {
  version: 1;
  executionId: string;
  targets: readonly EgressTarget[];
  allowPrivateAddresses: boolean;
  /**
   * Treat RFC 2544 benchmarking space (`198.18.0.0/15`) as a reachable
   * destination (alpha.6 dogfood finding D-A6-2).
   *
   * Off by default and off on the native-Linux release tier. It exists because
   * some deployments sit behind a resolver that maps public hostnames into that
   * range and NATs them onward, and on those hosts the strict §23 policy denies
   * every real destination. Enabling it is a deliberate, recorded weakening of
   * the address check for one /15 — never a general "allow reserved space", and
   * never inferred: the operator says so, and `/status` says so back.
   */
  allowBenchmarkRange: boolean;
  protocols: readonly EgressProtocol[];
}

export function buildProxyPolicy(opts: {
  executionId: string;
  mode: ProcessNetworkMode;
  allowPrivateAddresses?: boolean;
  allowBenchmarkRange?: boolean;
}): ProxyPolicy {
  const targets = opts.mode.kind === 'allowlist' ? opts.mode.targets : [];
  return {
    version: 1,
    executionId: opts.executionId,
    targets,
    allowPrivateAddresses: opts.allowPrivateAddresses ?? false,
    allowBenchmarkRange: opts.allowBenchmarkRange ?? false,
    protocols: ['http', 'https'],
  };
}

/**
 * Parse a policy document back, with every field re-validated.
 *
 * The sidecar reads its policy from a file, and "the kernel wrote it so it must
 * be well-formed" is the assumption that makes a file-mount an injection point.
 * Re-normalising each host here means the proxy's idea of the allowlist is
 * produced by the same function that produced the approval subject, which is the
 * §20 invariant restated at the trust boundary.
 */
export function parseProxyPolicy(
  text: string,
): { ok: true; policy: ProxyPolicy } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'policy is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'policy is not an object' };
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) return { ok: false, reason: 'policy version is not 1' };
  if (typeof doc.executionId !== 'string' || doc.executionId === '') {
    return { ok: false, reason: 'policy has no execution id' };
  }
  if (!Array.isArray(doc.targets)) return { ok: false, reason: 'policy targets is not an array' };
  if (doc.targets.length > MAX_POLICY_HOSTS) return { ok: false, reason: 'policy has too many targets' };

  const targets: EgressTarget[] = [];
  for (const entry of doc.targets as unknown[]) {
    if (typeof entry !== 'object' || entry === null)
      return { ok: false, reason: 'policy target is not an object' };
    const t = entry as Record<string, unknown>;
    if (typeof t.host !== 'string') return { ok: false, reason: 'policy target has no host' };
    const normalized = normalizeHost(t.host);
    if (!normalized.ok) return { ok: false, reason: `policy target host is invalid: ${normalized.reason}` };
    if (!Array.isArray(t.ports) || t.ports.length === 0) {
      return { ok: false, reason: 'policy target has no ports' };
    }
    const ports: number[] = [];
    for (const p of t.ports as unknown[]) {
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
        return { ok: false, reason: 'policy target port is not a valid port number' };
      }
      if (p !== HTTP_PORT && p !== HTTPS_PORT) {
        return { ok: false, reason: `policy target port ${p} is outside the enforced HTTP/HTTPS scope` };
      }
      ports.push(p);
    }
    const protocols: EgressProtocol[] = [];
    for (const p of (Array.isArray(t.protocols) ? t.protocols : []) as unknown[]) {
      if (p !== 'http' && p !== 'https')
        return { ok: false, reason: 'policy target protocol is not http/https' };
      protocols.push(p);
    }
    if (protocols.length === 0) return { ok: false, reason: 'policy target has no protocols' };
    targets.push({ host: normalized.host, kind: normalized.kind, ports, protocols });
  }

  return {
    ok: true,
    policy: {
      version: 1,
      executionId: doc.executionId,
      targets,
      allowPrivateAddresses: doc.allowPrivateAddresses === true,
      allowBenchmarkRange: doc.allowBenchmarkRange === true,
      protocols: ['http', 'https'],
    },
  };
}

/**
 * Look up a destination in the policy.
 *
 * Exact host match only (§21). `foo.registry.npmjs.org` is a different host from
 * `registry.npmjs.org` and gets a different answer, which is the entire content
 * of "wildcard policy is a later feature".
 */
export function findTarget(policy: ProxyPolicy, host: string, port: number): EgressTarget | undefined {
  return policy.targets.find((t) => t.host === host && t.ports.includes(port));
}

/**
 * The host set as it appears in an approval subject (§36).
 *
 * Normalised, sorted and joined, so that `["b.example","a.example"]` and
 * `["A.example.","b.example"]` are the same subject — and so that a subject for
 * two hosts can never collide with the subject for one of them.
 */
export function describeNetworkMode(mode: ProcessNetworkMode): string {
  switch (mode.kind) {
    case 'deny-all':
      return 'deny-all';
    case 'unrestricted':
      return 'unrestricted';
    case 'allowlist':
      return `allowlist:${mode.targets.map((t) => t.host).join(',')}`;
  }
}
