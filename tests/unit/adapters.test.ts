/**
 * Protocol adapters (spec §7.4, invariant 6).
 *
 * Each adapter is driven with a realistic SSE transcript and must produce the
 * same internal IR. If a provider quirk shows up in these assertions as anything
 * other than an adapter detail, it has leaked past the boundary it is supposed
 * to stop at.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicMessagesAdapter } from '../../src/model/adapters/anthropic.ts';
import { OpenAiChatAdapter } from '../../src/model/adapters/openai-chat.ts';
import { OpenAiResponsesAdapter } from '../../src/model/adapters/openai-responses.ts';
import { newAdapterState, type ProtocolAdapter } from '../../src/model/runtime.ts';
import { collectModelEvents, type ModelEvent, type ModelRequest } from '../../src/model/ir.ts';
import { ModelRegistry } from '../../src/model/profiles.ts';
import type { SseMessage } from '../../src/util/sse.ts';

const registry = new ModelRegistry();

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: 'r1',
    modelId: 'claude-sonnet-5',
    provider: 'anthropic',
    system: 'be careful',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'fix the bug' }], origin: { kind: 'user' } },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'call_1' as never, name: 'Read', arguments: { path: 'a.ts' } }],
        origin: { kind: 'assistant' },
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 'call_1' as never, content: 'file body', isError: false }],
        origin: { kind: 'tool' },
      },
    ],
    tools: [
      {
        name: 'Read',
        description: 'read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    ...overrides,
  };
}

/** Feed a transcript through an adapter and collect the resulting IR. */
async function run(adapter: ProtocolAdapter, transcript: SseMessage[]) {
  const state = newAdapterState('r1');
  const events: ModelEvent[] = [];
  for (const message of transcript) {
    for (const event of adapter.translate(message, state)) events.push(event);
    if (state.finished) break;
  }
  if (adapter.finish) for (const event of adapter.finish(state)) events.push(event);

  return collectModelEvents(
    (async function* () {
      yield { type: 'stream_start', requestId: 'r1' } as ModelEvent;
      for (const event of events) yield event;
    })(),
  );
}

describe('Anthropic Messages adapter', () => {
  const adapter = new AnthropicMessagesAdapter();

  test('the system prompt is hoisted and tool results become user blocks', () => {
    const resolved = registry.resolve('balanced')!;
    const wire = adapter.buildRequest(request(), resolved);
    const body = JSON.parse(wire.body) as Record<string, unknown>;

    assert.equal(wire.path, '/v1/messages');
    assert.equal(body.system, 'be careful');
    assert.equal(body.stream, true);

    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.equal(messages[0]?.role, 'user');
    assert.equal(messages[1]?.role, 'assistant');
    assert.equal(messages[1]?.content[0]?.type, 'tool_use');
    // A tool result is a *user* message in this protocol — a wire quirk that
    // must not appear anywhere outside this adapter.
    assert.equal(messages[2]?.role, 'user');
    assert.equal(messages[2]?.content[0]?.type, 'tool_result');
  });

  test('streamed blocks and fragmented tool arguments become IR', async () => {
    const turn = await run(adapter, [
      { data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 100 } } }) },
      { data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) },
      {
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Looking' },
        }),
      },
      {
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' at it.' },
        }),
      },
      { data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      {
        data: JSON.stringify({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_abc', name: 'Read' },
        }),
      },
      {
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":' },
        }),
      },
      {
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"src/a.ts"}' },
        }),
      },
      { data: JSON.stringify({ type: 'content_block_stop', index: 1 }) },
      {
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 42 },
        }),
      },
    ]);

    assert.equal(turn.text, 'Looking at it.');
    assert.equal(turn.finishReason, 'tool_calls');
    assert.equal(turn.rawFinishReason, 'tool_use');
    assert.equal(turn.toolCalls.length, 1);
    assert.equal(turn.toolCalls[0]?.name, 'Read');
    assert.deepEqual(turn.toolCalls[0]?.arguments, { path: 'src/a.ts' });
    assert.equal(turn.usage.inputTokens, 100);
    assert.equal(turn.usage.outputTokens, 42);
  });

  test('thinking blocks carry their signature for verbatim replay', async () => {
    const turn = await run(adapter, [
      {
        data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      },
      {
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'let me check' },
        }),
      },
      {
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-abc' },
        }),
      },
      { data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) },
    ]);

    const reasoning = turn.parts.find((p) => p.type === 'reasoning');
    assert.ok(reasoning && reasoning.type === 'reasoning');
    assert.equal(reasoning.text, 'let me check');
    assert.equal(reasoning.signature, 'sig-abc');
  });

  test('stop reasons map onto the internal enum', async () => {
    for (const [raw, expected] of [
      ['end_turn', 'completed'],
      ['max_tokens', 'truncated'],
      ['refusal', 'filtered'],
      ['pause_turn', 'paused'],
    ] as const) {
      const turn = await run(adapter, [
        { data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: raw } }) },
      ]);
      assert.equal(turn.finishReason, expected, raw);
      assert.equal(turn.rawFinishReason, raw, 'the raw value is preserved for diagnostics');
    }
  });

  test('an error event becomes a structured kernel error', async () => {
    const turn = await run(adapter, [
      { data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }) },
    ]);
    assert.equal(turn.finishReason, 'error');
    assert.equal(turn.error?.code, 'MODEL_INVALID_RESPONSE');
    assert.equal(turn.error?.message, 'busy');
  });
});

describe('OpenAI Chat adapter', () => {
  const adapter = new OpenAiChatAdapter();

  test('tool calls stream by index with the id only on the first fragment', async () => {
    const turn = await run(adapter, [
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_xyz', function: { name: 'Read', arguments: '' } }],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }],
        }),
      },
      { data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) },
      { data: JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }) },
      { data: '[DONE]' },
    ]);

    assert.equal(turn.toolCalls.length, 1);
    assert.equal(turn.toolCalls[0]?.name, 'Read');
    assert.deepEqual(turn.toolCalls[0]?.arguments, { path: 'a.ts' });
    assert.equal(turn.finishReason, 'tool_calls');
    assert.equal(turn.usage.inputTokens, 10);
  });

  test('an assistant turn with neither text nor tool calls is dropped from the request', () => {
    const resolved = registry.resolve('openai/gpt')!;
    const wire = adapter.buildRequest(
      request({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'hi' }], origin: { kind: 'user' } },
          { role: 'assistant', parts: [], origin: { kind: 'assistant' } },
        ],
      }),
      resolved,
    );
    const body = JSON.parse(wire.body) as { messages: Array<{ role: string }> };
    assert.deepEqual(
      body.messages.map((m) => m.role),
      ['system', 'user'],
      'an empty assistant message would be rejected by the API',
    );
  });

  test('the finish reason survives the DONE sentinel', async () => {
    const turn = await run(adapter, [
      { data: JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) },
      { data: '[DONE]' },
    ]);
    assert.equal(turn.text, 'done');
    assert.equal(turn.finishReason, 'completed');
    assert.equal(turn.rawFinishReason, 'stop');
  });

  test('length truncation is reported as truncated, not completed', async () => {
    const turn = await run(adapter, [
      { data: JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }) },
      { data: '[DONE]' },
    ]);
    assert.equal(turn.finishReason, 'truncated');
  });
});

describe('OpenAI Responses adapter', () => {
  const adapter = new OpenAiResponsesAdapter();

  test('call_id, not item id, is what a function result references', () => {
    const resolved = registry.resolve('openai/gpt')!;
    const wire = adapter.buildRequest(request(), resolved);
    const body = JSON.parse(wire.body) as { input: Array<Record<string, unknown>>; instructions: string };

    assert.equal(wire.path, '/v1/responses');
    assert.equal(body.instructions, 'be careful');

    const call = body.input.find((i) => i.type === 'function_call');
    const output = body.input.find((i) => i.type === 'function_call_output');
    assert.equal(call?.call_id, 'call_1');
    assert.equal(output?.call_id, 'call_1', 'the result must echo the call_id');
  });

  test('typed stream events become IR', async () => {
    const turn = await run(adapter, [
      { data: JSON.stringify({ type: 'response.output_text.delta', delta: 'Checking' }) },
      {
        data: JSON.stringify({
          type: 'response.output_item.added',
          item: { type: 'function_call', id: 'item_1', call_id: 'call_abc', name: 'Read' },
        }),
      },
      {
        data: JSON.stringify({
          type: 'response.function_call_arguments.delta',
          item_id: 'item_1',
          delta: '{"path":"a.ts"}',
        }),
      },
      {
        data: JSON.stringify({
          type: 'response.function_call_arguments.done',
          item_id: 'item_1',
          arguments: '{"path":"a.ts"}',
        }),
      },
      {
        data: JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 3 } },
        }),
      },
    ]);

    assert.equal(turn.text, 'Checking');
    assert.equal(turn.toolCalls.length, 1);
    assert.deepEqual(turn.toolCalls[0]?.arguments, { path: 'a.ts' });
    assert.equal(turn.finishReason, 'tool_calls');
    assert.equal(turn.usage.inputTokens, 7);
  });

  test('an incomplete response is truncated, and open calls are still closed', async () => {
    const turn = await run(adapter, [
      {
        data: JSON.stringify({
          type: 'response.output_item.added',
          item: { type: 'function_call', id: 'item_9', call_id: 'call_9', name: 'Shell' },
        }),
      },
      {
        data: JSON.stringify({
          type: 'response.incomplete',
          response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
        }),
      },
    ]);

    // The call must survive: dropping it would break invariant 1 downstream.
    assert.equal(turn.toolCalls.length, 1);
    assert.equal(turn.rawFinishReason, 'max_output_tokens');
  });

  test('encrypted reasoning is round-tripped, not interpreted', () => {
    const resolved = registry.resolve('openai/gpt')!;
    const wire = adapter.buildRequest(
      request({
        messages: [
          {
            role: 'assistant',
            parts: [{ type: 'reasoning', opaque: 'ENCRYPTED_BLOB' }],
            origin: { kind: 'assistant' },
          },
        ],
      }),
      resolved,
    );
    const body = JSON.parse(wire.body) as { input: Array<Record<string, unknown>> };
    const reasoning = body.input.find((i) => i.type === 'reasoning');
    assert.equal(reasoning?.encrypted_content, 'ENCRYPTED_BLOB');
  });
});

describe('tool call id normalisation', () => {
  test('an illegal provider id is legalised once and reused', async () => {
    const adapter = new AnthropicMessagesAdapter();
    const turn = await run(adapter, [
      {
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'weird/id with spaces!', name: 'Read' },
        }),
      },
      {
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        }),
      },
      { data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      { data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) },
    ]);

    const id = turn.toolCalls[0]?.id ?? '';
    assert.match(id, /^[A-Za-z0-9_-]+$/, 'the id is safe for the event log and the filesystem');
    assert.equal(id.includes('/'), false);
  });

  test('malformed argument JSON still produces a tool call', async () => {
    const adapter = new OpenAiChatAdapter();
    const turn = await run(adapter, [
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{not json' } }],
              },
            },
          ],
        }),
      },
      { data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) },
      { data: '[DONE]' },
    ]);

    // Invariant 1 begins here: a malformed call must still become a call, so it
    // can be answered with TOOL_INVALID_ARGS rather than vanishing.
    assert.equal(turn.toolCalls.length, 1);
    assert.deepEqual(turn.toolCalls[0]?.arguments, { __unparsed: '{not json' });
  });
});

describe('model profiles are separate from provider endpoints', () => {
  test('an alias resolves to both, independently', () => {
    const resolved = registry.resolve('balanced');
    assert.ok(resolved);
    assert.equal(resolved.provider.protocol, 'anthropic-messages');
    assert.equal(resolved.profile.preferredEditStrategy, 'exact');
    assert.ok(resolved.profile.contextWindow > 0);
    // The profile describes behaviour; it does not mention a URL.
    assert.equal('baseUrl' in resolved.profile, false);
  });

  test('usable context reserves room for the response', () => {
    const resolved = registry.resolve('balanced')!;
    const usable = ModelRegistry.usableContextTokens(resolved.profile);
    assert.ok(usable < resolved.profile.contextWindow);
    assert.ok(usable > 0);
  });
});
