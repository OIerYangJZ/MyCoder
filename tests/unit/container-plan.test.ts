/**
 * Container plan unit suite (alpha.5 §50, §60, §61, §62, §7).
 *
 * Everything here runs with no Docker daemon, on every platform, because
 * everything here is a pure function of a capability profile. That is deliberate:
 * §60 says not to leave security to Docker CLI string assembly, and the way to
 * avoid that is to make the security-relevant decisions testable without the
 * runtime that would otherwise have to be present for anyone to check them.
 *
 * The live suite (`tests/live/container-*.test.ts`) then proves the plans this
 * file asserts actually behave as claimed when a daemon executes them. Neither
 * suite is sufficient alone: this one cannot tell you Docker honours
 * `--network none`, and that one cannot enumerate profile shapes cheaply.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';

import type { CanonicalPath } from '../../src/util/paths.ts';
import type { CapabilityProfile } from '../../src/execution/backend.ts';
import {
  buildContainerPlan,
  containerName,
  dockerRunArgs,
  planContainerMounts,
  sortMounts,
  toContainerPath,
  toHostPath,
  translateArgvPaths,
  validateContainerPlan,
  CONTAINER_WORKSPACE,
  type ContainerMountPlan,
  type ContainerPlan,
  type MountPlannerHost,
} from '../../src/execution/container-plan.ts';
import {
  atLeast,
  containerEnforcement,
  describeEnforcement,
  localEnforcement,
  networkEnforcementLabel,
  sshEnforcement,
  summarizeEnforcement,
  weakest,
} from '../../src/execution/enforcement.ts';
import {
  classifyDockerError,
  resolveGeneratedDirs,
  discoverMaskPaths,
} from '../../src/execution/container.ts';
import { LocalExecutionBackend } from '../../src/execution/local.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';

let base: string;
let workspace: string;
let host: MountPlannerHost;

const profile = (over: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
  readRoots: [workspace as CanonicalPath],
  writeRoots: [],
  allowExec: true,
  network: false,
  envAllow: [],
  secretInjections: [],
  timeoutMs: 30_000,
  maxOutputBytes: 1024,
  ...over,
});

const planFor = async (
  p: CapabilityProfile,
  opts: Parameters<typeof planContainerMounts>[2] extends infer O ? Partial<O> : never = {},
): Promise<ContainerMountPlan> =>
  planContainerMounts(p, host, { workspaceRoot: workspace as CanonicalPath, ...opts });

before(async () => {
  const { realpath: resolveLink } = await import('node:fs/promises');
  // Resolved through symlinks, exactly as the kernel canonicalises a workspace
  // root before it reaches the planner. Skipping this makes every case pass or
  // fail for the wrong reason on macOS, where `os.tmpdir()` is `/var/folders/…`
  // and `/var` is a link to `/private/var`: the planner resolves a write root and
  // compares it against an unresolved root, so every mount looks like an escape.
  base = await resolveLink(await mkdtemp(path.join(tmpdir(), 'container-plan-test-')));
  workspace = path.join(base, 'workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(path.join(workspace, 'tests'), { recursive: true });
  await mkdir(path.join(workspace, 'dist'), { recursive: true });
  await mkdir(path.join(workspace, '.git'), { recursive: true });
  await mkdir(path.join(workspace, 'nested', 'deep'), { recursive: true });
  await mkdir(path.join(base, 'outside'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{}', 'utf8');
  await writeFile(path.join(workspace, '.env'), 'SECRET=x', 'utf8');
  await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const a = 1;', 'utf8');
  await writeFile(path.join(base, 'outside', 'secret.txt'), 'nope', 'utf8');
  await symlink(path.join(base, 'outside'), path.join(workspace, 'escape'));

  const { realpath, stat } = await import('node:fs/promises');
  host = {
    realpath: async (p) => {
      try {
        return await realpath(p);
      } catch {
        return undefined;
      }
    },
    kind: async (p) => {
      try {
        const s = await stat(p);
        return s.isDirectory() ? 'dir' : 'file';
      } catch {
        return undefined;
      }
    },
  };
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('mount planning — §60', () => {
  test('a read-only profile gets exactly one mount, and it is read-only', async () => {
    const plan = await planFor(profile({ writeRoots: [] }));
    assert.equal(plan.mounts.length, 1);
    assert.equal(plan.mounts[0]!.mode, 'ro');
    assert.equal(plan.mounts[0]!.containerPath, CONTAINER_WORKSPACE);
    assert.equal(plan.mounts[0]!.origin, 'workspace-base');
  });

  test('a workspace-dev profile gets writable overlays only where write was granted', async () => {
    const plan = await planFor(profile({ writeRoots: [path.join(workspace, 'src') as CanonicalPath] }));
    const writable = plan.mounts.filter((m) => m.mode === 'rw');
    assert.equal(writable.length, 1);
    assert.equal(writable[0]!.containerPath, '/workspace/src');
    // The thing this whole file exists to check: `tests/` was not granted, so it
    // is not writable, even though the "obvious" implementation would have made
    // the entire workspace read-write for every profile alike.
    assert.equal(
      plan.mounts.some((m) => m.containerPath === '/workspace/tests' && m.mode === 'rw'),
      false,
    );
  });

  test('a single writable file becomes a file mount, not a writable parent directory', async () => {
    const plan = await planFor(
      profile({ writeRoots: [path.join(workspace, 'package.json') as CanonicalPath] }),
    );
    const mount = plan.mounts.find((m) => m.containerPath === '/workspace/package.json');
    assert.ok(mount, 'package.json should be mounted');
    assert.equal(mount.mode, 'rw');
    assert.equal(mount.isFile, true);
    // Granting the file must not have made the workspace root writable.
    assert.equal(plan.mounts.find((m) => m.containerPath === CONTAINER_WORKSPACE)!.mode, 'ro');
  });

  test('a nested writable root sits inside the read-only parent, and is ordered after it', async () => {
    const plan = await planFor(
      profile({ writeRoots: [path.join(workspace, 'nested', 'deep') as CanonicalPath] }),
    );
    const paths = plan.mounts.map((m) => m.containerPath);
    assert.deepEqual(paths, ['/workspace', '/workspace/nested/deep']);
  });

  test('generated directories are writable only for a profile that can execute', async () => {
    const generated = [path.join(workspace, 'dist') as CanonicalPath];
    const withExec = await planFor(profile({ allowExec: true }), { generatedDirs: generated });
    assert.ok(withExec.mounts.some((m) => m.containerPath === '/workspace/dist' && m.mode === 'rw'));

    const withoutExec = await planFor(profile({ allowExec: false }), { generatedDirs: generated });
    assert.equal(
      withoutExec.mounts.some((m) => m.containerPath === '/workspace/dist'),
      false,
      'a profile that cannot run anything has no use for a writable build directory',
    );
  });

  test('write on the workspace root is refused and reported, never widened', async () => {
    const plan = await planFor(profile({ writeRoots: [workspace as CanonicalPath] }));
    assert.equal(plan.mounts.length, 1);
    assert.equal(plan.mounts[0]!.mode, 'ro');
    assert.equal(plan.unrepresented.length, 1);
    assert.match(plan.unrepresented[0]!.reason, /workspace root/);
  });

  test('write on .git is refused: the repository metadata stays read-only', async () => {
    const plan = await planFor(profile({ writeRoots: [path.join(workspace, '.git') as CanonicalPath] }));
    assert.equal(
      plan.mounts.some((m) => m.containerPath.startsWith('/workspace/.git')),
      false,
    );
    assert.match(plan.unrepresented[0]!.reason, /read-only/);
  });

  test('a symlink out of the workspace resolves before the containment check, and is refused', async () => {
    const plan = await planFor(profile({ writeRoots: [path.join(workspace, 'escape') as CanonicalPath] }));
    assert.equal(plan.mounts.length, 1, 'nothing outside the workspace may be mounted');
    assert.match(plan.unrepresented[0]!.reason, /outside the workspace/);
  });

  test('a write root outside the workspace is refused', async () => {
    const plan = await planFor(profile({ writeRoots: [path.join(base, 'outside') as CanonicalPath] }));
    assert.equal(plan.mounts.length, 1);
    assert.equal(plan.unrepresented[0]!.kind, 'write');
  });

  test('a write root that does not exist is refused rather than created by the daemon', async () => {
    const plan = await planFor(
      profile({ writeRoots: [path.join(workspace, 'does-not-exist') as CanonicalPath] }),
    );
    assert.equal(plan.mounts.length, 1);
    assert.match(plan.unrepresented[0]!.reason, /does not exist/);
  });

  test('duplicate write roots produce one mount', async () => {
    const src = path.join(workspace, 'src') as CanonicalPath;
    const plan = await planFor(profile({ writeRoots: [src, src, src] }));
    assert.equal(plan.mounts.filter((m) => m.containerPath === '/workspace/src').length, 1);
  });

  test('a protected path inside the workspace is masked, not merely denied', async () => {
    const plan = await planFor(profile(), {
      maskPaths: [path.join(workspace, '.env') as CanonicalPath],
      maskFileHostPath: path.join(base, 'empty'),
    });
    const mask = plan.mounts.find((m) => m.containerPath === '/workspace/.env');
    assert.ok(mask, '.env must be masked out of the base mount');
    assert.equal(mask.origin, 'mask');
    assert.equal(mask.mode, 'ro');
    assert.equal(mask.hostPath, path.join(base, 'empty'));
  });

  test('a path that is both protected and granted for writing ends up masked, not writable', async () => {
    const env = path.join(workspace, '.env') as CanonicalPath;
    const plan = await planFor(profile({ writeRoots: [env] }), {
      maskPaths: [env],
      maskFileHostPath: path.join(base, 'empty'),
    });
    const mounts = plan.mounts.filter((m) => m.containerPath === '/workspace/.env');
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0]!.origin, 'mask');
    assert.ok(plan.unrepresented.some((u) => /protected path/.test(u.reason)));
  });

  test('read roots outside the workspace are reported, not mounted', async () => {
    const plan = await planFor(
      profile({ readRoots: [workspace as CanonicalPath, path.join(base, 'outside') as CanonicalPath] }),
    );
    assert.equal(plan.mounts.length, 1);
    assert.ok(plan.unrepresented.some((u) => u.kind === 'read'));
  });

  test('tmpfs is always present, sized and bounded', async () => {
    const plan = await planFor(profile());
    const tmp = plan.tmpfs.find((t) => t.containerPath === '/tmp');
    assert.ok(tmp);
    assert.ok(tmp.sizeBytes > 0);
    assert.equal(tmp.mode, 0o1777);
  });

  test('mounts are ordered parent before child', () => {
    const sorted = sortMounts([
      { hostPath: '/w/a/b', containerPath: '/workspace/a/b', mode: 'rw', origin: 'write-root' },
      { hostPath: '/w', containerPath: '/workspace', mode: 'ro', origin: 'workspace-base' },
      { hostPath: '/w/a', containerPath: '/workspace/a', mode: 'rw', origin: 'write-root' },
    ]);
    assert.deepEqual(
      sorted.map((m) => m.containerPath),
      ['/workspace', '/workspace/a', '/workspace/a/b'],
    );
  });
});

describe('path translation', () => {
  test('workspace paths map into the container, and nothing else does', () => {
    assert.equal(toContainerPath('/w', '/w'), '/workspace');
    assert.equal(toContainerPath('/w', '/w/src/a.ts'), '/workspace/src/a.ts');
    assert.equal(toContainerPath('/w', '/other/a.ts'), undefined);
    assert.equal(toContainerPath('/w', '/w/../etc/passwd'), undefined);
    assert.equal(toHostPath('/w', '/workspace/src/a.ts'), '/w/src/a.ts');
    assert.equal(toHostPath('/w', '/etc/passwd'), undefined);
  });

  test('absolute argv tokens inside the workspace are rewritten; others are left to fail', () => {
    const { argv, translated } = translateArgvPaths(
      ['node', '--test', '/w/tests/a.test.ts', '/etc/passwd', 'relative/path'],
      '/w' as CanonicalPath,
    );
    assert.deepEqual(argv, [
      'node',
      '--test',
      '/workspace/tests/a.test.ts',
      // Deliberately untouched: it does not exist in the container, which is the
      // enforcement working rather than something to paper over.
      '/etc/passwd',
      'relative/path',
    ]);
    assert.equal(translated, 1);
  });
});

describe('docker argv — §61', () => {
  const basePlan = async (over: Partial<ContainerPlan> = {}): Promise<ContainerPlan> => {
    const mountPlan = await planFor(profile({ writeRoots: [path.join(workspace, 'src') as CanonicalPath] }));
    return {
      ...buildContainerPlan({
        image: { configured: 'node:22-bookworm', digest: 'sha256:abc' },
        mountPlan,
        cwd: workspace as CanonicalPath,
        workspaceRoot: workspace as CanonicalPath,
        env: { PATH: '/usr/bin', HOME: '/tmp' },
        argv: ['sh', '-c', 'echo hi'],
        timeoutMs: 30_000,
        network: 'none',
        user: '1000:1000',
        limits: { pids: 256, memoryBytes: 1024, cpus: 1 },
        name: 'mycoder-test',
      }),
      ...over,
    };
  };

  test('every required hardening flag is present', async () => {
    const args = dockerRunArgs(await basePlan());
    const line = args.join(' ');
    for (const flag of [
      '--rm',
      '--network none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--user 1000:1000',
      '--pids-limit 256',
      '--memory 1024',
      '--cpus 1',
      '--tmpfs /tmp:',
      '--workdir /workspace',
      '--entrypoint sh',
    ]) {
      assert.ok(line.includes(flag), `expected ${flag} in: ${line}`);
    }
  });

  test('every forbidden flag is absent', async () => {
    const line = dockerRunArgs(await basePlan()).join(' ');
    for (const forbidden of [
      '--privileged',
      '--network host',
      '--pid host',
      '--ipc host',
      '--userns host',
      'docker.sock',
      '--cap-add',
      'SSH_AUTH_SOCK',
      '--device',
    ]) {
      assert.ok(!line.includes(forbidden), `did not expect ${forbidden} in: ${line}`);
    }
  });

  test('the workspace is mounted read-only and the granted root is not', async () => {
    const args = dockerRunArgs(await basePlan());
    const mounts = args.filter((a) => a.startsWith('type=bind'));
    const baseMount = mounts.find((m) => m.includes(`target=${CONTAINER_WORKSPACE},`));
    assert.ok(baseMount?.endsWith('readonly'));
    assert.ok(mounts.some((m) => m.includes('target=/workspace/src') && !m.includes('readonly')));
  });

  test('a secret is passed by name, never as a value on the command line', async () => {
    const plan = await basePlan({ envPassthrough: ['GITHUB_TOKEN'] });
    const args = dockerRunArgs(plan);
    // The value-less form: docker reads it from the client process's own
    // environment, so it never appears in the host process table.
    assert.ok(args.includes('GITHUB_TOKEN'));
    assert.equal(
      args.some((a) => a.startsWith('GITHUB_TOKEN=')),
      false,
    );
  });

  test("the container name is sanitised into Docker's charset", () => {
    assert.match(containerName('mycoder', 'abc/../def'), /^mycoder-abc-\.\.-def$/);
    assert.match(containerName('mycoder', '--flag'), /^mycoder---flag$/);
    assert.ok(/^[A-Za-z0-9]/.test(containerName('mycoder', 'x')));
  });
});

describe('plan validation — §50', () => {
  const validateWith = async (mutate: (plan: ContainerPlan) => void): Promise<string[]> => {
    const mountPlan = await planFor(profile());
    const plan = buildContainerPlan({
      image: { configured: 'node:22-bookworm' },
      mountPlan,
      cwd: workspace as CanonicalPath,
      workspaceRoot: workspace as CanonicalPath,
      env: {},
      argv: ['sh'],
      timeoutMs: 1_000,
      network: 'none',
      name: 'mycoder-test',
    });
    mutate(plan);
    return validateContainerPlan(plan, {
      workspaceRoot: workspace as CanonicalPath,
      allowedImages: ['node:22-bookworm'],
    }).problems;
  };

  test('a well-formed plan validates', async () => {
    assert.deepEqual(await validateWith(() => {}), []);
  });

  test('a Docker socket mount is refused', async () => {
    const problems = await validateWith((plan) => {
      (plan.mounts as ContainerPlan['mounts'][number][]).push({
        hostPath: '/var/run/docker.sock',
        containerPath: '/workspace/sock',
        mode: 'rw',
        origin: 'write-root',
      });
    });
    assert.ok(problems.some((p) => /forbidden host location|outside the workspace/.test(p)));
  });

  test('a host root mount is refused', async () => {
    const problems = await validateWith((plan) => {
      (plan.mounts as ContainerPlan['mounts'][number][]).push({
        hostPath: '/',
        containerPath: '/workspace/host',
        mode: 'ro',
        origin: 'write-root',
      });
    });
    assert.ok(problems.length > 0);
  });

  test('an ssh directory mount is refused', async () => {
    const problems = await validateWith((plan) => {
      (plan.mounts as ContainerPlan['mounts'][number][]).push({
        hostPath: '/home/someone/.ssh',
        containerPath: '/workspace/keys',
        mode: 'ro',
        origin: 'write-root',
      });
    });
    assert.ok(problems.some((p) => /forbidden host location|outside the workspace/.test(p)));
  });

  test('a mount escaping /workspace is refused', async () => {
    const problems = await validateWith((plan) => {
      (plan.mounts as ContainerPlan['mounts'][number][]).push({
        hostPath: workspace,
        containerPath: '/etc',
        mode: 'rw',
        origin: 'write-root',
      });
    });
    assert.ok(problems.some((p) => /system directory|outside \/workspace/.test(p)));
  });

  test('a writable .git is refused', async () => {
    const problems = await validateWith((plan) => {
      (plan.mounts as ContainerPlan['mounts'][number][]).push({
        hostPath: path.join(workspace, '.git'),
        containerPath: '/workspace/.git',
        mode: 'rw',
        origin: 'write-root',
      });
    });
    assert.ok(problems.some((p) => /read-write/.test(p)));
  });

  test('a read-write workspace base is refused', async () => {
    const problems = await validateWith((plan) => {
      (plan.mounts[0] as { mode: string }).mode = 'rw';
    });
    assert.ok(problems.some((p) => /base mount is read-write/.test(p)));
  });

  test('dropping a hardening flag is refused', async () => {
    for (const key of ['readOnlyRoot', 'capDropAll', 'noNewPrivileges', 'removeOnExit'] as const) {
      const problems = await validateWith((plan) => {
        (plan as unknown as Record<string, boolean>)[key] = false;
      });
      assert.ok(problems.length > 0, `${key} = false must be refused`);
    }
  });

  test('an untrusted image is refused', async () => {
    const problems = await validateWith((plan) => {
      (plan.image as { configured: string }).configured = 'evil/backdoored';
    });
    assert.ok(problems.some((p) => /not one of the trusted images/.test(p)));
  });

  test('a cwd outside the workspace is refused', async () => {
    const problems = await validateWith((plan) => {
      (plan as { cwd: string }).cwd = '/etc';
    });
    assert.ok(problems.some((p) => /working directory/.test(p)));
  });

  test('an ungranted environment passthrough is refused', async () => {
    const problems = await validateWith((plan) => {
      (plan as { envPassthrough: readonly string[] }).envPassthrough = ['AWS_SECRET_ACCESS_KEY'];
    });
    assert.ok(problems.some((p) => /passthrough/.test(p)));
  });

  test('a protected host path given as an exact path is refused', async () => {
    const mountPlan = await planFor(profile());
    const plan = buildContainerPlan({
      image: { configured: 'node:22-bookworm' },
      mountPlan,
      cwd: workspace as CanonicalPath,
      workspaceRoot: workspace as CanonicalPath,
      env: {},
      argv: ['sh'],
      timeoutMs: 1_000,
      network: 'none',
      name: 'mycoder-test',
    });
    const result = validateContainerPlan(plan, {
      workspaceRoot: workspace as CanonicalPath,
      allowedImages: ['node:22-bookworm'],
      // The base mount is the workspace itself; declaring it protected is
      // artificial, and it is exactly how the check would fire for a credential
      // file that a bug allowed into the plan.
      protectedHostPaths: [workspace],
    });
    assert.equal(result.ok, false);
  });
});

describe('enforcement descriptor — §7', () => {
  test('levels are ordered and comparable', () => {
    assert.equal(weakest('container-enforced', 'best-effort'), 'best-effort');
    assert.equal(atLeast('container-enforced', 'policy-enforced'), true);
    assert.equal(atLeast('policy-enforced', 'container-enforced'), false);
  });

  test('the local backend never claims isolation', () => {
    const d = localEnforcement();
    assert.equal(summarizeEnforcement(d), 'policy-enforced');
    assert.equal(networkEnforcementLabel(d), 'best-effort');
    assert.match(describeEnforcement(d).caveat, /not OS-isolated/);
  });

  test('the ssh backend is honest about the remote jail being policy', () => {
    const d = sshEnforcement('example');
    assert.equal(summarizeEnforcement(d), 'policy-enforced');
    assert.equal(d.processFilesystem, 'policy-enforced');
  });

  test('a container reports the filesystem as container-enforced and the broker as policy-enforced', () => {
    const d = containerEnforcement({
      networkDenied: true,
      privilegesRestricted: true,
      readOnlyRoot: true,
      platformNotes: ['note'],
    });
    assert.equal(d.processFilesystem, 'container-enforced');
    assert.equal(d.processNetwork, 'container-enforced');
    // §28: Read/Edit are trusted kernel operations on the host filesystem, and
    // saying otherwise would be the exact overclaim the descriptor exists to stop.
    assert.equal(d.hostFileBroker, 'policy-enforced');
    // §23: this is release-critical and stays best-effort until there is an
    // egress proxy inside the network namespace.
    assert.equal(d.networkAllowlist, 'best-effort');
    assert.equal(summarizeEnforcement(d), 'container-enforced');
  });

  test('a container with network enabled does not claim network enforcement', () => {
    const d = containerEnforcement({
      networkDenied: false,
      privilegesRestricted: true,
      readOnlyRoot: true,
      platformNotes: [],
    });
    assert.equal(d.processNetwork, 'none');
    assert.equal(networkEnforcementLabel(d), 'unenforced');
    // The summary drops back, because the weakest process-facing dimension is
    // what a summary is allowed to claim.
    assert.equal(summarizeEnforcement(d), 'policy-enforced');
  });

  test('the rendered description names every dimension, and never says "enforced" for policy', () => {
    const summary = describeEnforcement(
      containerEnforcement({
        networkDenied: true,
        privilegesRestricted: true,
        readOnlyRoot: true,
        platformNotes: ['Docker Desktop runs the daemon in a VM.'],
      }),
    );
    assert.equal(summary.lines.length, 6);
    assert.ok(summary.lines.some((l) => l.startsWith('trusted file broker: policy-enforced')));
    assert.ok(summary.caveat.includes('host allowlist is not enforced'));
    assert.ok(summary.caveat.includes('Docker Desktop runs the daemon in a VM.'));
  });
});

describe('docker error mapping — §62', () => {
  const cases: Array<[string, string]> = [
    ['docker: command not found', 'CONTAINER_START_FAILED'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock.', 'CONTAINER_RUNTIME_UNAVAILABLE'],
    [
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
      'CONTAINER_RUNTIME_UNAVAILABLE',
    ],
    ["Unable to find image 'node:22' locally", 'CONTAINER_IMAGE_NOT_FOUND'],
    ['docker: invalid mount config for type "bind"', 'CONTAINER_INVALID_MOUNT'],
    ['unknown flag: --nonexistent', 'CONTAINER_UNSUPPORTED_FEATURE'],
  ];

  for (const [stderr, expected] of cases) {
    test(`"${stderr.slice(0, 40)}…" maps to ${expected}`, () => {
      assert.equal(classifyDockerError({ stderr, exitCode: 125 }).code, expected);
    });
  }

  test('a missing binary is distinguished from an unreachable daemon', () => {
    const enoent = classifyDockerError({
      stderr: '',
      exitCode: null,
      spawnError: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }),
    });
    assert.equal(enoent.code, 'CONTAINER_RUNTIME_NOT_FOUND');
    assert.equal(enoent.retryable, false);
  });

  test('a container killed for memory is not reported as a start failure', () => {
    assert.equal(classifyDockerError({ stderr: '', exitCode: 137 }).code, 'CONTAINER_RESOURCE_LIMIT');
  });
});

describe('workspace discovery helpers', () => {
  test('generated globs resolve to existing directories only', async () => {
    const fs = new LocalExecutionBackend({
      workspaceRoot: workspace as CanonicalPath,
      redactor: new Redactor(),
    }).fs;
    const dirs = await resolveGeneratedDirs(fs, workspace as CanonicalPath, [
      'dist/**',
      'coverage/**',
      '**/generated/**',
      '../escape/**',
    ]);
    assert.deepEqual(
      dirs.map((d) => path.basename(d)),
      ['dist'],
    );
  });

  test('protected files inside the workspace are discovered for masking', async () => {
    const fs = new LocalExecutionBackend({
      workspaceRoot: workspace as CanonicalPath,
      redactor: new Redactor(),
    }).fs;
    const protectedPaths = new ProtectedPaths({ home: base });
    const found = await discoverMaskPaths(
      fs,
      workspace as CanonicalPath,
      (p) => protectedPaths.checkReadToModel(p).protected,
    );
    assert.ok(found.some((p) => p.endsWith('.env')));
  });
});
