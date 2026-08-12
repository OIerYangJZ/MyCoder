/**
 * A real OpenSSH server, for validating the SSH backend against real OpenSSH.
 *
 * alpha.3 §11.1 asks one question: *does the existing backend contract survive
 * real OpenSSH behaviour?* Fixtures cannot answer it. `ssh` has its own opinions
 * about `BatchMode`, its own exit codes, its own stderr wording for a host-key
 * mismatch, its own ControlMaster lifecycle, and its own idea of what happens to
 * a remote process when the client goes away. All of that is what the backend
 * is written against, and none of it is exercised by a fake.
 *
 * So this starts a genuine `sshd`: real host key, real public-key auth, real
 * protocol, real remote `sh`. Two things it is **not**:
 *
 *   - It is not a VPS. There is no network hop, no separate machine, no
 *     separate user account. The remote process runs as the same uid on the
 *     same filesystem, so anything that would be caught by *OS* isolation
 *     between two hosts is not caught here. The evidence artifact says so in
 *     those words; see `docs/alpha3-ssh-validation.md`.
 *   - It is not a substitute for the VPS run. `KERNEL_SSH_REMOTE` points the
 *     same suite at a real host, and the matrix is written so that every case
 *     runs unchanged against either target. That is the point of putting the
 *     target behind a resolver rather than hard-coding loopback.
 *
 * What loopback *does* buy is that the whole matrix runs on every developer
 * machine and in ordinary CI, so a regression in the SSH backend is caught the
 * day it lands rather than the next time someone rents a server.
 *
 * Everything lives in one temp directory that is removed on teardown: host key,
 * client key, `sshd_config`, the remote workspace, and the out-of-workspace
 * canary. Nothing touches `~/.ssh`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import * as path from 'node:path';
import { createConnection } from 'node:net';

import type { RemoteConfig } from '../../src/execution/ssh.ts';
import { defaultRemoteConfig } from '../../src/execution/ssh.ts';

/** Value that must never appear in any sink (alpha.3 §16). */
export const REMOTE_CANARY = 'REMOTE_CANARY_SECRET_93af2b7c load-bearing';

/** Where the canary lives on the remote, deliberately outside the workspace. */
export const CANARY_BASENAME = '.agent-test-secret';

export interface SshFixture {
  /** Remote config pointing at whichever target is in use. */
  remote: RemoteConfig;
  /** Absolute remote path of the workspace root. */
  workspace: string;
  /** Absolute remote path of the out-of-workspace canary file. */
  canaryPath: string;
  /** Human-readable target description for the evidence artifact. */
  description: string;
  /** True when this is a loopback sshd rather than a real remote host. */
  loopback: boolean;
  /** Remote OS and OpenSSH version, recorded in the evidence artifact. */
  facts(): Promise<{ os: string; sshd: string; client: string }>;
  /** Run a raw command on the remote, outside the kernel. Setup/assertions only. */
  raw(script: string): Promise<{ stdout: string; stderr: string; code: number | null }>;
  cleanup(): Promise<void>;
}

/** Reason the SSH suite cannot run here, or undefined when it can. */
export function sshUnavailable(): string | undefined {
  if (process.env.KERNEL_SSH_REMOTE) return undefined;
  if (process.platform === 'win32') return 'the loopback sshd fixture is POSIX-only';
  if (which('ssh') === undefined) return 'no ssh client on PATH';
  if (sshdBinary() === undefined) return 'no sshd binary found';
  return undefined;
}

function which(bin: string): string | undefined {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  const out = r.stdout.trim();
  return out === '' ? undefined : out;
}

function sshdBinary(): string | undefined {
  // `sshd` is normally in sbin, which is often absent from a non-root PATH.
  for (const candidate of ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/sbin/sshd']) {
    const r = spawnSync(candidate, ['-?'], { encoding: 'utf8' });
    // `-?` is not a real flag; a binary that exists answers with usage on
    // stderr rather than failing to spawn.
    if (r.error === undefined) return candidate;
  }
  return which('sshd');
}

/**
 * Resolve the target.
 *
 * `KERNEL_SSH_REMOTE=<ssh-alias>` plus `KERNEL_SSH_WORKSPACE=<abs path>` runs
 * the whole matrix against a real host, using the user's own `~/.ssh/config`
 * for credentials — the kernel never reads a private key, which is the §13
 * rule. Absent those, a loopback sshd is started.
 */
export async function startSshFixture(): Promise<SshFixture> {
  const alias = process.env.KERNEL_SSH_REMOTE;
  return alias ? await realRemote(alias) : await loopbackSshd();
}

// --- a real remote ---------------------------------------------------------

async function realRemote(alias: string): Promise<SshFixture> {
  const workspace = process.env.KERNEL_SSH_WORKSPACE;
  if (!workspace || !workspace.startsWith('/')) {
    throw new Error('KERNEL_SSH_REMOTE requires KERNEL_SSH_WORKSPACE to be an absolute remote path');
  }

  const remote = defaultRemoteConfig('alpha3-validation', alias, workspace);
  const canaryPath = `${homeOf(workspace)}/${CANARY_BASENAME}`;

  const fixture: SshFixture = {
    remote,
    workspace,
    canaryPath,
    description: `real remote host via ssh alias "${alias}"`,
    loopback: false,
    facts: () => gatherFacts(fixture),
    raw: (script) => rawSsh(alias, script, []),
    async cleanup() {
      // Only what this suite created. A real host is the user's, and removing
      // anything else from it would be an overreach.
      await rawSsh(alias, `rm -f ${shq(canaryPath)}; rm -rf ${shq(workspace)}/*`, []);
    },
  };

  await fixture.raw(`mkdir -p ${shq(workspace)}`);
  await fixture.raw(`umask 077; printf '%s\\n' ${shq(REMOTE_CANARY)} > ${shq(canaryPath)}`);
  return fixture;
}

/** `/home/x/workspaces/w` → `/home/x`; best-effort parent for the canary. */
function homeOf(workspace: string): string {
  const parts = workspace.split('/').filter(Boolean);
  return parts.length > 1 ? `/${parts.slice(0, 2).join('/')}` : '/tmp';
}

// --- a loopback sshd -------------------------------------------------------

async function loopbackSshd(): Promise<SshFixture> {
  const sshd = sshdBinary();
  if (!sshd) throw new Error('no sshd binary found');

  const base = await mkdtemp(path.join(tmpdir(), 'kernel-sshd-'));
  const workspace = path.join(base, 'remote-home', 'workspaces', 'kernel-ssh-fixture');
  const remoteHome = path.join(base, 'remote-home');
  const canaryPath = path.join(remoteHome, CANARY_BASENAME);

  await mkdir(workspace, { recursive: true });
  await writeFile(canaryPath, `${REMOTE_CANARY}\n`, 'utf8');
  await chmod(canaryPath, 0o600);

  const hostKey = path.join(base, 'host_ed25519');
  const clientKey = path.join(base, 'client_ed25519');
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-f', hostKey, '-N', '', '-C', 'kernel-test-host']);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-f', clientKey, '-N', '', '-C', 'kernel-test-client']);

  const authorized = path.join(base, 'authorized_keys');
  await writeFile(authorized, await readText(`${clientKey}.pub`), 'utf8');
  await chmod(authorized, 0o600);
  await chmod(hostKey, 0o600);
  await chmod(clientKey, 0o600);

  const port = await freePort();
  const configPath = path.join(base, 'sshd_config');
  const logPath = path.join(base, 'sshd.log');

  // Deliberately mirrors the security posture the backend assumes it is talking
  // to: no agent forwarding, no password auth, no root. If a future change to
  // the backend started depending on one of these being *on*, the suite fails
  // here rather than silently passing against a permissive server.
  await writeFile(
    configPath,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey}`,
      `AuthorizedKeysFile ${authorized}`,
      `PidFile ${path.join(base, 'sshd.pid')}`,
      // The temp tree is 0700-ish but not owned the way sshd wants for a real
      // home; StrictModes would refuse to read authorized_keys.
      'StrictModes no',
      'UsePAM no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes',
      'PermitRootLogin no',
      'AllowAgentForwarding no',
      'AllowTcpForwarding no',
      'X11Forwarding no',
      'PermitUserEnvironment no',
      // No `AcceptEnv` line at all: accepting nothing is sshd's default, and
      // the directive requires at least one pattern, so writing `AcceptEnv`
      // with an empty argument is a config *error* rather than a stricter
      // setting. This is the server half of the §17 assertion; the client half
      // is `SendEnv=` on the backend's command line.
      'LogLevel VERBOSE',
      '',
    ].join('\n'),
    'utf8',
  );

  const proc = spawn(sshd, ['-f', configPath, '-E', logPath, '-D'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // lint-allow no-ambient-env-spawn: this is the fixture *server*, standing in
    // for a machine we do not own, not a kernel-spawned child. Scrubbing it
    // would weaken the §17 test rather than strengthen it: the assertion is that
    // host variables do not cross the connection, which is only meaningful if
    // the far side would have accepted them.
    env: process.env,
  });

  let stderr = '';
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (c: string) => {
    stderr += c;
  });

  const ready = await waitForPort(port, 5_000);
  if (!ready) {
    proc.kill('SIGKILL');
    // sshd writes config errors to the `-E` log, not to stderr, so a failure
    // reported without the log body says only "it did not start".
    let log = '';
    try {
      log = await readText(logPath);
    } catch {
      log = '(no log file)';
    }
    await rm(base, { recursive: true, force: true });
    throw new Error(
      `sshd did not start on 127.0.0.1:${port}\n  stderr: ${stderr.slice(0, 400)}\n  log: ${log.slice(0, 800)}`,
    );
  }

  const knownHosts = path.join(base, 'known_hosts');
  // Pre-seed known_hosts from the host key we generated, rather than connecting
  // once with StrictHostKeyChecking=no. The backend passes
  // `StrictHostKeyChecking=yes` unconditionally, so the very first kernel
  // connection has to succeed against a *pre-trusted* key — which is the real
  // deployment shape, and is what makes the host-key-mismatch case meaningful.
  await writeFile(knownHosts, `[127.0.0.1]:${port} ${(await readText(`${hostKey}.pub`)).trim()}\n`, 'utf8');

  // A dedicated ssh_config so the client uses this fixture's identity and
  // known_hosts and nothing from the developer's own ~/.ssh.
  const sshConfig = path.join(base, 'ssh_config');
  const alias = 'kernel-ssh-fixture';
  await writeFile(
    sshConfig,
    [
      `Host ${alias}`,
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  User ${userInfo().username}`,
      `  IdentityFile ${clientKey}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${knownHosts}`,
      '  GlobalKnownHostsFile /dev/null',
      '',
    ].join('\n'),
    'utf8',
  );

  // `-F <file>` is prepended to every invocation. This is also the mechanism a
  // real deployment uses: the kernel names an alias and OpenSSH resolves it.
  const extraArgs = ['-F', sshConfig];

  const remote: RemoteConfig = {
    ...defaultRemoteConfig('alpha3-loopback', alias, workspace),
    sshConfigFile: sshConfig,
  };

  const fixture: SshFixture = {
    remote,
    workspace,
    canaryPath,
    description: `loopback OpenSSH sshd on 127.0.0.1:${port} (NOT a remote VPS)`,
    loopback: true,
    facts: () => gatherFacts(fixture),
    raw: (script) => rawSsh(alias, script, extraArgs),
    async cleanup() {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 150));
      proc.kill('SIGKILL');
      await rm(base, { recursive: true, force: true });
    },
  };

  return fixture;
}

// --- helpers ---------------------------------------------------------------

async function gatherFacts(fixture: SshFixture): Promise<{ os: string; sshd: string; client: string }> {
  const os = await fixture.raw('uname -sr');
  // `sshd -V` on modern OpenSSH, falling back to the usage banner that older
  // builds print for an unknown flag. Wrapped in `sh -c` with everything
  // quoted: the remote *login* shell may be zsh, where a bare `-?` is a glob
  // that matches nothing and aborts the command before sshd runs at all.
  const sshd = await fixture.raw(
    `sh -c 'for b in /usr/sbin/sshd sshd; do "$b" -V 2>&1 | head -1 && exit 0; done; echo unknown'`,
  );
  const client = spawnSync('ssh', ['-V'], { encoding: 'utf8' });
  return {
    os: os.stdout.trim() || 'unknown',
    sshd: sshd.stdout.trim() || sshd.stderr.trim() || 'unknown',
    client: (client.stderr || client.stdout).trim(),
  };
}

function rawSsh(
  alias: string,
  script: string,
  extraArgs: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      'ssh',
      [...extraArgs, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', alias, '--', script],
      // lint-allow no-ambient-env-spawn: fixture setup and out-of-band
      // assertions, run as the *user* would run them. Against a real VPS this
      // needs HOME and SSH_AUTH_SOCK to resolve the alias and the key. Nothing
      // the kernel does goes through here.
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.on('error', (e) => resolve({ stdout: '', stderr: String(e), code: -1 }));
  });
}

function run(bin: string, args: string[]): void {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed: ${r.stderr}`);
}

async function readText(file: string): Promise<string> {
  return (await import('node:fs/promises')).readFile(file, 'utf8');
}

/** An ephemeral port the OS has just told us is free. */
async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** POSIX single-quote escaping, for the fixture's own setup commands. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
