/**
 * Capability profile → Landlock plan (alpha.7 §14–§19).
 *
 * The rule the whole file follows: **allowlist, derived from the same semantic
 * inputs every other backend uses**. There is no "everything except the secrets"
 * anywhere in here, because that construction is only as good as the list of
 * secrets, and §14 is explicit that the policy is a capability-derived allowlist
 * instead.
 *
 * Three things this is careful about:
 *
 *   **Deep protected descendants (§16).** A read root is granted as a subtree, so
 *   `packages/app/config/secrets/.env` inside a granted workspace *would* be
 *   readable. Landlock cannot express "this subtree except that leaf", so the
 *   protected leaves are handled the way the container backend handles them —
 *   the paths are located and the plan refuses to be built if they cannot all be
 *   covered. Failing closed is the only honest option, since a rule set that
 *   quietly missed one would be a guarantee that is not.
 *
 *   **Traversal is complete or it fails (§17).** No "first N entries" scan.
 *
 *   **The runtime base is a policy, not a shrug (§18).** A workload needs its
 *   loader, its libraries, a few /etc files and a handful of devices. Granting
 *   `/`, `$HOME` or all of `/etc` to get there would hand back everything the
 *   backend just took away, so the base list is explicit, small, and tested.
 */

import { statSync } from 'node:fs';
import * as path from 'node:path';

import type { CanonicalPath } from '../../util/paths.ts';
import { isWithin, toPosix } from '../../util/paths.ts';
import type { CapabilityProfile } from '../backend.ts';
import { isUnrestricted } from '../../security/egress/network-mode.ts';

/** One line of the launcher protocol. */
export interface PlanRule {
  verb: 'ro' | 'rx' | 'rw';
  path: string;
}

export interface LinuxSandboxPlan {
  rules: readonly PlanRule[];
  netDeny: boolean;
  seccomp: boolean;
  /** Synthetic HOME (§19); always inside the sandbox's own scratch space. */
  home: string;
  /** Rendered protocol text, exactly as the launcher will read it. */
  text: string;
}

export interface PlanInputs {
  profile: CapabilityProfile;
  /** Scratch directory the sandbox may write to, and the synthetic HOME. */
  sandboxHome: CanonicalPath;
  /**
   * Protected paths that fall *inside* a granted root.
   *
   * Landlock grants subtrees, so these are the leaves a subtree grant would
   * otherwise expose. The caller discovers them with a complete traversal and
   * passes the result; an incomplete discovery must arrive as `truncated`.
   */
  protectedInsideRoots: readonly CanonicalPath[];
  /** True when the discovery scan hit a limit. Refuses to build a plan (§17). */
  discoveryTruncated?: boolean;
  /** Optional override of the runtime base, for tests. */
  runtimeBase?: readonly PlanRule[];
  /** Existence check, injectable so plan building is testable off-Linux. */
  exists?: (p: string) => boolean;
}

export class PlanRefused extends Error {
  readonly reason: string;
  readonly remedy?: string;

  constructor(reason: string, remedy?: string) {
    super(reason);
    this.name = 'PlanRefused';
    this.reason = reason;
    if (remedy !== undefined) this.remedy = remedy;
  }
}

/**
 * The runtime base policy (§18).
 *
 * Read-and-execute for the program trees, read for the specific configuration
 * files a dynamic loader and TLS stack need, and read/write for the devices a
 * normal program expects to have. Every entry earns its place; `/etc` as a whole
 * is deliberately absent, because it carries credentials on plenty of machines.
 *
 * Paths that do not exist on this system are dropped rather than failing: `/lib64`
 * is x86-64's, `/snap` is Ubuntu's, and a plan is not wrong for being on aarch64.
 */
export const RUNTIME_BASE: readonly PlanRule[] = [
  { verb: 'rx', path: '/usr' },
  { verb: 'rx', path: '/bin' },
  { verb: 'rx', path: '/sbin' },
  { verb: 'rx', path: '/lib' },
  { verb: 'rx', path: '/lib64' },
  { verb: 'ro', path: '/etc/ld.so.cache' },
  { verb: 'ro', path: '/etc/ld.so.conf' },
  { verb: 'ro', path: '/etc/ld.so.conf.d' },
  { verb: 'ro', path: '/etc/alternatives' },
  { verb: 'ro', path: '/etc/ssl/certs' },
  // Node refuses to start without it: OpenSSL opens this by absolute path before
  // any of our code runs. Measured, not guessed — see the compatibility sweep in
  // `docs/alpha7-native-validation.md`.
  { verb: 'ro', path: '/etc/ssl/openssl.cnf' },
  // Identity lookups (`getpwuid`) go through nsswitch to these. Neither carries a
  // credential — `/etc/shadow` does, and it is not here and never will be.
  { verb: 'ro', path: '/etc/passwd' },
  { verb: 'ro', path: '/etc/group' },
  { verb: 'ro', path: '/etc/gitconfig' },
  { verb: 'ro', path: '/etc/resolv.conf' },
  { verb: 'ro', path: '/etc/ca-certificates' },
  { verb: 'ro', path: '/etc/localtime' },
  { verb: 'ro', path: '/etc/nsswitch.conf' },
  { verb: 'ro', path: '/etc/os-release' },
  { verb: 'ro', path: '/usr/share/zoneinfo' },
  // **procfs is deliberately absent.**
  //
  // The obvious rule — `ro /proc/self` — measures well and is a trap. Landlock
  // resolves it once, at plan time, to *this pid's* directory, and a pid does not
  // survive `fork`: the first process could read its own `/proc` entry and every
  // child it spawned could not. That is an asymmetric guarantee nobody can
  // reason about, and the shell is the first thing to hit it.
  //
  // Granting `/proc` whole is the other direction and is worse: `/proc/<pid>/environ`
  // of any same-uid process is exactly the leak §22 exists to close, and the
  // measurement confirmed it is readable that way.
  //
  // So neither. The compatibility sweep found node, python3 (with ssl, json and
  // subprocess), git, grep and shell loops all work with no procfs at all, which
  // makes "the sandbox has no /proc" both true and cheap. The complete answer —
  // a PID namespace with its own procfs mount, where `/proc` contains only the
  // sandbox's processes — is recorded in ADR-0018 as the next step rather than
  // half-built here.
  { verb: 'rw', path: '/dev/null' },
  { verb: 'rw', path: '/dev/zero' },
  { verb: 'rw', path: '/dev/full' },
  { verb: 'ro', path: '/dev/urandom' },
  { verb: 'ro', path: '/dev/random' },
  { verb: 'rw', path: '/dev/tty' },
];

/**
 * Build the plan, or refuse.
 *
 * Refusing is a normal outcome here, not an exception path: a protected file
 * inside a granted root that Landlock cannot carve out, a truncated discovery, a
 * write root outside every read root — each of those is a case where running
 * would mean claiming a boundary that is not there.
 */
export function buildPlan(input: PlanInputs): LinuxSandboxPlan {
  const exists = input.exists ?? ((p: string) => existsSyncSafe(p));
  const rules: PlanRule[] = [];

  if (input.discoveryTruncated === true) {
    throw new PlanRefused(
      'the protected-path scan did not complete, so the sandbox cannot be shown to cover every ' +
        'protected file inside the granted roots',
      'Narrow the workspace, or use the container backend, which masks paths instead of enumerating them.',
    );
  }

  for (const rule of input.runtimeBase ?? RUNTIME_BASE) {
    if (exists(rule.path)) rules.push(rule);
  }

  // The scratch directory doubles as HOME (§19). Provider keys, ssh keys and
  // cloud credentials live in the *real* home, which is not in the plan at all.
  rules.push({ verb: 'rw', path: toPosix(input.sandboxHome) });

  for (const root of input.profile.readRoots) {
    if (!exists(root)) continue;
    rules.push({ verb: 'rx', path: toPosix(root) });
  }
  for (const root of input.profile.writeRoots) {
    if (!exists(root)) continue;
    rules.push({ verb: 'rw', path: toPosix(root) });
  }

  // §16: a protected leaf inside a granted subtree. Landlock has no "deny under
  // an allow", so the plan cannot express it — and a plan that silently exposed
  // it would be worse than one that refuses.
  const exposed = input.protectedInsideRoots.filter((p) =>
    [...input.profile.readRoots, ...input.profile.writeRoots].some((root) => isWithin(root, p)),
  );
  if (exposed.length > 0) {
    throw new PlanRefused(
      `${exposed.length} protected file(s) sit inside a granted root and Landlock cannot carve them ` +
        `out: ${exposed
          .slice(0, 3)
          .map((p) => path.basename(p))
          .join(', ')}${exposed.length > 3 ? '…' : ''}`,
      'Move the credential outside the workspace, or use the container backend, which masks it.',
    );
  }

  const netDeny = input.profile.network === false;
  if (!netDeny && !isUnrestricted(input.profile.network)) {
    // §27: a host allowlist is not something Landlock can express. Saying so is
    // the whole point — a backend that accepted the request and enforced nothing
    // would be alpha.5's "disclosure, not enforcement" all over again.
    throw new PlanRefused(
      'a host-scoped network allowlist is not supported by the native Linux backend: Landlock rules ' +
        'are ports and address families, not hostnames',
      'Use the container backend for scoped egress, or request no network at all.',
    );
  }

  const deduped = dedupe(rules);
  return {
    rules: deduped,
    netDeny,
    seccomp: true,
    home: toPosix(input.sandboxHome),
    text: renderPlan(deduped, netDeny),
  };
}

/**
 * Later, broader grants win.
 *
 * `rw` implies `rx` implies `ro` for the same path, and the launcher would
 * happily add both rules — the union is what Landlock ends up enforcing, so the
 * plan may as well say the union and be readable in an audit log.
 */
function dedupe(rules: readonly PlanRule[]): PlanRule[] {
  const strength: Record<PlanRule['verb'], number> = { ro: 0, rx: 1, rw: 2 };
  const best = new Map<string, PlanRule>();
  for (const rule of rules) {
    const current = best.get(rule.path);
    if (!current || strength[rule.verb] > strength[current.verb]) best.set(rule.path, rule);
  }
  return [...best.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function renderPlan(rules: readonly PlanRule[], netDeny: boolean): string {
  const lines = ['version 1'];
  for (const rule of rules) lines.push(`${rule.verb} ${rule.path}`);
  lines.push(`net ${netDeny ? 'deny' : 'unrestricted'}`);
  // Always on: it is defence in depth for the one gap Landlock leaves open
  // (process inspection), and it costs nothing measurable.
  lines.push('seccomp 1');
  lines.push('nnp 1');
  lines.push('end');
  return `${lines.join('\n')}\n`;
}

function existsSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
