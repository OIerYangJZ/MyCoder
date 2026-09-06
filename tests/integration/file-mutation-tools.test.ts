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

describe('what the event log keeps of a call that is too big for it', () => {
  test('the summary of a large Write is still JSON, and still names the file', async () => {
    // `summarizeArgs` used to be `JSON.stringify(args).slice(0, 400)`, which is a
    // JSON *prefix* — an object with the closing brace missing. Two readers parse
    // this field and both broke on it:
    //
    //   the renderer's `summariseArgs`, which picks the one interesting argument
    //   for the tool line and on a parse failure printed the raw prefix — for a
    //   `Write` that is the beginning of the file's contents, so the line showed a
    //   wall of source and never the path;
    //
    //   `replaySession`, which reconstructs the assistant's tool call and on a
    //   parse failure produced `{ __summary: '<prefix>' }`, a shape no tool schema
    //   accepts.
    //
    // Measured against a real model on a real task: 29 of 45 calls exceeded the
    // budget, so this was the common case rather than the edge.
    const ws = await createTestWorkspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
    try {
      const big = `export const big = ${JSON.stringify('x'.repeat(4000))};\n`;
      setScript(ws.kernel, [
        { kind: 'tools', calls: [{ name: 'Write', arguments: { path: 'src/big.ts', content: big } }] },
        { kind: 'final', text: 'written' },
      ]);
      await ws.kernel.session.runTurn('write it');

      let summary: string | undefined;
      for await (const event of ws.kernel.store.readEvents(ws.kernel.sessionId)) {
        if (event.type !== 'tool.call') continue;
        const payload = event.payload as { name?: string; argsSummary?: string };
        if (payload.name === 'Write') summary = payload.argsSummary;
      }

      assert.ok(summary !== undefined, 'the call was never logged');
      const parsed = JSON.parse(summary) as { path?: string; content?: string };
      assert.equal(parsed.path, 'src/big.ts', 'the path is what the tool line is read for');
      assert.ok(summary.length <= 512, `the summary is unbounded: ${summary.length} characters`);
      assert.ok(
        (parsed.content ?? '').length < big.length,
        'the budget has to come out of the value, or nothing was saved',
      );
      // And the file itself is whole: only the *summary* is shortened.
      assert.equal(await ws.file('src/big.ts'), big);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('what a refusal tells the person watching', () => {
  test('the kernel says why on the event, and not one word of it reaches the log', async () => {
    // The asymmetry this closes: the *model* was told `$.limit is not an allowed
    // property (expected one of: path, offsetLine, limitLines)` and the person
    // supervising was told `TOOL_INVALID_ARGS`. The detail went to the party
    // that could act on it; the code went to the party watching.
    //
    // It is ephemeral for the same reason `preview` is, and a different one: it
    // carries no tool output, so it is not a leak — but it is a rendering of an
    // `errorCode` the record already has, and a log holding both holds one fact
    // twice, in two formats, one of which is prose that can drift.
    const captureEvents: Array<{ type: string; payload: unknown }> = [];
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'export const a = 1;\n' },
      captureEvents,
    });
    try {
      setScript(ws.kernel, [
        // `limit` is not a property of Read; `limitLines` is. A real model made
        // exactly this mistake, twice.
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts', limit: 20 } }] },
        { kind: 'final', text: 'tried' },
      ]);
      await ws.kernel.session.runTurn('read it');

      // What the host — the terminal — was handed.
      const live = captureEvents
        .filter((e) => e.type === 'tool.result')
        .map((e) => e.payload as Record<string, unknown>);
      assert.equal(live.length, 1, `expected one tool result, saw ${live.length}`);
      assert.equal(live[0]?.errorCode, 'TOOL_INVALID_ARGS');
      assert.match(
        String(live[0]?.safeMessage),
        /\$\.limit is not an allowed property/,
        'the person watching was told only the code',
      );

      // And what the record kept.
      let records = 0;
      for await (const event of ws.kernel.store.readEvents(ws.kernel.sessionId)) {
        if (event.type !== 'tool.result') continue;
        records += 1;
        const payload = event.payload as Record<string, unknown>;
        assert.equal(payload.errorCode, 'TOOL_INVALID_ARGS', 'the code is what the record keeps');
        assert.equal(payload.safeMessage, undefined, 'the prose was written to disk');
      }
      assert.equal(records, 1, 'no tool result was recorded at all');
    } finally {
      await ws.cleanup();
    }
  });
});
