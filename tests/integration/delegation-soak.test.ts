/**
 * Long-running delegated session soak (alpha.4 §31).
 *
 * One scripted scenario, repeated. Each iteration composes everything the
 * milestone touches into a single session:
 *
 *   20+ parent steps · 3+ delegations · 2+ skill activations
 *   2+ compaction boundaries · 1 restart and resume · 1 child failure
 *   1 denied child action · 1 successful edit-then-test cycle
 *
 * and then asserts the seven properties §31 lists: no state leak between
 * iterations, no orphan tool call, no orphan delegation, live == replay, exact
 * budget accounting, capability never widening, and zero canary leakage.
 *
 * Repeats default to 3 so an ordinary `pnpm test` stays fast; CI runs the full
 * `N = 50` through `KERNEL_SOAK_REPEATS`. The number is reported either way,
 * because "the soak passed" over an unrecorded N is not a measurement.
 *
 * The restart is the part worth reading. The gate is checked **twice**: once
 * before the shutdown, where the pre-restart facts are compared independently,
 * and once after, where the resumed session's seeded state must still agree with
 * the log it was seeded from plus everything the new process did. Checking only
 * the second would let a bug in the seed hide inside both halves.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createKernel, type Kernel } from '../../src/kernel.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import { ScriptedPrompter } from '../../src/cli/prompter.ts';
import { MemorySessionStore } from '../../src/session/store.ts';
import { Redactor } from '../../src/security/redactor.ts';
import {
  compareTerminalState,
  replayTerminalState,
  unansweredToolCalls,
} from '../../src/session/terminal-state.ts';
import { agentFile, skillFile } from '../helpers/workspace.ts';
import type { ModelRequest } from '../../src/model/ir.ts';
import type { EgressResponse, EgressTransport } from '../../src/security/egress-gate.ts';

const REPEATS = (() => {
  const raw = Number.parseInt(process.env.KERNEL_SOAK_REPEATS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

class Capture implements EgressTransport {
  readonly sent: string[] = [];
  async send(req: { url: string; headers: Record<string, string>; body?: string }): Promise<EgressResponse> {
    this.sent.push(`${req.url}\n${JSON.stringify(req.headers)}\n${req.body ?? ''}`);
    return { status: 200, headers: {}, body: '{}' };
  }
  text(): string {
    return this.sent.join('\n');
  }
}

interface Iteration {
  parentSteps: number;
  delegations: number;
  skillActivations: number;
  compactions: number;
  childFailures: number;
  deniedChildActions: number;
  editsApplied: number;
  testsRun: number;
  resumed: boolean;
  /** Every model request either scope made, for the leak surfaces. */
  requests: ModelRequest[];
  logText: string;
  canaryHits: string[];
  widened: string[];
}

const AGENTS = {
  '.mycoder/agents/reviewer.md': agentFile({
    name: 'reviewer',
    description: 'Read-only reviewer.',
    profile: 'read-only',
    tools: ['Read', 'Grep'],
    instructions: 'Report findings briefly.',
  }),
  '.mycoder/agents/fixer.md': agentFile({
    name: 'fixer',
    description: 'Applies small edits.',
    profile: 'workspace-dev',
    tools: ['Read', 'Edit', 'Shell'],
    instructions: 'Make the smallest change that works.',
  }),
  '.mycoder/agents/breaker.md': agentFile({
    name: 'breaker',
    description: 'A child that fails.',
    profile: 'read-only',
    // `Edit` is deliberately in the catalogue: the denial has to come from the
    // read-only *policy layer*, not from the tool being absent. Withholding the
    // tool would refuse the action for the wrong reason and leave the intersection
    // untested — the same trap the delegation suite hit twice.
    tools: ['Read', 'Edit'],
    instructions: 'You will fail.',
  }),
  '.mycoder/skills/review-only/SKILL.md': skillFile({
    name: 'review-only',
    description: 'Inspect and delegate, nothing else.',
    profile: 'read-only',
    tools: ['Read', 'Grep', 'Delegate', 'Skill'],
    instructions: 'SOAK_SKILL_MARKER: only inspect.',
  }),
  '.mycoder/skills/full/SKILL.md': skillFile({
    name: 'full',
    description: 'Everything the session already had.',
    instructions: 'SOAK_FULL_MARKER: no restriction beyond the session.',
  }),
};

/** One complete scenario. Returns what it observed, for the assertions below. */
async function runIteration(index: number): Promise<Iteration> {
  const canary = `SOAK_CANARY_${randomBytes(6).toString('hex')}`;
  const base = await mkdtemp(path.join(tmpdir(), `soak-${index}-`));
  const root = path.join(base, 'workspace');
  const big = 'y'.repeat(90_000);

  const files: Record<string, string> = {
    ...AGENTS,
    '.env': `SOAK_SECRET=${canary}\n`,
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
    'src/big.ts': `export const big = "${big}";\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  const store = new MemorySessionStore(new Redactor());
  const transport = new Capture();
  const requests: ModelRequest[] = [];
  const widened: string[] = [];

  const counters = {
    parentSteps: 0,
    delegations: 0,
    skillActivations: 0,
    childFailures: 0,
    deniedChildActions: 0,
    editsApplied: 0,
    testsRun: 0,
  };

  /** Receipt for a path out of whatever conversation is asking. */
  const receiptIn = (request: ModelRequest): string => {
    for (const message of [...request.messages].reverse()) {
      for (const part of message.parts) {
        if (part.type !== 'tool_result') continue;
        const match = /receiptId: (\S+)/.exec(part.content);
        if (match) return match[1]!;
      }
    }
    return 'rcp_missing';
  };

  /**
   * The scenario, as a function of the request.
   *
   * Written against *what the request is* rather than against a step index, so it
   * survives the kernel taking an extra step (a compaction, a retry) without the
   * script silently sliding out of alignment.
   */
  const respond = (request: ModelRequest): FakeStep => {
    requests.push(request);

    const system = request.system;
    const results = request.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'tool_result')
      .map((p) => (p.type === 'tool_result' ? p.content : ''));
    const lastResult = results.at(-1) ?? '';

    // --- children --------------------------------------------------------
    if (system.includes('the subagent "reviewer"')) {
      // A read-only child that reads, then reports.
      if (!lastResult.includes('receiptId')) {
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/b.ts' } }] };
      }
      return { kind: 'final', text: 'src/b.ts looks fine.' };
    }

    if (system.includes('the subagent "fixer"')) {
      if (results.length === 0) {
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] };
      }
      if (!results.some((r) => r.includes('changed') || r.includes('+'))) {
        return {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: {
                mode: 'replace',
                path: 'src/a.ts',
                receiptId: receiptIn(request),
                oldString: 'export const a = 1;',
                newString: `export const a = ${index + 2};`,
              },
            },
          ],
        };
      }
      // The edit-then-test cycle: the child verifies its own change.
      if (!results.some((r) => r.includes('exit 0') || r.includes('a ='))) {
        return { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['cat', 'src/a.ts'] } }] };
      }
      return { kind: 'final', text: 'Edited and verified.' };
    }

    if (system.includes('the subagent "breaker"')) {
      // A child that tries something it cannot do, then fails outright. Both
      // halves are needed: §31 wants a denied child action *and* a child failure.
      if (results.length === 0) {
        return {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: { mode: 'create', path: 'src/forbidden.ts', content: 'export const x = 1;\n' },
            },
          ],
        };
      }
      return {
        kind: 'error',
        error: {
          code: 'MODEL_TIMEOUT',
          message: 'the child gave up',
          retryable: true,
          blame: 'environment',
        },
      };
    }

    // --- the root agent ---------------------------------------------------
    counters.parentSteps += 1;

    // A child must never have handed the parent capability it lacks: the parent's
    // catalogue is checked on every step it takes.
    if (system.includes('SOAK_SKILL_MARKER')) {
      const offered = request.tools.map((t) => t.name);
      const illegal = offered.filter((t) => !['Read', 'Grep', 'Delegate', 'Skill'].includes(t));
      if (illegal.length > 0) widened.push(`step ${counters.parentSteps}: ${illegal.join(', ')}`);
    }

    switch (counters.parentSteps) {
      case 1:
        return { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'export const' } }] };
      case 2:
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] };
      case 3:
        return {
          kind: 'tools',
          calls: [{ name: 'Delegate', arguments: { agent: 'reviewer', task: 'Review src/b.ts.' } }],
        };
      // The failing child goes *before* the narrowing skill. Once `review-only` is
      // active the parent has no `Edit`, so neither would the child — and its
      // forbidden write would be refused as "not in the catalogue" instead of by
      // the read-only policy layer, which is the thing under test.
      case 4:
        return {
          kind: 'tools',
          calls: [{ name: 'Delegate', arguments: { agent: 'breaker', task: 'Try to write a new file.' } }],
        };
      case 5:
        return {
          kind: 'tools',
          calls: [{ name: 'Skill', arguments: { name: 'review-only', scope: 'turn' } }],
        };
      case 6:
        return { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'const b' } }] };
      case 7:
        return { kind: 'final', text: 'First stretch done.' };

      // Turn 2: the skill has expired with the turn, so Edit is available again.
      case 8:
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/b.ts' } }] };
      case 9:
        return {
          kind: 'tools',
          calls: [
            {
              name: 'Edit',
              arguments: {
                mode: 'replace',
                path: 'src/b.ts',
                receiptId: receiptIn(request),
                oldString: 'export const b = 2;',
                newString: 'export const b = 3;',
              },
            },
          ],
        };
      case 10:
        return { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['cat', 'src/b.ts'] } }] };
      case 11:
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/big.ts' } }] };
      case 12:
        return { kind: 'final', text: 'Second stretch done.' };

      // Turn 3: another skill, another delegation, more bulk.
      case 13:
        return { kind: 'tools', calls: [{ name: 'Skill', arguments: { name: 'full', scope: 'run' } }] };
      case 14:
        return {
          kind: 'tools',
          calls: [
            { name: 'Delegate', arguments: { agent: 'fixer', task: 'Bump the constant in src/a.ts.' } },
          ],
        };
      case 15:
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/big.ts' } }] };
      case 16:
        return { kind: 'final', text: 'Third stretch done.' };

      // Turn 4, after the restart.
      case 17:
        return { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'const a' } }] };
      case 18:
        return {
          kind: 'tools',
          calls: [{ name: 'Delegate', arguments: { agent: 'reviewer', task: 'Re-check src/b.ts.' } }],
        };
      case 19:
        return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/b.ts' } }] };
      case 20:
        return { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['cat', 'src/a.ts'] } }] };
      case 21:
        return { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'const' } }] };
      default:
        return { kind: 'final', text: 'Soak complete.' };
    }
  };

  const boot = async (resumeSessionId?: string): Promise<Kernel> =>
    createKernel({
      workspaceDir: root,
      dirsRoot: path.join(base, 'kernel-dirs'),
      store,
      fakeModel: new FakeModel({ responder: (request) => respond(request) }),
      egressTransport: transport,
      // Everything the scenario needs is allowed outright, so an unexpected
      // approval prompt shows up as a denial rather than as a hang.
      prompter: new ScriptedPrompter([]),
      logLevel: 'silent',
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });

  let kernel = await boot();
  const sessionId = kernel.sessionId;
  kernel.secrets.register('soak/canary', { kind: 'literal', value: canary });

  let compactions = 0;
  let resumed = false;

  try {
    for (const prompt of ['Start the soak.', 'Keep going.', 'And again.']) {
      const outcome = await kernel.session.runTurn(prompt);
      // A soak whose turns quietly fail is a soak that proves nothing: the scenario
      // below only reaches its later steps if the earlier turns completed. This is
      // how the `compacting → sampling` defect was found rather than absorbed.
      assert.equal(
        outcome.turn.state,
        'completed',
        `iteration ${index}, turn "${prompt}": ${outcome.error?.code ?? ''} ${outcome.error?.message ?? ''}`,
      );
    }

    // The pre-restart half of the gate, compared independently.
    const liveBefore = kernel.session.terminalState();
    const replayedBefore = await replayTerminalState(store, sessionId);
    const beforeComparison = compareTerminalState(liveBefore, replayedBefore);
    assert.equal(
      beforeComparison.equal,
      true,
      `iteration ${index}: pre-restart replay diverged:\n  ${beforeComparison.differences.join('\n  ')}`,
    );

    // --- restart ---------------------------------------------------------
    await kernel.shutdown();
    kernel = await boot(sessionId);
    kernel.secrets.register('soak/canary', { kind: 'literal', value: canary });
    resumed = true;

    for (const prompt of ['Continue after the restart.', 'Finish up.']) {
      const outcome = await kernel.session.runTurn(prompt);
      assert.equal(
        outcome.turn.state,
        'completed',
        `iteration ${index}, resumed turn "${prompt}": ${outcome.error?.code ?? ''} ${outcome.error?.message ?? ''}`,
      );
    }

    // --- observations ----------------------------------------------------
    const logLines: string[] = [];
    for await (const event of store.readEvents(sessionId)) {
      logLines.push(JSON.stringify(event));
      if (event.type === 'compaction.boundary') compactions += 1;
      if (event.type === 'delegation.started') counters.delegations += 1;
      if (event.type === 'skill.activated') counters.skillActivations += 1;
      if (event.type === 'delegation.failed') counters.childFailures += 1;
      if (event.type === 'file.edited') counters.editsApplied += 1;
      if (event.type === 'shell.executed') counters.testsRun += 1;
      if (event.type === 'policy.decision' && event.delegationId !== undefined) {
        counters.deniedChildActions += 1;
      }
    }
    const logText = logLines.join('\n');

    const live = kernel.session.terminalState();
    const replayed = await replayTerminalState(store, sessionId);
    const comparison = compareTerminalState(live, replayed);
    assert.equal(
      comparison.equal,
      true,
      `iteration ${index}: post-restart replay diverged:\n  ${comparison.differences.join('\n  ')}`,
    );
    assert.deepEqual(
      unansweredToolCalls(replayed),
      [],
      `iteration ${index}: the log contains tool calls with no result`,
    );

    // Every delegation that started also finished, in the log's own account.
    const started = logLines.filter((l) => l.includes('"type":"delegation.started"')).length;
    const finished = logLines.filter(
      (l) =>
        l.includes('"type":"delegation.completed"') ||
        l.includes('"type":"delegation.failed"') ||
        l.includes('"type":"delegation.cancelled"'),
    ).length;
    assert.equal(started, finished, `iteration ${index}: ${started - finished} orphan delegation(s)`);

    // §31 "budget exact": the session's own counters must match what the log
    // recorded, root and delegated together. A child whose usage was not charged
    // back would show up here as a smaller live number than the log's.
    const loggedRequests = logLines.filter((l) => l.includes('"type":"model.request.started"')).length;
    const loggedCalls = logLines.filter((l) => l.includes('"type":"tool.call"')).length;
    const usage = kernel.session.usageSnapshot;
    assert.equal(
      usage.modelRequests,
      loggedRequests,
      `iteration ${index}: the session counted ${usage.modelRequests} model requests, the log has ${loggedRequests}`,
    );
    assert.equal(
      usage.toolCalls,
      loggedCalls,
      `iteration ${index}: the session counted ${usage.toolCalls} tool calls, the log has ${loggedCalls}`,
    );

    const canaryHits: string[] = [];
    const surfaces: Array<[string, string]> = [
      ['model requests', requests.map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join('\n')],
      ['event log', logText],
      ['network capture', transport.text()],
      ['workspace file', await readFile(path.join(root, 'src', 'a.ts'), 'utf8')],
    ];
    for (const [name, text] of surfaces) {
      if (text.includes(canary)) canaryHits.push(name);
    }

    return {
      parentSteps: counters.parentSteps,
      delegations: counters.delegations,
      skillActivations: counters.skillActivations,
      compactions,
      childFailures: counters.childFailures,
      deniedChildActions: counters.deniedChildActions,
      editsApplied: counters.editsApplied,
      testsRun: counters.testsRun,
      resumed,
      requests,
      logText,
      canaryHits,
      widened,
    };
  } finally {
    await kernel.shutdown();
    await rm(base, { recursive: true, force: true });
  }
}

describe(`long-running delegated soak, N=${REPEATS} (§31)`, () => {
  test(`${REPEATS} iteration(s) preserve every invariant`, async () => {
    const iterations: Iteration[] = [];

    for (let i = 0; i < REPEATS; i += 1) {
      iterations.push(await runIteration(i));
    }

    for (const [i, it] of iterations.entries()) {
      const where = `iteration ${i}`;

      // §31's composition requirements. Asserted rather than assumed, so a script
      // that drifts out of alignment fails loudly instead of quietly soaking less.
      assert.ok(it.parentSteps >= 20, `${where}: only ${it.parentSteps} parent steps`);
      assert.ok(it.delegations >= 3, `${where}: only ${it.delegations} delegations`);
      assert.ok(it.skillActivations >= 2, `${where}: only ${it.skillActivations} skill activations`);
      assert.ok(it.compactions >= 2, `${where}: only ${it.compactions} compaction boundaries`);
      assert.ok(it.resumed, `${where}: no restart happened`);
      assert.ok(it.childFailures >= 1, `${where}: no child failed`);
      assert.ok(it.deniedChildActions >= 1, `${where}: no child action was denied`);
      assert.ok(it.editsApplied >= 1, `${where}: no edit was applied`);
      assert.ok(it.testsRun >= 1, `${where}: no verification command ran`);

      // The seven §31 assertions the loop above did not already make.
      assert.deepEqual(it.canaryHits, [], `${where}: the canary reached ${it.canaryHits.join(', ')}`);
      assert.deepEqual(it.widened, [], `${where}: the catalogue widened at ${it.widened.join('; ')}`);
    }

    // No state leak between iterations: each is a fresh workspace, a fresh store
    // and a fresh canary, so identical counts across iterations is the signal that
    // nothing carried over.
    const shape = (it: Iteration): string =>
      [it.parentSteps, it.delegations, it.skillActivations, it.editsApplied].join('/');
    const shapes = new Set(iterations.map(shape));
    assert.equal(
      shapes.size,
      1,
      `iterations diverged from one another: ${[...shapes].join(' vs ')} — state leaked between runs`,
    );

    process.stderr.write(
      `\n  soak: N=${REPEATS}, ${iterations[0]!.parentSteps} parent steps, ` +
        `${iterations[0]!.delegations} delegations, ${iterations[0]!.skillActivations} skill activations, ` +
        `${iterations[0]!.compactions} compactions per iteration\n`,
    );
  });
});
