/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * This is the lingua franca of self-hosted and third-party endpoints, so it is
 * the most useful second protocol to support (spec §1.2).
 *
 * Wire quirks absorbed here:
 *  - tool calls stream by array **index**, and `id` arrives only on the first
 *    fragment, so the index→id mapping has to be remembered;
 *  - `finish_reason` arrives on the same chunk as the last content delta;
 *  - the stream terminates with a literal `data: [DONE]` sentinel;
 *  - usage is only present when `stream_options.include_usage` is requested.
 */

import type { SseMessage } from '../../util/sse.ts';
import { kernelError, type KernelError } from '../../util/errors.ts';
import type { ToolCallId } from '../../util/ids.ts';
import type { FinishReason, ModelEvent, ModelMessage, ModelRequest } from '../ir.ts';
import type { ResolvedModelProfile } from '../profiles.ts';
import { mapToolCallId, type AdapterState, type ProtocolAdapter, type WireRequest } from '../runtime.ts';

export class OpenAiChatAdapter implements ProtocolAdapter {
  readonly protocol = 'openai-chat' as const;

  buildRequest(request: ModelRequest, resolved: ResolvedModelProfile): WireRequest {
    const body: Record<string, unknown> = {
      model: request.modelId,
      stream: true,
      stream_options: { include_usage: true },
      messages: toChatMessages(request),
    };
    const maxTokens = request.maxOutputTokens ?? resolved.profile.maxOutputTokens;
    if (maxTokens !== undefined) body.max_completion_tokens = maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      if (request.toolChoice) body.tool_choice = request.toolChoice;
    }
    Object.assign(body, request.providerOptions ?? {});

    return {
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(resolved.provider.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
    };
  }

  *translate(message: SseMessage, state: AdapterState): Iterable<ModelEvent> {
    if (message.data === '') return;
    if (message.data.trim() === '[DONE]') {
      yield* this.flush(state);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message.data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (payload.error) {
      const err = payload.error as Record<string, unknown>;
      state.finished = true;
      yield {
        type: 'error',
        error: kernelError('MODEL_INVALID_RESPONSE', String(err.message ?? 'Provider stream error.'), {
          blame: 'provider',
        }),
      };
      return;
    }

    const usage = payload.usage as Record<string, unknown> | undefined;
    if (usage) {
      yield { type: 'usage', usage: mapUsage(usage) };
    }

    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return;

    const delta = choice.delta as Record<string, unknown> | undefined;

    if (delta) {
      if (typeof delta.content === 'string' && delta.content !== '') {
        state.sawContent = true;
        yield { type: 'text_delta', text: delta.content };
      }
      // Several OpenAI-compatible servers expose reasoning under one of these.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning !== '') {
        yield { type: 'reasoning_delta', text: reasoning };
      }

      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      for (const tc of toolCalls ?? []) {
        const index = typeof tc.index === 'number' ? tc.index : 0;
        const fn = tc.function as Record<string, unknown> | undefined;
        let entry = state.byIndex.get(index);

        if (!entry) {
          const id = mapToolCallId(state, tc.id ?? `idx_${index}`);
          entry = { id, name: String(fn?.name ?? '') };
          state.byIndex.set(index, entry);
          state.sawContent = true;
          yield { type: 'tool_call_start', id: id as ToolCallId, name: entry.name };
        } else if (fn?.name && entry.name === '') {
          entry.name = String(fn.name);
        }

        if (typeof fn?.arguments === 'string' && fn.arguments !== '') {
          yield {
            type: 'tool_call_delta',
            id: entry.id as ToolCallId,
            argumentsDelta: fn.arguments,
          };
        }
      }
    }

    const finishReason = choice.finish_reason;
    if (typeof finishReason === 'string' && finishReason !== '') {
      state.pendingFinish = finishReason;
      // Do not mark finished yet: a usage-only chunk usually follows, and
      // `[DONE]` is the real terminator.
    }
  }

  *finish(state: AdapterState): Iterable<ModelEvent> {
    yield* this.flush(state);
  }

  private *flush(state: AdapterState): Iterable<ModelEvent> {
    if (state.finished) return;

    for (const [, entry] of state.byIndex) {
      yield {
        type: 'tool_call_end',
        id: entry.id as ToolCallId,
        name: entry.name,
        arguments: undefined as unknown,
      };
    }
    state.byIndex.clear();

    const raw = (state.pendingFinish as string | undefined) ?? 'stop';
    state.finished = true;
    yield { type: 'finish', finishReason: mapFinishReason(raw), rawFinishReason: raw };
  }

  mapHttpError(status: number, body: string): KernelError | undefined {
    let message = '';
    let code = '';
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } };
      message = parsed.error?.message ?? '';
      code = parsed.error?.code ?? '';
    } catch {
      return undefined;
    }
    if (code === 'context_length_exceeded' || /maximum context length/i.test(message)) {
      return kernelError('MODEL_CONTEXT_OVERFLOW', 'The request exceeded the model context window.', {
        blame: 'kernel',
        retryable: false,
      });
    }
    if (status === 401 || code === 'invalid_api_key') {
      return kernelError('MODEL_AUTH_ERROR', 'The provider credential was rejected.', {
        blame: 'user',
        retryable: false,
      });
    }
    return undefined;
  }
}

function mapFinishReason(raw: string): FinishReason {
  switch (raw) {
    case 'stop':
      return 'completed';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'truncated';
    case 'content_filter':
      return 'filtered';
    default:
      return 'unknown';
  }
}

function mapUsage(usage: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
} {
  const out: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  } = {};
  if (typeof usage.prompt_tokens === 'number') out.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.outputTokens = usage.completion_tokens;
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  if (typeof promptDetails?.cached_tokens === 'number') {
    out.cachedInputTokens = promptDetails.cached_tokens;
  }
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
  if (typeof completionDetails?.reasoning_tokens === 'number') {
    out.reasoningTokens = completionDetails.reasoning_tokens;
  }
  return out;
}

/** Project the IR conversation onto the Chat Completions message array. */
function toChatMessages(request: ModelRequest): unknown[] {
  const out: unknown[] = [];
  if (request.system) out.push({ role: 'system', content: request.system });

  for (const message of request.messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      for (const part of message.parts) {
        if (part.type !== 'tool_result') continue;
        out.push({ role: 'tool', tool_call_id: part.toolCallId, content: part.content });
      }
      continue;
    }

    if (message.role === 'user') {
      out.push({ role: 'user', content: userContent(message) });
      continue;
    }

    const text = message.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('');
    const toolCalls = message.parts
      .filter((p) => p.type === 'tool_call')
      .map((p) => {
        const call = p as { id: string; name: string; arguments: unknown };
        return {
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        };
      });

    // An assistant turn with neither text nor tool calls is not a legal message
    // for this protocol, so it is dropped rather than sent and rejected.
    if (text === '' && toolCalls.length === 0) continue;

    const entry: Record<string, unknown> = { role: 'assistant', content: text === '' ? null : text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    out.push(entry);
  }

  return out;
}

function userContent(message: ModelMessage): unknown {
  const media = message.parts.filter((p) => p.type === 'media');
  if (media.length === 0) {
    return message.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('');
  }
  return message.parts
    .map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'media') {
        return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
      }
      return undefined;
    })
    .filter(Boolean);
}
