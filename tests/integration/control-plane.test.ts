/**
 * Control plane (§15) and session resume (§21.3).
 *
 * The property under test throughout: a slash command changes kernel state
 * without the model being consulted. Each test therefore asserts on kernel state
 * directly and checks that the model was never called.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTestWorkspace } from '../helpers/workspace.ts';
import { FakeModel } from '../../src/model/adapters/fake.ts';
import { MemorySessionStore } from '../../src/session/store.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { replaySession, checkResumeIdentity, workspaceIdentity } from '../../src/session/resume.ts';
import { FakeClock } from '../../src/util/clock.ts';
import type { SessionId } from '../../src/util/ids.ts';
import type { SessionMetadata } from '../../src/session/store.ts';
import { parseArgs } from '../../src/cli/args.ts';
import { parseDuration, tokenize } from '../../src/control/control-plane.ts';
import { renderApproval } from '../../src/cli/prompter.ts';

describe('/model', () => {
  test('changes the session model without consulting the model', async () => {
    const ws = await createTestWorkspace({ files: {} });
    try {
      const before = ws.fakeModel.callCount;

      const list = await ws.kernel.control.execute('/model list');
      assert.ok(list.ok);
      assert.match(list.message, /fake/);

      const use = await ws.kernel.control.execute('/model use strongest');
      assert.ok(use.ok, use.message);
      assert.equal(ws.kernel.session.activeModelAlias, 'strongest');
      assert.ok(use.projection, 'the change is projected so the model learns about it');

      assert.equal(ws.fakeModel.callCount, before, 'no model request was made');
    } finally {
      await ws.cleanup();
    }
  });

  test('an unknown alias is refused and the model is unchanged', async () => {
    const ws = await createTestWorkspace({ files: {} });
    try {
      const result = await ws.kernel.control.execute('/model use not-a-model');
      assert.equal(result.ok, false);
      assert.equal(ws.kernel.session.activeModelAlias, 'fake');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('/goal', () => {
  test('sets, adds criteria, pauses and clears without granting permissions', async () => {
    const ws = await createTestWorkspace({ files: {} });
    try {
      await ws.kernel.control.execute('/goal set make the tests pass');
      assert.equal(ws.kernel.session.goal?.objective, 'make the tests pass');
      assert.equal(ws.kernel.session.goal?.status, 'active');

      await ws.kernel.control.execute('/goal criteria npm test exits zero');
      assert.deepEqual(ws.kernel.session.goal?.criteria, ['npm test exits zero']);

      const setResult = await ws.kernel.control.execute('/goal set now do something else');
      assert.match(setResult.projection ?? '', /does not change what you are permitted to do/);

      await ws.kernel.control.execute('/goal pause');
      assert.equal(ws.kernel.session.goal?.status, 'paused');

      await ws.kernel.control.execute('/goal clear');
      assert.equal(ws.kernel.session.goal, undefined);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('/loop', () => {
  test('start narrows the budget and cannot exceed the ceiling', async () => {
    const ws = await createTestWorkspace({ files: {} });
    try {
      const narrowed = await ws.kernel.control.execute('/loop start --max-steps 4 --max-time 30s');
      assert.ok(narrowed.ok, narrowed.message);
      assert.match(narrowed.message, /steps\s+: 4/);

      const tooBig = await ws.kernel.control.execute('/loop start --max-steps 9999');
      assert.ok(tooBig.ok);
      assert.match(tooBig.message, /Clamped to the session ceiling/);
      assert.match(tooBig.message, new RegExp(`steps\\s+: ${ws.kernel.session.budgetCeiling.maxSteps}`));

      const bad = await ws.kernel.control.execute('/loop start --max-steps banana');
      assert.equal(bad.ok, false);
    } finally {
      await ws.cleanup();
    }
  });

  test('duration parsing accepts the documented suffixes', () => {
    assert.equal(parseDuration('20m'), 1_200_000);
    assert.equal(parseDuration('90s'), 90_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('nonsense'), undefined);
  });
});

describe('/permissions', () => {
  test('shows the layers and can reset session approvals', async () => {
    const ws = await createTestWorkspace({ files: {} });
    try {
      ws.kernel.policy.approvals.record('process.exec:npm:install', true, 'npm install', 1);

      const show = await ws.kernel.control.execute('/permissions show');
      assert.match(show.message, /Permission profile/);
      assert.match(show.message, /Isolation\s+: policy-enforced/);
      assert.match(show.message, /Permanently denied/);
      assert.match(show.message, /process\.exec:npm:install/);

      const explain = await ws.kernel.control.execute('/permissions explain process.exec:npm:install');
      assert.match(explain.message, /allowed for this session/);

      const reset = await ws.kernel.control.execute('/permissions reset-session');
      assert.match(reset.message, /Cleared 1 session approval/);
      assert.equal(ws.kernel.policy.approvals.size, 0);
    } finally {
      await ws.cleanup();
    }
  });

  test('there is no command that disables security', async () => {
    const ws = await createTestWorkspace({ files: {} });
    try {
      const commands = ws.kernel.control.commandNames();
      for (const forbidden of ['disable-all-security', 'dangerously-bypass', 'bypass']) {
        assert.equal(commands.includes(forbidden), false, `/${forbidden} must not exist`);
      }
      const attempt = await ws.kernel.control.execute('/permissions disable-all-security');
      // Unknown subcommand falls through to `show`; what matters is that nothing changed.
      assert.match(attempt.message, /Permission profile/);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('/status and /compact', () => {
  test('status reports the honest isolation level', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'x\n' } });
    try {
      const status = await ws.kernel.control.execute('/status');
      assert.match(status.message, /session\s+: ses_/);
      assert.match(status.message, /isolation\s+: policy-enforced/);
      assert.match(status.message, /network from Shell is best-effort/);
      assert.match(status.message, /telemetry\s+:.*content upload permanently off/);
      assert.match(status.message, /context\s+: ~\d/);
    } finally {
      await ws.cleanup();
    }
  });

  test('compact reduces the projection and invalidates receipts', async () => {
    const ws = await createTestWorkspace({
      files: { 'a.ts': 'const x = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'a.ts' } }] },
        { kind: 'final', text: 'read it' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read the file');
      assert.ok(ws.kernel.freshness.size > 0, 'a receipt exists before compaction');

      // Pad the conversation so compaction has something to do.
      for (let i = 0; i < 40; i += 1) {
        ws.kernel.context.appendUser('x'.repeat(2000));
      }

      const result = await ws.kernel.control.execute('/compact');
      assert.ok(result.ok);
      assert.match(result.projection ?? '', /Read receipts from before the summary are no longer valid/);
      assert.equal(ws.kernel.freshness.size, 0, 'receipts do not survive compaction');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('/remote', () => {
  test('lists nothing when no remotes are configured and never invents one', async () => {
    const ws = await createTestWorkspace({ files: {} });
    try {
      const list = await ws.kernel.control.execute('/remote list');
      assert.match(list.message, /No remotes are configured/);

      const connect = await ws.kernel.control.execute('/remote connect nowhere');
      assert.equal(connect.ok, false);
      assert.match(connect.message, /not configured/);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('command dispatch', () => {
  test('an unknown command suggests the closest match', async () => {
    const ws = await createTestWorkspace({ files: {} });
    try {
      const result = await ws.kernel.control.execute('/statuss');
      assert.equal(result.ok, false);
      assert.match(result.message, /Did you mean "\/status"/);
    } finally {
      await ws.cleanup();
    }
  });

  test('tokenize honours quotes', () => {
    assert.deepEqual(tokenize('goal set "make the tests pass"'), ['goal', 'set', 'make the tests pass']);
  });
});

describe('CLI flags (§15.1)', () => {
  test('all documented flags parse', () => {
    const args = parseArgs([
      '-m',
      'strongest',
      '--profile',
      'review',
      '--cwd',
      '/tmp/x',
      '--remote',
      'dev-vps',
      '--no-telemetry',
      '--json',
      'fix the bug',
    ]);
    assert.equal(args.model, 'strongest');
    assert.equal(args.profile, 'review');
    assert.equal(args.cwd, '/tmp/x');
    assert.equal(args.remote, 'dev-vps');
    assert.equal(args.noTelemetry, true);
    assert.equal(args.json, true);
    assert.equal(args.prompt, 'fix the bug');
    assert.deepEqual(args.errors, []);
  });

  test('-c and -r are recognised', () => {
    assert.equal(parseArgs(['-c']).continueSession, true);
    assert.equal(parseArgs(['-r', 'ses_abc']).resumeSessionId, 'ses_abc');
  });

  test('--read-only wins over a conflicting --profile, loudly', () => {
    const args = parseArgs(['--read-only', '--profile', 'workspace-dev']);
    assert.equal(args.profile, 'read-only');
    assert.ok(args.errors.some((e) => /conflicts/.test(e)));
  });

  test('an unknown flag is an error, not silently ignored', () => {
    assert.ok(parseArgs(['--definitely-not-a-flag']).errors.length > 0);
  });
});

describe('approval rendering (§11.4)', () => {
  test('shows semantics, not just the raw command', () => {
    const text = renderApproval({
      subject: {
        key: 'Shell:npm:install',
        title: 'Run npm install zod',
        details: [
          'command: npm install zod',
          'directory: .',
          'network: registry.npmjs.org (best-effort — this backend cannot truly block sockets)',
        ],
        risk: 'high',
      },
      toolName: 'Shell',
      toolCallId: 'call_1',
      pending: [
        {
          action: 'ask',
          access: {
            kind: 'network.connect',
            host: 'registry.npmjs.org',
            port: 443,
            via: 'shell',
            display: 'registry.npmjs.org:443',
          },
          subjectKey: 'network.connect:shell:registry.npmjs.org:443',
          reason: 'network access is opt-in per host',
          final: false,
          errorCode: 'NETWORK_DENIED',
        },
      ],
    });

    assert.match(text, /high risk/);
    assert.match(text, /registry\.npmjs\.org/);
    assert.match(text, /best-effort/, 'the prompt must not overstate the isolation');
    assert.match(text, /scope\s+: this call only, or the rest of this session/);
  });
});

describe('resume (§21.3)', () => {
  test('an interrupted tool call gets a synthetic result on replay', async () => {
    const redactor = new Redactor();
    const clock = new FakeClock();
    const store = new MemorySessionStore(redactor, clock);
    const sessionId = 'ses_test' as SessionId;

    const metadata: SessionMetadata = {
      sessionId,
      createdAt: 1,
      updatedAt: 1,
      kernelVersion: '0.1.0',
      workspaceRoot: '/repo',
      workspaceIdentity: workspaceIdentity('/repo', '/repo'),
      model: 'fake',
      permissionProfile: 'workspace-dev',
      backendKind: 'local',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
        modelRequests: 0,
        toolCalls: 0,
      },
      lastSeq: 0,
    };
    await store.createSession(metadata);

    await store.append(sessionId, {
      type: 'turn.started',
      payload: { input: 'fix the bug', origin: 'user' },
    });
    await store.append(sessionId, {
      type: 'model.response',
      payload: { textLength: 20, finishReason: 'tool_calls' },
    });
    await store.append(sessionId, {
      type: 'tool.call',
      payload: { toolCallId: 'call_a', name: 'Read', argsSummary: '{"path":"a.ts"}' },
    });
    await store.append(sessionId, {
      type: 'tool.result',
      payload: { toolCallId: 'call_a', isError: false, contentBytes: 40 },
    });
    // A second call that never got its result: the process died here.
    await store.append(sessionId, {
      type: 'tool.call',
      payload: { toolCallId: 'call_b', name: 'Shell', argsSummary: '{"argv":["npm","test"]}' },
    });

    const replayed = await replaySession(store, sessionId);
    assert.ok(replayed);
    assert.deepEqual(replayed.interrupted, ['call_b']);

    // Every call now has a result — invariant 1 survives a crash.
    const called = new Set<string>();
    const answered = new Set<string>();
    for (const message of replayed.messages) {
      for (const part of message.parts) {
        if (part.type === 'tool_call') called.add(part.id);
        if (part.type === 'tool_result') answered.add(part.toolCallId);
      }
    }
    assert.deepEqual([...called].sort(), ['call_a', 'call_b']);
    for (const id of called) assert.ok(answered.has(id), `${id} was left unanswered`);

    const synthetic = replayed.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result' && p.toolCallId === 'call_b');
    assert.ok(synthetic && synthetic.type === 'tool_result');
    assert.equal(synthetic.isError, true);
    assert.match(synthetic.content, /outcome of this call is unknown/);

    assert.match(replayed.freshnessNote, /Read receipts do not survive a restart/);
  });

  test('resuming into a different workspace is refused', () => {
    const metadata = {
      workspaceRoot: '/repo-a',
      workspaceIdentity: 'aaaa',
    } as SessionMetadata;

    const wrong = checkResumeIdentity(metadata, {
      workspaceRoot: '/repo-b',
      workspaceIdentity: 'bbbb',
    });
    assert.equal(wrong.ok, false);
    assert.match(wrong.problems[0]!, /was created in \/repo-a/);

    const right = checkResumeIdentity(metadata, {
      workspaceRoot: '/repo-a',
      workspaceIdentity: 'aaaa',
    });
    assert.equal(right.ok, true);
  });

  test('a remote mismatch is refused', () => {
    const metadata = {
      workspaceRoot: '/repo',
      workspaceIdentity: 'aaaa',
      remote: 'dev-vps',
    } as SessionMetadata;

    const result = checkResumeIdentity(metadata, { workspaceRoot: '/repo', workspaceIdentity: 'aaaa' });
    assert.equal(result.ok, false);
    assert.match(result.problems[0]!, /remote "dev-vps"/);
  });
});

describe('event log hygiene', () => {
  test('the log stores hashes and sizes, never prompts or file contents', async () => {
    const ws = await createTestWorkspace({
      files: { 'secret-ish.ts': 'const DISTINCTIVE_SOURCE_MARKER = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'secret-ish.ts' } }] },
        { kind: 'final', text: 'The DISTINCTIVE_ANSWER_MARKER is here.' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read the file and DISTINCTIVE_PROMPT_MARKER');
      const log = await ws.eventLogText();

      assert.equal(
        log.includes('DISTINCTIVE_SOURCE_MARKER'),
        false,
        'file contents must not reach the event log',
      );
      assert.equal(
        log.includes('DISTINCTIVE_ANSWER_MARKER'),
        false,
        'assistant content must not reach the event log by default',
      );
      // The user's own input is retained deliberately, so a resumed session can
      // show what was asked (§21.3 step 1).
      assert.ok(log.includes('DISTINCTIVE_PROMPT_MARKER'));

      assert.match(log, /"payloadHash"/, 'the model request is recorded as a hash');
      assert.match(log, /"contentHash"/, 'the read is recorded as a hash');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('fake model plumbing', () => {
  test('the fake model streams text in chunks and reports usage', async () => {
    const model = new FakeModel({ script: [{ kind: 'final', text: 'hello world from the fake model' }] });
    const stream = await model.generate(
      {
        requestId: 'r1',
        modelId: 'fake-1',
        provider: 'fake',
        system: '',
        messages: [],
        tools: [],
      },
      { sessionId: 's' },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    assert.ok(events.filter((e) => e === 'text_delta').length > 1, 'text really streams');
    assert.ok(events.includes('usage'));
    assert.equal(events.at(-1), 'finish');
  });
});
