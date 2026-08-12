/**
 * Hook execution (spec §18.3).
 *
 * This suite exists because a typecheck found a `ReferenceError` on the only
 * path that runs a project hook — `PolicyEngine.combine` called a helper that
 * was no longer imported. Every hook invocation would have thrown, and no test
 * noticed, because nothing here actually *ran* a hook end to end. Parsing hook
 * configuration was covered; executing one was not.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { HookRunner, parseHookTable, renderHookOutput } from '../../src/extensions/hooks.ts';
import { PolicyEngine } from '../../src/policy/policy-engine.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';
import { readOnlyProfile, workspaceDevProfile } from '../../src/policy/profiles.ts';
import { LocalExecutionBackend } from '../../src/execution/local.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { nullLogger } from '../../src/util/logger.ts';
import { parseToml } from '../../src/util/toml.ts';
import { canonicalize, type CanonicalPath } from '../../src/util/paths.ts';

interface Harness {
  root: CanonicalPath;
  runner(config: string, profile?: 'workspace-dev' | 'read-only'): HookRunner;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const base = await mkdtemp(path.join(tmpdir(), 'hooks-test-'));
  const root = (await canonicalize(base, { cwd: base })).path;
  const redactor = new Redactor();
  const backend = await LocalExecutionBackend.detect({ workspaceRoot: root, redactor, logger: nullLogger });

  return {
    root,
    runner(config, profile = 'workspace-dev') {
      const ctx = { workspaceRoot: root };
      const policy = new PolicyEngine({
        workspaceRoot: root,
        protectedPaths: new ProtectedPaths({ home: base }),
        layers: [
          {
            name: `session:${profile}`,
            source: 'session',
            profile: profile === 'read-only' ? readOnlyProfile(ctx) : workspaceDevProfile(ctx),
          },
        ],
      });

      const parsed = parseHookTable(parseToml(config), 'test');
      assert.deepEqual(parsed.warnings, [], 'the fixture config should parse cleanly');

      return new HookRunner(parsed.hooks, {
        backend,
        policy,
        workspaceRoot: root,
        logger: nullLogger,
        now: () => Date.now(),
      });
    },
    async cleanup() {
      await backend.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

describe('HookRunner', () => {
  test('runs a permitted hook and captures its output', async () => {
    const h = await harness();
    try {
      const runner = h.runner(`
[[hooks]]
event = "PostToolUse"
matcher = "Edit"
command = ["echo", "linted {path}"]
inject_output = true
`);

      const outcomes = await runner.run({
        event: 'PostToolUse',
        toolName: 'Edit',
        path: 'src/a.ts',
        sessionId: 's1',
      });

      assert.equal(outcomes.length, 1, 'the hook matched and was attempted');
      const outcome = outcomes[0]!;
      assert.equal(outcome.ran, true, `hook did not run: ${outcome.blocked ?? 'unknown reason'}`);
      assert.equal(outcome.exitCode, 0);
      assert.match(outcome.output ?? '', /linted src\/a\.ts/, '{path} was substituted');

      const rendered = renderHookOutput(outcomes);
      assert.match(rendered ?? '', /linted src\/a\.ts/);
    } finally {
      await h.cleanup();
    }
  });

  test('the matcher selects which tools a hook fires for', async () => {
    const h = await harness();
    try {
      const runner = h.runner(`
[[hooks]]
event = "PostToolUse"
matcher = "Edit"
command = ["echo", "fired"]
`);

      assert.equal(runner.forEvent({ event: 'PostToolUse', toolName: 'Edit', sessionId: 's' }).length, 1);
      assert.equal(runner.forEvent({ event: 'PostToolUse', toolName: 'Read', sessionId: 's' }).length, 0);
      assert.equal(runner.forEvent({ event: 'TurnEnd', sessionId: 's' }).length, 0);
    } finally {
      await h.cleanup();
    }
  });

  test('a hook the profile does not permit is reported, not run', async () => {
    const h = await harness();
    try {
      // read-only asks before running a development command, and a hook must
      // never raise an approval prompt the user did not initiate.
      const runner = h.runner(
        `
[[hooks]]
event = "PostToolUse"
command = ["node", "-e", "console.log(1)"]
`,
        'read-only',
      );

      const outcomes = await runner.run({ event: 'PostToolUse', toolName: 'Edit', sessionId: 's' });

      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.ran, false);
      assert.match(outcomes[0]!.blocked ?? '', /requires approval|not permitted/);
    } finally {
      await h.cleanup();
    }
  });

  test('a hook cannot reach a hard-denied capability', async () => {
    const h = await harness();
    try {
      const runner = h.runner(`
[[hooks]]
event = "SessionStart"
command = ["sudo", "whoami"]
`);

      const outcomes = await runner.run({ event: 'SessionStart', sessionId: 's' });
      assert.equal(outcomes[0]!.ran, false);
      assert.match(outcomes[0]!.blocked ?? '', /privilege escalation|permanently denied/i);
    } finally {
      await h.cleanup();
    }
  });

  test('hook output is redacted and the environment is scrubbed', async () => {
    const h = await harness();
    try {
      const runner = h.runner(`
[[hooks]]
event = "SessionStart"
command = ["sh", "-c", "echo \\"token=$GITHUB_TOKEN\\"; env | grep -c GITHUB_TOKEN || true"]
inject_output = true
`);

      const outcomes = await runner.run({ event: 'SessionStart', sessionId: 's' });
      const output = outcomes[0]?.output ?? '';

      assert.equal(outcomes[0]?.ran, true, `hook did not run: ${outcomes[0]?.blocked ?? ''}`);
      // The variable is not in the child's environment at all, so it expands
      // to nothing rather than to a redacted placeholder.
      assert.match(output, /token=\s*$/m);
      assert.equal(/gh[pous]_/.test(output), false);
    } finally {
      await h.cleanup();
    }
  });

  test('a failing hook does not throw — it is reported', async () => {
    const h = await harness();
    try {
      const runner = h.runner(`
[[hooks]]
event = "TurnEnd"
command = ["sh", "-c", "exit 3"]
`);

      const outcomes = await runner.run({ event: 'TurnEnd', sessionId: 's' });
      assert.equal(outcomes[0]!.ran, true);
      assert.equal(outcomes[0]!.exitCode, 3);
    } finally {
      await h.cleanup();
    }
  });

  test('an executable that does not exist is reported, not fatal', async () => {
    const h = await harness();
    try {
      const runner = h.runner(`
[[hooks]]
event = "TurnEnd"
command = ["definitely-not-a-real-binary-xyz"]
`);

      const outcomes = await runner.run({ event: 'TurnEnd', sessionId: 's' });
      assert.equal(outcomes[0]!.ran, false);
      assert.ok(outcomes[0]!.blocked);
    } finally {
      await h.cleanup();
    }
  });
});

describe('PolicyEngine.combine', () => {
  // The regression that motivated this file: `combine` referenced a helper it
  // no longer imported, so every call threw ReferenceError at runtime.
  test('reduces a decision set to the strictest action', () => {
    const decide = (action: 'allow' | 'ask' | 'deny' | 'hard_deny') => ({
      action,
      access: { kind: 'vcs.mutate' as const, operation: 'commit' as const, display: 'git commit' },
      subjectKey: 'x',
      reason: '',
      final: action === 'hard_deny',
      errorCode: 'TOOL_DENIED' as const,
    });

    assert.equal(PolicyEngine.combine([]), 'allow');
    assert.equal(PolicyEngine.combine([decide('allow'), decide('allow')]), 'allow');
    assert.equal(PolicyEngine.combine([decide('allow'), decide('ask')]), 'ask');
    assert.equal(PolicyEngine.combine([decide('ask'), decide('deny')]), 'deny');
    assert.equal(PolicyEngine.combine([decide('deny'), decide('hard_deny')]), 'hard_deny');
    assert.equal(PolicyEngine.combine([decide('hard_deny'), decide('allow')]), 'hard_deny');
  });
});
