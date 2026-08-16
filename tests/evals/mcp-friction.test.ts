/**
 * The friction metric covers foreign tools from the first run (alpha.9 §17).
 *
 * §17's point is not that MCP tools should be counted — they are, because
 * `toolFrictionFromLog` keys by name and `mcp__wiki__search` is a name. It is
 * that shipping an MCP surface with the same "zero defects" unfalsifiability the
 * tool surface had before alpha.7 would be unforgivable, given the machinery now
 * exists.
 *
 * So the assertions below are about the *partition*: that the builtin half can
 * be read separately in both arms, because alpha.7's finding was that adding a
 * tool makes a **different** tool harder to call, and a total hides exactly that.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  toolFrictionFromLog,
  splitFriction,
  wastedCallRatio,
  mergeFriction,
} from '../../evals/runners/run.ts';

/** One event-log line. The metric is derived from the log, never from a run. */
function ev(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, payload });
}

const WITH_SERVER = [
  ev('tool.call', { name: 'Read', toolCallId: 'c1', argsHash: 'a' }),
  ev('tool.call', { name: 'mcp__wiki__search', toolCallId: 'c2', argsHash: 'b' }),
  ev('tool.error', { name: 'mcp__wiki__search', toolCallId: 'c2', errorCode: 'TOOL_DENIED' }),
  ev('tool.call', { name: 'mcp__wiki__search', toolCallId: 'c3', argsHash: 'b' }),
  ev('tool.error', { name: 'mcp__wiki__search', toolCallId: 'c3', errorCode: 'TOOL_DENIED' }),
  ev('tool.call', { name: 'Read', toolCallId: 'c4', argsHash: 'c' }),
  ev('tool.error', { name: 'Read', toolCallId: 'c4', errorCode: 'STALE_FILE' }),
].join('\n');

const WITHOUT_SERVER = [
  ev('tool.call', { name: 'Read', toolCallId: 'c1', argsHash: 'a' }),
  ev('tool.call', { name: 'Read', toolCallId: 'c2', argsHash: 'c' }),
].join('\n');

describe('foreign tools are measured like every other tool', () => {
  test('calls, errors, repeats and codes are all counted for an MCP tool', () => {
    const table = toolFrictionFromLog(WITH_SERVER);
    const search = table['mcp__wiki__search'];

    assert.ok(search, 'an MCP tool must appear in the friction table');
    assert.equal(search.calls, 2);
    assert.equal(search.errors, 2);
    // Two identical calls: the model did not understand the first rejection,
    // which is the signal `repeats` exists to make visible.
    assert.equal(search.repeats, 1);
    assert.deepEqual(search.codes, { TOOL_DENIED: 2 });
  });

  test("the split separates the kernel's tools from the ones it did not write", () => {
    const { builtin, foreign } = splitFriction(toolFrictionFromLog(WITH_SERVER));

    assert.deepEqual(Object.keys(builtin), ['Read']);
    assert.deepEqual(Object.keys(foreign), ['mcp__wiki__search']);
  });

  test('the builtin half is readable in both arms, which is the actual question', () => {
    // alpha.7 found that adding a tool can make a *different* tool harder to
    // call. That is only visible if `Read`'s rejection rate can be compared
    // across arms without the foreign tool's rejections in the denominator.
    const withServer = splitFriction(toolFrictionFromLog(WITH_SERVER));
    const withoutServer = splitFriction(toolFrictionFromLog(WITHOUT_SERVER));

    assert.equal(wastedCallRatio(withServer.builtin), 0.5);
    assert.equal(wastedCallRatio(withoutServer.builtin), 0);
    assert.equal(Object.keys(withoutServer.foreign).length, 0);

    // And the total would have hidden it: 3 errors over 5 calls is neither of
    // the two numbers above, and is not the number the question is about.
    assert.notEqual(wastedCallRatio(toolFrictionFromLog(WITH_SERVER)), wastedCallRatio(withServer.builtin));
  });

  test('NEGATIVE CONTROL: the split is not a rename of the whole table', () => {
    // Without this, a `splitFriction` that put everything in `builtin` and
    // nothing in `foreign` would pass the arm comparison above, because the
    // arm with no server has no foreign tools either.
    const { builtin, foreign } = splitFriction(toolFrictionFromLog(WITH_SERVER));
    assert.ok(Object.keys(foreign).length > 0, 'foreign must not be empty when a server was used');
    assert.equal(Object.keys(builtin).includes('mcp__wiki__search'), false);
  });

  test('merging across attempts keeps the two halves separable', () => {
    const merged = mergeFriction([toolFrictionFromLog(WITH_SERVER), toolFrictionFromLog(WITHOUT_SERVER)]);
    const { builtin, foreign } = splitFriction(merged);

    assert.equal(builtin['Read']!.calls, 4);
    assert.equal(foreign['mcp__wiki__search']!.calls, 2);
  });
});
