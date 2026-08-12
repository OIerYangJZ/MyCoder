/**
 * Live provider validation (alpha.2 §27, §28, §7).
 *
 * Run with `pnpm test:live:model`. **Skips cleanly** when no credential is
 * present, so it is safe to invoke anywhere — and so a missing key never looks
 * like a pass. The suite prints why it skipped.
 *
 * Never runs in ordinary CI: §27 forbids secret-bearing tests on untrusted pull
 * requests, and `.github/workflows/live-model.yml` is `workflow_dispatch` only.
 *
 * Cost is bounded on purpose: tiny prompts, `max_tokens` clamped, a handful of
 * requests. This validates the *protocol*, not the model's coding ability —
 * that is what the golden tasks are for.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createKernel, type Kernel } from '../../src/kernel.ts';
import { collectModelEvents, type ModelEvent } from '../../src/model/ir.ts';
import { resolveUsage } from '../../src/model/usage.ts';

/** Which provider this run validates. One only, per §2.1. */
const PROVIDER = process.env.KERNEL_LIVE_PROVIDER ?? 'anthropic';
const ALIAS = process.env.KERNEL_LIVE_MODEL ?? 'fast';

// A provider whose reasoning is not validated must not have its tool-call test
// blamed on the adapter; §13 says the same about parallel tools.

/**
 * Which environment variable holds the credential.
 *
 * Built-in providers are known; a configured provider (`[model.provider.x]` with
 * `api_key_env`) supplies its own, passed as KERNEL_LIVE_KEY_ENV. That keeps the
 * suite provider-agnostic rather than hard-coding the two vendors — which is the
 * same architectural claim the milestone is making everywhere else.
 */
const CREDENTIAL_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const credentialVar =
  process.env.KERNEL_LIVE_KEY_ENV ?? CREDENTIAL_ENV[PROVIDER] ?? `${PROVIDER.toUpperCase()}_API_KEY`;

/**
 * Two conditions, both required.
 *
 * The credential alone is not enough: a developer with a key exported would
 * otherwise fire real, billed requests from a plain `pnpm test`. `KERNEL_LIVE=1`
 * is set only by `pnpm test:live:model`, so spending money is always something
 * someone chose to do.
 */
const optedIn = process.env.KERNEL_LIVE === '1';
const hasCredential = Boolean(process.env[credentialVar]);
const enabled = optedIn && hasCredential;

const skip = enabled
  ? false
  : !optedIn
    ? 'KERNEL_LIVE is not set — run `pnpm test:live:model` to opt in (this is not a pass)'
    : `no ${credentialVar} in the environment — live validation skipped (this is not a pass)`;

/** Printed once so a skipped run says exactly what it wanted. */
const liveTarget = `${PROVIDER}/${ALIAS} (credential: ${credentialVar})`;

let kernel: Kernel | undefined;
let base: string | undefined;

async function boot(): Promise<Kernel> {
  base = await mkdtemp(path.join(tmpdir(), 'live-model-'));
  const root = path.join(base, 'workspace');
  await (await import('node:fs/promises')).mkdir(root, { recursive: true });

  const k = await createKernel({
    workspaceDir: root,
    dirsRoot: path.join(base, 'kernel-dirs'),
    modelOverride: ALIAS,
    logLevel: 'silent',
  });
  return k;
}

/** One bounded request. Keeps live cost predictable (§27). */
async function ask(k: Kernel, prompt: string, maxTokens = 64) {
  const resolved = k.modelRegistry.resolve(ALIAS);
  assert.ok(resolved, `model alias "${ALIAS}" is not registered`);

  const stream = await k.modelRuntime.generate(
    {
      requestId: `live_${Date.now()}`,
      modelId: resolved.modelId,
      provider: resolved.provider.id,
      system: 'Answer in as few words as possible.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }], origin: { kind: 'user' } }],
      tools: [],
      maxOutputTokens: maxTokens,
    },
    { sessionId: k.sessionId },
  );

  const events: ModelEvent[] = [];
  const turn = await collectModelEvents(stream, (e) => events.push(e));
  return { turn, events };
}

describe('live provider', { skip }, () => {
  before(async () => {
    if (!enabled) return;
    kernel = await boot();
  });

  test('authenticates and streams text (§10, RM1)', async () => {
    const { turn, events } = await ask(kernel!, 'Reply with exactly: ok');

    assert.equal(turn.error, undefined, `request failed: ${turn.error?.code} ${turn.error?.message}`);
    assert.ok(turn.text.length > 0, 'the provider returned no text');
    assert.ok(
      events.filter((e) => e.type === 'text_delta').length >= 1,
      'text should arrive as deltas, not one blob',
    );
    assert.ok(
      ['completed', 'truncated'].includes(turn.finishReason),
      `unexpected finish: ${turn.finishReason}`,
    );
  });

  test('reports usage, and provenance says so (§17)', async () => {
    const { turn } = await ask(kernel!, 'Reply with exactly: ok');
    const usage = resolveUsage(turn.usage, { responseText: turn.text });

    assert.equal(
      usage.inputTokens.provenance,
      'reported',
      'a live provider must report input tokens; falling back to an estimate here would hide a regression',
    );
    assert.equal(usage.outputTokens.provenance, 'reported');
    assert.ok(usage.inputTokens.value > 0);
  });

  test('streams a tool call and assembles its arguments (§11, RM2)', async () => {
    const resolved = kernel!.modelRegistry.resolve(ALIAS)!;
    const stream = await kernel!.modelRuntime.generate(
      {
        requestId: `live_tool_${Date.now()}`,
        modelId: resolved.modelId,
        provider: resolved.provider.id,
        system: 'Use the Read tool to read the file the user names. Do not answer in prose.',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Read src/auth.ts' }], origin: { kind: 'user' } },
        ],
        tools: [
          {
            name: 'Read',
            description: 'Read a file from the workspace.',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string', description: 'file to read' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
        maxOutputTokens: 256,
      },
      { sessionId: kernel!.sessionId },
    );

    const turn = await collectModelEvents(stream);

    assert.equal(turn.error, undefined, `request failed: ${turn.error?.code}`);
    assert.ok(turn.toolCalls.length >= 1, 'the model did not call the tool; try a more capable alias');

    const call = turn.toolCalls[0]!;
    assert.equal(call.name, 'Read');
    // The point of RM2: ToolRuntime must receive parsed arguments, never a
    // fragment. `__unparsed` here would mean assembly is broken on the wire.
    assert.equal(
      Object.prototype.hasOwnProperty.call(call.arguments as object, '__unparsed'),
      false,
      'tool arguments arrived unparsed — fragment assembly is broken',
    );
    assert.equal(typeof (call.arguments as { path?: unknown }).path, 'string');
    assert.equal(turn.finishReason, 'tool_calls');
  });

  test('cancellation aborts the request, and is not retried as a transient error (§19)', async () => {
    const resolved = kernel!.modelRegistry.resolve(ALIAS)!;
    const controller = new AbortController();

    const streamPromise = kernel!.modelRuntime.generate(
      {
        requestId: `live_cancel_${Date.now()}`,
        modelId: resolved.modelId,
        provider: resolved.provider.id,
        system: '',
        messages: [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'Count slowly from 1 to 200, one number per line.' }],
            origin: { kind: 'user' },
          },
        ],
        tools: [],
        maxOutputTokens: 1024,
      },
      { sessionId: kernel!.sessionId, signal: controller.signal },
    );

    const stream = await streamPromise;
    let seen = 0;
    setTimeout(() => controller.abort(), 300);

    const turn = await collectModelEvents(
      (async function* () {
        try {
          for await (const event of stream) {
            seen += 1;
            yield event;
          }
        } catch {
          // An aborted transport throws; the loop treats that as cancellation.
        }
      })(),
    );

    assert.ok(seen > 0, 'the stream produced nothing before cancellation');
    // A cancelled request must not come back as MODEL_RATE_LIMIT or any other
    // retryable class — retrying what the user cancelled is a real-money bug.
    assert.notEqual(turn.error?.code, 'MODEL_RATE_LIMIT');
    if (turn.error) assert.equal(turn.error.retryable, false, 'cancellation must not be retryable');
  });

  test('an invalid credential maps to MODEL_AUTH_ERROR without echoing the key (§22)', async () => {
    const bad = await boot();
    try {
      // Register a deliberately wrong credential for this kernel only, under
      // whichever provider ref the active alias actually resolves to.
      const resolved = bad.modelRegistry.resolve(ALIAS);
      const ref = resolved?.provider.authSecretRef ?? `provider/${PROVIDER}`;
      bad.secrets.register(ref, { kind: 'literal', value: 'INVALID-CREDENTIAL-FIXTURE' });

      const { turn } = await ask(bad, 'hello');

      assert.equal(turn.error?.code, 'MODEL_AUTH_ERROR');
      assert.equal(turn.error?.retryable, false, 'a bad credential must not be retried');

      const serialized = JSON.stringify(turn.error);
      assert.equal(
        serialized.includes('INVALID-CREDENTIAL-FIXTURE'),
        false,
        'the error echoed the credential',
      );
      assert.equal(/authorization|x-api-key/i.test(serialized), false, 'the error echoed an auth header');
    } finally {
      await bad.shutdown();
    }
  });
});

// --- §7, §28 credential isolation ------------------------------------------

describe('live credential isolation (§7, §28)', { skip }, () => {
  test('the credential never reaches a Shell subprocess', async () => {
    const k = kernel!;
    const results: string[] = [];

    const routed = k.modelRuntime as unknown as { routes: Map<string, unknown> };
    void routed;

    // Run a shell command that dumps its whole environment, through the real
    // tool path, and search it for the credential.
    const { FakeModel } = await import('../../src/model/adapters/fake.ts');
    routed.routes.set(
      'fake',
      new FakeModel({
        script: [
          {
            kind: 'tools',
            calls: [
              { name: 'Shell', arguments: { argv: ['sh', '-c', 'env; echo "$' + credentialVar + '"'] } },
            ],
          },
          { kind: 'final', text: 'done' },
        ],
      }),
    );
    k.session.selectModel('fake');
    await k.session.runTurn('dump the environment');

    for (const message of k.context.history()) {
      if (message.role !== 'tool') continue;
      for (const part of message.parts) if (part.type === 'tool_result') results.push(part.content);
    }

    const joined = results.join('\n');
    const credential = process.env[credentialVar]!;
    assert.equal(joined.includes(credential), false, 'the provider credential reached a subprocess');
    assert.equal(joined.includes(credentialVar), false, 'even the variable name should be absent');

    k.session.selectModel(ALIAS);
  });

  test('the credential never reaches the event log or the session store', async () => {
    const credential = process.env[credentialVar]!;
    const events: string[] = [];
    for await (const event of kernel!.store.readEvents(kernel!.sessionId)) events.push(JSON.stringify(event));

    assert.equal(events.join('\n').includes(credential), false, 'the credential reached the event log');
  });

  test('the credential is never registered as a redaction canary (§38)', () => {
    // §38 is explicit: do not use the real credential as a canary string. If it
    // were registered as a literal, a leak test would "pass" by redacting the
    // very thing it is supposed to prove never travelled.
    const credential = process.env[credentialVar]!;
    assert.equal(
      kernel!.redactor.literalValues().includes(credential),
      false,
      'the real credential must not be in the redactor literal set',
    );
  });
});

describe('live validation status', () => {
  test('reports whether it ran', (t) => {
    if (!enabled) {
      t.diagnostic(`SKIPPED: ${skip}`);
      t.diagnostic(`target would have been ${liveTarget}`);
      t.diagnostic('alpha.2 cannot be tagged until this suite has actually run.');
    } else {
      t.diagnostic(`live validation ran against ${liveTarget}`);
    }
    assert.ok(true);
  });
});

process.on('exit', () => {
  void kernel?.shutdown();
  if (base) void rm(base, { recursive: true, force: true });
});
