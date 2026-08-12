/**
 * OpenAI Responses protocol adapter.
 *
 * Wire quirks absorbed here:
 *  - the conversation is an `input` array of typed items, not chat messages;
 *  - function calls are items with both an `id` and a `call_id`; the *call_id*
 *    is what a function result must reference, and confusing the two produces a
 *    silent mismatch — so the mapping is pinned when the item is added;
 *  - reasoning items are returned as opaque blobs that must be replayed by id;
 *  - every stream event is typed (`response.output_text.delta`, …) rather than
 *    being a diff of one big object.
 */

import type { SseMessage } from '../../util/sse.ts';
import { kernelError, type KernelError } from '../../util/errors.ts';
import type { ToolCallId } from '../../util/ids.ts';
import type { FinishReason, ModelEvent, ModelRequest } from '../ir.ts';
import type { ResolvedModelProfile } from '../profiles.ts';
import { mapToolCallId, type AdapterState, type ProtocolAdapter, type WireRequest } from '../runtime.ts';

export class OpenAiResponsesAdapter implements ProtocolAdapter {
  readonly protocol = 'openai-responses' as const;

  buildRequest(request: ModelRequest, resolved: ResolvedModelProfile): WireRequest {
    const body: Record<string, unknown> = {
      model: request.modelId,
      stream: true,
      input: toResponsesInput(request),
    };
    if (request.system) body.instructions = request.system;
    const maxTokens = request.maxOutputTokens ?? resolved.profile.maxOutputTokens;
    if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }));
      if (request.toolChoice) body.tool_choice = request.toolChoice;
    }
    if (resolved.profile.supportsReasoning) {
      // Ask for reasoning to be returned encrypted so it can be replayed without
      // the kernel ever needing to interpret it.
      body.include = ['reasoning.encrypted_content'];
      body.store = false;
    }
    Object.assign(body, request.providerOptions ?? {});

    return {
      path: '/v1/responses',
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
    if (message.data === '' || message.data.trim() === '[DONE]') return;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = (payload.type as string | undefined) ?? message.event ?? '';

    switch (type) {
      case 'response.output_text.delta': {
        const delta = payload.delta;
        if (typeof delta === 'string' && delta !== '') {
          state.sawContent = true;
          yield { type: 'text_delta', text: delta };
        }
        return;
      }

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = payload.delta;
        if (typeof delta === 'string' && delta !== '') {
          yield { type: 'reasoning_delta', text: delta };
        }
        return;
      }

      case 'response.output_item.added': {
        const item = payload.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call') {
          // `call_id` is the identity a function result must echo back.
          const callId = String(item.call_id ?? item.id ?? '');
          const id = mapToolCallId(state, callId) as ToolCallId;
          const name = String(item.name ?? '');
          const byItemId = getItemIndex(state);
          byItemId.set(String(item.id ?? callId), { id, name });
          state.sawContent = true;
          yield { type: 'tool_call_start', id, name };
        }
        if (item?.type === 'reasoning' && typeof item.encrypted_content === 'string') {
          yield { type: 'reasoning_delta', opaque: item.encrypted_content };
        }
        return;
      }

      case 'response.function_call_arguments.delta': {
        const byItemId = getItemIndex(state);
        const entry = byItemId.get(String(payload.item_id ?? ''));
        const delta = payload.delta;
        if (entry && typeof delta === 'string' && delta !== '') {
          yield { type: 'tool_call_delta', id: entry.id as ToolCallId, argumentsDelta: delta };
        }
        return;
      }

      case 'response.function_call_arguments.done': {
        const byItemId = getItemIndex(state);
        const key = String(payload.item_id ?? '');
        const entry = byItemId.get(key);
        if (entry) {
          const args = typeof payload.arguments === 'string' ? safeParse(payload.arguments) : undefined;
          yield {
            type: 'tool_call_end',
            id: entry.id as ToolCallId,
            name: entry.name,
            arguments: args as unknown,
          };
          byItemId.delete(key);
        }
        return;
      }

      case 'response.output_item.done': {
        const item = payload.item as Record<string, unknown> | undefined;
        if (item?.type === 'reasoning' && typeof item.encrypted_content === 'string') {
          yield { type: 'reasoning_delta', opaque: item.encrypted_content };
        }
        return;
      }

      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const response = payload.response as Record<string, unknown> | undefined;
        if (response?.usage)
          yield { type: 'usage', usage: mapUsage(response.usage as Record<string, unknown>) };

        // Any function call still open must be closed, or the loop would lose it.
        const byItemId = getItemIndex(state);
        for (const [key, entry] of byItemId) {
          yield {
            type: 'tool_call_end',
            id: entry.id as ToolCallId,
            name: entry.name,
            arguments: undefined as unknown,
          };
          byItemId.delete(key);
        }

        const status = String(response?.status ?? type.replace('response.', ''));
        const incompleteReason = (response?.incomplete_details as Record<string, unknown> | undefined)
          ?.reason;
        const raw = incompleteReason ? String(incompleteReason) : status;

        state.finished = true;
        yield { type: 'finish', finishReason: mapStatus(status, raw), rawFinishReason: raw };
        return;
      }

      case 'error': {
        state.finished = true;
        yield {
          type: 'error',
          error: kernelError('MODEL_INVALID_RESPONSE', String(payload.message ?? 'Provider stream error.'), {
            blame: 'provider',
          }),
        };
        return;
      }

      default:
        return;
    }
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
    if (code === 'context_length_exceeded' || /maximum context length|too many tokens/i.test(message)) {
      return kernelError('MODEL_CONTEXT_OVERFLOW', 'The request exceeded the model context window.', {
        blame: 'kernel',
        retryable: false,
      });
    }
    if (status === 401) {
      return kernelError('MODEL_AUTH_ERROR', 'The provider credential was rejected.', {
        blame: 'user',
        retryable: false,
      });
    }
    return undefined;
  }
}

function getItemIndex(state: AdapterState): Map<string, { id: string; name: string }> {
  const existing = state.responsesItems as Map<string, { id: string; name: string }> | undefined;
  if (existing) return existing;
  const created = new Map<string, { id: string; name: string }>();
  state.responsesItems = created;
  return created;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { __unparsed: text };
  }
}

function mapStatus(status: string, raw: string): FinishReason {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'error';
  if (raw === 'max_output_tokens') return 'truncated';
  if (raw === 'content_filter') return 'filtered';
  if (status === 'incomplete') return 'truncated';
  return 'unknown';
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
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  if (typeof inputDetails?.cached_tokens === 'number') out.cachedInputTokens = inputDetails.cached_tokens;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  if (typeof outputDetails?.reasoning_tokens === 'number') {
    out.reasoningTokens = outputDetails.reasoning_tokens;
  }
  return out;
}

/** Project the IR conversation onto the Responses `input` array. */
function toResponsesInput(request: ModelRequest): unknown[] {
  const out: unknown[] = [];

  for (const message of request.messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      for (const part of message.parts) {
        if (part.type !== 'tool_result') continue;
        out.push({
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: part.content,
        });
      }
      continue;
    }

    if (message.role === 'user') {
      const content = message.parts
        .map((part) => {
          if (part.type === 'text') return { type: 'input_text', text: part.text };
          if (part.type === 'media') {
            return { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` };
          }
          return undefined;
        })
        .filter(Boolean);
      if (content.length > 0) out.push({ type: 'message', role: 'user', content });
      continue;
    }

    // assistant
    for (const part of message.parts) {
      if (part.type === 'text' && part.text !== '') {
        out.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: part.text }],
        });
      } else if (part.type === 'reasoning' && part.opaque) {
        out.push({ type: 'reasoning', encrypted_content: part.opaque, summary: [] });
      } else if (part.type === 'tool_call') {
        out.push({
          type: 'function_call',
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.arguments ?? {}),
        });
      }
    }
  }

  return out;
}
