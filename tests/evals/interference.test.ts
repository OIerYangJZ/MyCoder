/**
 * The fixture seam that produces its own condition (alpha.11 §10, CLOSURE D).
 *
 * alpha.10 §17 reported "0/9 attempts called Undo" from two tasks that never
 * put either model in difficulty — the workspace changed only when the model
 * scheduled it, so a competent model read afterwards and nothing was ever
 * refused. A null result from a fixture that could not have produced anything
 * else is not a measurement.
 *
 * This file asserts the two things that make the rebuilt fixture worth running:
 *
 *   1. the difficulty **happens** — a file changes between the read and the
 *      edit, and the edit is refused as stale;
 *   2. the seam that does it is **harness-only** and cannot be reached from a
 *      session or from the shipped package.
 *
 * The negative control is the important one: without the seam, the same
 * trajectory produces no refusal at all, which is precisely what alpha.10
 * measured and mistook for a result.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { createTestWorkspace, receiptFromContext } from '../helpers/workspace.ts';
import {
  installReadInterference,
  INTERFERED_TOOLS,
  STALE_REFUSAL_CODE,
} from '../../evals/experiments/interference.ts';
import { undoUtilityTasks } from '../../evals/experiments/undo-utility-fixtures.ts';
import type { FakeStep } from '../../src/model/adapters/fake.ts';

const ROOT = new URL('../../', import.meta.url);
const FILE = 'src/config.ts';
const ORIGINAL = 'export const retries = 1;\n';

const readStep: FakeStep = { kind: 'tools', calls: [{ name: 'Read', arguments: { path: FILE } }] };

/**
 * An edit built at the moment the step is taken, not before it.
 *
 * The receipt only exists once the Read has run, so resolving it up front would
 * send `missing-receipt` and the call would be refused for the wrong reason —
 * which looks exactly like the difficulty landing and is not it.
 */
const editStep = (kernel: () => Parameters<typeof receiptFromContext>[0], oldString: string): FakeStep => ({
  kind: 'tools',
  calls: [
    {
      name: 'Edit',
      arguments: {
        mode: 'replace',
        path: FILE,
        oldString,
        newString: 'export const retries = 5;',
        receiptId: receiptFromContext(kernel(), FILE) ?? 'missing-receipt',
      },
    },
  ],
});

describe('the difficulty actually occurs', () => {
  test('a file changes between the read and the edit, and the edit is refused', async () => {
    const ws = await createTestWorkspace({
      files: { [FILE]: ORIGINAL },
      approvals: [{ decision: 'allow', scope: 'session' }],
      responder: (_request, index) =>
        index === 0
          ? readStep
          : index === 1
            ? editStep(() => ws.kernel, 'export const retries = 1;')
            : { kind: 'final', text: 'done' },
    });

    const log = installReadInterference(ws.kernel, {
      target: FILE,
      becomes: (firing) => `export const retries = ${1 + firing};\n`,
    });

    await ws.kernel.session.runTurn('Set retries to 5.');

    assert.equal(log.fired, 1, 'the file was never changed underneath the model');
    assert.ok(log.observedStaleRefusal, 'nothing was refused as stale, so there was no difficulty');
    assert.equal(await ws.file(FILE), 'export const retries = 2;\n', 'the edit should not have applied');
  });

  test('NEGATIVE CONTROL: without the seam, nothing is refused', async () => {
    // This is alpha.10's condition, and it is why its result was empty. The
    // same trajectory, the same task, no interference — and no refusal, so a
    // count of zero Undo calls would have meant nothing.
    const ws = await createTestWorkspace({
      files: { [FILE]: ORIGINAL },
      approvals: [{ decision: 'allow', scope: 'session' }],
      responder: (_request, index) =>
        index === 0
          ? readStep
          : index === 1
            ? editStep(() => ws.kernel, 'export const retries = 1;')
            : { kind: 'final', text: 'done' },
    });

    await ws.kernel.session.runTurn('Set retries to 5.');

    assert.equal(await ws.file(FILE), 'export const retries = 5;\n', 'the edit should have applied cleanly');
  });

  test('the seam disarms once the difficulty has landed, so the task stays solvable', async () => {
    // Firing forever would make the task impossible, which measures the task.
    // Firing exactly once would be defeated by a model that reads twice before
    // editing — and would produce the same empty result all over again.
    const ws = await createTestWorkspace({
      files: { [FILE]: ORIGINAL },
      approvals: [{ decision: 'allow', scope: 'session' }],
      responder: (_request, index) =>
        index <= 1
          ? readStep
          : index === 2
            ? editStep(() => ws.kernel, 'export const retries = 2;')
            : { kind: 'final', text: 'done' },
    });

    const log = installReadInterference(ws.kernel, {
      target: FILE,
      becomes: (firing) => `export const retries = ${1 + firing};\n`,
    });

    await ws.kernel.session.runTurn('Set retries to 9.');

    assert.equal(log.fired, 2, 'a second read must also be trapped, or a double-read defeats the fixture');
    assert.notEqual(
      await ws.file(FILE),
      'export const retries = 2;\n',
      'consecutive firings must write different bytes, or the second read is not stale',
    );
  });

  test('the refusal code the seam watches for is the one the kernel emits', async () => {
    // A string that was right when it was written is not an assertion.
    const codes = await readFile(new URL('src/util/errors.ts', ROOT), 'utf8');
    assert.match(codes, new RegExp(`'${STALE_REFUSAL_CODE}'`));
  });
});

describe('the fixture asserts its own condition', () => {
  test('the interference task carries a check that fails when the difficulty does not happen', () => {
    const task = undoUtilityTasks().find((t) => t.baseId === 'recover-from-a-file-that-changed-underneath');
    assert.ok(task, 'the rebuilt task is missing');
    assert.ok(
      task.checks.some((c) => /refused for it/.test(c.name)),
      'the task does not assert that the difficulty occurred, which is the alpha.10 defect',
    );
  });

  test('the fixture version was bumped, so alpha.10 numbers are not compared with these', () => {
    for (const task of undoUtilityTasks()) {
      assert.equal(task.fixtureVersion, 2, `${task.id} still claims fixture 1`);
    }
  });

  test('the task no longer hands the model a script that changes the workspace', () => {
    // The alpha.10 flaw, as a regression: the model must not be the thing that
    // causes the difficulty, or it can simply sequence around it.
    const task = undoUtilityTasks().find((t) => t.baseId === 'recover-from-a-file-that-changed-underneath');
    assert.ok(task);
    assert.deepEqual(Object.keys(task.files), [FILE]);
    assert.doesNotMatch(task.livePrompt ?? '', /script|bump|run `sh/i);
  });
});

describe('the seam is a harness capability and not a product one', () => {
  test('nothing under src/ or bin/ references it', async () => {
    // §10: "a test-harness capability, not a product one, and it must not be
    // reachable from a session".
    const { readdir } = await import('node:fs/promises');
    const hits: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(new URL(`${dir}/`, ROOT), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) await walk(rel);
        else if (/\.(ts|mjs|js)$/.test(entry.name)) {
          const text = await readFile(new URL(rel, ROOT), 'utf8');
          if (text.includes('interference')) hits.push(rel);
        }
      }
    };

    await walk('src');
    await walk('bin');
    assert.deepEqual(hits, [], 'the interference seam is reachable from the product');
  });

  test('the evals directory is not in the published package', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8')) as { files: string[] };
    assert.ok(!pkg.files.some((f) => f.startsWith('evals')), 'evals/ is packed, so the seam ships to users');
  });

  test('it decorates existing tools rather than registering a new one', () => {
    // The Capability Creep Stop: alpha.11 adds no tool. Every name the seam
    // touches is one the kernel already had.
    const builtins = new Set(['Read', 'Edit', 'Write', 'Delete', 'Move']);
    for (const name of INTERFERED_TOOLS) {
      assert.ok(builtins.has(name), `${name} is not an existing builtin`);
    }
  });

  test('it lives outside the source tree', () => {
    const url = new URL('evals/experiments/interference.ts', ROOT);
    assert.ok(!url.pathname.includes(`${path.sep}src${path.sep}`));
  });
});
