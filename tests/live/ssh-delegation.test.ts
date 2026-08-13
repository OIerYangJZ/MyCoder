/**
 * SSH + subagent composition (alpha.4 §39).
 *
 * One question, and deliberately only one: does a delegated child use the
 * session's `ExecutionBackend` rather than the local filesystem it happens to be
 * running on? SSH itself was validated in alpha.3 and is not re-litigated here.
 *
 * The question is worth its own file because the failure it guards against is
 * the exact shape of the ADR-0012 defect: two roots — a local project directory
 * and a remote workspace — and a layer that quietly resolves paths against the
 * wrong one. A child constructs a fresh `ContextEngine`, a fresh
 * `FreshnessLedger` and a fresh `ToolRuntime`, so "the child inherited the right
 * root" is a claim about new code, and the only way to check it is to look for
 * the effect on the remote machine.
 *
 * Same two targets as the rest of the SSH matrix: a loopback `sshd` by default,
 * a real host under `KERNEL_SSH_REMOTE`. The remote-host run is the
 * authoritative one — loopback shares a uid and a filesystem, so it cannot tell
 * you anything about a real network hop.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createKernel, type Kernel } from '../../src/kernel.ts';
import { FakeModel } from '../../src/model/adapters/fake.ts';
import { ScriptedPrompter } from '../../src/cli/prompter.ts';
import { replayTerminalState, compareTerminalState } from '../../src/session/terminal-state.ts';
import { shq, sshUnavailable, startSshFixture, type SshFixture } from './ssh-harness.ts';
import { agentFile } from '../helpers/workspace.ts';
import type { ModelRequest } from '../../src/model/ir.ts';
import type { KernelEvent } from '../../src/session/events.ts';

const unavailable = sshUnavailable();
const ENABLED = process.env.KERNEL_SSH === '1' || Boolean(process.env.KERNEL_SSH_REMOTE);

/** A marker that exists only on the remote, so a local read cannot find it. */
const REMOTE_ONLY_MARKER = 'REMOTE_ONLY_DELEGATION_MARKER_4c1f';

let fixture: SshFixture;
let base: string;
let projectDir: string;

before(async () => {
  if (!ENABLED || unavailable) return;
  fixture = await startSshFixture();

  base = await mkdtemp(path.join(tmpdir(), 'ssh-delegation-'));
  projectDir = path.join(base, 'local-project');
  // The agent definition is a *local* project file — a config that names a remote
  // cannot itself be read through that remote (ADR-0012) — while everything the
  // child touches is remote. That asymmetry is the composition under test.
  await mkdir(path.join(projectDir, '.mycoder', 'agents'), { recursive: true });
  await writeFile(
    path.join(projectDir, '.mycoder', 'agents', 'remote-reviewer.md'),
    agentFile({
      name: 'remote-reviewer',
      description: 'Reads the remote workspace and reports.',
      profile: 'read-only',
      tools: ['Read', 'Grep'],
      instructions: 'Report what the file contains.',
    }),
    'utf8',
  );
});

after(async () => {
  if (base) await rm(base, { recursive: true, force: true });
  await fixture?.cleanup();
});

function guard(t: { skip(reason: string): void }): boolean {
  if (!ENABLED) {
    t.skip('set KERNEL_SSH=1 (loopback sshd) or KERNEL_SSH_REMOTE=<alias> to run the composition smoke');
    return true;
  }
  if (unavailable) {
    t.skip(`SSH validation unavailable: ${unavailable}`);
    return true;
  }
  return false;
}

describe('a delegated child uses the session backend, not the local one (§39)', () => {
  test('the child reads and greps the remote workspace, and the parent gets its report', async (t) => {
    if (guard(t)) return;

    // A file that exists **only** on the remote. If the child were resolving
    // against the local project directory it would find nothing, which is exactly
    // the ADR-0012 failure this smoke is shaped to catch.
    await fixture.raw(
      `printf '// ${REMOTE_ONLY_MARKER}\\nexport const remote = 1;\\n' > ${shq(`${fixture.workspace}/remote-only.ts`)}`,
    );

    const dirsRoot = path.join(base, 'dirs');
    await mkdir(path.join(dirsRoot, 'config'), { recursive: true });
    await writeFile(
      path.join(dirsRoot, 'config', 'remotes.toml'),
      `[remote.delegation-target]\nhost = "${fixture.remote.host}"\nworkspace = "${fixture.workspace}"\n` +
        (fixture.remote.sshConfigFile ? `ssh_config_file = "${fixture.remote.sshConfigFile}"\n` : ''),
      'utf8',
    );

    const childRequests: ModelRequest[] = [];
    let parentStep = 0;
    let childStep = 0;

    const kernel: Kernel = await createKernel({
      workspaceDir: projectDir,
      dirsRoot,
      remoteName: 'delegation-target',
      fakeModel: new FakeModel({
        responder: (request) => {
          if (request.system.includes('the subagent "remote-reviewer"')) {
            childRequests.push(request);
            childStep += 1;
            if (childStep === 1) {
              return { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'remote-only.ts' } }] };
            }
            if (childStep === 2) {
              return { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'REMOTE_ONLY' } }] };
            }
            return { kind: 'final', text: 'remote-only.ts carries the marker.' };
          }
          parentStep += 1;
          return parentStep === 1
            ? {
                kind: 'tools',
                calls: [
                  {
                    name: 'Delegate',
                    arguments: {
                      agent: 'remote-reviewer',
                      task: 'Read remote-only.ts and confirm what marker it contains.',
                    },
                  },
                ],
              }
            : { kind: 'final', text: 'The remote reviewer confirmed the marker.' };
        },
      }),
      prompter: new ScriptedPrompter([]),
      logLevel: 'silent',
    });

    try {
      assert.equal(kernel.backend.kind, 'ssh', 'the fixture did not connect over SSH');
      assert.ok(kernel.delegation, 'the local agent definition was not discovered');

      const outcome = await kernel.session.runTurn('Have the remote reviewer look at remote-only.ts.');
      assert.equal(outcome.turn.state, 'completed', outcome.error?.message ?? '');

      // --- the child really ran, and really ran remotely -------------------
      const record = kernel.session.delegationRecords().at(-1);
      assert.ok(record, 'no delegation was recorded');
      assert.equal(record.status, 'completed', `child status was ${record.status}`);
      assert.ok(record.usage.modelRequests >= 2, `child made ${record.usage.modelRequests} requests`);
      assert.equal(record.child.toolCalls.length, 2, 'expected the child Read and Grep');

      // The marker can only have come from the remote file. This is the assertion
      // the whole file exists for: a child resolving against the local project
      // directory would have failed to find `remote-only.ts` at all.
      const childResults = childRequests
        .flatMap((r) => r.messages)
        .flatMap((m) => m.parts)
        .filter((p) => p.type === 'tool_result')
        .map((p) => (p.type === 'tool_result' ? p.content : ''))
        .join('\n');
      assert.match(childResults, new RegExp(REMOTE_ONLY_MARKER));

      // Paths the child saw are the *remote* workspace's, not the local root.
      const events: KernelEvent[] = [];
      for await (const event of kernel.store.readEvents(kernel.sessionId)) events.push(event);
      const childReads = events.filter((e) => e.type === 'file.read' && e.delegationId !== undefined);
      assert.equal(childReads.length, 1, 'the child produced no remote read receipt');
      assert.equal(
        (childReads[0]!.payload as { path: string }).path,
        'remote-only.ts',
        'the read was recorded against an unexpected path',
      );
      // Compared by suffix, not by equality: on macOS the loopback fixture's
      // `/var/...` temp path is reported back as `/private/var/...` once the
      // remote resolves its symlinks, which is a property of the fixture rather
      // than of the backend.
      assert.ok(
        kernel.workspaceRoot.endsWith(fixture.workspace) || fixture.workspace.endsWith(kernel.workspaceRoot),
        `tool plane root ${kernel.workspaceRoot} is not the remote workspace ${fixture.workspace}`,
      );

      // --- and the parent received it, with the boundary still intact -------
      const parentResults = kernel.context
        .history()
        .flatMap((m) => m.parts)
        .filter((p) => p.type === 'tool_result')
        .map((p) => (p.type === 'tool_result' ? p.content : ''))
        .join('\n');
      assert.match(parentResults, /\[subagent:remote-reviewer\] completed/);

      // The replay gate holds over a remote delegation too: the composition is
      // only worth having if it is auditable.
      const live = kernel.session.terminalState();
      const replayed = await replayTerminalState(kernel.store, kernel.sessionId);
      const comparison = compareTerminalState(live, replayed);
      assert.equal(
        comparison.equal,
        true,
        `remote delegation diverged on replay:\n  ${comparison.differences.join('\n  ')}`,
      );

      process.stderr.write(
        `\n  ssh + subagent: ${fixture.description}; child made ${record.usage.modelRequests} ` +
          `model request(s) and ${record.child.toolCalls.length} remote tool call(s)\n`,
      );
    } finally {
      await kernel.shutdown();
      await fixture.raw(`rm -f ${shq(`${fixture.workspace}/remote-only.ts`)}`);
    }
  });

  test('a read-only child cannot write to the remote workspace either', async (t) => {
    if (guard(t)) return;

    const dirsRoot = path.join(base, 'dirs');
    const childResults: string[] = [];
    let parentStep = 0;

    const kernel: Kernel = await createKernel({
      workspaceDir: projectDir,
      dirsRoot,
      remoteName: 'delegation-target',
      fakeModel: new FakeModel({
        responder: (request) => {
          if (request.system.includes('the subagent "remote-reviewer"')) {
            for (const message of request.messages) {
              for (const part of message.parts) {
                if (part.type === 'tool_result') childResults.push(part.content);
              }
            }
            return childResults.length === 0
              ? {
                  kind: 'tools',
                  calls: [
                    {
                      name: 'Edit',
                      arguments: {
                        mode: 'create',
                        path: 'child-wrote-this.ts',
                        content: 'export const pwned = true;\n',
                      },
                    },
                  ],
                }
              : { kind: 'final', text: 'I could not write.' };
          }
          parentStep += 1;
          return parentStep === 1
            ? {
                kind: 'tools',
                calls: [
                  {
                    name: 'Delegate',
                    arguments: { agent: 'remote-reviewer', task: 'Create child-wrote-this.ts.' },
                  },
                ],
              }
            : { kind: 'final', text: 'The child was refused.' };
        },
      }),
      prompter: new ScriptedPrompter([]),
      logLevel: 'silent',
    });

    try {
      await kernel.session.runTurn('Ask the remote reviewer to create a file.');

      // The capability intersection is enforced before anything reaches the
      // network: the file must not exist on the remote.
      const probe = await fixture.raw(
        `test -e ${shq(`${fixture.workspace}/child-wrote-this.ts`)} && echo EXISTS || echo ABSENT`,
      );
      assert.match(probe.stdout, /ABSENT/, 'a read-only child wrote to the remote workspace');
    } finally {
      await kernel.shutdown();
      await fixture.raw(`rm -f ${shq(`${fixture.workspace}/child-wrote-this.ts`)}`);
    }
  });
});
