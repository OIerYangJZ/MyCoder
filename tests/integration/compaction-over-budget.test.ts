/**
 * When compaction cannot reach the budget, something has to say so (alpha.12).
 *
 * `compact` has a branch for the case where the recent tail alone exceeds the
 * budget, and its comment says to "report it rather than silently discarding
 * recent, load-bearing context". Nothing was reporting it: `maybeCompact`
 * appended the boundary event and returned, and the turn then sent the oversized
 * request.
 *
 * Measured on a live run against a deliberately small window:
 *
 *     compaction.boundary  droppedMessages: 0  tokensBefore: 8460  tokensAfter: 8460
 *     budget               6000
 *     next request         10,264 input tokens
 *
 * Nothing in the session, the log or the transcript said the context was over
 * budget. The next thing that would have happened on a model whose declared
 * window is accurate is a provider length error, attributable to nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { compact, needsCompaction } from '../../src/context/compaction.ts';
import { ModelRegistry, CONTEXT_SAFETY_MARGIN_TOKENS } from '../../src/model/profiles.ts';
import type { ModelMessage } from '../../src/model/ir.ts';
import { createTestWorkspace } from '../helpers/workspace.ts';

/** One exchange: a user turn and an assistant turn carrying a large tool result. */
function exchange(n: number, bytes: number): ModelMessage[] {
  return [
    { role: 'user', parts: [{ type: 'text', text: `question ${n}` }], origin: { kind: 'user' } },
    {
      role: 'assistant',
      parts: [{ type: 'text', text: 'x'.repeat(bytes) }],
      origin: { kind: 'assistant' },
    },
  ];
}

describe('compaction reports when it could not get under budget', () => {
  test('a tail that is entirely recent is kept, and the result says it did not shrink', () => {
    // Two exchanges, both inside the preserved window, both large.
    const messages = [...exchange(1, 12_000), ...exchange(2, 12_000)];
    const result = compact(messages, 'system prompt', { budgetTokens: 2_000 });

    assert.equal(result.droppedMessages, 0, 'recent, load-bearing context must not be discarded');
    assert.equal(
      result.tokensAfter,
      result.tokensBefore,
      'nothing was dropped, so nothing should have shrunk',
    );
    // And the caller can tell: the figure it returns is still over the budget it
    // was given. This is the signal `maybeCompact` now acts on.
    assert.ok(
      needsCompaction(result.tokensAfter, 2_000),
      'the result must remain recognisably over budget, or nobody can report it',
    );
  });

  test('when there is an older head, compaction does shrink it — the control', () => {
    const messages = [...exchange(1, 20_000), ...exchange(2, 200), ...exchange(3, 200), ...exchange(4, 200)];
    const result = compact(messages, 'system prompt', { budgetTokens: 2_000 });
    assert.ok(result.droppedMessages > 0, 'an older head should have been summarised');
    assert.ok(result.tokensAfter < result.tokensBefore);
  });
});

describe('the safety margin is what hides the tool schemas', () => {
  /**
   * The estimate counts the system prompt and the messages, never the tool
   * schemas, and every request carries those. A live first request measured 845
   * estimated against 3,436 billed — a 2,591-token gap that the margin absorbs.
   *
   * This pins the relationship rather than the numbers: the margin must stay
   * large enough to cover what the estimate omits, and the session warns when it
   * stops being.
   */
  test('the margin is a named constant, not a literal nobody can find', () => {
    assert.equal(typeof CONTEXT_SAFETY_MARGIN_TOKENS, 'number');
    assert.ok(CONTEXT_SAFETY_MARGIN_TOKENS > 0);
  });

  test('the default budget is the window less the reservation and the margin', () => {
    const profile = {
      family: 't',
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      reservedOutputTokens: 8_000,
      supportsParallelTools: false,
      supportsReasoning: false,
      preferredEditStrategy: 'exact' as const,
      autonomy: 'normal' as const,
      toolReliability: 'medium' as const,
    };
    assert.equal(ModelRegistry.usableContextTokens(profile), 100_000 - 8_000 - CONTEXT_SAFETY_MARGIN_TOKENS);
  });

  test('a window smaller than its own overheads still leaves a floor', () => {
    // The clamp matters: without it a small declared window produces a negative
    // budget and compaction runs on every step forever.
    const tiny = {
      family: 't',
      contextWindow: 1_000,
      maxOutputTokens: 500,
      reservedOutputTokens: 500,
      supportsParallelTools: false,
      supportsReasoning: false,
      preferredEditStrategy: 'exact' as const,
      autonomy: 'normal' as const,
      toolReliability: 'medium' as const,
    };
    assert.equal(ModelRegistry.usableContextTokens(tiny), 1_000);
  });
});

/**
 * The model is the only party that can act on being over budget, so it is told.
 *
 * The precedent is the turn budget: a limit enforced against a model that was
 * never told it existed produces a turn stopping for no reason the model can
 * explain. Over-budget context is the same shape, except the stop is a provider
 * length error rather than a clean halt.
 */
describe('the over-budget condition reaches the model, not just the log', () => {
  test('a critical fact lands in the system prompt the next step is built from', async () => {
    const ws = await createTestWorkspace({});
    try {
      ws.kernel.context.addFact({
        id: 'context-over-budget',
        priority: 'critical',
        text: 'Context is over budget: about 8444 tokens against a 6000-token window.',
      });

      const system = ws.kernel.projector.project(
        ws.kernel.context,
        ws.kernel.context.repository.facts,
      ).system;

      assert.match(system, /Context is over budget/);
      assert.match(system, /8444 tokens against a 6000-token window/);
    } finally {
      await ws.cleanup();
    }
  });
});

/**
 * The fix itself: a session that cannot compact under budget says so.
 *
 * The pieces above are necessary and none of them is sufficient — with the
 * reporting removed from `maybeCompact` they all still pass, which is how this
 * test came to exist. This drives a real session into the state and asserts what
 * the session did about it.
 */
describe('a session over budget records it and tells the model', () => {
  /** Enough text that two exchanges alone exceed the fake profile's 3,000-token budget. */
  const BIG = 'x '.repeat(6_000);

  test('the boundary event says overBudget, and a fact is injected', async () => {
    const ws = await createTestWorkspace({
      script: [
        { kind: 'final', text: BIG },
        { kind: 'final', text: BIG },
        { kind: 'final', text: 'done' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('first');
      await ws.kernel.session.runTurn('second');
      await ws.kernel.session.runTurn('third');

      const log = await ws.eventLogText();
      const boundaries = log
        .split('\n')
        .filter((l) => l.includes('"compaction.boundary"'))
        .map((l) => JSON.parse(l) as { payload: Record<string, unknown> });

      assert.ok(boundaries.length > 0, 'compaction never ran, so the fixture proves nothing');
      const over = boundaries.filter((b) => b.payload.overBudget === true);
      assert.ok(
        over.length > 0,
        `no boundary reported overBudget: ${JSON.stringify(boundaries.map((b) => b.payload))}`,
      );
      // The budget travels with it, so a reader does not have to recompute it.
      assert.equal(typeof over[0]?.payload.budgetTokens, 'number');

      // And the model was told, which is the half a log cannot do.
      const system = ws.kernel.projector.project(
        ws.kernel.context,
        ws.kernel.context.repository.facts,
      ).system;
      assert.match(system, /Context is over budget/);
      assert.match(system, /Stop reading new files/);
    } finally {
      await ws.cleanup();
    }
  });
});
