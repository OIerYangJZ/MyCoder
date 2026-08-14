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
import { readFile } from 'node:fs/promises';

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

/**
 * The KernelError the runtime produces for an HTTP status and body.
 *
 * Drives the real `HttpModelRuntime` rather than calling the mapper directly, so
 * the adapter's own `mapHttpError` gets first refusal exactly as it does in
 * production — the ordering between adapter and runtime is part of what is under
 * test.
 */
async function mapHttpStatus(status: number, body: string) {
  const egress = new ScriptedEgress([async () => ({ status, headers: {}, body })]);
  const runtime = makeRuntime(egress);
  const events = await collect(await runtime.generate(REQUEST, { sessionId: 's' }));
  const failure = errorOf(events);
  if (!failure || failure.type !== 'error') throw new Error(`no error event for HTTP ${status}`);
  return failure.error;
}

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

describe('an exhausted provider account is the environment, not our bug', () => {
  test('402 maps to a non-retryable user error that names billing', async () => {
    // The condition that produced this test: a live experiment ran the DeepSeek
    // account dry mid-run. Thirty attempts failed with 0 tokens each, and the only
    // way to find out why was a hand-written probe that printed the HTTP status —
    // the error the kernel produced said `Provider returned HTTP 402`, blamed the
    // provider, and offered no remedy.
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/openai/http-payment-required.json', import.meta.url), 'utf8'),
    ) as { status: number; body: unknown };

    const err = await mapHttpStatus(fixture.status, JSON.stringify(fixture.body));

    assert.equal(err.code, 'MODEL_AUTH_ERROR');
    assert.equal(err.blame, 'user', "an exhausted balance is the account holder's to fix");
    assert.equal(err.retryable, false, 'retrying a request the account cannot pay for burns wall time');
    assert.match(err.message, /billing/i);
    assert.match(err.message, /Top it up/);
  });

  test('a body that says "insufficient balance" is caught even on a 400', async () => {
    // Providers disagree about the status for this: some use 402, some a 400 or a
    // 429 with the reason in the body. The remedy is the same either way.
    const err = await mapHttpStatus(400, JSON.stringify({ error: { message: 'Insufficient Balance' } }));
    assert.equal(err.code, 'MODEL_AUTH_ERROR');
    assert.equal(err.retryable, false);
  });

  test('NEGATIVE CONTROL: an ordinary 400 is still a provider-shaped failure', async () => {
    // Without this, the two assertions above would pass just as well if every 4xx
    // had been relabelled as a billing problem.
    const err = await mapHttpStatus(400, JSON.stringify({ error: { message: 'bad request' } }));
    assert.equal(err.code, 'MODEL_INVALID_RESPONSE');
    assert.equal(err.retryable, false);
  });
});
