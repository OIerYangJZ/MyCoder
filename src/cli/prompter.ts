/**
 * Interactive approval UI (spec §11.4).
 *
 * The prompt shows **semantics, not a command string**: what the tool wants to
 * do, to which files, over which network destination, and how long the decision
 * lasts. Echoing back `npm install zod` tells the user nothing they did not
 * already type; "reaches registry.npmjs.org:443 and will modify package.json and
 * the lockfile" is a decision they can actually make.
 *
 * Scope is deliberately limited to this call or this session, and a session
 * approval is remembered against a concrete subject — never a capability class.
 */

import type { Interface as ReadlineInterface } from 'node:readline/promises';

import { describeAccess } from '../policy/access.ts';
import type { ApprovalOutcome, ApprovalPrompter, ApprovalRequest } from '../tools/runtime.ts';

export interface TerminalPrompterOptions {
  rl: ReadlineInterface;
  write?: (text: string) => void;
  /** Default when the user just presses enter. Denial, deliberately. */
  defaultDeny?: boolean;
}

export class TerminalApprovalPrompter implements ApprovalPrompter {
  private readonly rl: ReadlineInterface;
  private readonly write: (text: string) => void;

  constructor(opts: TerminalPrompterOptions) {
    this.rl = opts.rl;
    this.write = opts.write ?? ((t) => process.stderr.write(t));
  }

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.write(`\n${renderApproval(request)}\n`);

    for (;;) {
      const answer = (await this.rl.question('  [y] once  [s] this session  [n] no  [d] deny for session > '))
        .trim()
        .toLowerCase();

      switch (answer) {
        case 'y':
        case 'yes':
          return { decision: 'allow', scope: 'once' };
        case 's':
        case 'session':
          return { decision: 'allow', scope: 'session' };
        case 'n':
        case 'no':
        case '':
          return { decision: 'deny', scope: 'once' };
        case 'd':
          return { decision: 'deny', scope: 'session', reason: 'denied for the rest of this session' };
        default:
          this.write('  Please answer y, s, n or d.\n');
      }
    }
  }
}

/** Rendered separately so tests can assert on the text without a terminal. */
export function renderApproval(request: ApprovalRequest): string {
  const lines: string[] = [];
  const risk = request.subject.risk;

  lines.push(`Approval required${risk === 'high' ? '  (high risk)' : ''}`);
  lines.push(`  tool     : ${request.toolName}`);
  lines.push(`  action   : ${request.subject.title}`);

  for (const detail of request.subject.details) {
    lines.push(`  ${detail}`);
  }

  // Spell out every capability that is actually being asked for, not just the
  // headline one: an approval that hides a second access is not informed.
  if (request.pending.length > 0) {
    lines.push('  requires :');
    for (const decision of request.pending) {
      lines.push(`    - ${describeAccess(decision.access)}`);
      if (decision.reason) lines.push(`      (${decision.reason})`);
    }
  }

  if (request.diff) {
    const preview = request.diff.split('\n').slice(0, 40).join('\n');
    lines.push('  diff     :');
    lines.push(preview.replace(/^/gm, '    '));
    if (request.diff.split('\n').length > 40) lines.push('    … (truncated)');
  }

  lines.push('  scope    : this call only, or the rest of this session for exactly this action');

  return lines.join('\n');
}

/** Prompter that answers from a script. Used by tests and `--yes`-style runs. */
export class ScriptedPrompter implements ApprovalPrompter {
  private readonly answers: ApprovalOutcome[];
  private readonly fallback: ApprovalOutcome;
  readonly seen: ApprovalRequest[] = [];
  private index = 0;

  constructor(answers: ApprovalOutcome[], fallback: ApprovalOutcome = { decision: 'deny', scope: 'once' }) {
    this.answers = answers;
    this.fallback = fallback;
  }

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.seen.push(request);
    const answer = this.answers[this.index];
    this.index += 1;
    return answer ?? this.fallback;
  }
}
