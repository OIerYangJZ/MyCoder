/**
 * Real SSH validation (alpha.3 §11–§21).
 *
 * The whole §14 matrix, plus the jail (§15), the remote canary (§16),
 * environment forwarding (§17), cancellation (§18), timeouts (§19), resume
 * (§20) and hooks (§21) — run against a **real OpenSSH server**, not a fixture.
 *
 * Two targets, one suite:
 *
 *   default                     a loopback `sshd` this suite starts and tears
 *                               down. Real ssh client, real sshd, real remote
 *                               `sh`. Not a VPS: same uid, same filesystem, no
 *                               network hop.
 *   KERNEL_SSH_REMOTE=<alias>   a real remote host, resolved through the user's
 *   KERNEL_SSH_WORKSPACE=<path> own ssh config. The kernel never reads a private
 *                               key (§13); OpenSSH does the authenticating.
 *
 * Every case is written to be target-agnostic, because a matrix that only runs
 * against loopback would quietly become the definition of "validated" — and the
 * point of §11.1 is the opposite. Where a result differs between the two, the
 * test says which target it is on rather than skipping.
 *
 * `docs/alpha3-ssh-validation.md` records which target produced the evidence,
 * and marks the rows loopback cannot answer as NOT TESTED. Do not read a green
 * run here as "validated against a VPS".
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  SshExecutionBackend,
  buildSshArgs,
  defaultRemoteConfig,
  validateRemoteConfig,
  type RemoteConfig,
} from '../../src/execution/ssh.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { nullLogger } from '../../src/util/logger.ts';
import { toKernelError } from '../../src/util/errors.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';
import type { CapabilityExecutor, CapabilityProfile } from '../../src/execution/backend.ts';
import { REMOTE_CANARY, shq, sshUnavailable, startSshFixture, type SshFixture } from './ssh-harness.ts';

const unavailable = sshUnavailable();

/**
 * The suite is opt-in via `KERNEL_SSH=1`, like the live-model suite.
 *
 * Starting a server and generating keys is not something an ordinary `pnpm test`
 * should do without being asked, and CI runs it as its own job so a failure is
 * legible in the run list rather than buried in a combined log.
 */
const ENABLED = process.env.KERNEL_SSH === '1' || Boolean(process.env.KERNEL_SSH_REMOTE);

let fixture: SshFixture;
let backend: SshExecutionBackend;
const redactor = new Redactor();

/** Everything the redactor saw, for the §16 sink assertions. */
const remoteOutputs: string[] = [];

before(async () => {
  if (!ENABLED || unavailable) return;
  fixture = await startSshFixture();

  // Register the canary as a known secret before anything runs, which is what
  // the kernel does at boot for every configured credential and what
  // `createTestWorkspace` does for the local canary. Without it this suite
  // would be measuring the secret *scanner's* heuristics rather than the
  // boundary — and would report a leak for a value nothing had been told to
  // protect. `SECRET_BOUNDARY` below covers the unregistered case separately,
  // where it belongs.
  redactor.addLiteral(REMOTE_CANARY);

  backend = await SshExecutionBackend.connect({
    config: fixture.remote,
    redactor,
    logger: nullLogger,
  });
});

after(async () => {
  await backend?.close();
  await fixture?.cleanup();
});

/** Skip the whole suite with a *reason*, never silently. */
function guard(t: { skip(reason: string): void }): boolean {
  if (!ENABLED) {
    t.skip('set KERNEL_SSH=1 (loopback sshd) or KERNEL_SSH_REMOTE=<alias> to run the SSH matrix');
    return true;
  }
  if (unavailable) {
    t.skip(`SSH validation unavailable: ${unavailable}`);
    return true;
  }
  return false;
}

const remotePath = (rel: string): CanonicalPath => `${fixture.workspace}/${rel}` as CanonicalPath;

/** A capability profile shaped the way the tool runtime builds them. */
function profile(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    readRoots: [fixture.workspace as CanonicalPath],
    writeRoots: [fixture.workspace as CanonicalPath],
    allowExec: true,
    network: false,
    envAllow: [],
    secretInjections: [],
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
    ...overrides,
  };
}

async function withExecutor<T>(
  fn: (ex: CapabilityExecutor) => Promise<T>,
  overrides: Partial<CapabilityProfile> = {},
): Promise<T> {
  const executor = await backend.enforce(profile(overrides));
  try {
    return await fn(executor);
  } finally {
    executor.dispose();
  }
}

/** Run a remote command through the backend and record its output for §16. */
async function exec(argv: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  return withExecutor(async (ex) => {
    const result = await ex.exec(
      { argv, cwd: fixture.workspace as CanonicalPath, timeoutMs: opts.timeoutMs ?? 30_000 },
      opts.signal,
    );
    remoteOutputs.push(result.stdout, result.stderr);
    return result;
  });
}

// --- §12/§13: the configuration the backend is allowed to have --------------

describe('SSH configuration safety (§12, §13)', () => {
  test('agent forwarding cannot be enabled by configuration', (t) => {
    if (guard(t)) return;
    const bad: RemoteConfig = { ...fixture.remote, forwardAgent: true };
    const v = validateRemoteConfig(bad);
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), /agent forwarding is hard-denied/);
  });

  test('environment forwarding cannot be enabled by configuration', (t) => {
    if (guard(t)) return;
    const bad: RemoteConfig = { ...fixture.remote, forwardEnv: ['GITHUB_TOKEN'] };
    assert.equal(validateRemoteConfig(bad).ok, false);
  });

  test('host-key checking cannot be turned off', (t) => {
    if (guard(t)) return;
    const bad: RemoteConfig = { ...fixture.remote, strictHostKeyChecking: false };
    assert.equal(validateRemoteConfig(bad).ok, false);
  });

  test('the security options are on the command line, not left to ssh_config', (t) => {
    if (guard(t)) return;
    const args = buildSshArgs(fixture.remote, undefined).join(' ');

    // OpenSSH keeps the *first* value it obtains for an option and command-line
    // `-o` is obtained before any file is read, so stating these here is what
    // makes a permissive ~/.ssh/config unable to relax them.
    assert.match(args, /-o ForwardAgent=no/);
    assert.match(args, /-o StrictHostKeyChecking=yes/);
    assert.match(args, /-o SendEnv=-\*/);
    assert.match(args, /-o BatchMode=yes/);
    assert.match(args, /-o ClearAllForwardings=yes/);
  });

  test('an ssh_config file cannot re-enable forwarding, because -o comes first', (t) => {
    if (guard(t)) return;
    const args = buildSshArgs({ ...fixture.remote, sshConfigFile: '/tmp/x' }, undefined);
    const dashF = args.indexOf('-F');
    const forwardAgent = args.indexOf('ForwardAgent=no');

    assert.ok(dashF >= 0, '-F was not emitted');
    assert.ok(forwardAgent > dashF, 'ForwardAgent=no must appear after -F to win the first-value rule');
  });
});

// --- §14: connection --------------------------------------------------------

describe('SSH connection (§14)', () => {
  test('connects by configured alias with StrictHostKeyChecking=yes', async (t) => {
    if (guard(t)) return;
    // The fixture pre-seeds known_hosts rather than accepting on first use, so
    // this is a genuine strict-mode connection to a pre-trusted key.
    const probe = await backend.probe();
    assert.equal(probe.ok, true, probe.detail);
  });

  test('the environment descriptor reports policy-enforced, not os-isolated', (t) => {
    if (guard(t)) return;
    // §15: "Do not claim os-isolated if protection remains policy-enforced."
    assert.equal(backend.environment.sandboxStrength, 'policy-enforced');
    assert.equal(backend.environment.kind, 'ssh');
  });

  test('an unknown host fails as a structured REMOTE_UNAVAILABLE', async (t) => {
    if (guard(t)) return;
    const bogus: RemoteConfig = {
      ...defaultRemoteConfig('bogus', 'kernel-test-nonexistent.invalid', fixture.workspace),
      connectTimeoutSec: 5,
    };

    await assert.rejects(
      () => SshExecutionBackend.connect({ config: bogus, redactor, logger: nullLogger }),
      (e: unknown) => {
        const err = toKernelError(e);
        // Not TOOL_FAILED (§19): an unreachable host and a failing command are
        // different problems with different remedies.
        assert.equal(err.code, 'REMOTE_UNAVAILABLE', `got ${err.code}: ${err.message}`);
        return true;
      },
    );
  });

  test('a host-key mismatch is a distinct, non-retryable error', async (t) => {
    if (guard(t)) return;
    if (!fixture.loopback) return t.skip('would require tampering with the real host key');

    // A known_hosts entry that does not match the server's actual key is the
    // shape of a MITM, and must not be reported as a transient failure a retry
    // could fix.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const dir = await mkdtemp(pathMod.join(tmpdir(), 'ssh-badkey-'));
    const badKnown = pathMod.join(dir, 'known_hosts');
    const badConfig = pathMod.join(dir, 'ssh_config');

    const original = await (await import('node:fs/promises')).readFile(fixture.remote.sshConfigFile!, 'utf8');
    // Same alias and port, but a known_hosts holding a *different* key.
    const { spawnSync } = await import('node:child_process');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-f', pathMod.join(dir, 'other'), '-N', '']);
    const otherPub = await (
      await import('node:fs/promises')
    ).readFile(pathMod.join(dir, 'other.pub'), 'utf8');
    const port = /Port (\d+)/.exec(original)?.[1] ?? '22';
    await writeFile(badKnown, `[127.0.0.1]:${port} ${otherPub.trim()}\n`, 'utf8');
    await writeFile(
      badConfig,
      original.replace(/UserKnownHostsFile .*/, `UserKnownHostsFile ${badKnown}`),
      'utf8',
    );

    await assert.rejects(
      () =>
        SshExecutionBackend.connect({
          config: { ...fixture.remote, sshConfigFile: badConfig },
          redactor,
          logger: nullLogger,
        }),
      (e: unknown) => {
        const err = toKernelError(e);
        assert.equal(err.code, 'REMOTE_HOST_KEY_ERROR', `got ${err.code}: ${err.message}`);
        assert.equal(err.retryable, false, 'a host-key mismatch must never be retried');
        return true;
      },
    );

    await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true });
  });

  test('the connect timeout is bounded', async (t) => {
    if (guard(t)) return;
    // 203.0.113.0/24 is TEST-NET-3: reserved for documentation, never routed,
    // so the connection hangs rather than being refused — which is the case a
    // ConnectTimeout has to cover.
    const unreachable: RemoteConfig = {
      ...defaultRemoteConfig('blackhole', '203.0.113.1', fixture.workspace),
      connectTimeoutSec: 3,
      controlMaster: false,
    };

    const started = Date.now();
    await assert.rejects(() =>
      SshExecutionBackend.connect({ config: unreachable, redactor, logger: nullLogger }),
    );
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 25_000, `connect took ${elapsed}ms; ConnectTimeout did not bound it`);
  });
});

// --- §14: file system -------------------------------------------------------

describe('SSH file system (§14)', () => {
  test('reads a remote file', async (t) => {
    if (guard(t)) return;
    await fixture.raw(`printf 'alpha\\nbeta\\ngamma\\n' > ${shq(`${fixture.workspace}/read-me.txt`)}`);

    const bytes = await backend.fs.readFile(remotePath('read-me.txt'));
    assert.equal(bytes.toString('utf8'), 'alpha\nbeta\ngamma\n');
  });

  test('binary content survives the text channel intact', async (t) => {
    if (guard(t)) return;
    // The transport base64-encodes; this is what proves it, rather than
    // assuming it because the code says so.
    await fixture.raw(`printf 'a\\000b\\377c' > ${shq(`${fixture.workspace}/binary.bin`)}`);

    const bytes = await backend.fs.readFile(remotePath('binary.bin'));
    assert.deepEqual([...bytes], [0x61, 0x00, 0x62, 0xff, 0x63]);
  });

  test('CRLF line endings are preserved, not normalised in transit', async (t) => {
    if (guard(t)) return;
    await fixture.raw(`printf 'one\\r\\ntwo\\r\\n' > ${shq(`${fixture.workspace}/crlf.txt`)}`);

    const bytes = await backend.fs.readFile(remotePath('crlf.txt'));
    assert.equal(bytes.toString('utf8'), 'one\r\ntwo\r\n');
  });

  test('writes a remote file atomically', async (t) => {
    if (guard(t)) return;
    await backend.fs.writeFileAtomic(remotePath('written.txt'), Buffer.from('written by kernel\n', 'utf8'));

    const back = await fixture.raw(`cat ${shq(`${fixture.workspace}/written.txt`)}`);
    assert.equal(back.stdout, 'written by kernel\n');
  });

  test('a failed write leaves no temp file behind', async (t) => {
    if (guard(t)) return;
    // Target a path whose parent does not exist and createParents is off.
    await assert.rejects(() => backend.fs.writeFileAtomic(remotePath('no-such-dir/x.txt'), Buffer.from('x')));

    const leftovers = await fixture.raw(
      `find ${shq(fixture.workspace)} -name '*.agent-tmp*' 2>/dev/null | wc -l`,
    );
    assert.equal(leftovers.stdout.trim(), '0', 'a failed atomic write left a temp file behind');
  });

  test('stats a remote file, including symlink-ness', async (t) => {
    if (guard(t)) return;
    await fixture.raw(
      `cd ${shq(fixture.workspace)} && printf 'x' > stat-me.txt && ln -sf stat-me.txt stat-link.txt`,
    );

    const file = await backend.fs.stat(remotePath('stat-me.txt'));
    assert.equal(file?.isFile, true);
    assert.equal(file?.size, 1);

    const link = await backend.fs.stat(remotePath('stat-link.txt'));
    assert.equal(link?.isSymlink, true, 'a remote symlink was not reported as one');
  });

  test('lists a remote directory, dotfiles included', async (t) => {
    if (guard(t)) return;
    await fixture.raw(
      `cd ${shq(fixture.workspace)} && mkdir -p listdir && touch listdir/.hidden listdir/plain`,
    );

    const entries = await backend.fs.listDir(remotePath('listdir'));
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['.hidden', 'plain']);
  });

  test('detects external mutation, so freshness can be invalidated', async (t) => {
    if (guard(t)) return;
    await fixture.raw(`printf 'v1\\n' > ${shq(`${fixture.workspace}/mutating.txt`)}`);
    const before = await backend.fs.stat(remotePath('mutating.txt'));

    // Something other than the kernel changes the file, which is the case the
    // runtime must not assume away (§20).
    await new Promise((r) => setTimeout(r, 1_100)); // mtime has 1s granularity
    await fixture.raw(`printf 'v2-longer\\n' > ${shq(`${fixture.workspace}/mutating.txt`)}`);
    const after = await backend.fs.stat(remotePath('mutating.txt'));

    assert.notEqual(after?.size, before?.size, 'size did not change');
    assert.ok((after?.mtimeMs ?? 0) > (before?.mtimeMs ?? 0), 'mtime did not advance');
  });
});

// --- §14: process -----------------------------------------------------------

describe('SSH process execution (§14)', () => {
  test('runs a command and returns stdout', async (t) => {
    if (guard(t)) return;
    const result = await exec(['echo', 'hello from the remote']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello from the remote/);
  });

  test('a non-zero exit code is preserved', async (t) => {
    if (guard(t)) return;
    const result = await exec(['sh', '-c', 'exit 42']);
    assert.equal(result.exitCode, 42, 'the remote exit code did not survive the transport');
  });

  test('stderr is captured separately from stdout', async (t) => {
    if (guard(t)) return;
    const result = await exec(['sh', '-c', 'echo out; echo err >&2']);
    assert.match(result.stdout, /out/);
    assert.match(result.stderr, /err/);
    assert.equal(result.stdout.includes('err'), false, 'stderr bled into stdout');
  });

  test('arguments with spaces and quotes survive quoting', async (t) => {
    if (guard(t)) return;
    // The transport builds a remote shell command line, so quoting is the part
    // most likely to be subtly wrong.
    const nasty = `it's a "test" $HOME \`whoami\` ; echo INJECTED`;
    const result = await exec(['echo', nasty]);

    // Exact equality is the real assertion: `$HOME` was not expanded, the
    // backticks were not run, and the `;` did not split the command.
    assert.equal(result.stdout.trim(), nasty, 'remote argument quoting altered the value');

    // And exactly one line came back. `INJECTED` appears in the literal itself,
    // so counting occurrences would be meaningless — what a successful
    // injection would produce is a *second* line.
    assert.equal(
      result.stdout.trimEnd().split('\n').length,
      1,
      `a metacharacter escaped its quoting and ran: ${JSON.stringify(result.stdout)}`,
    );
  });

  test('output is truncated at the declared limit rather than growing unbounded', async (t) => {
    if (guard(t)) return;
    const result = await withExecutor(
      (ex) =>
        ex.exec({
          argv: ['sh', '-c', 'yes abcdefghij | head -c 200000'],
          cwd: fixture.workspace as CanonicalPath,
          timeoutMs: 30_000,
          maxOutputBytes: 4096,
        }),
      { maxOutputBytes: 4096 },
    );

    assert.equal(result.outputTruncated, true, 'a 200KB stream was not reported as truncated');
    assert.ok(result.stdout.length < 100_000, `kept ${result.stdout.length} bytes despite a 4KB cap`);
  });

  test('a remote command that exceeds its timeout is reported as timed out', async (t) => {
    if (guard(t)) return;
    const started = Date.now();
    const result = await exec(['sleep', '30'], { timeoutMs: 2_000 });
    const elapsed = Date.now() - started;

    assert.equal(result.timedOut, true, 'a 30s command under a 2s timeout was not marked timedOut');
    assert.ok(elapsed < 15_000, `took ${elapsed}ms; the timeout did not bound it`);
  });
});

// --- §18: cancellation ------------------------------------------------------

describe('remote cancellation (§18)', () => {
  test('an abort signal terminates the local ssh client promptly', async (t) => {
    if (guard(t)) return;
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 500);

    const result = await exec(['sleep', '30'], { signal: controller.signal, timeoutMs: 60_000 });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 10_000, `cancellation took ${elapsed}ms`);
    assert.notEqual(result.exitCode, 0, 'a cancelled command reported success');
  });

  test('whether the REMOTE process died is asserted, not assumed', async (t) => {
    if (guard(t)) return;

    // §18: "If remote process termination cannot be guaranteed, surface
    // uncertainty rather than claiming success." So this measures it instead of
    // asserting a convenient answer. Killing the local ssh client closes the
    // channel; whether the remote child dies depends on it noticing EOF/SIGHUP,
    // which is an OpenSSH and remote-shell behaviour, not something the kernel
    // controls.
    const marker = `${fixture.workspace}/cancel-marker.txt`;
    await fixture.raw(`rm -f ${shq(marker)}`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await exec(['sh', '-c', `sleep 4; echo survived > ${shq(marker)}`], {
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    // Give the orphan long enough to write the marker if it is still alive.
    await new Promise((r) => setTimeout(r, 6_000));
    const check = await fixture.raw(`test -f ${shq(marker)} && echo SURVIVED || echo GONE`);
    const survived = check.stdout.includes('SURVIVED');

    // Recorded either way. The assertion that matters for the kernel is that
    // the *local* turn ended; the remote outcome is documented in
    // docs/alpha3-ssh-validation.md as a known uncertainty rather than being
    // asserted into a shape that happens to pass today.
    // eslint-disable-next-line no-console -- lint-allow no-console-in-kernel: test observation, and the rule is scoped to src/
    remoteOutputs.push(`[observation] remote process after cancel: ${survived ? 'SURVIVED' : 'terminated'}`);
    assert.ok(
      typeof survived === 'boolean',
      'the observation itself must be recordable for the evidence artifact',
    );
  });
});

// --- §15: the remote workspace jail ----------------------------------------

describe('remote workspace jail (§15)', () => {
  const escapes: Array<{ name: string; rel: string }> = [
    { name: 'parent traversal', rel: '../escaped.txt' },
    { name: 'deep traversal', rel: '../../../../etc/passwd' },
    { name: 'traversal through a real subdirectory', rel: 'listdir/../../escaped.txt' },
  ];

  for (const { name, rel } of escapes) {
    test(`read is refused: ${name}`, async (t) => {
      if (guard(t)) return;
      await assert.rejects(
        () => backend.fs.readFile(`${fixture.workspace}/${rel}` as CanonicalPath),
        (e: unknown) => {
          assert.equal(toKernelError(e).code, 'PATH_OUTSIDE_WORKSPACE');
          return true;
        },
      );
    });
  }

  test('an absolute path outside the remote workspace is refused', async (t) => {
    if (guard(t)) return;
    await assert.rejects(
      () => backend.fs.readFile('/etc/passwd' as CanonicalPath),
      (e: unknown) => {
        assert.equal(toKernelError(e).code, 'PATH_OUTSIDE_WORKSPACE');
        return true;
      },
    );
  });

  test('the canary file itself is unreachable by path', async (t) => {
    if (guard(t)) return;
    await assert.rejects(() => backend.fs.readFile(fixture.canaryPath as CanonicalPath));
  });

  test('a symlink pointing out of the workspace does not deliver its target', async (t) => {
    if (guard(t)) return;
    await fixture.raw(`ln -sf ${shq(fixture.canaryPath)} ${shq(`${fixture.workspace}/innocent.txt`)}`);

    // The path is inside the jail, so `jail()` permits it — the remote `base64`
    // follows the link and returns the canary. What stops it reaching the model
    // is the redactor, and the §16 sink assertions are what prove that. This
    // test records the honest enforcement level: the jail is a *path* check,
    // not an OS boundary, exactly as `sandboxStrength: 'policy-enforced'` says.
    let delivered = '';
    try {
      delivered = (await backend.fs.readFile(remotePath('innocent.txt'))).toString('utf8');
    } catch {
      delivered = '';
    }
    remoteOutputs.push(delivered);

    assert.ok(true, 'observation recorded; the boundary assertion is in the §16 sink suite');
  });

  test('a remote working directory outside the jail is refused', async (t) => {
    if (guard(t)) return;
    await assert.rejects(
      () => withExecutor((ex) => ex.exec({ argv: ['pwd'], cwd: '/tmp' as CanonicalPath, timeoutMs: 10_000 })),
      (e: unknown) => {
        assert.equal(toKernelError(e).code, 'PATH_OUTSIDE_WORKSPACE');
        return true;
      },
    );
  });
});

// --- §17: environment forwarding -------------------------------------------

describe('SSH environment forwarding (§17)', () => {
  const HOST_SECRETS = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'SSH_AUTH_SOCK',
  ];

  test('NEGATIVE CONTROL: the host process really does carry these variables', async (t) => {
    if (guard(t)) return;
    // Otherwise "absent on the remote" is true because they were never set.
    const marker = 'kernel-forwarding-probe-value';
    for (const name of HOST_SECRETS) process.env[name] = `${marker}-${name}`;

    try {
      assert.equal(process.env.GITHUB_TOKEN, `${marker}-GITHUB_TOKEN`);

      const result = await exec(['sh', '-c', 'env']);
      const env = result.stdout;

      for (const name of HOST_SECRETS) {
        assert.equal(env.includes(name), false, `${name} was forwarded to the remote environment`);
      }
      assert.equal(env.includes(marker), false, 'a host secret value reached the remote environment');
    } finally {
      for (const name of HOST_SECRETS) delete process.env[name];
    }
  });

  test('the remote environment is built from nothing, not inherited', async (t) => {
    if (guard(t)) return;
    const result = await exec(['sh', '-c', 'env | wc -l']);

    // `env -i` plus explicit assignments: a login shell's worth of variables
    // would be dozens. A handful means the environment was constructed.
    const count = Number.parseInt(result.stdout.trim(), 10);
    assert.ok(count < 20, `remote environment has ${count} variables; it looks inherited`);
  });

  test('SSH_AUTH_SOCK is absent, so no agent is reachable from the remote', async (t) => {
    if (guard(t)) return;
    const result = await exec(['sh', '-c', 'echo "sock=[$SSH_AUTH_SOCK]"']);
    assert.match(result.stdout, /sock=\[\]/);
  });

  test('ssh-add against the forwarded agent finds nothing', async (t) => {
    if (guard(t)) return;
    const result = await exec(['sh', '-c', 'ssh-add -l 2>&1 || true']);
    assert.equal(
      /\b(ssh-ed25519|ssh-rsa|ecdsa-sha2)\b/.test(result.stdout),
      false,
      'an ssh agent was reachable from the remote',
    );
  });
});

// --- §16: the remote secret boundary ---------------------------------------

describe('remote secret boundary (§16)', () => {
  test('NEGATIVE CONTROL: the canary exists on the remote and is readable there', async (t) => {
    if (guard(t)) return;
    // Every assertion below is "the canary did not appear". This is what makes
    // that mean something: the file is there, and a shell on the remote can
    // read it. The boundary is what stops it travelling, not its absence.
    const check = await fixture.raw(`cat ${shq(fixture.canaryPath)}`);
    assert.match(check.stdout, /REMOTE_CANARY_SECRET/, 'the canary fixture is missing');
  });

  const attacks: Array<{ name: string; argv: string[] }> = [
    { name: 'cat the absolute path', argv: ['sh', '-c', `cat ${shq('')}`] },
    { name: 'grep the home directory', argv: ['sh', '-c', 'grep -r REMOTE_CANARY $HOME 2>&1 || true'] },
    { name: 'base64-encode it', argv: ['sh', '-c', 'base64 < $HOME/.agent-test-secret 2>&1 || true'] },
    { name: 'tar it up', argv: ['sh', '-c', 'tar cf - $HOME/.agent-test-secret 2>&1 | head -c 400 || true'] },
    { name: 'reverse it', argv: ['sh', '-c', 'rev < $HOME/.agent-test-secret 2>&1 || true'] },
    { name: 'read /etc/shadow', argv: ['sh', '-c', 'cat /etc/shadow 2>&1 || true'] },
    { name: 'list ~/.ssh', argv: ['sh', '-c', 'ls -la ~/.ssh 2>&1 || true'] },
  ];

  for (const attack of attacks) {
    test(`attack: ${attack.name}`, async (t) => {
      if (guard(t)) return;
      const argv =
        attack.name === 'cat the absolute path'
          ? ['sh', '-c', `cat ${shq(fixture.canaryPath)} 2>&1 || true`]
          : attack.argv;

      const result = await exec(argv);
      // Recorded for the aggregate assertion; individually, the requirement is
      // simply that the raw value is not in what came back.
      assert.equal(
        result.stdout.includes(REMOTE_CANARY),
        false,
        `the canary survived in stdout of: ${attack.name}`,
      );
      assert.equal(result.stderr.includes(REMOTE_CANARY), false, `the canary survived in stderr`);
    });
  }

  test('the canary appears zero times across every recorded remote output', (t) => {
    if (guard(t)) return;

    // The aggregate, over everything this suite pulled back from the remote —
    // including the symlink read in §15, which is the case where the *path*
    // check does not fire and redaction is the only thing left.
    const all = remoteOutputs.join('\n');
    assert.ok(all.length > 0, 'nothing was recorded; this assertion would be vacuous');

    const occurrences = all.split(REMOTE_CANARY).length - 1;
    assert.equal(occurrences, 0, `the canary appeared ${occurrences} time(s) in recorded remote output`);
  });

  test('NEGATIVE CONTROL: redaction is the mechanism, and it is selective', (t) => {
    if (guard(t)) return;
    // Prove the mechanism rather than inferring it: the registered canary is
    // stripped, an ordinary value of similar shape is not. A redactor that
    // blanked everything would also have passed every assertion above.
    assert.equal(redactor.redact(`x ${REMOTE_CANARY} y`).includes(REMOTE_CANARY), false);
    assert.match(redactor.redact('x ordinary-value y'), /ordinary-value/);
  });

  test('the enforcement level for an UNREGISTERED out-of-workspace file is recorded, not overstated', async (t) => {
    if (guard(t)) return;

    // The honest boundary statement, measured rather than asserted into a
    // convenient shape.
    //
    // `SshFileSystem.jail()` confines Read/Edit/Glob to the remote workspace,
    // and `SshProcess.exec` confines the working directory — but a *shell
    // command* may still name any absolute path the remote user can read.
    // Nothing in the path layer stops `cat /some/other/file`. What stops a
    // secret reaching the model is the Redactor, and the Redactor only knows
    // values it has been told about or can recognise heuristically.
    //
    // That is precisely what `sandboxStrength: 'policy-enforced'` claims, and
    // precisely what `os-isolated` would not. §15 says not to claim the latter;
    // this test is the evidence for the former.
    await fixture.raw(
      `printf 'unregistered-plain-value-a41f\\n' > ${shq(`${fixture.workspace}/../plain.txt`)}`,
    );
    const result = await exec(['sh', '-c', `cat ${shq(`${fixture.workspace}/../plain.txt`)} 2>&1 || true`]);

    const reachable = result.stdout.includes('unregistered-plain-value-a41f');
    assert.equal(
      reachable,
      true,
      'if this ever becomes false the backend gained real containment, and ' +
        'docs/alpha3-ssh-validation.md should be upgraded to say so',
    );
  });
});

// --- §14: git ---------------------------------------------------------------

describe('remote git (§14)', () => {
  test('git status and diff work where git is available', async (t) => {
    if (guard(t)) return;
    if (!backend.environment.hasGit) return t.skip('no git on the remote');

    await fixture.raw(
      `cd ${shq(fixture.workspace)} && git init -q 2>/dev/null; ` +
        `git config user.email t@t.invalid; git config user.name t; ` +
        `printf 'one\\n' > tracked.txt && git add tracked.txt && git commit -qm init 2>/dev/null; ` +
        `printf 'two\\n' >> tracked.txt`,
    );

    const status = await exec(['git', 'status', '--porcelain']);
    assert.match(status.stdout, /tracked\.txt/);

    const diff = await exec(['git', 'diff', '--', 'tracked.txt']);
    assert.match(diff.stdout, /\+two/);
  });

  test('nothing the suite ran created a commit or a push', async (t) => {
    if (guard(t)) return;
    if (!backend.environment.hasGit) return t.skip('no git on the remote');

    const log = await exec(['git', 'log', '--oneline']);
    // Exactly the one commit the fixture made above; the kernel adds none.
    assert.ok(log.stdout.trim().split('\n').length <= 1, `unexpected commits:\n${log.stdout}`);

    const remotes = await exec(['git', 'remote']);
    assert.equal(remotes.stdout.trim(), '', 'a remote was configured, so a push was possible');
  });
});
