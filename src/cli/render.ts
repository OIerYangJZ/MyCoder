/**
 * How a session looks while it is working.
 *
 * Until alpha.12 a turn was silent: the model worked, tools ran, and the terminal
 * printed nothing until the final answer. Everything needed to show the work was
 * already in the session's event stream — `tool.call` carries the name and the
 * arguments, `tool.result` carries the outcome — and nothing was watching it.
 *
 * So this module is a **renderer, not a TUI**. Spec §1.3 lists a full TUI under
 * NON-GOALS and that is unchanged: there is no alternate screen, no panes, no mouse
 * and no absolute positioning. It formats events that already happen, and if it were
 * deleted the kernel would behave identically.
 *
 * Until ADR-0032 this said "no cursor addressing beyond one line of spinner that
 * erases itself". That stopped being true when the line editor arrived: `src/cli/`
 * now moves the cursor over the several rows an input block occupies, and the menu
 * in `select.ts` over its own. Every move is still relative and nothing survives the
 * process — but the sentence was a claim about the program, the program changed, and
 * a claim left to go quietly stale is the defect this repository keeps finding.
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

import { MarkdownStream } from './markdown.ts';

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

const SGR = /\[[0-9;]*m/g;

/**
 * Ranges as inclusive pairs, flattened and sorted, scanned linearly.
 *
 * A binary search would be faster, and there are a few dozen entries checked once
 * per character of a banner. Linear with an early return on the sorted order is the
 * version somebody can read and correct.
 */
function inRanges(cp: number, ranges: readonly number[]): boolean {
  for (let i = 0; i < ranges.length; i += 2) {
    if (cp < (ranges[i] as number)) return false;
    if (cp <= (ranges[i + 1] as number)) return true;
  }
  return false;
}

/** Combining marks, joiners and selectors: they render into the previous cell. */
const ZERO: readonly number[] = [
  0x0300, 0x036f, 0x0483, 0x0489, 0x0591, 0x05bd, 0x05bf, 0x05bf, 0x05c1, 0x05c2, 0x0610, 0x061a, 0x064b,
  0x065f, 0x0670, 0x0670, 0x06d6, 0x06dc, 0x0e31, 0x0e31, 0x0e34, 0x0e3a, 0x0e47, 0x0e4e, 0x1ab0, 0x1aff,
  0x1dc0, 0x1dff, 0x200b, 0x200f, 0x2060, 0x2064, 0x20d0, 0x20f0, 0xfe00, 0xfe0f, 0xfe20, 0xfe2f, 0xfeff,
  0xfeff,
  // Emoji skin-tone modifiers combine with the emoji before them.
  0x1f3fb, 0x1f3ff, 0xe0100, 0xe01ef,
];

/**
 * East Asian Wide and Fullwidth, plus the emoji blocks terminals render double.
 *
 * The emoji ranges are coarse on purpose. The precise answer needs the Unicode
 * emoji-presentation tables, terminals disagree with each other about it anyway,
 * and the two failure modes are not symmetric: over-counting pads a line too far,
 * under-counting writes past the frame and corrupts it. Coarse rounds toward the
 * one that stays readable.
 */
const WIDE: readonly number[] = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd,
  0x25fe, 0x2614, 0x2615, 0x2648, 0x2653, 0x267f, 0x267f, 0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab,
  0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5,
  0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c,
  0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b,
  0x2b1c, 0x2b50, 0x2b50, 0x2b55, 0x2b55,
  // CJK proper: radicals through the compatibility ideographs. 0x303f is narrow.
  0x2e80, 0x303e, 0x3041, 0x33ff, 0x3400, 0x4dbf, 0x4e00, 0x9fff, 0xa000, 0xa4cf, 0xa960, 0xa97f, 0xac00,
  0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe6f,
  // Fullwidth forms. Halfwidth kana (0xff61-0xff9f) sits in the gap and is narrow.
  0xff00, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x16fe4, 0x17000, 0x18aff, 0x1b000, 0x1b12f, 0x1f004, 0x1f004,
  0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f320, 0x1f32d, 0x1f335, 0x1f337, 0x1f37c,
  0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e,
  0x1f440, 0x1f440, 0x1f442, 0x1f4fc, 0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a, 0x1f57a,
  0x1f595, 0x1f596, 0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2,
  0x1f6d5, 0x1f6d7, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f90c, 0x1f93a, 0x1f93c, 0x1f945,
  0x1f947, 0x1f978, 0x1f97a, 0x1f9cb, 0x1f9cd, 0x1f9ff, 0x1fa70, 0x1faff, 0x20000, 0x3fffd,
];

/** How many terminal columns one code point occupies. */
function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1; // the common case, before any table is consulted
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/**
 * Visible width, in terminal columns.
 *
 * Not `String.length`. Three things make those two disagree, and each one is a way
 * this file's alignment has broken or could break:
 *
 *   **The escape codes this module writes** are consumed by the terminal and never
 *   shown. Stripping them was this function's original and only job.
 *
 *   **A CJK character occupies two columns.** `reference/clio` measures with
 *   `.length`, which is why its input line corrupts itself the moment somebody
 *   types Chinese — and `submitted()` below inherited the assumption when its shape
 *   was read from there. A task written in Chinese is not an edge case for the
 *   person this is being built for.
 *
 *   **A surrogate pair is one character.** The string is walked by code point, which
 *   `for…of` does and `.length` does not: to `.length` an emoji is two characters
 *   wide, and a truncation measured that way can cut one in half.
 *
 * A ZWJ sequence — a family emoji — is still over-counted, because getting that
 * right needs a grapheme table. See the note on `WIDE` for why over-counting is the
 * safe side of wrong.
 */
export function visibleWidth(s: string): number {
  let width = 0;
  for (const ch of s.replace(SGR, '')) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** Cut to a column budget, on a character boundary, leaving room for the ellipsis. */
export const truncate = (s: string, max: number): string => {
  if (visibleWidth(s) <= max) return s;
  const budget = Math.max(0, max - 1);
  let width = 0;
  let out = '';
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (width + w > budget) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
};

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

/**
 * The preview, indented under the result line it belongs to (ADR-0031).
 *
 * Dim, and every line prefixed, so a wall of tool output never reads as the
 * assistant talking. It arrives already redacted and already truncated — this
 * function decides indentation and nothing else.
 */
export function toolPreviewBlock(preview: string, p: Palette, g: Glyphs): string {
  return preview
    .split('\n')
    .map((line) => `    ${p.dim(g.vertical)} ${p.dim(line)}`)
    .join('\n');
}
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A rounded box, or an ASCII one. Lines are not wrapped; they are truncated. */
/**
 * Break a run that no amount of word-wrapping will shorten.
 *
 * `wrapText` splits on whitespace and deliberately leaves a long word long, so that
 * a path is never broken mid-segment. Chinese has no spaces, so a whole paragraph of
 * it is one word to that rule and would sail straight past the frame. Broken by
 * display width, on a character boundary — for CJK that is where lines break anyway.
 */
function hardWrap(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const parts: string[] = [];
  let line = '';
  let used = 0;
  for (const ch of text) {
    const w = visibleWidth(ch);
    if (used + w > width && line !== '') {
      parts.push(line);
      line = '';
      used = 0;
    }
    line += ch;
    used += w;
  }
  if (line !== '') parts.push(line);
  return parts;
}
export function box(lines: readonly string[], p: Palette, g: Glyphs, width = 72): string {
  const widest = Math.max(...lines.map(visibleWidth), 0);
  const w = Math.min(Math.max(widest, 8), width - 4);

  // A line wider than the box used to be padded by `max(0, …)` — which is to say not
  // padded, and printed past the right edge with the closing rule after it. The
  // frame went ragged exactly where it mattered most: the approval box, which is the
  // one screen a user is *required* to read, and whose longest line is the sentence
  // describing what a session-scoped grant covers.
  //
  // Wrapped rather than truncated, and this is not a free choice. Every line here is
  // either a policy statement or a path, and a truncated policy statement reads like
  // a different and narrower claim — the same reason the banner drops its tips
  // instead of cutting the isolation line (invariant 5).
  const fitted: string[] = [];
  for (const line of lines) {
    if (visibleWidth(line) <= w) {
      fitted.push(line);
      continue;
    }
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    const room = Math.max(8, w - indent.length - 2);
    const wrapped = wrapText(line.slice(indent.length), room).flatMap((part) => hardWrap(part, room));
    fitted.push(...wrapped.map((part, index) => `${indent}${index === 0 ? '' : '  '}${part}`));
  }

  const bar = g.horizontal.repeat(w + 2);
  const out: string[] = [p.dim(`${g.topLeft}${bar}${g.topRight}`)];
  for (const line of fitted) {
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
  /**
   * The approval mode's label. Just the label.
   *
   * On the banner for the same reason the isolation line is: a session that will
   * not ask before writing to the workspace has to say so before the first
   * prompt, not when the first write happens. §12 requires the disclosure at
   * startup, and `disclosures()` already prints the full prose for a weak mode as
   * a `warning:` line — so this row is the always-present version, which makes
   * `manual` stated rather than merely implied by the absence of a warning.
   *
   * Deliberately not the summary as well: the row would then repeat, at startup,
   * the sentence the disclosure is about to print underneath it.
   */
  approvalMode?: { label: string };
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
    ...(info.approvalMode
      ? ([['approvals', `${info.approvalMode.label}  ${p.dim('(Shift-Tab cycles)')}`]] as Array<
          [string, string]
        >)
      : []),
    ['isolation', info.isolation],
    ['cwd', info.workspace],
  ];

  // Full width, so nothing has to be centred except the title — a centred column
  // of labels is unreadable, and a centred paragraph under a narrow box was the
  // thing that made this uncomfortable to look at.
  const inner = Math.max(40, columns - 4);
  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  const gutter = 3;

  const left = rows.map(([k, v]) => `${p.dim(k.padEnd(labelWidth))}  ${v}`);
  // Measured from the rendered line rather than re-derived from its parts. Deriving
  // it counted the value in characters, so a workspace path in Chinese was budgeted
  // for at half its width and the row it produced was wider than the frame it sat in.
  //
  // Capped at the frame, because a value can be longer than any terminal: a hundred
  // characters of path, or an isolation sentence in a narrow window. Uncapped, the
  // row was padded by `max(0, …)` — which is to say not padded — and printed straight
  // past the closing rule. Reported two milestones before it was fixed, and true of
  // plain ASCII as much as of CJK.
  const leftWidth = Math.min(Math.max(...left.map(visibleWidth), 0), inner);
  const tipWidth = Math.max(10, inner - leftWidth - gutter);

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

  // A row too wide for the frame is wrapped, never cut. Tips are decoration and give
  // way first; the left column is claims, and an isolation line truncated into
  // something shorter reads as a narrower claim than the one being made (invariant 5).
  // Continuation rows hang under the value rather than under the label, so the label
  // column still scans.
  const hang = ' '.repeat(Math.min(labelWidth + 2, Math.max(0, leftWidth - 8)));
  const leftRows = left.flatMap((line) => {
    if (visibleWidth(line) <= leftWidth) return [line];
    const room = Math.max(8, leftWidth - hang.length);
    return wrapText(line, room)
      .flatMap((part) => hardWrap(part, room))
      .map((part, index) => (index === 0 ? part : `${hang}${part}`));
  });

  const body: string[] = [];
  for (let i = 0; i < Math.max(leftRows.length, right.length); i += 1) {
    const l = leftRows[i] ?? '';
    const r = right[i] ?? '';
    // No gutter when there is nothing to its right: with a left column as wide as the
    // frame, three trailing spaces are three columns past the closing rule.
    body.push(r === '' ? l : `${pad(l, leftWidth)}${' '.repeat(gutter)}${r}`);
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
/**
 * What the turn did, and — since alpha.12 — what it was refused.
 *
 * `counts` is incremented when a call *starts*, because that is when the
 * renderer learns the tool's name. So a refused call was counted as a completed
 * one, and the footer said "ran 1 shell command" for a command policy declined.
 * Seen on a real run: the model's own prose said "shell approval was declined in
 * this non-interactive session" three lines above a footer claiming it ran.
 *
 * `refused` is subtracted from the totals and reported separately. The rule is
 * alpha.10 §12's: a count that includes what did not happen is the dishonest
 * half of the summary, and the honest version has to name both.
 */
export function turnFooter(
  elapsedMs: number,
  counts: ReadonlyMap<string, number>,
  p: Palette,
  g: Glyphs,
  refused: ReadonlyMap<string, number> = new Map(),
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

  /** What actually ran: the attempts, less the ones that were refused. */
  const ran = (name: string): number => Math.max(0, (counts.get(name) ?? 0) - (refused.get(name) ?? 0));

  const named = new Set(phrases.map(([name]) => name));
  const parts = phrases.filter(([name]) => ran(name) > 0).map(([name, phrase]) => phrase(ran(name)));

  // Anything this list has never heard of is still counted, by its own name: a tool
  // added later must not silently vanish from the summary.
  for (const [name] of counts) {
    if (!named.has(name) && ran(name) > 0) {
      const n = ran(name);
      parts.push(`called ${name} ${n} time${n === 1 ? '' : 's'}`);
    }
  }

  const declined = [...refused].filter(([, n]) => n > 0);
  if (declined.length > 0) {
    const total = declined.reduce((sum, [, n]) => sum + n, 0);
    parts.push(
      `${total} refused (${declined.map(([name, n]) => (n === 1 ? name : `${name} ×${n}`)).join(', ')})`,
    );
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
 * The rule under the input.
 *
 * There used to be four functions here — open the frame, redraw the bottom rule
 * after every keystroke, take the frame down two different ways — and all of them
 * existed to fight `readline`, which erases everything below its line on every
 * refresh. ADR-0032 replaced readline with an editor that owns its whole block, so
 * the fight is over and the functions went with it. What is left is the rule itself,
 * which the editor draws as its own footer.
 */
/**
 * The rule under the input, spanning the terminal like the banner above it.
 *
 * There was a second name for this — `ruleOf`, with `inputRule` delegating to it —
 * left from when the input had two rules and one caller wanted only the bottom. The
 * editor draws one rule as its own footer, so there is one function.
 */
export function inputRule(p: Palette, g: Glyphs, columns: number): string {
  return p.dimBlue(g.horizontal.repeat(Math.max(8, columns - 2)));
}

/**
 * The mode, in front of the prompt glyph.
 *
 * On the prompt rather than only in the banner because it is the answer to
 * "what will happen if I send this", and it changes under a keystroke. A mode
 * that could only be checked with `/mode` would be a mode people forget they are
 * in — which for `auto` is the whole risk.
 *
 * `manual` prints nothing. It is the default and the safe one, and a marker that
 * is always present is a marker nobody reads; keeping the line bare until
 * something is *not* the default is what makes the other three legible. The
 * colours run with the risk: plan is the one that cannot change anything, auto is
 * the one nobody is checking.
 */
export function modeIndicator(mode: string, label: string, p: Palette): string {
  switch (mode) {
    case 'plan':
      return `${p.blue(`[${label}]`)} `;
    case 'accept-edits':
      return `${p.green(`[${label}]`)} `;
    case 'auto':
      return `${p.yellow(`[${label}]`)} `;
    default:
      return '';
  }
}

/**
 * What you typed, redrawn as a block once it has been sent, with the frame closed
 * under it.
 *
 * Inverse video — dark text on a light background — because the one thing that is
 * genuinely hard to follow in a long transcript is which lines were *yours*.
 *
 * Every line, however long. There used to be a guard here that dropped the block for
 * anything wider than the terminal, because the old implementation moved the cursor
 * up one row and a wrapped line occupies more than one. The cursor move is gone — the
 * editor takes its own block down now — and the guard outlived its reason: with the
 * block cleared and the block suppressed, a long line vanished from the transcript
 * entirely, which is the opposite of what this function is for.
 */
export function submitted(text: string, p: Palette, g: Glyphs, columns: number): string {
  return `${p.inverse(` > ${text} `)}\n${inputRule(p, g, columns)}\n`;
}

export interface StatusInfo {
  model: string;
  contextWindow?: number;
  requests: number;
  tokens: number;
  costUsd?: number;
  /**
   * Model requests the kernel could not price, because the profile has no rates.
   *
   * Without this the line printed `$0.0000` for a session that had spent real
   * money against an unpriced model — the total is zero because the kernel
   * correctly refuses to add a figure it cannot compute, and zero on its own
   * reads as "free". `ModelProfile.pricing` promises cost is reported as
   * unknown when it is unset; this is where that promise is kept on the line
   * people actually read.
   */
  unpricedRequests?: number;
  elapsedMs?: number;
}

/**
 * One line under the frame: what answered, how much of it there was, what it cost.
 *
 * Every figure comes from the session's own counters. There is deliberately **no
 * context percentage**: the authoritative estimate lives on the control-plane host
 * (`contextUsage`), not on the kernel, and a percentage computed a second way would
 * be a number that disagrees with `/status` — which is the shape of half the defects
 * this milestone found.
 */
/**
 * The money, or an honest refusal to name it.
 *
 * Three states, not two. Everything priced is a figure; nothing priced is
 * `cost unknown`; a mixture is a floor, written `≥$x`, because the total is
 * real but covers only part of the session.
 */
function costParts(info: StatusInfo, p: Palette): string[] {
  const unpriced = info.unpricedRequests ?? 0;
  if (info.costUsd === undefined) return [];
  if (unpriced === 0) return [p.green(`$${info.costUsd.toFixed(4)}`)];
  if (info.costUsd === 0) {
    return [p.dim(`cost unknown (${unpriced} unpriced request${unpriced === 1 ? '' : 's'})`)];
  }
  return [p.green(`≥$${info.costUsd.toFixed(4)}`), p.dim(`${unpriced} unpriced`)];
}

export function statusLine(info: StatusInfo, p: Palette): string {
  const parts = [
    p.blue(info.model),
    ...(info.contextWindow === undefined ? [] : [p.dim(`${Math.round(info.contextWindow / 1000)}k ctx`)]),
    p.dim(`${info.requests} request${info.requests === 1 ? '' : 's'}`),
    p.dim(`${formatTokens(info.tokens)} tokens`),
    ...costParts(info, p),
    ...(info.elapsedMs === undefined ? [] : [p.dim(formatDuration(info.elapsedMs))]),
  ];
  return `  ${parts.join(p.dim(' · '))}`;
}

/** `just now`, `14m ago`, `3h ago`, `2d ago`. What a session list is read by. */
export function timeAgo(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface SessionChoice {
  sessionId: string;
  /** The first thing the user asked it. Absent for a session that never got one. */
  title?: string;
  model: string;
  updatedAt: number;
  toolCalls: number;
}

/**
 * The `-r` picker (ADR-0029).
 *
 * A numbered list, newest first, keyed by what the session was *about*. The id is
 * still printed — it is what `-r <id>` and a bug report need — but it is dim and
 * last, because it is the part nobody can recognise. A session with no title says
 * so rather than showing an empty column: "started, nothing asked yet" is a real
 * state and looks nothing like a missing field.
 */
export function sessionList(
  choices: readonly SessionChoice[],
  workspace: string,
  now: number,
  p: Palette,
): string {
  const lines = [p.dim(`Sessions in ${workspace}:`), ''];
  choices.forEach((c, index) => {
    const when = timeAgo(c.updatedAt, now).padEnd(9);
    const title = c.title ?? '(nothing was asked in this session)';
    lines.push(
      `  ${p.blue(`${index + 1}`)}  ${p.dim(when)} ${title}\n` +
        `     ${p.dim(`${c.model} · ${c.toolCalls} tool call${c.toolCalls === 1 ? '' : 's'} · ${c.sessionId}`)}`,
    );
  });
  return lines.join('\n');
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Greedy wrap. Long words are left long rather than broken mid-path. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (line === '') line = word;
    else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) line += ` ${word}`;
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
  /** Live figures, appended after the elapsed time. */
  private detail = '';
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

  /**
   * What the session has spent so far, shown while it is still spending it.
   *
   * `reference/clio` keeps a persistent bottom bar for this, reserved with a scroll
   * region — absolute terminal state that survives the process, so a crash between
   * setting it and restoring it leaves the terminal broken until the user runs
   * `reset`. The spinner line is already live, already erases itself and already
   * leaves no trace, so the figures go here instead: the same information, and no
   * new terminal state at all.
   */
  setDetail(detail: string): void {
    this.detail = detail;
  }

  /** Render one frame. Exposed so a test can drive it without a timer. */
  tick(): void {
    if (!this.enabled) return;
    const g = this.g.spinner;
    const frame = g[this.frame % g.length] ?? '';
    this.frame += 1;
    const seconds = Math.floor((this.now() - this.started) / 1000);
    const elapsed = seconds > 0 ? ` ${seconds}s` : '';
    const detail = this.detail === '' ? '' : ` · ${this.detail}`;
    this.write(`\r[K${this.p.cyan(frame)} ${this.p.dim(this.text + elapsed + detail)}`);
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
  /**
   * Where the model's answer goes, if it is to be streamed.
   *
   * Deliberately a second sink, and deliberately **stdout**: the answer is the
   * payload, not the chrome. It already goes to stdout today, whole, once the turn
   * has finished; streaming means the same bytes arriving earlier, so a reader
   * redirecting stdout still gets the answer and only the answer.
   *
   * Absent turns streaming off, which is what `--json` needs — a JSON envelope and
   * a stream of prose cannot share a file descriptor.
   */
  writeAnswer?: (s: string) => void;
  /**
   * The palette for the answer, which is **not** the palette for the chrome.
   *
   * Styling is decided per stream: `mycoder … > answer.md` has a terminal on stderr
   * and a file on stdout, and asking `stderr.isTTY` for both is how escape codes end
   * up in the file.
   */
  answerPalette?: Palette;
  /** Re-read per line, so a resize mid-answer is picked up. */
  columns?: () => number;
  /**
   * Whether the answer sink is a terminal.
   *
   * Decides whether the answer may be echoed and re-drawn as it arrives. Not the
   * same question as whether to colour it: `NO_COLOR` on a terminal is still a
   * terminal, and a redirected file is not one whatever the palette says.
   */
  answerIsTerminal?: boolean;
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
  /**
   * Calls policy refused, by tool name.
   *
   * Kept apart from `calls` rather than by decrementing it, because the two are
   * different facts and the footer reports both. `calls` counts what was
   * attempted — it has to, since the name arrives with the call and the outcome
   * arrives later — so the summary needs this to say what actually happened.
   */
  private readonly refused = new Map<string, number>();
  private turnStarted = 0;
  /** Running totals for the spinner line, reset with the turn. */
  private tokens = 0;
  private costUsd = 0;
  /** Present only when the answer is to be streamed. */
  private readonly answer: MarkdownStream | undefined;

  private readonly opts: RendererOptions;

  constructor(opts: RendererOptions) {
    this.opts = opts;
    this.spinner = new Spinner(opts.write, opts.palette, opts.glyphs, opts.live);
    this.answer = opts.writeAnswer
      ? new MarkdownStream({
          palette: opts.answerPalette ?? palette(false),
          glyphs: opts.glyphs,
          columns: opts.columns ?? ((): number => 80),
          echo: opts.answerIsTerminal === true,
        })
      : undefined;
  }

  /**
   * Whether this turn's answer was written as it arrived.
   *
   * The caller prints `finalText` when it was not, and must not when it was: the
   * whole point is that those are the same bytes.
   */
  streamedAnswer(): boolean {
    return this.answer?.active ?? false;
  }

  on(type: string, payload: unknown): void {
    const data = (payload ?? {}) as Record<string, unknown>;
    const { palette: p, glyphs: g, write } = this.opts;

    switch (type) {
      case 'turn.started':
        this.calls.clear();
        this.refused.clear();
        this.turnStarted = Date.now();
        this.tokens = 0;
        this.costUsd = 0;
        this.spinner.setDetail('');
        this.answer?.reset();
        this.spinner.start('Thinking');
        return;

      case 'model.request.started':
        this.spinner.start('Thinking');
        return;

      // Usage and cost, onto the line that is already live. The figures come from
      // the session's own counters, the same ones `statusLine` reports at the end of
      // the turn — never a second estimate computed here.
      case 'model.request.completed': {
        const usage = (data.usage ?? {}) as Record<string, unknown>;
        const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
        const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
        this.tokens += input + output;
        if (typeof data.costUsd === 'number') this.costUsd += data.costUsd;
        this.spinner.setDetail(
          `${formatTokens(this.tokens)} tokens` + (this.costUsd > 0 ? ` · ${this.costUsd.toFixed(4)}` : ''),
        );
        return;
      }

      // Already emitted by `Session` for every `ModelEvent`; until now nothing
      // listened. Only the visible text is rendered — reasoning arrives here too and
      // is deliberately left for a separate decision.
      case 'model.stream': {
        const event = (payload ?? {}) as { type?: unknown; text?: unknown };
        if (event.type !== 'text_delta' || typeof event.text !== 'string') return;
        const out = this.answer?.feed(event.text);
        if (out === undefined || out === '') return;
        // The spinner erases the row it is on, which from here is the row the answer
        // is being written to. It stays down until the next request or tool call.
        this.spinner.stop();
        this.opts.writeAnswer?.(out);
        return;
      }

      case 'tool.call': {
        const name = typeof data.name === 'string' ? data.name : 'tool';
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        const args = typeof data.argsSummary === 'string' ? data.argsSummary : '{}';
        // A model that says something and then calls a tool leaves the answer
        // mid-line; the tool line would land inside its last sentence.
        this.flushAnswer();
        this.inFlight.set(id, name);
        this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
        this.spinner.stop();
        write(`${toolCallLine(name, args, p, g)}\n`);
        this.spinner.start(`Running ${name}`);
        return;
      }

      /**
       * An action a mode approved instead of the user.
       *
       * Written into the transcript because the alternative is silence: in
       * `auto` the approval prompt simply does not appear, so the one signal
       * that an action went unreviewed would be the mode indicator on a prompt
       * the user is not looking at while the turn runs. The durable log records
       * it too (`approval.decided.answeredByMode`), but a log is what you read
       * afterwards and this is what you read at the time.
       *
       * Dim and one line, above the tool line it belongs to. It is a note, not
       * a warning — the user chose the mode, and shouting about every write
       * would train them to stop reading it.
       */
      case 'approval.auto': {
        const summary = typeof data.summary === 'string' ? data.summary : 'an action';
        const mode = typeof data.mode === 'string' ? data.mode : 'mode';
        this.flushAnswer();
        this.spinner.stop();
        // `diamond` is the glyph the approval frame uses, which is the point:
        // this line stands where that frame would have been.
        write(`${p.dim(`  ${g.diamond} auto-approved (${mode}): ${summary}`)}\n`);
        this.spinner.start('Thinking');
        return;
      }

      case 'tool.result':
      case 'tool.error':
      case 'tool.denied': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        // Recorded before the id is dropped, and keyed by the name the call
        // started with — the payload does not carry the tool's name.
        //
        // Keyed on `errorCode`, not on the event type. `tool.denied` exists in
        // the event union and nothing emits it: a refusal arrives as an ordinary
        // `tool.result` with `isError` and `TOOL_DENIED`. Checking only the type
        // is what made the first version of this fix do nothing, which the VM
        // showed immediately — the footer still said "ran 1 shell command" under
        // the model's own note that the command had been declined.
        if (type === 'tool.denied' || data.errorCode === 'TOOL_DENIED') {
          const name = this.inFlight.get(id);
          if (name !== undefined) this.refused.set(name, (this.refused.get(name) ?? 0) + 1);
        }
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
        if (typeof data.preview === 'string' && data.preview !== '') {
          write(`${toolPreviewBlock(data.preview, p, g)}\n`);
        }
        this.spinner.start('Thinking');
        return;
      }

      case 'turn.completed':
      case 'turn.failed':
      case 'turn.cancelled':
        this.spinner.stop();
        // A turn cancelled mid-sentence leaves the cursor inside the prose, and
        // `Turn cancelled.` then lands there.
        this.flushAnswer();
        this.inFlight.clear();
        return;

      default:
        return;
    }
  }

  /** Close off whatever of the answer is on the current line. Safe when idle. */
  private flushAnswer(): void {
    const tail = this.answer?.flush();
    if (tail !== undefined && tail !== '') this.opts.writeAnswer?.(tail);
  }

  /** The palette this renderer was built with, so a caller can match it. */
  get palette(): Palette {
    return this.opts.palette;
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
    return turnFooter(elapsed, this.calls, this.opts.palette, this.opts.glyphs, this.refused);
  }
}
