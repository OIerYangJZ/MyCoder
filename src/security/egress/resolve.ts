/**
 * Resolve-then-classify, for the one egress path with no proxy in front of it.
 *
 * alpha.6 put the §23 address check where it belongs for *subprocess* egress:
 * inside the proxy, on the address it is about to connect to, which is what makes
 * a DNS rebinding fail even for a host the policy allows. `WebFetch` (ADR-0017)
 * has no proxy — the kernel makes that request itself — so the same question has
 * to be asked here: `allowed.example` may be in the operator's allowlist and
 * still must not be usable to reach `169.254.169.254`.
 *
 * **This is best-effort and the code says so rather than the docs alone.** We
 * check the addresses the resolver returns *now*; the connection resolves again,
 * inside `fetch`, and nothing in a zero-dependency Node HTTP client lets us pin
 * the socket to the address we validated. So this closes the accidental and the
 * lazy case — a name that simply points at private space — and does not close a
 * resolver that answers differently twice on purpose. Invariant 5's rule applies
 * to us as much as to a sandbox label: say what it is.
 */

import { lookup as dnsLookup } from 'node:dns/promises';

import { classifyAddress, type AddressScope } from './host.ts';

/** Injectable for tests; the real one is `dns/promises.lookup`. */
export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface ResolveScopeOptions {
  /**
   * Permit RFC 2544 benchmarking space (`198.18.0.0/15`).
   *
   * The same explicit, auditable opt-in the egress proxy has, and it exists for
   * the same measured reason: some resolvers — DNS-interception VPNs, Docker
   * Desktop in certain configurations — map *public* names into that range and
   * NAT them to the real destination. On such a machine every legitimate host
   * resolves into a block §23 correctly refuses, and web reads deny the entire
   * internet. Off by default; turning it on is a line in the user's config.
   */
  allowBenchmarkRange?: boolean;
  lookup?: LookupFn;
  /** Milliseconds before an unanswered lookup is treated as a refusal. */
  timeoutMs?: number;
}

export type ResolveScopeResult =
  | { ok: true; addresses: string[]; skipped?: 'loopback-by-name' }
  | { ok: false; reason: string; scope?: AddressScope; address?: string };

/** Hosts that *are* loopback by name, where there is no ambiguity of intent. */
function isLoopbackName(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Check every address a name resolves to.
 *
 * Every address, not the first: a name that answers with one global address and
 * one link-local address is a name that can reach link-local, and `fetch` picks
 * whichever the platform prefers. Failing on any non-global answer is the only
 * reading that does not depend on resolver ordering.
 */
export async function resolveHostScope(
  host: string,
  opts: ResolveScopeOptions = {},
): Promise<ResolveScopeResult> {
  // A host that is loopback *by name* was named deliberately — a local docs
  // server, a fixture — and the operator had to put it in the allowlist. The
  // case this function exists to stop is a public name that *resolves* to
  // loopback, which is a different thing and still refused below.
  if (isLoopbackName(host)) return { ok: true, addresses: [host], skipped: 'loopback-by-name' };

  // An address literal was already classified by the caller; resolving it would
  // just hand the same string back.
  if (classifyAddress(host) !== undefined) {
    const classified = classifyAddress(host)!;
    return classified.global || (classified.scope === 'benchmarking' && opts.allowBenchmarkRange === true)
      ? { ok: true, addresses: [host] }
      : { ok: false, reason: `the address is ${classified.scope}`, scope: classified.scope, address: host };
  }

  const lookup = opts.lookup ?? ((h: string) => dnsLookup(h, { all: true }));
  const timeoutMs = opts.timeoutMs ?? 5_000;

  let answers: Array<{ address: string }>;
  try {
    answers = await withTimeout(lookup(host), timeoutMs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: `the host could not be resolved${code ? ` (${code})` : ''}` };
  }

  if (answers.length === 0) return { ok: false, reason: 'the host resolved to no addresses' };

  for (const answer of answers) {
    const classified = classifyAddress(answer.address);
    if (classified === undefined) {
      return {
        ok: false,
        reason: `the host resolved to an address that cannot be classified`,
        address: answer.address,
      };
    }
    if (classified.global) continue;
    if (classified.scope === 'benchmarking' && opts.allowBenchmarkRange === true) continue;
    return {
      ok: false,
      reason: `the host resolves to a ${classified.scope} address`,
      scope: classified.scope,
      address: answer.address,
    };
  }

  return { ok: true, addresses: answers.map((a) => a.address) };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
