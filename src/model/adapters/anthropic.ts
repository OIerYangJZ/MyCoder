/**
 * Anthropic Messages protocol adapter.
 *
 * Wire quirks absorbed here, so the agent loop never learns about them:
 *  - content arrives as indexed blocks with separate start/delta/stop events;
 *  - tool arguments stream as `input_json_delta` fragments of a JSON string;
 *  - extended thinking arrives as `thinking` blocks with a `signature` that must
 *    be replayed verbatim on the following request — carried as
 *    `ReasoningPart.opaque` + `.signature`;
 *  - the system prompt is a top-level field, not a message;
 *  - `stop_reason` uses names that do not match any other provider.
 */

import type { SseMessage } from '../../util/sse.ts';
import { kernelError, type KernelError } from '../../util/errors.ts';
import type { ToolCallId } from '../../util/ids.ts';
import type { FinishReason, MessagePart, ModelEvent, ModelMessage, ModelRequest } from '../ir.ts';
import type { ResolvedModelProfile } from '../profiles.ts';
import { mapToolCallId, type AdapterState, type ProtocolAdapter, type WireRequest } from '../runtime.ts';

interface AnthropicBlockState {
  kind: 'text' | 'thinking' | 'tool_use';
  id?: string;
  name?: string;
}

export class AnthropicMessagesAdapter implements ProtocolAdapter {
  readonly protocol = 'anthropic-messages' as const;

  buildRequest(request: ModelRequest, resolved: ResolvedModelProfile): WireRequest {
    const body: Record<string, unknown> = {
      model: request.modelId,
      max_tokens: request.maxOutputTokens ?? resolved.profile.maxOutputTokens ?? 8192,
      stream: true,
      messages: toAnthropicMessages(request.messages),
    };
    if (request.system) body.system = request.system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
      if (request.toolChoice === 'required') body.tool_choice = { type: 'any' };
      else if (request.toolChoice === 'none') body.tool_choice = { type: 'none' };
    }
    Object.assign(body, request.providerOptions ?? {});

    return {
      path: '/v1/messages',
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
    if (message.data === '' || message.data === '[DONE]') return;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const blocks = getBlocks(state);
    const type = (payload.type as string | undefined) ?? message.event;

    switch (type) {
      case 'message_start': {
        const usage = (payload.message as Record<string, unknown> | undefined)?.usage;
        if (usage) yield { type: 'usage', usage: mapUsage(usage as Record<string, unknown>) };
        return;
      }

      case 'content_block_start': {
        const index = payload.index as number;
        const block = payload.content_block as Record<string, unknown>;
        const blockType = block?.type as string;

        if (blockType === 'tool_use') {
          const id = mapToolCallId(state, block.id) as ToolCallId;
          const name = String(block.name ?? '');
          blocks.set(index, { kind: 'tool_use', id, name });
          state.sawContent = true;
          yield { type: 'tool_call_start', id, name };
          return;
        }
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          blocks.set(index, { kind: 'thinking' });
          // Redacted thinking carries only opaque data; forward it so it can be
          // replayed, without pretending it is readable text.
          if (typeof block.data === 'string') {
            yield { type: 'reasoning_delta', opaque: block.data };
          }
          return;
        }
        blocks.set(index, { kind: 'text' });
        return;
      }

      case 'content_block_delta': {
        const index = payload.index as number;
        const delta = payload.delta as Record<string, unknown>;
        const block = blocks.get(index);
        const deltaType = delta?.type as string;

        if (deltaType === 'text_delta' && typeof delta.text === 'string') {
          state.sawContent = true;
          yield { type: 'text_delta', text: delta.text };
          return;
        }
        if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'reasoning_delta', text: delta.thinking };
          return;
        }
        if (deltaType === 'signature_delta' && typeof delta.signature === 'string') {
          yield { type: 'reasoning_delta', signature: delta.signature };
          return;
        }
        if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (block?.kind === 'tool_use' && block.id) {
            yield {
              type: 'tool_call_delta',
              id: block.id as ToolCallId,
              argumentsDelta: delta.partial_json,
            };
          }
          return;
        }
        return;
      }

      case 'content_block_stop': {
        const index = payload.index as number;
        const block = blocks.get(index);
        if (block?.kind === 'tool_use' && block.id) {
          // `arguments` is undefined so the runtime parses the accumulated
          // fragments — Anthropic never sends the object in one piece.
          yield {
            type: 'tool_call_end',
            id: block.id as ToolCallId,
            name: block.name ?? '',
            arguments: undefined as unknown,
          };
        }
        blocks.delete(index);
        return;
      }

      case 'message_delta': {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (payload.usage) yield { type: 'usage', usage: mapUsage(payload.usage as Record<string, unknown>) };
        const stop = delta?.stop_reason;
        if (typeof stop === 'string') {
          state.finished = true;
          const finish: Extract<ModelEvent, { type: 'finish' }> = {
            type: 'finish',
            finishReason: mapStopReason(stop),
            rawFinishReason: stop,
          };
          if (delta?.stop_sequence) {
            finish.providerMetadata = { stopSequence: delta.stop_sequence };
          }
          yield finish;
        }
        return;
      }

      case 'message_stop': {
        if (!state.finished) {
          state.finished = true;
          yield { type: 'finish', finishReason: 'completed', rawFinishReason: 'message_stop' };
        }
        return;
      }

      case 'error': {
        const err = payload.error as Record<string, unknown> | undefined;
        state.finished = true;
        yield {
          type: 'error',
          error: kernelError('MODEL_INVALID_RESPONSE', String(err?.message ?? 'Provider stream error.'), {
            blame: 'provider',
            safeDetails: { providerErrorType: String(err?.type ?? 'unknown') },
          }),
        };
        return;
      }

      default:
        return;
    }
  }

  mapHttpError(status: number, body: string): KernelError | undefined {
    let type = '';
    let message = '';
    try {
      const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
      type = parsed.error?.type ?? '';
      message = parsed.error?.message ?? '';
    } catch {
      return undefined;
    }

    if (type === 'authentication_error' || status === 401) {
      return kernelError('MODEL_AUTH_ERROR', 'The Anthropic credential was rejected.', {
        blame: 'user',
        retryable: false,
      });
    }
    if (type === 'rate_limit_error' || status === 429) {
      return kernelError('MODEL_RATE_LIMIT', 'Anthropic is rate limiting this key.', {
        blame: 'provider',
        retryable: true,
      });
    }
    if (type === 'invalid_request_error' && /max_tokens|context|too long/i.test(message)) {
      return kernelError('MODEL_CONTEXT_OVERFLOW', 'The request exceeded the model context window.', {
        blame: 'kernel',
        retryable: false,
      });
    }
    return undefined;
  }
}

function getBlocks(state: AdapterState): Map<number, AnthropicBlockState> {
  const existing = state.anthropicBlocks as Map<number, AnthropicBlockState> | undefined;
  if (existing) return existing;
  const created = new Map<number, AnthropicBlockState>();
  state.anthropicBlocks = created;
  return created;
}

function mapStopReason(stop: string): FinishReason {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'completed';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'truncated';
    case 'refusal':
      return 'filtered';
    case 'pause_turn':
      return 'paused';
    default:
      return 'unknown';
  }
}

function mapUsage(usage: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
} {
  const out: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {};
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  if (typeof cacheRead === 'number') out.cachedInputTokens = cacheRead;
  return out;
}

/**
 * Project the IR conversation onto Anthropic's shape.
 *
 * Tool results must appear as `user` messages containing `tool_result` blocks,
 * and consecutive tool results have to be merged into one message — a detail
 * that has nothing to do with our conversation model, which is why it lives
 * here.
 */
function toAnthropicMessages(messages: readonly ModelMessage[]): unknown[] {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];

  const push = (role: 'user' | 'assistant', content: unknown[]): void => {
    if (content.length === 0) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };

  for (const message of messages) {
    if (message.role === 'system') continue; // hoisted to the top-level field

    if (message.role === 'tool') {
      push(
        'user',
        message.parts
          .filter((p) => p.type === 'tool_result')
          .map((p) => {
            const result = p as Extract<MessagePart, { type: 'tool_result' }>;
            return {
              type: 'tool_result',
              tool_use_id: result.toolCallId,
              content: result.content,
              is_error: result.isError,
            };
          }),
      );
      continue;
    }

    const content: unknown[] = [];
    for (const part of message.parts) {
      switch (part.type) {
        case 'text':
          if (part.text !== '') content.push({ type: 'text', text: part.text });
          break;
        case 'reasoning':
          // Replay is keyed on which field is present, not on both being
          // present. Visible extended thinking arrives as `text` + `signature`
          // and carries no `opaque`; requiring `opaque` here silently dropped it,
          // and the API rejects a follow-up tool turn whose thinking block is
          // missing. Redacted thinking is the opposite shape: `opaque`, no text.
          //
          // Unsigned readable thinking is still dropped — the API rejects it,
          // and inventing a signature is not an option.
          if (part.signature) {
            content.push({ type: 'thinking', thinking: part.text ?? '', signature: part.signature });
          } else if (part.opaque) {
            content.push({ type: 'redacted_thinking', data: part.opaque });
          }
          break;
        case 'tool_call':
          content.push({
            type: 'tool_use',
            id: part.id,
            name: part.name,
            input: part.arguments ?? {},
          });
          break;
        case 'media':
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: part.mediaType, data: part.data },
          });
          break;
        case 'tool_result':
          break; // handled by the `tool` branch
      }
    }
    push(message.role === 'assistant' ? 'assistant' : 'user', content);
  }

  // An assistant message with no content is rejected; the loop can produce one
  // after a filtered response, so normalise it here rather than upstream.
  return out.filter((m) => m.content.length > 0);
}
