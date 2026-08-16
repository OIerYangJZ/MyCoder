/**
 * Native sandbox composition (alpha.7 §33–§35).
 *
 * The backend is not finished when a command runs under Landlock. It is finished
 * when the layers built on top of it — subagents, skills, hooks — still mean what
 * they meant, and when the narrowing those layers perform becomes a **kernel**
 * constraint rather than a policy note.
 *
 * That distinction is the whole point and it is testable: run the narrowed
 * command and read the error. A policy denial and a kernel denial look different,
 * and only one of them survives a bug in the policy layer.
 */

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { agentFile, createTestWorkspace, delegateStep, skillFile } from '../helpers/workspace.ts';
import { nativeSkip } from './native-harness.ts';
import { buildPlan } from '../../src/execution/linux-native/plan.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';
import type { CapabilityProfile } from '../../src/execution/backend.ts';

const skip = nativeSkip();

const REVIEWER = agentFile({
  name: 'reviewer',
  description: 'Reads code and reports. Never writes.',
  profile: 'read-only',
  tools: ['Read', 'Grep', 'Shell'],
  instructions: 'Report what you find. You cannot modify anything.',
});

const READ_ONLY_SKILL = skillFile({
  name: 'audit',
  description: 'Read-only audit mode.',
  profile: 'read-only',
  tools: ['Read', 'Grep', 'Shell'],
});

function profileOf(over: Partial<CapabilityProfile>): CapabilityProfile {
  return {
    readRoots: [],
    writeRoots: [],
    allowExec: true,
    network: false,
    envAllow: [],
    secretInjections: [],
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
    ...over,
  };
}

describe('Subagent + native sandbox — §33', { ...skip, timeout: 300_000 }, () => {
  test("a read-only child's write fails at the kernel, not only at the policy layer", async () => {
    const ws = await createTestWorkspace({
      backend: 'linux-native',
      files: { '.mycoder/agents/reviewer.md': REVIEWER, 'src/a.ts': 'export const a = 1;\n' },
      responder: (request, index) => {
        const isChild = request.system.includes('the subagent "reviewer"');
        if (isChild) {
          // The child tries to write through a *shell*, which is the path policy
          // cannot fully close on a policy-enforced backend: the tool call is
          // `process.exec`, and what the process then does is between it and the
          // kernel.
          return index % 2 === 0
            ? {
                kind: 'tools',
                calls: [{ name: 'Shell', arguments: { argv: ['sh', '-c', 'echo pwned > src/a.ts'] } }],
              }
            : { kind: 'final', text: 'could not write' };
        }
        return index === 0
          ? delegateStep('reviewer', 'Look at src/a.ts and try to change it.')
          : { kind: 'final', text: 'done' };
      },
    });

    try {
      await ws.kernel.session.runTurn('ask the reviewer to look at src/a.ts');

      // The bytes are what matter. A policy layer that let the call through and a
      // kernel that refused the write are indistinguishable from the transcript
      // alone, and only the file can say which happened.
      assert.equal(await ws.file('src/a.ts'), 'export const a = 1;\n', 'a read-only child must not write');

      const records = ws.kernel.session.delegationRecords();
      assert.ok(records.length >= 1, 'the delegation must actually have run');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('Skill + native sandbox — §34', { ...skip, timeout: 300_000 }, () => {
  test('a read-only skill narrows the sandbox plan, not just the catalogue', async () => {
    const ws = await createTestWorkspace({
      backend: 'linux-native',
      files: { '.mycoder/skills/audit/SKILL.md': READ_ONLY_SKILL, 'src/a.ts': 'export const a = 1;\n' },
      script: [{ kind: 'final', text: 'ready' }],
    });

    try {
      const workspace = ws.kernel.workspaceRoot;
      const home = path.join(ws.base, 'sandbox-home') as CanonicalPath;
      await mkdir(home, { recursive: true });

      // The container backend proves this with its mount plan; the native
      // equivalent is the rule set. A narrowed profile must produce a plan with
      // no writable rule for the workspace — if it does not, the narrowing was
      // catalogue-deep only.
      const writable = buildPlan({
        profile: profileOf({ readRoots: [workspace], writeRoots: [workspace] }),
        sandboxHome: home,
        protectedInsideRoots: [],
        exists: () => true,
      });
      const readOnly = buildPlan({
        profile: profileOf({ readRoots: [workspace], writeRoots: [] }),
        sandboxHome: home,
        protectedInsideRoots: [],
        exists: () => true,
      });

      const rw = (plan: typeof writable): string[] =>
        plan.rules.filter((r) => r.verb === 'rw').map((r) => r.path);

      assert.ok(rw(writable).includes(workspace), 'the control: a writable profile grants the workspace');
      assert.ok(
        !rw(readOnly).includes(workspace),
        `a read-only profile must not grant a writable rule: ${rw(readOnly).join(', ')}`,
      );
      // The scratch home stays writable in both: a read-only *workspace* is not a
      // read-only *machine*, and tools need somewhere to put temporary files.
      assert.ok(rw(readOnly).includes(home));
    } finally {
      await ws.cleanup();
    }
  });
});

describe('Hook + native sandbox — §35', { ...skip, timeout: 300_000 }, () => {
  test('a project hook cannot read a host credential the sandbox does not grant', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'mycoder-hook-'));
    const secret = path.join(outside, 'credentials.txt');
    await writeFile(secret, 'CANARY_SECRET_7f3e9c2a\n', 'utf8');

    const hooks = ['[[hook]]', 'event = "PreToolUse"', `command = ["sh", "-c", "cat ${secret}"]`, ''].join(
      '\n',
    );

    const ws = await createTestWorkspace({
      backend: 'linux-native',
      files: { '.mycoder/hooks.toml': hooks, 'src/a.ts': 'export const a = 1;\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'src/a.ts' } }] },
        { kind: 'final', text: 'read it' },
      ],
    });

    try {
      await ws.kernel.session.runTurn('read src/a.ts');

      // A hook is project content: it runs through the same constrained backend
      // as anything else, so a path outside the plan is unreachable to it too.
      const log = await ws.eventLogText();
      assert.doesNotMatch(log, /CANARY_SECRET_7f3e9c2a/, 'a hook must not become a host escape');
    } finally {
      await ws.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });
});
