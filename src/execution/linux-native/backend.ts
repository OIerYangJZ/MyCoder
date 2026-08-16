/**
 * LinuxNativeExecutionBackend (alpha.7 MAIN, ADR-0018).
 *
 * The same `ExecutionBackend` every other backend implements (ADR-0007), with
 * the process half routed through the native launcher so the restrictions are
 * the *kernel's* rather than this process's good intentions.
 *
 * Three properties are worth stating because they are what makes this backend
 * different from `local`:
 *
 *   **It never downgrades (§9).** Selecting `linux-native` on a kernel without
 *   Landlock, or without a built launcher, is an error at construction. Falling
 *   back to `local` would give the user the word "sandbox" and none of it, and
 *   falling back to Docker would silently change which daemon is trusted.
 *
 *   **The file broker is unchanged.** `Read`, `Edit` and friends are kernel-side
 *   operations on the host filesystem, exactly as on the container backend, and
 *   the enforcement descriptor says so rather than implying Landlock covers them.
 *
 *   **A guarantee it cannot express is refused, not approximated (§27).** A
 *   host-scoped egress allowlist has no Landlock equivalent, so it comes back as
 *   a structured refusal naming the backend that does support it.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

import { kernelError, KernelErrorException } from '../../util/errors.ts';
import { isWithin, type CanonicalPath } from '../../util/paths.ts';
import { createLogger, type Logger } from '../../util/logger.ts';
import { scrubEnv, assertNoCredentialEnv } from '../../security/env-scrub.ts';
import type { Redactor } from '../../security/redactor.ts';
import { LocalExecutionBackend } from '../local.ts';
import { verifyLauncher } from './identity.ts';
import { resolveLauncherSourcePath } from './paths.ts';
import { linuxNativeEnforcement, summarizeEnforcement } from '../enforcement.ts';
import type {
  BackendKind,
  CapabilityExecutor,
  CapabilityProfile,
  EnvironmentDescriptor,
  ExecutionBackend,
  FileSystemBackend,
  ProcessResult,
  ProcessSpec,
} from '../backend.ts';
import { buildPlan, PlanRefused, type LinuxSandboxPlan } from './plan.ts';
import { describeProbe, probeLauncher, type LandlockProbe } from './probe.ts';

/** Exit codes the launcher uses before it execs anything (see the C source). */
const LAUNCHER_EXIT = {
  usage: 64,
  plan: 65,
  unsupported: 66,
  apply: 67,
  exec: 68,
} as const;

export interface LinuxNativeBackendOptions {
  workspaceRoot: CanonicalPath;
  redactor: Redactor;
  launcherPath: string;
  logger?: Logger;
  /** Scratch root; the synthetic HOME lives under it (§19). */
  sandboxHome?: CanonicalPath;
  homeDir?: string;
  tmpDir?: string;
  hasRipgrep?: boolean;
  hasGit?: boolean;
  /**
   * Protected paths discovered inside the workspace, and whether the scan
   * completed. Passed in rather than discovered here so the traversal is the
   * same one the container backend uses (§16, §17).
   */
  protectedInsideRoots?: readonly CanonicalPath[];
  discoveryTruncated?: boolean;
  /**
   * The launcher source this installation ships, for the ADR-0020 identity
   * check. Defaults to `resolveLauncherSourcePath()`; the live suites override
   * it when they build into a temp directory.
   */
  launcherSourcePath?: string;
  /** Test seam: skip probing and use this result. */
  probeOverride?: LandlockProbe;
}

class LinuxNativeExecutor implements CapabilityExecutor {
  readonly profile: CapabilityProfile;
  readonly environment: EnvironmentDescriptor;
  readonly fs: FileSystemBackend;

  private readonly deps: {
    launcherPath: string;
    sandboxHome: CanonicalPath;
    protectedInsideRoots: readonly CanonicalPath[];
    discoveryTruncated: boolean;
    redactor: Redactor;
    logger: Logger;
    homeDir: string;
    dispose(): void;
  };
  private disposed = false;

  constructor(
    profile: CapabilityProfile,
    environment: EnvironmentDescriptor,
    fs: FileSystemBackend,
    deps: LinuxNativeExecutor['deps'],
  ) {
    this.profile = profile;
    this.environment = environment;
    this.fs = fs;
    this.deps = deps;
  }

  /** The plan this profile produces. Exposed for `/status`, tests and audit. */
  plan(): LinuxSandboxPlan {
    return buildPlan({
      profile: this.profile,
      sandboxHome: this.deps.sandboxHome,
      protectedInsideRoots: this.deps.protectedInsideRoots,
      discoveryTruncated: this.deps.discoveryTruncated,
    });
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

    let plan: LinuxSandboxPlan;
    try {
      plan = this.plan();
    } catch (e) {
      if (e instanceof PlanRefused) {
        throw new KernelErrorException(
          kernelError('SANDBOX_UNSUPPORTED', e.reason, {
            blame: 'kernel',
            retryable: false,
            ...(e.remedy ? { safeDetails: { remedy: e.remedy } } : {}),
          }),
        );
      }
      throw e;
    }

    const scrub = scrubEnv({
      allow: this.profile.envAllow,
      // §19: the workload's HOME is the sandbox's own scratch directory. The
      // real home holds ssh keys and cloud credentials and is not in the plan.
      home: this.deps.sandboxHome,
      cwd: spec.cwd,
      ...(spec.env ? { extra: spec.env } : {}),
    });
    for (const injection of this.profile.secretInjections) {
      injection.lease.injectInto(scrub.env, injection.envName);
    }
    scrub.env.HOME = this.deps.sandboxHome;
    scrub.env.TMPDIR = this.deps.sandboxHome;

    const check = assertNoCredentialEnv(
      scrub.env,
      this.profile.secretInjections.map((i) => i.envName),
    );
    if (!check.ok) {
      throw new KernelErrorException(
        kernelError(
          'SECRET_ACCESS_DENIED',
          `Refusing to spawn: the prepared environment still contains ${check.offending.length} credential-shaped variable(s).`,
          { blame: 'kernel', safeDetails: { names: check.offending } },
        ),
      );
    }

    return runLauncher({
      launcherPath: this.deps.launcherPath,
      plan,
      argv: [...spec.argv],
      cwd: spec.cwd,
      env: scrub.env,
      timeoutMs: spec.timeoutMs ?? this.profile.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes ?? this.profile.maxOutputBytes,
      redactor: this.deps.redactor,
      ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deps.dispose();
  }
}

export class LinuxNativeExecutionBackend implements ExecutionBackend {
  readonly id = 'linux-native';
  readonly kind: BackendKind = 'linux-native';
  readonly fs: FileSystemBackend;
  readonly process: LocalExecutionBackend['process'];
  readonly environment: EnvironmentDescriptor;
  /** What this kernel was measured to support (§12). Named `features` because
   * `probe()` is the interface's reachability check, and one of them had to
   * move. */
  readonly features: LandlockProbe;

  private readonly opts: LinuxNativeBackendOptions;
  private readonly host: LocalExecutionBackend;
  private readonly sandboxHome: CanonicalPath;
  private readonly logger: Logger;

  private constructor(opts: LinuxNativeBackendOptions, host: LocalExecutionBackend, probe: LandlockProbe) {
    this.opts = opts;
    this.host = host;
    this.features = probe;
    this.logger = opts.logger ?? createLogger({ scope: 'backend:linux-native' });
    this.fs = host.fs;
    this.process = host.process;

    this.sandboxHome =
      opts.sandboxHome ?? (path.join(opts.tmpDir ?? tmpdir(), 'mycoder-sandbox-home') as CanonicalPath);
    mkdirSync(this.sandboxHome, { recursive: true });

    const enforcement = linuxNativeEnforcement({
      networkTcp: probe.networkTcp,
      abi: probe.abi,
      notes: describeProbe(probe),
    });

    this.environment = {
      platform: process.platform,
      kind: 'linux-native',
      workspaceRoot: opts.workspaceRoot,
      homeDir: opts.homeDir ?? homedir(),
      tmpDir: opts.tmpDir ?? tmpdir(),
      hasRipgrep: opts.hasRipgrep ?? host.environment.hasRipgrep,
      hasGit: opts.hasGit ?? host.environment.hasGit,
      sandboxStrength: summarizeEnforcement(enforcement),
      enforcement,
      description: `native Linux sandbox (Landlock ABI ${probe.abi}, seccomp, no_new_privs)`,
    };
  }

  /**
   * Construct, or refuse with a reason a human can act on (§9, §46).
   *
   * Every failure here is a refusal to *start*, never a quieter backend: the
   * user asked for a kernel-enforced sandbox, and the only honest alternatives
   * are providing it or saying why not.
   */
  static async create(opts: LinuxNativeBackendOptions): Promise<LinuxNativeExecutionBackend> {
    if (process.platform !== 'linux') {
      throw new KernelErrorException(
        kernelError('SANDBOX_UNSUPPORTED', `The native sandbox is Linux-only; this is ${process.platform}.`, {
          blame: 'user',
          retryable: false,
          safeDetails: { remedy: 'Use --backend container, or run on Linux.' },
        }),
      );
    }

    // Identity before capability (ADR-0020). Asking an unverified binary what it
    // can enforce and believing the answer is backwards: `--probe` is a claim
    // made by the very program whose provenance is in question, so a replaced
    // launcher could report ABI 8 and enforce nothing. Verify what it *is*
    // first, then ask what it can do.
    //
    // Skipped only when the caller supplied a probe override, which is the live
    // suites building into a temp directory — they pass `launcherSourcePath` when
    // they want the real check.
    if (!opts.probeOverride) {
      const identity = verifyLauncher(
        opts.launcherPath,
        opts.launcherSourcePath ?? resolveLauncherSourcePath(),
      );
      if (!identity.ok) {
        throw new KernelErrorException(
          kernelError('SANDBOX_UNSUPPORTED', identity.reason, {
            blame: identity.problem === 'mismatched' ? 'environment' : 'user',
            retryable: false,
            safeDetails: {
              problem: `launcher-${identity.problem}`,
              remedy: identity.remedy,
              launcher: identity.binary,
            },
          }),
        );
      }
    }

    const probed = opts.probeOverride
      ? ({ ok: true, probe: opts.probeOverride } as const)
      : probeLauncher(opts.launcherPath);

    if (!probed.ok) {
      throw new KernelErrorException(
        kernelError('SANDBOX_UNSUPPORTED', probed.reason, {
          blame: 'environment',
          retryable: false,
          ...(probed.remedy ? { safeDetails: { remedy: probed.remedy } } : {}),
        }),
      );
    }

    const host = await LocalExecutionBackend.detect({
      workspaceRoot: opts.workspaceRoot,
      redactor: opts.redactor,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
      ...(opts.tmpDir ? { tmpDir: opts.tmpDir } : {}),
    });

    return new LinuxNativeExecutionBackend(opts, host, probed.probe);
  }

  async enforce(profile: CapabilityProfile): Promise<CapabilityExecutor> {
    // The trusted broker is narrowed exactly as it is locally: same second path
    // check, same host paths. Landlock governs the *subprocess*, not the kernel's
    // own file access, and the enforcement descriptor says which is which.
    const broker = await this.host.enforce(profile);

    return new LinuxNativeExecutor(profile, this.environment, broker.fs, {
      launcherPath: this.opts.launcherPath,
      sandboxHome: this.sandboxHome,
      protectedInsideRoots: this.opts.protectedInsideRoots ?? [],
      discoveryTruncated: this.opts.discoveryTruncated ?? false,
      redactor: this.opts.redactor,
      logger: this.logger,
      homeDir: this.environment.homeDir,
      dispose: () => broker.dispose(),
    });
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const workspace = await this.fs.stat(this.environment.workspaceRoot);
    if (!workspace?.isDirectory) {
      return { ok: false, detail: `Workspace root is not a directory: ${this.environment.workspaceRoot}` };
    }
    return this.features.landlockAvailable
      ? { ok: true, detail: this.environment.description }
      : { ok: false, detail: 'Landlock is unavailable on this kernel' };
  }

  async close(): Promise<void> {
    await this.host.close();
  }
}

interface LauncherRun {
  launcherPath: string;
  plan: LinuxSandboxPlan;
  argv: readonly string[];
  cwd: CanonicalPath;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  redactor: Redactor;
  stdin?: string;
  signal?: AbortSignal;
}

/**
 * Run one command under the launcher.
 *
 * The plan travels on a pipe rather than in argv: `ps` shows argv to every user
 * on the box, and a plan is a list of exactly which paths this machine's agent
 * may touch.
 */
async function runLauncher(run: LauncherRun): Promise<ProcessResult> {
  const started = Date.now();

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(run.launcherPath, ['--plan-fd', '3', '--', ...run.argv], {
      cwd: run.cwd,
      env: run.env,
      // fd 3 is the plan pipe; the launcher closes it and every other inherited
      // descriptor before the workload starts (§20).
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;

    const planPipe = child.stdio[3] as NodeJS.WritableStream | null;
    planPipe?.end(run.plan.text);

    const killTree = (sig: NodeJS.Signals): void => {
      // `detached: true` makes the child a process-group leader, so the whole
      // tree gets the signal — §31's requirement, and the reason a shell that
      // spawned children cannot outlive its own timeout.
      try {
        process.kill(-child.pid!, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 2_000).unref?.();
    }, run.timeoutMs);

    const onAbort = (): void => {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 1_000).unref?.();
    };
    run.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (Buffer.byteLength(stdout, 'utf8') <= run.maxOutputBytes) stdout += chunk;
      else outputTruncated = true;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderr, 'utf8') <= run.maxOutputBytes) stderr += chunk;
      else outputTruncated = true;
    });

    if (run.stdin !== undefined) child.stdin?.end(run.stdin);
    else child.stdin?.end();

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);
      reject(
        new KernelErrorException(
          kernelError('TOOL_FAILED', `The native launcher could not be started: ${err.code ?? err.message}`, {
            blame: 'environment',
          }),
        ),
      );
    });

    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);

      // A launcher-level exit means the workload never ran, and reporting it as
      // "your command exited 66" would be the misleading transport noise §46
      // exists to stop.
      if (
        !timedOut &&
        code !== null &&
        code >= LAUNCHER_EXIT.usage &&
        code <= LAUNCHER_EXIT.exec &&
        stdout === ''
      ) {
        reject(launcherError(code, stderr, run.argv[0] ?? ''));
        return;
      }

      resolve({
        stdout: run.redactor.redact(stdout),
        stderr: run.redactor.redact(stderr),
        exitCode: code,
        signal: sig,
        timedOut,
        durationMs: Date.now() - started,
        outputTruncated,
      });
    });
  });
}

function launcherError(code: number, stderr: string, executable: string): KernelErrorException {
  const detail = stderr.trim().split('\n').slice(-1)[0] ?? '';

  // §51: a missing executable is *one* semantic error across Local, SSH,
  // Container and here. The launcher reports the kernel's own wording ("No such
  // file or directory"), which is true and is not what every other backend says;
  // the conformance suite is what caught the divergence. Backend-specific
  // transport text belongs in details, not in the sentence.
  if (code === LAUNCHER_EXIT.exec && /No such file or directory|ENOENT/i.test(detail)) {
    return new KernelErrorException(
      kernelError('TOOL_FAILED', `Executable not found: ${executable}`, {
        blame: 'model',
        safeDetails: { executable, backend: 'linux-native', launcherDetail: detail },
      }),
    );
  }

  switch (code) {
    case LAUNCHER_EXIT.unsupported:
      return new KernelErrorException(
        kernelError('SANDBOX_UNSUPPORTED', `The kernel cannot provide the requested sandbox: ${detail}`, {
          blame: 'environment',
          retryable: false,
        }),
      );
    case LAUNCHER_EXIT.apply:
      return new KernelErrorException(
        kernelError('SANDBOX_SETUP_FAILED', `A sandbox restriction could not be applied: ${detail}`, {
          blame: 'kernel',
          retryable: false,
        }),
      );
    case LAUNCHER_EXIT.plan:
    case LAUNCHER_EXIT.usage:
      return new KernelErrorException(
        kernelError('INTERNAL_ERROR', `The sandbox plan was rejected by the launcher: ${detail}`, {
          blame: 'kernel',
        }),
      );
    default:
      return new KernelErrorException(
        kernelError('TOOL_FAILED', `The sandboxed command could not be started: ${detail}`, {
          blame: 'model',
        }),
      );
  }
}
