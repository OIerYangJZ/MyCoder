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
import { select, type KeySource } from './select.ts';
import {
  box,
  diffBlock,
  glyphs as glyphSet,
  palette as makePalette,
  type Glyphs,
  type Palette,
} from './render.ts';

export interface TerminalPrompterOptions {
  rl: ReadlineInterface;
  write?: (text: string) => void;
  /** Default when the user just presses enter. Denial, deliberately. */
  defaultDeny?: boolean;
  /** Styling. Absent means plain text, which is what a pipe and a test get. */
  palette?: Palette;
  glyphs?: Glyphs;
  columns?: () => number;
  /**
   * Stop whatever else is drawing on the terminal, before this prompt draws.
   *
   * An approval opens *during* a tool call, and the renderer's spinner is running
   * for exactly that tool call. The spinner erases its own line every 90ms with
   * carriage-return and erase-to-end — which is the line the user is typing the
   * answer on. The keystrokes reached readline and Enter worked, so the prompt
   * functioned; it simply could not be seen, and what stayed on screen was
   * `⠹ Running Shell` with the cursor after it.
   *
   * Optional because the scripted and piped paths have nothing to quieten.
   */
  quiet?: () => void;
  /**
   * Raw keys, for the arrow-key menu. Absent means no terminal, and the typed
   * prompt is used instead — a scripted or piped run has no arrows to press.
   */
  keys?: KeySource;
}

export class TerminalApprovalPrompter implements ApprovalPrompter {
  private readonly rl: ReadlineInterface;
  private readonly write: (text: string) => void;
  private readonly p: Palette;
  private readonly g: Glyphs;
  private readonly columns: () => number;
  private readonly quiet: () => void;
  private readonly keys: KeySource | undefined;

  constructor(opts: TerminalPrompterOptions) {
    this.rl = opts.rl;
    this.write = opts.write ?? ((t) => process.stderr.write(t));
    this.p = opts.palette ?? makePalette(false);
    this.g = opts.glyphs ?? glyphSet(false);
    this.columns = opts.columns ?? (() => 80);
    this.quiet = opts.quiet ?? ((): void => {});
    this.keys = opts.keys;
  }

  /**
   * The one screen the user is *required* to read, so it gets the frame.
   *
   * A diff is rendered with its own colours and everything else stays as
   * `renderApproval` wrote it: the text of an approval is a security surface and
   * this is presentation only. The answers are numbered as well as lettered because
   * `[y]` and `[s]` are indistinguishable to somebody who has not read this before.
   */
  private frame(request: ApprovalRequest): string {
    const lines = renderApproval(request)
      .split('\n')
      .map((line) => (/^\s{4}[-+@]/.test(line) ? diffBlock(line, this.p) : line));
    // High risk is said on the title row, in red, rather than only in the prose
    // underneath: it is the one word that changes how carefully the rest is read,
    // and a reader who skips to the menu should not be able to miss it.
    const risk = request.subject.risk === 'high' ? `  ${this.p.red('high risk')}` : '';
    const title = `${this.p.accentBold(this.g.mark)} ${this.p.accentBold('Approval required')}${risk}`;
    // `renderApproval`'s first line is the same title in plain text, for the tests
    // and the non-terminal path; the framed version has just drawn its own.
    return box([title, '', ...lines.slice(1)], this.p, this.g, this.columns());
  }

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.quiet();
    this.write(`\n${this.frame(request)}\n`);

    const choices = approvalChoices(request);
    if (this.keys) {
      // Arrow keys need the terminal to themselves, and readline is holding it.
      this.rl.pause();
      try {
        const picked = await select({
          items: choices.map((c) => c.label),
          // On the safe answer. Enter without reading must not grant anything, which
          // was true of the typed prompt and stays true here.
          initial: choices.findIndex((c) => c.outcome.decision === 'deny'),
          write: this.write,
          palette: this.p,
          glyphs: this.g,
          input: this.keys,
          columns: this.columns,
        });
        // Abandoned with Escape or Ctrl-C. The caller decides what that means and
        // here it means no — the one reading it is a security question.
        return choices[picked ?? -1]?.outcome ?? { decision: 'deny', scope: 'once' };
      } finally {
        this.rl.resume();
      }
    }

    return this.typed(choices);
  }

  /**
   * The typed prompt, for anything without a terminal.
   *
   * Not a lesser version kept around for tests: a piped or scripted run has no arrow
   * keys, and a menu that answered itself would answer a security question wrong.
   */
  private async typed(choices: readonly ApprovalChoice[]): Promise<ApprovalOutcome> {
    for (;;) {
      // Again on every pass: an unrecognised answer loops, and anything that
      // arrived in the meantime may have started the spinner up again.
      this.quiet();
      const answer = (
        await this.rl.question(
          `  ${this.p.accentBold('[y]')} once  ${this.p.accentBold('[s]')} this session  ` +
            `${this.p.accentBold('[n]')} no  ${this.p.accentBold('[d]')} deny for session ${this.p.grey('>')} `,
        )
      )
        .trim()
        .toLowerCase();

      const key = ANSWER_KEYS[answer];
      if (key !== undefined) {
        const found = choices.find((c) => c.key === key);
        if (found) return found.outcome;
      }
      this.write('  Please answer y, s, n or d.\n');
    }
  }
}

/** The letters the typed prompt has always accepted, mapped onto the same choices. */
const ANSWER_KEYS: Readonly<Record<string, string>> = {
  y: 'y',
  yes: 'y',
  s: 's',
  session: 's',
  n: 'n',
  no: 'n',
  '': 'n',
  d: 'd',
};

export interface ApprovalChoice {
  key: string;
  label: string;
  outcome: ApprovalOutcome;
}

/**
 * The four answers, in the words of what they do.
 *
 * `[y]` and `[s]` are indistinguishable to somebody who has not read the code, and
 * the difference between them is how long the grant lasts — which is the whole of the
 * decision. Spelling the subject into the two lasting answers means the screen says
 * what is being remembered, rather than the reader having to hold it from the box
 * above.
 *
 * Denial keeps its lasting form too. Dropping it would have made the menu tidier and
 * quietly removed an answer somebody may be relying on.
 */
export function approvalChoices(request: ApprovalRequest): ApprovalChoice[] {
  const what = request.subject.title;
  return [
    { key: 'y', label: 'Yes', outcome: { decision: 'allow', scope: 'once' } },
    {
      key: 's',
      label: `Yes, and don't ask again for: ${what}`,
      outcome: { decision: 'allow', scope: 'session' },
    },
    { key: 'n', label: 'No', outcome: { decision: 'deny', scope: 'once' } },
    {
      key: 'd',
      label: `No, and don't ask again for: ${what}`,
      outcome: { decision: 'deny', scope: 'session', reason: 'denied for the rest of this session' },
    },
  ];
}

/**
 * Rendered separately so tests can assert on the text without a terminal.
 *
 * The labels used to be padded by hand — `tool     :`, `action   :` — and the hand
 * was wrong: `delegation:` is ten characters where the others are nine, so the one
 * screen a user is *required* to read had its colons out of line exactly when a
 * subagent was asking, which is the case that needs reading most carefully. They
 * are padded from the widest label present now, so the column is right whatever
 * set of rows this particular request produces.
 */
export function renderApproval(request: ApprovalRequest): string {
  const lines: string[] = [];
  const risk = request.subject.risk;

  lines.push(`Approval required${risk === 'high' ? '  (high risk)' : ''}`);

  // A child's action is attributed to the child (alpha.4 §40). Showing a
  // delegated `npm install` as though the root agent had asked for it would put
  // the user's trust in the wrong place — and "which agent wants this" is often
  // the whole basis for the decision.
  const rows: Array<[string, string]> = request.delegation
    ? [
        ['agent', `${request.delegation.agent}  (subagent, depth ${request.delegation.depth})`],
        ['delegation', request.delegation.delegationId],
        ['tool', request.toolName],
        ['child action', request.subject.title],
      ]
    : [
        ['tool', request.toolName],
        ['action', request.subject.title],
      ];

  // Every label that will be printed, the ones below included, so the colons line
  // up down the whole box rather than down the first half of it.
  const labels = [...rows.map(([k]) => k), 'scope'];
  if (request.pending.length > 0) labels.push('requires');
  if (request.diff) labels.push('diff');
  const width = Math.max(...labels.map((label) => label.length));
  const row = (label: string, value?: string): string =>
    `  ${label.padEnd(width)} :${value === undefined ? '' : ` ${value}`}`;

  for (const [label, value] of rows) lines.push(row(label, value));

  for (const detail of request.subject.details) {
    lines.push(`  ${detail}`);
  }

  // Spell out every capability that is actually being asked for, not just the
  // headline one: an approval that hides a second access is not informed.
  if (request.pending.length > 0) {
    lines.push(row('requires'));
    for (const decision of request.pending) {
      lines.push(`    - ${describeAccess(decision.access)}`);
      if (decision.reason) lines.push(`      (${decision.reason})`);
    }
  }

  if (request.diff) {
    const preview = request.diff.split('\n').slice(0, 40).join('\n');
    lines.push(row('diff'));
    lines.push(preview.replace(/^/gm, '    '));
    if (request.diff.split('\n').length > 40) lines.push('    … (truncated)');
  }

  lines.push(row('scope', 'this call only, or the rest of this session for exactly this action'));

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
