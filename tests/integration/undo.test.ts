/**
 * Undo — the alpha.10 §16 regression matrix.
 *
 * Two properties are load-bearing and everything here serves one of them.
 *
 * **It restores the exact prior bytes, or it refuses.** Never a third outcome.
 * Every reconstruction is hashed against what the journal recorded before a byte
 * is written (ADR-0025 §4), so the interesting half of this suite is the
 * refusals — eight distinct causes, each named.
 *
 * **Every denial has a reverse control.** A refusal that cannot be made to
 * succeed is not evidence; alpha.9's HTTP address check is the model copied
 * here. Each `refuses …` test is paired with the same fixture minus the one
 * thing that caused the refusal, and that pairing must pass.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { CANARY, createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts';
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

const ALLOW = Array.from({ length: 20 }, () => ({ decision: 'allow' as const, scope: 'once' as const }));

async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

/** Read a file through the agent, returning the receipt that produced. */
async function readReceipt(ws: TestWorkspace, file: string): Promise<string> {
  setScript(ws.kernel, [
    { kind: 'tools', calls: [{ name: 'Read', arguments: { path: file } }] },
    { kind: 'final', text: 'read' },
  ]);
  await ws.kernel.session.runTurn(`read ${file}`);
  const receipt = ws.kernel.freshness.list().find((r) => r.path.endsWith(file.split('/').at(-1)!));
  return receipt?.receiptId ?? 'missing';
}

/**
 * Do something, then undo it, **in one turn**.
 *
 * One turn because the model's `Undo` is capped at the turn it is in (ADR-0026
 * §6), which is the loop guard rather than a quirk of the harness. Tests that
 * need to reach further use `/undo`, as a person would.
 */
async function inOneTurn(ws: TestWorkspace, calls: FakeStep[]): Promise<void> {
  setScript(ws.kernel, [...calls, { kind: 'final', text: 'done' }]);
  await ws.kernel.session.runTurn('do it');
}

// --- the five kinds -------------------------------------------------------

describe('undo restores what the kernel did', () => {
  test('a replace — the content and the hash both return', async () => {
    const before = 'alpha\nbeta\ngamma\n';
    const ws = await createTestWorkspace({ files: { 'a.ts': before }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      await inOneTurn(ws, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'beta', newString: 'BETA', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'tools', calls: [{ name: 'Undo', arguments: {} }] },
      ]);

      assert.equal(await ws.file('a.ts'), before);
      assert.match(last(ws.kernel), /Reversed 1 edit/);
    } finally {
      await ws.cleanup();
    }
  });

  test('a create — the file is gone again', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'x\n' }, approvals: ALLOW });
    try {
      await inOneTurn(ws, [
        { kind: 'tools', calls: [{ name: 'Write', arguments: { path: 'new.ts', content: 'new\n' } }] },
        { kind: 'tools', calls: [{ name: 'Undo', arguments: {} }] },
      ]);

      assert.equal(await exists(ws.root, 'new.ts'), false);
    } finally {
      await ws.cleanup();
    }
  });

  test('a delete — the content returns byte-for-byte', async () => {
    const before = 'keep\nthis\nexactly\n';
    const ws = await createTestWorkspace({ files: { 'gone.ts': before }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'gone.ts');
      await inOneTurn(ws, [
        { kind: 'tools', calls: [{ name: 'Delete', arguments: { path: 'gone.ts', receiptId } }] },
        { kind: 'tools', calls: [{ name: 'Undo', arguments: {} }] },
      ]);

      assert.equal(await ws.file('gone.ts'), before);
    } finally {
      await ws.cleanup();
    }
  });

  test('a move — both paths are back where they were', async () => {
    const ws = await createTestWorkspace({ files: { 'from.ts': 'v\n' }, approvals: ALLOW });
    try {
      await inOneTurn(ws, [
        { kind: 'tools', calls: [{ name: 'Move', arguments: { from: 'from.ts', to: 'to.ts' } }] },
        { kind: 'tools', calls: [{ name: 'Undo', arguments: {} }] },
      ]);

      assert.equal(await exists(ws.root, 'to.ts'), false);
      assert.equal(await ws.file('from.ts'), 'v\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('an overwrite of a large file — §9 said this was the lossy candidate', async () => {
    // 5000 unrelated lines each side, which is past the differ's LCS ceiling and
    // therefore the coarse single-hunk path. The audit says it round-trips; this
    // says so against the real tool, through the real journal and the real
    // redactor.
    const before = Array.from({ length: 5000 }, (_, i) => `old line ${i}`).join('\n') + '\n';
    const after = Array.from({ length: 5000 }, (_, i) => `new line ${i}`).join('\n') + '\n';
    const ws = await createTestWorkspace({ files: { 'big.ts': before }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'big.ts');
      await inOneTurn(ws, [
        {
          kind: 'tools',
          calls: [{ name: 'Write', arguments: { path: 'big.ts', content: after, receiptId } }],
        },
        { kind: 'tools', calls: [{ name: 'Undo', arguments: {} }] },
      ]);

      assert.equal(await ws.file('big.ts'), before);
    } finally {
      await ws.cleanup();
    }
  });

  test('an undo of an undo, by the ordinary mechanism', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      await inOneTurn(ws, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'two', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'tools', calls: [{ name: 'Undo', arguments: {} }] },
      ]);
      assert.equal(await ws.file('a.ts'), 'one\n');

      // The model may not undo its own undo — that is the loop guard.
      await inOneTurn(ws, [{ kind: 'tools', calls: [{ name: 'Undo', arguments: {} }] }]);
      assert.match(last(ws.kernel), /nothing to undo/);
      assert.equal(await ws.file('a.ts'), 'one\n');

      // A person may, and it is an ordinary journalled edit.
      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.equal(await ws.file('a.ts'), 'two\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('undo with nothing to undo says so, and still states the limits', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'x\n' }, approvals: ALLOW });
    try {
      await inOneTurn(ws, [{ kind: 'tools', calls: [{ name: 'Undo', arguments: {} }] }]);
      assert.match(last(ws.kernel), /nothing to undo/);
      assert.match(last(ws.kernel), /Not covered by undo:/);
    } finally {
      await ws.cleanup();
    }
  });
});

// --- refusals, each with its reverse control ------------------------------

describe('undo refuses rather than guessing', () => {
  test('refuses when the file changed underneath, and names it', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\ntwo\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit');

      // Something else touches the file: a formatter, the user, an MCP server.
      await writeFile(path.join(ws.root, 'a.ts'), 'ONE\ntwo\nthree\n', 'utf8');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, false);
      assert.match(result.message, /a\.ts/);
      assert.match(result.message, /changed after that edit/);
      assert.match(result.message, /\[drifted\]/);
      assert.match(result.message, /Nothing was reversed/);
      // And the workspace is exactly as it was found.
      assert.equal(await ws.file('a.ts'), 'ONE\ntwo\nthree\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('reverse control: the same undo succeeds when nothing touched the file', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\ntwo\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.equal(await ws.file('a.ts'), 'one\ntwo\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('refuses when the file was deleted underneath', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit');
      const { rm } = await import('node:fs/promises');
      await rm(path.join(ws.root, 'a.ts'));

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, false);
      assert.match(result.message, /no longer exists/);
      assert.equal(await exists(ws.root, 'a.ts'), false, 'a refusal writes nothing');
    } finally {
      await ws.cleanup();
    }
  });

  test('refuses to restore a deleted file whose path is occupied again', async () => {
    const ws = await createTestWorkspace({ files: { 'gone.ts': 'old\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'gone.ts');
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Delete', arguments: { path: 'gone.ts', receiptId } }] },
        { kind: 'final', text: 'deleted' },
      ]);
      await ws.kernel.session.runTurn('delete');
      await writeFile(path.join(ws.root, 'gone.ts'), 'someone else\n', 'utf8');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, false);
      assert.match(result.message, /exists again/);
      assert.equal(await ws.file('gone.ts'), 'someone else\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('refuses a move-back whose source is now occupied', async () => {
    const ws = await createTestWorkspace({ files: { 'from.ts': 'v\n' }, approvals: ALLOW });
    try {
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Move', arguments: { from: 'from.ts', to: 'to.ts' } }] },
        { kind: 'final', text: 'moved' },
      ]);
      await ws.kernel.session.runTurn('move');
      await writeFile(path.join(ws.root, 'from.ts'), 'a new file at the old name\n', 'utf8');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, false);
      assert.match(result.message, /exists again/);
      assert.equal(await ws.file('from.ts'), 'a new file at the old name\n');
      assert.equal(await ws.file('to.ts'), 'v\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('reverse control: the move-back succeeds when the source is free', async () => {
    const ws = await createTestWorkspace({ files: { 'from.ts': 'v\n' }, approvals: ALLOW });
    try {
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Move', arguments: { from: 'from.ts', to: 'to.ts' } }] },
        { kind: 'final', text: 'moved' },
      ]);
      await ws.kernel.session.runTurn('move');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.equal(await ws.file('from.ts'), 'v\n');
      assert.equal(await exists(ws.root, 'to.ts'), false);
    } finally {
      await ws.cleanup();
    }
  });

  test("a redacted diff is still reversible in-process — the audit's prediction, corrected", async () => {
    // The §9 audit predicted this edit would be irreversible, and it is — but
    // only once the *log* is the only copy. A running process still holds the
    // real diff in the in-memory journal, so the reversal here is exact. The
    // refusal after a restart is in `undo-resume.test.ts`, as a pair, because
    // the honest statement is the difference between the two and neither half
    // says it alone.
    // The suite's registered canary rather than a credential-shaped literal:
    // the redactor matches registered values exactly, so the shape is irrelevant
    // to what is under test, and a fixture that looks like a real key is a
    // fixture someone eventually reports as a leak.
    const secret = CANARY;
    const before = `const key = "${secret}";\nconst port = 1;\n`;
    const ws = await createTestWorkspace({ files: { 'cfg.ts': before }, approvals: ALLOW });
    try {
      ws.kernel.redactor.addLiteral(secret);

      const receiptId = await readReceipt(ws, 'cfg.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Write',
              arguments: {
                path: 'cfg.ts',
                content: 'const key = process.env.KEY;\nconst port = 1;\n',
                receiptId,
              },
            },
          ],
        },
        { kind: 'final', text: 'rewrote' },
      ]);
      await ws.kernel.session.runTurn('rewrite');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.equal(await ws.file('cfg.ts'), before);
      assert.doesNotMatch(await ws.file('cfg.ts'), /REDACTED/);

      // And the log, which is the durable copy, does hold the placeholder.
      assert.match(await ws.eventLogText(), /REDACTED:secret/);
    } finally {
      await ws.cleanup();
    }
  });

  test('reverse control: the same rewrite without a secret is reversible', async () => {
    const ws = await createTestWorkspace({
      files: { 'cfg.ts': 'const key = "ordinary";\nconst port = 1;\n' },
      approvals: ALLOW,
    });
    try {
      const receiptId = await readReceipt(ws, 'cfg.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Write',
              arguments: {
                path: 'cfg.ts',
                content: 'const key = process.env.KEY;\nconst port = 1;\n',
                receiptId,
              },
            },
          ],
        },
        { kind: 'final', text: 'rewrote' },
      ]);
      await ws.kernel.session.runTurn('rewrite');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.equal(await ws.file('cfg.ts'), 'const key = "ordinary";\nconst port = 1;\n');
    } finally {
      await ws.cleanup();
    }
  });
});

// --- the set property -----------------------------------------------------

describe('an undo never applies to part of a set', () => {
  test('three files, one drifted: nothing is written', async () => {
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'a1\n', 'b.ts': 'b1\n', 'c.ts': 'c1\n' },
      approvals: ALLOW,
    });
    try {
      const ra = await readReceipt(ws, 'a.ts');
      const rb = await readReceipt(ws, 'b.ts');
      const rc = await readReceipt(ws, 'c.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'a1', newString: 'a2', receiptId: ra, mode: 'replace' },
            },
          ],
        },
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'b.ts', oldString: 'b1', newString: 'b2', receiptId: rb, mode: 'replace' },
            },
          ],
        },
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'c.ts', oldString: 'c1', newString: 'c2', receiptId: rc, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited three' },
      ]);
      await ws.kernel.session.runTurn('edit three files');

      // The middle one drifts.
      await writeFile(path.join(ws.root, 'b.ts'), 'b3\n', 'utf8');

      const result = await ws.kernel.control.execute('/undo last 3');
      assert.equal(result.ok, false);
      assert.match(result.message, /b\.ts/);
      assert.match(result.message, /Nothing was reversed/);

      // The state that did exist, not one that never did.
      assert.equal(await ws.file('a.ts'), 'a2\n');
      assert.equal(await ws.file('b.ts'), 'b3\n');
      assert.equal(await ws.file('c.ts'), 'c2\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('reverse control: with nothing drifted, all three reverse together', async () => {
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'a1\n', 'b.ts': 'b1\n', 'c.ts': 'c1\n' },
      approvals: ALLOW,
    });
    try {
      const ra = await readReceipt(ws, 'a.ts');
      const rb = await readReceipt(ws, 'b.ts');
      const rc = await readReceipt(ws, 'c.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'a1', newString: 'a2', receiptId: ra, mode: 'replace' },
            },
          ],
        },
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'b.ts', oldString: 'b1', newString: 'b2', receiptId: rb, mode: 'replace' },
            },
          ],
        },
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'c.ts', oldString: 'c1', newString: 'c2', receiptId: rc, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited three' },
      ]);
      await ws.kernel.session.runTurn('edit three files');

      const result = await ws.kernel.control.execute('/undo last 3');
      assert.equal(result.ok, true, result.message);
      assert.equal(await ws.file('a.ts'), 'a1\n');
      assert.equal(await ws.file('b.ts'), 'b1\n');
      assert.equal(await ws.file('c.ts'), 'c1\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('two edits to one file reverse in order, back to the original', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'v1\n' }, approvals: ALLOW });
    try {
      const r1 = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'v1', newString: 'v2', receiptId: r1, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'one' },
      ]);
      await ws.kernel.session.runTurn('edit once');

      const r2 = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'v2', newString: 'v3', receiptId: r2, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'two' },
      ]);
      await ws.kernel.session.runTurn('edit twice');
      assert.equal(await ws.file('a.ts'), 'v3\n');

      const result = await ws.kernel.control.execute('/undo last 2');
      assert.equal(result.ok, true, result.message);
      assert.equal(await ws.file('a.ts'), 'v1\n');
    } finally {
      await ws.cleanup();
    }
  });
});

// --- what it says it did not do -------------------------------------------

describe('undo enumerates what it did not cover, from the session', () => {
  test('a shell command that mutated source is counted and named', async () => {
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'one\n', 'b.ts': 'b\n' },
      approvals: ALLOW,
    });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        {
          kind: 'tools',
          calls: [
            {
              name: 'Shell',
              arguments: { argv: ['sh', '-c', "printf 'generated\\n' > b.ts"] },
            },
          ],
        },
        { kind: 'final', text: 'both' },
      ]);
      await ws.kernel.session.runTurn('edit and generate');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.match(result.message, /shell command\(s\) changed/);
      // And b.ts is untouched by the undo, because nothing journalled it.
      assert.equal(await ws.file('b.ts'), 'generated\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('a foreign tool call is counted, named, and declared out of reach', async () => {
    // The reason alpha.10 exists. ADR-0023 §6 says `effects inside MCP servers:
    // none`, and the reference filesystem server has `write_file` in its
    // catalogue. The kernel cannot see those writes; what it can do is say how
    // many chances there were, from this session rather than from a constant.
    const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'mcp-server.mjs');
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'one\n' },
      approvals: ALLOW,
      userConfig: `[mcp.servers.wiki]\ncommand = ["${process.execPath}", "${fixture}", "--mode=normal"]\n`,
    });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'tools', calls: [{ name: 'mcp__wiki__echo', arguments: { text: 'hello' } }] },
        { kind: 'final', text: 'both' },
      ]);
      await ws.kernel.session.runTurn('edit and call the server');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.match(result.message, /1 call\(s\) to MCP server\(s\) are not covered \(1 to "wiki"\)/);
      assert.match(result.message, /mcp\.invoke carries no/);
      assert.equal(await ws.file('a.ts'), 'one\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('with nothing uncovered, it says that, rather than saying nothing', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit');

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.match(result.message, /Not covered by undo:/);
      assert.match(result.message, /Nothing else in this session touched the workspace/);
    } finally {
      await ws.cleanup();
    }
  });

  test('/status reports the inventory and the same limits', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit');

      const status = await ws.kernel.control.execute('/status');
      assert.match(status.message, /undo\s+: 1 reversible edit/);
      assert.match(status.message, /Not covered by undo:/);
    } finally {
      await ws.cleanup();
    }
  });

  test('/undo list reverses nothing and shows the inventory', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit');

      const listed = await ws.kernel.control.execute('/undo list');
      assert.equal(listed.ok, true);
      assert.match(listed.message, /1 reversible edit/);
      assert.match(listed.message, /replace\s+a\.ts/);
      assert.equal(await ws.file('a.ts'), 'ONE\n', '/undo list must not write');
    } finally {
      await ws.cleanup();
    }
  });
});

// --- undo is an edit ------------------------------------------------------

describe('undo is an edit, with no special case', () => {
  test('it invalidates the freshness receipts for the paths it reverted', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit');
      assert.ok(ws.kernel.freshness.list().length > 0);

      await ws.kernel.control.execute('/undo');

      const remaining = ws.kernel.freshness.list().filter((r) => r.path.endsWith('a.ts'));
      assert.equal(remaining.length, 0, 'a reverted path keeps no receipt');
    } finally {
      await ws.cleanup();
    }
  });

  test('it appears in the event log as an ordinary file.edited, marked undoOf', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'one\n' }, approvals: ALLOW });
    try {
      const receiptId = await readReceipt(ws, 'a.ts');
      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { path: 'a.ts', oldString: 'one', newString: 'ONE', receiptId, mode: 'replace' },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit');
      await ws.kernel.control.execute('/undo');

      const edited: Array<Record<string, unknown>> = [];
      for await (const event of ws.kernel.store.readEvents(ws.kernel.sessionId)) {
        if (event.type === 'file.edited') edited.push(event.payload as Record<string, unknown>);
      }
      assert.equal(edited.length, 2);
      assert.equal(typeof edited[1]!.undoOf, 'string');
      assert.equal(edited[1]!.undoOf, edited[0]!.entryId);
    } finally {
      await ws.cleanup();
    }
  });

  test('it refuses a path that has become protected', async () => {
    // `.env` is hard-denied for reading and writing. Creating one through the
    // kernel is not possible, so the journal entry is placed directly — which is
    // the only way to reach the state this rule exists for: a file that was
    // writable when it was written and is denied now.
    const ws = await createTestWorkspace({ files: { 'a.ts': 'x\n' }, approvals: ALLOW });
    try {
      const target = path.join(ws.root, '.env');
      await writeFile(target, 'SECRET=2\n', 'utf8');
      const { sha256Hex, newJournalEntryId } = await import('../../src/util/ids.ts');
      ws.kernel.editJournal.record({
        entryId: newJournalEntryId(Date.now()),
        path: target as never,
        displayPath: '.env',
        kind: 'replace',
        oldHash: sha256Hex('SECRET=1\n'),
        newHash: sha256Hex('SECRET=2\n'),
        diff: '--- a/.env\n+++ b/.env\n@@ -1,1 +1,1 @@\n-SECRET=1\n+SECRET=2\n',
        eol: 'lf',
        finalNewline: true,
        createdFile: false,
        toolCallId: 'tc' as never,
        turnId: 'tn' as never,
        stepId: 'st' as never,
        appliedAt: Date.now(),
      });

      const result = await ws.kernel.control.execute('/undo');
      assert.equal(result.ok, false);
      // The *policy engine* refuses first, at the access the tool declared, which
      // is stronger than the tool's own check: the undo never reaches the point
      // of reading the file. The tool's `checkWritable` remains as the answer for
      // a path a profile merely narrows rather than hard-denies.
      assert.match(result.message, /PROTECTED_PATH|is now a protected path/);
      assert.equal(await readFile(target, 'utf8'), 'SECRET=2\n');
    } finally {
      await ws.cleanup();
    }
  });
});
