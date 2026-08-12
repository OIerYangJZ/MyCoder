/**
 * Sandbox planner.
 *
 * Turns a set of *granted* policy decisions into the concrete
 * `CapabilityProfile` the executor will enforce. This is the seam between
 * "decision" and "enforcement" that spec §2.3 insists on: the planner never
 * re-decides anything, it only translates.
 *
 * The translation is deliberately narrow. A granted `file.write` on one path
 * becomes a write root of exactly that path — not its directory — so an approval
 * to modify `src/auth.ts` cannot be spent on `src/anything-else.ts`.
 */

import * as path from 'node:path';

import type { CanonicalPath } from '../util/paths.ts';
import type { AccessRequest } from '../policy/access.ts';
import type { PolicyDecision } from '../policy/policy-engine.ts';
import type { SecretLease } from '../security/secret-broker.ts';
import type { CapabilityProfile, SandboxStrength } from './backend.ts';

export interface SandboxPlanOptions {
  workspaceRoot: CanonicalPath;
  /** Always writable scratch space. */
  agentTmpDir?: CanonicalPath;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Extra non-secret environment names the tool asked for. */
  envAllow?: readonly string[];
  secretInjections?: ReadonlyArray<{ envName: string; lease: SecretLease }>;
}

export interface SandboxPlan {
  profile: CapabilityProfile;
  /** Accesses that were granted, for the audit record. */
  granted: readonly AccessRequest[];
  /** Accesses that were refused; the caller turns these into a tool error. */
  refused: readonly PolicyDecision[];
}

export class SandboxPlanner {
  private readonly options: SandboxPlanOptions;

  constructor(options: SandboxPlanOptions) {
    this.options = options;
  }

  plan(decisions: readonly PolicyDecision[]): SandboxPlan {
    const readRoots = new Set<string>();
    const writeRoots = new Set<string>();
    const hosts = new Set<string>();
    const granted: AccessRequest[] = [];
    const refused: PolicyDecision[] = [];

    let allowExec = false;
    let anyNetwork = false;

    for (const decision of decisions) {
      if (decision.action !== 'allow') {
        refused.push(decision);
        continue;
      }
      granted.push(decision.access);

      switch (decision.access.kind) {
        case 'file.read':
          readRoots.add(decision.access.path);
          break;
        case 'file.write':
          writeRoots.add(decision.access.path);
          // A create needs its parent directory to be reachable.
          writeRoots.add(path.dirname(decision.access.path));
          readRoots.add(decision.access.path);
          break;
        case 'process.exec':
          allowExec = true;
          readRoots.add(decision.access.cwd);
          break;
        case 'network.connect':
          anyNetwork = true;
          hosts.add(decision.access.host);
          break;
        default:
          break;
      }
    }

    // A process needs to see the workspace to do anything useful, and the tools
    // that read files inside it have already been individually decided.
    if (allowExec) readRoots.add(this.options.workspaceRoot);
    if (this.options.agentTmpDir) {
      readRoots.add(this.options.agentTmpDir);
      if (allowExec || writeRoots.size > 0) writeRoots.add(this.options.agentTmpDir);
    }

    const profile: CapabilityProfile = {
      readRoots: [...readRoots] as CanonicalPath[],
      writeRoots: [...writeRoots] as CanonicalPath[],
      allowExec,
      network: anyNetwork ? { hosts: [...hosts] } : false,
      envAllow: this.options.envAllow ?? [],
      secretInjections: this.options.secretInjections ?? [],
      timeoutMs: this.options.timeoutMs ?? 120_000,
      maxOutputBytes: this.options.maxOutputBytes ?? 8 * 1024 * 1024,
    };

    return { profile, granted, refused };
  }
}

/**
 * Describe the isolation the user is actually getting.
 *
 * Invariant 5 forbids presenting a best-effort policy as strong isolation, so
 * this returns the caveat text as well as the label, and the CLI prints both.
 */
export function describeSandbox(strength: SandboxStrength): { label: string; caveat: string } {
  if (strength === 'os-isolated') {
    return {
      label: 'os-isolated',
      caveat: 'Processes run inside an OS sandbox with enforced filesystem and network boundaries.',
    };
  }
  return {
    label: 'policy-enforced',
    caveat:
      'Kernel policy governs what tools may request, and all tool output is redacted, ' +
      'but subprocesses are not OS-isolated: a process that runs can still reach the ' +
      'filesystem and network with your user rights. Use a container backend for strong isolation.',
  };
}

/**
 * Whether "network is off" can be stated as a fact.
 *
 * With only policy enforcement it is best-effort (spec §12.3), and the CLI must
 * say "best-effort" rather than "blocked".
 */
export function networkEnforcementLevel(strength: SandboxStrength): 'enforced' | 'best-effort' {
  return strength === 'os-isolated' ? 'enforced' : 'best-effort';
}
