/**
 * M2 hardening gaps (next-phase plan §4.3 and §4.4).
 *
 * The trajectory suite already covers stale edits, coverage, uniqueness, CRLF
 * and atomic write. What was missing is here:
 *
 *   §4.3  cancellation *during the model stream*, not just during a tool
 *   §4.4  the recorded diff agreeing with the bytes actually on disk
 *   §4.4  a receipt expiring the moment the file it describes changes
 *   §4.6  a shell mutation producing an audit fact, not a silent change
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { createTestWorkspace } from '../helpers/workspace.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import { unifiedDiff } from '../../src/edit/diff.ts';
import type { Kernel } from '../../src/kernel.ts';

function setScript(kernel: Kernel, script: FakeStep[], opts: { chunkDelayMs?: number } = {}): void {
  const routed = kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
  routed.routes.set(
    'fake',
    new FakeModel({
      script,
      ...(opts.chunkDelayMs ? { chunkDelayMs: opts.chunkDelayMs, chunkSize: 4 } : {}),
    }),
  );
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

describe('§4.3 cancellation during the model stream', () => {
  test('cancelling while sampling ends the turn as cancelled and runs no tool', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
    try {
      // A slow stream that would end in a tool call. Cancelling mid-stream must
      // stop before the tool runs — "the model asked for it" is not a reason to
      // run something the user just cancelled.
      setScript(
        ws.kernel,
        [
          {
            kind: 'tools',
            text: 'thinking about this at some length so the stream stays open',
            calls: [
              { name: 'Edit', arguments: { mode: 'create', path: 'should-not-exist.ts', content: 'x\n' } },
            ],
          },
          { kind: 'final', text: 'unreachable' },
        ],
        { chunkDelayMs: 12 },
      );

      const running = ws.kernel.session.runTurn('start something slow');
      await new Promise((r) => setTimeout(r, 40));
      const cancelled = ws.kernel.session.cancel();
      assert.equal(cancelled, true, 'cancel() should report that it acted');

      const outcome = await running;

      assert.equal(outcome.turn.state, 'cancelled');
      assert.deepEqual(ws.kernel.context.openToolCalls(), [], 'every issued call must still be answered');

      // The file the cancelled tool call would have created must not exist.
      await assert.rejects(
        () => ws.file('should-not-exist.ts'),
        'a cancelled tool call must not take effect',
      );
      assert.deepEqual(ws.kernel.editJournal.dirtyPaths(), []);
    } finally {
      await ws.cleanup();
    }
  });

  test('a turn cancelled before it starts sampling still terminates cleanly', async () => {
    const ws = await createTestWorkspace({ files: {}, script: [{ kind: 'final', text: 'ok' }] });
    try {
      const running = ws.kernel.session.runTurn('go');
      ws.kernel.session.cancel();
      const outcome = await running;

      assert.ok(['cancelled', 'completed'].includes(outcome.turn.state));
      assert.deepEqual(ws.kernel.context.openToolCalls(), []);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('§4.4 the recorded diff matches the bytes on disk', () => {
  test('applying the journal diff reproduces the file', async () => {
    const original = 'line one\nline two\nline three\n';
    const ws = await createTestWorkspace({
      files: { 'src/f.ts': original },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/f.ts' } }] },
        { kind: 'final', text: 'read' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read');
      const receipt = ws.kernel.freshness.list()[0]!.receiptId;

      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: {
                mode: 'replace',
                path: 'src/f.ts',
                oldString: 'line two',
                newString: 'line 2 changed',
                receiptId: receipt,
              },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit');

      const onDisk = await ws.file('src/f.ts');
      const entry = ws.kernel.editJournal.all().at(-1)!;

      // The hash the journal recorded must be the hash of what is actually there.
      const actualHash = createHash('sha256').update(onDisk).digest('hex');
      assert.equal(entry.newHash, actualHash, 'the recorded newHash must match the bytes on disk');

      // And the recorded diff must be the diff between old and new content —
      // regenerating it from the two states has to produce the same thing.
      const regenerated = unifiedDiff(original, onDisk, {
        oldLabel: `a/${path.join('src', 'f.ts')}`,
        newLabel: `b/${path.join('src', 'f.ts')}`,
      });
      assert.equal(entry.diff, regenerated.text, 'the journal diff must describe the change that was made');
      assert.match(entry.diff, /-line two/);
      assert.match(entry.diff, /\+line 2 changed/);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('§4.4 receipts expire when the file changes', () => {
  test('the receipt used by an edit no longer works afterwards', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/g.ts': 'const v = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/g.ts' } }] },
        { kind: 'final', text: 'read' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read');
      const firstReceipt = ws.kernel.freshness.list()[0]!.receiptId;

      const editWith = (receiptId: string, oldString: string, newString: string): FakeStep => ({
        kind: 'tools',
        calls: [
          {
            name: 'Edit',
            arguments: { mode: 'replace', path: 'src/g.ts', oldString, newString, receiptId },
          },
        ],
      });

      setScript(ws.kernel, [
        editWith(firstReceipt, 'const v = 1', 'const v = 2'),
        { kind: 'final', text: 'ok' },
      ]);
      await ws.kernel.session.runTurn('first edit');
      assert.equal(await ws.file('src/g.ts'), 'const v = 2;\n');

      // Reusing the same receipt must fail: it describes content that is gone.
      setScript(ws.kernel, [
        editWith(firstReceipt, 'const v = 2', 'const v = 3'),
        { kind: 'final', text: 'tried' },
      ]);
      await ws.kernel.session.runTurn('reuse the stale receipt');

      const results = toolResults(ws.kernel);
      assert.ok(
        results.some((r) => r.includes('STALE_FILE')),
        `expected STALE_FILE when reusing a spent receipt, got:\n${results.slice(-2).join('\n---\n')}`,
      );
      assert.equal(await ws.file('src/g.ts'), 'const v = 2;\n', 'the file must be unchanged');
    } finally {
      await ws.cleanup();
    }
  });

  test('re-reading produces a fresh receipt that works', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/h.ts': 'const v = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/h.ts' } }] },
        { kind: 'final', text: 'read' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read');
      const first = ws.kernel.freshness.list()[0]!.receiptId;

      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/h.ts' } }] },
        { kind: 'final', text: 'read again' },
      ]);
      await ws.kernel.session.runTurn('read again');

      const receipts = ws.kernel.freshness.list();
      const second = receipts[0]!.receiptId;
      assert.notEqual(second, first, 'a re-read must mint a new receipt');

      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: {
                mode: 'replace',
                path: 'src/h.ts',
                oldString: 'const v = 1',
                newString: 'const v = 9',
                receiptId: second,
              },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('edit with the fresh receipt');

      assert.equal(await ws.file('src/h.ts'), 'const v = 9;\n');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('§4.6 shell mutations are audited, never silent', () => {
  test('a source file rewritten by a shell command is reported and logged', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/i.ts': 'export const i = 1;\n' },
      script: [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Shell',
              arguments: { argv: ['sh', '-c', 'printf "export const i = 2;\\n" > src/i.ts'] },
            },
          ],
        },
        { kind: 'final', text: 'ran' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('rewrite a source file from the shell');

      // (a) the model is told, in the tool result
      const results = toolResults(ws.kernel);
      const shellResult = results.at(-1) ?? '';
      assert.match(shellResult, /changed 1 file|changed \d+ file/i);
      assert.match(shellResult, /src[/\\]i\.ts/);
      assert.match(shellResult, /Warning: 1 source\/test\/config file/);

      // (b) the next step sees it as a context fact
      const facts = ws.kernel.context.listFacts();
      assert.ok(
        facts.some((f) => /changed 1 source\/test\/config file/.test(f.text)),
        'the mutation should be projected as a fact for the next step',
      );

      // (c) it is in the audit log
      const log = await ws.eventLogText();
      assert.match(log, /workspace\.mutation/);
      assert.match(log, /"undeclared":true/);

      assert.equal(await ws.file('src/i.ts'), 'export const i = 2;\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('writing only to a declared generated path is not flagged', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/j.ts': 'export const j = 1;\n' },
      script: [
        {
          kind: 'tools',
          calls: [
            { name: 'Shell', arguments: { argv: ['sh', '-c', 'mkdir -p dist && echo built > dist/out.js'] } },
          ],
        },
        { kind: 'final', text: 'built' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('build');

      const shellResult = toolResults(ws.kernel).at(-1) ?? '';
      // The change is still reported — it is just not an undeclared mutation.
      assert.equal(/Warning: \d+ source\/test\/config file/.test(shellResult), false);

      const log = await ws.eventLogText();
      assert.equal(
        /"undeclared":true/.test(log),
        false,
        'a generated path is expected output, not a mutation',
      );
    } finally {
      await ws.cleanup();
    }
  });
});
