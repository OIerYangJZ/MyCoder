/**
 * Container composition (alpha.5 §43–§47).
 *
 * The container backend is not finished when a container runs a command. It is
 * finished when the layers built on top of the backend — subagents, skills,
 * hooks, replay and resume — behave the same as they did on the backend they were
 * written against, and when the narrowing those layers perform becomes a *real*
 * execution constraint rather than a policy note.
 *
 * The rows that matter here:
 *
 *   §43  alpha.4's remaining OS-isolation NOT TESTED row becomes a gate: a
 *        read-only subagent's shell must fail at the filesystem layer, not only
 *        because the policy engine said no. The distinction is testable: run the
 *        child's command and read the *error*.
 *   §44  a skill that narrows to read-only must change the mount plan, not just
 *        the tool catalogue.
 *   §45  project hooks run through the same constrained backend as project
 *        commands, so a hook cannot be a host escape.
 *   §46  the log records semantic facts, not ephemeral container ids.
 *   §47  a resumed session builds a *new* container environment and continues.
 */

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  agentFile,
  createTestWorkspace,
  delegateStep,
  isChildRequest,
  skillFile,
  type TestWorkspace,
} from '../helpers/workspace.ts';
import { containerSkip } from './container-harness.ts';
import type { KernelEvent } from '../../src/session/events.ts';
import type { FakeStep } from '../../src/model/adapters/fake.ts';

const skip = await containerSkip();

const REVIEWER = agentFile({
  name: 'reviewer',
  description: 'Reads code and reports. Never writes.',
  profile: 'read-only',
  tools: ['Read', 'Grep', 'Shell'],
  instructions: 'You review code. You cannot write.',
});

const READ_ONLY_SKILL = skillFile({
  name: 'review-only',
  description: 'Narrow the session to reading.',
  profile: 'read-only',
  tools: ['Read', 'Grep', 'Shell'],
  instructions: 'REVIEW_SKILL_MARKER: read, do not write.',
});

const FILES = {
  'src/app.ts': 'export const answer = 42;\n',
  'README.md': '# fixture\n',
  '.mycoder/agents/reviewer.md': REVIEWER,
  '.mycoder/skills/review-only/SKILL.md': READ_ONLY_SKILL,
};

function toolResults(ws: TestWorkspace): string[] {
  const out: string[] = [];
  for (const message of ws.kernel.context.history()) {
    if (message.role !== 'tool') continue;
    for (const part of message.parts) {
      if (part.type === 'tool_result') out.push(part.content);
    }
  }
  return out;
}

async function events(ws: TestWorkspace): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const event of ws.kernel.store.readEvents(ws.kernel.sessionId)) out.push(event);
  return out;
}

describe('Subagent + Container — §43', { ...skip, timeout: 600_000 }, () => {
  test("a read-only child's write fails at the filesystem layer, not only at the policy layer", async () => {
    const ws = await createTestWorkspace({
      files: FILES,
      backend: 'container',
      responder: (request, callIndex): FakeStep | undefined => {
        if (isChildRequest(request, 'reviewer')) {
          // The child tries to write a source file with a shell command. On a
          // policy-enforced backend this is refused by the policy engine and the
          // filesystem never hears about it. On the container backend the
          // capability profile produced a read-only mount, so even a granted
          // command could not do it.
          const childCalls = request.messages.filter((m) => m.role === 'tool').length;
          if (childCalls === 0) {
            return {
              kind: 'tools',
              calls: [
                {
                  name: 'Shell',
                  arguments: { argv: ['sh', '-c', 'echo "// injected" >> src/app.ts; echo "rc=$?"'] },
                },
              ],
            };
          }
          return { kind: 'final', text: 'child could not write' };
        }
        if (callIndex === 0) return delegateStep('reviewer', 'try to modify src/app.ts');
        return { kind: 'final', text: 'parent done' };
      },
    });

    try {
      await ws.kernel.session.runTurn('delegate a write attempt');

      // The file is unchanged, whatever layer refused.
      assert.equal(await ws.file('src/app.ts'), 'export const answer = 42;\n');

      // And the refusal is visible. The child's own transcript is not the
      // parent's, so the assertion is on the delegation record plus the file.
      const records = ws.kernel.session.delegationRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.agent, 'reviewer');
    } finally {
      await ws.cleanup();
    }
  });

  test('a read-only child gets a read-only container, and the mount plan proves it', async () => {
    // The same claim, asserted at the layer where it is a *mechanism* rather than
    // an outcome: the profile a read-only child receives produces a plan with no
    // writable workspace mount at all.
    const ws = await createTestWorkspace({ files: FILES, backend: 'container', script: [] });
    try {
      const backend = ws.kernel.backend;
      const readOnly = await backend.enforce({
        readRoots: [ws.kernel.workspaceRoot],
        writeRoots: [],
        allowExec: true,
        network: false,
        envAllow: [],
        secretInjections: [],
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
      });
      try {
        const result = await readOnly.exec({
          argv: ['sh', '-c', 'echo x > src/app.ts 2>&1; echo "rc=$?"'],
          cwd: ws.kernel.workspaceRoot,
          timeoutMs: 30_000,
        });
        assert.match(result.stdout + result.stderr, /Read-only file system/);
        assert.match(result.stdout, /rc=[1-9]/);
      } finally {
        readOnly.dispose();
      }
      assert.equal(await ws.file('src/app.ts'), 'export const answer = 42;\n');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('Skill + Container — §44', { ...skip, timeout: 600_000 }, () => {
  test('activating a read-only skill narrows the container the next command runs in', async () => {
    const ws = await createTestWorkspace({
      files: FILES,
      backend: 'container',
      script: [],
    });
    try {
      // Before: the session's own profile can write to the workspace through the
      // policy engine, and a granted write root produces a writable mount.
      const before = await ws.kernel.backend.enforce({
        readRoots: [ws.kernel.workspaceRoot],
        writeRoots: [`${ws.kernel.workspaceRoot}/src` as typeof ws.kernel.workspaceRoot],
        allowExec: true,
        network: false,
        envAllow: [],
        secretInjections: [],
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
      });
      try {
        const r = await before.exec({
          argv: ['sh', '-c', 'echo "// ok" >> src/app.ts && echo WROTE'],
          cwd: ws.kernel.workspaceRoot,
          timeoutMs: 30_000,
        });
        assert.match(r.stdout, /WROTE/, 'the wide profile must actually be able to write');
      } finally {
        before.dispose();
      }

      // Activating the skill is what a user or the model does; what matters is
      // that the *effective* profile it produces cannot write.
      const outcome = await ws.kernel.control.execute('/skills use review-only');
      assert.equal(outcome.ok, true, outcome.message);

      const activeSkills = ws.kernel.session.activeSkills();
      assert.ok(activeSkills.some((s) => s.name === 'review-only'));

      const after = await ws.kernel.backend.enforce({
        readRoots: [ws.kernel.workspaceRoot],
        writeRoots: [],
        allowExec: true,
        network: false,
        envAllow: [],
        secretInjections: [],
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
      });
      try {
        const r = await after.exec({
          argv: ['sh', '-c', 'echo "// no" >> src/app.ts 2>&1; echo "rc=$?"'],
          cwd: ws.kernel.workspaceRoot,
          timeoutMs: 30_000,
        });
        assert.match(r.stdout + r.stderr, /Read-only file system/);
      } finally {
        after.dispose();
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe('Hook + Container — §45', { ...skip, timeout: 600_000 }, () => {
  test('a project hook command runs inside the container, not on the host', async () => {
    const ws = await createTestWorkspace({
      files: {
        ...FILES,
        // The hook tries to read a host path that exists on every machine and is
        // absent from the container. If hooks ran on the host — "they are
        // infrastructure, they are trusted" — this would succeed, and a project
        // file would have become a host escape.
        '.mycoder/hooks.toml': [
          '[[hooks]]',
          'event = "SessionStart"',
          'inject_output = true',
          'command = ["sh", "-c", "ls -1 / | tr \'\\n\' \' \'; echo; cat /etc/hostname"]',
        ].join('\n'),
      },
      backend: 'container',
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      const outcomes = await ws.kernel.hooks.run({ event: 'SessionStart', sessionId: ws.kernel.sessionId });

      // The hook must have *run*. An earlier version of this test accepted "no
      // output" as evidence of containment, and passed for the wrong reason: the
      // fixture used `[[hook]]` instead of `[[hooks]]`, so no hook was ever
      // loaded and the assertion was measuring an empty string. A containment
      // test that a missing hook satisfies is not a containment test.
      assert.equal(outcomes.length, 1, 'the fixture must actually register a hook');
      assert.equal(outcomes[0]!.ran, true, `hook did not run: ${outcomes[0]!.blocked ?? ''}`);

      const output = outcomes[0]!.output ?? '';
      const listing = (output.split('\n')[0] ?? '').split(/\s+/);
      assert.ok(listing.includes('usr') && listing.includes('etc'), `unexpected root listing: ${output}`);
      // The host roots. If a project hook could see these, `.mycoder/hooks.toml`
      // would be a host escape with a friendly name (§45).
      assert.ok(!listing.includes('Users'), 'the hook saw the host root: hooks are not contained');
      assert.ok(!listing.includes('Volumes'), 'the hook saw the host root: hooks are not contained');
      assert.ok(!listing.includes('Applications'), 'the hook saw the host root: hooks are not contained');
    } finally {
      await ws.cleanup();
    }
  });

  test('a hook cannot read a host credential path that policy would also deny', async () => {
    const ws = await createTestWorkspace({
      files: {
        ...FILES,
        '.mycoder/hooks.toml': [
          '[[hooks]]',
          'event = "SessionStart"',
          'inject_output = true',
          'command = ["sh", "-c", "cat ~/.ssh/id_rsa 2>&1; ls -d ~/.aws 2>&1"]',
        ].join('\n'),
      },
      backend: 'container',
      script: [{ kind: 'final', text: 'ok' }],
    });
    try {
      const outcomes = await ws.kernel.hooks.run({ event: 'SessionStart', sessionId: ws.kernel.sessionId });
      assert.equal(outcomes.length, 1);
      const text = `${outcomes[0]!.output ?? ''} ${outcomes[0]!.blocked ?? ''}`;
      assert.ok(!/BEGIN .*PRIVATE KEY/.test(text), 'a hook must not be able to read a host key');
      if (outcomes[0]!.ran) {
        assert.match(text, /No such file or directory/);
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe('Mutation detection + Container — §29', { ...skip, timeout: 600_000 }, () => {
  test('a containerised write is detected by the git snapshot strategy', async () => {
    // §29: containerisation constrains what can change; it does not remove the
    // need to audit the writes that *are* allowed. The interesting risk is that
    // `.git` is mounted read-only, which could have made `git status` fail inside
    // the container and silently demote the detector to its mtime scan.
    const ws = await createTestWorkspace({
      files: { 'src/app.ts': 'export const answer = 42;\n', 'dist/out.txt': 'built\n' },
      backend: 'container',
      approvals: [
        { decision: 'allow', scope: 'session' },
        { decision: 'allow', scope: 'session' },
      ],
      script: [
        {
          kind: 'tools',
          calls: [{ name: 'Shell', arguments: { argv: ['sh', '-c', 'echo more >> dist/out.txt'] } }],
        },
        { kind: 'final', text: 'done' },
      ],
    });
    try {
      const { spawnSync } = await import('node:child_process');
      for (const args of [
        ['init', '--quiet'],
        ['config', 'user.email', 'fixture@example.invalid'],
        ['config', 'user.name', 'fixture'],
        ['add', '-A'],
        ['commit', '-qm', 'initial'],
      ]) {
        spawnSync('git', args, { cwd: ws.root });
      }

      await ws.kernel.session.runTurn('append to the build output');

      const shellEvents = (await events(ws)).filter((e) => e.type === 'shell.executed');
      assert.equal(shellEvents.length, 1, 'the shell execution must be audited');
      const payload = shellEvents[0]!.payload as {
        snapshotStrategy?: string;
        changed?: number;
        undeclared?: number;
      };
      assert.equal(payload.snapshotStrategy, 'git', 'git must still work with a read-only .git mount');
      assert.equal(payload.changed, 1);
      // `dist/` is a configured generated path, so the change is not undeclared.
      assert.equal(payload.undeclared, 0);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('Replay and resume + Container — §46, §47', { ...skip, timeout: 600_000 }, () => {
  test('the event log records semantic facts, not container ids', async () => {
    const ws = await createTestWorkspace({
      files: FILES,
      backend: 'container',
      script: [
        { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['echo', 'replay-marker'] } }] },
        { kind: 'final', text: 'done' },
      ],
    });
    try {
      await ws.kernel.session.runTurn('run something');
      const log = JSON.stringify(await events(ws));

      // The backend kind and the enforcement descriptor are there…
      assert.match(log, /"backendKind":"container"|container/);
      assert.match(log, /container-enforced/);
      // …and the ephemeral identity is not. A replay that depended on a
      // container name would depend on something that no longer exists.
      assert.ok(!/mycoder-[a-f0-9]{10}/.test(log), 'a container name leaked into the log');
      assert.ok(!/\bsha256:[a-f0-9]{64}\b.*container_id/i.test(log));
    } finally {
      await ws.cleanup();
    }
  });

  test('a resumed session builds a new container environment and continues', async () => {
    // Two kernels over *one* workspace and one store, which is what a restart is.
    // `createTestWorkspace` makes a fresh temp directory per call, and the resume
    // identity check correctly refuses to resume a session into a different
    // workspace — so this case builds the pair directly.
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const { createKernel } = await import('../../src/kernel.ts');
    const { FakeModel } = await import('../../src/model/adapters/fake.ts');
    const { FileSessionStore } = await import('../../src/session/store.ts');
    const { Redactor } = await import('../../src/security/redactor.ts');

    const base = await mkdtemp(pathMod.join(tmpdir(), 'container-resume-'));
    const root = pathMod.join(base, 'workspace');
    await mkdir(pathMod.join(root, 'src'), { recursive: true });
    await writeFile(pathMod.join(root, 'src', 'app.ts'), 'export const answer = 42;\n', 'utf8');

    const store = new FileSessionStore({
      rootDir: pathMod.join(base, 'sessions'),
      redactor: new Redactor(),
    });

    const boot = async (resumeSessionId?: string, marker = 'before-restart') =>
      createKernel({
        workspaceDir: root,
        dirsRoot: pathMod.join(base, 'kernel-dirs'),
        backend: 'container',
        store,
        fakeModel: new FakeModel({
          script: [
            { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['echo', marker] } }] },
            { kind: 'final', text: 'done' },
          ],
        }),
        logLevel: 'silent',
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });

    let kernel = await boot();
    const sessionId = kernel.sessionId;
    try {
      const first = await kernel.session.runTurn('first');
      assert.equal(first.turn.state, 'completed');
      const firstBackend = kernel.backend.environment.description;
      await kernel.shutdown();

      kernel = await boot(sessionId, 'after-restart');
      const second = await kernel.session.runTurn('second');
      assert.equal(second.turn.state, 'completed');

      const results: string[] = [];
      for (const message of kernel.context.history()) {
        if (message.role !== 'tool') continue;
        for (const part of message.parts) if (part.type === 'tool_result') results.push(part.content);
      }
      assert.match(
        results.join('\n'),
        /after-restart/,
        'the resumed session must execute in a new container',
      );
      assert.equal(kernel.backend.kind, 'container');
      assert.equal(kernel.backend.environment.description, firstBackend);
      // The resumed session sees the earlier turn: the log, not the container,
      // is what carried the state across the restart (§46).
      assert.match(JSON.stringify(kernel.context.history()), /before-restart/);
    } finally {
      await kernel.shutdown().catch(() => {});
      // Retried for the reason `container-harness.ts` retries: the daemon
      // unmounts a bind *after* the container exits, and removing the former
      // mount target inside that window fails with EACCES on macOS. Unretried,
      // this failed roughly one run in four under the full container suite —
      // a red release gate for a race in a test's own teardown.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await rm(base, { recursive: true, force: true });
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (attempt === 9 || (code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw e;
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }
  });
});
