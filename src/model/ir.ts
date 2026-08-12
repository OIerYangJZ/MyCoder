/**
 * Protocol-neutral model IR (spec §7.1, invariants 6 and 7).
 *
 * The agent loop only ever sees the types in this file. No `AnthropicBlock`, no
 * `OpenAIResponseItem`, no provider enum leaks past the adapter boundary — if a
 * provider has a quirk, the adapter absorbs it or records it in
 * `providerMetadata`, which the loop treats as opaque.
 *
 * `ReasoningPart` carries `opaque` and `signature` precisely because some
 * providers require verbatim replay of reasoning blocks on the next request. The
 * loop does not interpret them; it round-trips them.
 */

import type { ToolCallId } from '../util/ids.ts';
import type { JsonSchema } from '../util/jsonschema.ts';
import type { KernelError } from '../util/errors.ts';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ReasoningPart {
  type: 'reasoning';
  /** Human-readable reasoning, when the provider exposes it. */
  text?: string;
  /** Provider-encrypted reasoning that must be replayed verbatim. */
  opaque?: string;
  signature?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: ToolCallId;
  name: string;
  /** Untrusted. Validated against the tool's schema before use. */
  arguments: unknown;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: ToolCallId;
  content: string;
  isError: boolean;
  structured?: unknown;
}

export interface MediaPart {
  type: 'media';
  mediaType: string;
  /** base64. Media never comes from a protected path. */
  data: string;
  name?: string;
}

export type MessagePart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart | MediaPart;

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Provenance of a conversation message (spec §8.3). */
export type MessageOrigin =
  | { kind: 'user' }
  | { kind: 'assistant' }
  | { kind: 'tool' }
  | { kind: 'control' }
  | { kind: 'injection'; source: string }
  | { kind: 'compaction_summary' };

export interface ModelMessage {
  role: MessageRole;
  parts: MessagePart[];
  origin: MessageOrigin;
  /** Set once the message has been written to the event log. */
  seq?: number;
}

export type FinishReason =
  'completed' | 'tool_calls' | 'truncated' | 'filtered' | 'paused' | 'error' | 'unknown';

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/** A tool as presented to the model. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  requestId: string;
  /** Provider-agnostic model identifier resolved from the alias. */
  modelId: string;
  provider: string;
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolSchema[];
  maxOutputTokens?: number;
  temperature?: number;
  toolChoice?: 'auto' | 'none' | 'required';
  /** Opaque per-provider knobs resolved from configuration, never from the model. */
  providerOptions?: Record<string, unknown>;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  /** Correlation ids for the audit log. */
  sessionId: string;
  turnId?: string;
  stepId?: string;
}

export type ModelEvent =
  | { type: 'stream_start'; requestId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text?: string; opaque?: string; signature?: string }
  | { type: 'tool_call_start'; id: ToolCallId; name: string }
  | { type: 'tool_call_delta'; id: ToolCallId; argumentsDelta: string }
  | { type: 'tool_call_end'; id: ToolCallId; name: string; arguments: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | {
      type: 'finish';
      finishReason: FinishReason;
      rawFinishReason?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | { type: 'error'; error: KernelError };

/** The collected result of one model call. */
export interface ModelTurn {
  requestId: string;
  /** Concatenated visible text. */
  text: string;
  /** Full ordered part list, suitable for appending to the conversation. */
  parts: MessagePart[];
  toolCalls: ToolCallPart[];
  finishReason: FinishReason;
  rawFinishReason?: string;
  usage: TokenUsage;
  providerMetadata?: Record<string, unknown>;
  /** Present when the stream ended in an error. */
  error?: KernelError;
}

export interface ModelRuntime {
  generate(request: ModelRequest, options: GenerateOptions): Promise<AsyncIterable<ModelEvent>>;
}

/**
 * Drain a model stream into a `ModelTurn`.
 *
 * Tool-call arguments may arrive as incremental JSON fragments. We accumulate
 * them and parse once at `tool_call_end`; a provider that sends a complete
 * object instead simply skips the accumulation.
 */
export async function collectModelEvents(
  stream: AsyncIterable<ModelEvent>,
  onEvent?: (event: ModelEvent) => void,
): Promise<ModelTurn> {
  let requestId = '';
  let text = '';
  const parts: MessagePart[] = [];
  const toolCalls: ToolCallPart[] = [];
  let finishReason: FinishReason = 'unknown';
  let rawFinishReason: string | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  let usage: TokenUsage = {};
  let error: KernelError | undefined;

  const pending = new Map<string, { name: string; buffer: string }>();
  let currentText: TextPart | undefined;
  let currentReasoning: ReasoningPart | undefined;

  for await (const event of stream) {
    onEvent?.(event);

    switch (event.type) {
      case 'stream_start':
        requestId = event.requestId;
        break;

      case 'text_delta': {
        text += event.text;
        if (!currentText) {
          currentText = { type: 'text', text: '' };
          parts.push(currentText);
        }
        currentText.text += event.text;
        currentReasoning = undefined;
        break;
      }

      case 'reasoning_delta': {
        if (!currentReasoning) {
          currentReasoning = { type: 'reasoning' };
          parts.push(currentReasoning);
        }
        if (event.text !== undefined) {
          currentReasoning.text = (currentReasoning.text ?? '') + event.text;
        }
        if (event.opaque !== undefined) currentReasoning.opaque = event.opaque;
        if (event.signature !== undefined) currentReasoning.signature = event.signature;
        currentText = undefined;
        break;
      }

      case 'tool_call_start':
        pending.set(event.id, { name: event.name, buffer: '' });
        currentText = undefined;
        currentReasoning = undefined;
        break;

      case 'tool_call_delta': {
        const entry = pending.get(event.id);
        if (entry) entry.buffer += event.argumentsDelta;
        break;
      }

      case 'tool_call_end': {
        const entry = pending.get(event.id);
        const args =
          event.arguments !== undefined ? event.arguments : parseArgumentsLeniently(entry?.buffer ?? '');
        const call: ToolCallPart = {
          type: 'tool_call',
          id: event.id,
          name: event.name || entry?.name || 'unknown',
          arguments: args,
        };
        parts.push(call);
        toolCalls.push(call);
        pending.delete(event.id);
        break;
      }

      case 'usage':
        usage = { ...usage, ...event.usage };
        break;

      case 'finish':
        finishReason = event.finishReason;
        if (event.rawFinishReason !== undefined) rawFinishReason = event.rawFinishReason;
        if (event.providerMetadata !== undefined) providerMetadata = event.providerMetadata;
        break;

      case 'error':
        error = event.error;
        finishReason = 'error';
        break;
    }
  }

  // A stream that ended mid tool-call still has to produce a call, otherwise the
  // loop would silently drop it and violate invariant 1.
  for (const [id, entry] of pending) {
    const call: ToolCallPart = {
      type: 'tool_call',
      id: id as ToolCallId,
      name: entry.name,
      arguments: parseArgumentsLeniently(entry.buffer),
    };
    parts.push(call);
    toolCalls.push(call);
  }

  // Providers disagree about whether "stopped to call a tool" is reported as a
  // distinct finish reason. Normalise so the loop only reads `finishReason`.
  if (toolCalls.length > 0 && finishReason !== 'error') finishReason = 'tool_calls';

  const turn: ModelTurn = { requestId, text, parts, toolCalls, finishReason, usage };
  if (rawFinishReason !== undefined) turn.rawFinishReason = rawFinishReason;
  if (providerMetadata !== undefined) turn.providerMetadata = providerMetadata;
  if (error !== undefined) turn.error = error;
  return turn;
}

/**
 * Parse accumulated argument JSON.
 *
 * Returns the raw string under `__unparsed` rather than throwing: a malformed
 * tool call must still become a tool call, so the loop can hand the model a
 * TOOL_INVALID_ARGS result instead of losing the exchange.
 */
function parseArgumentsLeniently(buffer: string): unknown {
  const trimmed = buffer.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { __unparsed: trimmed };
  }
}

// --- small helpers used across the context and adapter layers ---------------

export function textPart(text: string): TextPart {
  return { type: 'text', text };
}

export function userMessage(text: string): ModelMessage {
  return { role: 'user', parts: [textPart(text)], origin: { kind: 'user' } };
}

export function assistantMessage(parts: MessagePart[]): ModelMessage {
  return { role: 'assistant', parts, origin: { kind: 'assistant' } };
}

export function toolResultMessage(results: ToolResultPart[]): ModelMessage {
  return { role: 'tool', parts: results, origin: { kind: 'tool' } };
}

export function messageText(message: ModelMessage): string {
  return message.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Tool calls in a message that have no matching result yet. */
export function openToolCallIds(messages: readonly ModelMessage[]): ToolCallId[] {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool_call') called.add(p.id);
      if (p.type === 'tool_result') answered.add(p.toolCallId);
    }
  }
  return [...called].filter((id) => !answered.has(id)) as ToolCallId[];
}
