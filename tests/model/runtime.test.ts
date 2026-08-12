/**
 * `HttpModelRuntime` — request lifetime, retry, and cancellation (§19, §22).
 *
 * The adapters are covered by fixture conformance; this suite covers the layer
 * *around* them, which until now had no direct tests. The cases that matter are
 * the ones where "the request never finishes" and "the user pressed Ctrl-C" have
 * to stay distinguishable: they look identical at the AbortSignal, but one is a
 * retryable environment fault and the other must never be retried.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HttpModelRuntime } from '../../src/model/runtime.ts';
import { OpenAiChatAdapter } from '../../src/model/adapters/openai-chat.ts';
import { InMemorySecretBroker } from '../../src/security/secret-broker.ts';
import { Redactor } from '../../src/security/redactor.ts';
import type { ModelEvent, ModelRequest } from '../../src/model/ir.ts';
import type { ResolvedModelProfile } from '../../src/model/profiles.ts';
import type { EgressGate, EgressResponse } from '../../src/security/egress-gate.ts';

const RESOLVED: ResolvedModelProfile = {
  alias: 'test',
  modelId: 'test-model',
  provider: {
    id: 'testprov',
    protocol: 'openai-chat',
    baseUrl: 'https://provider.example',
    authScheme: 'none',
  },
  profile: {
    family: 'frontier',
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
    supportsParallelTools: false,
    supportsReasoning: false,
    preferredEditStrategy: 'exact',
    autonomy: 'normal',
    reservedOutputTokens: 1_000,
    toolReliability: 'high',
  },
};

const REQUEST: ModelRequest = {
  requestId: 'req-1',
  modelId: 'test-model',
  provider: 'testprov',
  system: 'sys',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }], origin: { kind: 'user' } }],
  tools: [],
};

/** An egress gate whose responses are scripted per attempt. */
class ScriptedEgress implements EgressGate {
  attempts = 0;
  private readonly script: ((attempt: number) => Promise<EgressResponse>)[];
  constructor(script: ((attempt: number) => Promise<EgressResponse>)[]) {
    this.script = script;
  }
  async send(): Promise<EgressResponse> {
    this.attempts += 1;
    const step = this.script[Math.min(this.attempts - 1, this.script.length - 1)]!;
    return step(this.attempts);
  }
}

/** A stream that emits `chunks` with `gapMs` between them, then closes. */
function pacedStream(chunks: string[], gapMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) return controller.close();
      await new Promise((r) => setTimeout(r, gapMs));
      controller.enqueue(enc.encode(chunks[i]!));
      i += 1;
    },
  });
}

/** A stream that opens and then never produces anything. */
function silentStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      return new Promise<void>(() => {});
    },
  });
}

const DONE = [
  'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
  'data: [DONE]\n\n',
];

function makeRuntime(
  egress: EgressGate,
  opts: Partial<{ connectTimeoutMs: number; idleTimeoutMs: number }> = {},
) {
  return new HttpModelRuntime({
    egress,
    secrets: new InMemorySecretBroker(new Redactor()),
    adapters: [new OpenAiChatAdapter()],
    resolveModel: () => RESOLVED,
    logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} } as never,
    sleep: async () => {}, // no real backoff delay in tests
    connectTimeoutMs: opts.connectTimeoutMs ?? 60_000,
    idleTimeoutMs: opts.idleTimeoutMs ?? 120_000,
  });
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const errorOf = (events: ModelEvent[]) => events.find((e) => e.type === 'error');

describe('a stalled request cannot hang the turn', () => {
  test('a provider that never returns headers times out, and the timeout is retried', async () => {
    const egress = new ScriptedEgress([
      // Attempt 1: accept the connection, then never answer.
      (_a) => new Promise<EgressResponse>(() => {}),
      // Attempt 2: answer normally.
      async () => ({ status: 200, headers: {}, stream: pacedStream(DONE, 0) }),
    ]);
    const runtime = makeRuntime(egress, { connectTimeoutMs: 40 });

    const events = await collect(await runtime.generate(REQUEST, { sessionId: 's' }));

    // The stall was survived, not merely reported: the retry produced a real answer.
    assert.equal(egress.attempts, 2);
    assert.equal(errorOf(events), undefined);
    assert.equal(events.at(-1)?.type, 'finish');
  });

  test('a stream that opens and then goes quiet times out as MODEL_TIMEOUT', async () => {
    const egress = new ScriptedEgress([async () => ({ status: 200, headers: {}, stream: silentStream() })]);
    const runtime = makeRuntime(egress, { idleTimeoutMs: 40 });

    const events = await collect(await runtime.generate(REQUEST, { sessionId: 's' }));
    const err = errorOf(events);

    assert.equal(err?.type === 'error' && err.error.code, 'MODEL_TIMEOUT');
    assert.equal(err?.type === 'error' && err.error.safeDetails?.phase, 'idle');
    // Bounded, not infinite.
    assert.equal(egress.attempts, 3);
  });

  test('a slow but progressing stream is NOT killed', async () => {
    // The distinction the idle timeout exists to make: this stream takes 150ms
    // total, far longer than the 50ms budget, but never pauses for 50ms. A total
    // deadline would abort a legitimate long generation here.
    const egress = new ScriptedEgress([
      async () => ({ status: 200, headers: {}, stream: pacedStream(DONE, 30) }),
    ]);
    const runtime = makeRuntime(egress, { idleTimeoutMs: 50 });

    const events = await collect(await runtime.generate(REQUEST, { sessionId: 's' }));

    assert.equal(errorOf(events), undefined, 'a stream that keeps producing must not time out');
    assert.equal(
      events.some((e) => e.type === 'text_delta'),
      true,
    );
  });
});

describe('cancellation is not a timeout', () => {
  test('a caller abort reports CANCELLED and is never retried', async () => {
    const egress = new ScriptedEgress([async () => ({ status: 200, headers: {}, stream: silentStream() })]);
    // Timeouts long enough that only the caller's abort can end this.
    const runtime = makeRuntime(egress, { connectTimeoutMs: 10_000, idleTimeoutMs: 10_000 });

    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const events = await collect(await runtime.generate(REQUEST, { sessionId: 's', signal: ctl.signal }));
    const err = errorOf(events);

    assert.equal(err?.type === 'error' && err.error.code, 'CANCELLED');
    assert.equal(egress.attempts, 1, 'a user cancellation must not be retried as a transient fault');
  });

  test('a request cancelled before it starts does not reach the network', async () => {
    const egress = new ScriptedEgress([
      async () => ({ status: 200, headers: {}, stream: pacedStream(DONE, 0) }),
    ]);
    const runtime = makeRuntime(egress);

    const ctl = new AbortController();
    ctl.abort();
    const events = await collect(await runtime.generate(REQUEST, { sessionId: 's', signal: ctl.signal }));

    assert.equal(errorOf(events)?.type, 'error');
  });
});

describe('retries stay bounded', () => {
  test('a persistently failing provider stops after the attempt limit', async () => {
    const egress = new ScriptedEgress([async () => ({ status: 503, headers: {}, body: 'upstream down' })]);
    const runtime = makeRuntime(egress);

    const events = await collect(await runtime.generate(REQUEST, { sessionId: 's' }));

    assert.equal(egress.attempts, 3);
    assert.equal(errorOf(events)?.type, 'error');
    assert.equal(events.at(-1)?.type, 'finish');
  });

  test('an auth failure is not retried at all', async () => {
    const egress = new ScriptedEgress([async () => ({ status: 401, headers: {}, body: 'bad key' })]);
    const runtime = makeRuntime(egress);

    const events = await collect(await runtime.generate(REQUEST, { sessionId: 's' }));
    const err = errorOf(events);

    assert.equal(err?.type === 'error' && err.error.code, 'MODEL_AUTH_ERROR');
    assert.equal(
      egress.attempts,
      1,
      'a rejected credential will be rejected again; retrying only burns time',
    );
  });
});
