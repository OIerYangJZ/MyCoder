/**
 * Shell string → argv (spec §9.2).
 *
 * The Shell tool accepts argv only. When a human types a command line, it is
 * parsed here first, and the result is either:
 *
 *   - a simple command, which becomes argv directly; or
 *   - a compound command (pipes, redirection, `&&`, subshells), which cannot be
 *     represented as argv and is turned into an explicit `bash -lc <line>` plan.
 *
 * Making that second case explicit is the point. A parser that silently
 * "supports" pipes by handing the whole string to a shell hides the fact that a
 * shell is involved — and the shell, not the kernel, then decides what runs.
 * Here the escalation is visible in the plan, in the approval prompt, and in the
 * audit event.
 */

export interface SimpleCommand {
  kind: 'simple';
  argv: string[];
}

export interface CompoundCommand {
  kind: 'compound';
  /** The original line, to be run under an explicit shell. */
  line: string;
  /** Which operators forced the escalation, for the approval prompt. */
  operators: string[];
  argv: string[];
}

export interface ParseFailure {
  kind: 'error';
  message: string;
}

export type ShellPlan = SimpleCommand | CompoundCommand | ParseFailure;

const OPERATORS: ReadonlyArray<{ token: string; label: string }> = [
  { token: '&&', label: 'and-list' },
  { token: '||', label: 'or-list' },
  { token: '|', label: 'pipe' },
  { token: ';', label: 'sequence' },
  { token: '>>', label: 'append-redirect' },
  { token: '>', label: 'redirect' },
  { token: '<', label: 'input-redirect' },
  { token: '&', label: 'background' },
  { token: '$(', label: 'command-substitution' },
  { token: '`', label: 'command-substitution' },
];

export interface ParseOptions {
  /** Shell to use for compound commands. */
  shell?: string;
}

export function parseShellLine(line: string, opts: ParseOptions = {}): ShellPlan {
  const trimmed = line.trim();
  if (trimmed === '') return { kind: 'error', message: 'Empty command.' };

  const tokens = tokenizeShell(trimmed);
  if (!tokens.ok) return { kind: 'error', message: tokens.message };

  const operators = detectOperators(tokens.tokens, trimmed);
  if (operators.length > 0) {
    const shell = opts.shell ?? 'bash';
    return {
      kind: 'compound',
      line: trimmed,
      operators,
      argv: [shell, '-lc', trimmed],
    };
  }

  const argv = tokens.tokens.map((t) => t.value);
  if (argv.length === 0) return { kind: 'error', message: 'Empty command.' };
  return { kind: 'simple', argv };
}

interface Token {
  value: string;
  /** True when the token came from unquoted text and may be an operator. */
  bare: boolean;
}

function tokenizeShell(line: string): { ok: true; tokens: Token[] } | { ok: false; message: string } {
  const tokens: Token[] = [];
  let current = '';
  let bare = true;
  let started = false;
  let quote: '"' | "'" | undefined;

  const push = (): void => {
    if (started) {
      tokens.push({ value: current, bare });
      current = '';
      bare = true;
      started = false;
    }
  };

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;

    if (quote === "'") {
      if (c === "'") quote = undefined;
      else current += c;
      started = true;
      continue;
    }

    if (quote === '"') {
      if (c === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) {
        current += line[i + 1];
        i += 1;
      } else if (c === '"') {
        quote = undefined;
      } else {
        current += c;
      }
      started = true;
      continue;
    }

    if (c === '\\') {
      if (i + 1 >= line.length) return { ok: false, message: 'Command ends with a dangling backslash.' };
      current += line[i + 1];
      i += 1;
      started = true;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      bare = false;
      started = true;
      continue;
    }

    if (/\s/.test(c)) {
      push();
      continue;
    }

    current += c;
    started = true;
  }

  if (quote) return { ok: false, message: `Unterminated ${quote === '"' ? 'double' : 'single'} quote.` };
  push();

  return { ok: true, tokens };
}

/**
 * Find shell operators in unquoted text.
 *
 * Quoted operators do not count: `grep "a|b" file` is a simple command, and
 * treating it as a pipeline would be both wrong and a needless escalation.
 */
function detectOperators(tokens: readonly Token[], line: string): string[] {
  const found = new Set<string>();

  for (const token of tokens) {
    if (!token.bare) continue;
    for (const op of OPERATORS) {
      if (token.value.includes(op.token)) found.add(op.label);
    }
  }

  // Backticks and `$(` can span tokens; check the raw line outside quotes too.
  if (/(^|[^\\'"])\$\(/.test(line)) found.add('command-substitution');

  return [...found];
}

/** Human-readable description for the approval prompt. */
export function describePlan(plan: ShellPlan): string {
  switch (plan.kind) {
    case 'simple':
      return plan.argv.join(' ');
    case 'compound':
      return `${plan.line}\n  (runs under a shell because it uses: ${plan.operators.join(', ')})`;
    case 'error':
      return `unparsable: ${plan.message}`;
  }
}
