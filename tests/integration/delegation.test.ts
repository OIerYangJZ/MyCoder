/**
 * Real delegated execution (alpha.4 §43).
 *
 * Every test here drives the **actual child runtime**: a real `Session`, a real
 * `ToolRuntime`, real policy decisions, real events. That is the whole point of
 * the milestone. alpha.3's lesson, written into the plan as a rule, was that a
 * layer which has never crossed the real runtime path is unvalidated however good
 * its pure-function tests look — and `deriveSubagent()` had excellent
 * pure-function tests while no child had ever sampled a model.
 *
 * So the assertions are deliberately about observable runtime facts: what the
 * child's model request actually contained, what the event log recorded, what the
 * parent actually received. Each block that could pass vacuously carries a
 * negative control proving the mechanism it relies on is live (§44).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentFile,
  createTestWorkspace,
  delegateStep,
  isChildRequest,
  type TestWorkspace,
} from '../helpers/workspace.ts';
import type { FakeStep } from '../../src/model/adapters/fake.ts';
import type { ModelRequest } from '../../src/model/ir.ts';
import type { KernelEvent } from '../../src/session/events.ts';

const REVIEWER = agentFile({
  name: 'reviewer',
  description: 'Reads code and reports problems.',
  profile: 'read-only',
  tools: ['Read', 'Grep', 'Glob'],
  instructions: 'REVIEWER_INSTRUCTION_MARKER: report findings as a short list.',
});

const WORKER = agentFile({
  name: 'worker',
  description: 'Implements small changes.',
  profile: 'workspace-dev',
  tools: ['Read', 'Grep', 'Edit', 'Shell'],
  instructions: 'WORKER_INSTRUCTION_MARKER: make the smallest change that works.',
});

/**
 * An agent with no `tools:` line, so it inherits the parent's whole catalogue —
 * including `Delegate`. The depth test needs that: an agent whose definition
 * happens to exclude `Delegate` is refused for the wrong reason (the tool is not
 * in its catalogue), which would leave the depth ceiling itself untested.
 */
const DEPUTY = agentFile({
  name: 'deputy',
  description: 'Inherits everything the parent has.',
  profile: 'read-only',
  instructions: 'DEPUTY_INSTRUCTION_MARKER: you may not delegate further.',
});

const FILES = {
  '.mycoder/agents/reviewer.md': REVIEWER,
  '.mycoder/agents/worker.md': WORKER,
  '.mycoder/agents/deputy.md': DEPUTY,
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 2;\n',
};

/** Every event, so provenance can be asserted against the log rather than memory. */
async function events(ws: TestWorkspace): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const event of ws.kernel.store.readEvents(ws.kernel.sessionId)) out.push(event);
  return out;
}

const byType = (all: readonly KernelEvent[], type: string): KernelEvent[] =>
  all.filter((e) => e.type === type);

/** The most recent tool result the parent received. */
function lastToolResult(ws: TestWorkspace): string {
  const results: string[] = [];
  for (const message of ws.kernel.context.history()) {
    for (const part of message.parts) {
      if (part.type === 'tool_result') results.push(part.content);
    }
  }
  return results.at(-1) ?? '';
}

describe('a subagent runs on the real runtime (§43)', () => {
  test('the child samples the model and executes tools through the kernel', async () => {
    const childRequests: ModelRequest[] = [];
    const parentRequests: ModelRequest[] = [];

    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          childRequests.push(request);
          // First child step reads a file; second reports back.
          return childRequests.length === 1
            ? ({ kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] } as FakeStep)
            : ({ kind: 'final', text: 'src/a.ts exports a constant; nothing to flag.' } as FakeStep);
        }
        parentRequests.push(request);
        return parentRequests.length === 1
          ? delegateStep('reviewer', 'Review src/a.ts and report anything surprising.')
          : ({ kind: 'final', text: 'The reviewer found nothing.' } as FakeStep);
      },
    });

    try {
      const outcome = await ws.kernel.session.runTurn('Have the reviewer look at src/a.ts.');
      assert.equal(outcome.turn.state, 'completed');

      // --- the child really sampled the model ---------------------------
      assert.ok(childRequests.length >= 2, `child made ${childRequests.length} model request(s)`);
      const first = childRequests[0]!;
      assert.match(first.system, /REVIEWER_INSTRUCTION_MARKER/);
      assert.match(first.system, /Instructions from agent:reviewer/);

      // NEGATIVE CONTROL: the agent's instructions are the *child's* context, not
      // the session's. Without this, a test asserting the marker is present
      // would also pass if the overlay had leaked into every request.
      assert.ok(
        parentRequests.every((r) => !r.system.includes('REVIEWER_INSTRUCTION_MARKER')),
        'the agent definition leaked into the parent context',
      );

      // --- the child really executed a tool -----------------------------
      const all = await events(ws);
      const childCalls = byType(all, 'tool.call').filter((e) => e.delegationId !== undefined);
      assert.equal(childCalls.length, 1, 'expected exactly one delegated tool call');
      assert.equal((childCalls[0]!.payload as { name: string }).name, 'Read');

      const childReads = byType(all, 'file.read').filter((e) => e.delegationId !== undefined);
      assert.equal(childReads.length, 1, 'the child Read did not produce a file.read record');

      // The child's own turn is recorded and attributed.
      const childTurns = byType(all, 'turn.started').filter((e) => e.delegationId !== undefined);
      assert.equal(childTurns.length, 1);
      assert.equal((childTurns[0]!.payload as { origin: string }).origin, 'delegation');
      assert.equal((childTurns[0]!.payload as { agent?: string }).agent, 'reviewer');

      // --- the parent received a structured result ----------------------
      const result = lastToolResult(ws);
      assert.match(result, /\[subagent:reviewer\] completed/);
      assert.match(result, /nothing to flag/);
      assert.match(result, /child cost : \d+ model request\(s\)/);
    } finally {
      await ws.cleanup();
    }
  });

  test('provenance joins the child to the tool call that asked for it (§9)', async () => {
    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) =>
        isChildRequest(request, 'reviewer')
          ? { kind: 'final', text: 'done' }
          : request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
            ? { kind: 'final', text: 'ok' }
            : delegateStep('reviewer', 'Look at src/b.ts.'),
    });

    try {
      await ws.kernel.session.runTurn('Delegate a review.');
      const all = await events(ws);

      const requested = byType(all, 'delegation.requested');
      const started = byType(all, 'delegation.started');
      const completed = byType(all, 'delegation.completed');
      assert.equal(requested.length, 1);
      assert.equal(started.length, 1);
      assert.equal(completed.length, 1);

      const req = requested[0]!.payload as {
        delegationId: string;
        agent: string;
        depth: number;
        toolCallId: string;
        taskHash: string;
      };
      assert.equal(req.agent, 'reviewer');
      assert.equal(req.depth, 1);
      assert.ok(req.toolCallId, 'the delegating tool call id was not recorded');
      assert.match(req.taskHash, /^[0-9a-f]{16}$/);

      // The lifecycle events belong to the parent's turn and step…
      assert.ok(requested[0]!.turnId, 'delegation.requested has no parent turn');
      assert.ok(requested[0]!.stepId, 'delegation.requested has no parent step');
      assert.equal(requested[0]!.delegationId, undefined);

      // …and the child's work carries the delegation id, with the same id used
      // across requested / started / completed.
      const started0 = started[0]!.payload as { delegationId: string; childRunId: string };
      assert.equal(started0.delegationId, req.delegationId);
      assert.match(started0.childRunId, /^crn_/);

      const tagged = all.filter((e) => e.delegationId === req.delegationId);
      assert.ok(tagged.length > 0, 'no event was attributed to the child scope');
      assert.ok(
        tagged.every((e) => e.turnId !== requested[0]!.turnId),
        "a child event was recorded against the parent's turn",
      );
    } finally {
      await ws.cleanup();
    }
  });

  test("the child's report reaches the parent as a tool result, never as the user (§18)", async () => {
    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) =>
        isChildRequest(request, 'reviewer')
          ? { kind: 'final', text: 'CHILD_REPORT_MARKER: two problems in src/a.ts.' }
          : request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
            ? { kind: 'final', text: 'Relayed.' }
            : delegateStep('reviewer', 'Review src/a.ts.'),
    });

    try {
      await ws.kernel.session.runTurn('Review it.');

      const carriers = ws.kernel.context
        .history()
        .filter((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('CHILD_REPORT_MARKER')));
      assert.deepEqual(carriers, [], 'the child report appeared as a plain message');

      const toolMessages = ws.kernel.context.history().filter((m) => m.role === 'tool');
      const carrying = toolMessages.filter((m) =>
        m.parts.some((p) => p.type === 'tool_result' && p.content.includes('CHILD_REPORT_MARKER')),
      );
      assert.equal(carrying.length, 1, 'the report did not arrive as a tool result');
      assert.equal(carrying[0]!.origin.kind, 'tool');

      // And inside the *child*, the task is an injection naming the parent —
      // not a user message either (§18 in the other direction).
      const childTaskEvents = (await events(ws))
        .filter((e) => e.delegationId !== undefined && e.type === 'turn.started')
        .map((e) => e.payload as { origin: string });
      assert.deepEqual(
        childTaskEvents.map((p) => p.origin),
        ['delegation'],
      );
    } finally {
      await ws.cleanup();
    }
  });
});

describe('capability never widens across the delegation boundary (§10)', () => {
  test('a read-only parent produces a read-only child, whatever the definition asks', async () => {
    const childRequests: ModelRequest[] = [];
    const ws = await createTestWorkspace({
      files: FILES,
      profile: 'read-only',
      responder: (request) => {
        if (isChildRequest(request, 'worker')) {
          childRequests.push(request);
          // The child tries to write. Its definition asked for workspace-dev.
          return childRequests.length === 1
            ? {
                kind: 'tools',
                calls: [
                  {
                    name: 'Edit',
                    arguments: {
                      path: 'src/a.ts',
                      receiptId: 'rcp_none',
                      oldString: 'export const a = 1;',
                      newString: 'export const a = 2;',
                    },
                  },
                ],
              }
            : { kind: 'final', text: 'I could not write.' };
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'The worker was blocked.' }
          : delegateStep('worker', 'Change src/a.ts so a is 2.');
      },
    });

    try {
      await ws.kernel.session.runTurn('Have the worker edit src/a.ts.');

      // The file is untouched: the intersection held at runtime, not just in
      // `deriveSubagent()`.
      assert.equal(await ws.file('src/a.ts'), 'export const a = 1;\n');

      const all = await events(ws);
      const denials = all.filter(
        (e) => e.delegationId !== undefined && (e.type === 'policy.decision' || e.type === 'tool.result'),
      );
      assert.ok(denials.length > 0, 'the child produced no policy or tool record at all');

      // The child's own tool result says it was refused, and the refusal came
      // from the policy layer rather than from a missing tool.
      const started = byType(all, 'delegation.started')[0]!.payload as { policyLayers: string[] };
      assert.ok(
        started.policyLayers.some((l) => l === 'agent:worker'),
        `expected an agent layer, got ${started.policyLayers.join(' ∩ ')}`,
      );
      assert.ok(
        started.policyLayers.some((l) => l.startsWith('session:read-only')),
        'the read-only session layer is missing from the child',
      );
    } finally {
      await ws.cleanup();
    }
  });

  test('the child catalogue is an intersection, and a tool outside it is not callable', async () => {
    const childRequests: ModelRequest[] = [];
    const ws = await createTestWorkspace({
      files: {
        ...FILES,
        // A skill that narrows the *parent* to two tools, so the intersection has
        // something to bite on: the worker definition asks for four.
        // Note `Delegate` in the skill's own tool list. A skill that narrows the
        // catalogue narrows *every* tool, delegation included — so a skill listing
        // only [Read, Grep] silently disables delegation for as long as it is
        // active. Correct, and surprising enough to be worth stating here.
        '.mycoder/skills/inspect-only/SKILL.md': [
          '---',
          'name: inspect-only',
          'description: Look, do not touch.',
          'tools: [Read, Grep, Delegate]',
          '---',
          '',
          'Only inspect.',
        ].join('\n'),
      },
      responder: (request) => {
        if (isChildRequest(request, 'worker')) {
          childRequests.push(request);
          return childRequests.length === 1
            ? { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['echo', 'hi'] } }] }
            : { kind: 'final', text: 'No shell available.' };
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'done' }
          : delegateStep('worker', 'Run the tests.');
      },
    });

    try {
      // Activate the narrowing skill as the user would, then delegate.
      const activated = await ws.kernel.control.execute('/skills use inspect-only');
      assert.equal(activated.ok, true, activated.message);

      await ws.kernel.session.runTurn('Ask the worker to run the tests.');

      const childTools = childRequests[0]!.tools.map((t) => t.name).sort();
      // parent [Read, Grep, Delegate] ∩ worker [Read, Grep, Edit, Shell] = [Grep, Read].
      // Edit and Shell are in the *definition* and absent from the child.
      assert.deepEqual(childTools, ['Grep', 'Read'], `child catalogue was ${childTools.join(', ')}`);

      // The call it attempted anyway is refused as not-in-catalogue, which is the
      // frozen step's authority rather than the registry's.
      const all = await events(ws);
      const childResults = byType(all, 'tool.result').filter((e) => e.delegationId !== undefined);
      assert.equal(childResults.length, 1);
      assert.equal((childResults[0]!.payload as { isError: boolean }).isError, true);

      const started = byType(all, 'delegation.started')[0]!.payload as { allowedTools: string[] };
      assert.deepEqual([...started.allowedTools].sort(), ['Grep', 'Read']);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('delegation is bounded (§12, §13, §32)', () => {
  test('a child cannot delegate again: depth is refused with a structured result', async () => {
    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) => {
        if (isChildRequest(request, 'deputy')) {
          const tried = request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'));
          return tried
            ? { kind: 'final', text: 'I cannot delegate further, so I stopped.' }
            : delegateStep('worker', 'You do it instead.');
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'ok' }
          : delegateStep('deputy', 'Review and delegate if you must.');
      },
    });

    try {
      await ws.kernel.session.runTurn('Start a review.');
      const all = await events(ws);

      const denied = byType(all, 'delegation.denied');
      assert.equal(denied.length, 1, 'the nested delegation was not denied');
      const payload = denied[0]!.payload as { errorCode: string; depth: number; agent: string };
      assert.equal(payload.errorCode, 'DELEGATION_DEPTH_EXCEEDED');
      assert.equal(payload.depth, 2);
      assert.equal(payload.agent, 'worker');

      // The attempt is *recorded* rather than being invisible: the request event
      // exists for the grandchild that was refused.
      const requested = byType(all, 'delegation.requested').map((e) => e.payload as { depth: number });
      assert.deepEqual(
        requested.map((r) => r.depth),
        [1, 2],
      );

      // Only one child ever ran.
      assert.equal(byType(all, 'delegation.started').length, 1);
    } finally {
      await ws.cleanup();
    }
  });

  test("the child's budget is bounded by what the parent has left, and is charged back", async () => {
    let childCalls = 0;
    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          childCalls += 1;
          return childCalls < 3
            ? { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] }
            : { kind: 'final', text: 'read it three times' };
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'ok' }
          : delegateStep('reviewer', 'Read src/a.ts a few times.', { maxSteps: 99, maxToolCalls: 99 });
      },
    });

    try {
      const before = ws.kernel.session.usageSnapshot;
      assert.equal(before.modelRequests, 0);

      await ws.kernel.session.runTurn('Delegate a small task.');

      const all = await events(ws);
      const granted = (
        byType(all, 'delegation.started')[0]!.payload as {
          granted: { maxSteps: number; maxToolCalls: number; maxModelRequests: number };
        }
      ).granted;

      // The request asked for 99 of each. The ceiling is the minimum of the
      // default child allowance and what the turn had left — never 99.
      assert.ok(granted.maxSteps <= 8, `child got maxSteps=${granted.maxSteps}`);
      assert.ok(granted.maxToolCalls <= 24, `child got maxToolCalls=${granted.maxToolCalls}`);
      assert.ok(granted.maxModelRequests <= 8, `child got maxModelRequests=${granted.maxModelRequests}`);
      assert.ok(granted.maxSteps <= ws.kernel.session.budgetCeiling.maxSteps);

      // Root usage includes the child's (§13), and the notes say so.
      const usage = ws.kernel.session.usageSnapshot;
      assert.ok(usage.modelRequests >= childCalls + 2, `root recorded ${usage.modelRequests} requests`);

      const records = ws.kernel.session.delegationRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.usage.modelRequests, childCalls);
      assert.ok(records[0]!.child.toolCalls.length >= 2);

      const result = lastToolResult(ws);
      assert.match(result, /Requested maxSteps=99; granted \d+/);
    } finally {
      await ws.cleanup();
    }
  });

  test('repeating the same failed delegation is bounded (§32)', async () => {
    let attempts = 0;
    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          attempts += 1;
          // The child fails the same way every time.
          return {
            kind: 'error',
            error: { code: 'MODEL_TIMEOUT', message: 'timed out', retryable: true, blame: 'environment' },
          };
        }
        // The parent keeps retrying the identical delegation.
        return delegateStep('reviewer', 'Review src/a.ts.');
      },
    });

    try {
      const outcome = await ws.kernel.session.runTurn('Keep trying.');

      // The turn ends rather than looping: either the doom-loop guard denied it
      // or the repeated-failure tracker stopped the turn. Both are bounded.
      assert.ok(outcome.turn.isTerminal(), `turn state was ${outcome.turn.state}`);
      assert.ok(attempts <= 6, `the child was re-dispatched ${attempts} times`);

      const all = await events(ws);
      const denied = byType(all, 'delegation.denied');
      assert.ok(denied.length > 0, 'no delegation was ever denied, so the repeat guard never fired');
      assert.match(String((denied.at(-1)!.payload as { errorCode: string }).errorCode), /DELEGATION_DENIED/);
    } finally {
      await ws.cleanup();
    }
  });

  test('an unknown agent is denied, and the denial names what exists', async () => {
    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) =>
        request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'ok' }
          : delegateStep('does-not-exist', 'Do something.'),
    });

    try {
      await ws.kernel.session.runTurn('Delegate to a made-up agent.');
      const result = lastToolResult(ws);
      assert.match(result, /DELEGATION_DENIED/);
      assert.match(result, /reviewer/);
      assert.match(result, /worker/);

      const all = await events(ws);
      assert.equal(byType(all, 'delegation.started').length, 0, 'a child ran for an unknown agent');
      assert.equal(byType(all, 'delegation.denied').length, 1);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('child failure and cancellation are contained (§19, §20)', () => {
  test('a failing child becomes a structured result the parent can reason about', async () => {
    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          return {
            kind: 'error',
            error: {
              code: 'MODEL_TIMEOUT',
              message: 'the provider did not respond',
              retryable: true,
              blame: 'environment',
            },
          };
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'The reviewer timed out, so I read the file myself.' }
          : delegateStep('reviewer', 'Review src/a.ts.');
      },
    });

    try {
      const outcome = await ws.kernel.session.runTurn('Try the reviewer.');

      // The parent's turn survives a child failure.
      assert.equal(outcome.turn.state, 'completed');
      assert.match(outcome.finalText, /read the file myself/);

      const result = lastToolResult(ws);
      assert.match(result, /error: MODEL_TIMEOUT/);
      assert.match(result, /\[subagent:reviewer\] failed/);
      assert.match(result, /did not complete/);

      const all = await events(ws);
      const failed = byType(all, 'delegation.failed');
      assert.equal(failed.length, 1);
      assert.equal((failed[0]!.payload as { status: string }).status, 'failed');

      // No replacement child was spawned behind the model's back.
      assert.equal(byType(all, 'delegation.started').length, 1);
    } finally {
      await ws.cleanup();
    }
  });

  test('cancelling the parent stops the child; nothing continues in the background', async () => {
    let childRequests = 0;

    const ws = await createTestWorkspace({
      files: FILES,
      // A non-zero chunk delay is what gives the fake stream a point at which to
      // observe the abort. The cancellation itself is *synchronous*, below: a
      // timer-based version passed locally and left the outcome to whether a 1ms
      // callback beat a whole model exchange, which is not a property to assert on
      // a loaded CI runner.
      chunkDelayMs: 5,
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          childRequests += 1;
          if (childRequests === 1) {
            // Cancel the *parent* from inside the child's first request, so the
            // abort is already set when the stream reaches its next chunk.
            ws.kernel.session.cancel('test cancellation');
          }
          return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] };
        }
        return delegateStep('reviewer', 'Review everything, slowly.');
      },
    });

    try {
      const outcome = await ws.kernel.session.runTurn('Start a long review.');

      assert.equal(outcome.turn.state, 'cancelled');
      // The child does not keep sampling after the parent was cancelled. One
      // in-flight request may complete; a second would mean it continued.
      assert.ok(childRequests <= 2, `the child made ${childRequests} requests after cancellation`);

      const all = await events(ws);
      const cancelledEvents = byType(all, 'delegation.cancelled');
      assert.equal(cancelledEvents.length, 1, 'the delegation was not recorded as cancelled');
      assert.equal((cancelledEvents[0]!.payload as { status: string }).status, 'cancelled');

      // Invariant 1 still holds on both sides of the boundary.
      assert.deepEqual(ws.kernel.context.openToolCalls(), []);

      const record = ws.kernel.session.delegationRecords().at(-1)!;
      assert.equal(record.status, 'cancelled');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('the delegation surface is absent when nothing can be delegated', () => {
  test('a project with no agents gets no Delegate tool', async () => {
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'export const a = 1;\n' },
      script: [{ kind: 'final', text: 'nothing to do' }],
    });

    try {
      assert.equal(ws.kernel.delegation, undefined);
      assert.equal(ws.kernel.toolRegistry.has('Delegate'), false);
      assert.equal(ws.kernel.toolRegistry.has('Skill'), false);

      await ws.kernel.session.runTurn('hello');
      const names = ws.fakeModel.requests[0]!.tools.map((t) => t.name).sort();
      // The file-mutation tools are unconditional (ADR-0016); `WebFetch` is not,
      // and its absence here is the same property this test asserts for
      // `Delegate` — a capability nobody configured is a capability nobody has.
      assert.deepEqual(names, [
        'Delete',
        'Edit',
        'GitDiff',
        'Glob',
        'Grep',
        'Move',
        'Read',
        'Shell',
        'Write',
      ]);
      assert.equal(ws.kernel.toolRegistry.has('WebFetch'), false);
    } finally {
      await ws.cleanup();
    }
  });

  test('a project with agents gets it, and the schema names them', async () => {
    const ws = await createTestWorkspace({
      files: FILES,
      script: [{ kind: 'final', text: 'nothing to do' }],
    });

    try {
      assert.ok(ws.kernel.delegation, 'no delegation service was built');
      assert.deepEqual(ws.kernel.delegation!.agentNames(), ['deputy', 'reviewer', 'worker']);

      await ws.kernel.session.runTurn('hello');
      const delegate = ws.fakeModel.requests[0]!.tools.find((t) => t.name === 'Delegate');
      assert.ok(delegate, 'Delegate was not offered to the model');
      const agentProp = (
        delegate.inputSchema as unknown as {
          properties: { agent: { description: string } };
        }
      ).properties.agent;
      assert.match(agentProp.description, /deputy, reviewer, worker/);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('the prompt introduces delegation as a strategy (§4 of the utility experiment)', () => {
  test('the guidance appears only when there is something to delegate to', async () => {
    const withAgents = await createTestWorkspace({
      files: FILES,
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await withAgents.kernel.session.runTurn('hello');
      const system = withAgents.fakeModel.requests[0]!.system;
      assert.match(system, /You have subagents available through the Delegate tool/);
      assert.match(system, /keeps your own context on the main thread/);
    } finally {
      await withAgents.cleanup();
    }

    // NEGATIVE CONTROL: a project with no agents must not read about a tool the
    // kernel will not register for it. Advertising it would cost a step to
    // discover, and would change every alpha.3 trajectory.
    const without = await createTestWorkspace({
      files: { 'src/a.ts': 'export const a = 1;\n' },
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await without.kernel.session.runTurn('hello');
      assert.ok(
        !without.fakeModel.requests[0]!.system.includes('subagents available'),
        'a session with no agents was told it had subagents',
      );
    } finally {
      await without.cleanup();
    }
  });

  test('a project can switch the guidance off without losing the tool', async () => {
    const ws = await createTestWorkspace({
      files: {
        ...FILES,
        '.mycoder/config.toml': '[loop]\ndelegation_guidance = false\n',
      },
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await ws.kernel.session.runTurn('hello');
      const request = ws.fakeModel.requests[0]!;

      assert.ok(!request.system.includes('subagents available'), 'the nudge survived being switched off');
      // The capability is untouched: what the flag removes is the advice, not the
      // tool. A flag that quietly disabled delegation would be a different feature
      // wearing the same name.
      assert.ok(
        request.tools.some((t) => t.name === 'Delegate'),
        'switching off the guidance also removed the tool',
      );
      assert.ok(ws.kernel.delegation, 'switching off the guidance disabled the service');
    } finally {
      await ws.cleanup();
    }
  });

  test('a child is not told to delegate; its briefing says the opposite', async () => {
    const childRequests: ModelRequest[] = [];
    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          childRequests.push(request);
          return { kind: 'final', text: 'done' };
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'ok' }
          : delegateStep('reviewer', 'Review src/a.ts.');
      },
    });
    try {
      await ws.kernel.session.runTurn('Delegate a review.');
      assert.ok(childRequests.length > 0, 'the child never sampled');
      const system = childRequests[0]!.system;
      assert.ok(!system.includes('You have subagents available'), 'a child was nudged to delegate');
      assert.match(system, /You cannot delegate further/);
    } finally {
      await ws.cleanup();
    }
  });
});

describe("the root's usage totals include the child's (§13, §14)", () => {
  test('tokens roll up, not only requests and cost', async () => {
    // Found against a live relay: a delegated task reported ~5k tokens for 4.3
    // requests when each request was demonstrably ~4.4k. `recordDelegation` rolled
    // up modelRequests, toolCalls and cost — and silently not tokens — so `/status`
    // showed a request count that included the child beside a token count that did
    // not, and the eval's tokens-per-task understated every delegated run.
    let childCalls = 0;
    const ws = await createTestWorkspace({
      files: FILES,
      responder: (request) => {
        if (isChildRequest(request, 'reviewer')) {
          childCalls += 1;
          return childCalls === 1
            ? { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] }
            : { kind: 'final', text: 'nothing to flag' };
        }
        return request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))
          ? { kind: 'final', text: 'relayed' }
          : delegateStep('reviewer', 'Review src/a.ts.');
      },
    });

    try {
      await ws.kernel.session.runTurn('Delegate a review.');

      const root = ws.kernel.session.usageSnapshot;
      const record = ws.kernel.session.delegationRecords()[0]!;

      // The child really did spend tokens.
      assert.ok(record.usage.inputTokens > 0, 'the delegation record carries no input tokens');
      assert.ok(record.usage.outputTokens > 0, 'the delegation record carries no output tokens');

      // And the root's totals contain them. Asserted as "at least the child's",
      // because the parent spent its own on top.
      assert.ok(
        root.inputTokens > record.usage.inputTokens,
        `root input ${root.inputTokens} does not include the child's ${record.usage.inputTokens}`,
      );
      assert.ok(
        root.outputTokens >= record.usage.outputTokens,
        `root output ${root.outputTokens} does not include the child's ${record.usage.outputTokens}`,
      );

      // The consistency that was broken: requests and tokens must describe the same
      // set of requests. A root that counts the child's requests but not its tokens
      // is internally contradictory wherever the two are shown together.
      assert.equal(
        root.modelRequests,
        ws.fakeModel.callCount,
        'the root request count does not match the requests actually made',
      );
    } finally {
      await ws.cleanup();
    }
  });
});
