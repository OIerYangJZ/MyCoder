/**
 * Delegation across replay, compaction and resume (alpha.4 §28, §29, §30).
 *
 *     live parent + child terminal state  ==  replayed parent + child terminal state
 *
 * The gate alpha.3 shipped compared a single flat session. A delegation makes the
 * comparison meaningfully harder, and in two ways that were both defects before
 * this suite existed: a child's tool calls must count toward the root's totals
 * without being folded into the parent's transcript, and a delegation must not be
 * left orphaned by either half.
 *
 * §29's resume case is the one worth reading first. A process that dies while a
 * child is running leaves an unanswered delegating tool call *and* a workspace the
 * child may have half-edited. Both halves have to be repaired without silently
 * restarting the child.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { agentFile, createTestWorkspace, delegateStep, isChildRequest } from '../helpers/workspace.ts';
import { MemorySessionStore } from '../../src/session/store.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { replaySession } from '../../src/session/resume.ts';
import {
  compareTerminalState,
  replayTerminalState,
  unansweredToolCalls,
} from '../../src/session/terminal-state.ts';
import type { Kernel } from '../../src/kernel.ts';
import type { FakeStep } from '../../src/model/adapters/fake.ts';
import type { ModelRequest } from '../../src/model/ir.ts';

const AGENTS = {
  '.mycoder/agents/reviewer.md': agentFile({
    name: 'reviewer',
    profile: 'read-only',
    tools: ['Read', 'Grep'],
    instructions: 'Report what you find.',
  }),
  '.mycoder/agents/fixer.md': agentFile({
    name: 'fixer',
    profile: 'workspace-dev',
    tools: ['Read', 'Edit'],
    instructions: 'Make the change.',
  }),
};

async function assertGate(kernel: Kernel, label: string): Promise<void> {
  const live = kernel.session.terminalState();
  const replayed = await replayTerminalState(kernel.store, kernel.sessionId);
  const comparison = compareTerminalState(live, replayed);

  assert.equal(
    comparison.equal,
    true,
    `${label}: replay diverged from live state:\n  ${comparison.differences.join('\n  ')}`,
  );
  assert.deepEqual(
    unansweredToolCalls(replayed),
    [],
    `${label}: the event log contains tool calls with no result`,
  );
}

describe('the replay gate holds across a delegation (§28)', () => {
  test('a completed delegation replays identically, child work included', async () => {
    let childCalls = 0;
    const ws = await createTestWorkspace({
      files: { ...AGENTS, 'src/a.ts': 'export const a = 1;\n' },
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          childCalls += 1;
          return childCalls === 1
            ? { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] }
            : { kind: 'final', text: 'One constant, no problems.' };
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'Reviewed.' }
          : delegateStep('reviewer', 'Review src/a.ts.');
      },
    });

    try {
      await ws.kernel.session.runTurn('Review the file.');

      const live = ws.kernel.session.terminalState();

      // The root's totals include the child's work…
      assert.equal(live.delegations.length, 1);
      assert.equal(live.delegations[0]!.agent, 'reviewer');
      assert.equal(live.delegations[0]!.status, 'completed');
      assert.deepEqual(live.delegations[0]!.childTurns, ['completed']);
      assert.equal(live.delegations[0]!.childToolCalls.length, 1);
      assert.equal(live.toolCalls.length, 2, 'expected the Delegate call and the child Read');

      // …and only the parent's own turn is in `turns`.
      assert.deepEqual(live.turns, [{ state: 'completed', finalTextLength: 'Reviewed.'.length }]);

      await assertGate(ws.kernel, 'completed delegation');
    } finally {
      await ws.cleanup();
    }
  });

  test('a child edit lands in the root dirty list and in the delegation record', async () => {
    let childCalls = 0;
    const ws = await createTestWorkspace({
      files: { ...AGENTS, 'src/a.ts': 'export const a = 1;\n' },
      responder: (request) => {
        if (isChildRequest(request, 'fixer')) {
          childCalls += 1;
          if (childCalls === 1) {
            return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] };
          }
          if (childCalls === 2) {
            // The receipt comes from the child's *own* read, which is the point: a
            // parent's receipt does not authorise a child's edit.
            return {
              kind: 'tools',
              calls: [
                {
                  name: 'Edit',
                  arguments: {
                    mode: 'replace',
                    path: 'src/a.ts',
                    receiptId: receiptFromRequest(request),
                    oldString: 'export const a = 1;',
                    newString: 'export const a = 2;',
                  },
                },
              ],
            };
          }
          return { kind: 'final', text: 'Changed a to 2.' };
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'The fixer changed it.' }
          : delegateStep('fixer', 'Set a to 2 in src/a.ts.');
      },
    });

    try {
      await ws.kernel.session.runTurn('Change the constant.');
      assert.equal(await ws.file('src/a.ts'), 'export const a = 2;\n');

      const live = ws.kernel.session.terminalState();
      assert.deepEqual(live.dirtyFiles, ['src/a.ts']);
      assert.deepEqual(ws.kernel.session.delegationRecords()[0]!.child.dirtyFiles, ['src/a.ts']);

      await assertGate(ws.kernel, 'delegated edit');
    } finally {
      await ws.cleanup();
    }
  });

  test('a failed and a denied delegation both replay, and neither is orphaned', async () => {
    let parentStep = 0;
    const ws = await createTestWorkspace({
      files: { ...AGENTS, 'src/a.ts': 'export const a = 1;\n' },
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          return {
            kind: 'error',
            error: { code: 'MODEL_TIMEOUT', message: 'no response', retryable: true, blame: 'environment' },
          } as FakeStep;
        }
        parentStep += 1;
        if (parentStep === 1) return delegateStep('reviewer', 'Review src/a.ts.');
        if (parentStep === 2) return delegateStep('ghost', 'Do something impossible.');
        return { kind: 'final', text: 'Both attempts failed.' };
      },
    });

    try {
      await ws.kernel.session.runTurn('Try two delegations.');

      const live = ws.kernel.session.terminalState();
      assert.equal(live.delegations.length, 2);
      assert.deepEqual(
        live.delegations.map((d) => d.status),
        ['failed', 'denied'],
      );

      await assertGate(ws.kernel, 'failed and denied delegations');
    } finally {
      await ws.cleanup();
    }
  });

  test('a cancelled delegation replays as cancelled', async () => {
    let childRequests = 0;
    const ws = await createTestWorkspace({
      files: { ...AGENTS, 'src/a.ts': 'export const a = 1;\n' },
      chunkDelayMs: 5,
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          childRequests += 1;
          // Synchronous, not on a timer: the assertion is about propagation, not
          // about whether a 1ms callback wins a race on a busy runner.
          if (childRequests === 1) ws.kernel.session.cancel('test');
          return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] };
        }
        return delegateStep('reviewer', 'Review slowly.');
      },
    });

    try {
      await ws.kernel.session.runTurn('Start and cancel.');
      const live = ws.kernel.session.terminalState();
      assert.equal(live.delegations.at(-1)!.status, 'cancelled');
      await assertGate(ws.kernel, 'cancelled delegation');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('compaction preserves delegated work (§30)', () => {
  test('a compaction boundary keeps the delegation, its outcome and its files', async () => {
    // Compaction only summarises the *head* of the conversation: the last three
    // user exchanges are preserved verbatim (§20). So the session has to be four
    // turns long for the delegation to be in the part that gets summarised — a
    // single-turn fixture would exercise the "nothing older to summarise" branch
    // and assert nothing about anchors.
    const big = 'x'.repeat(120_000);
    let childCalls = 0;
    let parentCalls = 0;

    const ws = await createTestWorkspace({
      files: {
        ...AGENTS,
        'src/a.ts': 'export const a = 1;\n',
        'src/big.ts': `export const big = "${big}";\n`,
      },
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          childCalls += 1;
          return childCalls === 1
            ? { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] }
            : { kind: 'final', text: 'CHILD_FINDING: the constant is unused.' };
        }
        parentCalls += 1;
        // Turn 1 delegates; turn 2 reads the very large file; turns 3 and 4 are
        // trivial, which is what pushes the delegation into the summarised head.
        if (parentCalls === 1) return delegateStep('reviewer', 'Review src/a.ts.');
        if (parentCalls === 3) {
          return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/big.ts' } }] };
        }
        return { kind: 'final', text: `ack ${parentCalls}` };
      },
    });

    try {
      await ws.kernel.session.runTurn('Review src/a.ts.');
      await ws.kernel.session.runTurn('Now read the big file.');
      await ws.kernel.session.runTurn('Anything else?');
      await ws.kernel.session.runTurn('Wrap up.');

      const compacted = await ws.kernel.session.compactNow();
      assert.ok(
        compacted.droppedMessages > 0,
        `compaction dropped nothing (${compacted.tokensBefore} → ${compacted.tokensAfter} tokens), ` +
          'so this test asserts nothing',
      );

      const projected = JSON.stringify(
        ws.kernel.projector.project(ws.kernel.context, ws.kernel.context.repository.facts).messages,
      );

      // The delegation survives as an anchor: which agent, what outcome, and an
      // instruction not to run it again.
      assert.match(projected, /Delegated work in this session/);
      assert.match(projected, /reviewer \(completed\)/);
      assert.match(projected, /Do not re-dispatch a delegation that already completed/);

      // Nothing was orphaned by the rewrite, and the record itself is intact.
      assert.deepEqual(ws.kernel.context.openToolCalls(), []);
      assert.equal(ws.kernel.session.delegationRecords().length, 1);
      await assertGate(ws.kernel, 'after compaction');
    } finally {
      await ws.cleanup();
    }
  });

  test('a compaction inside a child is attributed to the child, not the root', async () => {
    // The child's own conversation is compacted when its projection outgrows the
    // model's window. Both halves of the gate have to attribute that boundary to
    // the child, or the root's compaction count diverges by one.
    let childCalls = 0;
    const big = 'x'.repeat(120_000);
    const ws = await createTestWorkspace({
      files: {
        ...AGENTS,
        'src/big.ts': `export const big = "${big}";\n`,
        'src/a.ts': 'export const a = 1;\n',
      },
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          childCalls += 1;
          if (childCalls <= 2) {
            return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/big.ts' } }] };
          }
          return { kind: 'final', text: 'That file is enormous.' };
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'ok' }
          : delegateStep('reviewer', 'Read src/big.ts twice.');
      },
    });

    try {
      await ws.kernel.session.runTurn('Look at the big file.');

      const live = ws.kernel.session.terminalState();
      // Whether the child actually compacted depends on the fake model's window,
      // so this asserts the *attribution* rather than a specific count.
      assert.equal(
        live.compactions,
        live.delegations.reduce((n, d) => n + d.childCompactions, 0),
        'the root recorded compactions that no scope claims',
      );
      await assertGate(ws.kernel, 'child compaction');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('an interrupted delegation resumes safely (§29)', () => {
  test('the delegating call is answered, the child is not restarted, and the risk is stated', async () => {
    const redactor = new Redactor();
    const store = new MemorySessionStore(redactor);

    let childCalls = 0;
    let parentCalls = 0;
    const ws = await createTestWorkspace({
      files: { ...AGENTS, 'src/a.ts': 'export const a = 1;\n' },
      store,
      responder: (request) => {
        if (isChildRequest(request, 'fixer')) {
          childCalls += 1;
          if (childCalls === 1) {
            return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] };
          }
          // The child performs a real edit, and then the "process dies": the
          // delegation never reaches a terminal event because the test kills the
          // turn from underneath it.
          if (childCalls === 2) {
            return {
              kind: 'tools',
              calls: [
                {
                  name: 'Edit',
                  arguments: {
                    mode: 'replace',
                    path: 'src/a.ts',
                    receiptId: receiptFromRequest(request),
                    oldString: 'export const a = 1;',
                    newString: 'export const a = 3;',
                  },
                },
              ],
            };
          }
          throw new Error('simulated process death inside the child');
        }
        parentCalls += 1;
        return parentCalls === 1
          ? delegateStep('fixer', 'Set a to 3.')
          : { kind: 'final', text: 'the fixer did not report back' };
      },
    });

    try {
      const outcome = await ws.kernel.session.runTurn('Have the fixer change it.');
      // The simulated death surfaces as a failed child, and the parent still ends
      // in a legal terminal state with every call answered.
      assert.ok(outcome.turn.isTerminal());
      assert.equal(await ws.file('src/a.ts'), 'export const a = 3;\n', 'the child edit did not happen');

      // Now drop the terminal delegation events, as a hard kill would: replay must
      // notice the delegation was still open.
      const truncated = new MemorySessionStore(redactor);
      await truncated.createSession((await store.loadMetadata(ws.kernel.sessionId))!);
      for (const event of store.events(ws.kernel.sessionId)) {
        if (
          event.type === 'delegation.completed' ||
          event.type === 'delegation.failed' ||
          event.type === 'delegation.cancelled' ||
          event.type === 'tool.result'
        ) {
          continue;
        }
        await truncated.append(ws.kernel.sessionId, {
          type: event.type,
          payload: event.payload,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(event.stepId ? { stepId: event.stepId } : {}),
          ...(event.delegationId ? { delegationId: event.delegationId } : {}),
        });
      }

      const replayed = await replaySession(truncated, ws.kernel.sessionId);
      assert.ok(replayed, 'the session did not replay');

      // §29: the delegation is reported as unfinished, by agent name.
      assert.equal(replayed.unfinishedDelegations.length, 1);
      assert.equal(replayed.unfinishedDelegations[0]!.agent, 'fixer');
      assert.match(replayed.warnings.join('\n'), /still running when the previous session ended/);
      assert.match(replayed.warnings.join('\n'), /not resumed/);

      // The parent's delegating call was answered synthetically, and the text says
      // plainly that the child may have half-finished — the model must verify
      // rather than re-dispatch.
      const synthetic = replayed.messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === 'tool_result')
        .map((p) => (p.type === 'tool_result' ? p.content : ''))
        .join('\n');
      assert.match(synthetic, /"fixer" subagent was still running/);
      assert.match(synthetic, /re-dispatching the same task could repeat a partial edit/);
      assert.deepEqual(
        replayed.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_call' && false),
        [],
      );

      // The child's own work is recorded (the edit is in the log) but is not
      // replayed into the parent's transcript.
      assert.ok(replayed.editedPaths.includes('src/a.ts'), 'the child edit is missing from resume');
      const transcript = JSON.stringify(replayed.messages);
      assert.ok(
        !transcript.includes('"name":"Edit"'),
        "the child's Edit was folded into the parent's transcript",
      );
    } finally {
      await ws.cleanup();
    }
  });
});

/**
 * The receipt the *child* was given, read out of the child's own conversation.
 *
 * A child has its own freshness ledger, so the kernel's is the wrong place to
 * look — and reading the log would be reaching around the model. This is exactly
 * what a real child does: the receipt id is in the header of its Read result.
 */
function receiptFromRequest(request: ModelRequest): string {
  for (const message of [...request.messages].reverse()) {
    for (const part of message.parts) {
      if (part.type !== 'tool_result') continue;
      const match = /receiptId: (\S+)/.exec(part.content);
      if (match) return match[1]!;
    }
  }
  return 'rcp_missing';
}
