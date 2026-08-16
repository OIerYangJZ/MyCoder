/**
 * SSH ExecutionBackend (spec §19).
 *
 * v0.1 keeps the kernel local and uses OpenSSH as the transport (§19.1). The
 * model is still called from the local process; remote bytes pass through the
 * same secret and egress policy on the way into context.
 *
 * Security defaults are not options (§19.3):
 *   ForwardAgent=no          — agent forwarding is hard-denied everywhere
 *   SendEnv (nothing)        — the host's environment never crosses
 *   StrictHostKeyChecking=yes— a changed host key stops the session
 *   BatchMode=yes            — no interactive password prompt inside a tool call
 *   no default root login
 *   remote workspace jail
 *
 * Every one of those is passed explicitly on the command line, so a permissive
 * `~/.ssh/config` cannot quietly relax them.
 *
 * `agentd` (v0.2+) will replace the transport without changing this interface.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { kernelError, KernelErrorException } from '../util/errors.ts';
import { fingerprint } from '../util/ids.ts';
import { normalizeUnicode, toPosix, type CanonicalPath } from '../util/paths.ts';
import { createLogger, type Logger } from '../util/logger.ts';
import { scrubEnv } from '../security/env-scrub.ts';
import type { Redactor } from '../security/redactor.ts';
import { sshEnforcement, summarizeEnforcement } from './enforcement.ts';
import type {
  BackendKind,
  CapabilityExecutor,
  CapabilityProfile,
  DirEntry,
  EnvironmentDescriptor,
  ExecutionBackend,
  FileStat,
  FileSystemBackend,
  ProcessBackend,
  ProcessResult,
  ProcessSpec,
  RemoveOptions,
  WriteOptions,
} from './backend.ts';

export interface RemoteConfig {
  name: string;
  /** OpenSSH host alias. Credentials live in ~/.ssh/config, never in a project. */
  host: string;
  /**
   * An explicit `ssh_config` to resolve the alias from, instead of `~/.ssh/config`.
   *
   * User configuration only, like every other field here — a project that could
   * name a config file could name one it also ships. It cannot weaken anything:
   * the security options below are passed as command-line `-o`, and OpenSSH
   * takes the first value it obtains, so a config file that sets
   * `ForwardAgent yes` loses to the `-o ForwardAgent=no` already on the line.
   */
  sshConfigFile?: string;
  workspace: string;
  profile?: string;
  strictHostKeyChecking?: boolean;
  forwardAgent?: boolean;
  forwardEnv?: string[];
  controlMaster?: boolean;
  user?: string;
  port?: number;
  connectTimeoutSec?: number;
}

/**
 * The `sun_path` ceiling for a unix domain socket.
 *
 * 104 on macOS, 108 on Linux; the smaller is used everywhere so a path that
 * works on one platform is not a surprise failure on the other.
 */
const CONTROL_PATH_MAX = 104;

/**
 * Would this ControlPath fit in a unix domain socket?
 *
 * Exported so the limit has a regression test that runs everywhere. Without one
 * the property is only checked incidentally, on macOS, where `os.tmpdir()`
 * happens to be long enough to break it — a Linux-only CI run would not notice
 * the socket being moved back under `tmpdir()` with a `%C` suffix.
 */
export function controlPathFits(candidate: string): boolean {
  return Buffer.byteLength(candidate) < CONTROL_PATH_MAX;
}

/**
 * How long to let stdout drain after the ssh client exits.
 *
 * Long enough for a local pipe to flush what has already been written, short
 * enough that a cancelled command still returns promptly.
 */
const PIPE_DRAIN_MS = 100;

export function defaultRemoteConfig(name: string, host: string, workspace: string): RemoteConfig {
  return {
    name,
    host,
    workspace,
    strictHostKeyChecking: true,
    forwardAgent: false,
    forwardEnv: [],
    controlMaster: true,
    connectTimeoutSec: 15,
  };
}

/**
 * Build the ssh argv.
 *
 * `ForwardAgent=no` and an empty `SendEnv` are emitted unconditionally: spec
 * §11.3 lists agent forwarding as hard-denied, so `forwardAgent: true` in a
 * config file is refused here rather than honoured.
 */
export function buildSshArgs(config: RemoteConfig, controlPath: string | undefined): string[] {
  const args: string[] = [
    // `-F` first so it is unmistakably subordinate to the `-o` options that
    // follow: OpenSSH keeps the first value it obtains for any option, and
    // command-line `-o` is obtained before the file is read.
    ...(config.sshConfigFile ? ['-F', config.sshConfigFile] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    // Never negotiable. A config that asks for forwarding is rejected at load.
    'ForwardAgent=no',
    '-o',
    `StrictHostKeyChecking=${config.strictHostKeyChecking === false ? 'accept-new' : 'yes'}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    `ConnectTimeout=${config.connectTimeoutSec ?? 15}`,
    // Clear the SendEnv list so a system-wide or user ssh_config cannot add to
    // it. `-*` is the negation syntax OpenSSH documents for exactly this; the
    // obvious-looking `SendEnv=` is a *syntax error* — "no argument after
    // keyword sendenv" — which aborts the connection before it is attempted.
    // That is not a theoretical distinction: it is what the first run against a
    // real OpenSSH server found, and it meant the SSH backend could not
    // connect to any real host at all.
    '-o',
    'SendEnv=-*',
  ];

  if (config.controlMaster !== false && controlPath) {
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=120');
  }
  if (config.port) args.push('-p', String(config.port));

  const target = config.user ? `${config.user}@${config.host}` : config.host;
  args.push(target);
  return args;
}

/** Reject a remote configuration that asks for something permanently denied. */
export function validateRemoteConfig(config: RemoteConfig): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (config.forwardAgent === true) {
    problems.push('forward_agent = true is not permitted: SSH agent forwarding is hard-denied.');
  }
  if ((config.forwardEnv?.length ?? 0) > 0) {
    problems.push(
      `forward_env is not permitted (${config.forwardEnv!.join(', ')}): host environment is never forwarded.`,
    );
  }
  if (config.user === 'root') {
    problems.push('user = "root" is not permitted by default; connect as an unprivileged user.');
  }
  if (config.strictHostKeyChecking === false) {
    problems.push('strict_host_key_checking = false is not permitted.');
  }
  if (!config.workspace.startsWith('/')) {
    problems.push('workspace must be an absolute remote path.');
  }
  return { ok: problems.length === 0, problems };
}

/** POSIX single-quote escaping for a remote command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function quoteArgv(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

class SshTransport {
  private readonly config: RemoteConfig;
  private readonly logger: Logger;
  private readonly redactor: Redactor;
  private controlPath: string | undefined;

  constructor(config: RemoteConfig, redactor: Redactor, logger: Logger) {
    this.config = config;
    this.redactor = redactor;
    this.logger = logger;
  }

  /**
   * Prepare the connection-multiplexing socket, if it will fit.
   *
   * A ControlPath is a **unix domain socket path**, and `sun_path` is 104 bytes
   * on macOS and 108 on Linux. That limit is easy to blow through without
   * noticing: `os.tmpdir()` on macOS is `/var/folders/<2>/<28>/T`, roughly 50
   * characters before anything of ours is added, and `%C` expands to a 40-hex
   * digest rather than the two characters it looks like. The combination was
   * over the limit, so `ssh` refused every connection with "ControlPath too
   * long" — which the backend reported as `REMOTE_UNAVAILABLE`, i.e. as though
   * the *host* were the problem.
   *
   * Two changes. The directory is `/tmp` where that exists, because it is short
   * and universally present; and the filename is a fixed two characters instead
   * of `%C`, which is safe because `mkdtemp` has already made the directory
   * unique per transport instance — `%C` exists to disambiguate a shared
   * directory, which this is not.
   *
   * If it still does not fit, multiplexing is dropped rather than the
   * connection. Losing connection reuse costs a handshake per command; losing
   * the connection costs the session.
   */
  async init(): Promise<void> {
    if (this.config.controlMaster === false) return;

    const base = existsSync('/tmp') ? '/tmp' : tmpdir();
    const dir = await mkdtemp(path.join(base, 'agent-ssh-'));
    const candidate = path.join(dir, 'cm');

    if (!controlPathFits(candidate)) {
      this.logger.debug('ssh multiplexing disabled: control path would exceed the socket limit', {
        length: Buffer.byteLength(candidate),
        limit: CONTROL_PATH_MAX,
      });
      return;
    }
    this.controlPath = candidate;
  }

  /**
   * Run a remote shell snippet.
   *
   * The snippet is always wrapped in `env -i` plus explicit assignments, so the
   * remote login environment is replaced rather than inherited — the remote
   * equivalent of `scrubEnv`.
   */
  async run(
    script: string,
    opts: { env?: Record<string, string>; timeoutMs: number; stdin?: string; maxOutputBytes?: number },
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const assignments = Object.entries(opts.env ?? {})
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(' ');
    const remote = `env -i ${assignments} sh -c ${shellQuote(script)}`;
    const argv = [...buildSshArgs(this.config, this.controlPath), '--', remote];

    const started = Date.now();
    const maxBytes = opts.maxOutputBytes ?? 8 * 1024 * 1024;

    return new Promise<ProcessResult>((resolve, reject) => {
      // The local `ssh` process itself gets a scrubbed environment, so host
      // credentials cannot leak into it either.
      const localEnv = scrubEnv({ allow: ['SSH_ASKPASS', 'DISPLAY'] }).env;
      const child = spawn('ssh', argv, { env: localEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, opts.timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        if (stdout.length + c.length <= maxBytes) stdout += c;
        else truncated = true;
      });
      child.stderr.on('data', (c: string) => {
        if (stderr.length + c.length <= maxBytes) stderr += c;
        else truncated = true;
      });

      child.stdin.end(opts.stdin ?? '');

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(
          new KernelErrorException(
            kernelError('REMOTE_UNAVAILABLE', `Could not start ssh: ${err.message}`, {
              blame: 'environment',
            }),
          ),
        );
      });

      let drainTimer: NodeJS.Timeout | undefined;

      const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        signal?.removeEventListener('abort', onAbort);

        // A host key problem must be a distinct, non-retryable failure.
        if (/host key verification failed|remote host identification has changed/i.test(stderr)) {
          reject(
            new KernelErrorException(
              kernelError(
                'REMOTE_HOST_KEY_ERROR',
                `Host key verification failed for "${this.config.host}". The session was not established.`,
                { blame: 'environment', retryable: false, safeDetails: { remote: this.config.name } },
              ),
            ),
          );
          return;
        }

        resolve({
          stdout: this.redactor.redact(stdout),
          stderr: this.redactor.redact(stderr),
          exitCode: code,
          signal: sig,
          timedOut,
          durationMs: Date.now() - started,
          outputTruncated: truncated,
        });
      };

      /**
       * Settle once the ssh client is gone, without waiting for its pipes.
       *
       * `close` fires only when every stdio stream has ended, and with
       * `ControlMaster` the persisted master process holds duplicates of those
       * descriptors for its whole `ControlPersist` window. The practical effect,
       * measured against a real sshd: killing the client on timeout or on
       * cancellation left this promise pending until the *remote* command
       * finished on its own — 20 seconds for a `sleep 20` that was supposed to
       * be abandoned after 1.5. `timedOut` was set correctly the entire time;
       * nothing was listening yet. Since multiplexing is on by default, that
       * applied to essentially every remote command.
       *
       * `exit` is therefore the authoritative signal — the client is gone and
       * will write nothing further — and `close` is an optimisation that
       * usually arrives first. The short grace period after `exit` lets a normal
       * run's last buffered chunk land before the result is assembled.
       */
      child.on('exit', (code, sig) => {
        if (settled || drainTimer) return;
        drainTimer = setTimeout(() => finish(code, sig), PIPE_DRAIN_MS);
        // Never hold the event loop open just to wait for a drain.
        drainTimer.unref?.();
      });

      child.on('close', (code, sig) => finish(code, sig));
    });
  }

  async close(): Promise<void> {
    if (!this.controlPath) return;
    try {
      await this.run('true', { timeoutMs: 5_000 });
    } catch {
      // Best effort; ControlPersist expires on its own.
    }
    this.logger.debug('ssh control master released');
  }
}

/** Remote filesystem, implemented with small POSIX snippets. */
class SshFileSystem implements FileSystemBackend {
  private readonly transport: SshTransport;
  private readonly workspace: string;

  constructor(transport: SshTransport, workspace: string) {
    this.transport = transport;
    this.workspace = workspace;
  }

  private jail(p: CanonicalPath): string {
    const posix = toPosix(p);
    if (posix !== this.workspace && !posix.startsWith(`${this.workspace}/`)) {
      throw new KernelErrorException(
        kernelError('PATH_OUTSIDE_WORKSPACE', 'Remote path is outside the remote workspace.', {
          blame: 'kernel',
          safeDetails: { workspace: this.workspace },
        }),
      );
    }
    if (posix.includes('..')) {
      throw new KernelErrorException(
        kernelError('PATH_OUTSIDE_WORKSPACE', 'Remote path contains a traversal segment.', {
          blame: 'model',
        }),
      );
    }
    return posix;
  }

  async readFile(p: CanonicalPath): Promise<Buffer> {
    const target = this.jail(p);
    // base64 keeps binary content intact across the text channel.
    const result = await this.transport.run(`base64 < ${shellQuote(target)}`, { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      throw new KernelErrorException(
        kernelError('TOOL_FAILED', `Could not read remote file.`, {
          blame: 'environment',
          safeDetails: { detail: result.stderr.trim().slice(0, 200) },
        }),
      );
    }
    return Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64');
  }

  async writeFileAtomic(p: CanonicalPath, data: Buffer, opts: WriteOptions = {}): Promise<void> {
    const target = this.jail(p);
    const tmp = `${target}.agent-tmp.$$`;
    const script =
      (opts.createParents ? `mkdir -p "$(dirname ${shellQuote(target)})" && ` : '') +
      `base64 -d > ${shellQuote(tmp)} && ` +
      // Same-directory temp file, then rename: atomic on the remote filesystem
      // for the same reasons it is locally.
      `mv -f ${shellQuote(tmp)} ${shellQuote(target)}`;

    const result = await this.transport.run(script, {
      timeoutMs: 60_000,
      stdin: data.toString('base64'),
    });
    if (result.exitCode !== 0) {
      // Clean up the temp file so a failed write leaves nothing behind.
      await this.transport.run(`rm -f ${shellQuote(tmp)}`, { timeoutMs: 10_000 }).catch(() => {});
      throw new KernelErrorException(
        kernelError('TOOL_FAILED', 'Could not write the remote file.', {
          blame: 'environment',
          safeDetails: { detail: result.stderr.trim().slice(0, 200) },
        }),
      );
    }
  }

  async stat(p: CanonicalPath): Promise<FileStat | undefined> {
    let target: string;
    try {
      target = this.jail(p);
    } catch {
      return undefined;
    }
    // GNU stat first, BSD stat second: covers Linux and macOS remotes.
    const script =
      `P=${shellQuote(target)}; ` +
      `if [ -e "$P" ] || [ -L "$P" ]; then ` +
      `S=$(stat -c '%s %Y' "$P" 2>/dev/null || stat -f '%z %m' "$P" 2>/dev/null); ` +
      `printf '%s %s %s %s\\n' "$S" "$([ -f "$P" ] && echo 1 || echo 0)" ` +
      `"$([ -d "$P" ] && echo 1 || echo 0)" "$([ -L "$P" ] && echo 1 || echo 0)"; fi`;

    const result = await this.transport.run(script, { timeoutMs: 20_000 });
    const line = result.stdout.trim();
    if (result.exitCode !== 0 || line === '') return undefined;

    const [size, mtime, isFile, isDir, isLink] = line.split(/\s+/);
    return {
      path: p,
      size: Number.parseInt(size ?? '0', 10) || 0,
      mtimeMs: (Number.parseInt(mtime ?? '0', 10) || 0) * 1000,
      isFile: isFile === '1',
      isDirectory: isDir === '1',
      isSymlink: isLink === '1',
    };
  }

  async listDir(p: CanonicalPath): Promise<DirEntry[]> {
    const target = this.jail(p);
    const script =
      `cd ${shellQuote(target)} 2>/dev/null || exit 1; ` +
      `for f in * .[!.]* ..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; ` +
      `printf '%s\\t%s\\t%s\\n' "$f" "$([ -d "$f" ] && echo 1 || echo 0)" "$([ -L "$f" ] && echo 1 || echo 0)"; done`;

    const result = await this.transport.run(script, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) return [];

    return result.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((line) => {
        const [name, isDir, isLink] = line.split('\t');
        return {
          name: normalizeUnicode(name ?? ''),
          isDirectory: isDir === '1',
          isSymlink: isLink === '1',
        };
      });
  }

  async mkdirp(p: CanonicalPath): Promise<void> {
    const target = this.jail(p);
    await this.transport.run(`mkdir -p ${shellQuote(target)}`, { timeoutMs: 20_000 });
  }

  async realpath(p: CanonicalPath): Promise<CanonicalPath | undefined> {
    const target = toPosix(p);
    const script =
      `P=${shellQuote(target)}; ` +
      `if command -v readlink >/dev/null && readlink -f "$P" 2>/dev/null; then :; ` +
      `else D=$(dirname "$P"); B=$(basename "$P"); (cd "$D" 2>/dev/null && printf '%s/%s\\n' "$(pwd -P)" "$B"); fi`;

    const result = await this.transport.run(script, { timeoutMs: 20_000 });
    const line = result.stdout.trim().split('\n')[0];
    return line && line !== '' ? (line as CanonicalPath) : undefined;
  }

  async remove(p: CanonicalPath, opts: RemoveOptions = {}): Promise<void> {
    const target = this.jail(p);
    // `rmdir` rather than `rm -r`, and `rm` without `-r` for the file case: the
    // remote side must not be able to do something the local backend cannot
    // (ADR-0016 refuses recursive removal), and `-f` is omitted so that deleting
    // a path that is already gone is an error rather than a quiet success.
    const script = opts.directory ? `rmdir ${shellQuote(target)}` : `rm ${shellQuote(target)}`;
    const result = await this.transport.run(script, { timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
      throw new KernelErrorException(
        kernelError('TOOL_FAILED', 'Could not remove the remote path.', {
          blame: 'environment',
          safeDetails: { detail: result.stderr.trim().slice(0, 200) },
        }),
      );
    }
  }

  async rename(from: CanonicalPath, to: CanonicalPath): Promise<void> {
    const source = this.jail(from);
    const dest = this.jail(to);
    // `mv -n` is not POSIX and is a no-op *with exit status 0* on some BSD
    // versions when the destination exists, which would report a move that did
    // not happen. Test first, in the same shell, and use a distinct exit code so
    // the two failures are distinguishable.
    const script =
      `if [ -e ${shellQuote(dest)} ] || [ -L ${shellQuote(dest)} ]; then exit 3; fi; ` +
      `mv ${shellQuote(source)} ${shellQuote(dest)}`;
    const result = await this.transport.run(script, { timeoutMs: 30_000 });
    if (result.exitCode === 3) {
      throw new KernelErrorException(
        kernelError('TOOL_FAILED', 'The destination already exists.', { blame: 'model' }),
      );
    }
    if (result.exitCode !== 0) {
      throw new KernelErrorException(
        kernelError('TOOL_FAILED', 'Could not move the remote path.', {
          blame: 'environment',
          safeDetails: { detail: result.stderr.trim().slice(0, 200) },
        }),
      );
    }
  }
}

class SshProcess implements ProcessBackend {
  private readonly transport: SshTransport;
  private readonly workspace: string;

  constructor(transport: SshTransport, workspace: string) {
    this.transport = transport;
    this.workspace = workspace;
  }

  async exec(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessResult> {
    const cwd = toPosix(spec.cwd);
    if (cwd !== this.workspace && !cwd.startsWith(`${this.workspace}/`)) {
      throw new KernelErrorException(
        kernelError('PATH_OUTSIDE_WORKSPACE', 'Remote working directory is outside the workspace jail.', {
          blame: 'model',
        }),
      );
    }
    const script = `cd ${shellQuote(cwd)} && exec ${quoteArgv(spec.argv)}`;
    return this.transport.run(
      script,
      {
        env: spec.env,
        timeoutMs: spec.timeoutMs,
        ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
        ...(spec.maxOutputBytes !== undefined ? { maxOutputBytes: spec.maxOutputBytes } : {}),
      },
      signal,
    );
  }
}

class SshExecutor implements CapabilityExecutor {
  readonly profile: CapabilityProfile;
  readonly environment: EnvironmentDescriptor;
  readonly fs: FileSystemBackend;

  private readonly processBackend: ProcessBackend;
  private disposed = false;

  constructor(
    profile: CapabilityProfile,
    environment: EnvironmentDescriptor,
    fs: FileSystemBackend,
    processBackend: ProcessBackend,
  ) {
    this.profile = profile;
    this.environment = environment;
    this.fs = fs;
    this.processBackend = processBackend;
  }

  async exec(
    spec: Omit<ProcessSpec, 'env'> & { env?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    if (this.disposed) throw new KernelErrorException(kernelError('INTERNAL_ERROR', 'executor disposed'));
    if (!this.profile.allowExec) {
      throw new KernelErrorException(
        kernelError('TOOL_DENIED', 'This execution was not granted permission to run processes.', {
          blame: 'kernel',
        }),
      );
    }

    // The remote environment is built from scratch, exactly as it is locally.
    const env = scrubEnv({
      source: {},
      allow: this.profile.envAllow,
      cwd: spec.cwd,
    }).env;
    for (const injection of this.profile.secretInjections) injection.lease.injectInto(env, injection.envName);

    return this.processBackend.exec(
      {
        argv: spec.argv,
        cwd: spec.cwd,
        env,
        timeoutMs: spec.timeoutMs ?? this.profile.timeoutMs,
        ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
        maxOutputBytes: spec.maxOutputBytes ?? this.profile.maxOutputBytes,
      },
      signal,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const injection of this.profile.secretInjections) injection.lease.release();
  }
}

export interface SshBackendOptions {
  config: RemoteConfig;
  redactor: Redactor;
  logger?: Logger;
}

export class SshExecutionBackend implements ExecutionBackend {
  readonly id: string;
  readonly kind: BackendKind = 'ssh';
  readonly fs: FileSystemBackend;
  readonly process: ProcessBackend;
  readonly environment: EnvironmentDescriptor;

  private readonly transport: SshTransport;
  private readonly config: RemoteConfig;

  private constructor(
    config: RemoteConfig,
    transport: SshTransport,
    hasRipgrep: boolean,
    hasGit: boolean,
    homeDir: string,
    hostIdentity: string,
  ) {
    this.config = config;
    this.id = `ssh:${config.name}`;
    this.transport = transport;
    this.fs = new SshFileSystem(transport, config.workspace);
    this.process = new SshProcess(transport, config.workspace);
    this.environment = {
      platform: 'remote-posix',
      kind: 'ssh',
      workspaceRoot: config.workspace as CanonicalPath,
      // The remote's real `$HOME`, probed at connect. It used to be reported as
      // the workspace, which is a different directory and made every consumer
      // of `homeDir` quietly wrong about the remote.
      homeDir,
      hostIdentity,
      tmpDir: '/tmp',
      hasRipgrep,
      hasGit,
      sandboxStrength: summarizeEnforcement(sshEnforcement(config.host)),
      enforcement: sshEnforcement(config.host),
      description: `ssh ${config.host}:${config.workspace}, policy-enforced (remote jail, no agent or env forwarding)`,
    };
  }

  static async connect(opts: SshBackendOptions): Promise<SshExecutionBackend> {
    const validation = validateRemoteConfig(opts.config);
    if (!validation.ok) {
      throw new KernelErrorException(
        kernelError('REMOTE_UNAVAILABLE', `Remote "${opts.config.name}" is misconfigured.`, {
          blame: 'user',
          retryable: false,
          safeDetails: { problems: validation.problems },
        }),
      );
    }

    const logger = opts.logger ?? createLogger({ scope: 'backend:ssh' });
    const transport = new SshTransport(opts.config, opts.redactor, logger);
    await transport.init();

    // One round trip for everything the descriptor needs. Newline-separated
    // rather than space-separated: `$HOME` and the hostname can contain spaces,
    // and a positional split on whitespace mis-assigns every later field when
    // they do.
    const probe = await transport.run(
      `cd ${shellQuote(opts.config.workspace)} && ` +
        `printf '%s\\n%s\\n%s\\n%s\\n' ` +
        `"$(command -v rg >/dev/null && echo 1 || echo 0)" ` +
        `"$(command -v git >/dev/null && echo 1 || echo 0)" ` +
        `"$HOME" ` +
        `"$(hostname 2>/dev/null)|$(uname -sm 2>/dev/null)|` +
        `$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || true)" ` +
        // The workspace as the *remote* resolves it. A configured path may go
        // through a symlink — `/var/...` is `/private/var/...` on macOS, and
        // `/home` is frequently a link on Linux — and the jail compares against
        // this value while the tool layer canonicalises through the remote. If
        // the two spell the same directory differently, every path is refused as
        // outside the workspace.
        `"$(pwd -P)"`,
      { timeoutMs: 30_000 },
    );

    if (probe.exitCode !== 0) {
      throw new KernelErrorException(
        kernelError(
          'REMOTE_UNAVAILABLE',
          `Could not enter the remote workspace ${opts.config.workspace} on "${opts.config.host}".`,
          { blame: 'environment', safeDetails: { detail: probe.stderr.trim().slice(0, 200) } },
        ),
      );
    }

    const [hasRg, hasGit, remoteHome, rawIdentity, resolvedWorkspace] = probe.stdout
      .split('\n')
      .map((l) => l.trim());

    // Jail against the resolved path, so a symlinked or otherwise non-canonical
    // `workspace` in remotes.toml works instead of refusing everything.
    const effective: RemoteConfig =
      resolvedWorkspace && resolvedWorkspace.startsWith('/') && resolvedWorkspace !== opts.config.workspace
        ? { ...opts.config, workspace: resolvedWorkspace }
        : opts.config;

    if (effective.workspace !== opts.config.workspace) {
      logger.debug('remote workspace resolved through a link', {
        configured: opts.config.workspace,
        resolved: effective.workspace,
      });
    }

    return new SshExecutionBackend(
      effective,
      transport,
      hasRg === '1',
      hasGit === '1',
      remoteHome && remoteHome.startsWith('/') ? remoteHome : opts.config.workspace,
      // Hashed rather than stored raw: it goes into the session metadata, and a
      // hostname plus machine-id is more about the user's infrastructure than
      // anything the event log needs to carry in the clear.
      fingerprint(rawIdentity ?? opts.config.host),
    );
  }

  async enforce(profile: CapabilityProfile): Promise<CapabilityExecutor> {
    return new SshExecutor(profile, this.environment, this.fs, this.process);
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const result = await this.transport.run(`test -d ${shellQuote(this.config.workspace)}`, {
        timeoutMs: 20_000,
      });
      return result.exitCode === 0
        ? { ok: true, detail: this.environment.description }
        : { ok: false, detail: `remote workspace ${this.config.workspace} is not a directory` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : 'remote probe failed' };
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
