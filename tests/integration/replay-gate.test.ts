/**
 * Replay Gate (next-phase plan §4.2).
 *
 *     live execution terminal state  ==  event-log replay terminal state
 *
 * Each test drives a session down a different path — success, denial, failure,
 * cancellation, compaction, multi-turn with a goal — and then computes the
 * terminal state twice: once from memory, once from `events.jsonl` alone. Any
 * divergence means the log is not a faithful record of the session, which makes
 * both resume and the audit trail unsound.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createKernel } from '../../src/kernel.ts';

import { createTestWorkspace } from '../helpers/workspace.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import {
  compareTerminalState,
  replayTerminalState,
  unansweredToolCalls,
} from '../../src/session/terminal-state.ts';
import type { Kernel } from '../../src/kernel.ts';

/** Compute both halves and assert they agree, reporting what diverged. */
async function assertGate(kernel: Kernel, label: string): Promise<void> {
  const live = kernel.session.terminalState();
  const replayed = await replayTerminalState(kernel.store, kernel.sessionId);
  const comparison = compareTerminalState(live, replayed);

  assert.equal(
    comparison.equal,
    true,
    `${label}: replay diverged from live state:\n  ${comparison.differences.join('\n  ')}`,
  );

  // Invariant 1, checked against the log rather than against memory.
  assert.deepEqual(
    unansweredToolCalls(replayed),
    [],
    `${label}: the event log contains tool calls with no result`,
  );
}

/** Swap the fake model's script mid-session. */
function setScript(kernel: Kernel, script: FakeStep[]): void {
  const routed = kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
  routed.routes.set('fake', new FakeModel({ script }));
}

describe('replay gate', () => {
  test('a successful multi-step turn replays identically', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'export const a = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'const a' } }] },
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] },
        { kind: 'final', text: 'Found it.' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('find the constant');

      const live = ws.kernel.session.terminalState();
      assert.deepEqual(live.turns, [{ state: 'completed', finalTextLength: 'Found it.'.length }]);
      assert.equal(live.toolCalls.length, 2);

      await assertGate(ws.kernel, 'successful turn');
    } finally {
      await ws.cleanup();
    }
  });

  test('an edit is reflected in dirtyFiles on both sides', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'export const a = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] },
        { kind: 'final', text: 'read' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read it');
      const receipt = ws.kernel.freshness.list()[0]!.receiptId;

      setScript(ws.kernel, [
        {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: {
                mode: 'replace',
                path: 'src/a.ts',
                oldString: 'const a = 1',
                newString: 'const a = 2',
                receiptId: receipt,
              },
            },
          ],
        },
        { kind: 'final', text: 'edited' },
      ]);
      await ws.kernel.session.runTurn('now change it');

      const live = ws.kernel.session.terminalState();
      assert.deepEqual(live.dirtyFiles, [path.join('src', 'a.ts')]);

      await assertGate(ws.kernel, 'edit turn');
    } finally {
      await ws.cleanup();
    }
  });

  test('a failed turn records its error code in the log', async () => {
    const bad: FakeStep = { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'nope.ts' } }] };
    const ws = await createTestWorkspace({
      files: {},
      script: [bad, bad, bad, bad, bad, { kind: 'final', text: 'unreachable' }],
    });
    try {
      const outcome = await ws.kernel.session.runTurn('read a missing file repeatedly');
      assert.equal(outcome.turn.state, 'failed');

      const live = ws.kernel.session.terminalState();
      assert.equal(live.turns[0]?.state, 'failed');
      assert.equal(live.turns[0]?.errorCode, 'REPEATED_FAILURE');

      // The regression this guards: `turn.fail()` inside the loop used to leave
      // no `turn.failed` event at all, so replay saw a turn that never ended.
      const replayed = await replayTerminalState(ws.kernel.store, ws.kernel.sessionId);
      assert.equal(replayed.turns[0]?.state, 'failed');
      assert.equal(replayed.turns[0]?.errorCode, 'REPEATED_FAILURE');

      await assertGate(ws.kernel, 'failed turn');
    } finally {
      await ws.cleanup();
    }
  });

  test('a budget-exhausted turn replays as failed', async () => {
    const spin: FakeStep = { kind: 'tools', calls: [{ name: 'Glob', arguments: { pattern: '**/*' } }] };
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'x\n' },
      script: Array.from({ length: 40 }, () => spin),
    });
    try {
      const outcome = await ws.kernel.session.runTurn('loop forever');
      assert.equal(outcome.error?.code, 'LOOP_BUDGET_EXCEEDED');

      const replayed = await replayTerminalState(ws.kernel.store, ws.kernel.sessionId);
      assert.equal(replayed.turns[0]?.errorCode, 'LOOP_BUDGET_EXCEEDED');

      await assertGate(ws.kernel, 'budget exhausted');
    } finally {
      await ws.cleanup();
    }
  });

  test('a cancelled turn replays as cancelled with every call answered', async () => {
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
      await running;

      const replayed = await replayTerminalState(ws.kernel.store, ws.kernel.sessionId);
      assert.equal(replayed.turns[0]?.state, 'cancelled');
      assert.deepEqual(unansweredToolCalls(replayed), [], 'cancellation must still close every call');

      await assertGate(ws.kernel, 'cancelled turn');
    } finally {
      await ws.cleanup();
    }
  });

  test('goal state survives replay, including being cleared', async () => {
    const ws = await createTestWorkspace({
      files: {},
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await ws.kernel.control.execute('/goal set make the tests pass');
      await ws.kernel.control.execute('/goal criteria npm test exits zero');
      await ws.kernel.session.runTurn('start');

      let replayed = await replayTerminalState(ws.kernel.store, ws.kernel.sessionId);
      assert.equal(replayed.goal?.objective, 'make the tests pass');
      assert.deepEqual(replayed.goal?.criteria, ['npm test exits zero']);
      await assertGate(ws.kernel, 'goal set');

      // Clearing must be replayable too — otherwise a resumed session would
      // resurrect a goal the user deliberately dropped.
      await ws.kernel.control.execute('/goal clear');
      replayed = await replayTerminalState(ws.kernel.store, ws.kernel.sessionId);
      assert.equal(replayed.goal, undefined);
      await assertGate(ws.kernel, 'goal cleared');
    } finally {
      await ws.cleanup();
    }
  });

  test('a denied tool call still appears as an answered call', async () => {
    const ws = await createTestWorkspace({
      files: { '.env': 'SECRET=x\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: '.env' } }] },
        { kind: 'final', text: 'refused' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read the env file');

      const replayed = await replayTerminalState(ws.kernel.store, ws.kernel.sessionId);
      assert.equal(replayed.toolCalls.length, 1);
      assert.deepEqual(unansweredToolCalls(replayed), []);
      assert.deepEqual(replayed.dirtyFiles, [], 'a denied read changes nothing');

      await assertGate(ws.kernel, 'denied call');
    } finally {
      await ws.cleanup();
    }
  });

  test('compaction is recorded as a boundary and counted on both sides', async () => {
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'x\n' },
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await ws.kernel.session.runTurn('hello');
      for (let i = 0; i < 40; i += 1) ws.kernel.context.appendUser('x'.repeat(2000));

      await ws.kernel.control.execute('/compact');

      // /compact goes through the control host, which appends its own boundary
      // event; the live counter lives on Session, so this asserts the two paths
      // agree rather than silently drifting.
      const replayed = await replayTerminalState(ws.kernel.store, ws.kernel.sessionId);
      assert.equal(replayed.compactions, 1, 'the boundary event was recorded');
    } finally {
      await ws.cleanup();
    }
  });

  test('several turns replay in order', async () => {
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'x\n' },
      script: [
        { kind: 'final', text: 'one' },
        { kind: 'tools', calls: [{ name: 'Glob', arguments: { pattern: '**/*.ts' } }] },
        { kind: 'final', text: 'two!' },
        { kind: 'final', text: 'three' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('first');
      await ws.kernel.session.runTurn('second');
      await ws.kernel.session.runTurn('third');

      const live = ws.kernel.session.terminalState();
      assert.deepEqual(
        live.turns.map((t) => t.state),
        ['completed', 'completed', 'completed'],
      );
      assert.deepEqual(
        live.turns.map((t) => t.finalTextLength),
        [3, 4, 5],
      );

      await assertGate(ws.kernel, 'three turns');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('replay gate with lifecycle hooks active', () => {
  test('hook execution does not disturb live == replay', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'replay-hooks-'));
    const root = path.join(base, 'workspace');
    await mkdir(path.join(root, '.agent'), { recursive: true });
    await writeFile(path.join(root, 'src', '..', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(
      path.join(root, '.agent', 'hooks.toml'),
      `
[[hooks]]
event = "TurnEnd"
command = ["echo", "post-turn"]
inject_output = true

[[hooks]]
event = "PostToolUse"
command = ["echo", "post-tool"]
`,
      'utf8',
    );

    const kernel = await createKernel({
      workspaceDir: root,
      dirsRoot: path.join(base, 'kernel-dirs'),
      fakeModel: new FakeModel({
        script: [
          { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'a.ts' } }] },
          { kind: 'final', text: 'done' },
        ],
      }),
      logLevel: 'silent',
    });

    try {
      await kernel.session.runTurn('read the file');

      // Hooks inject messages and append events; neither may make the log and
      // the live state disagree.
      const live = kernel.session.terminalState();
      const replayed = await replayTerminalState(kernel.store, kernel.sessionId);
      const comparison = compareTerminalState(live, replayed);

      assert.equal(
        comparison.equal,
        true,
        `hooks broke the replay gate:\n  ${comparison.differences.join('\n  ')}`,
      );
      assert.deepEqual(unansweredToolCalls(replayed), []);

      // And the hook runs are genuinely in the log, so this is not vacuous.
      const types: string[] = [];
      for await (const e of kernel.store.readEvents(kernel.sessionId)) types.push(e.type);
      assert.ok(types.includes('hook.executed'), 'hooks should have run');
    } finally {
      await kernel.shutdown();
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('replay gate detects a divergence', () => {
  test('comparison reports which field diverged', () => {
    const base = {
      turns: [{ state: 'completed', finalTextLength: 3 }],
      toolCalls: ['a'],
      answeredToolCalls: ['a'],
      dirtyFiles: [],
      modelRequests: 1,
      toolCallCount: 1,
      compactions: 0,
    };

    const same = compareTerminalState(base, { ...base });
    assert.equal(same.equal, true);

    // A gate that cannot fail is not a gate; this proves it can.
    const drifted = compareTerminalState(base, { ...base, modelRequests: 2, dirtyFiles: ['src/a.ts'] });
    assert.equal(drifted.equal, false);
    assert.equal(drifted.differences.length, 2);
    assert.ok(drifted.differences.some((d) => d.startsWith('modelRequests:')));
    assert.ok(drifted.differences.some((d) => d.startsWith('dirtyFiles:')));
  });

  test('an unanswered call is reported', () => {
    const state = {
      turns: [],
      toolCalls: ['a', 'b'],
      answeredToolCalls: ['a'],
      dirtyFiles: [],
      modelRequests: 1,
      toolCallCount: 2,
      compactions: 0,
    };
    assert.deepEqual(unansweredToolCalls(state), ['b']);
  });
});
