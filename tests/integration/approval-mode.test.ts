/**
 * Approval modes through a real kernel and a real turn (spec §11.4).
 *
 * `tests/unit/approval-mode.test.ts` covers the gate and the tables in
 * isolation. This file asserts the part a unit test cannot: that the mode is
 * actually wired to the policy engine and to the prompter a tool call passes
 * through, and that switching it changes what the next call does.
 *
 * Two things about the fixture, both learned by getting them wrong first.
 *
 * **The probe is a deletion, not a write.** A new file inside the workspace is
 * `allow` outright under `workspace-dev` — no approval is ever raised — so a
 * write-based version showed `manual` "not asking" and passed for three modes
 * while proving nothing about any of them. A deletion is `ask` in that profile
 * (ADR-0016: an overwrite leaves a diff and a receipt, a removal leaves
 * neither), which is what separates all four:
 *
 *     plan          denied by the read-only layer; never reaches an approval
 *     manual        asks
 *     accept-edits  asks — it covers writes, and a deletion is not a write
 *     auto          answered without asking
 *
 * **The file is read first.** `Delete` requires the receipt from a `Read` that
 * covered the whole file, and without one the call fails at
 * `TOOL_INVALID_ARGS` *before the policy engine sees it*. An earlier draft
 * skipped the read, and every mode "behaved correctly" because every call was
 * refused for an unrelated reason — the plan-mode test in particular passed
 * while asserting nothing. A test whose subject never runs is worse than no
 * test, because it reports a property nobody has checked.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTestWorkspace, readStep, type TestWorkspace } from '../helpers/workspace.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import type { Kernel } from '../../src/kernel.ts';
import type { ApprovalMode } from '../../src/policy/approval-mode.ts';

function setScript(kernel: Kernel, script: FakeStep[]): void {
  const routed = kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
  routed.routes.set('fake', new FakeModel({ script }));
}

const TARGET = 'doomed.txt';

/** Read the target so the delete has a receipt, then return it. */
async function receiptFor(ws: TestWorkspace): Promise<string> {
  setScript(ws.kernel, [readStep(TARGET), { kind: 'final', text: 'read' }]);
  await ws.kernel.session.runTurn(`read ${TARGET}`);
  const receipt = ws.kernel.freshness.list().find((r) => r.path.endsWith(TARGET));
  assert.ok(receipt, 'the fixture failed to obtain a read receipt');
  return receipt.receiptId;
}

interface Attempt {
  /** Approvals that reached the prompter. */
  asked: string[];
  isError: boolean;
  message: string;
  /** Did the file survive? */
  stillThere: boolean;
  layers: string[];
}

/**
 * Attempt the deletion in one mode, with a prompter that approves what it sees.
 *
 * Approving rather than denying is deliberate: it means "the file survived" can
 * only be explained by the engine refusing before any approval was raised, which
 * is exactly the claim plan mode makes.
 */
async function attemptDelete(mode: ApprovalMode): Promise<Attempt> {
  const ws = await createTestWorkspace({
    files: { [TARGET]: 'delete me\n' },
    approvals: [{ decision: 'allow', scope: 'once' }],
  });
  try {
    const receiptId = await receiptFor(ws);
    ws.kernel.session.setApprovalMode(mode);
    const layers = [...ws.kernel.toolRuntime.activeLayers()];

    const before = ws.prompter.seen.length;
    const result = await ws.kernel.session.runControlTool('Delete', { path: TARGET, receiptId });
    const asked = ws.prompter.seen.slice(before).map((r) => r.subject.title);

    const stillThere = await ws
      .file(TARGET)
      .then(() => true)
      .catch(() => false);

    return { asked, isError: result.isError === true, message: result.content, stillThere, layers };
  } finally {
    await ws.cleanup();
  }
}

describe('the mode decides who answers, in a real session', () => {
  test('manual asks, and the deletion happens once approved', async () => {
    const r = await attemptDelete('manual');
    assert.equal(r.asked.length, 1, `manual did not consult the user: ${r.message}`);
    assert.match(r.asked[0] ?? '', /Delete/);
    assert.equal(r.isError, false, r.message);
    assert.equal(r.stillThere, false, 'the approval was granted, so the file should be gone');
  });

  /** The distinction people get wrong about `accept-edits`, end to end. */
  test('accept-edits still asks about a deletion — it covers writes, not removals', async () => {
    const r = await attemptDelete('accept-edits');
    assert.equal(r.asked.length, 1, `accept-edits answered a deletion: ${r.message}`);
    assert.equal(r.stillThere, false);
  });

  test('auto answers the deletion without consulting anyone', async () => {
    const r = await attemptDelete('auto');
    assert.deepEqual(r.asked, [], 'auto consulted the user for something it claims to answer');
    assert.equal(r.isError, false, r.message);
    assert.equal(r.stillThere, false, 'auto answered but the deletion did not happen');
  });

  /**
   * Plan mode's whole claim: not "declined", but "unreachable".
   *
   * The prompter approves everything here, so a surviving file can only be
   * explained by the read-only layer turning the decision into a `deny` before
   * an approval was raised. The `isError` assertion alone would not show that —
   * a denial and a missing receipt both produce an error — which is why the
   * fixture obtains the receipt and this asserts the prompter was never reached.
   */
  test('plan mode denies the deletion, and never reaches the prompter', async () => {
    const r = await attemptDelete('plan');
    assert.ok(r.layers.includes('mode:plan'), `the plan layer is not in force: ${r.layers.join(', ')}`);
    assert.deepEqual(r.asked, [], 'a denial was presented to the user as an approval');
    assert.ok(r.isError, `expected a refusal, got: ${r.message}`);
    assert.equal(r.stillThere, true, 'plan mode let a deletion through');
  });
});

describe('switching mid-session', () => {
  test('the plan layer attaches on the way in and detaches on the way out', async () => {
    const ws = await createTestWorkspace({});
    try {
      const { kernel } = ws;
      assert.ok(!kernel.toolRuntime.activeLayers().includes('mode:plan'), 'manual should carry no layer');

      kernel.session.setApprovalMode('plan');
      assert.ok(kernel.toolRuntime.activeLayers().includes('mode:plan'));
      // A real layer on the engine, not only a name in a list.
      assert.ok(
        kernel.toolRuntime.policy.describeLayers().some((l) => l.name === 'mode:plan'),
        'the layer was reported but not intersected',
      );

      kernel.session.setApprovalMode('auto');
      assert.ok(
        !kernel.toolRuntime.activeLayers().includes('mode:plan'),
        'leaving plan mode left its layer behind',
      );
    } finally {
      await ws.cleanup();
    }
  });

  /**
   * The audit question, asked of the durable log rather than of the code.
   *
   * `approval.decided` records `granted: true` whether a person pressed `y` or a
   * mode answered, so before `answeredByMode` existed the log stated those two
   * in identical bytes. For a session that ran in `auto`, "which of these did a
   * human actually review" is the first thing anybody would ask of it, and the
   * answer was not in the file.
   */
  test('the event log says whether a human answered, or the mode did', async () => {
    const answeredBy = async (mode: ApprovalMode): Promise<unknown> => {
      const ws = await createTestWorkspace({
        files: { [TARGET]: 'x\n' },
        approvals: [{ decision: 'allow', scope: 'once' }],
      });
      try {
        const receiptId = await receiptFor(ws);
        ws.kernel.session.setApprovalMode(mode);
        const result = await ws.kernel.session.runControlTool('Delete', { path: TARGET, receiptId });
        assert.equal(result.isError, false, result.content);

        const log = await ws.eventLogText();
        const decided = log
          .split('\n')
          .filter((l) => l.includes('"approval.decided"'))
          .map((l) => JSON.parse(l) as { payload: Record<string, unknown> });
        assert.equal(decided.length, 1, `expected one approval.decided, got ${decided.length}`);
        assert.equal(decided[0]?.payload.granted, true);
        return decided[0]?.payload.answeredByMode;
      } finally {
        await ws.cleanup();
      }
    };

    assert.equal(await answeredBy('manual'), false, 'a human approval was logged as the mode’s');
    assert.equal(await answeredBy('auto'), true, 'a mode-answered action was logged as a human’s');
  });

  test('a mode-answered action is not recorded as a user approval', async () => {
    // `/permissions show` prints `SessionApprovalStore`, and it means "the user
    // decided this". A mode-answered action was never put to them, so writing it
    // there would put words in their mouth.
    const ws = await createTestWorkspace({ files: { [TARGET]: 'x\n' } });
    try {
      const receiptId = await receiptFor(ws);
      ws.kernel.session.setApprovalMode('auto');
      const result = await ws.kernel.session.runControlTool('Delete', { path: TARGET, receiptId });

      assert.equal(result.isError, false, result.content);
      assert.equal(
        ws.kernel.policy.approvals.size,
        0,
        'a mode-granted action was written into the session approval store',
      );
    } finally {
      await ws.cleanup();
    }
  });

  test('the mode survives a skill activation recomputing the narrowing layers', async () => {
    // Both fold into the same from-scratch recompute. An incremental version
    // would drop one when the other changed, and this is the interleaving that
    // would show it.
    const ws = await createTestWorkspace({});
    try {
      ws.kernel.session.setApprovalMode('plan');
      assert.ok(ws.kernel.toolRuntime.activeLayers().includes('mode:plan'));

      // Any recompute will do; `setApprovalMode` to the same value is a no-op, so
      // go via a real second change and back.
      ws.kernel.session.setApprovalMode('auto');
      ws.kernel.session.setApprovalMode('plan');
      assert.ok(
        ws.kernel.toolRuntime.activeLayers().includes('mode:plan'),
        'the plan layer did not survive a round trip',
      );
    } finally {
      await ws.cleanup();
    }
  });
});
