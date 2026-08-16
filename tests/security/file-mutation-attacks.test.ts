/**
 * The destructive tools against the boundaries (ADR-0016).
 *
 * `Write`, `Delete` and `Move` are the first tools that can remove content, and
 * the interesting question is not whether they work — the integration suite
 * covers that — but whether the ceilings that were written for `Edit` still hold
 * when the operation is "unlink" rather than "replace".
 *
 * Every case here must fail, and must fail at the layer named in its title. A
 * test that only asserts "an error came back" would pass if the file were deleted
 * and the error came from something else afterwards, so each one also checks the
 * bytes on disk.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import type { Kernel } from '../../src/kernel.ts';

function setScript(kernel: Kernel, script: FakeStep[]): void {
  const routed = kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
  routed.routes.set('fake', new FakeModel({ script }));
}

function lastResult(kernel: Kernel): string {
  const out: string[] = [];
  for (const message of kernel.context.history()) {
    if (message.role !== 'tool') continue;
    for (const part of message.parts) {
      if (part.type === 'tool_result') out.push(part.content);
    }
  }
  return out.at(-1) ?? '';
}

/** Run one tool call and return the result the model saw. */
async function runCall(ws: TestWorkspace, name: string, args: Record<string, unknown>): Promise<string> {
  setScript(ws.kernel, [
    { kind: 'tools', calls: [{ name, arguments: args }] },
    { kind: 'final', text: 'done' },
  ]);
  await ws.kernel.session.runTurn(`${name} ${JSON.stringify(args)}`);
  return lastResult(ws.kernel);
}

async function present(root: string, rel: string): Promise<boolean> {
  try {
    await stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

describe('protected paths cannot be deleted', () => {
  test('Delete on a .env is hard denied, whatever the user would approve', async () => {
    const ws = await createTestWorkspace({
      files: { '.env': 'API_KEY=sk-live-not-a-real-key\n' },
      // A prompter that says yes to everything: a hard deny must never reach it.
      approvals: [{ decision: 'allow', scope: 'session' }],
    });
    try {
      const result = await runCall(ws, 'Delete', { path: '.env', receiptId: 'anything' });

      assert.match(result, /PROTECTED_PATH/);
      assert.equal(ws.prompter.seen.length, 0, 'a hard deny must not be turned into a prompt');
      assert.equal(await present(ws.root, '.env'), true);
    } finally {
      await ws.cleanup();
    }
  });

  test('Write cannot overwrite a secret file either', async () => {
    const ws = await createTestWorkspace({
      files: { 'config/private.key': 'PRIVATE KEY MATERIAL\n' },
      approvals: [{ decision: 'allow', scope: 'session' }],
    });
    try {
      const result = await runCall(ws, 'Write', {
        path: 'config/private.key',
        content: 'replaced\n',
        receiptId: 'anything',
      });

      assert.match(result, /PROTECTED_PATH/);
      assert.match(await ws.file('config/private.key'), /PRIVATE KEY MATERIAL/);
    } finally {
      await ws.cleanup();
    }
  });

  test('Move cannot use a rename to reach a protected destination', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/payload.txt': 'anything\n' },
      approvals: [{ decision: 'allow', scope: 'session' }],
    });
    try {
      // Renaming *onto* `.env` is a write to a protected path, and renaming a
      // protected file away is a delete of one. Both are refused.
      const onto = await runCall(ws, 'Move', { from: 'src/payload.txt', to: '.env' });
      assert.match(onto, /PROTECTED_PATH/);
      assert.equal(await present(ws.root, '.env'), false);

      await writeFile(path.join(ws.root, '.env'), 'API_KEY=sk-live-x\n', 'utf8');
      const away = await runCall(ws, 'Move', { from: '.env', to: 'src/leaked.txt' });
      assert.match(away, /PROTECTED_PATH/);
      assert.equal(await present(ws.root, 'src/leaked.txt'), false);
      assert.equal(await present(ws.root, '.env'), true);
    } finally {
      await ws.cleanup();
    }
  });

  test('a symlink into a credential directory does not launder a delete', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'export const a = 1;\n' },
      outsideFiles: [['secrets/id_ed25519', 'PRIVATE KEY\n', 0o600]],
      // The helper resolves a relative link target against the workspace root,
      // and `outsideFiles` writes relative to its parent — so one `..`.
      symlinks: { 'src/link.key': '../secrets/id_ed25519' },
    });
    try {
      const result = await runCall(ws, 'Delete', { path: 'src/link.key', receiptId: 'anything' });

      assert.match(result, /PROTECTED_PATH/);
      assert.equal(
        await readFile(path.join(ws.base, 'secrets/id_ed25519'), 'utf8'),
        'PRIVATE KEY\n',
        'the link target must survive',
      );
    } finally {
      await ws.cleanup();
    }
  });
});

describe('the git database is not edited by hand', () => {
  test('Delete refuses a path inside .git', async () => {
    const ws = await createTestWorkspace({
      files: { '.git/HEAD': 'ref: refs/heads/main\n', 'src/a.ts': 'x\n' },
      approvals: [{ decision: 'allow', scope: 'session' }],
    });
    try {
      const result = await runCall(ws, 'Delete', { path: '.git/HEAD', receiptId: 'anything' });

      assert.match(result, /git database/);
      assert.equal(await present(ws.root, '.git/HEAD'), true);
    } finally {
      await ws.cleanup();
    }
  });

  test('the workspace root cannot be deleted or moved', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'x\n' },
      approvals: [{ decision: 'allow', scope: 'session' }],
    });
    try {
      assert.match(await runCall(ws, 'Delete', { path: '.' }), /workspace root/);
      assert.match(await runCall(ws, 'Move', { from: '.', to: 'elsewhere' }), /workspace root/);
      assert.equal(await present(ws.root, 'src/a.ts'), true);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('read-only profiles have no destructive surface', () => {
  test('Delete, Write and Move are all denied under read-only', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'export const a = 1;\n' },
      profile: 'read-only',
      approvals: [{ decision: 'allow', scope: 'session' }],
    });
    try {
      assert.match(await runCall(ws, 'Delete', { path: 'src/a.ts', receiptId: 'x' }), /TOOL_DENIED/);
      assert.match(await runCall(ws, 'Write', { path: 'src/new.ts', content: 'x\n' }), /TOOL_DENIED/);
      assert.match(await runCall(ws, 'Move', { from: 'src/a.ts', to: 'src/b.ts' }), /TOOL_DENIED/);

      assert.equal(await ws.file('src/a.ts'), 'export const a = 1;\n');
      assert.equal(await present(ws.root, 'src/new.ts'), false);
      assert.equal(await present(ws.root, 'src/b.ts'), false);
      assert.equal(ws.prompter.seen.length, 0, 'a denial is not an approval prompt');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('deletion is a separate approval from writing', () => {
  test('approving a write for a file does not approve deleting it', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'export const a = 1;\n' },
      // The first prompt (if any) is answered "session"; a second prompt proves
      // the delete was not covered by the write's cached subject.
      approvals: [
        { decision: 'allow', scope: 'session' },
        { decision: 'deny', scope: 'once' },
      ],
    });
    try {
      // A workspace write needs no approval at all under workspace-dev …
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [{ name: 'Write', arguments: { path: 'src/new.ts', content: 'export const n = 1;\n' } }],
        },
        { kind: 'final', text: 'written' },
      ]);
      await ws.kernel.session.runTurn('write');
      assert.equal(ws.prompter.seen.length, 0, 'an ordinary workspace write must not prompt');

      // … but deleting the same file does.
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/new.ts' } }] },
        { kind: 'final', text: 'read' },
      ]);
      await ws.kernel.session.runTurn('read it');
      const receipt = ws.kernel.freshness.list().find((r) => r.path.endsWith('new.ts'))!.receiptId;

      const result = await runCall(ws, 'Delete', { path: 'src/new.ts', receiptId: receipt });
      assert.equal(ws.prompter.seen.length, 1, 'deleting must ask');
      assert.match(ws.prompter.seen[0]!.pending[0]!.subjectKey, /^file\.delete:/);
      assert.doesNotMatch(result, /error/);
      assert.equal(await present(ws.root, 'src/new.ts'), false);
    } finally {
      await ws.cleanup();
    }
  });
});
