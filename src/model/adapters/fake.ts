/**
 * FakeModel (spec §27.1).
 *
 * Drives the agent loop from a script instead of a provider. Everything the
 * kernel's own tests care about — the state machine, freshness, permission
 * decisions, replay — is exercised without a network call or an API key, which
 * is exactly the point of §31: get the skeleton right before real model
 * behaviour can mask a state machine bug.
 *
 * Two modes:
 *   - a fixed list of steps, consumed in order;
 *   - a responder function, which sees the full request (including tool results)
 *     and decides what to do next. Used for tests like "retry after the edit was
 *     rejected as stale".
 */

import { kernelError, type KernelError } from '../../util/errors.ts';
import { asToolCallId } from '../../util/ids.ts';
import type { GenerateOptions, ModelEvent, ModelRequest, ModelRuntime, TokenUsage } from '../ir.ts';

export interface FakeToolCall {
  name: string;
  arguments: unknown;
  id?: string;
}

export type FakeStep =
  /** Final assistant message; ends the turn. */
  | { kind: 'final'; text: string; usage?: TokenUsage }
  /** Assistant requests one or more tools. */
  | { kind: 'tools'; text?: string; calls: FakeToolCall[]; usage?: TokenUsage; reasoning?: string }
  /** Provider-level failure. */
  | { kind: 'error'; error: KernelError }
  /** An empty assistant message, to exercise the empty-response path. */
  | { kind: 'empty' }
  /** Emits a truncated stream, to exercise the incomplete-stream path. */
  | { kind: 'truncated'; text: string };

export type FakeResponder = (request: ModelRequest, callIndex: number) => FakeStep | undefined;

export interface FakeModelOptions {
  script?: FakeStep[];
  responder?: FakeResponder;
  /** Delay between emitted events, to exercise cancellation. */
  chunkDelayMs?: number;
  /** Split text into deltas of this size, so streaming is genuinely streamed. */
  chunkSize?: number;
}

export class FakeModel implements ModelRuntime {
  /** Every request the loop made. Assertions read this. */
  readonly requests: ModelRequest[] = [];

  private readonly script: FakeStep[];
  private readonly responder: FakeResponder | undefined;
  private readonly chunkDelayMs: number;
  private readonly chunkSize: number;
  private callIndex = 0;

  constructor(opts: FakeModelOptions = {}) {
    this.script = opts.script ? [...opts.script] : [];
    this.responder = opts.responder;
    this.chunkDelayMs = opts.chunkDelayMs ?? 0;
    this.chunkSize = opts.chunkSize ?? 24;
  }

  get callCount(): number {
    return this.callIndex;
  }

  /** Remaining scripted steps, for tests that assert the script was consumed. */
  get remaining(): number {
    return Math.max(0, this.script.length - this.callIndex);
  }

  async generate(request: ModelRequest, options: GenerateOptions): Promise<AsyncIterable<ModelEvent>> {
    this.requests.push(request);
    const index = this.callIndex;
    this.callIndex += 1;

    const step =
      this.responder?.(request, index) ??
      this.script[index] ??
      ({ kind: 'final', text: '(fake model: script exhausted)' } as FakeStep);

    return this.emit(step, request, index, options);
  }

  private async *emit(
    step: FakeStep,
    request: ModelRequest,
    index: number,
    options: GenerateOptions,
  ): AsyncIterable<ModelEvent> {
    yield { type: 'stream_start', requestId: request.requestId };

    const pause = async (): Promise<void> => {
      if (this.chunkDelayMs > 0) await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    };

    switch (step.kind) {
      case 'error':
        yield { type: 'error', error: step.error };
        yield { type: 'finish', finishReason: 'error' };
        return;

      case 'empty':
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } };
        yield { type: 'finish', finishReason: 'completed', rawFinishReason: 'stop' };
        return;

      case 'truncated':
        for (const chunk of chunks(step.text, this.chunkSize)) {
          await pause();
          yield { type: 'text_delta', text: chunk };
        }
        // Deliberately no `finish` event: the runtime must notice.
        return;

      case 'final':
        for (const chunk of chunks(step.text, this.chunkSize)) {
          await pause();
          yield { type: 'text_delta', text: chunk };
        }
        yield {
          type: 'usage',
          usage: step.usage ?? { inputTokens: 100 + index, outputTokens: step.text.length },
        };
        yield { type: 'finish', finishReason: 'completed', rawFinishReason: 'stop' };
        return;

      case 'tools': {
        if (step.reasoning) {
          await pause();
          yield { type: 'reasoning_delta', text: step.reasoning };
        }
        if (step.text) {
          for (const chunk of chunks(step.text, this.chunkSize)) {
            await pause();
            yield { type: 'text_delta', text: chunk };
          }
        }
        for (let i = 0; i < step.calls.length; i += 1) {
          const call = step.calls[i]!;
          const id = asToolCallId(call.id ?? `fake_call_${index}_${i}`);
          await pause();
          yield { type: 'tool_call_start', id, name: call.name };
          const json = JSON.stringify(call.arguments ?? {});
          for (const chunk of chunks(json, this.chunkSize)) {
            yield { type: 'tool_call_delta', id, argumentsDelta: chunk };
          }
          yield { type: 'tool_call_end', id, name: call.name, arguments: call.arguments ?? {} };
        }
        yield {
          type: 'usage',
          usage: step.usage ?? { inputTokens: 100 + index, outputTokens: 20 },
        };
        yield { type: 'finish', finishReason: 'tool_calls', rawFinishReason: 'tool_use' };
        return;
      }
    }
  }
}

function* chunks(text: string, size: number): Iterable<string> {
  if (text === '') return;
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

// --- convenience builders for tests ---------------------------------------

export function toolStep(name: string, args: unknown, text?: string): FakeStep {
  const step: FakeStep = { kind: 'tools', calls: [{ name, arguments: args }] };
  if (text !== undefined) step.text = text;
  return step;
}

export function finalStep(text: string): FakeStep {
  return { kind: 'final', text };
}

export function errorStep(message: string): FakeStep {
  return { kind: 'error', error: kernelError('MODEL_INVALID_RESPONSE', message, { blame: 'provider' }) };
}
