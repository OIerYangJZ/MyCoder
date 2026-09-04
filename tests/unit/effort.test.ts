/**
 * Thinking effort (`src/model/ir.ts`, `src/model/profiles.ts`, the adapters).
 *
 * MyCoder used to send no thinking parameter at all, which meant "whatever the
 * provider does by default" — and on a current frontier model that is adaptive
 * thinking with no ceiling but `max_tokens`. So the interesting cases here are
 * not "does the level reach the wire" but the three places it must be *bent* on
 * the way: a profile that does not think gets nothing, a profile with a ceiling
 * gets the ceiling, and a protocol with a shorter vocabulary gets its own top
 * level rather than a 400.
 *
 * The last of those is the one worth having a test for. `xhigh` on an OpenAI
 * endpoint is not a degraded answer, it is a rejected request, and the failure
 * arrives mid-turn rather than at startup.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampEffort,
  isReasoningEffort,
  REASONING_EFFORTS,
  type ModelRequest,
  type ReasoningEffort,
} from '../../src/model/ir.ts';
import { ModelRegistry, type ModelProfile, type ResolvedModelProfile } from '../../src/model/profiles.ts';
import { AnthropicMessagesAdapter } from '../../src/model/adapters/anthropic.ts';
import { OpenAiResponsesAdapter } from '../../src/model/adapters/openai-responses.ts';
import { OpenAiChatAdapter } from '../../src/model/adapters/openai-chat.ts';
import { configFromToml, defaultConfig, mergeConfig } from '../../src/config/schema.ts';
import { parseToml } from '../../src/util/toml.ts';
import { createTestWorkspace } from '../helpers/workspace.ts';

const BASE: ModelProfile = {
  family: 'test',
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsParallelTools: true,
  supportsReasoning: true,
  preferredEditStrategy: 'exact',
  autonomy: 'long',
  toolReliability: 'high',
  reservedOutputTokens: 32_000,
};

function request(effort?: ReasoningEffort): ModelRequest {
  return {
    requestId: 'req_1',
    modelId: 'test-model',
    provider: 'test',
    system: 'be helpful',
    messages: [],
    tools: [],
    maxOutputTokens: 32_000,
    ...(effort ? { effort } : {}),
  };
}

function resolved(profile: ModelProfile, protocol: ResolvedModelProfile['provider']['protocol']) {
  return {
    alias: 'test',
    modelId: 'test-model',
    provider: { id: 'test', protocol, baseUrl: 'https://example.invalid', authScheme: 'none' as const },
    profile,
  } satisfies ResolvedModelProfile;
}

const bodyOf = (wire: { body: string }): Record<string, unknown> =>
  JSON.parse(wire.body) as Record<string, unknown>;

describe('the level itself', () => {
  test('the five levels are ordered weakest to strongest', () => {
    // `clampEffort` compares indices, so the order is load-bearing rather than
    // presentational — an insertion in the wrong place silently weakens a clamp.
    assert.deepEqual([...REASONING_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('clamping returns the weaker side, whichever side it is on', () => {
    assert.equal(clampEffort('max', 'high'), 'high');
    assert.equal(clampEffort('low', 'high'), 'low');
    assert.equal(clampEffort('high', 'high'), 'high');
  });

  test('a plausible synonym is not a level', () => {
    assert.ok(!isReasoningEffort('minimal'));
    assert.ok(!isReasoningEffort('none'));
    assert.ok(!isReasoningEffort('very-high'));
    assert.ok(isReasoningEffort('xhigh'));
  });
});

describe('resolving a level for a profile', () => {
  test('a profile that does not claim reasoning sends nothing, whatever is configured', () => {
    const profile = { ...BASE, supportsReasoning: false, effort: 'medium' as const };
    assert.equal(ModelRegistry.effortFor(profile), undefined);
    assert.equal(ModelRegistry.effortFor(profile, 'max'), undefined);
  });

  test('the profile default is used when nothing overrides it', () => {
    assert.equal(ModelRegistry.effortFor({ ...BASE, effort: 'xhigh' }), 'xhigh');
  });

  test('an override beats the profile default', () => {
    assert.equal(ModelRegistry.effortFor({ ...BASE, effort: 'low' }, 'max'), 'max');
  });

  test('the profile ceiling beats the override — a ceiling is not a suggestion', () => {
    // The case that turns a working small-model session into a 400: Haiku 4.5
    // rejects `xhigh` and `max`, and `[model] effort = "max"` is a global.
    const capped = { ...BASE, effort: 'medium' as const, effortCeiling: 'high' as const };
    assert.equal(ModelRegistry.effortFor(capped, 'max'), 'high');
    assert.equal(ModelRegistry.effortFor(capped, 'xhigh'), 'high');
    // And it does not raise a weaker request to the ceiling.
    assert.equal(ModelRegistry.effortFor(capped, 'low'), 'low');
  });

  test('a profile with no default and no override sends nothing', () => {
    const { effort: _unused, ...noDefault } = { ...BASE, effort: 'high' as const };
    assert.equal(ModelRegistry.effortFor(noDefault as ModelProfile), undefined);
  });

  test('the shipped profiles resolve to the levels the docs promise', () => {
    const registry = new ModelRegistry();
    const levelFor = (alias: string): ReasoningEffort | undefined => {
      const model = registry.resolve(alias);
      return model ? ModelRegistry.effortFor(model.profile) : undefined;
    };
    assert.equal(levelFor('strongest'), 'xhigh');
    assert.equal(levelFor('balanced'), 'high');
    // `fast` points at a profile that does not claim reasoning, so nothing is
    // sent for it — which is not the same as sending `low`.
    assert.equal(levelFor('fast'), undefined);
  });
});

describe('what each protocol puts on the wire', () => {
  test('anthropic nests the level in output_config, and sends no thinking block', () => {
    const wire = new AnthropicMessagesAdapter().buildRequest(
      request('xhigh'),
      resolved(BASE, 'anthropic-messages'),
    );
    const body = bodyOf(wire);
    assert.deepEqual(body.output_config, { effort: 'xhigh' });
    // A top-level `effort` is ignored rather than rejected, which is the worst
    // of the three outcomes — assert it is not what we send.
    assert.equal(body.effort, undefined);
    // `budget_tokens` is rejected outright by these models and `{type:
    // "disabled"}` is a 400 at high effort, so the supported surface is the
    // level alone.
    assert.equal(body.thinking, undefined);
  });

  test('anthropic sends no output_config when there is no level', () => {
    const body = bodyOf(
      new AnthropicMessagesAdapter().buildRequest(request(), resolved(BASE, 'anthropic-messages')),
    );
    assert.equal(body.output_config, undefined);
  });

  test('all five levels survive the anthropic protocol unchanged', () => {
    for (const level of REASONING_EFFORTS) {
      const body = bodyOf(
        new AnthropicMessagesAdapter().buildRequest(request(level), resolved(BASE, 'anthropic-messages')),
      );
      assert.deepEqual(body.output_config, { effort: level }, `${level} was altered`);
    }
  });

  test('the responses protocol nests it under reasoning and clamps to high', () => {
    const adapter = new OpenAiResponsesAdapter();
    const high = bodyOf(adapter.buildRequest(request('high'), resolved(BASE, 'openai-responses')));
    assert.deepEqual(high.reasoning, { effort: 'high' });

    // This protocol has no `xhigh` and no `max`. Unclamped, the request is
    // rejected mid-turn rather than answered at a lower level.
    for (const level of ['xhigh', 'max'] as const) {
      const body = bodyOf(adapter.buildRequest(request(level), resolved(BASE, 'openai-responses')));
      assert.deepEqual(body.reasoning, { effort: 'high' }, `${level} reached an OpenAI endpoint`);
    }
  });

  test('the chat protocol uses the flat key, clamped the same way', () => {
    const adapter = new OpenAiChatAdapter();
    assert.equal(
      bodyOf(adapter.buildRequest(request('medium'), resolved(BASE, 'openai-chat'))).reasoning_effort,
      'medium',
    );
    assert.equal(
      bodyOf(adapter.buildRequest(request('max'), resolved(BASE, 'openai-chat'))).reasoning_effort,
      'high',
    );
  });

  test('neither OpenAI protocol sends a level for a profile that does not reason', () => {
    const plain = { ...BASE, supportsReasoning: false };
    assert.equal(
      bodyOf(new OpenAiChatAdapter().buildRequest(request('high'), resolved(plain, 'openai-chat')))
        .reasoning_effort,
      undefined,
    );
    assert.equal(
      bodyOf(new OpenAiResponsesAdapter().buildRequest(request('high'), resolved(plain, 'openai-responses')))
        .reasoning,
      undefined,
    );
  });

  test('providerOptions still wins, because it is the documented escape hatch', () => {
    const body = bodyOf(
      new AnthropicMessagesAdapter().buildRequest(
        { ...request('low'), providerOptions: { output_config: { effort: 'max' } } },
        resolved(BASE, 'anthropic-messages'),
      ),
    );
    assert.deepEqual(body.output_config, { effort: 'max' });
  });
});

/**
 * The chain end to end: `/effort` → the session → the `ModelRequest`.
 *
 * The adapter tests above prove `ModelRequest.effort` reaches the wire, and
 * `effortFor` proves the level resolves. This is the join between them, and it is
 * the part that was never exercised: a resolver that works and an adapter that
 * works still ship nothing if `buildRequest` forgets to call one.
 */
describe('from the control command to the request', () => {
  test('the level a session resolves is the level on its next request', async () => {
    const ws = await createTestWorkspace({
      script: [{ kind: 'final', text: 'done' }],
      // `fake` is the only alias a test workspace has, and its profile does not
      // claim reasoning — so this asserts the *absent* case first, which is the
      // one a careless implementation gets wrong by sending `low`.
    });
    try {
      await ws.kernel.session.runTurn('anything');
      assert.equal(ws.fakeModel.requests.length, 1);
      assert.equal(
        ws.fakeModel.requests[0]?.effort,
        undefined,
        'a profile that does not claim reasoning must send no level at all',
      );

      // Now make the profile reasoning-capable and set an override, and the very
      // next request must carry it.
      ws.kernel.modelRegistry.registerProfile('fake', {
        family: 'fake',
        contextWindow: 8_000,
        maxOutputTokens: 1_000,
        supportsParallelTools: true,
        supportsReasoning: true,
        preferredEditStrategy: 'exact',
        autonomy: 'normal',
        toolReliability: 'high',
        reservedOutputTokens: 1_000,
        effort: 'medium',
      });

      const set = await ws.kernel.control.execute('/effort xhigh');
      assert.ok(set.ok, set.message);

      await ws.kernel.session.runTurn('again');
      assert.equal(ws.fakeModel.requests.length, 2);
      assert.equal(ws.fakeModel.requests[1]?.effort, 'xhigh', '/effort did not reach the request');

      // And clearing it falls back to the profile default rather than to nothing.
      assert.ok((await ws.kernel.control.execute('/effort default')).ok);
      await ws.kernel.session.runTurn('once more');
      assert.equal(ws.fakeModel.requests[2]?.effort, 'medium');
    } finally {
      await ws.cleanup();
    }
  });

  test('a profile ceiling still applies to a level set at runtime', async () => {
    const ws = await createTestWorkspace({ script: [{ kind: 'final', text: 'done' }] });
    try {
      ws.kernel.modelRegistry.registerProfile('fake', {
        family: 'fake',
        contextWindow: 8_000,
        maxOutputTokens: 1_000,
        supportsParallelTools: true,
        supportsReasoning: true,
        preferredEditStrategy: 'exact',
        autonomy: 'normal',
        toolReliability: 'high',
        reservedOutputTokens: 1_000,
        effort: 'low',
        effortCeiling: 'high',
      });

      await ws.kernel.control.execute('/effort max');
      await ws.kernel.session.runTurn('anything');
      assert.equal(
        ws.fakeModel.requests[0]?.effort,
        'high',
        'the ceiling was bypassed by a runtime override',
      );
    } finally {
      await ws.cleanup();
    }
  });
});

describe('configuration', () => {
  test('[model] effort is read, and an unknown level warns by name', () => {
    const good = configFromToml(parseToml('[model]\neffort = "xhigh"\n'), 'test');
    assert.equal(good.model?.effort, 'xhigh');

    const bad = configFromToml(parseToml('[model]\neffort = "extreme"\n'), 'test');
    assert.equal(bad.model?.effort, undefined, 'an unparseable level must not silently become one');
    assert.match(bad.warnings?.join('\n') ?? '', /effort is "extreme"/);
    // The levels are listed rather than "invalid", because the usual mistake is
    // a plausible synonym and the set is short enough to print.
    assert.match(bad.warnings?.join('\n') ?? '', /low, medium, high, xhigh, max/);
  });

  test('a profile may carry its own default and its own ceiling', () => {
    const parsed = configFromToml(
      parseToml(`
[model.profile.custom]
context_window = 128000
supports_reasoning = true
effort = "medium"
effort_ceiling = "high"
`),
      'test',
    );
    assert.equal(parsed.model?.profiles?.custom?.effort, 'medium');
    assert.equal(parsed.model?.profiles?.custom?.effortCeiling, 'high');
  });

  test('a later layer overrides the level, because cost is not a boundary', () => {
    // Unlike the approval mode, which merges strictest-wins: thinking harder or
    // less hard is a spend decision, not a permission.
    const merged = mergeConfig(
      { ...defaultConfig(), model: { default: 'strongest', effort: 'low' } },
      { model: { effort: 'max' } },
    );
    assert.equal(merged.model.effort, 'max');
  });
});
