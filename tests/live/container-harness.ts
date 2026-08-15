/**
 * Container test harness (alpha.5 §35, §37, §59, §65).
 *
 * Two jobs, and the second is the one that matters.
 *
 * The first is ordinary fixture work: a disposable workspace with source files,
 * a protected `.env` inside it, a canary *outside* it, and a wired
 * `ContainerExecutionBackend`.
 *
 * The second is deciding whether a suite may skip. §65 is blunt about this: if
 * the strongest enforcement claim depends on a run, "SKIP" is not an acceptable
 * outcome — a suite that quietly skips on the release machine produces a green
 * CI and an unearned claim. So availability is resolved through
 * `containerRequirement()`, which distinguishes three cases:
 *
 *   required + available   run
 *   required + unavailable **fail**, with the reason
 *   not required           skip, with the reason printed
 *
 * `KERNEL_CONTAINER=1` opts a machine in. `KERNEL_CONTAINER_REQUIRED=1` is what
 * the release job sets, and it turns a missing runtime into a red build.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { canonicalize, type CanonicalPath } from '../../src/util/paths.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';
import { createLogger } from '../../src/util/logger.ts';
import {
  ContainerExecutionBackend,
  defaultContainerConfig,
  discoverMaskPaths,
  probeContainerRuntime,
  resolveGeneratedDirs,
  type ContainerRuntimeInfo,
} from '../../src/execution/container.ts';
import type { CapabilityProfile } from '../../src/execution/backend.ts';
import type { ContainerPlan } from '../../src/execution/container-plan.ts';

/**
 * The value that must never reach a container (§59, §26.1 of the spec).
 *
 * It lives in a file *outside* the workspace, which is the whole point: on the
 * local backend a subprocess can read it with one `cat`, and the only thing
 * standing in the way is the path scanner. Inside a container it is not in the
 * mount namespace at all.
 */
export const HOST_CANARY = 'HOST_CANARY_SECRET_5b81ee27 load-bearing';

/** A second canary, this one *inside* the workspace in a protected file. */
export const WORKSPACE_CANARY = 'WORKSPACE_CANARY_SECRET_a71c02d4 load-bearing';

export const TEST_IMAGE = process.env.KERNEL_CONTAINER_IMAGE ?? 'node:22-bookworm';

export interface ContainerRequirement {
  /** True when the suite should run. */
  run: boolean;
  /** True when a missing runtime must fail rather than skip. */
  required: boolean;
  reason: string;
  info?: ContainerRuntimeInfo;
}

let cached: ContainerRequirement | undefined;

/**
 * Decide whether the container suites run, skip, or fail.
 *
 * Cached because every suite calls it and each call is a `docker version` round
 * trip against the daemon — on Docker Desktop that is 100–300ms, which is
 * several seconds across the matrix for an answer that cannot change mid-run.
 */
export async function containerRequirement(): Promise<ContainerRequirement> {
  if (cached) return cached;

  const required = process.env.KERNEL_CONTAINER_REQUIRED === '1';
  const optedIn = required || process.env.KERNEL_CONTAINER === '1';

  if (!optedIn) {
    cached = {
      run: false,
      required: false,
      reason: 'set KERNEL_CONTAINER=1 to run the container suites (they need a docker runtime)',
    };
    return cached;
  }

  const probe = await probeContainerRuntime({});
  if (!probe.ok || !probe.info) {
    cached = {
      run: false,
      required,
      reason: `docker runtime unusable: ${probe.detail}`,
    };
    return cached;
  }

  cached = { run: true, required, reason: probe.detail, info: probe.info };
  return cached;
}

/**
 * Skip helper with §65 built in.
 *
 * Returns a `{ skip }` object for `node:test`, or throws when the run was
 * declared required — a required suite that cannot run is a failed suite, not an
 * absent one.
 */
export async function containerSkip(): Promise<{ skip?: string }> {
  const requirement = await containerRequirement();
  if (requirement.run) return {};
  if (requirement.required) {
    throw new Error(
      `KERNEL_CONTAINER_REQUIRED=1 but the container suite cannot run: ${requirement.reason}. ` +
        'This is a failure, not a skip: the release claim depends on this evidence (alpha.5 §65).',
    );
  }
  return { skip: requirement.reason };
}

export interface ContainerFixture {
  root: CanonicalPath;
  base: string;
  backend: ContainerExecutionBackend;
  /** Absolute host path of the canary that lives outside the workspace. */
  hostCanaryPath: string;
  /** Absolute host path of the protected `.env` inside the workspace. */
  workspaceSecretPath: string;
  protectedPaths: ProtectedPaths;
  /** Every plan this fixture's backend built, newest last. */
  plans: ContainerPlan[];
  /** A profile granting exec plus writes to the paths named. */
  profile(opts?: Partial<CapabilityProfile>): CapabilityProfile;
  /** Run one command through a fresh executor built from `profile()`. */
  run(
    argv: string[],
    opts?: { profile?: Partial<CapabilityProfile>; cwd?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
  cleanup(): Promise<void>;
}

export interface ContainerFixtureOptions {
  files?: Record<string, string>;
  symlinks?: Record<string, string>;
  /** Extra directories to treat as configured "generated" paths. */
  generated?: string[];
}

export async function createContainerFixture(opts: ContainerFixtureOptions = {}): Promise<ContainerFixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'mycoder-container-test-'));
  const workspace = path.join(base, 'workspace');
  await mkdir(workspace, { recursive: true });

  const files: Record<string, string> = {
    'src/app.ts': 'export const answer = 42;\n',
    'src/util.ts': 'export const twice = (n: number): number => n * 2;\n',
    'tests/app.test.ts': "import { answer } from '../src/app.ts';\nconsole.log(answer);\n",
    'README.md': '# fixture\n',
    'package.json': '{ "name": "fixture", "private": true }\n',
    // Protected by ProtectedPaths' `**/.env` rule, and therefore masked out of
    // the container even though it is inside the mounted workspace (§16).
    '.env': `API_KEY=${WORKSPACE_CANARY}\n`,
    ...(opts.files ?? {}),
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workspace, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await mkdir(path.join(workspace, 'dist'), { recursive: true });

  const { symlink } = await import('node:fs/promises');
  for (const [link, target] of Object.entries(opts.symlinks ?? {})) {
    const full = path.join(workspace, link);
    await mkdir(path.dirname(full), { recursive: true });
    await symlink(target, full);
  }

  // Outside the workspace, beside it: the file a `../` traversal would reach on
  // the local backend.
  const hostCanaryPath = path.join(base, 'host-secret.txt');
  await writeFile(hostCanaryPath, `${HOST_CANARY}\n`, 'utf8');

  const root = (await canonicalize(workspace, { cwd: base })).path;
  const redactor = new Redactor();
  const protectedPaths = new ProtectedPaths({ home: base });

  const { LocalExecutionBackend } = await import('../../src/execution/local.ts');
  const local = await LocalExecutionBackend.detect({ workspaceRoot: root, redactor });
  const generatedDirs = await resolveGeneratedDirs(local.fs, root, ['dist/**', ...(opts.generated ?? [])]);
  const maskScan = await discoverMaskPaths(
    local.fs,
    root,
    (p) => protectedPaths.checkReadToModel(p).protected,
  );
  const maskPaths = maskScan.paths;

  const plans: ContainerPlan[] = [];
  const backend = await ContainerExecutionBackend.create({
    workspaceRoot: root,
    redactor,
    config: { ...defaultContainerConfig(), image: TEST_IMAGE },
    logger: createLogger({ level: 'silent', scope: 'test:container' }),
    generatedDirs,
    maskPaths,
    isProtectedHostPath: (p) => protectedPaths.checkReadToModel(p as CanonicalPath).protected,
    onPlan: (plan) => plans.push(plan),
  });

  const profile = (over: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
    readRoots: [root],
    writeRoots: generatedDirs,
    allowExec: true,
    network: false,
    envAllow: [],
    secretInjections: [],
    timeoutMs: 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
    ...over,
  });

  return {
    root,
    base,
    backend,
    hostCanaryPath,
    workspaceSecretPath: path.join(workspace, '.env'),
    protectedPaths,
    plans,
    profile,

    async run(argv, runOpts = {}) {
      const executor = await backend.enforce(profile(runOpts.profile ?? {}));
      try {
        const result = await executor.exec(
          {
            argv,
            cwd: (runOpts.cwd ?? root) as CanonicalPath,
            timeoutMs: runOpts.timeoutMs ?? 60_000,
          },
          runOpts.signal,
        );
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        };
      } finally {
        executor.dispose();
      }
    },

    async cleanup() {
      await backend.close();
      await local.close();
      // Retried for the same reason `tests/helpers/workspace.ts` retries: the
      // daemon unmounts a bind after the container exits, and removing the
      // former mount target during that window fails with EACCES on macOS.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await rm(base, { recursive: true, force: true });
          return;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (attempt === 9 || (code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw e;
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    },
  };
}

/** A `sh -c` argv, for the attack cases that need a shell to be interesting. */
export function sh(script: string): string[] {
  return ['sh', '-c', script];
}
