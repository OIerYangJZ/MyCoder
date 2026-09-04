/**
 * The line editor (ADR-0032).
 *
 * Replaces `readline` for the interactive prompt. `readline` gave wrapping, wide
 * characters and paste for free and capped what the prompt could ever be: no
 * completion menu, no `@file`, no multi-line composition, no history search — and a
 * bottom rule that had to be redrawn on every keypress, because readline erases
 * everything below its line. That was a workaround against the library, and every
 * further affordance would have been another one.
 *
 * **Split so that the interesting half needs no terminal.** `applyKey` is a pure
 * function from state and key to state; `Editor` is the thin driver that owns the
 * stream, the raw mode and the redraw. Every behavioural test drives the state
 * machine. `reference/clio`'s equivalent is 1196 lines with no tests at all, and its
 * catalogued defects are this module's acceptance criteria — see ADR-0032.
 *
 * Three of those criteria are visible in the code rather than only in the tests:
 *
 *   **Columns, not characters.** Every width is `visibleWidth`. A prompt measured in
 *   `String.length` corrupts itself the moment somebody types Chinese.
 *
 *   **Rows, not lines.** The redraw computes how many *visual* rows the input
 *   occupies and moves by that. `\r` returns to the start of a visual row, so an
 *   editor that assumes one logical line is one row erases the wrong thing as soon
 *   as anything wraps.
 *
 *   **Bounded by the window.** A redraw cannot move back up to a row that has
 *   scrolled off the top, so the block never draws more rows than the terminal
 *   holds. The buffer gets a viewport that follows the cursor and the completion
 *   menu gets what is left — never more than half, because a menu that pushed the
 *   buffer off screen would hide what is being typed in order to show suggestions
 *   about it. `layout` is the one place a logical line becomes visual rows, so the
 *   count, the cursor and the drawing cannot disagree about where the block begins.
 *
 *   **Bracketed paste, not a heuristic.** Everything between the paste markers is
 *   literal text. clio guesses from "the chunk contained a newline", which misfires
 *   on a slow paste and then auto-submits it.
 */

import { truncate, visibleWidth, type Glyphs, type Palette } from './render.ts';

const ESC = '\u001b';
const CSI = `${ESC}[`;

/** Turn bracketed paste on and off. Must be off again before we let go of the tty. */
export const PASTE_ON = `${CSI}?2004h`;
export const PASTE_OFF = `${CSI}?2004l`;
const PASTE_START = `${CSI}200~`;
const PASTE_END = `${CSI}201~`;

/**
 * Whether a bracketed paste is still open, carried between chunks.
 *
 * The same shape as the highlighter's `BlockState`, and for the same reason: a
 * construct that spans reads needs somewhere to remember that it does.
 */
export interface PasteState {
  inside: boolean;
}

export function newPasteState(): PasteState {
  return { inside: false };
}

/** What the editor understands. Everything else is text or is ignored. */
export type Key =
  | { kind: 'text'; text: string }
  | { kind: 'enter' }
  | { kind: 'newline' }
  | { kind: 'backspace' }
  | { kind: 'delete' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'word-left' }
  | { kind: 'word-right' }
  | { kind: 'kill-to-end' }
  | { kind: 'kill-to-start' }
  | { kind: 'kill-word' }
  | { kind: 'yank' }
  | { kind: 'tab' }
  | { kind: 'cancel' }
  | { kind: 'eof' }
  | { kind: 'escape' }
  | { kind: 'clear' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'search' }
  /**
   * Shift-Tab: cycle the approval mode.
   *
   * A key the editor recognises but never acts on, like `clear`. It has to be
   * decoded here because this is the only place a keystroke is decoded
   * (criterion 4) — a second decoder for host keys is how `clio` ended up with a
   * binding table and a parallel switch that disagreed. What it *means* is the
   * host's business, so the driver hands it over and the buffer never sees it.
   *
   * Plain Tab is completion and stays that way. Shift-Tab was free.
   */
  | { kind: 'cycle-mode' };

/** How a read ended. */
export type EditorOutcome = { kind: 'line'; text: string } | { kind: 'cancel' } | { kind: 'eof' };

export interface EditorState {
  /** The buffer, as logical lines. Never empty. */
  lines: string[];
  /** Which logical line the cursor is on. */
  row: number;
  /** Character offset within that line. Not a column. */
  col: number;
  history: readonly string[];
  /** Where in history the cursor is; `history.length` means "the line being typed". */
  historyAt: number;
  /** What was typed before history was walked into, so Down can come back to it. */
  draft: string | undefined;
  killRing: string;
  /**
   * Set once the line is finished, and *how* it finished.
   *
   * Cancel and end-of-input were both `null` until a real terminal session showed
   * what that costs: Ctrl-C exited the program instead of abandoning the line, in a
   * session whose own banner says "Ctrl-C cancels a turn, Ctrl-D exits". Two ways to
   * stop typing that mean opposite things cannot share a return value.
   */
  done: EditorOutcome | undefined;
  /** Completion candidates on screen, if any. */
  menu: readonly string[];
  menuAt: number;
  /**
   * Snapshots for Ctrl-Z, newest last, bounded.
   *
   * Only the buffer and the cursor: replaying history position or a menu would
   * undo things the user did not type.
   */
  undo: ReadonlyArray<{ lines: readonly string[]; row: number; col: number }>;
  redo: ReadonlyArray<{ lines: readonly string[]; row: number; col: number }>;
  /** Reverse history search (Ctrl-R). Absent when not searching. */
  search: { query: string; matches: readonly number[]; at: number } | undefined;
}

/** How far back Ctrl-Z reaches. Bounded so a long session cannot grow without limit. */
export const MAX_UNDO = 200;

export function newEditorState(history: readonly string[] = []): EditorState {
  return {
    lines: [''],
    row: 0,
    col: 0,
    history,
    historyAt: history.length,
    draft: undefined,
    killRing: '',
    done: undefined,
    menu: [],
    menuAt: 0,
    undo: [],
    redo: [],
    search: undefined,
  };
}

/** The buffer as one string. */
export function textOf(state: EditorState): string {
  return state.lines.join('\n');
}

const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\w$-]/.test(ch);

/**
 * Decode a chunk into keys.
 *
 * One path, not two: clio has a keybinding table *and* a parallel hardcoded switch,
 * and most of the second is dead code that still occasionally runs. Everything the
 * editor understands is decided here and nowhere else (criterion 4).
 */
export function parseInput(
  data: string,
  overrides?: ReadonlyMap<number, Key>,
  paste: PasteState = newPasteState(),
): Key[] {
  const keys: Key[] = [];
  let i = 0;

  // Still inside a paste that began in an earlier chunk.
  if (paste.inside) {
    const end = data.indexOf(PASTE_END);
    const body = end === -1 ? data : data.slice(0, end);
    if (body !== '') keys.push({ kind: 'text', text: body });
    if (end === -1) return keys;
    paste.inside = false;
    i = end + PASTE_END.length;
  }

  while (i < data.length) {
    // Bracketed paste: everything to the end marker is text, newlines included.
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i);
      const body = end === -1 ? data.slice(i + PASTE_START.length) : data.slice(i + PASTE_START.length, end);
      if (body !== '') keys.push({ kind: 'text', text: body });
      if (end === -1) {
        // A paste large enough to be split across reads — which is every paste worth
        // making. Without carrying this, the next chunk is parsed as keystrokes and
        // the newlines inside it submit the line, over and over. Found by pasting 40
        // lines into a real terminal; a single-chunk test cannot see it.
        paste.inside = true;
        return keys;
      }
      i = end + PASTE_END.length;
      continue;
    }

    if (data.startsWith(CSI, i)) {
      let j = i + CSI.length;
      while (j < data.length && data.charCodeAt(j) >= 0x30 && data.charCodeAt(j) <= 0x3f) j += 1;
      const params = data.slice(i + CSI.length, j);
      const final = data[j];
      const key = csiKey(params, final);
      if (key) keys.push(key);
      i = j + 1;
      continue;
    }

    const ch = data[i] as string;
    const code = ch.codePointAt(0) ?? 0;

    if (ch === ESC) {
      keys.push({ kind: 'escape' });
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      keys.push({ kind: 'enter' });
      i += 1;
      continue;
    }
    if (code === 0x7f || code === 0x08) {
      keys.push({ kind: 'backspace' });
      i += 1;
      continue;
    }

    const control = overrides?.get(code) ?? CONTROL_KEYS[code];
    if (control) {
      keys.push(control);
      i += 1;
      continue;
    }

    if (code < 0x20) {
      i += 1;
      continue;
    }

    // Printable: take the whole run at once so a paste-shaped chunk is one edit.
    let j = i;
    let text = '';
    while (j < data.length) {
      const c = data[j] as string;
      const cp = c.codePointAt(0) ?? 0;
      if (cp < 0x20 || cp === 0x7f) break;
      text += c;
      j += c.length;
    }
    keys.push({ kind: 'text', text });
    i = j;
  }

  return keys;
}

const CONTROL_KEYS: Readonly<Record<number, Key>> = {
  0x01: { kind: 'home' },
  0x03: { kind: 'cancel' },
  0x04: { kind: 'eof' },
  0x05: { kind: 'end' },
  0x0a: { kind: 'newline' },
  0x0b: { kind: 'kill-to-end' },
  0x0c: { kind: 'clear' },
  0x15: { kind: 'kill-to-start' },
  0x17: { kind: 'kill-word' },
  0x12: { kind: 'search' },
  0x19: { kind: 'yank' },
  0x1a: { kind: 'undo' },
  0x09: { kind: 'tab' },
};

function csiKey(params: string, final: string | undefined): Key | undefined {
  const seq = `${params}${final ?? ''}`;
  switch (seq) {
    case 'A':
      return { kind: 'up' };
    case 'B':
      return { kind: 'down' };
    case 'C':
      return { kind: 'right' };
    case 'D':
      return { kind: 'left' };
    case 'H':
    case '1~':
      return { kind: 'home' };
    case 'F':
    case '4~':
      return { kind: 'end' };
    case '3~':
      return { kind: 'delete' };
    case '1;5C':
      return { kind: 'word-right' };
    case '1;5D':
      return { kind: 'word-left' };
    case '13;2u':
      return { kind: 'newline' };
    // Shift-Tab. `CSI Z` with no parameters is what every terminal worth
    // supporting sends for it — xterm, iTerm2, Terminal.app, Alacritty, kitty in
    // its default mode — and it is unambiguous: no other key produces a bare `Z`
    // final byte.
    case 'Z':
      return { kind: 'cycle-mode' };
    default:
      return undefined;
  }
}

export interface ApplyOptions {
  /** Candidates for the current buffer, if the host can offer any. */
  complete?: (text: string) => readonly string[];
}

/**
 * One key, one new state. No I/O, no clock, no terminal.
 *
 * Returns the same object when nothing changed, so a driver can skip a redraw.
 */
export function applyKey(state: EditorState, key: Key, opts: ApplyOptions = {}): EditorState {
  const line = state.lines[state.row] ?? '';
  const next = (patch: Partial<EditorState>): EditorState => ({ ...state, ...patch });

  /** Snapshot before an edit, so Ctrl-Z has somewhere to go back to. */
  const remember = (patch: Partial<EditorState>): EditorState =>
    next({
      ...patch,
      undo: [...state.undo, { lines: state.lines, row: state.row, col: state.col }].slice(-MAX_UNDO),
      redo: [],
    });

  // Reverse search owns the keyboard while it is open (Ctrl-R).
  if (state.search) {
    const search = state.search;
    if (key.kind === 'search') {
      // Ctrl-R again: the next older match.
      return next({
        search: { ...search, at: Math.min(search.at + 1, Math.max(0, search.matches.length - 1)) },
      });
    }
    if (key.kind === 'escape' || key.kind === 'cancel') {
      // Leaves the search, keeps the line. Ctrl-C inside a search is "stop
      // searching", not "throw away what I was typing".
      return next({ search: undefined });
    }
    if (key.kind === 'enter') {
      const found = state.history[search.matches[search.at] ?? -1];
      if (found === undefined) return next({ search: undefined });
      return next({
        search: undefined,
        lines: found.split('\n'),
        row: found.split('\n').length - 1,
        col: (found.split('\n').pop() ?? '').length,
      });
    }
    if (key.kind === 'backspace') {
      const query = search.query.slice(0, -1);
      return next({ search: { query, matches: matchHistory(state.history, query), at: 0 } });
    }
    if (key.kind === 'text') {
      const query = search.query + key.text;
      return next({ search: { query, matches: matchHistory(state.history, query), at: 0 } });
    }
    return state;
  }

  // A menu on screen takes the navigation keys before the buffer does.
  if (state.menu.length > 0) {
    if (key.kind === 'up')
      return next({ menuAt: (state.menuAt - 1 + state.menu.length) % state.menu.length });
    if (key.kind === 'down') return next({ menuAt: (state.menuAt + 1) % state.menu.length });
    if (key.kind === 'escape') return next({ menu: [], menuAt: 0 });
    if (key.kind === 'enter' || key.kind === 'tab') {
      const picked = state.menu[state.menuAt] ?? '';
      const lines = [...state.lines];
      const start = tokenStart(line, state.col);
      lines[state.row] = line.slice(0, start) + picked + line.slice(state.col);
      return next({ lines, col: start + picked.length, menu: [], menuAt: 0 });
    }
  }

  switch (key.kind) {
    case 'text': {
      const lines = [...state.lines];
      // A pasted run can contain newlines; splitting here is what makes paste and
      // typing the same code path.
      const parts = key.text.split('\n');
      const head = line.slice(0, state.col);
      const tail = line.slice(state.col);
      if (parts.length === 1) {
        lines[state.row] = head + (parts[0] ?? '') + tail;
        return remember({ lines, col: state.col + (parts[0] ?? '').length, menu: [], menuAt: 0 });
      }
      const inserted = parts.map((part, index) =>
        index === 0 ? head + part : index === parts.length - 1 ? part + tail : part,
      );
      lines.splice(state.row, 1, ...inserted);
      return remember({
        lines,
        row: state.row + parts.length - 1,
        col: (parts[parts.length - 1] ?? '').length,
        menu: [],
        menuAt: 0,
      });
    }

    case 'enter':
      return next({ done: { kind: 'line', text: textOf(state) } });

    case 'newline': {
      const lines = [...state.lines];
      lines.splice(state.row, 1, line.slice(0, state.col), line.slice(state.col));
      return next({ lines, row: state.row + 1, col: 0 });
    }

    case 'backspace': {
      if (state.col > 0) {
        const lines = [...state.lines];
        lines[state.row] = line.slice(0, state.col - 1) + line.slice(state.col);
        return remember({ lines, col: state.col - 1, menu: [], menuAt: 0 });
      }
      if (state.row === 0) return state;
      const lines = [...state.lines];
      const previous = lines[state.row - 1] ?? '';
      lines.splice(state.row - 1, 2, previous + line);
      return remember({ lines, row: state.row - 1, col: previous.length });
    }

    case 'delete': {
      if (state.col < line.length) {
        const lines = [...state.lines];
        lines[state.row] = line.slice(0, state.col) + line.slice(state.col + 1);
        return next({ lines });
      }
      if (state.row >= state.lines.length - 1) return state;
      const lines = [...state.lines];
      lines.splice(state.row, 2, line + (lines[state.row + 1] ?? ''));
      return next({ lines });
    }

    case 'left':
      if (state.col > 0) return next({ col: state.col - 1 });
      if (state.row === 0) return state;
      return next({ row: state.row - 1, col: (state.lines[state.row - 1] ?? '').length });

    case 'right':
      if (state.col < line.length) return next({ col: state.col + 1 });
      if (state.row >= state.lines.length - 1) return state;
      return next({ row: state.row + 1, col: 0 });

    case 'home':
      return next({ col: 0 });

    case 'end':
      return next({ col: line.length });

    case 'word-left': {
      let at = state.col;
      while (at > 0 && !isWord(line[at - 1])) at -= 1;
      while (at > 0 && isWord(line[at - 1])) at -= 1;
      return next({ col: at });
    }

    case 'word-right': {
      let at = state.col;
      while (at < line.length && !isWord(line[at])) at += 1;
      while (at < line.length && isWord(line[at])) at += 1;
      return next({ col: at });
    }

    case 'kill-to-end': {
      const lines = [...state.lines];
      lines[state.row] = line.slice(0, state.col);
      return remember({ lines, killRing: line.slice(state.col) });
    }

    case 'kill-to-start': {
      const lines = [...state.lines];
      lines[state.row] = line.slice(state.col);
      return remember({ lines, col: 0, killRing: line.slice(0, state.col) });
    }

    case 'kill-word': {
      let at = state.col;
      while (at > 0 && !isWord(line[at - 1])) at -= 1;
      while (at > 0 && isWord(line[at - 1])) at -= 1;
      const lines = [...state.lines];
      lines[state.row] = line.slice(0, at) + line.slice(state.col);
      return remember({ lines, col: at, killRing: line.slice(at, state.col) });
    }

    case 'yank': {
      if (state.killRing === '') return state;
      const lines = [...state.lines];
      lines[state.row] = line.slice(0, state.col) + state.killRing + line.slice(state.col);
      return remember({ lines, col: state.col + state.killRing.length });
    }

    case 'up': {
      // Within a multi-line buffer, move between lines; on the first line, walk
      // history. Anything else surprises somebody composing a paragraph.
      if (state.row > 0) {
        const target = state.lines[state.row - 1] ?? '';
        return next({ row: state.row - 1, col: Math.min(state.col, target.length) });
      }
      if (state.historyAt === 0 || state.history.length === 0) return state;
      const at = state.historyAt - 1;
      const entry = state.history[at] ?? '';
      return next({
        historyAt: at,
        draft: state.historyAt === state.history.length ? textOf(state) : state.draft,
        lines: entry.split('\n'),
        row: entry.split('\n').length - 1,
        col: (entry.split('\n').pop() ?? '').length,
      });
    }

    case 'down': {
      if (state.row < state.lines.length - 1) {
        const target = state.lines[state.row + 1] ?? '';
        return next({ row: state.row + 1, col: Math.min(state.col, target.length) });
      }
      if (state.historyAt >= state.history.length) return state;
      const at = state.historyAt + 1;
      const entry = at === state.history.length ? (state.draft ?? '') : (state.history[at] ?? '');
      return next({
        historyAt: at,
        lines: entry.split('\n'),
        row: entry.split('\n').length - 1,
        col: (entry.split('\n').pop() ?? '').length,
      });
    }

    case 'tab': {
      const candidates = opts.complete?.(textOf(state)) ?? [];
      if (candidates.length === 0) return state;
      if (candidates.length === 1) {
        const picked = candidates[0] ?? '';
        const lines = [...state.lines];
        const start = tokenStart(line, state.col);
        lines[state.row] = line.slice(0, start) + picked + line.slice(state.col);
        return next({ lines, col: start + picked.length });
      }
      return next({ menu: candidates, menuAt: 0 });
    }

    case 'cancel':
      // Abandon this line. Not the session: that is Ctrl-D's job.
      return next({ done: { kind: 'cancel' } });

    case 'eof':
      return textOf(state) === '' ? next({ done: { kind: 'eof' } }) : state;

    case 'escape':
      return state.menu.length > 0 ? next({ menu: [], menuAt: 0 }) : state;

    case 'undo': {
      const last = state.undo[state.undo.length - 1];
      if (!last) return state;
      return next({
        lines: [...last.lines],
        row: Math.min(last.row, last.lines.length - 1),
        col: last.col,
        undo: state.undo.slice(0, -1),
        redo: [...state.redo, { lines: state.lines, row: state.row, col: state.col }].slice(-MAX_UNDO),
        menu: [],
        menuAt: 0,
      });
    }

    case 'redo': {
      const last = state.redo[state.redo.length - 1];
      if (!last) return state;
      return next({
        lines: [...last.lines],
        row: Math.min(last.row, last.lines.length - 1),
        col: last.col,
        redo: state.redo.slice(0, -1),
        undo: [...state.undo, { lines: state.lines, row: state.row, col: state.col }].slice(-MAX_UNDO),
        menu: [],
        menuAt: 0,
      });
    }

    case 'search':
      // Opens on the whole history, so the first Ctrl-R shows the most recent.
      return next({
        search: { query: '', matches: matchHistory(state.history, ''), at: 0 },
        menu: [],
        menuAt: 0,
      });

    // Both handled by the driver before they reach here, and listed rather than
    // left to `default` so that deleting the driver's handling produces a key
    // that visibly does nothing instead of one that silently falls through.
    case 'clear':
    case 'cycle-mode':
      return state;

    default:
      return state;
  }
}

/**
 * History entries containing the query, newest first.
 *
 * Case-insensitive, because a search you have to capitalise correctly is a search
 * you retype. An empty query matches everything, which is what makes the first
 * Ctrl-R show the most recent entry rather than nothing.
 */
export function matchHistory(history: readonly string[], query: string): number[] {
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if ((history[i] ?? '').toLowerCase().includes(needle)) out.push(i);
  }
  return out;
}

/** Where the token under the cursor begins — a `/command` or an `@path`. */
export function tokenStart(line: string, col: number): number {
  let start = col;
  while (start > 0 && !/\s/.test(line[start - 1] ?? '')) start -= 1;
  return start;
}

/**
 * How many terminal rows a buffer occupies, given the prompt widths.
 *
 * The whole reason the redraw is correct: a logical line is not a row. Measured in
 * columns, so a line of Chinese counts double, and `+ 1` because a line that exactly
 * fills the width still owns its own row.
 */
/**
 * Split a string into pieces that each fit a column budget.
 *
 * By display columns, so a two-column character is never cut in half — which is what
 * a naive `slice` does, and what the terminal then renders as a replacement glyph.
 */
export function chunkByColumns(text: string, width: number): string[] {
  const budget = Math.max(1, width);
  if (visibleWidth(text) <= budget) return [text];
  const out: string[] = [];
  let piece = '';
  let used = 0;
  for (const ch of text) {
    const w = visibleWidth(ch);
    if (used + w > budget && piece !== '') {
      out.push(piece);
      piece = '';
      used = 0;
    }
    piece += ch;
    used += w;
  }
  out.push(piece);
  return out;
}

export interface Layout {
  /** Every visual row of the buffer, prefix included, in order. */
  rows: readonly string[];
  /** Which of those rows the cursor is on. */
  cursorRow: number;
  /** And which column of it. */
  cursorCol: number;
}

/**
 * The buffer as the terminal will actually lay it out.
 *
 * One function, because everything downstream needs the same answer: how tall the
 * block is, which row the cursor is on, which rows to draw. This arithmetic used to
 * live in three places — `rowsUsed`, `cursorRowOf` and `renderEditor` — and three
 * copies of a row calculation is three chances for them to disagree about where the
 * block begins, which is a redraw clearing somebody else's output.
 *
 * A logical line becomes one row plus one for each time it wraps. Only the first row
 * of a logical line carries the prompt; the terminal supplies no prefix when it wraps.
 */
export function layout(state: EditorState, opts: RenderOptions): Layout {
  const columns = Math.max(1, opts.columns);
  const promptWidth = visibleWidth(opts.prompt);
  const continuationWidth = visibleWidth(opts.continuation);

  const rows: string[] = [];
  let cursorRow = 0;
  let cursorCol = promptWidth;

  state.lines.forEach((line, index) => {
    const prefix = index === 0 ? opts.prompt : opts.continuation;
    const prefixWidth = index === 0 ? promptWidth : continuationWidth;
    const first = rows.length;

    // The first row shares its width with the prompt; the wrapped ones do not.
    const head = chunkByColumns(line, Math.max(1, columns - prefixWidth));
    const headText = head[0] ?? '';
    rows.push(`${prefix}${headText}`);
    const rest = line.slice(headText.length);
    for (const piece of chunkByColumns(rest, columns)) {
      if (piece !== '') rows.push(piece);
    }

    // A row filled to the last column gets an empty row after it, and that row is
    // really drawn. Terminals defer the wrap — the cursor sits pending at the edge
    // until one more character arrives — so "does an exactly-full line occupy one row
    // or two" has no answer that is true of the screen alone. Drawing the empty row
    // makes it true: the terminal then has the row, the cursor has somewhere to be,
    // and the count matches what was written. Guessing either way instead leaves
    // `cursorRow` pointing past the end of `rows`.
    if (visibleWidth(rows[rows.length - 1] ?? '') >= columns) rows.push('');

    if (index === state.row) {
      const upto = visibleWidth(line.slice(0, state.col));
      if (upto + prefixWidth < columns) {
        cursorRow = first;
        cursorCol = prefixWidth + upto;
      } else {
        const past = upto + prefixWidth - columns;
        cursorRow = first + 1 + Math.floor(past / columns);
        cursorCol = past % columns;
      }
    }
  });

  return { rows, cursorRow, cursorCol };
}

export interface RenderOptions {
  prompt: string;
  continuation: string;
  columns: number;
  palette: Palette;
  glyphs: Glyphs;
  /**
   * How tall the terminal is.
   *
   * The redraw moves up by the number of rows it drew, and a row that has scrolled
   * off the top cannot be moved back to. So the block never draws more rows than the
   * window holds: the buffer gets a viewport that follows the cursor, and the
   * completion menu gets what is left.
   *
   * Absent means unbounded, which is what a test has and what a pipe never reaches.
   */
  rows?: number;
  /**
   * A rule drawn under the input, redrawn with it.
   *
   * Owned by the editor rather than by the caller, which is what removes
   * `keepFrame`: readline erased everything below its line on every keystroke and
   * the rule had to be put back after each one. Nothing erases it here, because the
   * thing doing the erasing is also the thing drawing it.
   */
  footer?: string;
}

export interface Viewport {
  /** The buffer rows to draw, and where the cursor sits among them. */
  bufferRows: readonly string[];
  cursorRow: number;
  cursorCol: number;
  /** The menu slice to draw, and which of those is selected. */
  menuItems: readonly string[];
  menuSelected: number;
  footerRows: number;
  /** Everything above, added up. What the next redraw must clear. */
  total: number;
}

/**
 * How the window is divided between the buffer, the menu and the rule.
 *
 * The policy, stated once so it can be argued with: **the menu never takes more than
 * half**, and then each grows into whatever the other did not need. A menu that
 * pushed the buffer off screen would hide what is being typed in order to show
 * suggestions about it.
 *
 * The buffer's slice follows the cursor rather than the top of the buffer, so
 * scrolling up through a long paste shows where you are rather than where you began.
 */
export function viewport(state: EditorState, opts: RenderOptions): Viewport {
  const plan = layout(state, opts);
  const footerRows = opts.footer !== undefined && opts.footer !== '' ? 1 : 0;
  const height = opts.rows ?? Number.POSITIVE_INFINITY;

  if (!Number.isFinite(height)) {
    return {
      bufferRows: plan.rows,
      cursorRow: plan.cursorRow,
      cursorCol: plan.cursorCol,
      menuItems: state.menu,
      menuSelected: state.menuAt,
      footerRows,
      total: plan.rows.length + state.menu.length + footerRows,
    };
  }

  const available = Math.max(1, Math.floor(height) - 1);
  const forContent = Math.max(1, available - footerRows);

  let menuShare = Math.min(state.menu.length, Math.floor(forContent / 2));
  const bufferShare = Math.max(1, Math.min(plan.rows.length, forContent - menuShare));
  menuShare = Math.min(state.menu.length, Math.max(0, forContent - bufferShare));

  // The buffer window follows the cursor and never runs off either end.
  const bufferStart = Math.min(
    Math.max(0, plan.cursorRow - Math.floor(bufferShare / 2)),
    Math.max(0, plan.rows.length - bufferShare),
  );
  const bufferRows = plan.rows.slice(bufferStart, bufferStart + bufferShare);

  const menuStart = Math.min(
    Math.max(0, state.menuAt - Math.floor(menuShare / 2)),
    Math.max(0, state.menu.length - menuShare),
  );
  const menuItems = state.menu.slice(menuStart, menuStart + menuShare);

  return {
    bufferRows,
    cursorRow: plan.cursorRow - bufferStart,
    cursorCol: plan.cursorCol,
    menuItems,
    menuSelected: state.menuAt - menuStart,
    footerRows,
    total: bufferRows.length + menuItems.length + footerRows,
  };
}

/**
 * Which row of its own block the cursor sits on, counting from the top.
 *
 * Shared by the redraw and by the teardown, because both need it and a second copy
 * of this arithmetic is how the two stop agreeing about where the block is.
 */
export function cursorRowOf(state: EditorState, opts: RenderOptions): number {
  if (state.search) return 0;
  return viewport(state, opts).cursorRow;
}

/**
 * Erase the block, leaving the cursor where it began.
 *
 * The editor draws several rows — the prompt line, any wrapped rows, a menu, the
 * rule — and something has to take them down when the line is finished. Until this
 * existed the caller's `submitted()` moved up one row and cleared, which was right
 * when input was one readline row and wrong afterwards: the prompt line survived and
 * the sent line appeared twice, once as typed and once as the inverse block.
 */
export function clearBlock(state: EditorState, opts: RenderOptions): string {
  const row = cursorRowOf(state, opts);
  return `\r${row > 0 ? `${CSI}${row}A` : ''}${CSI}J`;
}

/**
 * The buffer and any menu, as the bytes that put them on screen.
 *
 * `previousRows` is how many rows the last render occupied: the cursor is somewhere
 * inside them, so the redraw goes to the top of that block and clears down. Passing
 * zero means "nothing there yet".
 */
export function renderEditor(state: EditorState, opts: RenderOptions, previousRows: number): string {
  const { columns, palette: p } = opts;
  let out = '';

  if (previousRows > 0) {
    out += `\r${previousRows > 1 ? `${CSI}${previousRows - 1}A` : ''}`;
  }
  out += `\r${CSI}J`;

  // Reverse search replaces the prompt line while it is open, the way a shell does:
  // what is being searched for, and the entry it currently points at.
  if (state.search) {
    const found = state.history[state.search.matches[state.search.at] ?? -1] ?? '';
    const label = p.dim(`(reverse-i-search)'${state.search.query}': `);
    out += `${label}${truncate(found, Math.max(8, columns - visibleWidth(label) - 1))}`;
    out += `\r${CSI}${visibleWidth(label) + visibleWidth(state.search.query)}C`;
    return out;
  }

  const view = viewport(state, opts);
  out += view.bufferRows.join('\n');

  if (view.menuItems.length > 0) {
    out += '\n';
    out += view.menuItems
      .map((item, index) =>
        index === view.menuSelected ? `  ${p.boldBlue('❯')} ${p.boldBlue(item)}` : `    ${p.dim(item)}`,
      )
      .join('\n');
  }

  if (view.footerRows > 0) out += `\n${opts.footer ?? ''}`;

  // Back to the cursor: up from the end of what was written, then across.
  const up = view.total - 1 - view.cursorRow;
  if (up > 0) out += `${CSI}${up}A`;
  out += `\r${view.cursorCol > 0 ? `${CSI}${view.cursorCol}C` : ''}`;

  return out;
}

/** Rows the last render occupied, for the next one to clear. */
export function renderedRows(state: EditorState, opts: RenderOptions): number {
  // Search is one row and replaces everything else, so the next redraw clears one.
  if (state.search) return 1;
  return viewport(state, opts).total;
}

/**
 * Signals after which the terminal is ours to put back.
 *
 * `SIGINT` is absent deliberately: in raw mode Ctrl-C arrives as a byte and is the
 * editor's own key, and a session that handled it here would exit instead of
 * cancelling the turn.
 */
export const RESTORE_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGQUIT'];

/** Just enough of `process.stdin` to drive the editor, so a test can supply a fake. */
export interface EditorInput {
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  off(event: 'data', listener: (chunk: Buffer | string) => void): void;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
}

export interface EditorOptions {
  input: EditorInput;
  write: (s: string) => void;
  palette: Palette;
  glyphs: Glyphs;
  columns: () => number;
  /** The terminal height, re-read like the width. */
  rows?: () => number;
  prompt: () => string;
  continuation: string;
  footer?: () => string;
  complete?: (text: string) => readonly string[];
  /**
   * Subscribe to end-of-input. Returns an unsubscribe.
   *
   * A separate function rather than a wider `EditorInput`, so the shape stays small
   * enough for `process.stdin` to satisfy it structurally and for a test to fake it.
   */
  onEnd?: (listener: () => void) => () => void;
  /**
   * Called with the buffer after every change.
   *
   * Exists because completion candidates can be asynchronous and Tab is not: a
   * completer that awaited would either block the keystroke or answer after the
   * next one. The host keeps its candidates current here and Tab reads whatever is
   * ready — one keystroke behind at worst, and never blocking.
   */
  onChange?: (text: string) => void;
  /** Remapped control keys, from the user's keybindings file. */
  keybindings?: ReadonlyMap<number, Key>;
  /** Called when Ctrl-L is pressed, before the prompt is drawn again. */
  onClear?: () => void;
  /**
   * Called when Shift-Tab is pressed. The host changes the mode and may return
   * text to show above the prompt.
   *
   * **Synchronous, and it must stay that way.** The editor writes whatever comes
   * back and then redraws from a clean slate. An earlier version had the host
   * fire an async command and write from its `.then()`: the write landed after
   * the redraw, so the message printed into the middle of the prompt block and
   * the next redraw moved up one line against five lines of leftover text. Seen
   * through a real pty, not reasoned about.
   *
   * Returning nothing is fine — the prompt indicator is feedback by itself.
   */
  onCycleMode?: () => string | undefined;
}

/**
 * The driver: the stream, the raw mode, the redraw, and putting the terminal back.
 *
 * Deliberately thin. Everything that decides anything is in `applyKey`; this class
 * moves bytes and counts rows. Criterion 5 lives here — raw mode and bracketed paste
 * are terminal state that outlives the process, so they are restored on the way out
 * of every path including a crash, not only on the return path. Bracketed paste left
 * on is the nastier of the two: every subsequent paste in that shell arrives wrapped
 * in `200~`/`201~` markers, in a program that has exited and cannot strip them.
 */
export class Editor {
  private readonly opts: EditorOptions;
  private readonly history: string[] = [];
  private restoring = false;
  private readonly restore = (): void => this.teardown();

  constructor(opts: EditorOptions) {
    this.opts = opts;
  }

  /** Read one line. `null` for Ctrl-C or Ctrl-D on an empty buffer. */
  read(): Promise<EditorOutcome> {
    const { input, write } = this.opts;
    let state = newEditorState(this.history);
    let rows = 0;
    const paste = newPasteState();

    const options = (): RenderOptions => ({
      prompt: this.opts.prompt(),
      continuation: this.opts.continuation,
      columns: this.opts.columns(),
      ...(this.opts.rows ? { rows: this.opts.rows() } : {}),
      palette: this.opts.palette,
      glyphs: this.opts.glyphs,
      ...(this.opts.footer ? { footer: this.opts.footer() } : {}),
    });

    const draw = (): void => {
      const view = options();
      write(renderEditor(state, view, rows));
      rows = renderedRows(state, view);
    };

    input.setRawMode?.(true);
    input.resume();
    write(PASTE_ON);
    this.arm();
    draw();

    return new Promise<EditorOutcome>((resolve) => {
      const finish = (answer: EditorOutcome): void => {
        input.off('data', onData);
        unsubscribeEnd?.();
        write(PASTE_OFF);
        input.setRawMode?.(false);
        input.pause();
        this.disarm();
        // Take the block down. Whatever prints next — the inverse block for a sent
        // line, or nothing at all for an abandoned one — starts where the prompt was.
        write(clearBlock(state, options()));
        if (answer.kind === 'line' && answer.text.trim() !== '') this.history.push(answer.text);
        resolve(answer);
      };

      const onData = (chunk: Buffer | string): void => {
        for (const key of parseInput(chunk.toString(), this.opts.keybindings, paste)) {
          if (key.kind === 'clear') {
            this.opts.onClear?.();
            write(`${CSI}2J${CSI}H`);
            rows = 0;
            draw();
            continue;
          }
          // Not `applyKey`'d at all — the buffer is whatever the user was typing
          // and Shift-Tab must not disturb a half-written line, cursor included.
          //
          // The order is the whole of it: take the block down, write the host's
          // message where the block was, then redraw from `rows = 0` so the next
          // redraw is not measuring against rows the message pushed away. Same
          // sequence `clear` uses above, and for the same reason.
          if (key.kind === 'cycle-mode') {
            const notice = this.opts.onCycleMode?.();
            if (notice !== undefined && notice !== '') {
              write(clearBlock(state, options()));
              write(`${notice}\n`);
              rows = 0;
            }
            draw();
            continue;
          }
          const before = state;
          state = applyKey(state, key, this.opts.complete ? { complete: this.opts.complete } : {});
          if (state.done !== undefined) {
            finish(state.done);
            return;
          }
          if (state !== before) {
            if (textOf(state) !== textOf(before)) this.opts.onChange?.(textOf(state));
            draw();
          }
        }
      };

      // End of input is not the same key as Ctrl-D and does not arrive as one.
      // Found by running it: a terminal whose input closes — a pty going away, a
      // harness feeding a script — produced an editor that drew its prompt correctly
      // and then waited forever for a keystroke that could never come.
      const unsubscribeEnd = this.opts.onEnd?.(() => finish({ kind: 'eof' }));

      input.on('data', onData);
    });
  }

  /**
   * Restore on every way out, not only the return path.
   *
   * `exit` covers a normal end and an uncaught throw. It does **not** fire for a
   * signal, and a signal is how a terminal usually loses its foreground process —
   * a closed window, a `kill`, a parent going away. Raw mode the shell will fix;
   * bracketed paste it will not, and every subsequent paste in that terminal then
   * arrives wrapped in `200~`/`201~` markers from a program that has exited.
   *
   * This is the same class of defect as `reference/clio` leaving a scroll region
   * behind, milder only because the residue is smaller. Having criticised it there,
   * leaving it here would be the shabbier of the two.
   *
   * `SIGKILL` cannot be caught by anything, and is the one case no program can fix.
   */
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    this.teardown();
    // Re-raise with the default action, so the exit status still says what happened.
    process.removeListener(signal, this.onSignal);
    process.kill(process.pid, signal);
  };

  private arm(): void {
    process.once('exit', this.restore);
    for (const signal of RESTORE_SIGNALS) process.once(signal, this.onSignal);
  }

  private disarm(): void {
    process.off('exit', this.restore);
    for (const signal of RESTORE_SIGNALS) process.off(signal, this.onSignal);
  }

  /** Put the terminal back. Safe to call twice; called on the exit path too. */
  teardown(): void {
    if (this.restoring) return;
    this.restoring = true;
    this.opts.write(PASTE_OFF);
    this.opts.input.setRawMode?.(false);
    this.restoring = false;
  }
}
