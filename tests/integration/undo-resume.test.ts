/**
 * Undo across a restart — ADR-0025 §6, and the §16 rows a live session cannot
 * reach.
 *
 * Until alpha.10 the journal was a private array that died with the process, so
 * the one capability that repairs a mistake was unavailable in exactly the
 * situation that produces the worst ones. These suites drive a real kernel,
 * shut it down, boot a second one over the same store, and ask it to reverse
 * what the first did.
 *
 * They also hold the correction the live matrix produced. The §9 audit predicted
 * that a redacted diff makes an edit irreversible; that is true of the **durable**
 * journal and not of the in-memory one, because `store.ts` redacts on the way
 * into the log and the running process still holds the real diff. So the same
 * edit is reversible before a restart and refused after one — which is a
 * sharper statement than the ADR first made, and the reason it is stated here
 * with a test rather than in prose.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createKernel, type Kernel } from '../../src/kernel.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import { FileSessionStore } from '../../src/session/store.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { ScriptedPrompter } from '../../src/cli/prompter.ts';
import { CANARY } from '../helpers/workspace.ts';

const ALLOW = Array.from({ length: 20 }, () => ({ decision: 'allow' as const, scope: 'once' as const }));

interface Fixture {
  base: string;
  root: string;
  store: FileSessionStore;
  /**
   * The store's redactor, shared across both boots.
   *
   * In the product this is the *kernel's* redactor — `createKernel` hands it to
   * the store it builds. A test that injects a store has to reproduce that link
   * by hand, or it measures a log that redacts nothing and concludes the wrong
   * thing about what survives a restart.
   */
  redactor: Redactor;
  boot(resumeSessionId?: string): Promise<Kernel>;
  file(rel: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function fixture(files: Record<string, string>): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'undo-resume-'));
  const root = path.join(base, 'workspace');
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  const redactor = new Redactor();
  const store = new FileSessionStore({ rootDir: path.join(base, 'sessions'), redactor });

  return {
    base,
    root,
    store,
    redactor,
    boot: (resumeSessionId?: string) =>
      createKernel({
        workspaceDir: root,
        dirsRoot: path.join(base, 'kernel-dirs'),
        store,
        fakeModel: new FakeModel({ script: [{ kind: 'final', text: 'ok' }] }),
        prompter: new ScriptedPrompter(ALLOW),
        logLevel: 'silent',
        ...(resumeSessionId ? { resumeSessionId } : {}),
      }),
    file: (rel: string) => readFile(path.join(root, rel), 'utf8'),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

function setScript(kernel: Kernel, script: FakeStep[]): void {
  const routed = kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
  routed.routes.set('fake', new FakeModel({ script }));
}

async function readReceipt(kernel: Kernel, file: string): Promise<string> {
  setScript(kernel, [
    { kind: 'tools', calls: [{ name: 'Read', arguments: { path: file } }] },
    { kind: 'final', text: 'read' },
  ]);
  await kernel.session.runTurn(`read ${file}`);
  return (
    kernel.freshness.list().find((r) => r.path.endsWith(file.split('/').at(-1)!))?.receiptId ?? 'missing'
  );
}

describe('a session resumed from the log can undo', () => {
  test('a replace made by the previous process is reversed by the next one', async () => {
    const fx = await fixture({ 'a.ts': 'one\ntwo\n' });
    let kernel = await fx.boot();
    const sessionId = kernel.sessionId;
    try {
      const receiptId = await readReceipt(kernel, 'a.ts');
      setScript(kernel, [
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
      await kernel.session.runTurn('edit');
      assert.equal(await fx.file('a.ts'), 'ONE\ntwo\n');
      await kernel.shutdown();

      // A new process. The in-memory journal is gone; the log is not.
      kernel = await fx.boot(sessionId);
      assert.equal(kernel.editJournal.size, 1, 'the journal is rebuilt from file.edited');

      const result = await kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.equal(await fx.file('a.ts'), 'one\ntwo\n');
    } finally {
      await kernel.shutdown().catch(() => {});
      await fx.cleanup();
    }
  });

  test('a deletion made by the previous process is restored byte-for-byte', async () => {
    const fx = await fixture({ 'gone.ts': 'keep\nthis\n' });
    let kernel = await fx.boot();
    const sessionId = kernel.sessionId;
    try {
      const receiptId = await readReceipt(kernel, 'gone.ts');
      setScript(kernel, [
        { kind: 'tools', calls: [{ name: 'Delete', arguments: { path: 'gone.ts', receiptId } }] },
        { kind: 'final', text: 'deleted' },
      ]);
      await kernel.session.runTurn('delete');
      await kernel.shutdown();

      kernel = await fx.boot(sessionId);
      const result = await kernel.control.execute('/undo');
      assert.equal(result.ok, true, result.message);
      assert.equal(await fx.file('gone.ts'), 'keep\nthis\n');
    } finally {
      await kernel.shutdown().catch(() => {});
      await fx.cleanup();
    }
  });

  test('the resumed undo states that the journal has a boundary', async () => {
    const fx = await fixture({ 'a.ts': 'one\n' });
    let kernel = await fx.boot();
    const sessionId = kernel.sessionId;
    try {
      const receiptId = await readReceipt(kernel, 'a.ts');
      setScript(kernel, [
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
      await kernel.session.runTurn('edit');
      await kernel.shutdown();

      kernel = await fx.boot(sessionId);
      const result = await kernel.control.execute('/undo');
      assert.match(result.message, /rebuilt from the event log and begins at/);
    } finally {
      await kernel.shutdown().catch(() => {});
      await fx.cleanup();
    }
  });

  /**
   * The correction to ADR-0025 §3, held as a pair.
   *
   * Same edit, same file, same secret. Before a restart the running process
   * still holds the unredacted diff and the reversal is exact. After a restart
   * the only copy is the log's, which stores `[REDACTED:secret/<fp>]`, and the
   * reversal is refused — because writing the placeholder back would corrupt the
   * file while reporting success.
   */
  test('a redacted diff is reversible in-process and refused after a restart', async () => {
    // The suite's registered canary rather than a credential-shaped literal:
    // the redactor matches registered values exactly, so the shape is irrelevant
    // to what is under test, and a fixture that looks like a real key is a
    // fixture someone eventually reports as a leak.
    const secret = CANARY;
    const fx = await fixture({ 'cfg.ts': `const key = "${secret}";\nconst port = 1;\n` });
    let kernel = await fx.boot();
    const sessionId = kernel.sessionId;
    try {
      fx.redactor.addLiteral(secret);
      kernel.redactor.addLiteral(secret);
      const receiptId = await readReceipt(kernel, 'cfg.ts');
      const rewrite: FakeStep[] = [
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
      ];
      setScript(kernel, rewrite);
      await kernel.session.runTurn('rewrite');

      // In-process: the journal holds the real diff, so this is exact.
      const live = await kernel.control.execute('/undo');
      assert.equal(live.ok, true, live.message);
      assert.equal(await fx.file('cfg.ts'), `const key = "${secret}";\nconst port = 1;\n`);

      // Do it again, so there is an unreversed edit to carry across the restart.
      const receipt2 = await readReceipt(kernel, 'cfg.ts');
      setScript(kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Write',
              arguments: {
                path: 'cfg.ts',
                content: 'const key = process.env.KEY;\nconst port = 2;\n',
                receiptId: receipt2,
              },
            },
          ],
        },
        { kind: 'final', text: 'rewrote again' },
      ]);
      await kernel.session.runTurn('rewrite again');
      await kernel.shutdown();

      // After the restart the log is the only copy, and the log is redacted.
      kernel = await fx.boot(sessionId);
      const resumed = await kernel.control.execute('/undo');
      assert.equal(resumed.ok, false, resumed.message);
      assert.match(resumed.message, /redacted credential/);
      // Nothing was written, and in particular no placeholder reached the file.
      const after = await fx.file('cfg.ts');
      assert.equal(after, 'const key = process.env.KEY;\nconst port = 2;\n');
      assert.doesNotMatch(after, /REDACTED/);
    } finally {
      await kernel.shutdown().catch(() => {});
      await fx.cleanup();
    }
  });

  test('an edit recorded by a kernel older than alpha.10 is listed and refused', async () => {
    const fx = await fixture({ 'a.ts': 'current\n' });
    let kernel = await fx.boot();
    const sessionId = kernel.sessionId;
    try {
      await kernel.session.runTurn('nothing');
      // The pre-alpha.10 payload shape: no entryId, no kind, no finalNewline.
      await fx.store.append(sessionId, {
        type: 'file.edited',
        payload: {
          path: 'a.ts',
          toolCallId: 'tc_old',
          oldHash: 'deadbeef',
          newHash: 'cafebabe',
          diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-before\n+current\n',
          linesAdded: 1,
          linesRemoved: 1,
          eol: 'lf',
          created: false,
        },
      });
      await kernel.shutdown();

      kernel = await fx.boot(sessionId);
      // Listed, because a user asking what happened to their workspace is owed
      // the older edits too.
      const listed = await kernel.control.execute('/undo list');
      assert.match(listed.message, /a\.ts/);

      const result = await kernel.control.execute('/undo');
      assert.equal(result.ok, false);
      assert.match(result.message, /older than alpha\.10/);
      assert.match(result.message, /\[legacy\]/);
      assert.equal(await fx.file('a.ts'), 'current\n');
    } finally {
      await kernel.shutdown().catch(() => {});
      await fx.cleanup();
    }
  });

  test('an entry whose diff exceeded the size ceiling is refused, naming the ceiling', async () => {
    const fx = await fixture({ 'a.ts': 'x\n' });
    const kernel = await fx.boot();
    try {
      const { newJournalEntryId, sha256Hex } = await import('../../src/util/ids.ts');
      kernel.editJournal.record({
        entryId: newJournalEntryId(Date.now()),
        path: path.join(fx.root, 'a.ts') as never,
        displayPath: 'a.ts',
        kind: 'overwrite',
        oldHash: sha256Hex('big\n'),
        newHash: sha256Hex('x\n'),
        diff: '',
        diffOmitted: 4 * 1024 * 1024,
        eol: 'lf',
        finalNewline: true,
        createdFile: false,
        toolCallId: 'tc' as never,
        turnId: 'tn' as never,
        stepId: 'st' as never,
        appliedAt: Date.now(),
      });

      const result = await kernel.control.execute('/undo');
      assert.equal(result.ok, false);
      assert.match(result.message, /exceeded the journal ceiling/);
      assert.match(result.message, /\[diff-omitted\]/);
      assert.equal(await fx.file('a.ts'), 'x\n');
    } finally {
      await kernel.shutdown().catch(() => {});
      await fx.cleanup();
    }
  });
});
