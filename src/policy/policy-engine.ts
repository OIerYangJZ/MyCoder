/**
 * Policy Engine (spec §11).
 *
 * Decides allow / deny / ask / hard-deny. It does **not** enforce anything — the
 * executor does that, with a capability profile derived from these decisions.
 * Keeping the two apart is what stops "the model was told no" from being
 * mistaken for "the model cannot".
 *
 * Composition rule (spec §11.2):
 *
 *   EffectiveCapability = SystemCeiling ∩ SessionCeiling ∩ UserProfile
 *                       ∩ ProjectProfile ∩ AgentProfile ∩ SkillProfile
 *                       ∩ ToolRequest
 *
 * Implemented literally: every layer votes, and the **strictest** vote wins. A
 * layer can therefore only ever narrow what the layers above it allow, which is
 * the mechanical reason a skill cannot raise the session ceiling (invariant 14).
 */

import { globMatch } from '../util/glob.ts';
import { isWithin, toPosix, type CanonicalPath } from '../util/paths.ts';
import { kernelError, type ErrorCode, type KernelError } from '../util/errors.ts';
import { capabilityOf, describeAccess, matchTargetOf, subjectKeyOf, type AccessRequest } from './access.ts';
import { ProtectedPaths, type ProtectionVerdict } from './protected-paths.ts';
import {
  isStricter,
  strictest,
  type PermissionProfile,
  type PolicyAction,
  type PolicyRule,
} from './profiles.ts';

export type PolicySource = 'system' | 'session' | 'user' | 'project' | 'agent' | 'skill' | 'tool';

export interface PolicyLayer {
  /** Shown in `/permissions explain`. */
  name: string;
  source: PolicySource;
  profile: PermissionProfile;
}

export interface PolicyDecision {
  action: PolicyAction;
  access: AccessRequest;
  subjectKey: string;
  /** Human-readable justification, safe for the model and the approval UI. */
  reason: string;
  /** Which layer produced the winning vote. */
  layer?: string;
  source?: PolicySource;
  rule?: PolicyRule;
  /** True for hard denies: no approval, no configuration, can lift this. */
  final: boolean;
  /** Set when the request targets a path outside the workspace root. */
  outsideWorkspace?: boolean;
  /** The error code to use if this decision blocks a tool. */
  errorCode: ErrorCode;
}

/**
 * Executables that escalate privilege. Hard denied at the system layer, so no
 * profile, config file, skill or approval can reach them (spec §11.3).
 */
const PRIVILEGE_ESCALATION: readonly string[] = [
  'sudo',
  'sudoedit',
  'su',
  'doas',
  'pkexec',
  'runas',
  'security', // macOS: `security dump-keychain`
  'csrutil',
  'spctl',
  'dscl',
  'launchctl',
  'systemsetup',
  'chflags',
  'diskutil',
  'nvram',
];

export interface ApprovalRecord {
  subjectKey: string;
  granted: boolean;
  decidedAt: number;
  /** What the user actually saw when they decided. */
  summary: string;
}

/**
 * Session-scoped approvals.
 *
 * Only concrete subjects are cached — never a capability class. "Allow for this
 * session" on `npm install` does not grant `curl`.
 */
export class SessionApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  record(subjectKey: string, granted: boolean, summary: string, at: number): void {
    this.records.set(subjectKey, { subjectKey, granted, decidedAt: at, summary });
  }

  lookup(subjectKey: string): ApprovalRecord | undefined {
    return this.records.get(subjectKey);
  }

  reset(): void {
    this.records.clear();
  }

  entries(): ApprovalRecord[] {
    return [...this.records.values()].sort((a, b) => a.decidedAt - b.decidedAt);
  }

  get size(): number {
    return this.records.size;
  }
}

export interface PolicyEngineOptions {
  workspaceRoot: CanonicalPath;
  protectedPaths: ProtectedPaths;
  /** Ordered from broadest to narrowest. Order affects reporting, not outcome. */
  layers: readonly PolicyLayer[];
  approvals?: SessionApprovalStore;
}

export class PolicyEngine {
  readonly workspaceRoot: CanonicalPath;
  readonly approvals: SessionApprovalStore;
  private readonly protectedPaths: ProtectedPaths;
  private readonly layers: readonly PolicyLayer[];

  constructor(opts: PolicyEngineOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.protectedPaths = opts.protectedPaths;
    this.layers = opts.layers;
    this.approvals = opts.approvals ?? new SessionApprovalStore();
  }

  /**
   * Derive a narrower engine by appending a layer.
   *
   * This is how a subagent, skill or hook gets its capability set. Because the
   * combination rule is "strictest wins", the result is provably ≤ the parent.
   */
  narrow(layer: PolicyLayer): PolicyEngine {
    return new PolicyEngine({
      workspaceRoot: this.workspaceRoot,
      protectedPaths: this.protectedPaths,
      layers: [...this.layers, layer],
      approvals: this.approvals,
    });
  }

  describeLayers(): Array<{ name: string; source: PolicySource; profile: string }> {
    return this.layers.map((l) => ({ name: l.name, source: l.source, profile: l.profile.name }));
  }

  decide(access: AccessRequest): PolicyDecision {
    const subjectKey = subjectKeyOf(access);

    // ---- 1. System hard ceilings. Nothing below can reach past these. ----
    const hard = this.systemHardDeny(access, subjectKey);
    if (hard) return hard;

    // ---- 2. Layer votes: strictest wins. ----
    // `winner` names the layer that actually constrains the request, which is
    // what `/permissions explain` needs to show.
    let action: PolicyAction = 'allow';
    let winner: { layer: PolicyLayer; rule?: PolicyRule } | undefined;

    for (const layer of this.layers) {
      const vote = evaluateProfile(layer.profile, access);
      if (winner === undefined || isStricter(vote.action, action)) {
        const w: { layer: PolicyLayer; rule?: PolicyRule } = { layer };
        if (vote.rule) w.rule = vote.rule;
        winner = w;
        action = vote.action;
      }
    }

    const outsideWorkspace = isPathAccess(access) && !isWithin(this.workspaceRoot, accessPath(access));

    // ---- 3. Session approval cache turns a repeated `ask` into a decision. ----
    if (action === 'ask') {
      const cached = this.approvals.lookup(subjectKey);
      if (cached) {
        const decision: PolicyDecision = {
          action: cached.granted ? 'allow' : 'deny',
          access,
          subjectKey,
          reason: cached.granted
            ? `Approved for this session: ${cached.summary}`
            : `Denied for this session: ${cached.summary}`,
          final: false,
          errorCode: errorCodeFor(access, outsideWorkspace),
        };
        if (outsideWorkspace) decision.outsideWorkspace = true;
        return decision;
      }
    }

    const decision: PolicyDecision = {
      action,
      access,
      subjectKey,
      reason: winner?.rule?.note ?? defaultReason(action, access, winner?.layer.profile.name),
      final: false,
      errorCode: errorCodeFor(access, outsideWorkspace),
    };
    if (winner) {
      decision.layer = winner.layer.name;
      decision.source = winner.layer.source;
      if (winner.rule) decision.rule = winner.rule;
    }
    if (outsideWorkspace) decision.outsideWorkspace = true;
    return decision;
  }

  decideBatch(accesses: readonly AccessRequest[]): PolicyDecision[] {
    return accesses.map((a) => this.decide(a));
  }

  /**
   * Reduce a set of decisions to the single action that governs the tool call.
   * A tool runs only if *every* access it declared is permitted.
   */
  static combine(decisions: readonly PolicyDecision[]): PolicyAction {
    return decisions.reduce<PolicyAction>((acc, d) => strictest(acc, d.action), 'allow');
  }

  private systemHardDeny(access: AccessRequest, subjectKey: string): PolicyDecision | undefined {
    const mk = (reason: string, code: ErrorCode): PolicyDecision => ({
      action: 'hard_deny',
      access,
      subjectKey,
      reason,
      layer: 'system-ceiling',
      source: 'system',
      final: true,
      errorCode: code,
    });

    switch (access.kind) {
      case 'file.read': {
        const verdict: ProtectionVerdict = access.toModel
          ? this.protectedPaths.checkReadToModel(access.path)
          : this.protectedPaths.checkRead(access.path);
        if (verdict.protected) {
          return mk(ProtectedPaths.explain(verdict, access.display), 'PROTECTED_PATH');
        }
        return undefined;
      }

      case 'file.write': {
        const verdict = this.protectedPaths.checkWrite(access.path);
        if (verdict.protected) {
          return mk(ProtectedPaths.explain(verdict, access.display), 'PROTECTED_PATH');
        }
        return undefined;
      }

      case 'process.exec': {
        const exe = basename(access.executable);
        if (PRIVILEGE_ESCALATION.includes(exe)) {
          return mk(
            `"${exe}" escalates privilege and is permanently denied. This cannot be approved.`,
            'TOOL_DENIED',
          );
        }
        // `sudo` hidden behind a shell wrapper.
        const argv = access.argv.join(' ');
        if (/(^|[\s;&|(])sudo\s/.test(argv) || /(^|[\s;&|(])doas\s/.test(argv)) {
          return mk(
            'The command invokes sudo/doas. Privilege escalation is permanently denied.',
            'TOOL_DENIED',
          );
        }
        return undefined;
      }

      case 'network.connect': {
        if (access.via === 'telemetry') {
          // Telemetry may exist, but never as a content channel; the egress gate
          // enforces the field allowlist. Nothing to hard-deny here.
          return undefined;
        }
        return undefined;
      }

      case 'remote.connect':
        return undefined;

      case 'env.read': {
        // Reading the raw host environment is never granted: credentials live in
        // it, and `scrubEnv` is the supported way to build a child environment.
        return mk(
          'Dumping the host environment is permanently denied. Use secret_ref:// for credentials a command genuinely needs.',
          'SECRET_ACCESS_DENIED',
        );
      }

      case 'secret.use':
      case 'vcs.mutate':
        return undefined;
    }
  }
}

interface ProfileVote {
  action: PolicyAction;
  rule?: PolicyRule;
}

/**
 * Evaluate one profile.
 *
 * Within a profile the **most specific** matching rule wins, except that a
 * `hard_deny` always wins. Specificity keeps `allow network registry.npmjs.org`
 * meaningful in the presence of `ask network *`, which a plain strictest-wins
 * rule would swallow.
 */
function evaluateProfile(profile: PermissionProfile, access: AccessRequest): ProfileVote {
  const capability = capabilityOf(access);
  const target = matchTargetOf(access);

  let best: { rule: PolicyRule; score: number } | undefined;

  for (const rule of profile.rules) {
    if (rule.capability !== '*' && rule.capability !== capability) continue;
    if (!ruleMatches(rule, access, target)) continue;

    if (rule.action === 'hard_deny') return { action: 'hard_deny', rule };

    const score = specificity(rule);
    if (!best || score > best.score) {
      best = { rule, score };
    } else if (score === best.score && isStricter(rule.action, best.rule.action)) {
      // Equal specificity: the stricter rule wins, so an ambiguous profile
      // fails closed.
      best = { rule, score };
    }
  }

  if (!best) return { action: profile.fallback };
  return { action: best.rule.action, rule: best.rule };
}

function ruleMatches(rule: PolicyRule, access: AccessRequest, target: string): boolean {
  if (rule.pattern !== undefined) {
    const value = access.kind === 'file.read' || access.kind === 'file.write' ? toPosix(target) : target;
    const alsoBasename = access.kind === 'process.exec' ? basename(value) : value;
    if (!globMatch(rule.pattern, value) && !globMatch(rule.pattern, alsoBasename)) return false;
  }

  if (rule.argvPattern !== undefined) {
    if (access.kind !== 'process.exec') return false;
    const argvLine = [basename(access.executable), ...access.argv.slice(1)].join(' ');
    const fullLine = access.argv.join(' ');
    if (!globMatch(rule.argvPattern, argvLine) && !globMatch(rule.argvPattern, fullLine)) return false;
  }

  if (rule.via !== undefined) {
    if (access.kind !== 'network.connect') return false;
    if (!rule.via.includes(access.via)) return false;
  }

  if (rule.ports !== undefined) {
    if (access.kind !== 'network.connect') return false;
    if (!rule.ports.includes(access.port)) return false;
  }

  return true;
}

/**
 * How narrow a rule is. Higher wins within a profile.
 *
 * Specificity is about how *few* things a pattern matches, which is not the same
 * as how long it is. `{node,npm,pnpm,…,git,rg,…}` is a very long pattern that
 * matches fifty executables; `git` is short and matches one. Scoring by raw
 * length made the broad rule win, which silently turned `git status` into an
 * approval prompt and let `npm install` through without one.
 *
 * So: literal text counts for specificity, alternatives and wildcards count
 * against it, and a rule with no pattern at all is a catch-all that loses to
 * anything with a pattern.
 */
function specificity(rule: PolicyRule): number {
  const patterns = [rule.pattern, rule.argvPattern].filter((p): p is string => p !== undefined);

  if (patterns.length === 0) {
    // A bare `{ action: 'ask', capability: 'process.exec' }` is the fallback for
    // "anything else", and must never outrank a rule that named something.
    let base = -1000;
    if (rule.via) base += 5;
    if (rule.ports) base += 5;
    return base;
  }

  let score = 0;
  for (const pattern of patterns) {
    score += 20;
    score += literalLength(pattern);
    score -= alternativeCount(pattern);
    score -= (pattern.match(/\*\*/g) ?? []).length * 12;
    score -= (pattern.match(/(?<!\*)\*(?!\*)/g) ?? []).length * 6;
  }
  if (rule.via) score += 5;
  if (rule.ports) score += 5;
  return score;
}

/** Characters outside any brace group: the part that must match exactly. */
function literalLength(pattern: string): number {
  return pattern.replace(/\{[^{}]*\}/g, '').replace(/[*?]/g, '').length;
}

/** Total number of alternatives across all brace groups. */
function alternativeCount(pattern: string): number {
  let total = 0;
  for (const match of pattern.matchAll(/\{([^{}]*)\}/g)) {
    total += match[1]!.split(',').length;
  }
  return total;
}

function defaultReason(action: PolicyAction, access: AccessRequest, profile?: string): string {
  const what = describeAccess(access);
  switch (action) {
    case 'allow':
      return `Permitted by ${profile ?? 'the active profile'}: ${what}.`;
    case 'ask':
      return `Approval required to ${what}.`;
    case 'deny':
      return `Not permitted by ${profile ?? 'the active profile'}: ${what}.`;
    case 'hard_deny':
      return `Permanently denied: ${what}.`;
  }
}

function isPathAccess(access: AccessRequest): access is Extract<AccessRequest, { path: CanonicalPath }> {
  return access.kind === 'file.read' || access.kind === 'file.write';
}

function accessPath(access: Extract<AccessRequest, { path: CanonicalPath }>): CanonicalPath {
  return access.path;
}

function errorCodeFor(access: AccessRequest, outsideWorkspace: boolean): ErrorCode {
  if (isPathAccess(access) && outsideWorkspace) return 'PATH_OUTSIDE_WORKSPACE';
  switch (access.kind) {
    case 'network.connect':
      return 'NETWORK_DENIED';
    case 'secret.use':
      return 'SECRET_ACCESS_DENIED';
    default:
      return 'TOOL_DENIED';
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

/** Turn a blocking decision into the structured error the model will see. */
export function decisionToError(decision: PolicyDecision): KernelError {
  const details: Record<string, unknown> = {
    capability: capabilityOf(decision.access),
    subject: decision.subjectKey,
  };
  if (decision.layer) details.deniedBy = decision.layer;
  if (decision.final) details.appealable = false;

  return kernelError(decision.errorCode, decision.reason, {
    blame: decision.final ? 'kernel' : 'user',
    retryable: false,
    safeDetails: details,
  });
}
