/**
 * The line editor (`src/cli/editor.ts`, ADR-0032).
 *
 * `reference/clio`'s equivalent is 1196 lines with no tests at all, and six
 * catalogued defects. Those six are this file's contents — a test named after each,
 * so that a later rewrite has to argue with them rather than rediscover them.
 *
 * The reason there is anything to test without a terminal is that `applyKey` is a
 * pure function. That was criterion 6, and it is the one that makes the other five
 * checkable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyKey,
  Editor,
  PASTE_OFF,
  PASTE_ON,
  MAX_UNDO,
  layout,
  RESTORE_SIGNALS,
  newEditorState,
  newPasteState,
  parseInput,
  renderEditor,
  renderedRows,
  viewport,
  textOf,
  tokenStart,
  type EditorState,
  type Key,
} from '../../src/cli/editor.ts';
import { glyphs, palette, visibleWidth } from '../../src/cli/render.ts';

const ESC = String.fromCharCode(27);
const plain = palette(false);
const g = glyphs(true);

/** Type a string as if a person had. */
function type(state: EditorState, data: string): EditorState {
  return parseInput(data).reduce((s, key) => applyKey(s, key), state);
}

const render = { prompt: '> ', continuation: '… ', columns: 40, palette: plain, glyphs: g };

/** How many visual rows a buffer occupies, which is what every redraw depends on. */
function rowsOf(lines: string[], columns = 40, prompt = '> ', continuation = '  '): number {
  const state = { ...newEditorState(), lines };
  return layout(state, { ...render, columns, prompt, continuation }).rows.length;
}

describe('criterion 1 — a wrapped line occupies more than one row', () => {
  test('rows are counted from columns and the terminal width, not from line count', () => {
    // Three logical lines, one of which is three rows wide.
    assert.equal(rowsOf(['']), 1);
    assert.equal(rowsOf(['x'.repeat(37)]), 1, '39 columns still fits one row');
    // Exactly full: the terminal defers the wrap, so the empty row is drawn rather
    // than assumed either way. See the note in `layout`.
    assert.equal(rowsOf(['x'.repeat(38)]), 2, '40 columns owns a second row');
    assert.equal(rowsOf(['x'.repeat(100)]), 3);
    assert.equal(rowsOf(['a', 'b']), 2);
  });

  test('the redraw moves up by rows, so it never clears a line it did not write', () => {
    const state = type(newEditorState(), 'x'.repeat(100));
    const rows = renderedRows(state, render);
    assert.equal(rows, 3, `a 100-column line in a 40-column terminal is 3 rows, not ${rows}`);
    const out = renderEditor(state, render, rows);
    assert.match(out, new RegExp(`^\\r${ESC}\\[2A`), 'the redraw must go to the top of its own block');
  });

  test('nothing is moved when there was nothing on screen yet', () => {
    const out = renderEditor(newEditorState(), render, 0);
    assert.equal(new RegExp(`${ESC}\\[\\d+A`).test(out), false, 'it moved up over somebody else output');
  });
});

describe('criterion 2 — measured in columns, not characters', () => {
  test('a line of Chinese is twice as many rows as its character count suggests', () => {
    // 30 characters, 60 columns: two rows in a 40-column terminal, not one.
    assert.equal(rowsOf(['修'.repeat(30)]), 2);
    assert.equal(rowsOf(['x'.repeat(30)]), 1);
  });

  test('the cursor lands on the right column after typing Chinese', () => {
    const state = type(newEditorState(), '修复');
    const out = renderEditor(state, render, 0);
    // Prompt is 2 columns, the text is 4: the cursor belongs at column 6.
    assert.match(out, new RegExp(`${ESC}\\[6C`), `cursor not at column 6: ${JSON.stringify(out)}`);
  });

  test('the prompt width counts too, whatever it is made of', () => {
    assert.equal(rowsOf(['x'.repeat(38)], 40, '', ''), 1, 'no prompt, so it still fits');
    assert.equal(rowsOf(['x'.repeat(38)]), 2, 'a two-column prompt pushes it over');
  });
});

describe('criterion 3 — bracketed paste, not a guess', () => {
  test('everything between the markers is text, newlines included', () => {
    const keys = parseInput(`${ESC}[200~line one\nline two${ESC}[201~`);
    assert.deepEqual(keys, [{ kind: 'text', text: 'line one\nline two' }]);
  });

  test('a pasted newline does not submit, which is what clio gets wrong', () => {
    // clio decides "chunk contains a newline" means paste, and a paste ending in one
    // auto-submits. Here the markers say what it is, so nothing is inferred.
    const state = type(newEditorState(), `${ESC}[200~one\ntwo\n${ESC}[201~`);
    assert.equal(state.done, undefined, 'a paste submitted the line');
    assert.equal(textOf(state), 'one\ntwo\n');
  });

  test('a typed newline still submits', () => {
    const state = type(newEditorState(), 'hello\r');
    assert.deepEqual(state.done, { kind: 'line', text: 'hello' });
  });

  test('an unterminated paste is still treated as text rather than as keys', () => {
    // The end marker can land in the next chunk. Guessing "these are keystrokes"
    // would run whatever control characters the pasted text happened to contain.
    const keys = parseInput(`${ESC}[200~half a paste`);
    assert.deepEqual(keys, [{ kind: 'text', text: 'half a paste' }]);
  });
});

describe('criterion 4 — one key-handling path', () => {
  test('every key the editor understands comes out of parseInput and nowhere else', () => {
    const cases: Array<[string, Key['kind']]> = [
      ['\r', 'enter'],
      ['\n', 'enter'],
      [String.fromCharCode(10), 'enter'],
      [String.fromCharCode(3), 'cancel'],
      [String.fromCharCode(4), 'eof'],
      [String.fromCharCode(1), 'home'],
      [String.fromCharCode(5), 'end'],
      [String.fromCharCode(11), 'kill-to-end'],
      [String.fromCharCode(21), 'kill-to-start'],
      [String.fromCharCode(23), 'kill-word'],
      [String.fromCharCode(25), 'yank'],
      [String.fromCharCode(9), 'tab'],
      [String.fromCharCode(127), 'backspace'],
      [`${ESC}[A`, 'up'],
      [`${ESC}[B`, 'down'],
      [`${ESC}[C`, 'right'],
      [`${ESC}[D`, 'left'],
      [`${ESC}[H`, 'home'],
      [`${ESC}[F`, 'end'],
      [`${ESC}[3~`, 'delete'],
      [`${ESC}[1;5C`, 'word-right'],
      [`${ESC}[1;5D`, 'word-left'],
      [`${ESC}[Z`, 'cycle-mode'],
    ];
    for (const [input, kind] of cases) {
      const keys = parseInput(input);
      assert.equal(keys[0]?.kind, kind, `${JSON.stringify(input)} decoded as ${keys[0]?.kind}`);
    }
  });

  test('an unknown escape sequence is dropped, not typed into the buffer', () => {
    const state = type(newEditorState(), `${ESC}[99~abc`);
    assert.equal(textOf(state), 'abc');
  });

  test('a chunk holding several keypresses is decoded in order', () => {
    const keys = parseInput(`ab${ESC}[Dc`);
    assert.deepEqual(
      keys.map((k) => k.kind),
      ['text', 'left', 'text'],
    );
  });

  /**
   * Shift-Tab is the host's key, and the buffer must not notice it.
   *
   * Plain Tab is completion and Shift-Tab cycles the approval mode, so the two
   * have to stay distinguishable — and the mode key must leave a half-written
   * line exactly as it was, cursor included. The driver intercepts it before
   * `applyKey`; this asserts the fallback is also inert, so removing the
   * interception would produce a key that does nothing rather than one that
   * silently edits.
   */
  test('Shift-Tab is not Tab, and does not touch the buffer', () => {
    assert.equal(parseInput(String.fromCharCode(9))[0]?.kind, 'tab');
    assert.equal(parseInput(`${ESC}[Z`)[0]?.kind, 'cycle-mode');

    const typed = type(newEditorState(), 'npm ru');
    const after = applyKey(typed, { kind: 'cycle-mode' });
    assert.equal(textOf(after), 'npm ru');
    assert.equal(after.col, typed.col);
    assert.equal(after.row, typed.row);
  });
});

describe('editing', () => {
  test('typing, moving and deleting', () => {
    let s = type(newEditorState(), 'hello world');
    assert.equal(textOf(s), 'hello world');
    s = type(s, `${ESC}[D${ESC}[D`);
    s = applyKey(s, { kind: 'backspace' });
    assert.equal(textOf(s), 'hello wold');
    s = applyKey(s, { kind: 'home' });
    assert.equal(s.col, 0);
    s = applyKey(s, { kind: 'end' });
    assert.equal(s.col, 10);
  });

  test('word motion and word kill stop at word boundaries', () => {
    let s = type(newEditorState(), 'alpha beta gamma');
    s = applyKey(s, { kind: 'word-left' });
    assert.equal(s.col, 11, 'should sit at the start of "gamma"');
    s = applyKey(s, { kind: 'end' });
    s = applyKey(s, { kind: 'kill-word' });
    assert.equal(textOf(s), 'alpha beta ');
    assert.equal(s.killRing, 'gamma');
    s = applyKey(s, { kind: 'yank' });
    assert.equal(textOf(s), 'alpha beta gamma');
  });

  test('multi-line composition, and backspace joining lines back up', () => {
    let s = type(newEditorState(), 'first');
    s = applyKey(s, { kind: 'newline' });
    s = type(s, 'second');
    assert.equal(textOf(s), 'first\nsecond');
    assert.equal(s.row, 1);
    s = applyKey(s, { kind: 'home' });
    s = applyKey(s, { kind: 'backspace' });
    assert.equal(textOf(s), 'firstsecond');
    assert.equal(s.row, 0);
    assert.equal(s.col, 5);
  });

  test('Enter submits the whole buffer, not the line the cursor is on', () => {
    let s = type(newEditorState(), 'one');
    s = applyKey(s, { kind: 'newline' });
    s = type(s, 'two');
    s = applyKey(s, { kind: 'up' });
    s = applyKey(s, { kind: 'enter' });
    assert.deepEqual(s.done, { kind: 'line', text: 'one\ntwo' });
  });

  test('Ctrl-D ends input only on an empty buffer', () => {
    assert.deepEqual(applyKey(newEditorState(), { kind: 'eof' }).done, { kind: 'eof' });
    const typed = type(newEditorState(), 'x');
    assert.equal(applyKey(typed, { kind: 'eof' }).done, undefined);
  });
});

describe('history', () => {
  const history = ['first task', 'second task'];

  test('Up walks back, Down walks forward, and the draft comes back', () => {
    let s = type(newEditorState(history), 'half-typed');
    s = applyKey(s, { kind: 'up' });
    assert.equal(textOf(s), 'second task');
    s = applyKey(s, { kind: 'up' });
    assert.equal(textOf(s), 'first task');
    s = applyKey(s, { kind: 'down' });
    assert.equal(textOf(s), 'second task');
    s = applyKey(s, { kind: 'down' });
    assert.equal(textOf(s), 'half-typed', 'what was being typed must come back');
  });

  test('inside a multi-line buffer the arrows move between lines, not through history', () => {
    // Otherwise composing a paragraph throws it away on the first Up.
    let s = type(newEditorState(history), 'line one');
    s = applyKey(s, { kind: 'newline' });
    s = type(s, 'line two');
    s = applyKey(s, { kind: 'up' });
    assert.equal(textOf(s), 'line one\nline two', 'history was walked from inside a paragraph');
    assert.equal(s.row, 0);
  });
});

describe('completion', () => {
  const complete = (text: string): string[] =>
    ['/status', '/skills', '/undo'].filter((c) => c.startsWith(text));

  test('a single candidate is inserted without a menu', () => {
    const s = applyKey(type(newEditorState(), '/u'), { kind: 'tab' }, { complete });
    assert.equal(textOf(s), '/undo');
    assert.equal(s.menu.length, 0);
  });

  test('several candidates open a menu that the arrows move through', () => {
    let s = applyKey(type(newEditorState(), '/s'), { kind: 'tab' }, { complete });
    assert.deepEqual([...s.menu], ['/status', '/skills']);
    s = applyKey(s, { kind: 'down' });
    assert.equal(s.menuAt, 1);
    s = applyKey(s, { kind: 'enter' });
    assert.equal(textOf(s), '/skills', 'Enter in a menu picks, it does not submit');
    assert.equal(s.done, undefined);
  });

  test('Escape closes the menu and leaves the buffer alone', () => {
    let s = applyKey(type(newEditorState(), '/s'), { kind: 'tab' }, { complete });
    s = applyKey(s, { kind: 'escape' });
    assert.equal(s.menu.length, 0);
    assert.equal(textOf(s), '/s');
  });

  test('the token under the cursor is what gets replaced', () => {
    assert.equal(tokenStart('read @src/app', 13), 5);
    assert.equal(tokenStart('/status', 7), 0);
    assert.equal(tokenStart('', 0), 0);
  });
});

describe('what the renderer puts on screen', () => {
  test('the continuation prompt marks every line after the first', () => {
    let s = type(newEditorState(), 'one');
    s = applyKey(s, { kind: 'newline' });
    s = type(s, 'two');
    const out = renderEditor(s, render, 0);
    assert.match(out, /> one/);
    assert.match(out, /… two/);
  });

  test('a plain palette leaves no colour in the menu', () => {
    const s = applyKey(
      type(newEditorState(), '/s'),
      { kind: 'tab' },
      {
        complete: () => ['/status', '/skills'],
      },
    );
    const out = renderEditor(s, render, 0);
    assert.match(out, /\/status/);
    assert.match(out, /\/skills/);
    // Only cursor movement, no SGR: the palette is off.
    assert.equal(/\[\d*[m]/.test(out.replace(/\[\d*[A-DCJ]/g, '')), false);
  });

  test('every row of the render is accounted for by renderedRows', () => {
    // The two have to agree or the next redraw clears the wrong number of rows.
    const cases: EditorState[] = [
      newEditorState(),
      type(newEditorState(), 'short'),
      type(newEditorState(), 'x'.repeat(100)),
      type(newEditorState(), '修'.repeat(40)),
    ];
    for (const s of cases) {
      const rows = renderedRows(s, render);
      const body = s.lines
        .map((line, i) => visibleWidth(line) + (i === 0 ? 2 : 2))
        .reduce((total, used) => total + Math.floor(used / 40) + 1, 0);
      assert.equal(rows, body, `disagreement on ${JSON.stringify(textOf(s)).slice(0, 30)}`);
    }
  });
});

describe('criterion 5 — the terminal is put back, on every path', () => {
  function fakeInput() {
    const listeners: Array<(c: Buffer | string) => void> = [];
    const raw: boolean[] = [];
    return {
      raw,
      on: (_e: 'data', l: (c: Buffer | string) => void) => void listeners.push(l),
      off: (_e: 'data', l: (c: Buffer | string) => void) => {
        const at = listeners.indexOf(l);
        if (at >= 0) listeners.splice(at, 1);
      },
      setRawMode: (mode: boolean) => void raw.push(mode),
      resume: () => {},
      pause: () => {},
      send: (s: string) => listeners.forEach((l) => l(Buffer.from(s))),
      listenerCount: () => listeners.length,
    };
  }

  function driver(
    input: ReturnType<typeof fakeInput>,
    written: string[],
    onEnd?: (l: () => void) => () => void,
  ) {
    return new Editor({
      input,
      write: (s) => written.push(s),
      palette: plain,
      glyphs: g,
      columns: () => 40,
      prompt: () => '> ',
      continuation: '  ',
      ...(onEnd ? { onEnd } : {}),
    });
  }

  test('bracketed paste is turned on, and off again when the line is done', async () => {
    const input = fakeInput();
    const written: string[] = [];
    const line = driver(input, written).read();
    input.send('hello\r');
    assert.deepEqual(await line, { kind: 'line', text: 'hello' });
    const all = written.join('');
    assert.ok(all.includes(PASTE_ON), 'bracketed paste was never enabled');
    assert.ok(all.lastIndexOf(PASTE_OFF) > all.indexOf(PASTE_ON), 'it was left on');
    assert.deepEqual(input.raw, [true, false], 'raw mode was left on');
    assert.equal(input.listenerCount(), 0, 'the data listener outlived the read');
  });

  test('end of input resolves the read rather than waiting forever', async () => {
    // Found by running it under a pty whose input closed: the prompt drew correctly
    // and then hung, because end-of-stream is not a keystroke and never arrives as one.
    const input = fakeInput();
    const written: string[] = [];
    let fire: (() => void) | undefined;
    const line = driver(input, written, (l) => {
      fire = l;
      return () => {};
    }).read();
    assert.notEqual(fire, undefined, 'the editor did not subscribe to end of input');
    fire?.();
    assert.deepEqual(await line, { kind: 'eof' });
    assert.deepEqual(input.raw, [true, false]);
  });

  test('teardown alone restores the terminal, for the paths that never finish a read', () => {
    const input = fakeInput();
    const written: string[] = [];
    driver(input, written).teardown();
    assert.ok(written.join('').includes(PASTE_OFF));
    assert.deepEqual(input.raw, [false]);
  });
});

describe('criterion 5, continued — a signal is a way out too', () => {
  test('the signals that get a restore, and the one that deliberately does not', () => {
    // SIGINT is absent on purpose: in raw mode Ctrl-C arrives as a byte and is the
    // editor's own key. Handling it here would exit instead of cancelling the turn.
    assert.deepEqual([...RESTORE_SIGNALS], ['SIGTERM', 'SIGHUP', 'SIGQUIT']);
    assert.equal(RESTORE_SIGNALS.includes('SIGINT'), false);
  });

  test('a read arms the signal handlers and a finished read disarms them', async () => {
    // Tracked by identity rather than by count. A count is a claim about the whole
    // process — anything else that adds or removes a signal listener while this runs
    // makes it wrong — and a test that can be made wrong by its neighbours is a test
    // that will be, eventually, on some machine, once.
    const before = RESTORE_SIGNALS.map((s) => new Set(process.listeners(s)));
    const ours = (i: number) =>
      process.listeners(RESTORE_SIGNALS[i] as NodeJS.Signals).filter((l) => !before[i]!.has(l));

    const listeners: Array<(c: Buffer | string) => void> = [];
    const input = {
      on: (_e: 'data', l: (c: Buffer | string) => void) => void listeners.push(l),
      off: (_e: 'data', l: (c: Buffer | string) => void) => {
        const at = listeners.indexOf(l);
        if (at >= 0) listeners.splice(at, 1);
      },
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    };
    const editor = new Editor({
      input,
      write: () => {},
      palette: plain,
      glyphs: g,
      columns: () => 40,
      prompt: () => '> ',
      continuation: '  ',
    });

    const line = editor.read();
    RESTORE_SIGNALS.forEach((signal, i) => {
      assert.equal(ours(i).length, 1, `${signal} was not armed`);
    });

    listeners.forEach((l) => l(Buffer.from('\r')));
    await line;

    RESTORE_SIGNALS.forEach((signal, i) => {
      assert.deepEqual(ours(i), [], `${signal} handler outlived the read`);
    });
  });
});

describe('undo, and reverse history search', () => {
  test('Ctrl-Z steps back through edits, and stops when there is nothing left', () => {
    let s = type(newEditorState(), 'hello');
    s = type(s, ' world');
    assert.equal(textOf(s), 'hello world');
    s = applyKey(s, { kind: 'undo' });
    assert.equal(textOf(s), 'hello', 'one edit back');
    // Every keystroke is an edit, so walking all the way back reaches empty and stays.
    for (let i = 0; i < 40; i += 1) s = applyKey(s, { kind: 'undo' });
    assert.equal(textOf(s), '');
    assert.equal(applyKey(s, { kind: 'undo' }), s, 'undo with nothing to undo must be a no-op');
  });

  test('redo comes back, and a fresh edit throws the redo away', () => {
    let s = type(newEditorState(), 'abc');
    s = applyKey(s, { kind: 'undo' });
    const undone = textOf(s);
    s = applyKey(s, { kind: 'redo' });
    assert.equal(textOf(s), 'abc');
    s = applyKey(s, { kind: 'undo' });
    assert.equal(textOf(s), undone);
    s = type(s, 'Z');
    assert.equal(s.redo.length, 0, 'a new edit must invalidate the redo stack');
  });

  test('a kill and a yank are undoable, and moving the cursor is not', () => {
    let s = type(newEditorState(), 'alpha beta');
    const before = textOf(s);
    const depth = s.undo.length;
    s = applyKey(s, { kind: 'home' });
    s = applyKey(s, { kind: 'end' });
    assert.equal(s.undo.length, depth, 'cursor movement should not be on the undo stack');
    s = applyKey(s, { kind: 'kill-word' });
    assert.notEqual(textOf(s), before);
    s = applyKey(s, { kind: 'undo' });
    assert.equal(textOf(s), before);
  });

  test('the undo stack is bounded, so a long session cannot grow without limit', () => {
    let s = newEditorState();
    for (let i = 0; i < MAX_UNDO + 50; i += 1) s = type(s, 'x');
    assert.equal(s.undo.length, MAX_UNDO);
  });

  test('Ctrl-R searches history, newest first and case-insensitively', () => {
    const history = ['fix the WIDTH bug', 'run the tests', 'fix the frame'];
    let s = applyKey(newEditorState(history), { kind: 'search' });
    assert.notEqual(s.search, undefined, 'search did not open');
    s = type(s, 'fix');
    // Newest first: 'fix the frame' before 'fix the WIDTH bug'.
    assert.equal(history[s.search?.matches[0] ?? -1], 'fix the frame');
    s = applyKey(s, { kind: 'search' });
    assert.equal(s.search?.at, 1, 'Ctrl-R again should step to the next older match');
    s = applyKey(s, { kind: 'enter' });
    assert.equal(textOf(s), 'fix the WIDTH bug');
    assert.equal(s.search, undefined, 'search must close when a match is taken');
  });

  test('case does not matter, and backspace widens the search again', () => {
    const history = ['fix the WIDTH bug'];
    let s = applyKey(newEditorState(history), { kind: 'search' });
    s = type(s, 'width');
    assert.equal(s.search?.matches.length, 1, 'lower-case query should match upper-case history');
    s = type(s, 'zzz');
    assert.equal(s.search?.matches.length, 0);
    s = applyKey(s, { kind: 'backspace' });
    s = applyKey(s, { kind: 'backspace' });
    s = applyKey(s, { kind: 'backspace' });
    assert.equal(s.search?.matches.length, 1, 'backspace should widen it back');
  });

  test('Escape leaves the search without changing the buffer', () => {
    let s = type(newEditorState(['something else']), 'half typed');
    s = applyKey(s, { kind: 'search' });
    s = type(s, 'some');
    s = applyKey(s, { kind: 'escape' });
    assert.equal(s.search, undefined);
    assert.equal(textOf(s), 'half typed', 'the buffer must survive an abandoned search');
  });

  test('the search prompt is one row, and says what it is searching for', () => {
    let s = applyKey(newEditorState(['fix the width bug']), { kind: 'search' });
    s = type(s, 'wid');
    assert.equal(renderedRows(s, render), 1, 'the redraw would clear the wrong number of rows');
    const out = renderEditor(s, render, 1);
    assert.match(out, /reverse-i-search\)'wid'/);
    // Cut to the terminal, like every other row: 40 columns less the label leaves 14,
    // so the match shows as a prefix rather than whole. One row is the invariant.
    assert.match(out, /fix the widt/);
    assert.ok(visibleWidth(out.replace(/\r/g, '')) <= 40 + 8, 'the search row ran past the terminal');
  });
});

describe('@ completion reaches the editor through the same key as /', () => {
  test('Tab inserts the candidate over the @ token, not over the whole line', () => {
    const s = applyKey(
      type(newEditorState(), 'explain @src/cl'),
      { kind: 'tab' },
      {
        complete: () => ['@src/cli/app.ts'],
      },
    );
    assert.equal(textOf(s), 'explain @src/cli/app.ts');
  });

  test('several candidates open the same menu the commands use', () => {
    let s = applyKey(
      type(newEditorState(), 'read @src/'),
      { kind: 'tab' },
      {
        complete: () => ['@src/cli/app.ts', '@src/cli/editor.ts'],
      },
    );
    assert.equal(s.menu.length, 2);
    s = applyKey(s, { kind: 'down' });
    s = applyKey(s, { kind: 'enter' });
    assert.equal(textOf(s), 'read @src/cli/editor.ts');
  });
});

describe('Ctrl-C and Ctrl-D are not the same answer', () => {
  // Found by a real terminal session, not by a unit test: Ctrl-C exited the program
  // instead of abandoning the line, in a session whose banner says "Ctrl-C cancels a
  // turn, Ctrl-D exits". Both produced `null`, so the caller could not tell them apart.
  test('Ctrl-C abandons the line', () => {
    const s = applyKey(type(newEditorState(), 'half a thought'), { kind: 'cancel' });
    assert.deepEqual(s.done, { kind: 'cancel' });
  });

  test('Ctrl-D on an empty buffer ends the session, and on a full one does nothing', () => {
    assert.deepEqual(applyKey(newEditorState(), { kind: 'eof' }).done, { kind: 'eof' });
    assert.equal(applyKey(type(newEditorState(), 'x'), { kind: 'eof' }).done, undefined);
  });

  test('a cancelled line is not remembered in history', async () => {
    const listeners: Array<(c: Buffer | string) => void> = [];
    const input = {
      on: (_e: 'data', l: (c: Buffer | string) => void) => void listeners.push(l),
      off: (_e: 'data', l: (c: Buffer | string) => void) => {
        const at = listeners.indexOf(l);
        if (at >= 0) listeners.splice(at, 1);
      },
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    };
    const editor = new Editor({
      input,
      write: () => {},
      palette: plain,
      glyphs: g,
      columns: () => 40,
      prompt: () => '> ',
      continuation: '  ',
    });

    const first = editor.read();
    listeners.forEach((l) => l(Buffer.from('abandoned')));
    listeners.forEach((l) => l(Buffer.from(String.fromCharCode(3))));
    assert.deepEqual(await first, { kind: 'cancel' });

    // The next read's history must not offer what was thrown away.
    const second = editor.read();
    listeners.forEach((l) => l(Buffer.from(`${ESC}[A`)));
    listeners.forEach((l) => l(Buffer.from('\r')));
    const outcome = await second;
    assert.deepEqual(outcome, { kind: 'line', text: '' }, 'an abandoned line came back from history');
  });

  test('Ctrl-C inside a search leaves the search, not the line', () => {
    let s = type(newEditorState(['older']), 'being typed');
    s = applyKey(s, { kind: 'search' });
    s = applyKey(s, { kind: 'cancel' });
    assert.equal(s.done, undefined, 'the line was abandoned from inside a search');
    assert.equal(s.search, undefined);
    assert.equal(textOf(s), 'being typed');
  });
});

describe('the block never grows taller than the window', () => {
  // The redraw moves up by the rows it drew, and a row that scrolled off the top
  // cannot be moved back to. So nothing draws more rows than the window holds: the
  // buffer gets a viewport that follows the cursor, the menu gets what is left.

  const short = { ...render, rows: 10 };

  function withMenu(items: number): EditorState {
    return applyKey(
      type(newEditorState(), '@src/'),
      { kind: 'tab' },
      {
        complete: () => Array.from({ length: items }, (_, i) => `@src/file${i}.ts`),
      },
    );
  }

  test('nothing ever claims more rows than the window has', () => {
    const cases: EditorState[] = [
      withMenu(30),
      type(newEditorState(), 'x'.repeat(4000)),
      applyKey(
        type(newEditorState(), 'x'.repeat(4000)),
        { kind: 'tab' },
        {
          complete: () => Array.from({ length: 30 }, (_, i) => `@f${i}`),
        },
      ),
    ];
    for (const state of cases) {
      const rows = renderedRows(state, short);
      assert.ok(rows <= 9, `claimed ${rows} rows in a 10-row terminal`);
      assert.equal(viewport(state, short).total, rows, 'the render and the count disagree');
    }
  });

  test('a buffer taller than the window is scrolled, not truncated at the top', () => {
    // The old limit, and the reason this exists: a long paste used to draw every row
    // and then move up over rows that had scrolled away.
    const state = type(newEditorState(), 'x'.repeat(4000));
    const view = viewport(state, short);
    assert.ok(view.bufferRows.length < layout(state, short).rows.length, 'nothing was scrolled');
    assert.ok(view.cursorRow >= 0 && view.cursorRow < view.bufferRows.length, 'the cursor scrolled away');
  });

  test('the viewport follows the cursor rather than the top of the buffer', () => {
    let state = type(newEditorState(), 'line one');
    for (let i = 0; i < 30; i += 1) {
      state = applyKey(state, { kind: 'newline' });
      state = type(state, `line ${i}`);
    }
    const atEnd = viewport(state, short);
    assert.ok(
      atEnd.bufferRows.some((r) => r.includes('line 29')),
      'the end was not in view',
    );

    for (let i = 0; i < 40; i += 1) state = applyKey(state, { kind: 'up' });
    const atStart = viewport(state, short);
    assert.ok(
      atStart.bufferRows.some((r) => r.includes('line one')),
      'moving up did not scroll back',
    );
  });

  test('a short buffer keeps all it needs and the menu grows into the rest', () => {
    const state = withMenu(30);
    const view = viewport(state, short);
    assert.equal(view.bufferRows.length, layout(state, short).rows.length, 'the buffer was trimmed');
    assert.equal(view.total, 9, 'the menu did not take the leftover');
    assert.equal(view.menuItems[view.menuSelected], state.menu[state.menuAt], 'wrong item highlighted');
  });

  test('against a tall buffer the menu is held to half, so typing stays visible', () => {
    // The policy, and the reason for it: a menu that pushed the buffer off screen
    // would hide what is being typed in order to show suggestions about it.
    let state = type(newEditorState(), 'x'.repeat(4000));
    state = applyKey(
      state,
      { kind: 'tab' },
      {
        complete: () => Array.from({ length: 30 }, (_, i) => `@f${i}`),
      },
    );
    const view = viewport(state, short);
    assert.ok(view.menuItems.length <= Math.floor(9 / 2), `menu took ${view.menuItems.length} of 9`);
    assert.ok(view.bufferRows.length >= 5, 'the buffer was squeezed out');
  });

  test('the selection stays visible as it moves past the bottom of the window', () => {
    let state = withMenu(30);
    for (let i = 0; i < 20; i += 1) state = applyKey(state, { kind: 'down' });
    const view = viewport(state, short);
    assert.ok(view.menuSelected >= 0 && view.menuSelected < view.menuItems.length);
    assert.equal(view.menuItems[view.menuSelected], state.menu[state.menuAt]);
  });

  test('with no height given nothing is windowed — a test has no terminal', () => {
    const state = withMenu(30);
    assert.equal(viewport(state, render).menuItems.length, 30);
  });

  test('a wide character is never cut in half by the wrap', () => {
    // Splitting by characters puts half a two-column glyph at the end of a row, and
    // the terminal draws a replacement box for it.
    const state = { ...newEditorState(), lines: ['修'.repeat(40)] };
    for (const row of layout(state, render).rows) {
      assert.ok(visibleWidth(row) <= 40, `a row is ${visibleWidth(row)} columns wide`);
    }
    assert.equal(layout(state, render).rows.join('').replace('> ', ''), '修'.repeat(40));
  });
});

describe('a paste split across reads is still one paste', () => {
  // Every paste worth making is larger than a terminal read. The markers arrive in
  // one chunk and the body in the next several, so "am I inside a paste" has to
  // survive between calls — otherwise the newlines in chunks two onward are parsed as
  // Enter and the paste submits itself, line by line. Found by pasting 40 lines into
  // a real terminal; no single-chunk test can see it.

  test('the body of a chunked paste is text, not keystrokes', () => {
    const paste = newPasteState();
    const first = parseInput(`${ESC}[200~line one\nline two\n`, undefined, paste);
    assert.deepEqual(first, [{ kind: 'text', text: 'line one\nline two\n' }]);
    assert.equal(paste.inside, true, 'the parser forgot it was inside a paste');

    const second = parseInput('line three\nline four\n', undefined, paste);
    assert.deepEqual(second, [{ kind: 'text', text: 'line three\nline four\n' }]);
    assert.equal(
      second.some((k) => k.kind === 'enter'),
      false,
      'a newline inside a paste became Enter',
    );

    const last = parseInput(`line five${ESC}[201~`, undefined, paste);
    assert.deepEqual(last, [{ kind: 'text', text: 'line five' }]);
    assert.equal(paste.inside, false, 'the paste never closed');
  });

  test('typing after a chunked paste is typing again', () => {
    const paste = newPasteState();
    parseInput(`${ESC}[200~pasted`, undefined, paste);
    const after = parseInput(`${ESC}[201~\r`, undefined, paste);
    assert.deepEqual(after, [{ kind: 'enter' }], 'Enter after the paste did not submit');
  });

  test('the whole thing lands in the buffer, unsubmitted', () => {
    const paste = newPasteState();
    let state = newEditorState();
    for (const chunk of [`${ESC}[200~one\n`, 'two\n', `three${ESC}[201~`]) {
      for (const key of parseInput(chunk, undefined, paste)) state = applyKey(state, key);
    }
    assert.equal(textOf(state), 'one\ntwo\nthree');
    assert.equal(state.done, undefined, 'the paste submitted itself');
  });

  test('without a state object each call starts fresh, which is the old behaviour', () => {
    // Kept explicit: a caller that forgets to thread the state gets per-chunk parsing,
    // and this test says so rather than leaving it as a surprise.
    const keys = parseInput('line one\nline two');
    assert.ok(keys.some((k) => k.kind === 'enter'));
  });
});

describe('Shift-Tab is the host’s key, and the ordering is the whole of it', () => {
  function fakeInput() {
    const listeners: Array<(c: Buffer | string) => void> = [];
    return {
      on: (_e: 'data', l: (c: Buffer | string) => void) => void listeners.push(l),
      off: (_e: 'data', l: (c: Buffer | string) => void) => {
        const at = listeners.indexOf(l);
        if (at >= 0) listeners.splice(at, 1);
      },
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
      send: (s: string) => listeners.forEach((l) => l(Buffer.from(s))),
    };
  }

  /**
   * The defect this exists for, found through a real pty.
   *
   * The host used to fire an async command and write its message from the
   * `.then()`. That lands *after* the editor has redrawn, so the message printed
   * into the middle of the prompt block and the next redraw moved up one line
   * against five lines of leftover text. The contract is now synchronous: the
   * host returns text, the editor takes its block down, writes the text, and
   * redraws from a clean slate.
   */
  test('the notice is written before the prompt is redrawn, not after', async () => {
    const input = fakeInput();
    const written: string[] = [];
    let mode = 'manual';

    const editor = new Editor({
      input,
      write: (s) => written.push(s),
      palette: plain,
      glyphs: g,
      columns: () => 40,
      prompt: () => `[${mode}] > `,
      continuation: '  ',
      onCycleMode: () => {
        mode = 'auto';
        return 'MODE-NOTICE';
      },
    });

    const line = editor.read();
    input.send('half typed');
    input.send(`${ESC}[Z`);
    input.send('\r');
    const outcome = await line;

    // The buffer survived the keystroke untouched — cursor included, since the
    // line submitted as typed.
    assert.deepEqual(outcome, { kind: 'line', text: 'half typed' });

    const all = written.join('');
    const notice = all.indexOf('MODE-NOTICE');
    assert.ok(notice >= 0, 'the notice was never written');

    // The new prompt appears *after* the notice. Reversed, that is the pty defect.
    const promptAfter = all.indexOf('[auto] > ', notice);
    assert.ok(promptAfter > notice, 'the prompt was redrawn before the notice was written');

    // And the stale prompt is not redrawn after the notice.
    assert.equal(all.indexOf('[manual] > ', notice), -1, 'the old mode was drawn after the change');
  });

  test('a host that returns nothing gets a redraw and no stray output', async () => {
    const input = fakeInput();
    const written: string[] = [];
    let called = 0;

    const editor = new Editor({
      input,
      write: (s) => written.push(s),
      palette: plain,
      glyphs: g,
      columns: () => 40,
      prompt: () => '> ',
      continuation: '  ',
      onCycleMode: () => {
        called += 1;
        return undefined;
      },
    });

    const line = editor.read();
    input.send(`${ESC}[Z`);
    input.send('ok\r');
    assert.deepEqual(await line, { kind: 'line', text: 'ok' });
    assert.equal(called, 1, 'the host was not consulted');
  });
});
