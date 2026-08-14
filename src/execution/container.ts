/**
 * Container ExecutionBackend (alpha.5, ADR-0014).
 *
 * The point of this backend is the sentence alpha.4 could not write: for an
 * arbitrary subprocess, forbidden host resources are *absent*, not denied. Every
 * earlier backend answered "can the model reach this?" with kernel policy, which
 * is a real defence against a model that asks for the wrong thing and no defence
 * at all against a command that simply opens the file. Here the process runs in a
 * mount namespace containing the workspace and nothing else, with no network
 * unless the capability profile granted it.
 *
 * Three constraints shape the implementation:
 *
 *  1. **ADR-0007.** This is an `ExecutionBackend` like the other two. The agent
 *     loop, the tool runtime and every tool are unchanged and cannot tell which
 *     backend they are running on; there is no `if (backend === 'container')`
 *     anywhere outside this file and the bootstrap that selects it.
 *
 *  2. **ADR-0009.** The transport is the `docker` CLI, invoked through the same
 *     `spawn` the local backend uses. No Docker SDK, no new runtime dependency.
 *     The kernel owns argument construction, plan validation, error mapping and
 *     result normalisation — see `container-plan.ts`, which is where all four
 *     live as pure functions.
 *
 *  3. **§28.** The trusted file broker stays on the host. `Read`, `Edit`, the
 *     freshness ledger and the atomic-write journal are kernel operations on the
 *     host filesystem, and containerising them would mean re-implementing the
 *     edit protocol as `docker exec sed`, which §30 rules out for good reasons.
 *     So this backend reports two different enforcement levels — the process's
 *     filesystem view is container-enforced, the broker is policy-enforced — and
 *     never blurs them.
 *
 * The one thing this backend must never do is succeed quietly when it cannot do
 * its job. §40: if the runtime is unavailable, construction fails. A backend that
 * fell back to local execution would turn a security decision into a warning
 * nobody reads.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

import { kernelError, KernelErrorException, type ErrorCode as KernelErrorCode } from '../util/errors.ts';
import { shortId } from '../util/ids.ts';
import { isWithin, toPosix, type CanonicalPath } from '../util/paths.ts';
import { createLogger, type Logger } from '../util/logger.ts';
import { scrubEnv, assertNoCredentialEnv } from '../security/env-scrub.ts';
import type { Redactor } from '../security/redactor.ts';
import { containerEnforcement, summarizeEnforcement } from './enforcement.ts';
import { LocalExecutionBackend } from './local.ts';
import {
  buildContainerPlan,
  containerName,
  dockerRunArgs,
  planContainerMounts,
  toContainerPath,
  translateArgvPaths,
  validateContainerPlan,
  CONTAINER_TMP,
  CONTAINER_WORKSPACE,
  type ContainerImageRef,
  type ContainerLimits,
  type ContainerMountPlan,
  type ContainerPlan,
  type MountPlannerHost,
} from './container-plan.ts';
import type {
  BackendKind,
  CapabilityExecutor,
  CapabilityProfile,
  EnvironmentDescriptor,
  ExecutionBackend,
  FileSystemBackend,
  ProcessBackend,
  ProcessResult,
  ProcessSpec,
} from './backend.ts';

/** Default resource bounds. Only ever reported as enforced when actually tested. */
export const DEFAULT_CONTAINER_LIMITS: ContainerLimits = {
  pids: 512,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  cpus: 2,
};

export interface ContainerConfig {
  /**
   * The image, from trusted configuration or the built-in default.
   *
   * §11: never model-controlled. It arrives here from user config or the
   * default; a tool argument cannot reach it, and the plan validator refuses an
   * image that is not on the trusted list even if one somehow did.
   */
  image: string;
  /** Additional trusted images, e.g. for a test fixture. */
  allowedImages?: readonly string[];
  limits?: ContainerLimits;
  /** `uid:gid` for the container process. Defaults to the host's on POSIX. */
  user?: string;
  /** Skip the `--user` flag entirely, for an image with its own unprivileged user. */
  useImageUser?: boolean;
  tmpfsBytes?: number;
  /** Pull the image at startup when it is missing. Control-plane action (§11). */
  pullIfMissing?: boolean;
}

export function defaultContainerConfig(): ContainerConfig {
  return {
    // A Debian-based Node image, chosen because the isolation suite has to be
    // able to *attempt* every attack in §59 with a real interpreter: a missing
    // `python3` would make "the network is unreachable" and "python is not
    // installed" indistinguishable, and the first is evidence while the second
    // is a test that proves nothing.
    image: 'node:22-bookworm',
    limits: DEFAULT_CONTAINER_LIMITS,
  };
}

// --- runtime probe (§10) ---------------------------------------------------

export interface ContainerRuntimeInfo {
  /** `docker` today; the field exists so the error messages do not lie later. */
  binary: string;
  clientVersion: string;
  serverVersion: string;
  /** e.g. `linux/arm64`. */
  serverPlatform: string;
  /** Docker Desktop, Docker Engine, … as the daemon reports it. */
  operatingSystem: string;
  kernelVersion: string;
  /** True when the daemon is a native Linux engine rather than a VM (§37/§38). */
  nativeLinux: boolean;
  rootless: boolean;
  securityOptions: readonly string[];
}

export interface ProbeResult {
  ok: boolean;
  info?: ContainerRuntimeInfo;
  code?: KernelErrorCode;
  detail: string;
}

interface RunOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

/**
 * Run the docker client.
 *
 * The client is *kernel-side* infrastructure, not the untrusted workload, so it
 * gets an environment that lets it find the daemon: `HOME` (for
 * `~/.docker/config.json` and the current context) plus the `DOCKER_*` variables
 * a user may legitimately have set to point at a non-default daemon. That is a
 * deliberate, narrow exception to the scrub — and it is *not* the environment the
 * workload receives, which is built separately in `ContainerExecutor.exec` and
 * asserted credential-free before it is used.
 */
async function runDocker(
  binary: string,
  args: readonly string[],
  opts: {
    timeoutMs: number;
    stdin?: string;
    maxOutputBytes?: number;
    env?: Record<string, string>;
    /**
     * Called the moment this run is being torn down, before the client is
     * signalled.
     *
     * `docker run` does not exit when it receives SIGTERM: it forwards the signal
     * to the container and keeps waiting. And the container will not act on it
     * either, because the workload is PID 1 in its own namespace, and PID 1
     * ignores SIGTERM unless it installs a handler — which `sh -c 'sleep 120'`
     * does not.
     *
     * The measured consequence, before this hook existed: cancelling a command
     * returned control to the user after **120 seconds**, i.e. when the command
     * finished on its own. The cancellation had done nothing except set a flag.
     * That is the same defect the SSH backend hit in alpha.3 for a different
     * reason, and it is worth naming twice: a cancel that does not terminate the
     * work is not a cancel.
     *
     * So the teardown path removes the *container*, which makes `docker run`
     * exit, which settles this promise. Killing the client is the fallback, not
     * the mechanism.
     */
    onTerminate?: (reason: 'timeout' | 'abort') => void;
  },
  signal?: AbortSignal,
): Promise<RunOutput> {
  const env =
    opts.env ??
    scrubEnv({
      allow: ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'],
      home: homedir(),
    }).env;

  const maxBytes = opts.maxOutputBytes ?? 8 * 1024 * 1024;

  return new Promise<RunOutput>((resolve) => {
    const child = spawn(binary, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, spawnError?: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode, timedOut, ...(spawnError ? { spawnError } : {}) });
    };

    const teardown = (reason: 'timeout' | 'abort'): void => {
      // Remove the container first; the client exits as a consequence.
      opts.onTerminate?.(reason);
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 5_000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      teardown('timeout');
    }, opts.timeoutMs);

    const onAbort = (): void => teardown('abort');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      if (Buffer.byteLength(stdout) < maxBytes) stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      if (Buffer.byteLength(stderr) < maxBytes) stderr += c;
    });

    child.stdin.on('error', () => {
      // A container that exits before reading stdin closes the pipe; EPIPE here
      // is the workload's business, not a transport failure.
    });
    child.stdin.end(opts.stdin ?? '');

    child.on('error', (err: NodeJS.ErrnoException) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Classify a docker failure (§62).
 *
 * The stderr strings are matched loosely and the *order* matters: "permission
 * denied" on the socket and "is the docker daemon running" both mean the daemon
 * is unusable, but they need different messages, because one is fixed by adding a
 * group and the other by starting Docker.
 */
export function classifyDockerError(output: {
  stderr: string;
  exitCode: number | null;
  spawnError?: NodeJS.ErrnoException;
}): { code: KernelErrorCode; detail: string; retryable: boolean } {
  const stderr = output.stderr.trim();
  const lower = stderr.toLowerCase();

  if (output.spawnError?.code === 'ENOENT') {
    return {
      code: 'CONTAINER_RUNTIME_NOT_FOUND',
      detail: 'The docker CLI is not on PATH.',
      retryable: false,
    };
  }
  if (output.spawnError) {
    return {
      code: 'CONTAINER_RUNTIME_UNAVAILABLE',
      detail: `The docker CLI could not be started (${output.spawnError.code ?? 'unknown'}).`,
      retryable: false,
    };
  }
  // lint-allow no-container-escape-flags: matching the daemon's own error text, which
  // names the socket the *client* could not open. This is error classification, not a
  // mount: the only socket involved belongs to the kernel-side docker client.
  if (lower.includes('permission denied') && lower.includes('docker.sock')) {
    return {
      code: 'CONTAINER_RUNTIME_UNAVAILABLE',
      detail: 'The docker socket exists but this user may not use it.',
      retryable: false,
    };
  }
  if (
    lower.includes('cannot connect to the docker daemon') ||
    lower.includes('is the docker daemon running') ||
    lower.includes('failed to connect to the docker api') ||
    lower.includes('docker_host')
  ) {
    return {
      code: 'CONTAINER_RUNTIME_UNAVAILABLE',
      detail: 'The docker daemon is not reachable.',
      retryable: true,
    };
  }
  if (
    lower.includes('no such image') ||
    lower.includes('manifest unknown') ||
    (lower.includes('unable to find image') && lower.includes('locally')) ||
    lower.includes('pull access denied')
  ) {
    return {
      code: 'CONTAINER_IMAGE_NOT_FOUND',
      detail: 'The configured container image is not present and could not be resolved.',
      retryable: false,
    };
  }
  if (lower.includes('unknown flag') || lower.includes('not supported') || lower.includes('unsupported')) {
    return {
      code: 'CONTAINER_UNSUPPORTED_FEATURE',
      detail: 'This docker runtime does not support a flag the plan requires.',
      retryable: false,
    };
  }
  if (lower.includes('invalid mount') || lower.includes('bind source path does not exist')) {
    return {
      code: 'CONTAINER_INVALID_MOUNT',
      detail: 'The daemon rejected a mount in the plan.',
      retryable: false,
    };
  }
  if (lower.includes('oom') || output.exitCode === 137) {
    return {
      code: 'CONTAINER_RESOURCE_LIMIT',
      detail: 'The container was killed, most likely by the memory limit.',
      retryable: false,
    };
  }
  return {
    code: 'CONTAINER_START_FAILED',
    detail: stderr === '' ? 'The container could not be started.' : stderr.slice(0, 300),
    retryable: false,
  };
}

/** Probe the runtime: binary, client, daemon, platform (§10). */
export async function probeContainerRuntime(
  opts: { binary?: string; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const binary = opts.binary ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 20_000;

  // One call: `docker version` already contacts the daemon, so a separate
  // reachability check would only add a second way to be wrong.
  const version = await runDocker(
    binary,
    [
      'version',
      '--format',
      '{{.Client.Version}}\n{{.Server.Version}}\n{{.Server.Os}}/{{.Server.Arch}}\n{{.Server.KernelVersion}}',
    ],
    { timeoutMs },
  );

  if (version.exitCode !== 0 || version.spawnError) {
    const classified = classifyDockerError(version);
    return { ok: false, code: classified.code, detail: classified.detail };
  }

  const [clientVersion, serverVersion, serverPlatform, kernelVersion] = version.stdout
    .split('\n')
    .map((l) => l.trim());

  const info = await runDocker(binary, ['info', '--format', '{{.OperatingSystem}}\n{{.SecurityOptions}}'], {
    timeoutMs,
  });
  const [operatingSystem, securityRaw] = info.stdout.split('\n').map((l) => l.trim());
  const securityOptions = (securityRaw ?? '')
    .replace(/^\[|\]$/g, '')
    .split(/\s+/)
    .filter((s) => s !== '');

  const os = operatingSystem ?? '';
  return {
    ok: true,
    detail: `docker ${serverVersion ?? '?'} on ${os}`,
    info: {
      binary,
      clientVersion: clientVersion ?? '?',
      serverVersion: serverVersion ?? '?',
      serverPlatform: serverPlatform ?? '?',
      operatingSystem: os,
      kernelVersion: kernelVersion ?? '?',
      // Docker Desktop runs the daemon in a VM, so its boundary is the
      // hypervisor's plus a file-sharing layer, not the host kernel's alone
      // (§38). `linuxkit` is the Desktop VM's kernel; naming both the product
      // and the kernel keeps this from depending on one string.
      nativeLinux:
        process.platform === 'linux' && !/docker desktop/i.test(os) && !/linuxkit/i.test(kernelVersion ?? ''),
      rootless: securityOptions.some((o) => o.includes('rootless')),
      securityOptions,
    },
  };
}

/** Resolve the image and record its provenance (§11). Never pulls implicitly. */
export async function resolveContainerImage(
  binary: string,
  image: string,
  opts: { pullIfMissing?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: boolean; ref?: ContainerImageRef; code?: KernelErrorCode; detail: string }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const inspect = async (): Promise<RunOutput> =>
    runDocker(binary, ['image', 'inspect', image, '--format', '{{.Id}}\n{{index .RepoDigests 0}}'], {
      timeoutMs,
    });

  let result = await inspect();
  if (result.exitCode !== 0 && opts.pullIfMissing) {
    // A pull is a setup action, done here at construction time, never as a side
    // effect of a tool call (§11). It needs the network, which is why it cannot
    // live inside an execution whose profile may forbid one.
    const pull = await runDocker(binary, ['pull', '--quiet', image], { timeoutMs: 10 * 60_000 });
    if (pull.exitCode !== 0) {
      const classified = classifyDockerError(pull);
      return { ok: false, code: classified.code, detail: classified.detail };
    }
    result = await inspect();
  }

  if (result.exitCode !== 0) {
    const classified = classifyDockerError(result);
    return {
      ok: false,
      code: classified.code === 'CONTAINER_START_FAILED' ? 'CONTAINER_IMAGE_NOT_FOUND' : classified.code,
      detail:
        `Image "${image}" is not present locally. Pull it once as a setup step ` +
        `(docker pull ${image}) or set container.pull_if_missing.`,
    };
  }

  const [id, repoDigest] = result.stdout.split('\n').map((l) => l.trim());
  const digest = repoDigest && repoDigest.includes('@') ? repoDigest.split('@')[1] : undefined;
  return {
    ok: true,
    detail: `image ${image} resolved`,
    ref: {
      configured: image,
      ...(id ? { resolvedId: id } : {}),
      ...(digest ? { digest } : {}),
    },
  };
}

// --- the process backend ---------------------------------------------------

export interface ContainerProcessOptions {
  binary: string;
  image: ContainerImageRef;
  workspaceRoot: CanonicalPath;
  redactor: Redactor;
  logger: Logger;
  allowedImages: readonly string[];
  limits: ContainerLimits;
  user?: string;
  /** Empty file used to mask a protected file inside the workspace. */
  maskFileHostPath: string;
  isProtectedHostPath?: (hostPath: string) => boolean;
  protectedHostPaths?: readonly string[];
}

/**
 * One ephemeral container per execution (§27).
 *
 * The alternative — a long-lived container per session, with `docker exec` per
 * command — is faster and much harder to reason about: the capability profile
 * changes per tool call, so the mount set and the network mode would have to
 * change under a running container, which Docker cannot do. A container whose
 * mounts were planned for the *previous* call is a capability leak with a
 * plausible-looking implementation. §27 says to start here and change it only
 * with measured evidence.
 */
export class ContainerProcess {
  private readonly opts: ContainerProcessOptions;
  /** Names of containers this backend started, so cleanup can be verified. */
  private readonly started = new Set<string>();

  constructor(opts: ContainerProcessOptions) {
    this.opts = opts;
  }

  get startedNames(): readonly string[] {
    return [...this.started];
  }

  /** Build, validate and run a plan. Returns the plan for the audit record. */
  async run(
    plan: ContainerPlan,
    envPassthroughValues: Record<string, string>,
    spec: { stdin?: string; maxOutputBytes?: number },
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const validation = validateContainerPlan(plan, {
      workspaceRoot: this.opts.workspaceRoot,
      allowedImages: this.opts.allowedImages,
      ...(this.opts.protectedHostPaths ? { protectedHostPaths: this.opts.protectedHostPaths } : {}),
      ...(this.opts.isProtectedHostPath ? { isProtectedHostPath: this.opts.isProtectedHostPath } : {}),
      allowedEnvPassthrough: Object.keys(envPassthroughValues),
    });
    if (!validation.ok) {
      // A rejected plan is a kernel defect, and it is reported as one: `blame:
      // 'kernel'` rather than 'model', because no tool argument is supposed to be
      // able to produce an invalid plan.
      throw new KernelErrorException(
        kernelError('CONTAINER_PLAN_REJECTED', 'The container plan was refused before it was started.', {
          blame: 'kernel',
          retryable: false,
          safeDetails: { problems: validation.problems },
        }),
      );
    }

    const args = dockerRunArgs(plan);
    const started = Date.now();
    this.started.add(plan.name);

    // The docker client's environment carries the secret values, so the
    // daemon receives them over the socket instead of via the process table.
    const clientEnv = {
      ...scrubEnv({
        allow: ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'],
        home: homedir(),
      }).env,
      ...envPassthroughValues,
    };

    const output = await runDocker(
      this.opts.binary,
      args,
      {
        // The container's own timeout is enforced here, on the client: `docker
        // run` has no timeout flag, and the workload cannot be trusted to
        // respect one.
        timeoutMs: plan.timeoutMs,
        ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
        ...(spec.maxOutputBytes !== undefined ? { maxOutputBytes: spec.maxOutputBytes } : {}),
        env: clientEnv,
        onTerminate: (reason) => {
          // Fire and forget: the awaited path below settles as soon as the
          // client notices the container is gone, and blocking teardown on a
          // second docker round trip would reintroduce the delay this fixes.
          void this.reap(plan.name, true).catch(() => false);
          this.opts.logger.debug('container terminated', { name: plan.name, reason });
        },
      },
      signal,
    );

    // Cleanup runs whatever happened. `--rm` covers a clean exit; a killed
    // client does not necessarily take the container with it, and §26 is
    // explicit that a cancelled execution must not leave one running.
    const leaked = await this.reap(plan.name, output.timedOut || (signal?.aborted ?? false));

    if (output.spawnError || (output.exitCode !== 0 && looksLikeDockerFailure(output.stderr))) {
      const classified = classifyDockerError(output);
      throw new KernelErrorException(
        kernelError(classified.code, `Container execution failed: ${classified.detail}`, {
          blame: classified.code === 'CONTAINER_RUNTIME_NOT_FOUND' ? 'environment' : 'environment',
          retryable: classified.retryable,
          safeDetails: { image: plan.image.configured, network: plan.network },
        }),
      );
    }

    if (leaked) {
      this.opts.logger.debug('container removed after cancellation', { name: plan.name });
    }
    this.started.delete(plan.name);

    return {
      // Redaction happens before the output can reach the model, the log or the
      // terminal, exactly as it does locally.
      stdout: this.opts.redactor.redact(output.stdout),
      stderr: this.opts.redactor.redact(output.stderr),
      exitCode: output.exitCode,
      signal: output.timedOut ? 'SIGTERM' : null,
      timedOut: output.timedOut,
      durationMs: Date.now() - started,
      outputTruncated:
        Buffer.byteLength(output.stdout) >= (spec.maxOutputBytes ?? 8 * 1024 * 1024) ||
        Buffer.byteLength(output.stderr) >= (spec.maxOutputBytes ?? 8 * 1024 * 1024),
    };
  }

  /** Force-remove a container by name. Returns true when it was still there. */
  async reap(name: string, force: boolean): Promise<boolean> {
    if (!force) {
      // Even on a clean exit, confirm `--rm` did its job rather than assuming.
      const ps = await runDocker(this.opts.binary, ['ps', '-a', '-q', '--filter', `name=^${name}$`], {
        timeoutMs: 10_000,
      });
      if (ps.stdout.trim() === '') return false;
    }
    const rm = await runDocker(this.opts.binary, ['rm', '-f', name], { timeoutMs: 30_000 });
    return rm.exitCode === 0;
  }

  /** True when a container with this name is still known to the daemon. */
  async exists(name: string): Promise<boolean> {
    const ps = await runDocker(this.opts.binary, ['ps', '-a', '-q', '--filter', `name=^${name}$`], {
      timeoutMs: 10_000,
    });
    return ps.stdout.trim() !== '';
  }
}

/**
 * Distinguish "the workload exited non-zero" from "docker could not run it".
 *
 * This matters more than it looks: a test suite that fails is a *successful*
 * execution with exit code 1, and turning that into a `CONTAINER_START_FAILED`
 * would make every red test look like an infrastructure problem. Docker's own
 * failures are recognisable — it exits 125 for a client/daemon error, and its
 * messages are distinctive.
 */
function looksLikeDockerFailure(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes('docker:') ||
    lower.includes('cannot connect to the docker daemon') ||
    lower.includes('failed to connect to the docker api') ||
    lower.includes('unable to find image') ||
    lower.includes('invalid mount') ||
    lower.includes('unknown flag') ||
    lower.includes('error response from daemon')
  );
}

// --- the capability executor ----------------------------------------------

interface ContainerExecutorDeps {
  profile: CapabilityProfile;
  environment: EnvironmentDescriptor;
  /** The trusted host-side broker, already narrowed to the profile (§28). */
  fs: FileSystemBackend;
  process: ContainerProcess;
  workspaceRoot: CanonicalPath;
  agentTmpDir?: CanonicalPath;
  generatedDirs: readonly CanonicalPath[];
  maskPaths: readonly CanonicalPath[];
  maskFileHostPath: string;
  mountHost: MountPlannerHost;
  image: ContainerImageRef;
  limits: ContainerLimits;
  user?: string;
  tmpfsBytes?: number;
  logger: Logger;
  onPlan?: (plan: ContainerPlan) => void;
}

class ContainerExecutor implements CapabilityExecutor {
  readonly profile: CapabilityProfile;
  readonly environment: EnvironmentDescriptor;
  readonly fs: FileSystemBackend;

  private readonly deps: ContainerExecutorDeps;
  private disposed = false;

  constructor(deps: ContainerExecutorDeps) {
    this.deps = deps;
    this.profile = deps.profile;
    this.environment = deps.environment;
    this.fs = deps.fs;
  }

  /** The mount plan this profile produces. Exposed for `/status` and tests. */
  async plan(): Promise<ContainerMountPlan> {
    return planContainerMounts(this.profile, this.deps.mountHost, {
      workspaceRoot: this.deps.workspaceRoot,
      ...(this.deps.agentTmpDir ? { agentTmpDir: this.deps.agentTmpDir } : {}),
      generatedDirs: this.deps.generatedDirs,
      maskPaths: this.deps.maskPaths,
      maskFileHostPath: this.deps.maskFileHostPath,
      ...(this.deps.tmpfsBytes !== undefined ? { tmpfsBytes: this.deps.tmpfsBytes } : {}),
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
    if (toContainerPath(this.deps.workspaceRoot, spec.cwd) === undefined) {
      throw new KernelErrorException(
        kernelError(
          'PATH_OUTSIDE_WORKSPACE',
          'The working directory is outside the workspace, and nothing outside the workspace is mounted into the container.',
          { blame: 'model' },
        ),
      );
    }

    const mountPlan = await this.plan();

    // The workload's environment is built from scratch — never from
    // `process.env`, and never from the docker client's environment either.
    // `HOME` points at the tmpfs, because a container home on a read-only rootfs
    // breaks every tool that writes a cache, and pointing it at the workspace
    // would put tool caches in the repository.
    const scrub = scrubEnv({
      source: {},
      allow: this.profile.envAllow,
      home: CONTAINER_TMP,
      cwd: toContainerPath(this.deps.workspaceRoot, spec.cwd) ?? CONTAINER_WORKSPACE,
      ...(spec.env ? { extra: spec.env } : {}),
    });
    const env: Record<string, string> = {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      ...scrub.env,
    };

    // Secrets go through the client's environment, not the argv (§25).
    const passthroughValues: Record<string, string> = {};
    for (const injection of this.profile.secretInjections) {
      injection.lease.injectInto(passthroughValues, injection.envName);
    }

    const check = assertNoCredentialEnv(env, []);
    if (!check.ok) {
      throw new KernelErrorException(
        kernelError(
          'SECRET_ACCESS_DENIED',
          `Refusing to start a container: the prepared environment still contains ${check.offending.length} credential-shaped variable(s).`,
          { blame: 'kernel', safeDetails: { names: check.offending } },
        ),
      );
    }

    const translated = translateArgvPaths(spec.argv, this.deps.workspaceRoot);
    const plan = buildContainerPlan({
      image: this.deps.image,
      mountPlan,
      cwd: spec.cwd,
      workspaceRoot: this.deps.workspaceRoot,
      env,
      envPassthrough: Object.keys(passthroughValues),
      argv: translated.argv,
      timeoutMs: spec.timeoutMs ?? this.profile.timeoutMs,
      // The one place the capability profile becomes a runtime network fact.
      // `network: false` is the default for every profile that did not ask.
      network: this.profile.network === false ? 'none' : 'bridge',
      ...(this.deps.user ? { user: this.deps.user } : {}),
      limits: this.deps.limits,
      name: containerName('mycoder', shortId()),
    });

    this.deps.onPlan?.(plan);
    this.deps.logger.debug('container plan', {
      image: plan.image.configured,
      network: plan.network,
      mounts: plan.mounts.length,
      writable: plan.mounts.filter((m) => m.mode === 'rw').length,
      masked: plan.mounts.filter((m) => m.origin === 'mask').length,
      unrepresented: plan.unrepresented.length,
      argvTranslated: translated.translated,
    });

    return this.deps.process.run(
      plan,
      passthroughValues,
      {
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

// --- the backend -----------------------------------------------------------

export interface ContainerBackendOptions {
  workspaceRoot: CanonicalPath;
  redactor: Redactor;
  config?: ContainerConfig;
  logger?: Logger;
  agentTmpDir?: CanonicalPath;
  /** Existing directories declared generated by configuration. */
  generatedDirs?: readonly CanonicalPath[];
  /** Protected paths *inside* the workspace, masked out of the container (§16). */
  maskPaths?: readonly CanonicalPath[];
  protectedHostPaths?: readonly string[];
  isProtectedHostPath?: (hostPath: string) => boolean;
  /** The trusted host-side filesystem broker. Defaults to the local one. */
  hostFs?: FileSystemBackend;
  /** Test seam: observe every plan that is about to run. */
  onPlan?: (plan: ContainerPlan) => void;
}

export class ContainerExecutionBackend implements ExecutionBackend {
  readonly id: string;
  readonly kind: BackendKind = 'container';
  readonly fs: FileSystemBackend;
  readonly process: ProcessBackend;
  readonly environment: EnvironmentDescriptor;

  readonly runtime: ContainerRuntimeInfo;
  readonly image: ContainerImageRef;

  private readonly containerProcess: ContainerProcess;
  private readonly opts: ContainerBackendOptions;
  private readonly config: ContainerConfig;
  private readonly logger: Logger;
  private readonly maskFileHostPath: string;
  private readonly scratchDir: string;
  private readonly mountHost: MountPlannerHost;
  /**
   * The host-side broker, constructed once.
   *
   * §28: `Read`, `Edit`, `Grep`'s fallback scanner and the freshness ledger are
   * trusted kernel operations against the host filesystem, and they are narrowed
   * by exactly the same `ConstrainedExecutor` the local backend uses. Reusing that
   * implementation rather than writing a second one is what keeps "the same path
   * rules apply on every backend" true by construction instead of by review.
   */
  private readonly hostBroker: LocalExecutionBackend;

  private constructor(init: {
    opts: ContainerBackendOptions;
    config: ContainerConfig;
    runtime: ContainerRuntimeInfo;
    image: ContainerImageRef;
    hostBroker: LocalExecutionBackend;
    hostFs: FileSystemBackend;
    logger: Logger;
    scratchDir: string;
    maskFileHostPath: string;
    hasGit: boolean;
    hasRipgrep: boolean;
  }) {
    this.opts = init.opts;
    this.config = init.config;
    this.runtime = init.runtime;
    this.image = init.image;
    this.logger = init.logger;
    this.scratchDir = init.scratchDir;
    this.maskFileHostPath = init.maskFileHostPath;
    this.hostBroker = init.hostBroker;
    this.fs = init.hostFs;
    this.id = `container:${init.image.configured}`;

    this.mountHost = {
      realpath: async (p) => init.hostFs.realpath(p as CanonicalPath),
      kind: async (p) => {
        const s = await init.hostFs.stat(p as CanonicalPath);
        if (!s) return undefined;
        return s.isDirectory ? 'dir' : 'file';
      },
    };

    this.containerProcess = new ContainerProcess({
      binary: init.runtime.binary,
      image: init.image,
      workspaceRoot: init.opts.workspaceRoot,
      redactor: init.opts.redactor,
      logger: init.logger,
      allowedImages: [init.config.image, ...(init.config.allowedImages ?? [])],
      limits: init.config.limits ?? DEFAULT_CONTAINER_LIMITS,
      maskFileHostPath: init.maskFileHostPath,
      ...(init.opts.protectedHostPaths ? { protectedHostPaths: init.opts.protectedHostPaths } : {}),
      ...(init.opts.isProtectedHostPath ? { isProtectedHostPath: init.opts.isProtectedHostPath } : {}),
    });

    // A `ProcessBackend` that refuses to run: nothing may execute outside a
    // capability profile on this backend. The interface requires the field, and
    // the honest implementation of "run this with no capability profile" is a
    // denial rather than a permissive default.
    this.process = {
      exec: async () => {
        throw new KernelErrorException(
          kernelError('TOOL_DENIED', 'Container execution requires a capability profile; use enforce().', {
            blame: 'kernel',
          }),
        );
      },
    };

    const enforcement = containerEnforcement({
      networkDenied: true,
      privilegesRestricted: true,
      readOnlyRoot: true,
      platformNotes: platformNotes(init.runtime, init.config),
    });

    this.environment = {
      // The workload's platform, which is the container's, not the host's.
      platform: init.runtime.serverPlatform,
      kind: 'container',
      // The *host* workspace root. The trusted broker works on host paths, and
      // ADR-0012's rule still holds: this is the single source of truth for the
      // tool plane's root. The container path (`/workspace`) is an internal
      // detail of this backend and never leaks into policy or the ledger.
      workspaceRoot: init.opts.workspaceRoot,
      homeDir: CONTAINER_TMP,
      tmpDir: CONTAINER_TMP,
      hasRipgrep: init.hasRipgrep,
      hasGit: init.hasGit,
      sandboxStrength: summarizeEnforcement(enforcement),
      enforcement,
      description:
        `container ${init.image.configured}` +
        (init.image.digest ? ` (${init.image.digest.slice(0, 19)}…)` : '') +
        ` via ${init.runtime.binary} ${init.runtime.serverVersion} on ${init.runtime.operatingSystem}`,
    };
  }

  /**
   * Construct the backend, or fail (§40).
   *
   * There is no `ok: false` return and no fallback parameter. If the runtime is
   * missing, the daemon is down or the image is absent, this throws a structured
   * error and the session does not start. "Security intent must not degrade
   * silently" is only true if there is no code path in which it can.
   */
  static async create(opts: ContainerBackendOptions): Promise<ContainerExecutionBackend> {
    const logger = opts.logger ?? createLogger({ scope: 'backend:container' });
    const config = opts.config ?? defaultContainerConfig();

    const probe = await probeContainerRuntime({});
    if (!probe.ok || !probe.info) {
      throw new KernelErrorException(
        kernelError(
          probe.code ?? 'CONTAINER_RUNTIME_UNAVAILABLE',
          `The container backend was requested but the runtime is unusable: ${probe.detail} ` +
            'Nothing was executed locally instead.',
          { blame: 'environment', retryable: false },
        ),
      );
    }

    const resolved = await resolveContainerImage(probe.info.binary, config.image, {
      ...(config.pullIfMissing !== undefined ? { pullIfMissing: config.pullIfMissing } : {}),
    });
    if (!resolved.ok || !resolved.ref) {
      throw new KernelErrorException(
        kernelError(resolved.code ?? 'CONTAINER_IMAGE_NOT_FOUND', resolved.detail, {
          blame: 'user',
          retryable: false,
          safeDetails: { image: config.image },
        }),
      );
    }

    const hostBroker = await LocalExecutionBackend.detect({
      workspaceRoot: opts.workspaceRoot,
      redactor: opts.redactor,
      logger: logger.child('broker'),
    });
    const hostFs = opts.hostFs ?? hostBroker.fs;

    // A kernel-owned scratch directory, outside the workspace, holding exactly
    // one file: an empty one used to mask protected files inside the workspace.
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'mycoder-container-'));
    const maskFileHostPath = path.join(scratchDir, 'masked');
    await writeFile(maskFileHostPath, '', { mode: 0o444 });

    // What the *image* has, probed inside it rather than assumed from the host.
    // `hasGit: true` because the host has git would make GitDiff fail in a way
    // that looks like a repository problem.
    const probeTools = await runDocker(
      probe.info.binary,
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--tmpfs',
        '/tmp:rw,size=16777216,mode=1777',
        '--entrypoint',
        'sh',
        config.image,
        '-c',
        'command -v rg >/dev/null && echo rg; command -v git >/dev/null && echo git',
      ],
      { timeoutMs: 60_000 },
    );
    const tools = probeTools.stdout.split('\n').map((l) => l.trim());

    logger.debug('container runtime ready', {
      server: probe.info.serverVersion,
      platform: probe.info.serverPlatform,
      nativeLinux: probe.info.nativeLinux,
      image: resolved.ref.configured,
    });

    return new ContainerExecutionBackend({
      opts,
      config,
      runtime: probe.info,
      image: resolved.ref,
      hostBroker,
      hostFs,
      logger,
      scratchDir,
      maskFileHostPath,
      hasGit: tools.includes('git'),
      hasRipgrep: tools.includes('rg'),
    });
  }

  /** The uid:gid the container process runs as, or undefined for the image's. */
  private containerUser(): string | undefined {
    if (this.config.useImageUser) return undefined;
    if (this.config.user) return this.config.user;
    // Matching the host uid keeps workspace writes owned by the user who
    // started the session (§19). `process.getuid` is absent on Windows, where
    // the flag is meaningless anyway.
    const getuid = process.getuid?.bind(process);
    const getgid = process.getgid?.bind(process);
    if (!getuid || !getgid) return undefined;
    return `${getuid()}:${getgid()}`;
  }

  async enforce(profile: CapabilityProfile): Promise<CapabilityExecutor> {
    // The same second path check the local backend performs, on the same host
    // paths: the trusted broker is host-side, so its containment rules are
    // unchanged by containerisation.
    const broker = await this.hostBroker.enforce(profile);

    const user = this.containerUser();
    return new ContainerExecutor({
      profile,
      environment: this.environment,
      fs: broker.fs,
      process: this.containerProcess,
      workspaceRoot: this.opts.workspaceRoot,
      ...(this.opts.agentTmpDir ? { agentTmpDir: this.opts.agentTmpDir } : {}),
      generatedDirs: this.opts.generatedDirs ?? [],
      maskPaths: this.opts.maskPaths ?? [],
      maskFileHostPath: this.maskFileHostPath,
      mountHost: this.mountHost,
      image: this.image,
      limits: this.config.limits ?? DEFAULT_CONTAINER_LIMITS,
      ...(user ? { user } : {}),
      ...(this.config.tmpfsBytes !== undefined ? { tmpfsBytes: this.config.tmpfsBytes } : {}),
      logger: this.logger,
      ...(this.opts.onPlan ? { onPlan: this.opts.onPlan } : {}),
    });
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const s = await this.fs.stat(this.opts.workspaceRoot);
    if (!s?.isDirectory) {
      return { ok: false, detail: `Workspace root is not a directory: ${this.opts.workspaceRoot}` };
    }
    const probe = await probeContainerRuntime({ binary: this.runtime.binary });
    return probe.ok
      ? { ok: true, detail: this.environment.description }
      : { ok: false, detail: probe.detail };
  }

  /** Container names this backend has started, for leak assertions in tests. */
  get startedContainers(): readonly string[] {
    return this.containerProcess.startedNames;
  }

  async containerExists(name: string): Promise<boolean> {
    return this.containerProcess.exists(name);
  }

  async close(): Promise<void> {
    // Anything still running is a leak; remove it rather than leaving it to a
    // human to notice. `--rm` has usually already done this.
    for (const name of this.containerProcess.startedNames) {
      await this.containerProcess.reap(name, true).catch(() => false);
    }
    await this.hostBroker.close();
    await rm(this.scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Platform caveats, phrased so an untested platform is never called equivalent. */
export function platformNotes(runtime: ContainerRuntimeInfo, config: ContainerConfig): string[] {
  const notes: string[] = [];
  if (runtime.nativeLinux) {
    notes.push(
      `Native Linux ${runtime.binary} ${runtime.serverVersion} (kernel ${runtime.kernelVersion}): the ` +
        'mount and network namespaces are enforced by this host kernel.',
    );
  } else {
    notes.push(
      `${runtime.operatingSystem} runs the daemon in a virtual machine (kernel ${runtime.kernelVersion}), ` +
        'so the host boundary is mediated by that VM and its file-sharing layer. Container execution is ' +
        'validated here; native-Linux-equivalent isolation is not claimed.',
    );
  }
  if (runtime.rootless) notes.push('The daemon is running rootless.');
  notes.push(`Image: ${config.image}. Chosen by configuration, never by the model.`);
  return notes;
}

/** Resolve `[generated_paths]` globs to existing top-level directories. */
export async function resolveGeneratedDirs(
  fs: FileSystemBackend,
  workspaceRoot: CanonicalPath,
  patterns: readonly string[],
): Promise<CanonicalPath[]> {
  const out: CanonicalPath[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    // Only the leading literal segment is used. A glob cannot be a mount
    // boundary, and inventing one by expanding `**` would produce a mount set
    // that changes shape as files appear.
    const head = pattern.split('/')[0];
    if (!head || head.includes('*') || head === '..' || head === '.') continue;
    const candidate = path.join(workspaceRoot, head) as CanonicalPath;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const s = await fs.stat(candidate);
    if (s?.isDirectory) out.push(candidate);
  }
  return out;
}

/**
 * Find protected paths that live *inside* the workspace, so they can be masked.
 *
 * Bounded on purpose. This runs before every containerised execution, and an
 * unbounded walk of a large repository would make every shell call slow — the
 * mistake the mutation detector's scan strategy already learned. Depth and entry
 * limits are conservative because the paths this is looking for are, by their
 * nature, near the top: `.env`, `id_rsa`, `service-account.json`.
 */
export async function discoverMaskPaths(
  fs: FileSystemBackend,
  workspaceRoot: CanonicalPath,
  isProtected: (p: CanonicalPath) => boolean,
  opts: { maxDepth?: number; maxEntries?: number; skipDirs?: readonly string[] } = {},
): Promise<CanonicalPath[]> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? 4_000;
  const skip = new Set(opts.skipDirs ?? ['node_modules', '.git', 'dist', 'build', 'target', 'coverage']);

  const found: CanonicalPath[] = [];
  let seen = 0;

  const walk = async (dir: CanonicalPath, depth: number): Promise<void> => {
    if (depth > maxDepth || seen >= maxEntries) return;
    let entries;
    try {
      entries = await fs.listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) return;
      seen += 1;
      const child = path.join(dir, entry.name) as CanonicalPath;
      if (isProtected(child)) {
        found.push(child);
        continue;
      }
      if (entry.isDirectory && !entry.isSymlink && !skip.has(entry.name)) {
        await walk(child, depth + 1);
      }
    }
  };

  await walk(workspaceRoot, 0);
  return found;
}

/** For `/status`: the writable roots, as workspace-relative display paths. */
export function summarizeWritableRoots(plan: ContainerMountPlan, workspaceRoot: string): string[] {
  return plan.mounts
    .filter((m) => m.mode === 'rw')
    .map((m) => {
      const rel = toPosix(m.hostPath).slice(toPosix(workspaceRoot).length).replace(/^\//, '');
      return rel === '' ? '.' : rel;
    });
}

export type { ContainerPlan, ContainerMountPlan } from './container-plan.ts';
