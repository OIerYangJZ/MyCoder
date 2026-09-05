/**
 * Pick one of a short list with the arrow keys.
 *
 * Built for the approval prompt, where typing `y`, `s`, `n` or `d` meant knowing in
 * advance what four letters did — and where `[y]` and `[s]` are indistinguishable to
 * anybody who has not read the code. A list you move through says what each answer
 * *is*.
 *
 * **Still not the TUI spec §1.3 rules out.** No alternate screen, no absolute
 * positioning: the menu is written where the cursor already is, and every redraw is
 * "up N lines, rewrite N lines" — the same relative technique the line editor uses
 * for its own block. Nothing survives the process.
 *
 * The two halves are separated so the interesting one can be tested without a
 * terminal: `renderMenu` and `parseKeys` are pure, and `select` is the loop that
 * joins them to a stream.
 *
 * **A caller without a terminal must not use this.** There is no fallback here;
 * `select` refuses rather than inventing an answer, because the one place this is
 * used is a security decision and a menu that answers itself would answer it wrong.
 */

import { truncate, type Glyphs, type Palette } from './render.ts';

const ESC = '\u001b';
const CSI = `${ESC}[`;
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

/** What a keypress means to a menu. Anything else means nothing. */
export type MenuKey = 'up' | 'down' | 'confirm' | 'cancel';

/**
 * Decode a chunk into menu keys.
 *
 * A chunk can hold more than one keypress — a held arrow key, or a paste — so this
 * returns a list. `j` and `k` are accepted alongside the arrows because the cost is
 * two lines and somebody will try them.
 *
 * Written with `\\u001b` rather than a literal escape byte, after an hour lost to a
 * constant that already contained its own `[` and produced `ESC [ [ A`. An invisible
 * character in a source file is a bug nobody can see while reading.
 */
export function parseKeys(data: string): MenuKey[] {
  const keys: MenuKey[] = [];
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(CSI, i)) {
      // Skip the parameter bytes and land on the final one.
      let j = i + CSI.length;
      while (j < data.length && data.charCodeAt(j) >= 0x30 && data.charCodeAt(j) <= 0x3f) j += 1;
      const final = data[j];
      if (final === 'A') keys.push('up');
      else if (final === 'B') keys.push('down');
      else keys.push('cancel');
      i = j + 1;
      continue;
    }

    const ch = data[i] as string;
    if (ch === ESC) keys.push('cancel');
    else if (ch === '\r' || ch === '\n') keys.push('confirm');
    else if (ch === CTRL_C || ch === CTRL_D) keys.push('cancel');
    else if (ch === 'k') keys.push('up');
    else if (ch === 'j') keys.push('down');
    i += 1;
  }
  return keys;
}
/**
 * The menu, as N lines and no more.
 *
 * Exactly one line per item, because the redraw moves up by the number of items and
 * a wrapped label would make that count a lie. Labels are cut to fit rather than
 * allowed to wrap.
 *
 * Numbered, which `approvalChoices` has claimed in its own comment since it was
 * written and this never actually did: "the answers are numbered as well as
 * lettered" was true of the typed prompt and of nothing else. The numbers earn
 * their column twice over — they say how many answers there are without counting
 * rows, and they are what a person reads back to somebody over a call.
 *
 * The unselected rows are grey rather than plain. With four white rows and one
 * bold one, the bold one is where the highlight *is*; with four grey rows and one
 * accented one, the highlight is what the eye lands on first.
 */
export function renderMenu(
  items: readonly string[],
  selected: number,
  p: Palette,
  g: Glyphs,
  columns = 80,
): string {
  // Wide enough for the widest number, so single- and double-digit lists both
  // line their labels up in one column.
  const numberWidth = String(items.length).length;
  const room = Math.max(8, columns - 6 - numberWidth - 2);
  return items
    .map((item, index) => {
      const label = truncate(item, room);
      const number = `${String(index + 1).padStart(numberWidth)}.`;
      return index === selected
        ? `  ${p.accentBold(g.prompt)} ${p.accentBold(number)} ${p.accentBold(label)}`
        : `    ${p.grey(number)} ${p.grey(label)}`;
    })
    .join('\n');
}

/** The same menu again, over the top of the one already on screen. */
export function redrawMenu(
  items: readonly string[],
  selected: number,
  p: Palette,
  g: Glyphs,
  columns = 80,
): string {
  const up = `${CSI}${items.length}A`;
  const lines = renderMenu(items, selected, p, g, columns)
    .split('\n')
    .map((line) => `\r${CSI}2K${line}`)
    .join('\n');
  return `${up}${lines}\n`;
}

/**
 * Just enough of `process.stdin` to drive a menu, so a test can supply a fake.
 *
 * `setRawMode` is optional for the same reason: the fake does not have one, and its
 * absence is what "this is not a terminal" looks like from in here.
 */
export interface KeySource {
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  off(event: 'data', listener: (chunk: Buffer | string) => void): void;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
}

export interface SelectOptions {
  items: readonly string[];
  /** Where the highlight starts. For a security question, on the safe answer. */
  initial: number;
  write: (s: string) => void;
  palette: Palette;
  glyphs: Glyphs;
  input: KeySource;
  columns?: () => number;
}

/**
 * Show the menu and resolve with the chosen index, or `undefined` if it was
 * abandoned with Escape or Ctrl-C.
 *
 * The caller decides what abandonment means. For an approval it means no.
 */
export async function select(opts: SelectOptions): Promise<number | undefined> {
  const { items, write, palette: p, glyphs: g, input } = opts;
  if (items.length === 0) return undefined;
  const columns = opts.columns ?? ((): number => 80);

  let index = Math.min(Math.max(0, opts.initial), items.length - 1);
  write(`${renderMenu(items, index, p, g, columns())}\n`);

  input.setRawMode?.(true);
  input.resume();

  return new Promise<number | undefined>((resolve) => {
    const finish = (answer: number | undefined): void => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      resolve(answer);
    };

    const onData = (chunk: Buffer | string): void => {
      for (const key of parseKeys(chunk.toString())) {
        if (key === 'up') index = (index - 1 + items.length) % items.length;
        else if (key === 'down') index = (index + 1) % items.length;
        else if (key === 'confirm') {
          finish(index);
          return;
        } else if (key === 'cancel') {
          finish(undefined);
          return;
        }
        write(redrawMenu(items, index, p, g, columns()));
      }
    };

    input.on('data', onData);
  });
}
