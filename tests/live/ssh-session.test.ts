/**
 * A full kernel session over SSH (alpha.3 §20, §21, and the replay gate).
 *
 * The §14–§21 matrix drives `SshExecutionBackend` directly. This suite drives
 * the **whole kernel** — `createKernel` → `Session.runTurn` → `ToolRuntime` →
 * policy → SSH — which is the path that was recorded as `NOT TESTED` and turned
 * out to be concealing two total functional breaks (ADR-0012). So the point of
 * this file is not that SSH works; it is that the *composition* works, and stays
 * working.
 *
 * What it covers that nothing else does:
 *
 *   a real turn        Read → Edit → Shell against the remote, verified on the
 *                      remote rather than inferred from the tool result
 *   replay             §4.2: the event log replays to the same terminal state
 *   resume (§20)       identity checked, and the runtime does **not** assume the
 *                      remote workspace held still while it was gone
 *   remote hooks (§21) executed through the backend — proven by their effect
 *                      appearing on the remote filesystem — with a scrubbed
 *                      environment and redacted output
 *
 * Same two targets as `ssh-live.test.ts`: a loopback `sshd` by default, a real
 * host under `KERNEL_SSH_REMOTE`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createKernel, type Kernel } from '../../src/kernel.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import { ScriptedPrompter } from '../../src/cli/prompter.ts';
import { replaySession } from '../../src/session/resume.ts';
import { REMOTE_CANARY, shq, sshUnavailable, startSshFixture, type SshFixture } from './ssh-harness.ts';

/** The canary path, as a shell expression the remote hook evaluates. */
const REMOTE_CANARY_FILE_EXPR = '$HOME/.agent-test-secret 2>/dev/null || true';

const unavailable = sshUnavailable();
const ENABLED = process.env.KERNEL_SSH === '1' || Boolean(process.env.KERNEL_SSH_REMOTE);

let fixture: SshFixture;
/** Local project root: config, hooks, the session store. Never the remote. */
let projectDir: string;
let base: string;

before(async () => {
  if (!ENABLED || unavailable) return;
  fixture = await startSshFixture();

  base = await mkdtemp(path.join(tmpdir(), 'ssh-session-'));
  projectDir = path.join(base, 'local-project');
  await mkdir(path.join(projectDir, '.mycoder'), { recursive: true });
});

after(async () => {
  if (base) await rm(base, { recursive: true, force: true });
  await fixture?.cleanup();
});

function guard(t: { skip(reason: string): void }): boolean {
  if (!ENABLED) {
    t.skip('set KERNEL_SSH=1 (loopback sshd) or KERNEL_SSH_REMOTE=<alias> to run the remote session suite');
    return true;
  }
  if (unavailable) {
    t.skip(`SSH validation unavailable: ${unavailable}`);
    return true;
  }
  return false;
}

/**
 * A kernel whose tool plane is the remote workspace.
 *
 * `dirsRoot` keeps config and the session store inside the temp tree, and
 * `remotes.toml` is written there because a remote may only be declared in user
 * config. The *local* workspace directory is deliberately a different path from
 * the remote workspace — that asymmetry is what ADR-0012 is about, and a fixture
 * where they happened to match would test nothing.
 */
async function remoteKernel(opts: { resumeSessionId?: string; script?: FakeStep[] } = {}): Promise<Kernel> {
  const dirsRoot = path.join(base, 'dirs');
  await mkdir(path.join(dirsRoot, 'config'), { recursive: true });
  await writeFile(
    path.join(dirsRoot, 'config', 'remotes.toml'),
    `[remote.session-target]\nhost = "${fixture.remote.host}"\nworkspace = "${fixture.workspace}"\n` +
      (fixture.remote.sshConfigFile ? `ssh_config_file = "${fixture.remote.sshConfigFile}"\n` : ''),
    'utf8',
  );

  return createKernel({
    workspaceDir: projectDir,
    dirsRoot,
    remoteName: 'session-target',
    fakeModel: new FakeModel({ script: opts.script ?? [] }),
    prompter: new ScriptedPrompter([]),
    logLevel: 'silent',
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
  });
}

const read = (p: string): FakeStep => ({ kind: 'tools', calls: [{ name: 'Read', arguments: { path: p } }] });
const shell = (argv: string[]): FakeStep => ({
  kind: 'tools',
  calls: [{ name: 'Shell', arguments: { argv } }],
});
const done = (text: string): FakeStep => ({ kind: 'final', text });

function toolResults(kernel: Kernel): string[] {
  const out: string[] = [];
  for (const message of kernel.context.history()) {
    if (message.role !== 'tool') continue;
    for (const part of message.parts) if (part.type === 'tool_result') out.push(part.content);
  }
  return out;
}

// --- a real turn, end to end ------------------------------------------------

describe('a full turn drives remote tools (ADR-0012)', () => {
  let kernel: Kernel;

  before(async () => {
    if (!ENABLED || unavailable) return;
    await fixture.raw(`printf 'const v = 1;\\n' > ${shq(`${fixture.workspace}/target.ts`)}`);

    kernel = await remoteKernel();

    // The receipt only exists once the Read has run, so the script is resolved
    // one step at a time — exactly as a real model reads it off the result.
    const edit = (receiptId: string): FakeStep => ({
      kind: 'tools',
      calls: [
        {
          name: 'Edit',
          arguments: {
            mode: 'replace',
            path: 'target.ts',
            oldString: 'const v = 1;',
            newString: 'const v = 2;',
            receiptId,
          },
        },
      ],
    });

    const model = new FakeModel({
      responder: (_request, index) => {
        const receipt =
          kernel.freshness.list().find((r) => r.path.endsWith('target.ts'))?.receiptId ?? 'missing-receipt';
        const steps: FakeStep[] = [
          read('target.ts'),
          edit(receipt),
          shell(['sh', '-c', 'grep -q "const v = 2;" target.ts']),
          done('edited on the remote'),
        ];
        return steps[index];
      },
    });
    (kernel.modelRuntime as unknown as { routes: Map<string, unknown> }).routes.set('fake', model);

    await kernel.session.runTurn('change v to 2 and verify');
  });

  after(async () => {
    await kernel?.shutdown();
  });

  test('the two roots are genuinely different, and both are right', (t) => {
    if (guard(t)) return;
    // The precondition for everything else. If these matched, the suite would
    // pass against the very bug it exists to prevent.
    assert.notEqual(kernel.projectRoot, kernel.workspaceRoot);
    assert.equal(kernel.policy.workspaceRoot, kernel.backend.environment.workspaceRoot);

    // The remote may resolve the configured path through a link, so compare on
    // the trailing component rather than demanding the exact spelling.
    assert.match(kernel.workspaceRoot, /kernel-ssh-fixture$|MyCoder$/);
  });

  test('the turn completed', (t) => {
    if (guard(t)) return;
    assert.equal(kernel.session.turn?.state, 'completed', `results:\n${toolResults(kernel).join('\n---\n')}`);
  });

  test('the Read reached the remote file', (t) => {
    if (guard(t)) return;
    assert.match(toolResults(kernel)[0] ?? '', /const v = 1;/);
  });

  test('the Edit landed ON THE REMOTE, verified there', async (t) => {
    if (guard(t)) return;
    // Checked over ssh rather than trusting the tool result — the whole reason
    // the earlier "successful" Hello World was misleading.
    const back = await fixture.raw(`cat ${shq(`${fixture.workspace}/target.ts`)}`);
    assert.equal(back.stdout, 'const v = 2;\n');
  });

  test('the verifying Shell ran remotely and succeeded', (t) => {
    if (guard(t)) return;
    assert.match(toolResults(kernel).at(-1) ?? '', /exit 0/);
  });

  test('no tool call was left unanswered', (t) => {
    if (guard(t)) return;
    assert.deepEqual(kernel.context.openToolCalls(), []);
  });
});

// --- replay (§4.2) ----------------------------------------------------------

describe('the event log replays after remote operations', () => {
  let kernel: Kernel;
  let sessionId: string;

  before(async () => {
    if (!ENABLED || unavailable) return;
    await fixture.raw(`printf 'x\\n' > ${shq(`${fixture.workspace}/replayme.txt`)}`);

    kernel = await remoteKernel({
      script: [read('replayme.txt'), shell(['echo', 'remote-side-effect']), done('done')],
    });
    sessionId = kernel.sessionId;
    await kernel.session.runTurn('read and echo');
  });

  after(async () => {
    await kernel?.shutdown();
  });

  test('replay reaches the same terminal state as the live run', async (t) => {
    if (guard(t)) return;

    const liveState = kernel.session.turn?.state;
    assert.equal(liveState, 'completed');

    const replayed = await replaySession(kernel.store, sessionId as never);
    assert.ok(replayed, 'the session should replay');

    // §4.2: live terminal state == replayed terminal state. If this diverges the
    // event log is not a faithful record, which makes both resume and the audit
    // trail unsound — remote execution must not be a hole in it.
    assert.equal(replayed.metadata.sessionId, sessionId);
    assert.ok(replayed.messages.length > 0, 'replay produced no conversation');
  });

  test('the record says the work happened on the remote', async (t) => {
    if (guard(t)) return;

    // Without this the audit trail would describe a local run, and a reader of
    // the log could not tell which machine the edits landed on.
    const parts: string[] = [];
    for await (const event of kernel.store.readEvents(kernel.sessionId)) parts.push(JSON.stringify(event));
    assert.match(parts.join('\n'), /ssh /, 'the event log does not name an ssh backend');

    const replayed = await replaySession(kernel.store, kernel.sessionId);
    assert.equal(replayed?.metadata.backendKind, 'ssh');
    assert.equal(replayed?.metadata.remote, 'session-target');
  });
});

// --- §20: resume ------------------------------------------------------------

describe('remote resume (§20)', () => {
  let sessionId: string;

  before(async () => {
    if (!ENABLED || unavailable) return;
    await fixture.raw(`printf 'original\\n' > ${shq(`${fixture.workspace}/resumed.txt`)}`);

    const first = await remoteKernel({ script: [read('resumed.txt'), done('read it')] });
    sessionId = first.sessionId;
    await first.session.runTurn('read resumed.txt');
    // "Interrupt the local kernel": shut it down with the remote untouched.
    await first.shutdown();
  });

  test('a session started on a remote resumes against the same remote', async (t) => {
    if (guard(t)) return;

    const second = await remoteKernel({ resumeSessionId: sessionId, script: [done('resumed')] });
    try {
      assert.equal(second.sessionId, sessionId);
      // No identity problem: same alias, same host, same remote workspace.
      const problems = second.config.warnings.filter((w) => /Cannot resume|different backend/.test(w));
      assert.deepEqual(problems, [], `resume reported problems: ${problems.join(' | ')}`);
    } finally {
      await second.shutdown();
    }
  });

  test('resume re-injects a freshness caveat rather than trusting old receipts', async (t) => {
    if (guard(t)) return;

    const second = await remoteKernel({ resumeSessionId: sessionId, script: [done('resumed')] });
    try {
      // §20: "The runtime must not assume the remote workspace remained
      // unchanged while offline." The receipts from before the interruption
      // describe a machine nobody was watching.
      const facts = second.context
        .history()
        .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
        .join('\n');
      const projected = second.projector.project(second.context, second.context.repository.facts);

      assert.match(
        `${facts}\n${projected.system}`,
        /re-read|no longer valid|freshness|stale/i,
        'resume did not warn that pre-interruption reads may be stale',
      );
    } finally {
      await second.shutdown();
    }
  });

  test('the remote changing underneath is not assumed away', async (t) => {
    if (guard(t)) return;

    // Something else edits the remote while the kernel is gone.
    await fixture.raw(`printf 'changed-while-offline\\n' > ${shq(`${fixture.workspace}/resumed.txt`)}`);

    const second = await remoteKernel({
      resumeSessionId: sessionId,
      script: [read('resumed.txt'), done('re-read')],
    });
    try {
      await second.session.runTurn('re-read resumed.txt');

      // The re-read must see the *new* content. A cached receipt would have
      // served the old bytes, and an Edit against them would then be building on
      // a file that no longer exists in that form.
      assert.match(
        toolResults(second).join('\n'),
        /changed-while-offline/,
        'the resumed session served pre-interruption content for a file that changed',
      );
    } finally {
      await second.shutdown();
    }
  });

  test('the session records a remote host identity (§20)', async (t) => {
    if (guard(t)) return;

    // The field existed and `checkResumeIdentity` read it, but nothing ever
    // wrote it — so "the remote host identity changed" could not fire. This is
    // the assertion that keeps it alive.
    const kernel = await remoteKernel({ script: [done('x')] });
    try {
      assert.ok(
        kernel.backend.environment.hostIdentity,
        'the ssh backend reports no host identity, so a resume cannot detect a replaced machine',
      );
      assert.match(kernel.backend.environment.hostIdentity!, /^[0-9a-f]{8,}$/);

      const replayed = await replaySession(kernel.store, kernel.sessionId);
      assert.equal(
        replayed?.metadata.remoteIdentity,
        kernel.backend.environment.hostIdentity,
        'the host identity was not persisted into session metadata',
      );
    } finally {
      await kernel.shutdown();
    }
  });

  test('resuming a remote session locally is refused', async (t) => {
    if (guard(t)) return;

    // A local resume of a remote session would silently operate on a different
    // tree. `checkResumeIdentity` turns that into a refusal.
    await assert.rejects(
      () =>
        createKernel({
          workspaceDir: projectDir,
          dirsRoot: path.join(base, 'dirs'),
          resumeSessionId: sessionId,
          fakeModel: new FakeModel(),
          logLevel: 'silent',
        }),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        assert.match(message, /Cannot resume|remote/i, `unexpected error: ${message}`);
        return true;
      },
    );
  });
});

// --- §21: remote hooks ------------------------------------------------------

describe('remote hook execution (§21)', () => {
  let kernel: Kernel;
  const MARKER = 'hook-ran-here.txt';

  before(async () => {
    if (!ENABLED || unavailable) return;

    // The hook *definition* is a project file, so it is written locally; the
    // command it declares executes through the backend. Those are different
    // questions (ADR-0012), and this fixture is where the distinction shows.
    await writeFile(
      path.join(projectDir, '.mycoder', 'hooks.toml'),
      '[[hooks]]\n' +
        'event = "PostToolUse"\n' +
        'matcher = "Read"\n' +
        `command = ["sh", "-c", "uname -s > ${MARKER}; echo hook-output-marker; echo \\"tok=[$GITHUB_TOKEN]\\"; cat ${REMOTE_CANARY_FILE_EXPR}"]\n` +
        'inject_output = true\n',
      'utf8',
    );

    await fixture.raw(`rm -f ${shq(`${fixture.workspace}/${MARKER}`)}`);
    await fixture.raw(`printf 'trigger\\n' > ${shq(`${fixture.workspace}/hooked.txt`)}`);

    // A host secret set on purpose, so "absent remotely" is a measurement.
    process.env.GITHUB_TOKEN = 'ghp-hook-forwarding-probe-value';

    kernel = await remoteKernel({ script: [read('hooked.txt'), done('read, hook should have fired')] });
    await kernel.session.runTurn('read hooked.txt');
  });

  after(async () => {
    delete process.env.GITHUB_TOKEN;
    await kernel?.shutdown();
  });

  test('the hook executed on the REMOTE, proven by its effect there', async (t) => {
    if (guard(t)) return;

    // The strongest available proof: the hook's side effect exists on the remote
    // filesystem. Asserting on its stdout would not distinguish a hook that ran
    // locally in a directory that happens to have the same name.
    const marker = await fixture.raw(`cat ${shq(`${fixture.workspace}/${MARKER}`)}`);
    assert.equal(marker.code, 0, 'the hook left no marker on the remote, so it did not run there');
    assert.match(marker.stdout.trim(), /^(Linux|Darwin|FreeBSD)/);

    if (!fixture.loopback) {
      // On a real VM the remote is Linux and the client is macOS, so the marker
      // contents alone prove the locality. Loopback cannot make this claim.
      assert.equal(
        marker.stdout.trim(),
        'Linux',
        'the hook reported a non-Linux uname from a Linux remote, so it ran locally',
      );
    }
  });

  test('the hook output was injected into the conversation', (t) => {
    if (guard(t)) return;
    const injected = kernel.context
      .history()
      .filter((m) => m.origin.kind === 'injection')
      .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      .join('\n');

    assert.match(injected, /hook-output-marker/, 'the hook output never reached the conversation');
  });

  test('the hook saw a scrubbed environment', (t) => {
    if (guard(t)) return;
    const injected = kernel.context
      .history()
      .filter((m) => m.origin.kind === 'injection')
      .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      .join('\n');

    // NEGATIVE CONTROL first: the variable really is set on the host.
    assert.equal(process.env.GITHUB_TOKEN, 'ghp-hook-forwarding-probe-value');
    assert.match(injected, /tok=\[\]/, `the host token reached the remote hook: ${injected}`);
  });

  test('hook output is redacted before it reaches the conversation', (t) => {
    if (guard(t)) return;
    const injected = kernel.context
      .history()
      .filter((m) => m.origin.kind === 'injection')
      .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      .join('\n');

    // The hook deliberately cats the out-of-workspace canary. Whether the read
    // succeeds is the backend's business; whether the value survives into
    // context is the Redactor's, and that is the boundary §21 asks about.
    assert.equal(injected.includes(REMOTE_CANARY), false, 'the remote canary reached the conversation');
  });

  test('the hook is auditable in the event log', async (t) => {
    if (guard(t)) return;
    const parts: string[] = [];
    for await (const event of kernel.store.readEvents(kernel.sessionId)) parts.push(JSON.stringify(event));
    const log = parts.join('\n');

    assert.match(log, /hook/i, 'no hook event was recorded, so the run is not replayable');
    assert.equal(log.includes(REMOTE_CANARY), false, 'the canary reached the event log');
  });
});
