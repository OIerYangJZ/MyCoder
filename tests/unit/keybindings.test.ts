/**
 * Remapped keys (`src/cli/keybindings.ts`).
 *
 * The property worth stating: a keybindings file is a **remapping and never a
 * capability**. The value has to name an action the editor already has, so no file
 * can make the editor do something it could not do before — and a value that names
 * nothing is reported rather than silently dropped, because the silent version is a
 * binding somebody swears they wrote and cannot find.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { controlByteFor, parseKeybindings, loadKeybindings } from '../../src/cli/keybindings.ts';
import { parseInput } from '../../src/cli/editor.ts';

describe('which keys can be bound', () => {
  test('the control range, by name', () => {
    assert.equal(controlByteFor('ctrl+a'), 1);
    assert.equal(controlByteFor('ctrl+r'), 18);
    assert.equal(controlByteFor('CTRL+Z'), 26, 'case should not matter');
    assert.equal(controlByteFor(' ctrl+p '), 16, 'nor should stray space');
  });

  test('a printable key cannot be bound, because that would make it untypeable', () => {
    assert.equal(controlByteFor('k'), undefined);
    assert.equal(controlByteFor('shift+tab'), undefined);
    assert.equal(controlByteFor('alt+x'), undefined);
    assert.equal(controlByteFor(''), undefined);
  });
});

describe('reading the file', () => {
  test('a good file maps bytes to actions', () => {
    const { overrides, warnings } = parseKeybindings('{"ctrl+p":"up","ctrl+n":"down"}', 'k.json');
    assert.deepEqual(warnings, []);
    assert.deepEqual(overrides.get(16), { kind: 'up' });
    assert.deepEqual(overrides.get(14), { kind: 'down' });
  });

  test('an action the editor does not have is refused by name', () => {
    const { overrides, warnings } = parseKeybindings('{"ctrl+p":"fly"}', 'k.json');
    assert.equal(overrides.size, 0);
    assert.match(warnings[0] ?? '', /"fly" is not an action/);
  });

  test('an unbindable key is refused by name', () => {
    const { warnings } = parseKeybindings('{"f5":"up"}', 'k.json');
    assert.match(warnings[0] ?? '', /"f5" is not a bindable key/);
  });

  test('broken JSON is a warning, not a failed startup', () => {
    const { overrides, warnings } = parseKeybindings('{not json', 'k.json');
    assert.equal(overrides.size, 0);
    assert.match(warnings[0] ?? '', /not valid JSON/);
  });

  test('the wrong shape is a warning too', () => {
    assert.match(parseKeybindings('[]', 'k.json').warnings[0] ?? '', /should be an object/);
    assert.match(parseKeybindings('"nope"', 'k.json').warnings[0] ?? '', /should be an object/);
  });

  test('one bad entry does not throw the good ones away', () => {
    const { overrides, warnings } = parseKeybindings('{"ctrl+p":"up","ctrl+q":"fly"}', 'k.json');
    assert.deepEqual(overrides.get(16), { kind: 'up' });
    assert.equal(warnings.length, 1);
  });

  test('a missing file says nothing at all, because that is the normal case', async () => {
    const loaded = await loadKeybindings('/nonexistent/config/dir');
    assert.equal(loaded.overrides.size, 0);
    assert.deepEqual(loaded.warnings, []);
  });
});

describe('the editor honours them', () => {
  test('an override replaces the default for that byte', () => {
    const { overrides } = parseKeybindings('{"ctrl+p":"up","ctrl+n":"down"}', 'k.json');
    assert.deepEqual(parseInput(String.fromCharCode(16), overrides), [{ kind: 'up' }]);
    assert.deepEqual(parseInput(String.fromCharCode(14), overrides), [{ kind: 'down' }]);
  });

  test('a byte with no override keeps its default', () => {
    const { overrides } = parseKeybindings('{"ctrl+p":"up"}', 'k.json');
    assert.deepEqual(parseInput(String.fromCharCode(3), overrides), [{ kind: 'cancel' }]);
  });

  test('a default can be remapped over, including a dangerous one', () => {
    // Somebody who wants Ctrl-C to mean something else may have it: the editor's
    // meaning of a key is the user's business, and Ctrl-D still ends input.
    const { overrides } = parseKeybindings('{"ctrl+c":"clear"}', 'k.json');
    assert.deepEqual(parseInput(String.fromCharCode(3), overrides), [{ kind: 'clear' }]);
  });
});
