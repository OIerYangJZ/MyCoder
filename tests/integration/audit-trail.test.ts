/**
 * CLOSURE B — every mutation reaches the durable log (ADR-0025 §1).
 *
 * The defect this suite exists for: of the four mutating tools, only `Edit`
 * emitted `file.edited`. `Write`, `Delete` and `Move` — the three whose mistakes
 * are least recoverable — changed the workspace and left no trace in the audit
 * trail, and `Delete` on an empty directory left no trace anywhere at all.
 *
 * It survived two milestones because nothing asked the log this question. The
 * last test here asks it *generically*: it enumerates the registry's mutating
 * tools rather than a hardcoded list, so a fifth one that forgets to journal
 * fails here instead of quietly re-opening the gap.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import type { Kernel } from '../../src/kernel.ts';
import type { KernelEvent } from '../../src/session/events.ts';

function setScript(kernel: Kernel, script: FakeStep[]): void {
  const routed = kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
  routed.routes.set('fake', new FakeModel({ script }));
}

async function events(ws: TestWorkspace, type: string): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const event of ws.kernel.store.readEvents(ws.kernel.sessionId)) {
    if (event.type === type) out.push(event);
  }
  return out;
}

async function readReceipt(ws: TestWorkspace, file: string): Promise<string> {
  setScript(ws.kernel, [
    { kind: 'tools', calls: [{ name: 'Read', arguments: { path: file } }] },
    { kind: 'final', text: 'read' },
  ]);
  await ws.kernel.session.runTurn(`read ${file}`);
  const receipt = ws.kernel.freshness.list().find((r) => r.path.endsWith(file.split('/').at(-1)!));
  return receipt?.receiptId ?? 'missing';
}

async function runOne(ws: TestWorkspace, name: string, args: Record<string, unknown>): Promise<void> {
  setScript(ws.kernel, [
    { kind: 'tools', calls: [{ name, arguments: args }] },
    { kind: 'final', text: 'done' },
  ]);
  await ws.kernel.session.runTurn(`run ${name}`);
}

describe('every mutating tool reaches the event log', () => {
  test('Write — creating a file emits file.edited', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'x\n' } });
    try {
      await runOne(ws, 'Write', { path: 'b.ts', content: 'export const b = 1;\n' });

      const edited = await events(ws, 'file.edited');
      assert.equal(edited.length, 1, 'Write must produce exactly one file.edited');
      const payload = edited[0]!.payload as Record<string, unknown>;
      assert.equal(payload.kind, 'create');
      assert.equal(payload.path, 'b.ts');
      assert.equal(payload.created, true);
      assert.equal(typeof payload.entryId, 'string');
    } finally {
      await ws.cleanup();
    }
  });

  test('Write — overwriting emits file.edited with both hashes', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\ntwo\n' } });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      await runOne(ws, 'Write', { path: 'a.ts', content: 'three\n', receiptId });

      const edited = await events(ws, 'file.edited');
      assert.equal(edited.length, 1);
      const payload = edited[0]!.payload as Record<string, unknown>;
      assert.equal(payload.kind, 'overwrite');
      assert.notEqual(payload.oldHash, payload.newHash);
      assert.match(String(payload.diff), /-one/);
    } finally {
      await ws.cleanup();
    }
  });

  test('Delete — removing a file emits file.edited carrying the content', async () => {
    const ws = await createTestWorkspace({
      files: { 'gone.ts': 'keep\nthis\n' },
      approvals: [{ decision: 'allow', scope: 'session' }],
    });
    try {
      const receiptId = await readReceipt(ws, 'gone.ts');
      await runOne(ws, 'Delete', { path: 'gone.ts', receiptId });

      const edited = await events(ws, 'file.edited');
      assert.equal(edited.length, 1);
      const payload = edited[0]!.payload as Record<string, unknown>;
      assert.equal(payload.kind, 'delete');
      assert.equal(payload.deletedFile, true);
      // The diff is the copy, which is the whole reason a deletion is reversible.
      assert.match(String(payload.diff), /-keep\n-this/);
    } finally {
      await ws.cleanup();
    }
  });

  test('Delete — an empty directory reaches the log too', async () => {
    const ws = await createTestWorkspace({
      files: { 'dir/x.ts': 'x\n' },
      approvals: [
        { decision: 'allow', scope: 'once' },
        { decision: 'allow', scope: 'once' },
      ],
    });
    try {
      const receiptId = await readReceipt(ws, 'dir/x.ts');
      await runOne(ws, 'Delete', { path: 'dir/x.ts', receiptId });
      await runOne(ws, 'Delete', { path: 'dir' });

      const edited = await events(ws, 'file.edited');
      assert.equal(edited.length, 2, 'the file and the directory are both mutations');
      const dir = edited[1]!.payload as Record<string, unknown>;
      assert.equal(dir.directory, true);
      assert.equal(dir.kind, 'delete');
    } finally {
      await ws.cleanup();
    }
  });

  test('Move — a rename emits file.edited naming both paths', async () => {
    const ws = await createTestWorkspace({
      files: { 'from.ts': 'v\n' },
      approvals: [{ decision: 'allow', scope: 'once' }],
    });
    try {
      await runOne(ws, 'Move', { from: 'from.ts', to: 'to.ts' });

      const edited = await events(ws, 'file.edited');
      assert.equal(edited.length, 1);
      const payload = edited[0]!.payload as Record<string, unknown>;
      assert.equal(payload.kind, 'move');
      assert.equal(payload.path, 'to.ts');
      assert.equal(payload.movedFrom, 'from.ts');
      assert.equal(typeof payload.movedFromPath, 'string');
    } finally {
      await ws.cleanup();
    }
  });

  test('Edit — the one tool that already worked still does', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'alpha\nbeta\n' } });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      await runOne(ws, 'Edit', {
        path: 'a.ts',
        oldString: 'beta',
        newString: 'gamma',
        receiptId,
        mode: 'replace',
      });

      const edited = await events(ws, 'file.edited');
      assert.equal(edited.length, 1);
      const payload = edited[0]!.payload as Record<string, unknown>;
      assert.equal(payload.kind, 'replace');
      // The fields the pre-alpha.10 log carried are still carried.
      assert.equal(payload.linesAdded, 1);
      assert.equal(payload.linesRemoved, 1);
    } finally {
      await ws.cleanup();
    }
  });

  /**
   * The generic form of the defect.
   *
   * A hardcoded list of four would have passed for the whole of alpha.7–alpha.9
   * while three of them were broken, because the list would have been written
   * from the same assumption that produced the bug. This asks the registry.
   */
  test('no mutating builtin changes the workspace without journalling it', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/one.ts': 'one\n', 'src/two.ts': 'two\n', 'src/three.ts': 'three\n' },
      approvals: Array.from({ length: 8 }, () => ({ decision: 'allow' as const, scope: 'once' as const })),
    });
    try {
      const mutating = ws.kernel.toolRegistry
        .all()
        .filter((t) => !t.readOnly)
        .map((t) => t.name);

      // Every builtin that can change a file, and the call that exercises it.
      // A new mutating tool must be added here — which is the point: the
      // assertion below fails until it is.
      // Each entry returns how many `file.edited` events its call should
      // produce, because `Undo` is a mutating tool whose exercise is necessarily
      // two mutations: the edit it reverses and the reversal itself.
      const exercised: Record<string, () => Promise<number>> = {
        Edit: async () => {
          const r = await readReceipt(ws, 'src/one.ts');
          await runOne(ws, 'Edit', {
            path: 'src/one.ts',
            oldString: 'one',
            newString: 'ONE',
            receiptId: r,
            mode: 'replace',
          });
          return 1;
        },
        Write: async () => {
          await runOne(ws, 'Write', { path: 'src/new.ts', content: 'new\n' });
          return 1;
        },
        Delete: async () => {
          const r = await readReceipt(ws, 'src/two.ts');
          await runOne(ws, 'Delete', { path: 'src/two.ts', receiptId: r });
          return 1;
        },
        Move: async () => {
          await runOne(ws, 'Move', { from: 'src/three.ts', to: 'src/moved.ts' });
          return 1;
        },
        Undo: async () => {
          // Both calls in one turn: the model may only reverse the turn it is in
          // (ADR-0026 §6), which is the loop guard rather than an accident of
          // this fixture.
          const r = await readReceipt(ws, 'src/one.ts');
          setScript(ws.kernel, [
            {
              kind: 'tools',
              calls: [
                {
                  name: 'Edit',
                  arguments: {
                    path: 'src/one.ts',
                    oldString: 'ONE',
                    newString: 'one again',
                    receiptId: r,
                    mode: 'replace',
                  },
                },
              ],
            },
            { kind: 'tools', calls: [{ name: 'Undo', arguments: {} }] },
            { kind: 'final', text: 'reverted' },
          ]);
          await ws.kernel.session.runTurn('edit then undo');
          return 2;
        },
      };

      const fileMutating = mutating.filter((name) => name in exercised);
      const unexercised = mutating.filter(
        (name) => !(name in exercised) && !['Shell', 'Delegate', 'Skill', 'WebFetch'].includes(name),
      );
      assert.deepEqual(
        unexercised,
        [],
        `a mutating tool this suite does not exercise: ${unexercised.join(', ')}. ` +
          'Add it above, or classify it as not-file-mutating.',
      );

      let expected = 0;
      for (const name of fileMutating) {
        expected += await exercised[name]!();
        const edited = await events(ws, 'file.edited');
        assert.equal(edited.length, expected, `${name} changed the workspace without appending file.edited`);
      }
    } finally {
      await ws.cleanup();
    }
  });
});
