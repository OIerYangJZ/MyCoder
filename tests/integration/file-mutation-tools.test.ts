/**
 * Write, Delete and Move (ADR-0016).
 *
 * The three tools share one property and it is the only reason they are safe to
 * have: **you cannot destroy content you have not read in full**. Each suite here
 * proves one half of that — the receipt is demanded, and a partial read is not a
 * receipt — and then proves the ordinary case still works, because a rule nobody
 * can satisfy is not a safety property.
 *
 * Everything runs against the real kernel with the fake model, so the policy
 * engine, the approval prompt, the freshness ledger and the edit journal are all
 * the production ones.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';

import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import type { Kernel } from '../../src/kernel.ts';

function setScript(kernel: Kernel, script: FakeStep[]): void {
  const routed = kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
  routed.routes.set('fake', new FakeModel({ script }));
}

function toolResults(kernel: Kernel): string[] {
  const out: string[] = [];
  for (const message of kernel.context.history()) {
    if (message.role !== 'tool') continue;
    for (const part of message.parts) {
      if (part.type === 'tool_result') out.push(part.content);
    }
  }
  return out;
}

const last = (kernel: Kernel): string => toolResults(kernel).at(-1) ?? '';

/** Read a file through the agent, and hand back the receipt that produced. */
async function readFile(
  ws: TestWorkspace,
  file: string,
  window?: { offsetLine: number; limitLines: number },
) {
  setScript(ws.kernel, [
    {
      kind: 'tools',
      calls: [{ name: 'Read', arguments: { path: file, ...(window ?? {}) } }],
    },
    { kind: 'final', text: 'read' },
  ]);
  await ws.kernel.session.runTurn(`read ${file}`);
  const receipt = ws.kernel.freshness.list().find((r) => r.path.endsWith(file.split('/').at(-1)!));
  return receipt?.receiptId ?? 'missing';
}

async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

describe('Write', () => {
  test('creates a file that does not exist, with no receipt', async () => {
    const ws = await createTestWorkspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
    try {
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [{ name: 'Write', arguments: { path: 'src/b.ts', content: 'export const b = 2;\n' } }],
        },
        { kind: 'final', text: 'created' },
      ]);
      await ws.kernel.session.runTurn('create it');

      assert.equal(await ws.file('src/b.ts'), 'export const b = 2;\n');
      assert.match(last(ws.kernel), /Created .*b\.ts/);
      assert.equal(ws.kernel.editJournal.all().at(-1)!.kind, 'create');
    } finally {
      await ws.cleanup();
    }
  });

  test('refuses to overwrite an existing file without a receipt', async () => {
    const ws = await createTestWorkspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
    try {
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [{ name: 'Write', arguments: { path: 'src/a.ts', content: 'wiped\n' } }],
        },
        { kind: 'final', text: 'tried' },
      ]);
      await ws.kernel.session.runTurn('overwrite it');

      assert.match(last(ws.kernel), /TOOL_INVALID_ARGS/);
      assert.equal(await ws.file('src/a.ts'), 'export const a = 1;\n', 'the file must be untouched');
    } finally {
      await ws.cleanup();
    }
  });

  test('refuses to overwrite a file that was only read in part', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const ws = await createTestWorkspace({ files: { 'src/long.ts': lines } });
    try {
      const receipt = await readFile(ws, 'src/long.ts', { offsetLine: 1, limitLines: 5 });

      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            { name: 'Write', arguments: { path: 'src/long.ts', content: 'replaced\n', receiptId: receipt } },
          ],
        },
        { kind: 'final', text: 'tried' },
      ]);
      await ws.kernel.session.runTurn('overwrite from a partial read');

      assert.match(last(ws.kernel), /INSUFFICIENT_READ_COVERAGE/);
      assert.equal(await ws.file('src/long.ts'), lines);
    } finally {
      await ws.cleanup();
    }
  });

  test('overwrites after a full read, and records the diff', async () => {
    const ws = await createTestWorkspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
    try {
      const receipt = await readFile(ws, 'src/a.ts');

      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Write',
              arguments: { path: 'src/a.ts', content: 'export const a = 2;\n', receiptId: receipt },
            },
          ],
        },
        { kind: 'final', text: 'done' },
      ]);
      await ws.kernel.session.runTurn('overwrite it');

      assert.equal(await ws.file('src/a.ts'), 'export const a = 2;\n');
      const entry = ws.kernel.editJournal.all().at(-1)!;
      assert.equal(entry.kind, 'overwrite');
      assert.match(entry.diff, /-export const a = 1;/);
      assert.match(entry.diff, /\+export const a = 2;/);
    } finally {
      await ws.cleanup();
    }
  });

  test('a spent receipt cannot be reused', async () => {
    const ws = await createTestWorkspace({ files: { 'src/a.ts': 'one\n' } });
    try {
      const receipt = await readFile(ws, 'src/a.ts');
      const write = (content: string): FakeStep => ({
        kind: 'tools',
        calls: [{ name: 'Write', arguments: { path: 'src/a.ts', content, receiptId: receipt } }],
      });

      setScript(ws.kernel, [write('two\n'), { kind: 'final', text: 'ok' }]);
      await ws.kernel.session.runTurn('first');
      assert.equal(await ws.file('src/a.ts'), 'two\n');

      setScript(ws.kernel, [write('three\n'), { kind: 'final', text: 'tried' }]);
      await ws.kernel.session.runTurn('again');

      assert.match(last(ws.kernel), /STALE_FILE/);
      assert.equal(await ws.file('src/a.ts'), 'two\n');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('Delete', () => {
  test('removes a file that was read in full, once approved', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/old.ts': 'export const old = true;\n' },
      approvals: [{ decision: 'allow', scope: 'once' }],
    });
    try {
      const receipt = await readFile(ws, 'src/old.ts');

      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Delete', arguments: { path: 'src/old.ts', receiptId: receipt } }] },
        { kind: 'final', text: 'deleted' },
      ]);
      await ws.kernel.session.runTurn('delete it');

      assert.equal(await exists(ws.root, 'src/old.ts'), false);
      assert.match(last(ws.kernel), /Deleted .*old\.ts/);

      // Deletion is never silent: it asked, and the prompt named the file.
      assert.equal(ws.prompter.seen.length, 1);
      assert.match(ws.prompter.seen[0]!.subject.title, /Delete .*old\.ts/);

      // The journal carries the whole file, which is what an undo would need.
      const entry = ws.kernel.editJournal.all().at(-1)!;
      assert.equal(entry.kind, 'delete');
      assert.equal(entry.deletedFile, true);
      assert.match(entry.diff, /-export const old = true;/);
    } finally {
      await ws.cleanup();
    }
  });

  test('a denied deletion leaves the file alone', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/old.ts': 'keep me\n' },
      approvals: [{ decision: 'deny', scope: 'once' }],
    });
    try {
      const receipt = await readFile(ws, 'src/old.ts');
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Delete', arguments: { path: 'src/old.ts', receiptId: receipt } }] },
        { kind: 'final', text: 'refused' },
      ]);
      await ws.kernel.session.runTurn('delete it');

      assert.match(last(ws.kernel), /TOOL_DENIED/);
      assert.equal(await ws.file('src/old.ts'), 'keep me\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('requires a receipt for a file', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/old.ts': 'x\n' },
      approvals: [{ decision: 'allow', scope: 'once' }],
    });
    try {
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Delete', arguments: { path: 'src/old.ts' } }] },
        { kind: 'final', text: 'tried' },
      ]);
      await ws.kernel.session.runTurn('delete it');

      assert.match(last(ws.kernel), /TOOL_INVALID_ARGS/);
      assert.equal(await exists(ws.root, 'src/old.ts'), true);
    } finally {
      await ws.cleanup();
    }
  });

  test('removes an empty directory, and refuses one with contents', async () => {
    const ws = await createTestWorkspace({
      files: { 'keep/inner.ts': 'export const x = 1;\n' },
      // One per deletion: each path is its own approval subject, which is the
      // point of `subjectKeyOf` — approving one file never approves another.
      approvals: [
        { decision: 'allow', scope: 'once' },
        { decision: 'allow', scope: 'once' },
        { decision: 'allow', scope: 'once' },
      ],
    });
    try {
      // A directory the fixture creates empty is awkward to express through
      // `files`, so the agent makes one.
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Write', arguments: { path: 'empty/x.ts', content: 'x\n' } }] },
        { kind: 'final', text: 'made it' },
      ]);
      await ws.kernel.session.runTurn('make a directory');

      const receipt = await readFile(ws, 'empty/x.ts');
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Delete', arguments: { path: 'empty/x.ts', receiptId: receipt } }] },
        { kind: 'tools', calls: [{ name: 'Delete', arguments: { path: 'empty' } }] },
        { kind: 'tools', calls: [{ name: 'Delete', arguments: { path: 'keep' } }] },
        { kind: 'final', text: 'done' },
      ]);
      await ws.kernel.session.runTurn('clear it out');

      const results = toolResults(ws.kernel);
      assert.ok(
        results.some((r) => /Removed empty directory/.test(r)),
        'the empty directory should go',
      );
      assert.equal(await exists(ws.root, 'empty'), false);

      assert.match(last(ws.kernel), /containing 1 entry/);
      assert.equal(await exists(ws.root, 'keep/inner.ts'), true, 'a non-empty directory survives');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('Move', () => {
  test('renames a file and invalidates the receipts for both paths', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'export const a = 1;\n' },
      approvals: [{ decision: 'allow', scope: 'once' }],
    });
    try {
      await readFile(ws, 'src/a.ts');
      assert.equal(ws.kernel.freshness.list().length, 1);

      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Move', arguments: { from: 'src/a.ts', to: 'src/renamed.ts' } }] },
        { kind: 'final', text: 'moved' },
      ]);
      await ws.kernel.session.runTurn('rename it');

      assert.equal(await ws.file('src/renamed.ts'), 'export const a = 1;\n');
      assert.equal(await exists(ws.root, 'src/a.ts'), false);
      assert.equal(ws.kernel.freshness.list().length, 0, 'the receipt named a path that no longer exists');

      const entry = ws.kernel.editJournal.all().at(-1)!;
      assert.equal(entry.kind, 'move');
      assert.match(entry.movedFrom ?? '', /a\.ts/);
    } finally {
      await ws.cleanup();
    }
  });

  test('never overwrites an existing destination', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'first\n', 'src/b.ts': 'second\n' },
      approvals: [{ decision: 'allow', scope: 'once' }],
    });
    try {
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Move', arguments: { from: 'src/a.ts', to: 'src/b.ts' } }] },
        { kind: 'final', text: 'tried' },
      ]);
      await ws.kernel.session.runTurn('move onto b');

      assert.match(last(ws.kernel), /already exists/);
      assert.equal(await ws.file('src/a.ts'), 'first\n');
      assert.equal(await ws.file('src/b.ts'), 'second\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('moves a directory', async () => {
    const ws = await createTestWorkspace({
      files: { 'pkg/one.ts': 'export const one = 1;\n' },
      approvals: [{ decision: 'allow', scope: 'once' }],
    });
    try {
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Move', arguments: { from: 'pkg', to: 'lib' } }] },
        { kind: 'final', text: 'moved' },
      ]);
      await ws.kernel.session.runTurn('rename the package');

      assert.equal(await ws.file('lib/one.ts'), 'export const one = 1;\n');
      assert.equal(await exists(ws.root, 'pkg'), false);
    } finally {
      await ws.cleanup();
    }
  });
});
