/**
 * `@path` completion and resolution (`src/cli/completions.ts`).
 *
 * The completion half is a convenience. The resolution half reads files and puts
 * their contents in front of the model, which makes it the half with teeth — and the
 * reason the first describe block below is about escaping the workspace rather than
 * about matching prefixes.
 *
 * `reference/clio` resolves `@path` with a bare `fs.readFile` inside its input
 * module, so `@../../.ssh/id_rsa` is read and pasted into the conversation whatever
 * the policy says. Nothing in that path consults one.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  FileIndex,
  findReferences,
  insideWorkspace,
  mutationChangesPaths,
  resolveReferences,
} from '../../src/cli/completions.ts';

let base = '';
let root = '';

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'mycoder-completions-'));
  root = path.join(base, 'workspace');
  await mkdir(path.join(root, 'src', 'cli'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'junk'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'src', 'cli', 'app.ts'), 'export const app = 1;\n');
  await writeFile(path.join(root, 'src', 'cli', 'editor.ts'), 'export const editor = 2;\n');
  await writeFile(path.join(root, 'README.md'), '# readme\n');
  await writeFile(path.join(root, 'node_modules', 'junk', 'index.js'), 'nope\n');
  await writeFile(path.join(root, '.git', 'HEAD'), 'nope\n');
  // The thing a reference must never reach.
  await writeFile(path.join(base, 'secret.txt'), 'SHOULD-NOT-BE-READ\n');
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('a reference may not leave the workspace', () => {
  test('the check is on the resolved path, not on the text', () => {
    // `a/../../b` has no leading `..` for a naive scan to object to, and resolves
    // outside anyway.
    assert.equal(insideWorkspace(root, 'src/cli/app.ts'), true);
    assert.equal(insideWorkspace(root, './README.md'), true);
    assert.equal(insideWorkspace(root, '../secret.txt'), false);
    assert.equal(insideWorkspace(root, 'src/../../secret.txt'), false);
    assert.equal(insideWorkspace(root, '/etc/passwd'), false);
  });

  test('an escaping reference is left as literal text and says why', async () => {
    const result = await resolveReferences('look at @../secret.txt please', root);
    assert.equal(result.text, 'look at @../secret.txt please', 'the message was rewritten');
    assert.equal(result.text.includes('SHOULD-NOT-BE-READ'), false, 'the file was read');
    assert.deepEqual(result.attached, []);
    assert.equal(result.skipped[0]?.reason, 'outside the workspace');
  });

  test('an absolute path is not a workspace reference either', async () => {
    const result = await resolveReferences(`read @${path.join(base, 'secret.txt')}`, root);
    assert.equal(result.text.includes('SHOULD-NOT-BE-READ'), false);
    assert.deepEqual(result.attached, []);
  });
});

describe('resolution', () => {
  test('a real file is attached after the message, not substituted into it', async () => {
    const result = await resolveReferences('explain @src/cli/app.ts', root);
    assert.match(result.text, /^explain @src\/cli\/app\.ts/, 'what was typed must stay legible');
    assert.match(result.text, /Contents of src\/cli\/app\.ts/);
    assert.match(result.text, /export const app = 1;/);
    assert.deepEqual([...result.attached], ['src/cli/app.ts']);
  });

  test('two references are both attached, and a repeat is attached once', async () => {
    const result = await resolveReferences('@README.md and @src/cli/app.ts and @README.md', root);
    assert.deepEqual([...result.attached], ['README.md', 'src/cli/app.ts']);
    assert.equal((result.text.match(/Contents of README\.md/g) ?? []).length, 1);
  });

  test('a missing file leaves the text alone — an @ in prose is common', async () => {
    const result = await resolveReferences('email me @nowhere/at/all', root);
    assert.equal(result.attached.length, 0);
    assert.equal(result.skipped[0]?.reason, 'not found');
    assert.equal(result.text, 'email me @nowhere/at/all');
  });

  test('a message with no references is returned untouched, object and all', async () => {
    const result = await resolveReferences('nothing to see', root);
    assert.equal(result.text, 'nothing to see');
    assert.deepEqual(result.attached, []);
    assert.deepEqual(result.skipped, []);
  });

  test('what counts as a reference', () => {
    assert.deepEqual(
      findReferences('@a/b.ts and @c').map((r) => r.relative),
      ['a/b.ts', 'c'],
    );
    // A bare `@` is not a reference, so `@` in prose survives.
    assert.deepEqual(findReferences('reach me @ home'), []);
  });
});

describe('completion', () => {
  test('prefix matches come before substring matches', async () => {
    const index = new FileIndex({ root });
    const found = await index.complete('src/cli/e');
    assert.equal(found[0], '@src/cli/editor.ts');
  });

  test('the noisy directories are never offered', async () => {
    const index = new FileIndex({ root });
    const all = await index.paths();
    assert.equal(
      all.some((p) => p.includes('node_modules') || p.startsWith('.git')),
      false,
      `walked into something it should not: ${all.filter((p) => p.includes('node_modules')).join(', ')}`,
    );
  });

  test('candidates come back as the token that replaces what was typed', async () => {
    const index = new FileIndex({ root });
    const found = await index.complete('README');
    assert.deepEqual(found, ['@README.md'], 'the @ has to be part of the replacement');
  });

  test('an empty partial offers everything, bounded', async () => {
    const index = new FileIndex({ root });
    const found = await index.complete('', 2);
    assert.equal(found.length, 2);
  });
});

describe('when the @ index goes stale', () => {
  test('a new, deleted or moved file changes the path set', () => {
    assert.equal(mutationChangesPaths('file.edited', { kind: 'create' }), true);
    assert.equal(mutationChangesPaths('file.edited', { kind: 'delete' }), true);
    assert.equal(mutationChangesPaths('file.edited', { kind: 'move' }), true);
    // Older logs say `created` and no `kind`.
    assert.equal(mutationChangesPaths('file.edited', { created: true }), true);
  });

  test('editing what is already there does not, so an edit-heavy session pays nothing', () => {
    assert.equal(mutationChangesPaths('file.edited', { kind: 'replace' }), false);
    assert.equal(mutationChangesPaths('file.edited', { kind: 'overwrite' }), false);
    assert.equal(mutationChangesPaths('file.edited', { created: false }), false);
  });

  test('a shell that added or removed something counts; one that only modified does not', () => {
    const changed = (kind: string) => ({ changed: [{ path: 'a', kind, classification: 'source' }] });
    assert.equal(mutationChangesPaths('workspace.mutation', changed('added')), true);
    assert.equal(mutationChangesPaths('workspace.mutation', changed('deleted')), true);
    assert.equal(mutationChangesPaths('workspace.mutation', changed('modified')), false);
  });

  test('anything else, and any malformed payload, is not a reason to re-walk', () => {
    assert.equal(mutationChangesPaths('tool.result', { kind: 'create' }), false);
    assert.equal(mutationChangesPaths('file.read', {}), false);
    assert.equal(mutationChangesPaths('workspace.mutation', {}), false);
    assert.equal(mutationChangesPaths('workspace.mutation', { changed: 'not an array' }), false);
    assert.equal(mutationChangesPaths('file.edited', null), false);
  });

  test('invalidating makes the next walk see a file created since the first', async () => {
    const index = new FileIndex({ root });
    assert.equal((await index.paths()).includes('fresh.ts'), false);
    await writeFile(path.join(root, 'fresh.ts'), 'export const fresh = 1;\n');
    assert.equal((await index.paths()).includes('fresh.ts'), false, 'the cache should still be warm');
    index.invalidate();
    assert.equal((await index.paths()).includes('fresh.ts'), true);
  });
});
