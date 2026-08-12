/**
 * The vertical slice from spec §31, plus the acceptance criteria in §28.
 *
 * Everything here runs fully offline against FakeModel:
 *
 *   Grep → Read → Edit → Shell(fails) → Read → Edit → Shell(passes) → final
 *
 * If this passes, the kernel has a skeleton: the state machine, the freshness
 * ledger, atomic edits, the executor and the event log all agree with each
 * other. §31's point is that hooking up a real provider before this works only
 * hides state-machine bugs behind model behaviour.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import { createKernel, type Kernel } from '../../src/kernel.ts';
import { LocalExecutionBackend } from '../../src/execution/local.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { Turn } from '../../src/session/turn.ts';
import { FailureTracker, LoopBudgetTracker, DEFAULT_LOOP_BUDGET } from '../../src/session/step.ts';
import { compact } from '../../src/context/compaction.ts';
import type { ModelMessage } from '../../src/model/ir.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

const BUGGY = `export function add(a: number, b: number): number {
  return a - b;
}
`;

const TEST_CMD = ['sh', '-c', 'grep -q "return a + b;" src/math.ts'];

/**
 * The scripted trajectory.
 *
 * A responder rather than a fixed array, because steps 3 and 6 need the
 * receiptId that step 2 and 5 produced — which is exactly what a real model does
 * by reading it out of the Read result.
 */
function trajectory(holder: { kernel?: Kernel }): (index: number) => FakeStep {
  return (index: number): FakeStep => {
    const receipt = (): string => {
      const receipts = holder.kernel?.freshness.list() ?? [];
      return receipts.find((r) => r.path.endsWith('math.ts'))?.receiptId ?? 'missing';
    };

    switch (index) {
      case 0:
        return { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'function add' } }] };
      case 1:
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/math.ts' } }] };
      case 2:
        // A plausible but wrong fix, so step 4 genuinely fails.
        return {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: {
                mode: 'replace',
                path: 'src/math.ts',
                oldString: 'return a - b;',
                newString: 'return a * b;',
                receiptId: receipt(),
              },
            },
          ],
        };
      case 3:
        return { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: TEST_CMD } }] };
      case 4:
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/math.ts' } }] };
      case 5:
        return {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: {
                mode: 'replace',
                path: 'src/math.ts',
                oldString: 'return a * b;',
                newString: 'return a + b;',
                receiptId: receipt(),
              },
            },
          ],
        };
      case 6:
        return { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: TEST_CMD } }] };
      default:
        return { kind: 'final', text: 'Fixed add() to return a + b; the check now passes.' };
    }
  };
}

async function runTrajectory(): Promise<{ ws: TestWorkspace; kernel: Kernel }> {
  const holder: { kernel?: Kernel } = {};
  const ws = await createTestWorkspace({
    files: { 'src/math.ts': BUGGY },
  });
  holder.kernel = ws.kernel;

  // Swap in a responder-driven model now that the kernel exists.
  const responder = trajectory(holder);
  const model = new FakeModel({ responder: (_req, index) => responder(index) });
  Object.assign(ws.kernel.session as unknown as { opts: { modelRuntime: unknown } }, {});
  (ws as { fakeModel: FakeModel }).fakeModel = model;

  // The session captured the runtime at construction, so route through it.
  const routed = ws.kernel.modelRuntime as unknown as {
    routes: Map<string, unknown>;
  };
  routed.routes.set('fake', model);

  await ws.kernel.session.runTurn('Fix the add function so the check passes.');
  return { ws, kernel: ws.kernel };
}

describe('§31 vertical slice: the offline trajectory', () => {
  test('runs eight steps and leaves the file correct', async () => {
    const { ws, kernel } = await runTrajectory();
    try {
      const turn = kernel.session.turn!;
      assert.equal(turn.state, 'completed', `turn ended as ${turn.state}: ${turn.error?.message ?? ''}`);

      // The file is actually fixed on disk, not just claimed to be.
      const content = await ws.file('src/math.ts');
      assert.match(content, /return a \+ b;/);

      // Every stage of the trajectory really happened.
      const results = toolResults(kernel.context.history());
      assert.ok(
        results.some((r) => /match\(es\) for/.test(r)),
        'Grep ran',
      );
      assert.ok(
        results.some((r) => /receiptId:/.test(r)),
        'Read produced a receipt',
      );
      assert.ok(
        results.some((r) => /Updated .*math\.ts/.test(r)),
        'Edit applied',
      );
      assert.ok(
        results.some((r) => /exit 1/.test(r)),
        'the first verification failed',
      );
      assert.ok(
        results.some((r) => /exit 0/.test(r)),
        'the second verification passed',
      );
      assert.match(turn.finalText ?? '', /a \+ b/);
    } finally {
      await ws.cleanup();
    }
  });

  test('every tool call has a matching result (invariant 1)', async () => {
    const { ws, kernel } = await runTrajectory();
    try {
      assert.deepEqual(kernel.context.openToolCalls(), [], 'no tool call may be left unanswered');

      // And the same holds in the persisted log.
      const calls = new Set<string>();
      const results = new Set<string>();
      for await (const event of kernel.store.readEvents(kernel.sessionId)) {
        const payload = event.payload as { toolCallId?: string };
        if (event.type === 'tool.call' && payload.toolCallId) calls.add(payload.toolCallId);
        if ((event.type === 'tool.result' || event.type === 'tool.synthetic_result') && payload.toolCallId) {
          results.add(payload.toolCallId);
        }
      }
      assert.ok(calls.size >= 7, `expected at least 7 tool calls, saw ${calls.size}`);
      for (const id of calls) {
        assert.ok(results.has(id), `tool call ${id} has no result in the event log`);
      }
    } finally {
      await ws.cleanup();
    }
  });

  test('the turn transitions only through legal states (§5.2)', async () => {
    const { ws, kernel } = await runTrajectory();
    try {
      const transitions = kernel.session.turn!.transitions;
      const seen = transitions.map((t) => `${t.from}→${t.to}`);

      assert.equal(transitions[0]?.from, 'queued');
      assert.equal(transitions.at(-1)?.to, 'completed');

      // The three forbidden moves from §5.2.
      assert.equal(seen.includes('completed→sampling'), false);
      assert.equal(seen.includes('cancelled→executing_tools'), false);
      assert.ok(seen.filter((s) => s === 'sampling→executing_tools').length >= 7);
    } finally {
      await ws.cleanup();
    }
  });

  test('the event log is append-only with a contiguous sequence', async () => {
    const { ws, kernel } = await runTrajectory();
    try {
      let expected = 0;
      let count = 0;
      for await (const event of kernel.store.readEvents(kernel.sessionId)) {
        expected += 1;
        count += 1;
        assert.equal(event.seq, expected, 'sequence numbers must be contiguous');
        assert.equal(event.sessionId, kernel.sessionId);
        assert.ok(event.ts > 0);
      }
      assert.ok(count > 20, `expected a detailed log, saw ${count} events`);
    } finally {
      await ws.cleanup();
    }
  });

  test('the log records the edit with both hashes and a diff (invariant 4)', async () => {
    const { ws, kernel } = await runTrajectory();
    try {
      const journal = kernel.editJournal.all();
      assert.equal(journal.length, 2, 'two edits were applied');
      for (const entry of journal) {
        assert.notEqual(entry.oldHash, entry.newHash);
        assert.match(entry.diff, /@@/);
        assert.ok(entry.toolCallId, 'the edit is tied to a tool call');
        assert.ok(entry.turnId && entry.stepId);
      }
    } finally {
      await ws.cleanup();
    }
  });

  test('repeats without state leaking between runs', async (t) => {
    // §28 asks for 100 repetitions with no leakage. Each run gets a fresh
    // temp workspace, so a leak would show up as a wrong file, a reused
    // receipt, or an event log that is not identical in shape.
    //
    // The count is overridable so the cross-platform CI job can run a cheap
    // smoke pass while the dedicated determinism job runs the full 100. It
    // defaults to 100, so a plain `node --test` still satisfies §28.
    const REPEATS = parseRepeats(process.env.KERNEL_TRAJECTORY_REPEATS, 100);
    const shapes = new Set<string>();

    for (let i = 0; i < REPEATS; i += 1) {
      const { ws, kernel } = await runTrajectory();
      try {
        assert.equal(kernel.session.turn!.state, 'completed', `run ${i} did not complete`);
        assert.match(await ws.file('src/math.ts'), /return a \+ b;/, `run ${i} left the wrong content`);
        assert.deepEqual(kernel.context.openToolCalls(), [], `run ${i} left an open tool call`);

        const types: string[] = [];
        for await (const event of kernel.store.readEvents(kernel.sessionId)) types.push(event.type);
        shapes.add(types.join(','));
      } finally {
        await ws.cleanup();
      }
    }

    assert.equal(
      shapes.size,
      1,
      `the trajectory was not deterministic: ${shapes.size} distinct event shapes`,
    );
    t.diagnostic(`${REPEATS} repetitions produced one event shape`);
  });
});

describe('§28 context and edit criteria', () => {
  test('a stale edit is rejected', async () => {
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'const x = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'a.ts' } }] },
        { kind: 'final', text: 'read' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read the file');
      const receipt = ws.kernel.freshness.list()[0]!.receiptId;

      // Something else changes the file behind the model's back.
      await ws.write('a.ts', 'const x = 2;\n');

      const routed = ws.kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
      routed.routes.set(
        'fake',
        new FakeModel({
          script: [
            {
              kind: 'tools',
              calls: [
                {
                  name: 'Edit',
                  arguments: {
                    mode: 'replace',
                    path: 'a.ts',
                    oldString: 'const x = 1;',
                    newString: 'const x = 3;',
                    receiptId: receipt,
                  },
                },
              ],
            },
            { kind: 'final', text: 'tried' },
          ],
        }),
      );

      await ws.kernel.session.runTurn('now edit it');
      const results = toolResults(ws.kernel.context.history());
      assert.ok(
        results.some((r) => r.includes('STALE_FILE')),
        `expected STALE_FILE, got:\n${results.join('\n---\n')}`,
      );
      assert.equal(await ws.file('a.ts'), 'const x = 2;\n', 'the file must be untouched');
    } finally {
      await ws.cleanup();
    }
  });

  test('an edit outside the read window is rejected for insufficient coverage', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
    const ws = await createTestWorkspace({
      files: { 'big.ts': lines },
      script: [
        {
          kind: 'tools',
          calls: [{ name: 'Read', arguments: { path: 'big.ts', offsetLine: 1, limitLines: 10 } }],
        },
        { kind: 'final', text: 'read the top' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read the top of the file');
      const receipt = ws.kernel.freshness.list()[0]!.receiptId;

      const routed = ws.kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
      routed.routes.set(
        'fake',
        new FakeModel({
          script: [
            {
              kind: 'tools',
              calls: [
                {
                  name: 'Edit',
                  arguments: {
                    mode: 'replace',
                    path: 'big.ts',
                    // Line 90 — never shown to the model.
                    oldString: 'const v89 = 89;',
                    newString: 'const v89 = 999;',
                    receiptId: receipt,
                  },
                },
              ],
            },
            { kind: 'final', text: 'tried' },
          ],
        }),
      );

      await ws.kernel.session.runTurn('edit line 90');
      const results = toolResults(ws.kernel.context.history());
      assert.ok(
        results.some((r) => r.includes('INSUFFICIENT_READ_COVERAGE')),
        `expected INSUFFICIENT_READ_COVERAGE, got:\n${results.join('\n---\n')}`,
      );
      assert.equal(await ws.file('big.ts'), lines, 'the file must be untouched');
    } finally {
      await ws.cleanup();
    }
  });

  test('a non-unique match is rejected rather than guessed', async () => {
    const ws = await createTestWorkspace({
      files: { 'dup.ts': 'const a = 1;\nconst a = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'dup.ts' } }] },
        { kind: 'final', text: 'read' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read');
      const receipt = ws.kernel.freshness.list()[0]!.receiptId;

      const routed = ws.kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
      routed.routes.set(
        'fake',
        new FakeModel({
          script: [
            {
              kind: 'tools',
              calls: [
                {
                  name: 'Edit',
                  arguments: {
                    mode: 'replace',
                    path: 'dup.ts',
                    oldString: 'const a = 1;',
                    newString: 'const a = 2;',
                    receiptId: receipt,
                  },
                },
              ],
            },
            { kind: 'final', text: 'tried' },
          ],
        }),
      );

      await ws.kernel.session.runTurn('edit');
      const results = toolResults(ws.kernel.context.history());
      assert.ok(results.some((r) => r.includes('NON_UNIQUE_MATCH')));
    } finally {
      await ws.cleanup();
    }
  });

  test('a CRLF file stays CRLF after an edit', async () => {
    const ws = await createTestWorkspace({
      files: { 'win.ts': 'line one\r\nline two\r\nline three\r\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'win.ts' } }] },
        { kind: 'final', text: 'read' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read');
      const receipt = ws.kernel.freshness.list()[0]!.receiptId;

      const routed = ws.kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
      routed.routes.set(
        'fake',
        new FakeModel({
          script: [
            {
              kind: 'tools',
              calls: [
                {
                  name: 'Edit',
                  arguments: {
                    mode: 'replace',
                    path: 'win.ts',
                    oldString: 'line two',
                    newString: 'line 2',
                    receiptId: receipt,
                  },
                },
              ],
            },
            { kind: 'final', text: 'edited' },
          ],
        }),
      );

      await ws.kernel.session.runTurn('edit line two');
      const content = await ws.file('win.ts');

      assert.equal(content, 'line one\r\nline 2\r\nline three\r\n');
      assert.equal(content.includes('\n\n'), false);
      // A three-line edit must not rewrite the whole file's endings.
      assert.equal((content.match(/\r\n/g) ?? []).length, 3);
    } finally {
      await ws.cleanup();
    }
  });

  test('a failed atomic write leaves no partial file and no stray temp file', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'atomic-'));
    try {
      const backend = new LocalExecutionBackend({
        workspaceRoot: base as CanonicalPath,
        redactor: new Redactor(),
      });

      // Writing to a path whose parent does not exist fails; the invariant is
      // that nothing is left behind when it does.
      await assert.rejects(() =>
        backend.fs.writeFileAtomic(path.join(base, 'missing', 'file.txt') as CanonicalPath, Buffer.from('x')),
      );

      const entries = await readdir(base);
      assert.deepEqual(entries, [], `a temp file was left behind: ${entries.join(', ')}`);

      // And a successful write is durable and complete.
      const target = path.join(base, 'ok.txt') as CanonicalPath;
      await backend.fs.writeFileAtomic(target, Buffer.from('hello'));
      const s = await stat(target);
      assert.equal(s.size, 5);
      assert.deepEqual((await readdir(base)).sort(), ['ok.txt']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('a create is refused when the file already exists', async () => {
    const ws = await createTestWorkspace({
      files: { 'exists.ts': 'x\n' },
      script: [
        {
          kind: 'tools',
          calls: [{ name: 'Edit', arguments: { mode: 'create', path: 'exists.ts', content: 'y\n' } }],
        },
        { kind: 'final', text: 'tried' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('create it');
      const results = toolResults(ws.kernel.context.history());
      assert.ok(results.some((r) => /already exists/.test(r)));
      assert.equal(await ws.file('exists.ts'), 'x\n');
    } finally {
      await ws.cleanup();
    }
  });

  test('creating a new file works and records a diff', async () => {
    const ws = await createTestWorkspace({
      files: {},
      script: [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { mode: 'create', path: 'src/new.ts', content: 'export const a = 1;\n' },
            },
          ],
        },
        { kind: 'final', text: 'created' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('create a file');
      assert.equal(await ws.file('src/new.ts'), 'export const a = 1;\n');
      assert.equal(ws.kernel.editJournal.all()[0]?.createdFile, true);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('§28 loop control', () => {
  test('an unknown tool still produces a result', async () => {
    const ws = await createTestWorkspace({
      files: {},
      script: [
        { kind: 'tools', calls: [{ name: 'NotATool', arguments: {} }] },
        { kind: 'final', text: 'recovered' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('use a tool that does not exist');
      const results = toolResults(ws.kernel.context.history());
      assert.ok(results.some((r) => r.includes('TOOL_NOT_FOUND')));
      assert.deepEqual(ws.kernel.context.openToolCalls(), []);
      assert.equal(ws.kernel.session.turn!.state, 'completed');
    } finally {
      await ws.cleanup();
    }
  });

  test('malformed arguments produce TOOL_INVALID_ARGS, not a crash', async () => {
    const ws = await createTestWorkspace({
      files: {},
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { notAPath: 42 } }] },
        { kind: 'final', text: 'recovered' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read nothing');
      const results = toolResults(ws.kernel.context.history());
      assert.ok(results.some((r) => r.includes('TOOL_INVALID_ARGS')));
    } finally {
      await ws.cleanup();
    }
  });

  test('the doom-loop guard stops an identical repeated failure', async () => {
    const badCall = {
      kind: 'tools' as const,
      calls: [{ name: 'Read', arguments: { path: 'does-not-exist.ts' } }],
    };
    const ws = await createTestWorkspace({
      files: {},
      script: [badCall, badCall, badCall, badCall, badCall, { kind: 'final', text: 'never reached' }],
    });
    try {
      const outcome = await ws.kernel.session.runTurn('read a missing file forever');
      assert.equal(outcome.turn.state, 'failed');
      assert.equal(outcome.error?.code, 'REPEATED_FAILURE');
      assert.ok(ws.fakeModel.callCount < 6, 'the loop stopped before consuming the whole script');
    } finally {
      await ws.cleanup();
    }
  });

  test('the failure fingerprint ignores incidental detail', () => {
    const a = FailureTracker.fingerprint('Shell', { argv: ['x'] }, 'TOOL_FAILED', 'failed pid 1234 at 0xabc');
    const b = FailureTracker.fingerprint('Shell', { argv: ['x'] }, 'TOOL_FAILED', 'failed pid 9999 at 0xdef');
    const c = FailureTracker.fingerprint('Shell', { argv: ['y'] }, 'TOOL_FAILED', 'failed pid 1234 at 0xabc');
    assert.equal(a, b, 'same failure, different pid → same fingerprint');
    assert.notEqual(a, c, 'different arguments → different fingerprint');
  });

  test('argument key order does not change the fingerprint', () => {
    const a = FailureTracker.fingerprint('Edit', { path: 'a', mode: 'replace' }, 'X', 'm');
    const b = FailureTracker.fingerprint('Edit', { mode: 'replace', path: 'a' }, 'X', 'm');
    assert.equal(a, b);
  });

  test('a step budget stops the turn', async () => {
    const spin: FakeStep = { kind: 'tools', calls: [{ name: 'Glob', arguments: { pattern: '**/*' } }] };
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'x\n' },
      script: Array.from({ length: 40 }, () => spin),
    });
    try {
      const outcome = await ws.kernel.session.runTurn('loop forever');
      assert.equal(outcome.turn.state, 'failed');
      assert.equal(outcome.error?.code, 'LOOP_BUDGET_EXCEEDED');
    } finally {
      await ws.cleanup();
    }
  });

  test('/loop start cannot raise a budget above the session ceiling', () => {
    const tracker = new LoopBudgetTracker(DEFAULT_LOOP_BUDGET, () => Date.now());
    tracker.applyCeiling({ maxSteps: 9999, maxToolCalls: 9999 }, DEFAULT_LOOP_BUDGET);
    assert.equal(tracker.current.maxSteps, DEFAULT_LOOP_BUDGET.maxSteps);
    assert.equal(tracker.current.maxToolCalls, DEFAULT_LOOP_BUDGET.maxToolCalls);

    tracker.applyCeiling({ maxSteps: 4 }, DEFAULT_LOOP_BUDGET);
    assert.equal(tracker.current.maxSteps, 4, 'narrowing is allowed');
  });

  test('cancelling mid-turn ends in cancelled with every call answered', async () => {
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'x\n' },
      script: Array.from({ length: 10 }, () => ({
        kind: 'tools' as const,
        calls: [{ name: 'Shell', arguments: { argv: ['sh', '-c', 'sleep 0.2'] } }],
      })),
    });
    try {
      const running = ws.kernel.session.runTurn('run something slow');
      await new Promise((r) => setTimeout(r, 60));
      ws.kernel.session.cancel();

      const outcome = await running;
      assert.equal(outcome.turn.state, 'cancelled');
      assert.deepEqual(ws.kernel.context.openToolCalls(), [], 'cancellation still closes every call');
    } finally {
      await ws.cleanup();
    }
  });

  test('an empty model response is nudged rather than accepted as an answer', async () => {
    const ws = await createTestWorkspace({
      files: {},
      script: [{ kind: 'empty' }, { kind: 'final', text: 'here is the real answer' }],
    });
    try {
      const outcome = await ws.kernel.session.runTurn('say something');
      assert.equal(outcome.turn.state, 'completed');
      assert.equal(outcome.finalText, 'here is the real answer');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('turn state machine', () => {
  test('illegal transitions throw', () => {
    const turn = new Turn({ turnId: 't1' as never, input: 'x', origin: 'user', startedAt: 0 });
    turn.transition('preparing', 1);
    turn.transition('sampling', 2);
    turn.complete('done', 3);
    assert.equal(turn.state, 'completed');
    assert.throws(() => turn.transition('sampling', 4), /illegal turn transition/);
  });

  test('a cancelled turn cannot start executing tools', () => {
    const turn = new Turn({ turnId: 't2' as never, input: 'x', origin: 'user', startedAt: 0 });
    turn.transition('preparing', 1);
    turn.cancel(2);
    assert.equal(turn.state, 'cancelled');
    assert.throws(() => turn.transition('executing_tools', 3), /illegal turn transition/);
  });
});

describe('compaction (§20)', () => {
  test('never splits a tool call from its result', () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 12; i += 1) {
      messages.push({ role: 'user', parts: [{ type: 'text', text: `ask ${i}` }], origin: { kind: 'user' } });
      messages.push({
        role: 'assistant',
        parts: [{ type: 'tool_call', id: `c${i}` as never, name: 'Read', arguments: { path: `f${i}` } }],
        origin: { kind: 'assistant' },
      });
      messages.push({
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            toolCallId: `c${i}` as never,
            content: 'x'.repeat(4000),
            isError: false,
          },
        ],
        origin: { kind: 'tool' },
      });
    }

    const result = compact(messages, 'system', { budgetTokens: 500 });

    const called = new Set<string>();
    const answered = new Set<string>();
    for (const message of result.messages) {
      for (const part of message.parts) {
        if (part.type === 'tool_call') called.add(part.id);
        if (part.type === 'tool_result') answered.add(part.toolCallId);
      }
    }
    for (const id of called) {
      assert.ok(answered.has(id), `compaction orphaned tool call ${id}`);
    }
    assert.ok(result.tokensAfter < result.tokensBefore, 'compaction actually reduced the projection');
    assert.ok(result.levelsApplied.includes('L2'), 'the head was summarised');
  });

  test('the summary names what was edited so the work is not forgotten', () => {
    const messages: ModelMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'fix the bug' }], origin: { kind: 'user' } },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'c1' as never,
            name: 'Edit',
            arguments: { path: 'src/a.ts', mode: 'replace' },
          },
        ],
        origin: { kind: 'assistant' },
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 'c1' as never, content: 'ok', isError: false }],
        origin: { kind: 'tool' },
      },
      { role: 'user', parts: [{ type: 'text', text: 'now what' }], origin: { kind: 'user' } },
      { role: 'user', parts: [{ type: 'text', text: 'and now' }], origin: { kind: 'user' } },
      { role: 'user', parts: [{ type: 'text', text: 'and now again' }], origin: { kind: 'user' } },
      { role: 'user', parts: [{ type: 'text', text: 'x'.repeat(40_000) }], origin: { kind: 'user' } },
    ];

    const result = compact(messages, 'system', { budgetTokens: 200 });
    const summary = result.messages.find((m) => m.origin.kind === 'compaction_summary');
    assert.ok(summary, 'a summary message was produced');
    const text = summary.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    assert.match(text, /src\/a\.ts/, 'the summary records which file was edited');
  });
});

// --- helpers ---------------------------------------------------------------

function parseRepeats(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toolResults(messages: readonly ModelMessage[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.parts) {
      if (part.type === 'tool_result') out.push(part.content);
    }
  }
  return out;
}
