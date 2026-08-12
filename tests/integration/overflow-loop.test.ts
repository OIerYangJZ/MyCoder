/**
 * Context overflow must not become a loop (§23, §50 "Failure handling").
 *
 * When the provider rejects a request as too large, the session compacts and
 * retries. If compaction does not actually shrink the request — a single message
 * larger than the window, a provider counting tokens differently than we do —
 * the retry overflows again, and the obvious implementation spins forever
 * burning real money on requests that are all rejected.
 *
 * The bound is the loop budget rather than a dedicated retry counter. That is a
 * deliberate choice (one budget to reason about instead of two), but it is only
 * a real bound if the overflow path actually consumes steps, which is what these
 * tests check. Nothing else asserts it: the offline trajectory never overflows,
 * and the golden task compacts successfully on the first attempt.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FakeModel } from '../../src/model/adapters/fake.ts';
import { kernelError } from '../../src/util/errors.ts';
import { createTestWorkspace } from '../helpers/workspace.ts';

const OVERFLOW = kernelError('MODEL_CONTEXT_OVERFLOW', 'The request exceeded the model context window.', {
  blame: 'kernel',
  retryable: false,
});

/** A model that never stops reporting overflow, however much we compact. */
function alwaysOverflows(): { model: FakeModel; calls: () => number } {
  let calls = 0;
  const model = new FakeModel({
    responder: () => {
      calls += 1;
      return { kind: 'error', error: OVERFLOW };
    },
  });
  return { model, calls: () => calls };
}

async function runUntilItStops(
  maxModelRequests: number,
): Promise<{ state: string; requests: number; code?: string }> {
  const ws = await createTestWorkspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  try {
    const { model, calls } = alwaysOverflows();
    (ws.kernel.modelRuntime as unknown as { routes: Map<string, unknown> }).routes.set('fake', model);
    // The overflow retry consumes a model request, not a tool call, so that is
    // the budget that has to bound it — and the one that bounds the cost.
    ws.kernel.session.setTurnBudget({ maxModelRequests });

    // If the bound is missing this never returns, so the suite's own timeout is
    // the backstop. A hang here is the defect, not a flaky test.
    await ws.kernel.session.runTurn('do something that will not fit');

    const turn = ws.kernel.session.turn!;
    return {
      state: turn.state,
      requests: calls(),
      ...(turn.error ? { code: turn.error.code } : {}),
    };
  } finally {
    await ws.cleanup();
  }
}

describe('a provider that always reports overflow cannot spin forever', () => {
  test('the turn terminates instead of retrying without limit', async () => {
    const outcome = await runUntilItStops(6);

    assert.equal(outcome.state, 'failed', 'an unrecoverable overflow must fail the turn, not hang');
    assert.ok(outcome.requests > 1, 'compaction should have been attempted at least once');
    assert.ok(
      outcome.requests <= 7,
      `the overflow path made ${outcome.requests} requests against a 6-request budget — ` +
        'each retry must consume one, or the budget does not bound it',
    );
  });

  test('a tighter budget produces proportionally fewer billed requests', async () => {
    // The point of the bound is cost, so it has to actually track the budget
    // rather than merely being finite.
    const tight = await runUntilItStops(2);
    const loose = await runUntilItStops(10);

    assert.ok(
      tight.requests < loose.requests,
      `a 2-request budget made ${tight.requests} and a 10-request budget made ${loose.requests}; ` +
        'the overflow retry is not governed by the budget',
    );
  });

  test('the failure names the budget, not the overflow', async () => {
    // The user needs to know the run was stopped, not that one request was too
    // big — the latter reads as "try again", which would repeat the cost.
    const outcome = await runUntilItStops(4);
    assert.equal(outcome.code, 'LOOP_BUDGET_EXCEEDED', `turn failed with ${outcome.code}`);
  });
});
