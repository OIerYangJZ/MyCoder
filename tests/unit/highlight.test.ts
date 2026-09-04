/**
 * Colour inside a fenced code block (`src/cli/highlight.ts`).
 *
 * The first test in this file is the one that matters. Highlighting is presentation
 * and nothing else, so stripping the escape codes from a highlighted line must
 * return the input byte for byte. A highlighter that drops a character, or emits one
 * twice, has silently altered what the model said — inside a program whose whole
 * output surface rests on the claim that the renderer changes nothing.
 *
 * Everything below it is about colours being plausible, which matters much less.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { highlightLine, languageNames, isKnownLanguage, newBlockState } from '../../src/cli/highlight.ts';
import { palette, visibleWidth } from '../../src/cli/render.ts';

const fancy = palette(true);
const plain = palette(false);

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

/**
 * Deliberately awkward. Each of these has broken a hand-written lexer somewhere:
 * an unterminated string runs to the end of the line, a lone delimiter is not a
 * string at all, and a line that already contains an escape code must not be
 * double-counted.
 */
const FIXTURES: readonly string[] = [
  '',
  '   ',
  'const x = 1;',
  'const s = "hello";',
  "const s = 'hello';",
  'const s = "unterminated',
  'const s = "with \\" an escape";',
  '"',
  '// a comment',
  '# a comment',
  'code(); // trailing comment',
  '/* block */ code();',
  '/* opens and does not close',
  'x = 0xff + 3.14e-2;',
  'def f(a, b): return a + b',
  'fn main() -> Result<(), Box<dyn Error>> {}',
  '  - a list item that is not code',
  '中文 identifiers and 字符串 "中文"',
  'emoji 🙂 in code',
  '\t\tindented(with, tabs)',
];

// Deliberately not a fixture here: a line that already contains an escape sequence.
// The model can emit one, and this lexer would slice it apart — but the answer is not
// to make the lexer escape-aware. Model text carrying terminal control codes must not
// reach the terminal at all, and that is stripped one layer up, before any of this
// runs. `tests/unit/markdown.test.ts` is where it is asserted.

describe('highlighting never changes the text', () => {
  test('every language, every fixture, round-trips exactly', () => {
    for (const lang of languageNames()) {
      for (const fixture of FIXTURES) {
        const out = highlightLine(fixture, lang, fancy, newBlockState());
        assert.equal(
          strip(out),
          fixture,
          `${lang} altered ${JSON.stringify(fixture)} → ${JSON.stringify(strip(out))}`,
        );
      }
    }
  });

  test('and the visible width is unchanged, which is what the frame depends on', () => {
    for (const lang of languageNames()) {
      for (const fixture of FIXTURES) {
        const out = highlightLine(fixture, lang, fancy, newBlockState());
        assert.equal(visibleWidth(out), visibleWidth(fixture), `${lang}: ${JSON.stringify(fixture)}`);
      }
    }
  });

  test('an unknown language is returned untouched rather than guessed at', () => {
    // A fence naming something we do not know is common. Plain is right; guessing
    // with another language's keywords is worse than no colour.
    assert.equal(isKnownLanguage('brainfuck'), false);
    const line = 'const x = 1; // looks like typescript';
    assert.equal(highlightLine(line, 'brainfuck', fancy, newBlockState()), line);
    assert.equal(highlightLine(line, '', fancy, newBlockState()), line);
  });

  test('a plain palette produces no escape codes at all', () => {
    for (const lang of languageNames()) {
      const out = highlightLine('const s = "x"; // c', lang, plain, newBlockState());
      assert.equal(out.includes(''), false, `${lang} styled a plain palette`);
    }
  });
});

describe('what gets coloured', () => {
  test('keywords, strings, comments and numbers are distinguishable', () => {
    const out = highlightLine('const s = "hi"; // note', 'ts', fancy, newBlockState());
    assert.match(out, /\[34mconst\[0m/, 'keyword');
    assert.match(out, /\[32m"hi"\[0m/, 'string');
    assert.match(out, /\[2m\/\/ note\[0m/, 'comment');
    assert.match(highlightLine('x = 42', 'ts', fancy, newBlockState()), /\[33m42\[0m/);
  });

  test('a comment marker inside a string is not a comment', () => {
    const out = highlightLine('const url = "http://example.com";', 'ts', fancy, newBlockState());
    assert.equal(/\[2m/.test(out), false, `the URL was read as a comment: ${JSON.stringify(out)}`);
  });

  test('a keyword inside a string is not a keyword', () => {
    const out = highlightLine('const s = "const";', 'ts', fancy, newBlockState());
    // One `const` styled as a keyword, the other inside the green string.
    assert.equal((out.match(/\[34mconst\[0m/g) ?? []).length, 1);
  });

  test('a word that merely contains a keyword is not one', () => {
    const out = highlightLine('constant = iffy', 'ts', fancy, newBlockState());
    assert.equal(/\[34m/.test(out), false, `sub-word match: ${JSON.stringify(out)}`);
  });

  test('TOML is highlighted, which clio has no entry for and this repo is configured in', () => {
    const out = highlightLine('model = "deepseek" # the alias', 'toml', fancy, newBlockState());
    assert.match(out, /\[32m"deepseek"\[0m/);
    assert.match(out, /\[2m# the alias\[0m/);
  });

  test('a diff colours by line prefix, and never as code', () => {
    const s = newBlockState();
    assert.match(highlightLine('+added', 'diff', fancy, s), /\[32m\+added\[0m/);
    assert.match(highlightLine('-removed', 'diff', fancy, s), /\[31m-removed\[0m/);
    assert.match(highlightLine('@@ -1 +1 @@', 'diff', fancy, s), /\[36m/);
    assert.equal(highlightLine(' context', 'diff', fancy, s), ' context');
  });
});

describe('constructs that span lines', () => {
  test('a block comment stays a comment on the lines after it opens', () => {
    // clio highlights strictly per line, so the second line of a `/* … */` renders
    // as code. The stream already carries the fence state across deltas; carrying
    // one more field costs nothing.
    const state = newBlockState();
    const first = highlightLine('/* the comment opens', 'ts', fancy, state);
    assert.match(first, /\[2m/);
    assert.equal(state.inBlockComment, true);

    const middle = highlightLine('const notCode = 1;', 'ts', fancy, state);
    assert.equal(/\[34m/.test(middle), false, 'a keyword was coloured inside a comment');
    assert.match(middle, /\[2mconst notCode = 1;\[0m/);

    const last = highlightLine('closes here */ const real = 1;', 'ts', fancy, state);
    assert.equal(state.inBlockComment, false);
    assert.match(last, /\[34mconst\[0m/, 'code after the closer is code again');
  });

  test('a language with no block comment never enters that state', () => {
    const state = newBlockState();
    highlightLine('# /* not a block comment opener in bash */', 'bash', fancy, state);
    assert.equal(state.inBlockComment, false);
  });

  test('state is per-stream, so a fresh one starts clean', () => {
    const a = newBlockState();
    highlightLine('/* open', 'ts', fancy, a);
    assert.equal(a.inBlockComment, true);
    assert.equal(newBlockState().inBlockComment, false);
  });
});
