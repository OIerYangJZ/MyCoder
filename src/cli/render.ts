/**
 * How a session looks while it is working.
 *
 * Until alpha.12 a turn was silent: the model worked, tools ran, and the terminal
 * printed nothing until the final answer. Everything needed to show the work was
 * already in the session's event stream — `tool.call` carries the name and the
 * arguments, `tool.result` carries the outcome — and nothing was watching it.
 *
 * So this module is a **renderer, not a TUI**. Spec §1.3 lists a full TUI under
 * NON-GOALS and that is unchanged: there is no alternate screen, no panes, no mouse,
 * no cursor addressing beyond one line of spinner that erases itself. It formats
 * events that already happen, and if it were deleted the kernel would behave
 * identically.
 *
 * Three constraints shape every choice here:
 *
 *   **Zero dependencies** (ADR-0009). No `chalk`, no `ink`. The escape codes are
 *   written out, which is also why they are all in one place with one switch.
 *
 *   **Every byte goes to stderr**, because stdout is a contract: `--json` puts one
 *   object per line there and `mycoder … | jq` must never have to filter human
 *   text out of its input (`docs/cli-contract.md`).
 *
 *   **Plain when it is not a terminal.** Styling a pipe writes escape codes into
 *   somebody's log file. The same switch also drops the box-drawing and the
 *   Braille spinner, because a CI log and `cmd.exe` are the two places those come
 *   out as mojibake.
 */

/** One place where the escape codes live. */
export interface Palette {
  on: boolean;
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

const wrap = (on: boolean, code: string) => (s: string) => (on ? `[${code}m${s}[0m` : s);

export function palette(on: boolean): Palette {
  return {
    on,
    dim: wrap(on, '2'),
    bold: wrap(on, '1'),
    red: wrap(on, '31'),
    green: wrap(on, '32'),
    yellow: wrap(on, '33'),
    cyan: wrap(on, '36'),
  };
}

/**
 * Whether to colour at all.
 *
 * `NO_COLOR` wins over everything, including `FORCE_COLOR`: it is the one
 * convention a user sets *because* something got this wrong before.
 */
export function colourEnabled(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return isTty;
}

export interface Glyphs {
  call: string;
  result: string;
  ok: string;
  bad: string;
  prompt: string;
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  spinner: readonly string[];
}

/** Box drawing and Braille when the terminal can take it; ASCII when it cannot. */
export function glyphs(fancy: boolean): Glyphs {
  return fancy
    ? {
        call: '⏺',
        result: '⎿',
        ok: '✓',
        bad: '✗',
        prompt: '❯',
        topLeft: '╭',
        topRight: '╮',
        bottomLeft: '╰',
        bottomRight: '╯',
        horizontal: '─',
        vertical: '│',
        spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
      }
    : {
        call: '*',
        result: '`-',
        ok: 'ok',
        bad: 'x',
        prompt: '>',
        topLeft: '+',
        topRight: '+',
        bottomLeft: '+',
        bottomRight: '+',
        horizontal: '-',
        vertical: '|',
        spinner: ['-', '\\', '|', '/'],
      };
}

/** Visible width, ignoring the escape codes this module writes. */
export function visibleWidth(s: string): number {
  return s.replace(/\[[0-9;]*m/g, '').length;
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

/**
 * The one interesting thing about a tool call, in the words the user typed.
 *
 * `tool.call`'s `argsSummary` is JSON, up to 400 characters of it, which is right
 * for an audit log and useless in a terminal: `Read({"path":"src/app.ts",…})` buries
 * the only part anybody reads. So the field is picked per tool, and the fallback is
 * the raw summary rather than nothing — a tool this does not know about still shows
 * something true.
 */
export function summariseArgs(name: string, argsSummary: string, max = 64): string {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argsSummary);
    if (parsed === null || typeof parsed !== 'object') return truncate(argsSummary, max);
    args = parsed as Record<string, unknown>;
  } catch {
    return truncate(argsSummary, max);
  }

  const str = (key: string): string | undefined =>
    typeof args[key] === 'string' ? (args[key] as string) : undefined;

  switch (name) {
    case 'Shell': {
      const argv = args.argv;
      if (Array.isArray(argv)) return truncate(argv.map(String).join(' '), max);
      break;
    }
    case 'Grep': {
      const pattern = str('pattern');
      const where = str('path');
      if (pattern !== undefined) return truncate(where ? `${pattern} in ${where}` : pattern, max);
      break;
    }
    case 'Move': {
      const from = str('from');
      const to = str('to');
      if (from !== undefined && to !== undefined) return truncate(`${from} → ${to}`, max);
      break;
    }
    case 'Delegate': {
      const agent = str('agent');
      if (agent !== undefined) return truncate(agent, max);
      break;
    }
  }

  for (const key of ['path', 'displayPath', 'pattern', 'url', 'name', 'query']) {
    const value = str(key);
    if (value !== undefined) return truncate(value, max);
  }
  return truncate(argsSummary, max);
}

/** `⏺ Read(src/app.ts)` — the line that says work is happening. */
export function toolCallLine(name: string, argsSummary: string, p: Palette, g: Glyphs): string {
  const summary = summariseArgs(name, argsSummary);
  return `${p.cyan(g.call)} ${p.bold(name)}${p.dim(`(${summary})`)}`;
}

export interface ResultInfo {
  isError?: boolean;
  errorCode?: string;
  contentBytes?: number;
}

/** `  ⎿ 1.2 kB` under the call, or the error code in red. */
export function toolResultLine(info: ResultInfo, p: Palette, g: Glyphs): string {
  if (info.isError === true) {
    const what = info.errorCode ?? 'failed';
    return `  ${p.red(g.result)} ${p.red(what)}`;
  }
  return `  ${p.dim(g.result)} ${p.dim(formatBytes(info.contentBytes ?? 0))}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A rounded box, or an ASCII one. Lines are not wrapped; they are truncated. */
export function box(lines: readonly string[], p: Palette, g: Glyphs, width = 72): string {
  const inner = Math.max(...lines.map(visibleWidth), 0);
  const w = Math.min(Math.max(inner, 8), width - 4);
  const bar = g.horizontal.repeat(w + 2);
  const out: string[] = [p.dim(`${g.topLeft}${bar}${g.topRight}`)];

  for (const line of lines) {
    const pad = ' '.repeat(Math.max(0, w - visibleWidth(line)));
    out.push(`${p.dim(g.vertical)} ${line}${pad} ${p.dim(g.vertical)}`);
  }
  out.push(p.dim(`${g.bottomLeft}${bar}${g.bottomRight}`));
  return out.join('\n');
}

export interface BannerInfo {
  version: string;
  model: string;
  profile: string;
  workspace: string;
  /**
   * How the isolation is described, from the enforcement descriptor — never a
   * literal (invariant 5, `no-enforcement-overclaim`).
   */
  isolation: string;
  /** The caveat that goes with it, in the words `/status` uses. */
  caveat: string;
}

/**
 * What you are about to run, and what it can reach. Printed once.
 *
 * The isolation line is **not decoration** and is not optional. Invariant 5 says
 * the user-facing surface must never present policy as strong isolation, and the
 * first draft of this banner replaced a `/status` dump that carried the honest
 * wording with a tidy `backend local` — which is how an accurate claim becomes a
 * missing one. `tests/integration/cli.test.ts` caught it, which is exactly what it
 * was written for (alpha.5 §41).
 */
export function banner(info: BannerInfo, p: Palette, g: Glyphs, width = 96): string {
  // `name        : value`, which is the shape `/status` already uses. Two surfaces
  // describing the same session should not need two vocabularies, and
  // `tests/integration/cli.test.ts` asserts on this shape.
  const row = (name: string, value: string): string => `${p.dim(`${name.padEnd(11)}:`)} ${value}`;

  return [
    box(
      [
        `${p.bold('MyCoder')} ${p.dim(info.version)}`,
        '',
        row('model', info.model),
        row('profile', info.profile),
        row('isolation', info.isolation),
        row('cwd', info.workspace),
      ],
      p,
      g,
      width,
    ),
    // Outside the box, wrapped: the caveat is several sentences and it is the part
    // invariant 5 is about, so it is neither truncated nor squeezed into a cell.
    wrapText(info.caveat, Math.min(width, 88))
      .map((line) => p.dim(line))
      .join('\n'),
  ].join('\n');
}

/** Greedy wrap. Long words are left long rather than broken mid-path. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/** `+`/`-` lines coloured, everything else left alone. */
export function diffBlock(diff: string, p: Palette, maxLines = 40): string {
  const lines = diff.split('\n');
  const shown = lines.slice(0, maxLines).map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return p.dim(line);
    if (line.startsWith('+')) return p.green(line);
    if (line.startsWith('-')) return p.red(line);
    if (line.startsWith('@@')) return p.cyan(line);
    return line;
  });
  if (lines.length > maxLines) shown.push(p.dim(`… ${lines.length - maxLines} more line(s)`));
  return shown.join('\n');
}

/**
 * One line that erases itself.
 *
 * The only cursor manipulation in this file, and it is `\r` plus "erase to end of
 * line" — nothing that survives the process or moves the cursor anywhere it was
 * not. Disabled entirely when not a terminal, where it would write a frame per
 * tick into a log file.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private text = '';
  private started = 0;

  private readonly write: (s: string) => void;
  private readonly p: Palette;
  private readonly g: Glyphs;
  private readonly enabled: boolean;
  private readonly now: () => number;

  // Explicit fields rather than parameter properties: `tsconfig.json` sets
  // `erasableSyntaxOnly`, because Node strips types rather than compiling them and
  // a parameter property is the one piece of TypeScript that has to *emit* code.
  constructor(
    write: (s: string) => void,
    p: Palette,
    g: Glyphs,
    enabled: boolean,
    now: () => number = Date.now,
  ) {
    this.write = write;
    this.p = p;
    this.g = g;
    this.enabled = enabled;
    this.now = now;
  }

  start(text: string): void {
    this.text = text;
    this.started = this.now();
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.tick(), 90);
    // Do not hold the process open for a spinner.
    this.timer.unref?.();
    this.tick();
  }

  /** Render one frame. Exposed so a test can drive it without a timer. */
  tick(): void {
    if (!this.enabled) return;
    const g = this.g.spinner;
    const frame = g[this.frame % g.length] ?? '';
    this.frame += 1;
    const seconds = Math.floor((this.now() - this.started) / 1000);
    const elapsed = seconds > 0 ? ` ${seconds}s` : '';
    this.write(`\r[K${this.p.cyan(frame)} ${this.p.dim(this.text + elapsed)}`);
  }

  /** Clear the line. Safe to call when never started. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.enabled) this.write('\r[K');
  }
}

export interface RendererOptions {
  write: (s: string) => void;
  palette: Palette;
  glyphs: Glyphs;
  /** False for `--json`, a pipe, or a non-interactive run: no spinner, no frames. */
  live: boolean;
}

/**
 * The session event stream, as terminal output.
 *
 * Deliberately a translation and nothing more: it holds one map of in-flight tool
 * calls so a result can be printed under the call it belongs to, and no other
 * state. It never decides anything, and every branch either prints or does not.
 */
export class SessionRenderer {
  private readonly spinner: Spinner;
  private readonly inFlight = new Map<string, string>();

  private readonly opts: RendererOptions;

  constructor(opts: RendererOptions) {
    this.opts = opts;
    this.spinner = new Spinner(opts.write, opts.palette, opts.glyphs, opts.live);
  }

  on(type: string, payload: unknown): void {
    const data = (payload ?? {}) as Record<string, unknown>;
    const { palette: p, glyphs: g, write } = this.opts;

    switch (type) {
      case 'turn.started':
        this.spinner.start('Thinking');
        return;

      case 'model.request.started':
        this.spinner.start('Thinking');
        return;

      case 'tool.call': {
        const name = typeof data.name === 'string' ? data.name : 'tool';
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        const args = typeof data.argsSummary === 'string' ? data.argsSummary : '{}';
        this.inFlight.set(id, name);
        this.spinner.stop();
        write(`${toolCallLine(name, args, p, g)}\n`);
        this.spinner.start(`Running ${name}`);
        return;
      }

      case 'tool.result':
      case 'tool.error':
      case 'tool.denied': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        this.inFlight.delete(id);
        this.spinner.stop();
        write(
          `${toolResultLine(
            {
              isError: data.isError === true || type !== 'tool.result',
              ...(typeof data.errorCode === 'string' ? { errorCode: data.errorCode } : {}),
              ...(type === 'tool.denied' ? { errorCode: 'denied' } : {}),
              ...(typeof data.contentBytes === 'number' ? { contentBytes: data.contentBytes } : {}),
            },
            p,
            g,
          )}\n`,
        );
        this.spinner.start('Thinking');
        return;
      }

      case 'turn.completed':
      case 'turn.failed':
      case 'turn.cancelled':
        this.spinner.stop();
        this.inFlight.clear();
        return;

      default:
        return;
    }
  }

  /** Stop any frame in flight. Called before a prompt and at shutdown. */
  quiet(): void {
    this.spinner.stop();
  }
}
