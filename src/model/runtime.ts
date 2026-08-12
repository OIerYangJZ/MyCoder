/**
 * Model Runtime (spec §7.3).
 *
 * Three layers, exactly as the spec lays them out:
 *
 *   Protocol Adapter   → wire format in and out
 *   Semantic Normalizer→ tool ids, finish reasons, empty-assistant legality
 *   Model Profile      → behaviour (context window, autonomy, edit strategy)
 *
 * The runtime owns retries and the egress call. Adapters are pure: they build a
 * request object and translate SSE records into `ModelEvent`s, and they never
 * touch the network or the secret broker themselves.
 */

import { kernelError, toKernelError, type KernelError } from '../util/errors.ts';
import { legalizeToolCallId, sha256Hex } from '../util/ids.ts';
import { createLogger, type Logger } from '../util/logger.ts';
import { decodeSse, type SseMessage } from '../util/sse.ts';
import type { EgressGate } from '../security/egress-gate.ts';
import { EgressBlockedError } from '../security/egress-gate.ts';
import type { SecretBroker } from '../security/secret-broker.ts';
import type { GenerateOptions, ModelEvent, ModelRequest, ModelRuntime } from './ir.ts';
import type { ProviderProtocol, ResolvedModelProfile } from './profiles.ts';

/** What an adapter produces for the egress gate. */
export interface WireRequest {
  path: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface ProtocolAdapter {
  readonly protocol: ProviderProtocol;
  buildRequest(request: ModelRequest, resolved: ResolvedModelProfile): WireRequest;
  /**
   * Translate decoded SSE records into IR events. Adapters are generators so a
   * single wire message can fan out into several IR events (common for tool
   * calls, where "start" and "arguments" arrive separately).
   */
  translate(message: SseMessage, state: AdapterState): Iterable<ModelEvent>;
  /** Called once the stream ends, to flush anything still buffered. */
  finish?(state: AdapterState): Iterable<ModelEvent>;
  /** Map a non-2xx response body onto a structured error. */
  mapHttpError?(status: number, body: string): KernelError | undefined;
}

/** Per-request scratch space owned by the runtime and handed to the adapter. */
export interface AdapterState {
  requestId: string;
  toolCallIndex: number;
  /** Provider tool id → legalised IR id. */
  idMap: Map<string, string>;
  /** Index-keyed accumulation for protocols that stream arguments by index. */
  byIndex: Map<number, { id: string; name: string }>;
  finished: boolean;
  sawContent: boolean;
  [key: string]: unknown;
}

export function newAdapterState(requestId: string): AdapterState {
  return {
    requestId,
    toolCallIndex: 0,
    idMap: new Map(),
    byIndex: new Map(),
    finished: false,
    sawContent: false,
  };
}

/** Legalise a provider tool id once and reuse it for the rest of the stream. */
export function mapToolCallId(state: AdapterState, providerId: unknown): string {
  const key = String(providerId ?? '');
  const existing = state.idMap.get(key);
  if (existing) return existing;
  const legal = legalizeToolCallId(providerId, state.toolCallIndex);
  state.toolCallIndex += 1;
  state.idMap.set(key, legal);
  return legal;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export interface HttpModelRuntimeOptions {
  egress: EgressGate;
  secrets: SecretBroker;
  adapters: readonly ProtocolAdapter[];
  resolveModel: (modelId: string, provider: string) => ResolvedModelProfile | undefined;
  logger?: Logger;
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Time allowed for the provider to return response *headers*. A provider that
   * accepts the connection and then never answers would otherwise hang the turn
   * forever: the loop's wall-clock budget is only consulted between steps, so
   * nothing above this layer can break out of a stalled request.
   */
  connectTimeoutMs?: number;
  /**
   * Maximum gap *between* stream events. Deliberately not a total-request
   * deadline — a long generation is legitimate and must not be killed for being
   * slow, only for having stopped.
   */
  idleTimeoutMs?: number;
  onRequestAudit?: (audit: { requestId: string; payloadHash: string; payloadBytes: number }) => void;
}

export class HttpModelRuntime implements ModelRuntime {
  private readonly egress: EgressGate;
  private readonly secrets: SecretBroker;
  private readonly adapters: Map<ProviderProtocol, ProtocolAdapter>;
  private readonly resolveModel: HttpModelRuntimeOptions['resolveModel'];
  private readonly logger: Logger;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly onRequestAudit: HttpModelRuntimeOptions['onRequestAudit'];

  constructor(opts: HttpModelRuntimeOptions) {
    this.egress = opts.egress;
    this.secrets = opts.secrets;
    this.adapters = new Map(opts.adapters.map((a) => [a.protocol, a]));
    this.resolveModel = opts.resolveModel;
    this.logger = opts.logger ?? createLogger({ scope: 'model' });
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 60_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    if (opts.onRequestAudit) this.onRequestAudit = opts.onRequestAudit;
  }

  async generate(request: ModelRequest, options: GenerateOptions): Promise<AsyncIterable<ModelEvent>> {
    const resolved = this.resolveModel(request.modelId, request.provider);
    if (!resolved) {
      throw new ModelRuntimeError(
        kernelError('MODEL_INVALID_RESPONSE', `Unknown model "${request.modelId}".`, {
          blame: 'user',
        }),
      );
    }

    const adapter = this.adapters.get(resolved.provider.protocol);
    if (!adapter) {
      throw new ModelRuntimeError(
        kernelError(
          'MODEL_INVALID_RESPONSE',
          `No protocol adapter registered for "${resolved.provider.protocol}".`,
          { blame: 'kernel' },
        ),
      );
    }

    const wire = adapter.buildRequest(request, resolved);
    this.onRequestAudit?.({
      requestId: request.requestId,
      payloadHash: sha256Hex(wire.body).slice(0, 16),
      payloadBytes: Buffer.byteLength(wire.body, 'utf8'),
    });

    const self = this;
    return (async function* (): AsyncIterable<ModelEvent> {
      yield { type: 'stream_start', requestId: request.requestId };
      yield* self.streamWithRetry(adapter, wire, request, resolved, options);
    })();
  }

  private async *streamWithRetry(
    adapter: ProtocolAdapter,
    wire: WireRequest,
    request: ModelRequest,
    resolved: ResolvedModelProfile,
    options: GenerateOptions,
  ): AsyncIterable<ModelEvent> {
    let attempt = 0;

    for (;;) {
      attempt += 1;
      let lease: Awaited<ReturnType<SecretBroker['resolve']>> | undefined;

      // One controller per attempt, fed by both the caller's signal and our own
      // watchdogs. `timedOut` distinguishes the two afterwards: a caller
      // cancellation must never be retried (§19), a timeout should be.
      const attempt$ = new AbortController();
      let timedOut: 'connect' | 'idle' | undefined;
      const onCallerAbort = (): void => attempt$.abort();
      if (options.signal) {
        if (options.signal.aborted) attempt$.abort();
        else options.signal.addEventListener('abort', onCallerAbort, { once: true });
      }
      let watchdog: NodeJS.Timeout | undefined;

      // Racing the abort explicitly rather than trusting the transport to honour
      // the signal: a transport that ignores it would otherwise hang forever,
      // which is precisely the failure the watchdogs exist to prevent. Handled
      // eagerly so an abort after a successful attempt is not an unhandled
      // rejection.
      const aborted = new Promise<never>((_, reject) => {
        const fail = (): void => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (attempt$.signal.aborted) fail();
        else attempt$.signal.addEventListener('abort', fail, { once: true });
      });
      aborted.catch(() => {});

      try {
        const headers: Record<string, string> = { ...wire.headers };

        if (resolved.provider.authSecretRef && resolved.provider.authScheme !== 'none') {
          lease = await this.secrets.resolve(resolved.provider.authSecretRef, 'model.auth');
          if (resolved.provider.authScheme === 'Bearer') {
            lease.applyAuthorization(headers, 'Bearer');
          } else {
            lease.applyAuthorization(headers, 'raw', 'x-api-key');
          }
        }

        const egressReq: Parameters<EgressGate['send']>[0] = {
          kind: 'model',
          url: `${resolved.provider.baseUrl}${wire.path}`,
          method: wire.method,
          headers,
          body: wire.body,
          stream: true,
        };
        egressReq.signal = attempt$.signal;

        const egressCtx: Parameters<EgressGate['send']>[1] = {
          sessionId: options.sessionId,
          purpose: resolved.provider.id,
        };
        if (options.turnId) egressCtx.turnId = options.turnId;
        if (options.stepId) egressCtx.stepId = options.stepId;

        // Deliberately not `.unref()`ed. A deadline that cannot itself hold the
        // event loop open is a deadline that silently fails to fire when it is
        // the only thing left pending -- precisely the hang it exists to
        // prevent. It is cleared on every exit path, so it never outlives the
        // request.
        watchdog = setTimeout(() => {
          timedOut = 'connect';
          attempt$.abort();
        }, this.connectTimeoutMs);

        const response = await Promise.race([this.egress.send(egressReq, egressCtx), aborted]);

        // Headers are in; from here the deadline is per-chunk, not total.
        watchdog?.refresh();
        timedOut = undefined;

        if (response.status >= 400) {
          const body = response.body ?? (await drainToString(response.stream));
          const err = this.mapError(adapter, response.status, body, resolved);
          if (err.retryable && attempt < this.retry.maxAttempts) {
            lease?.release();
            await this.sleep(this.backoff(attempt, response.headers));
            continue;
          }
          yield { type: 'error', error: err };
          yield { type: 'finish', finishReason: 'error' };
          return;
        }

        if (!response.stream) {
          yield {
            type: 'error',
            error: kernelError('MODEL_INVALID_RESPONSE', 'Provider returned no response stream.', {
              blame: 'provider',
            }),
          };
          yield { type: 'finish', finishReason: 'error' };
          return;
        }

        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          timedOut = 'idle';
          attempt$.abort();
        }, this.idleTimeoutMs);

        const state = newAdapterState(request.requestId);
        const messages = decodeSse(response.stream, attempt$.signal)[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await Promise.race([messages.next(), aborted]);
            if (next.done === true) break;
            watchdog?.refresh(); // progress, not completion: reset the gap timer
            for (const event of adapter.translate(next.value, state)) yield event;
            if (state.finished) break;
          }
        } finally {
          await messages.return?.(undefined); // release the reader on every path
        }
        clearTimeout(watchdog);
        watchdog = undefined;
        if (adapter.finish) {
          for (const event of adapter.finish(state)) yield event;
        }

        if (!state.finished) {
          // The connection ended without a terminal event. Treat it as a
          // truncation rather than a success, so the loop does not conclude the
          // turn on a half-received answer.
          yield {
            type: 'finish',
            finishReason: state.sawContent ? 'truncated' : 'error',
            rawFinishReason: 'stream_ended_without_terminal_event',
          };
        }
        return;
      } catch (e) {
        // A watchdog abort surfaces as a generic AbortError, which would
        // otherwise be reported as the user cancelling — the opposite of what
        // happened, and unretryable to boot.
        const err =
          timedOut && !options.signal?.aborted
            ? kernelError(
                'MODEL_TIMEOUT',
                timedOut === 'connect'
                  ? `Provider "${resolved.provider.id}" did not respond within ${this.connectTimeoutMs}ms.`
                  : `Provider "${resolved.provider.id}" stopped sending for ${this.idleTimeoutMs}ms.`,
                { blame: 'environment', retryable: true, safeDetails: { phase: timedOut } },
              )
            : this.classify(e);
        if (err.retryable && attempt < this.retry.maxAttempts && !options.signal?.aborted) {
          this.logger.warn('retrying model request', { attempt, code: err.code });
          await this.sleep(this.backoff(attempt));
          continue;
        }
        yield { type: 'error', error: err };
        yield { type: 'finish', finishReason: 'error' };
        return;
      } finally {
        clearTimeout(watchdog);
        options.signal?.removeEventListener('abort', onCallerAbort);
        lease?.release();
      }
    }
  }

  private mapError(
    adapter: ProtocolAdapter,
    status: number,
    body: string,
    resolved: ResolvedModelProfile,
  ): KernelError {
    const mapped = adapter.mapHttpError?.(status, body);
    if (mapped) return mapped;

    if (status === 401 || status === 403) {
      return kernelError('MODEL_AUTH_ERROR', `Provider "${resolved.provider.id}" rejected the credential.`, {
        blame: 'user',
        retryable: false,
        safeDetails: { status, provider: resolved.provider.id },
      });
    }
    if (status === 429) {
      return kernelError('MODEL_RATE_LIMIT', `Provider "${resolved.provider.id}" is rate limiting.`, {
        blame: 'provider',
        retryable: true,
        safeDetails: { status },
      });
    }
    if (status >= 500) {
      return kernelError('MODEL_INVALID_RESPONSE', `Provider returned HTTP ${status}.`, {
        blame: 'provider',
        retryable: true,
        safeDetails: { status },
      });
    }
    if (/context.{0,20}(length|window)|too many tokens|maximum context/i.test(body)) {
      return kernelError('MODEL_CONTEXT_OVERFLOW', 'The request exceeded the model context window.', {
        blame: 'kernel',
        retryable: false,
      });
    }
    return kernelError('MODEL_INVALID_RESPONSE', `Provider returned HTTP ${status}.`, {
      blame: 'provider',
      retryable: false,
      safeDetails: { status },
    });
  }

  private classify(e: unknown): KernelError {
    if (e instanceof EgressBlockedError) return e.kernelError;
    if (e instanceof ModelRuntimeError) return e.kernelError;
    return toKernelError(e);
  }

  private backoff(attempt: number, headers?: Record<string, string>): number {
    const retryAfter = headers?.['retry-after'];
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, this.retry.maxDelayMs);
      }
    }
    const exponential = this.retry.baseDelayMs * 2 ** (attempt - 1);
    // Deterministic jitter derived from the attempt number: enough to avoid a
    // thundering herd, without introducing nondeterminism into replay tests.
    const jitter = (attempt * 137) % 250;
    return Math.min(exponential + jitter, this.retry.maxDelayMs);
  }
}

export class ModelRuntimeError extends Error {
  readonly kernelError: KernelError;

  constructor(err: KernelError) {
    super(err.message);
    this.name = 'ModelRuntimeError';
    this.kernelError = err;
  }
}

/**
 * Dispatch to a runtime by protocol.
 *
 * This is what lets `/model use fake` swap the entire transport without the
 * agent loop noticing — the fake runtime is not an HTTP client at all.
 */
export class RoutingModelRuntime implements ModelRuntime {
  private readonly routes: Map<ProviderProtocol, ModelRuntime>;
  private readonly resolveModel: (modelId: string, provider: string) => ResolvedModelProfile | undefined;

  constructor(
    routes: Map<ProviderProtocol, ModelRuntime>,
    resolveModel: (modelId: string, provider: string) => ResolvedModelProfile | undefined,
  ) {
    this.routes = routes;
    this.resolveModel = resolveModel;
  }

  async generate(request: ModelRequest, options: GenerateOptions): Promise<AsyncIterable<ModelEvent>> {
    const resolved = this.resolveModel(request.modelId, request.provider);
    const protocol = resolved?.provider.protocol;
    const runtime = protocol ? this.routes.get(protocol) : undefined;
    if (!runtime) {
      throw new ModelRuntimeError(
        kernelError('MODEL_INVALID_RESPONSE', `No runtime for model "${request.modelId}".`, {
          blame: 'kernel',
        }),
      );
    }
    return runtime.generate(request, options);
  }
}

async function drainToString(stream?: ReadableStream<Uint8Array>): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf8');
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length > 64 * 1024) break;
  }
  reader.releaseLock();
  return out + decoder.decode();
}
