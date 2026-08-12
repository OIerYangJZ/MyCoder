/**
 * Hook lifecycle wiring (spec §18.1, plan P5).
 *
 * `hooks.test.ts` covers `HookRunner` in isolation. This covers the thing that
 * was missing until now: the turn loop actually *reaching* the lifecycle points.
 *
 * The properties that matter are not "a hook ran" but:
 *   - it ran at the right point, with the right substitutions;
 *   - it ran on failure and cancellation too, not only on the happy path;
 *   - a broken hook cannot take the turn down;
 *   - its output arrives as an `injection`, not as the user speaking;
 *   - it is audited, including when policy refused it;
 *   - it still cannot escalate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createKernel, type Kernel } from '../../src/kernel.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import { ScriptedPrompter } from '../../src/cli/prompter.ts';
import { CANARY } from '../helpers/workspace.ts';

interface HookWorkspace {
  kernel: Kernel;
  root: string;
  events(): Promise<string[]>;
  hookEvents(): Promise<Array<{ event: string; ran: boolean; blocked?: string; exitCode?: number | null }>>;
  injections(): string[];
  cleanup(): Promise<void>;
}

async function withHooks(opts: {
  hooksToml: string;
  files?: Record<string, string>;
  script?: FakeStep[];
  profile?: string;
}): Promise<HookWorkspace> {
  const base = await mkdtemp(path.join(tmpdir(), 'hook-lifecycle-'));
  const root = path.join(base, 'workspace');
  await mkdir(path.join(root, '.agent'), { recursive: true });

  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await writeFile(path.join(root, '.agent', 'hooks.toml'), opts.hooksToml, 'utf8');

  const kernel = await createKernel({
    workspaceDir: root,
    dirsRoot: path.join(base, 'kernel-dirs'),
    ...(opts.profile ? { profileOverride: opts.profile } : {}),
    fakeModel: new FakeModel({ script: opts.script ?? [{ kind: 'final', text: 'done' }] }),
    prompter: new ScriptedPrompter([]),
    logLevel: 'silent',
  });

  return {
    kernel,
    root,
    async events() {
      const out: string[] = [];
      for await (const e of kernel.store.readEvents(kernel.sessionId)) out.push(JSON.stringify(e));
      return out;
    },
    async hookEvents() {
      const out: Array<{ event: string; ran: boolean; blocked?: string; exitCode?: number | null }> = [];
      for await (const e of kernel.store.readEvents(kernel.sessionId)) {
        if (e.type !== 'hook.executed') continue;
        out.push(e.payload as (typeof out)[number]);
      }
      return out;
    },
    injections() {
      return kernel.context
        .history()
        .filter((m) => m.origin.kind === 'injection')
        .map((m) => m.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''));
    },
    async cleanup() {
      await kernel.shutdown();
      await rm(base, { recursive: true, force: true });
    },
  };
}

describe('lifecycle points are reached', () => {
  test('SessionStart, UserPromptSubmit, BeforeStep and TurnEnd all fire', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "SessionStart"
command = ["echo", "session-start"]

[[hooks]]
event = "UserPromptSubmit"
command = ["echo", "prompt-submit"]

[[hooks]]
event = "BeforeStep"
command = ["echo", "before-step"]

[[hooks]]
event = "TurnEnd"
command = ["echo", "turn-end"]
`,
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await ws.kernel.session.runTurn('hello');

      const fired = (await ws.hookEvents()).filter((h) => h.ran).map((h) => h.event);
      assert.ok(fired.includes('SessionStart'), 'SessionStart did not fire');
      assert.ok(fired.includes('UserPromptSubmit'), 'UserPromptSubmit did not fire');
      assert.ok(fired.includes('BeforeStep'), 'BeforeStep did not fire');
      assert.ok(fired.includes('TurnEnd'), 'TurnEnd did not fire');
    } finally {
      await ws.cleanup();
    }
  });

  test('PreToolUse and PostToolUse bracket a tool call, with {path} substituted', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "PreToolUse"
matcher = "Read"
command = ["echo", "pre {path}"]
inject_output = true

[[hooks]]
event = "PostToolUse"
matcher = "Read"
command = ["echo", "post {path}"]
inject_output = true
`,
      files: { 'src/a.ts': 'export const a = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] },
        { kind: 'final', text: 'read it' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read the file');

      const injected = ws.injections().join('\n');
      assert.match(injected, /pre src\/a\.ts/, 'PreToolUse did not fire with the path');
      assert.match(injected, /post src\/a\.ts/, 'PostToolUse did not fire with the path');
    } finally {
      await ws.cleanup();
    }
  });

  test('the matcher restricts which tools a hook fires for', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "PostToolUse"
matcher = "Edit"
command = ["echo", "edit-only"]
inject_output = true
`,
      files: { 'src/a.ts': 'x\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] },
        { kind: 'final', text: 'done' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read');
      assert.equal(
        ws.injections().join('\n').includes('edit-only'),
        false,
        'the hook should not have matched Read',
      );
    } finally {
      await ws.cleanup();
    }
  });

  test('TurnEnd fires even when the turn fails', async () => {
    const bad: FakeStep = { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'nope.ts' } }] };
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "TurnEnd"
command = ["echo", "cleanup-ran"]
`,
      script: [bad, bad, bad, bad, bad, { kind: 'final', text: 'unreachable' }],
    });
    try {
      const outcome = await ws.kernel.session.runTurn('fail repeatedly');
      assert.equal(outcome.turn.state, 'failed');

      const fired = (await ws.hookEvents()).filter((h) => h.ran && h.event === 'TurnEnd');
      assert.ok(fired.length > 0, 'TurnEnd must fire on a failed turn — that is when cleanup matters most');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('a hook cannot damage the session', () => {
  test('a failing hook does not fail the turn', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "BeforeStep"
command = ["sh", "-c", "exit 7"]
`,
      script: [{ kind: 'final', text: 'still fine' }],
    });
    try {
      const outcome = await ws.kernel.session.runTurn('go');
      assert.equal(outcome.turn.state, 'completed');
      assert.equal(outcome.finalText, 'still fine');

      // The failure is still recorded, with its real exit code — swallowing the
      // turn-level impact must not mean swallowing the evidence.
      const beforeStep = (await ws.hookEvents()).filter((h) => h.event === 'BeforeStep');
      assert.ok(beforeStep.length > 0, 'the hook run should be audited');
      assert.equal(beforeStep[0]!.ran, true);
      assert.equal(beforeStep[0]!.exitCode, 7);
    } finally {
      await ws.cleanup();
    }
  });

  test('a hook whose executable does not exist does not fail the turn', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "TurnEnd"
command = ["definitely-not-a-real-binary-xyz"]
`,
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      const outcome = await ws.kernel.session.runTurn('go');
      assert.equal(outcome.turn.state, 'completed');
    } finally {
      await ws.cleanup();
    }
  });

  test('a malformed hooks.toml is a warning, not a crash', async () => {
    const ws = await withHooks({
      hooksToml: '[[hooks]\nevent = "TurnEnd"\n',
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      const outcome = await ws.kernel.session.runTurn('go');
      assert.equal(outcome.turn.state, 'completed');
      assert.ok(
        ws.kernel.config.warnings.some((w) => /hooks\.toml could not be parsed/.test(w)),
        'the parse failure must be visible',
      );
    } finally {
      await ws.cleanup();
    }
  });
});

describe('hooks stay inside the security boundary', () => {
  test('a hook that prints a secret has its output redacted before injection', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "TurnEnd"
command = ["sh", "-c", "cat .env 2>/dev/null || true"]
inject_output = true
`,
      files: { '.env': `TEST_CANARY_SECRET=${CANARY}\n` },
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      ws.kernel.secrets.register('test/canary', { kind: 'literal', value: CANARY });
      await ws.kernel.session.runTurn('go');

      const injected = ws.injections().join('\n');
      assert.equal(injected.includes(CANARY), false, 'hook output must pass through the redactor');

      const log = (await ws.events()).join('\n');
      assert.equal(log.includes(CANARY), false, 'the hook audit event must not carry the value');
    } finally {
      await ws.cleanup();
    }
  });

  test('hook output is injected with provenance, not as the user', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "TurnEnd"
command = ["echo", "lint clean"]
inject_output = true
`,
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await ws.kernel.session.runTurn('go');

      const injections = ws.kernel.context.history().filter((m) => m.origin.kind === 'injection');
      assert.equal(injections.length, 1);
      const origin = injections[0]!.origin;
      assert.equal(origin.kind, 'injection');
      if (origin.kind === 'injection') {
        assert.equal(
          origin.source,
          'hook:TurnEnd',
          'the model must be able to tell where this text came from',
        );
      }
    } finally {
      await ws.cleanup();
    }
  });

  test('a hook denied by policy is recorded and does not run', async () => {
    const ws = await withHooks({
      // read-only asks before running a development command, and a hook must
      // never raise a prompt the user did not initiate — so it is skipped.
      hooksToml: `
[[hooks]]
event = "TurnEnd"
command = ["node", "-e", "console.log(1)"]
`,
      profile: 'read-only',
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await ws.kernel.session.runTurn('go');

      const turnEnd = (await ws.hookEvents()).filter((h) => h.event === 'TurnEnd');
      assert.ok(turnEnd.length > 0, 'the attempt must be audited even though it was refused');
      assert.equal(turnEnd[0]!.ran, false);
      assert.match(turnEnd[0]!.blocked ?? '', /requires approval|not permitted/);
    } finally {
      await ws.cleanup();
    }
  });

  test('a hook cannot reach a hard-denied capability', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "TurnEnd"
command = ["sudo", "whoami"]
`,
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await ws.kernel.session.runTurn('go');

      const turnEnd = (await ws.hookEvents()).filter((h) => h.event === 'TurnEnd');
      assert.equal(turnEnd[0]?.ran, false);
      assert.match(turnEnd[0]?.blocked ?? '', /privilege escalation|permanently denied/i);
    } finally {
      await ws.cleanup();
    }
  });

  test('a hook runs with a scrubbed environment', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "TurnEnd"
command = ["sh", "-c", "echo \\"tok=[$GITHUB_TOKEN]\\""]
inject_output = true
`,
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await ws.kernel.session.runTurn('go');
      assert.match(
        ws.injections().join('\n'),
        /tok=\[\]/,
        'the variable must not exist in the hook environment',
      );
    } finally {
      await ws.cleanup();
    }
  });
});

describe('hook execution is replayable', () => {
  test('every hook run appears in the event log', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "TurnEnd"
command = ["echo", "audited"]
`,
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      await ws.kernel.session.runTurn('go');

      const log = (await ws.events()).join('\n');
      assert.match(log, /"type":"hook\.executed"/);
      assert.match(log, /"event":"TurnEnd"/);
      assert.match(log, /"ran":true/);
    } finally {
      await ws.cleanup();
    }
  });

  test('hook injections do not break tool-call closure', async () => {
    const ws = await withHooks({
      hooksToml: `
[[hooks]]
event = "PostToolUse"
command = ["echo", "post-tool"]
inject_output = true
`,
      files: { 'src/a.ts': 'x\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] },
        { kind: 'final', text: 'ok' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('read');
      assert.deepEqual(ws.kernel.context.openToolCalls(), []);
    } finally {
      await ws.cleanup();
    }
  });
});
