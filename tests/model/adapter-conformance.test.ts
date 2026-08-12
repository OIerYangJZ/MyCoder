/**
 * Offline provider conformance (alpha.2 §25, §26, §48).
 *
 * Drives sanitized wire fixtures through the *real* path:
 *
 *     fixture bytes -> decodeSse -> adapter.translate -> collectModelEvents
 *
 * No credentials, no network, fully deterministic — so adapter behaviour stays
 * regression-tested in ordinary CI even though live validation is a separate,
 * manually-dispatched job (§27, §49).
 *
 * Each case names the normalized IR it expects. That is the point of the
 * milestone: the assertions below are written in terms of the internal IR only,
 * so if a provider quirk ever leaks upward it shows up here as a test that
 * suddenly needs to know a vendor field name.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

import { AnthropicMessagesAdapter } from '../../src/model/adapters/anthropic.ts';
import { newAdapterState, type ProtocolAdapter } from '../../src/model/runtime.ts';
import { collectModelEvents, type ModelEvent, type ModelTurn } from '../../src/model/ir.ts';
import { decodeSse, stringStream } from '../../src/util/sse.ts';

const FIXTURES = path.join(process.cwd(), 'tests', 'model', 'fixtures', 'anthropic');
// Typed as the interface rather than the class: these assertions must hold for
// any adapter, and typing to the concrete class would let a provider-specific
// method quietly become part of what the suite depends on.
const adapter: ProtocolAdapter = new AnthropicMessagesAdapter();

/** Run a `.sse` fixture through the decoder and the adapter. */
async function runFixture(
  name: string,
  opts: { chunkSize?: number } = {},
): Promise<{ turn: ModelTurn; events: ModelEvent[] }> {
  const raw = await readFile(path.join(FIXTURES, name), 'utf8');

  // Split the fixture into arbitrary byte chunks so the decoder is tested at
  // boundaries the wire actually produces — a record split mid-JSON is the
  // normal case, not an edge case.
  const size = opts.chunkSize ?? raw.length;
  const chunks: string[] = [];
  for (let i = 0; i < raw.length; i += size) chunks.push(raw.slice(i, i + size));

  const state = newAdapterState('req_fixture');
  const events: ModelEvent[] = [];

  for await (const message of decodeSse(stringStream(chunks))) {
    for (const event of adapter.translate(message, state)) events.push(event);
    if (state.finished) break;
  }
  if (adapter.finish) for (const event of adapter.finish(state)) events.push(event);

  const turn = await collectModelEvents(
    (async function* () {
      yield { type: 'stream_start', requestId: 'req_fixture' } as ModelEvent;
      for (const event of events) yield event;
    })(),
  );

  return { turn, events };
}

async function httpFixture(
  name: string,
): Promise<{ status: number; body: string; retryAfterSeconds?: number }> {
  const parsed = JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8')) as {
    status: number;
    body: unknown;
    retryAfterSeconds?: number;
  };
  return {
    status: parsed.status,
    body: JSON.stringify(parsed.body),
    ...(parsed.retryAfterSeconds !== undefined ? { retryAfterSeconds: parsed.retryAfterSeconds } : {}),
  };
}

// --- §25 sanitisation -------------------------------------------------------

describe('fixtures are sanitized (§25)', () => {
  test('no fixture contains a credential, a real id, or private source', async () => {
    const files = (await readdir(FIXTURES)).filter((f) => f.endsWith('.sse') || f.endsWith('.json'));
    assert.ok(files.length >= 15, `expected the full fixture set, found ${files.length}`);

    const forbidden: Array<{ pattern: RegExp; why: string }> = [
      { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/, why: 'looks like a real Anthropic key' },
      { pattern: /sk-[A-Za-z0-9]{20,}/, why: 'looks like a real API key' },
      { pattern: /CANARY_SECRET/, why: 'the canary must not be used as fixture content (§38)' },
      { pattern: /"x-api-key"/i, why: 'fixtures must not carry auth headers' },
      { pattern: /authorization/i, why: 'fixtures must not carry auth headers' },
    ];

    for (const file of files) {
      const content = await readFile(path.join(FIXTURES, file), 'utf8');
      for (const { pattern, why } of forbidden) {
        assert.equal(pattern.test(content), false, `${file}: ${why}`);
      }
    }
  });

  test('every message and tool id is fixture-prefixed', async () => {
    // A fixture captured from a real session would carry real ids. Requiring the
    // prefix makes "I forgot to sanitise" a test failure rather than a commit.
    const files = (await readdir(FIXTURES)).filter((f) => f.endsWith('.sse'));
    for (const file of files) {
      const content = await readFile(path.join(FIXTURES, file), 'utf8');
      for (const m of content.matchAll(/"(?:id|tool_use_id)"\s*:\s*"([^"]+)"/g)) {
        assert.match(m[1]!, /FIXTURE/, `${file}: id ${m[1]} is not fixture-prefixed`);
      }
    }
  });
});

// --- §9, §10 text streaming -------------------------------------------------

describe('text streaming (§10)', () => {
  test('fragmented text assembles in order, exactly once', async () => {
    const { turn } = await runFixture('text-stream.sse');

    assert.equal(turn.text, 'Hello', 'the three deltas H/el/lo must assemble to exactly "Hello"');
    assert.equal(turn.finishReason, 'completed');
    assert.equal(turn.rawFinishReason, 'end_turn');
    assert.deepEqual(turn.toolCalls, []);
  });

  test('assembly does not depend on HTTP chunk boundaries (§10)', async () => {
    // Same fixture, cut at hostile sizes. A decoder that assumed a record never
    // spans a chunk would produce different text here.
    const whole = (await runFixture('text-stream.sse')).turn;
    for (const chunkSize of [1, 3, 7, 64, 997]) {
      const { turn } = await runFixture('text-stream.sse', { chunkSize });
      assert.equal(turn.text, whole.text, `chunkSize=${chunkSize} changed the assembled text`);
      assert.equal(turn.finishReason, whole.finishReason, `chunkSize=${chunkSize} changed the finish reason`);
    }
  });

  test('usage is normalized from message_start and message_delta (§17)', async () => {
    const { turn } = await runFixture('text-stream.sse');
    assert.equal(turn.usage.inputTokens, 25);
    assert.equal(turn.usage.outputTokens, 15);
  });
});

// --- §11 tool call streaming ------------------------------------------------

describe('tool call streaming (§11)', () => {
  test('a tool call arrives complete, never as wire fragments', async () => {
    const { turn, events } = await runFixture('tool-call-stream.sse');

    assert.equal(turn.text, 'Let me look at that file.');
    assert.equal(turn.toolCalls.length, 1);
    assert.equal(turn.toolCalls[0]?.name, 'Read');
    assert.deepEqual(turn.toolCalls[0]?.arguments, { path: 'src/auth.ts' });
    assert.equal(turn.finishReason, 'tool_calls');

    // The IR must contain a start/delta/end sequence — ToolRuntime only ever
    // sees the assembled `tool_call` part, never a partial_json string.
    const kinds = events.map((e) => e.type);
    assert.ok(kinds.includes('tool_call_start'));
    assert.ok(kinds.includes('tool_call_delta'));
    assert.ok(kinds.includes('tool_call_end'));
  });

  test('heavily fragmented arguments assemble correctly', async () => {
    const { turn } = await runFixture('tool-call-fragmented.sse');

    assert.deepEqual(turn.toolCalls[0]?.arguments, {
      mode: 'replace',
      path: 'src/a.ts',
      oldString: 'a - b',
      newString: 'a + b',
      receiptId: 'rcp_1',
    });
  });

  test('fragmented assembly survives hostile chunk boundaries', async () => {
    for (const chunkSize of [1, 5, 13]) {
      const { turn } = await runFixture('tool-call-fragmented.sse', { chunkSize });
      assert.equal(
        (turn.toolCalls[0]?.arguments as { newString?: string }).newString,
        'a + b',
        `chunkSize=${chunkSize} corrupted the assembled arguments`,
      );
    }
  });

  test('parallel tool calls keep distinct ids (§13)', async () => {
    const { turn } = await runFixture('parallel-tools.sse');

    assert.equal(turn.toolCalls.length, 2);
    const ids = turn.toolCalls.map((c) => c.id);
    assert.equal(new Set(ids).size, 2, 'parallel calls must not collide on id');
    assert.deepEqual(
      turn.toolCalls.map((c) => c.name),
      ['Read', 'Grep'],
    );
    assert.deepEqual(turn.toolCalls[1]?.arguments, { pattern: 'export const' });
  });
});

// --- §12, §43 malformed and interrupted -------------------------------------

describe('malformed and interrupted streams (§12, §43)', () => {
  test('invalid JSON becomes a tool call with unparsed arguments, not a crash', async () => {
    const { turn } = await runFixture('malformed-tool-args.sse');

    // Invariant 1 starts here: the call must exist so it can be answered with
    // TOOL_INVALID_ARGS. Dropping it would lose the exchange entirely.
    assert.equal(turn.toolCalls.length, 1);
    assert.deepEqual(turn.toolCalls[0]?.arguments, { __unparsed: '{"path": "src/a.ts' });
  });

  test('a stream cut mid-arguments never fabricates a completed call (§43)', async () => {
    const { turn } = await runFixture('stream-cut-mid-tool-args.sse');

    // The call is preserved — it was started, so it must be closed — but its
    // arguments must not be invented from the partial fragment.
    assert.equal(turn.toolCalls.length, 1);
    assert.equal(turn.toolCalls[0]?.name, 'Shell');
    assert.deepEqual(
      turn.toolCalls[0]?.arguments,
      { __unparsed: '{"argv": ["rm", "-rf"' },
      'a truncated argv must stay unparsed rather than becoming a runnable command',
    );

    // And schema validation is what stops it: `__unparsed` is not a valid Shell
    // argument set, so ToolRuntime rejects it before anything executes.
    assert.equal(Object.prototype.hasOwnProperty.call(turn.toolCalls[0]?.arguments as object, 'argv'), false);
  });

  test('a stream that ends with no terminal event is reported as truncated', async () => {
    const { turn } = await runFixture('stream-cut-mid-tool-args.sse');
    // There are tool calls, so the collector normalises to tool_calls; the point
    // is that it did not claim `completed`.
    assert.notEqual(turn.finishReason, 'completed');
  });

  test('an in-stream provider error becomes a structured kernel error', async () => {
    const { turn } = await runFixture('stream-error-overloaded.sse');

    assert.equal(turn.finishReason, 'error');
    assert.equal(turn.error?.code, 'MODEL_INVALID_RESPONSE');
    assert.equal(turn.error?.blame, 'provider');
    // Text received before the error is still assembled, not discarded.
    assert.equal(turn.text, 'Starting');
  });
});

// --- §14, §15 reasoning -----------------------------------------------------

describe('reasoning normalization (§14, §15)', () => {
  test('visible reasoning and its signature are captured for replay', async () => {
    const { turn } = await runFixture('reasoning.sse');

    const reasoning = turn.parts.find((p) => p.type === 'reasoning');
    assert.ok(reasoning && reasoning.type === 'reasoning');
    assert.equal(reasoning.text, 'The subtraction looks wrong. I should read the file first.');
    assert.equal(reasoning.signature, 'FIXTURE_SIGNATURE_dGVzdA==');

    // The reasoning precedes the tool call, which is what makes signature replay
    // across a tool turn meaningful.
    assert.equal(turn.toolCalls.length, 1);
    assert.equal(turn.finishReason, 'tool_calls');
  });

  test('opaque reasoning is preserved without pretending it is readable', async () => {
    const { turn } = await runFixture('redacted-reasoning.sse');

    const reasoning = turn.parts.find((p) => p.type === 'reasoning');
    assert.ok(reasoning && reasoning.type === 'reasoning');
    assert.equal(reasoning.opaque, 'FIXTURE_OPAQUE_BLOB_AAAA');
    assert.equal(reasoning.text, undefined, 'redacted thinking has no readable text');
    assert.equal(turn.text, 'Done.');
  });

  test('cache metadata is normalized into cachedInputTokens (§17)', async () => {
    const { turn } = await runFixture('reasoning.sse');
    assert.equal(turn.usage.cachedInputTokens, 256);
  });

  test('reasoning survives a round trip back into a request (§15)', async () => {
    const { turn } = await runFixture('reasoning.sse');
    const resolved = {
      alias: 'balanced',
      modelId: 'claude-sonnet-5',
      provider: {
        id: 'anthropic',
        protocol: 'anthropic-messages' as const,
        baseUrl: 'https://api.anthropic.com',
        authScheme: 'x-api-key' as const,
      },
      profile: {
        family: 'frontier',
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsParallelTools: true,
        supportsReasoning: true,
        preferredEditStrategy: 'exact' as const,
        autonomy: 'normal' as const,
        toolReliability: 'high' as const,
        reservedOutputTokens: 8192,
      },
    };

    const wire = adapter.buildRequest(
      {
        requestId: 'r2',
        modelId: 'claude-sonnet-5',
        provider: 'anthropic',
        system: 's',
        messages: [{ role: 'assistant', parts: turn.parts, origin: { kind: 'assistant' } }],
        tools: [],
      },
      resolved,
    );

    const body = JSON.parse(wire.body) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const thinking = body.messages[0]?.content.find((c) => c.type === 'thinking');
    assert.ok(thinking, 'the thinking block must be replayed');
    assert.equal(thinking.signature, 'FIXTURE_SIGNATURE_dGVzdA==', 'the signature must survive verbatim');
  });
});

// --- §16 finish reasons, §44 unknown features -------------------------------

describe('finish reasons and unknown features (§16, §44)', () => {
  test('max_tokens normalizes to truncated, not completed', async () => {
    const { turn } = await runFixture('truncated.sse');
    assert.equal(turn.finishReason, 'truncated');
    assert.equal(turn.rawFinishReason, 'max_tokens');
  });

  test('an unknown stop reason maps to `unknown` and keeps the raw value', async () => {
    const { turn } = await runFixture('unknown-finish-reason.sse');

    assert.equal(turn.finishReason, 'unknown');
    assert.equal(
      turn.rawFinishReason,
      'some_future_stop_reason_v9',
      'the raw value must be retained for diagnosis',
    );
    assert.equal(turn.text, 'Partial.', 'an unknown finish reason must not discard content');
  });

  test('unknown events and content blocks are ignored, not fatal (§44)', async () => {
    const { turn } = await runFixture('unknown-event-and-block.sse');

    assert.equal(turn.text, 'Still fine.');
    assert.equal(turn.finishReason, 'completed');
    // No guessing: the unknown block contributed nothing to the IR.
    assert.equal(turn.parts.filter((p) => p.type === 'text').length, 1);
  });
});

// --- §20-§23 HTTP error mapping ---------------------------------------------

describe('HTTP error mapping (§20, §21, §22, §23)', () => {
  // Optional on the interface, but required of a production adapter: without it
  // every provider error would collapse to the runtime's generic default.
  const mapHttpError = adapter.mapHttpError?.bind(adapter);
  test('the adapter implements error mapping at all', () => {
    assert.ok(mapHttpError, 'a production adapter must classify its provider errors');
  });

  test('429 maps to MODEL_RATE_LIMIT and is retryable', async () => {
    const fixture = await httpFixture('http-rate-limit.json');
    const err = mapHttpError!(fixture.status, fixture.body);

    assert.equal(err?.code, 'MODEL_RATE_LIMIT');
    assert.equal(err?.retryable, true);
    assert.equal(err?.blame, 'provider');
  });

  test('401 maps to MODEL_AUTH_ERROR and is NOT retryable (§20)', async () => {
    const fixture = await httpFixture('http-auth-error.json');
    const err = mapHttpError!(fixture.status, fixture.body);

    assert.equal(err?.code, 'MODEL_AUTH_ERROR');
    assert.equal(err?.retryable, false, 'retrying a bad credential just burns the budget');
    // §22: the message must not echo the key or the header.
    assert.equal(/x-api-key|sk-ant|authorization/i.test(JSON.stringify(err)), false);
  });

  test('a context-overflow 400 maps to MODEL_CONTEXT_OVERFLOW (§23)', async () => {
    const fixture = await httpFixture('http-context-overflow.json');
    const err = mapHttpError!(fixture.status, fixture.body);

    assert.equal(err?.code, 'MODEL_CONTEXT_OVERFLOW');
    assert.equal(err?.retryable, false, 'the retry path is compaction, not a blind resend');
  });

  test('a 5xx falls through to the runtime default and stays retryable', async () => {
    const fixture = await httpFixture('http-server-error.json');
    const err = mapHttpError!(fixture.status, fixture.body);
    // The adapter may decline to special-case it; the runtime maps >=500 to a
    // retryable MODEL_INVALID_RESPONSE. Either way it must not be fatal.
    if (err) assert.equal(err.retryable, true);
  });
});

// --- §9 normalized event vocabulary -----------------------------------------

describe('normalized event vocabulary (§9)', () => {
  test('the adapter emits only IR event types the Step Engine knows', async () => {
    const known = new Set([
      'stream_start',
      'text_delta',
      'reasoning_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_end',
      'usage',
      'finish',
      'error',
    ]);

    for (const fixture of [
      'text-stream.sse',
      'tool-call-stream.sse',
      'tool-call-fragmented.sse',
      'parallel-tools.sse',
      'reasoning.sse',
      'redacted-reasoning.sse',
      'truncated.sse',
      'malformed-tool-args.sse',
      'unknown-finish-reason.sse',
      'unknown-event-and-block.sse',
      'stream-error-overloaded.sse',
    ]) {
      const { events } = await runFixture(fixture);
      for (const event of events) {
        assert.ok(known.has(event.type), `${fixture} produced non-IR event type "${event.type}"`);
      }
    }
  });

  test('no fixture produces a part carrying a vendor field name', async () => {
    // The architectural claim of this milestone, asserted directly: nothing
    // vendor-shaped reaches the IR. `providerMetadata` is the sanctioned escape
    // hatch (§24) and is deliberately excluded.
    for (const fixture of ['reasoning.sse', 'tool-call-stream.sse', 'redacted-reasoning.sse']) {
      const { turn } = await runFixture(fixture);
      const serialized = JSON.stringify(turn.parts);
      for (const vendorField of [
        'content_block',
        'input_json_delta',
        'stop_reason',
        'tool_use',
        'thinking_delta',
      ]) {
        assert.equal(
          serialized.includes(vendorField),
          false,
          `${fixture}: vendor field "${vendorField}" leaked into the IR`,
        );
      }
    }
  });
});
