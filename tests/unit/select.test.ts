/**
 * The arrow-key menu (`src/cli/select.ts`).
 *
 * Split into a pure half and a stream half precisely so the pure half can be tested
 * like this. The one property worth stating aloud: a menu redraw moves the cursor up
 * by the number of items, so the menu must occupy exactly that many rows — a label
 * long enough to wrap would make the count a lie and the redraw would eat a row of
 * whatever was above it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { parseKeys, renderMenu, redrawMenu, select, type KeySource } from '../../src/cli/select.ts';
import { glyphs, palette, visibleWidth } from '../../src/cli/render.ts';

const fancy = palette(true);
const plain = palette(false);
const g = glyphs(true);
const ESC = String.fromCharCode(27);

const ITEMS = ['Yes', "Yes, and don't ask again", 'No'];

describe('what a keypress means', () => {
  test('the arrows, Enter, Escape and Ctrl-C', () => {
    assert.deepEqual(parseKeys(`${ESC}[A`), ['up']);
    assert.deepEqual(parseKeys(`${ESC}[B`), ['down']);
    assert.deepEqual(parseKeys('\r'), ['confirm']);
    assert.deepEqual(parseKeys('\n'), ['confirm']);
    assert.deepEqual(parseKeys(ESC), ['cancel']);
    assert.deepEqual(parseKeys(String.fromCharCode(3)), ['cancel']);
  });

  test('k and j, because somebody will try them', () => {
    assert.deepEqual(parseKeys('k'), ['up']);
    assert.deepEqual(parseKeys('j'), ['down']);
  });

  test('a chunk can hold more than one keypress', () => {
    // A held arrow key arrives as one chunk, and dropping all but the first would
    // make the menu feel stuck.
    assert.deepEqual(parseKeys(`${ESC}[B${ESC}[B\r`), ['down', 'down', 'confirm']);
  });

  test('anything it does not recognise means nothing, not something', () => {
    assert.deepEqual(parseKeys('hello'), []);
    assert.deepEqual(parseKeys('  '), []);
    // An unknown escape sequence leaves rather than guessing which item was meant.
    assert.deepEqual(parseKeys(`${ESC}[5~`), ['cancel']);
  });
});

describe('the menu, as rows', () => {
  test('one row per item, whatever the labels are', () => {
    assert.equal(renderMenu(ITEMS, 0, fancy, g).split('\n').length, ITEMS.length);
    const long = ['x'.repeat(500), 'y'.repeat(500)];
    assert.equal(renderMenu(long, 0, fancy, g, 40).split('\n').length, 2);
  });

  test('no row is wider than the terminal, so none of them wraps', () => {
    // The redraw moves up by the item count. A wrapped row makes that count wrong
    // and the next redraw clears a line of something else.
    const long = ['a very long label that will not fit in a narrow terminal at all', '短'.repeat(60)];
    for (const cols of [20, 40, 80]) {
      for (const line of renderMenu(long, 0, fancy, g, cols).split('\n')) {
        assert.ok(visibleWidth(line) <= cols, `${visibleWidth(line)} columns in a ${cols}-column terminal`);
      }
    }
  });

  test('the selected row is marked and blue, and the others are not', () => {
    const rendered = renderMenu(ITEMS, 1, fancy, g).split('\n');
    assert.match(rendered[1] ?? '', /\[1;34m/, 'the selection is not blue');
    assert.match(rendered[1] ?? '', /❯/);
    assert.equal(/\[1;34m/.test(rendered[0] ?? ''), false, 'an unselected row was styled');
    assert.equal((rendered[0] ?? '').includes('❯'), false);
  });

  test('a plain palette still marks the selection, because colour is not the only reader', () => {
    const rendered = renderMenu(ITEMS, 2, plain, glyphs(false)).split('\n');
    assert.equal(rendered[2]?.includes('>'), true);
    assert.equal(rendered[0]?.includes('>'), false);
    assert.equal(rendered.join('').includes(ESC), false);
  });

  test('a redraw goes up by exactly the number of rows and clears each one', () => {
    const out = redrawMenu(ITEMS, 0, plain, g);
    assert.match(out, new RegExp(`^${ESC}\\[${ITEMS.length}A`), 'wrong number of rows moved');
    assert.equal((out.match(/\[2K/g) ?? []).length, ITEMS.length, 'every row must be cleared');
    assert.equal(/\[\d+;\d+H/.test(out), false, 'no absolute positioning');
  });
});

/** A stdin stand-in: an emitter with the three methods `select` calls. */
function fakeInput(): KeySource & { send: (s: string) => void; raw: boolean[] } {
  const bus = new EventEmitter();
  const raw: boolean[] = [];
  return {
    on: (e, l) => void bus.on(e, l),
    off: (e, l) => void bus.off(e, l),
    setRawMode: (mode: boolean) => void raw.push(mode),
    resume: () => {},
    pause: () => {},
    send: (s: string) => bus.emit('data', Buffer.from(s)),
    raw,
  };
}

describe('driving it', () => {
  test('Enter takes the initial selection, which is where the caller put it', async () => {
    const input = fakeInput();
    const chosen = select({
      items: ITEMS,
      initial: 2,
      write: () => {},
      palette: plain,
      glyphs: g,
      input,
    });
    input.send('\r');
    assert.equal(await chosen, 2);
  });

  test('the arrows move, and wrap around', async () => {
    const input = fakeInput();
    const chosen = select({ items: ITEMS, initial: 0, write: () => {}, palette: plain, glyphs: g, input });
    input.send(`${ESC}[A`); // up from the first wraps to the last
    input.send('\r');
    assert.equal(await chosen, ITEMS.length - 1);
  });

  test('Escape and Ctrl-C choose nothing at all', async () => {
    for (const key of [ESC, String.fromCharCode(3)]) {
      const input = fakeInput();
      const chosen = select({ items: ITEMS, initial: 0, write: () => {}, palette: plain, glyphs: g, input });
      input.send(key);
      assert.equal(await chosen, undefined, `${JSON.stringify(key)} should abandon the menu`);
    }
  });

  test('raw mode is turned on and, whatever happens, turned off again', async () => {
    const input = fakeInput();
    const chosen = select({ items: ITEMS, initial: 0, write: () => {}, palette: plain, glyphs: g, input });
    input.send(ESC);
    await chosen;
    assert.deepEqual(input.raw, [true, false], 'the terminal was left in raw mode');
  });

  test('keys arriving after the answer do nothing', async () => {
    const input = fakeInput();
    const writes: string[] = [];
    const chosen = select({
      items: ITEMS,
      initial: 0,
      write: (s) => writes.push(s),
      palette: plain,
      glyphs: g,
      input,
    });
    input.send('\r');
    await chosen;
    const after = writes.length;
    input.send(`${ESC}[B`);
    assert.equal(writes.length, after, 'the listener outlived the menu');
  });
});
