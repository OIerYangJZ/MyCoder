/**
 * Local ExecutionBackend (spec §12.2).
 *
 * Implements the v0.1 minimum: canonical paths, workspace jail, env scrub,
 * process timeout, explicit network declaration, output redaction and audit.
 *
 * It is **`policy-enforced`, not `os-isolated`**. A subprocess we launch can
 * still open any file the user can open; what this backend guarantees is that
 * the *kernel* never hands it a path or a credential it was not granted, and
 * that anything it emits is redacted on the way back. `sandboxStrength` says so,
 * and `/status` prints it, because claiming otherwise would violate invariant 5.
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  lstat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

import { kernelError, KernelErrorException } from '../util/errors.ts';
import { isWithin, normalizeUnicode, type CanonicalPath } from '../util/paths.ts';
import { createLogger, type Logger } from '../util/logger.ts';
import { scrubEnv, assertNoCredentialEnv } from '../security/env-scrub.ts';
import type { Redactor } from '../security/redactor.ts';
import { localEnforcement, summarizeEnforcement } from './enforcement.ts';
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
  ProcessSession,
  ProcessSpec,
  RemoveOptions,
  WriteOptions,
} from './backend.ts';

export interface LocalBackendOptions {
  workspaceRoot: CanonicalPath;
  redactor: Redactor;
  logger?: Logger;
  homeDir?: string;
  tmpDir?: string;
  /** Override for tests; normally discovered by probing PATH. */
  hasRipgrep?: boolean;
  hasGit?: boolean;
}

class LocalFileSystem implements FileSystemBackend {
  async readFile(p: CanonicalPath): Promise<Buffer> {
    return readFile(p);
  }

  /**
   * Atomic replace: write a sibling temp file, fsync it, rename over the target.
   *
   * The temp file must be on the same filesystem or `rename` is not atomic,
   * which is why it is a sibling rather than something under /tmp. On failure
   * the temp file is removed, so a crashed edit never leaves a half-written
   * source file (spec §10.2, acceptance §28).
   */
  async writeFileAtomic(p: CanonicalPath, data: Buffer, opts: WriteOptions = {}): Promise<void> {
    const dir = path.dirname(p);
    if (opts.createParents) await mkdir(dir, { recursive: true });

    const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.${Date.now().toString(36)}.tmp`);
    let handle;
    try {
      handle = await open(tmp, 'wx', opts.mode ?? 0o644);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, p);
      // fsync the directory so the rename itself is durable.
      try {
        const dirHandle = await open(dir, 'r');
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
        // Directory fsync is not supported everywhere; the rename still applied.
      }
    } catch (e) {
      if (handle) await handle.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async stat(p: CanonicalPath): Promise<FileStat | undefined> {
    try {
      const [s, ls] = await Promise.all([stat(p), lstat(p)]);
      return {
        path: p,
        size: s.size,
        mtimeMs: s.mtimeMs,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymlink: ls.isSymbolicLink(),
      };
    } catch {
      return undefined;
    }
  }

  async listDir(p: CanonicalPath): Promise<DirEntry[]> {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.map((e) => ({
      name: normalizeUnicode(e.name),
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }));
  }

  async mkdirp(p: CanonicalPath): Promise<void> {
    await mkdir(p, { recursive: true });
  }

  async realpath(p: CanonicalPath): Promise<CanonicalPath | undefined> {
    try {
      return normalizeUnicode(await realpath(p)) as CanonicalPath;
    } catch {
      return undefined;
    }
  }

  async remove(p: CanonicalPath, opts: RemoveOptions = {}): Promise<void> {
    // `unlink` on a symlink removes the link, not its target, which is the
    // behaviour a delete tool wants: the caller canonicalised and got a decision
    // about the target, but destroying the target through a link nobody looked
    // at is not what "delete this path" means.
    if (opts.directory) {
      await rmdir(p);
      return;
    }
    await unlink(p);
  }

  async rename(from: CanonicalPath, to: CanonicalPath): Promise<void> {
    // `rename(2)` overwrites; `link` + `unlink` does not. The link is the check
    // and the move in one operation, so there is no window in which a file
    // created at `to` by something else could be replaced.
    try {
      await link(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new KernelErrorException(
          kernelError('TOOL_FAILED', 'The destination already exists.', {
            blame: 'model',
            safeDetails: { code },
          }),
        );
      }
      // Hard links do not work across filesystems, and not at all for
      // directories. Fall back to rename, which the caller has already checked
      // the destination for.
      if (code === 'EXDEV' || code === 'EPERM' || code === 'EISDIR' || code === 'EACCES') {
        await rename(from, to);
        return;
      }
      throw e;
    }
    await unlink(from);
  }
}

class LocalProcess implements ProcessBackend {
  private readonly redactor: Redactor;
  private readonly logger: Logger;

  constructor(redactor: Redactor, logger: Logger) {
    this.redactor = redactor;
    this.logger = logger;
  }

  /**
   * A long-lived process, for a stdio MCP server (ADR-0022 §2).
   *
   * Present on this backend because it can host one. It is deliberately absent
   * on backends that cannot, so the MCP client refuses them rather than routing
   * around them.
   */
  async session(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessSession> {
    return startLocalSession(spec, this.redactor, signal);
  }

  async exec(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessResult> {
    const [executable, ...args] = spec.argv;
    if (!executable) {
      throw new KernelErrorException(
        kernelError('TOOL_INVALID_ARGS', 'No executable was given.', { blame: 'model' }),
      );
    }

    // Last line of defence before spawn: no credential-shaped variable may be
    // present unless it was deliberately injected as a lease.
    const injected = Object.keys(spec.env).filter((n) => n.startsWith('__injected_'));
    const check = assertNoCredentialEnv(spec.env, injected);
    if (!check.ok) {
      throw new KernelErrorException(
        kernelError(
          'SECRET_ACCESS_DENIED',
          `Refusing to spawn: the prepared environment still contains ${check.offending.length} credential-shaped variable(s).`,
          { blame: 'kernel', safeDetails: { names: check.offending } },
        ),
      );
    }

    const started = Date.now();
    const maxBytes = spec.maxOutputBytes ?? 8 * 1024 * 1024;

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: spec.cwd,
        // NEVER `process.env`. The environment was built by scrubEnv().
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // No shell: argv is passed through directly, so quoting and globbing
        // cannot be turned into command injection.
        shell: false,
        detached: false,
      });

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputTruncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        kill(child, 'SIGTERM');
        // Escalate if the process ignores SIGTERM.
        setTimeout(() => kill(child, 'SIGKILL'), 2_000).unref?.();
      }, spec.timeoutMs);

      const onAbort = (): void => {
        kill(child, 'SIGTERM');
        setTimeout(() => kill(child, 'SIGKILL'), 1_000).unref?.();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes <= maxBytes) stdout += chunk;
        else outputTruncated = true;
      });
      child.stderr.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk, 'utf8');
        if (stderrBytes <= maxBytes) stderr += chunk;
        else outputTruncated = true;
      });

      if (spec.stdin !== undefined) {
        child.stdin.end(spec.stdin);
      } else {
        child.stdin.end();
      }

      const finish = (exitCode: number | null, sig: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);

        // Redaction happens here, before the output can reach any caller — the
        // model, the event log, or the terminal.
        resolve({
          stdout: this.redactor.redact(stdout),
          stderr: this.redactor.redact(stderr),
          exitCode,
          signal: sig,
          timedOut,
          durationMs: Date.now() - started,
          outputTruncated,
        });
      };

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (err.code === 'ENOENT') {
          reject(
            new KernelErrorException(
              kernelError('TOOL_FAILED', `Executable not found: ${executable}`, {
                blame: 'model',
                safeDetails: { executable },
              }),
            ),
          );
          return;
        }
        this.logger.debug('spawn failed', { executable, code: err.code ?? 'unknown' });
        reject(
          new KernelErrorException(
            kernelError('TOOL_FAILED', `Failed to start "${executable}".`, {
              blame: 'environment',
              safeDetails: { executable, code: err.code ?? 'unknown' },
            }),
          ),
        );
      });

      child.on('close', (code, sig) => finish(code, sig));
    });
  }
}

/**
 * A long-lived local process (ADR-0022 §2).
 *
 * Shares `exec()`'s two non-negotiables and adds nothing of its own: the
 * environment must already be scrubbed, and `assertNoCredentialEnv` is the last
 * line before spawn. A stdio MCP server is a subprocess, and "it is
 * infrastructure" is not an exemption from anything alpha.4-alpha.7 established.
 *
 * Note what is **not** redacted here, and why it is safe. `exec()` redacts
 * stdout before returning it, because that output goes to the model. This
 * stream carries JSON-RPC frames that the client parses; redacting mid-frame
 * would corrupt the JSON. Redaction happens instead where the content leaves —
 * `parseCallResult` produces the text and the tool layer labels it, and that
 * result travels the ordinary tool-result path with the ordinary redactor.
 */
export function startLocalSession(
  spec: ProcessSpec,
  redactor: Redactor,
  signal?: AbortSignal,
): Promise<ProcessSession> {
  const [executable, ...args] = spec.argv;
  if (!executable) {
    throw new KernelErrorException(
      kernelError('TOOL_INVALID_ARGS', 'No executable was given.', { blame: 'model' }),
    );
  }

  const injected = Object.keys(spec.env).filter((n) => n.startsWith('__injected_'));
  const check = assertNoCredentialEnv(spec.env, injected);
  if (!check.ok) {
    throw new KernelErrorException(
      kernelError(
        'SECRET_ACCESS_DENIED',
        `Refusing to spawn: the prepared environment still contains ${check.offending.length} credential-shaped variable(s).`,
        { blame: 'kernel', safeDetails: { names: check.offending } },
      ),
    );
  }

  const child = spawn(executable, args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    // A process group, so `kill()` can take the *tree* rather than just the
    // parent — a server that spawned helpers must not leave them behind
    // (alpha.7 §31). `detached` here means "new group", not "outlive us".
    detached: process.platform !== 'win32',
  });

  const maxStderr = spec.maxOutputBytes ?? 256 * 1024;
  let stderr = '';
  let dead = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < maxStderr) stderr += chunk;
  });

  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    const settle = (exitCode: number | null, sig: string | null): void => {
      dead = true;
      resolve({ exitCode, signal: sig });
    };
    child.on('close', (code, sig) => settle(code, sig));
    child.on('error', () => settle(null, null));
  });

  const killTree = async (): Promise<void> => {
    if (dead) return;
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        process.kill(-child.pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }, 2_000).unref?.();
      } else {
        kill(child, 'SIGTERM');
      }
    } catch {
      kill(child, 'SIGTERM');
    }
    await exited;
  };

  signal?.addEventListener('abort', () => void killTree(), { once: true });

  const session: ProcessSession = {
    async write(data: string): Promise<void> {
      if (dead || child.stdin.destroyed) {
        throw new KernelErrorException(
          kernelError('TOOL_FAILED', 'the process is no longer accepting input', {
            blame: 'provider',
          }),
        );
      }
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(data, (err) => (err ? reject(err) : resolve()));
      });
    },

    stdout(): AsyncIterableIterator<string> {
      return child.stdout[Symbol.asyncIterator]() as AsyncIterableIterator<string>;
    },

    stderrSoFar(): string {
      return redactor.redact(stderr);
    },

    exited,

    get alive(): boolean {
      return !dead;
    },

    kill: killTree,
  };

  return Promise.resolve(session);
}

function kill(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/**
 * A `CapabilityExecutor` that re-checks every path against the granted roots.
 *
 * The policy engine already decided; this is the second check, at the point of
 * use, so a bug in a tool cannot turn into a path escape.
 */
class ConstrainedExecutor implements CapabilityExecutor {
  readonly profile: CapabilityProfile;
  readonly environment: EnvironmentDescriptor;
  readonly fs: FileSystemBackend;

  private readonly inner: FileSystemBackend;
  private readonly processBackend: ProcessBackend;
  private readonly homeDir: string;
  private disposed = false;

  constructor(
    profile: CapabilityProfile,
    environment: EnvironmentDescriptor,
    fs: FileSystemBackend,
    processBackend: ProcessBackend,
    homeDir: string,
  ) {
    this.profile = profile;
    this.environment = environment;
    this.inner = fs;
    this.processBackend = processBackend;
    this.homeDir = homeDir;

    const self = this;
    this.fs = {
      async readFile(p) {
        self.assertReadable(p);
        return self.inner.readFile(p);
      },
      async writeFileAtomic(p, data, opts) {
        self.assertWritable(p);
        return self.inner.writeFileAtomic(p, data, opts);
      },
      async stat(p) {
        self.assertReadable(p);
        return self.inner.stat(p);
      },
      async listDir(p) {
        self.assertReadable(p);
        return self.inner.listDir(p);
      },
      async mkdirp(p) {
        self.assertWritable(p);
        return self.inner.mkdirp(p);
      },
      async realpath(p) {
        return self.inner.realpath(p);
      },
      async remove(p, opts) {
        self.assertWritable(p);
        return self.inner.remove(p, opts);
      },
      async rename(from, to) {
        // Both ends. A move is a delete at the source and a create at the
        // destination, and a grant for one is not a grant for the other.
        self.assertWritable(from);
        self.assertWritable(to);
        return self.inner.rename(from, to);
      },
    };
  }

  private assertReadable(p: CanonicalPath): void {
    if (this.profile.readRoots.some((root) => isWithin(root, p))) return;
    throw new KernelErrorException(
      kernelError('PATH_OUTSIDE_WORKSPACE', 'This execution was not granted read access to that path.', {
        blame: 'kernel',
        safeDetails: { grantedRoots: this.profile.readRoots.length },
      }),
    );
  }

  private assertWritable(p: CanonicalPath): void {
    if (this.profile.writeRoots.some((root) => isWithin(root, p))) return;
    throw new KernelErrorException(
      kernelError('PATH_OUTSIDE_WORKSPACE', 'This execution was not granted write access to that path.', {
        blame: 'kernel',
        safeDetails: { grantedRoots: this.profile.writeRoots.length },
      }),
    );
  }

  async exec(
    spec: Omit<ProcessSpec, 'env'> & { env?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    if (this.disposed) {
      throw new KernelErrorException(
        kernelError('INTERNAL_ERROR', 'This executor has already been disposed.'),
      );
    }
    if (!this.profile.allowExec) {
      throw new KernelErrorException(
        kernelError('TOOL_DENIED', 'This execution was not granted permission to run processes.', {
          blame: 'kernel',
        }),
      );
    }
    if (!this.profile.readRoots.some((root) => isWithin(root, spec.cwd))) {
      throw new KernelErrorException(
        kernelError('PATH_OUTSIDE_WORKSPACE', 'The working directory is outside the granted roots.', {
          blame: 'model',
        }),
      );
    }

    const scrub = scrubEnv({
      allow: this.profile.envAllow,
      home: this.homeDir,
      cwd: spec.cwd,
      ...(spec.env ? { extra: spec.env } : {}),
    });

    // Secrets are injected *after* scrubbing, one named slot at a time.
    for (const injection of this.profile.secretInjections) {
      injection.lease.injectInto(scrub.env, injection.envName);
    }

    return this.processBackend.exec(
      {
        argv: spec.argv,
        cwd: spec.cwd,
        env: scrub.env,
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

export class LocalExecutionBackend implements ExecutionBackend {
  readonly id = 'local';
  readonly kind: BackendKind = 'local';
  readonly fs: FileSystemBackend;
  readonly process: ProcessBackend;
  readonly environment: EnvironmentDescriptor;

  private readonly logger: Logger;
  private readonly homeDir: string;

  constructor(opts: LocalBackendOptions) {
    this.logger = opts.logger ?? createLogger({ scope: 'backend:local' });
    this.homeDir = opts.homeDir ?? homedir();
    this.fs = new LocalFileSystem();
    this.process = new LocalProcess(opts.redactor, this.logger);
    const enforcement = localEnforcement();
    this.environment = {
      platform: process.platform,
      kind: 'local',
      workspaceRoot: opts.workspaceRoot,
      homeDir: this.homeDir,
      tmpDir: opts.tmpDir ?? tmpdir(),
      hasRipgrep: opts.hasRipgrep ?? false,
      hasGit: opts.hasGit ?? false,
      sandboxStrength: summarizeEnforcement(enforcement),
      enforcement,
      description: 'local process execution, policy-enforced (no OS isolation)',
    };
  }

  /** Discover optional tooling once, at startup. */
  static async detect(opts: LocalBackendOptions): Promise<LocalExecutionBackend> {
    const [hasRipgrep, hasGit] = await Promise.all([onPath('rg'), onPath('git')]);
    return new LocalExecutionBackend({
      ...opts,
      hasRipgrep: opts.hasRipgrep ?? hasRipgrep,
      hasGit: opts.hasGit ?? hasGit,
    });
  }

  async enforce(profile: CapabilityProfile): Promise<CapabilityExecutor> {
    return new ConstrainedExecutor(profile, this.environment, this.fs, this.process, this.homeDir);
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const s = await this.fs.stat(this.environment.workspaceRoot);
    if (!s?.isDirectory) {
      return { ok: false, detail: `Workspace root is not a directory: ${this.environment.workspaceRoot}` };
    }
    return { ok: true, detail: this.environment.description };
  }

  async close(): Promise<void> {}
}

async function onPath(name: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(path.join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/** Write a file with no atomicity guarantee. Only for scratch/test fixtures. */
export async function writeFileDirect(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content, 'utf8');
}
