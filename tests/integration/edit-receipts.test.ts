/**
 * A successful edit hands back the receipt for what it just wrote (alpha.12).
 *
 * The freshness ledger has always refreshed the receipt after a write —
 * `recordWrite` returns one, and `ExactEditEngine.apply` discarded it. So the
 * ledger was correct and the model could not act on it: a second edit to the
 * same file was refused with `STALE_FILE`, and the only way to learn the new
 * receipt was to Read the file again.
 *
 * Found by giving a real model a real multi-file task on a VM. Its own narration
 * is the bug report:
 *
 *   > my earlier receipt for the region (lines 17-41) is now stale since import
 *   > added a line above line 17. I need to re-read the region after the change.
 *
 * It spent a step on that after nearly every edit, and the run ended at the
 * 40-step budget with the work unfinished. Nothing was wrong with the policy;
 * the kernel was withholding a value it had already computed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTestWorkspace } from '../helpers/workspace.ts';

/** The receiptId a tool result advertises, if it advertises one. */
function receiptFrom(content: string): string | undefined {
  return /receiptId:\s*(\S+)/.exec(content)?.[1];
}

describe('an edit reports the receipt for the file it just wrote', () => {
  test('Edit returns a receiptId, and it is not the one that was passed in', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'const a = 1;\nconst b = 2;\n' } });
    try {
      const read = await ws.kernel.session.runControlTool('Read', { path: 'a.ts' });
      const first = receiptFrom(read.content);
      assert.ok(first, 'Read did not report a receiptId');

      const edited = await ws.kernel.session.runControlTool('Edit', {
        path: 'a.ts',
        oldString: 'const a = 1;',
        newString: 'const a = 9;',
        receiptId: first,
      });
      assert.equal(edited.isError, false, edited.content);

      const next = receiptFrom(edited.content);
      assert.ok(next, `Edit reported no receiptId: ${JSON.stringify(edited.content.slice(0, 120))}`);
      assert.notEqual(next, first, 'the same receipt came back, which cannot describe the new content');
    } finally {
      await ws.cleanup();
    }
  });

  /**
   * The property that makes the fix worth having: N edits, N-1 fewer reads.
   */
  test('three consecutive edits need no read between them', async () => {
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;\n' },
    });
    try {
      const read = await ws.kernel.session.runControlTool('Read', { path: 'a.ts' });
      let receipt = receiptFrom(read.content);

      const edits: Array<[string, string]> = [
        ['const a = 1;', 'const a = 9;'],
        ['const b = 2;', 'const b = 8;'],
        ['const c = 3;', 'const c = 7;'],
      ];

      for (const [oldString, newString] of edits) {
        const result = await ws.kernel.session.runControlTool('Edit', {
          path: 'a.ts',
          oldString,
          newString,
          receiptId: receipt,
        });
        assert.equal(result.isError, false, `${oldString}: ${result.content}`);
        receipt = receiptFrom(result.content);
        assert.ok(receipt, `no receipt after editing ${oldString}`);
      }

      assert.equal(await ws.file('a.ts'), 'const a = 9;\nconst b = 8;\nconst c = 7;\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('Write reports one too, so an overwrite can be followed by an edit', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'old\n' } });
    try {
      const read = await ws.kernel.session.runControlTool('Read', { path: 'a.ts' });
      const written = await ws.kernel.session.runControlTool('Write', {
        path: 'a.ts',
        content: 'fresh = 1;\nkeep = 2;\n',
        receiptId: receiptFrom(read.content),
      });
      assert.equal(written.isError, false, written.content);

      const afterWrite = receiptFrom(written.content);
      assert.ok(afterWrite, `Write reported no receiptId: ${JSON.stringify(written.content.slice(0, 120))}`);

      const edited = await ws.kernel.session.runControlTool('Edit', {
        path: 'a.ts',
        oldString: 'fresh = 1;',
        newString: 'fresh = 42;',
        receiptId: afterWrite,
      });
      assert.equal(edited.isError, false, `the receipt Write reported was not usable: ${edited.content}`);
    } finally {
      await ws.cleanup();
    }
  });

  /**
   * The negative control. Reporting the new receipt must not weaken the check
   * it exists to serve — a *stale* receipt is still refused, which is the whole
   * reason the ledger is there.
   */
  test('the old receipt is still refused after an edit', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'const a = 1;\nconst b = 2;\n' } });
    try {
      const read = await ws.kernel.session.runControlTool('Read', { path: 'a.ts' });
      const stale = receiptFrom(read.content);

      await ws.kernel.session.runControlTool('Edit', {
        path: 'a.ts',
        oldString: 'const a = 1;',
        newString: 'const a = 9;',
        receiptId: stale,
      });

      const second = await ws.kernel.session.runControlTool('Edit', {
        path: 'a.ts',
        oldString: 'const b = 2;',
        newString: 'const b = 8;',
        receiptId: stale,
      });
      assert.equal(second.isError, true, 'a stale receipt was accepted');
      assert.match(second.content, /STALE_FILE/);
    } finally {
      await ws.cleanup();
    }
  });

  test('creating a file reports a receipt, so it can be edited without a read', async () => {
    const ws = await createTestWorkspace({});
    try {
      const created = await ws.kernel.session.runControlTool('Write', {
        path: 'new.ts',
        content: 'export const x = 1;\n',
      });
      assert.equal(created.isError, false, created.content);

      const receipt = receiptFrom(created.content);
      assert.ok(receipt, 'a create reported no receiptId');

      const edited = await ws.kernel.session.runControlTool('Edit', {
        path: 'new.ts',
        oldString: 'export const x = 1;',
        newString: 'export const x = 2;',
        receiptId: receipt,
      });
      assert.equal(edited.isError, false, edited.content);
    } finally {
      await ws.cleanup();
    }
  });

  /**
   * The tool descriptions have to say so, or a model will not plan for it — it
   * budgets a Read between edits because nothing told it not to.
   *
   * Read off the live registry rather than the source, so this is the text the
   * model is actually shown.
   */
  test('both tools advertise the returned receipt in their description', async () => {
    const ws = await createTestWorkspace({});
    try {
      for (const name of ['Edit', 'Write']) {
        const description = ws.kernel.toolRegistry.get(name)?.description ?? '';
        assert.ok(description.length > 0, `${name} is not registered`);
        assert.match(
          description,
          /returns a fresh receiptId/,
          `${name} does not tell the model the receipt comes back`,
        );
      }
    } finally {
      await ws.cleanup();
    }
  });
});
