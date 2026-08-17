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
  /** The accent. One colour carries the frame, the title and the prompt. */
  blue(s: string): string;
  /** Dark text on a light background: what *you* said, once it has been sent. */
  inverse(s: string): string;
  boldBlue(s: string): string;
  dimBlue(s: string): string;
}

/** The one escape byte in this file. */
const ESC = '\u001b[';

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
    blue: wrap(on, '34'),
    inverse: wrap(on, '47;30'),
    boldBlue: wrap(on, '1;34'),
    dimBlue: wrap(on, '2;34'),
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
  /** The title mark. `reference/clio` uses the same one. */
  diamond: string;
  /** Printed with the "worked for" line when a turn finishes. */
  finished: string;
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
        diamond: '◆',
        finished: '✻',
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
        diamond: '*',
        finished: '*',
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
  /** The model's context window, in tokens. Shown because compaction turns on it. */
  contextWindow?: number;
  /**
   * How the isolation is described, from the enforcement descriptor — never a
   * literal (invariant 5, `no-enforcement-overclaim`).
   */
  isolation: string;
  /** The caveat that goes with it, in the words `/status` uses. */
  caveat: string;
}

/**
 * The right-hand column of the banner.
 *
 * Every one is something the session can actually do, phrased as the command to
 * type. A tip that names a feature without naming the way in is a tip that makes
 * somebody go looking.
 */
export const TIPS: readonly string[] = [
  '/help lists every control command',
  '/status shows budget, context and dirty files',
  '/undo reverses edits — all of them or none',
  '/model list picks a different model',
  '/permissions explain <subject> says why',
  'Ctrl-C cancels a turn, Ctrl-D exits',
  '!cmd shows how a command would parse',
  '/compact summarises the older conversation',
  '/loop start --max-steps 40 raises a budget',
  '--read-only wins over --profile, and says so',
];

/** Pick without repeating. The generator is injectable so a test is not a coin toss. */
export function pickTips(count: number, random: () => number = Math.random): string[] {
  const pool = [...TIPS];
  const out: string[] = [];
  while (out.length < Math.min(count, TIPS.length)) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    out.push(pool.splice(index, 1)[0] ?? '');
  }
  return out;
}

/** Pad a block of lines so it sits in the middle of the terminal. */
export function centre(lines: readonly string[], columns: number): string[] {
  const widest = Math.max(...lines.map(visibleWidth), 0);
  const left = ' '.repeat(Math.max(0, Math.floor((columns - widest) / 2)));
  return lines.map((line) => `${left}${line}`);
}

/**
 * What you are about to run, and what it can reach. Printed once, centred.
 *
 * The isolation line is **not decoration** and is not optional. Invariant 5 says
 * the user-facing surface must never present policy as strong isolation, and the
 * first draft of this banner replaced a `/status` dump that carried the honest
 * wording with a tidy `backend local` — which is how an accurate claim becomes a
 * missing one. `tests/integration/cli.test.ts` caught it, which is exactly what it
 * was written for (alpha.5 §41).
 *
 * The shape follows `reference/clio`'s banner, which is a Claude Code clone: one
 * accent colour on the frame and the title, dim labels in a column, and the
 * caveat as prose underneath rather than squeezed into a cell. Read for the
 * design, not copied — `reference/**` is read-only (AGENTS.md rule 3) and none of
 * its types cross into ours.
 */
export function banner(
  info: BannerInfo,
  p: Palette,
  g: Glyphs,
  columns = 80,
  tips: readonly string[] = pickTips(4),
): string {
  const rows: Array<[string, string]> = [
    ['model', info.model],
    ...(info.contextWindow === undefined
      ? []
      : ([['context', `${info.contextWindow.toLocaleString('en-US')} tokens`]] as Array<[string, string]>)),
    ['profile', info.profile],
    ['isolation', info.isolation],
    ['cwd', info.workspace],
  ];

  // Full width, so nothing has to be centred except the title — a centred column
  // of labels is unreadable, and a centred paragraph under a narrow box was the
  // thing that made this uncomfortable to look at.
  const inner = Math.max(40, columns - 4);
  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  const gutter = 3;
  const leftWidth = Math.max(...rows.map(([k, v]) => k.padEnd(labelWidth).length + 2 + v.length));
  const tipWidth = Math.max(10, inner - leftWidth - gutter);

  const left = rows.map(([k, v]) => `${p.dim(k.padEnd(labelWidth))}  ${v}`);

  // Tips are decoration; the left column is not. A terminal too narrow to hold both
  // loses the tips rather than truncating an isolation line into something that
  // reads like a different claim.
  const TIP_MINIMUM = 30;
  const right =
    tipWidth < TIP_MINIMUM
      ? []
      : [p.dim('Tips'), ...tips.map((tip) => p.dim(`· ${truncate(tip, tipWidth - 2)}`))];

  const pad = (line: string, width: number): string =>
    `${line}${' '.repeat(Math.max(0, width - visibleWidth(line)))}`;

  const title = `${p.boldBlue(g.diamond)} ${p.boldBlue('MyCoder')} ${p.dim(info.version)}`;
  const body: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = pad(left[i] ?? '', leftWidth);
    const r = right[i] ?? '';
    body.push(`${l}${' '.repeat(gutter)}${r}`);
  }

  const bar = g.horizontal.repeat(inner + 2);
  const framed = [
    p.blue(`${g.topLeft}${bar}${g.topRight}`),
    `${p.blue(g.vertical)} ${pad(centre([title], inner)[0] ?? title, inner)} ${p.blue(g.vertical)}`,
    `${p.blue(g.vertical)} ${pad('', inner)} ${p.blue(g.vertical)}`,
    ...body.map((line) => `${p.blue(g.vertical)} ${pad(line, inner)} ${p.blue(g.vertical)}`),
    p.blue(`${g.bottomLeft}${bar}${g.bottomRight}`),
  ];

  // The caveat sits under the frame at the frame's own left edge. Left-aligned, not
  // centred: it is several sentences of prose and centred prose is a ransom note.
  return [...framed, '', ...wrapText(info.caveat, inner).map((line) => `  ${p.dim(line)}`)].join('\n');
}

/**
 * `✻ Worked for 1m 4s`, and what it did while it worked.
 *
 * Counted from the events the turn actually emitted rather than from the model's
 * account of itself: "ran 27 shell commands" is a fact about the session, and a
 * summary written from the final message would be a fact about the prose.
 */
export function turnFooter(
  elapsedMs: number,
  counts: ReadonlyMap<string, number>,
  p: Palette,
  g: Glyphs,
): string {
  const phrases: Array<[string, (n: number) => string]> = [
    ['Read', (n) => `read ${n} file${n === 1 ? '' : 's'}`],
    ['Grep', (n) => `searched for ${n} pattern${n === 1 ? '' : 's'}`],
    ['Glob', (n) => `listed ${n} director${n === 1 ? 'y' : 'ies'}`],
    ['Shell', (n) => `ran ${n} shell command${n === 1 ? '' : 's'}`],
    ['Edit', (n) => `edited ${n} file${n === 1 ? '' : 's'}`],
    ['Write', (n) => `wrote ${n} file${n === 1 ? '' : 's'}`],
    ['Delete', (n) => `deleted ${n} file${n === 1 ? '' : 's'}`],
    ['Move', (n) => `moved ${n} file${n === 1 ? '' : 's'}`],
    ['GitDiff', (n) => `read the diff ${n} time${n === 1 ? '' : 's'}`],
    ['WebFetch', (n) => `fetched ${n} page${n === 1 ? '' : 's'}`],
    ['Delegate', (n) => `delegated ${n} task${n === 1 ? '' : 's'}`],
    ['Undo', (n) => `undid ${n} change${n === 1 ? '' : 's'}`],
  ];

  const named = new Set(phrases.map(([name]) => name));
  const parts = phrases
    .filter(([name]) => (counts.get(name) ?? 0) > 0)
    .map(([name, phrase]) => phrase(counts.get(name) ?? 0));

  // Anything this list has never heard of is still counted, by its own name: a tool
  // added later must not silently vanish from the summary.
  for (const [name, n] of counts) {
    if (!named.has(name) && n > 0) parts.push(`called ${name} ${n} time${n === 1 ? '' : 's'}`);
  }

  const worked = `${p.blue(g.finished)} ${p.dim(`Worked for ${formatDuration(elapsedMs)}`)}`;
  return parts.length === 0 ? worked : `${worked}\n  ${p.dim(parts.join(', '))}`;
}

/** `43s`, `1m 4s`, `2h 3m`. Whole units only; nobody reads milliseconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * The input frame: a rule above, a rule below, and nothing at the sides.
 *
 * Both rules are drawn **before** the cursor arrives, which is the only way the
 * frame is closed while you type rather than after you press Enter. That needs two
 * relative cursor moves — down a line and up two — and nothing more: no alternate
 * screen, no absolute positioning, no redraw per keystroke. A right-hand border
 * would need that redraw, and that is the TUI spec §1.3 rules out.
 *
 * `openInput` leaves the cursor on the blank line between the rules, where readline
 * then writes the prompt.
 */
export function openInput(p: Palette, g: Glyphs, columns: number): string {
  const rule = ruleOf(p, g, columns);
  // rule, blank line for the prompt, rule, then back up two lines.
  return `${rule}\n\n${rule}\n${CURSOR_UP(2)}`;
}

/** Move past the bottom rule, leaving it on screen. */
export function closeInput(): string {
  return '\n';
}

/** The rule itself, exported for the tests that assert it has no sides. */
export function ruleOf(p: Palette, g: Glyphs, columns: number): string {
  return p.dimBlue(g.horizontal.repeat(Math.max(8, Math.min(columns - 2, 100))));
}

/** Kept for callers that only want one rule. */
export function inputRule(p: Palette, g: Glyphs, columns = 80): string {
  return ruleOf(p, g, columns);
}

const CURSOR_UP = (n: number): string => `${ESC}${n}A`; // ESC already carries the '['

/**
 * What you typed, redrawn as a block once it has been sent.
 *
 * Inverse video — dark text on a light background — because the one thing that is
 * genuinely hard to follow in a long transcript is which lines were *yours*. It
 * replaces the line you typed rather than adding another: the cursor goes up one
 * line, the line is erased, and the block is written in its place.
 *
 * Only when the line fits in one terminal row. A wrapped input occupies more rows
 * than this can account for, and moving up one line would land in the middle of it —
 * so a long prompt is left exactly as typed.
 */
export function submitted(text: string, p: Palette, columns: number): string | undefined {
  if (visibleWidth(text) + 4 > columns) return undefined;
  return `${CURSOR_UP(1)}\r${ESC}2K${p.inverse(` > ${text} `)}\n`;
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
  /** Tool calls this turn, by name — what the footer's summary is counted from. */
  private readonly calls = new Map<string, number>();
  private turnStarted = 0;

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
        this.calls.clear();
        this.turnStarted = Date.now();
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
        this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
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

  /**
   * `✻ Worked for 1m 4s`, plus what it did — or nothing at all for a turn that
   * called no tools and took no time worth reporting.
   */
  footer(now: () => number = Date.now): string | undefined {
    if (this.turnStarted === 0) return undefined;
    const elapsed = now() - this.turnStarted;
    if (this.calls.size === 0 && elapsed < 2000) return undefined;
    return turnFooter(elapsed, this.calls, this.opts.palette, this.opts.glyphs);
  }
}
