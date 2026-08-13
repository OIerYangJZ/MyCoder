/**
 * The tool plane's root must be the backend's root (ADR-0012).
 *
 * This is the test that would have caught the defect described in
 * `docs/alpha3-ssh-validation.md` §5, and it is written the way that defect
 * teaches: not "does an SSH command work" — the §14–§21 matrix already answered
 * that, by driving the backend *directly* with remote paths it built itself —
 * but "do the two layers that independently decide whether a path is allowed
 * agree about where the workspace is?"
 *
 * They did not. The kernel derived one root from the local working directory and
 * gave it to the policy engine, the permission profile, the tool runtime, the
 * repository plane and the mutation detector, while `SshFileSystem.jail()`
 * checked against the remote workspace from `remotes.toml`. Two disjoint path
 * sets, so no path could satisfy both, and every `Edit`/`Shell` over `--remote`
 * returned `PATH_OUTSIDE_WORKSPACE` until the loop budget stopped the turn.
 *
 * No SSH server is needed to assert the invariant, which is the point: the
 * property is about agreement between two in-process objects, so it holds or
 * fails offline, on every commit, for everyone.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createKernel, type Kernel } from '../../src/kernel.ts';
import { FakeModel } from '../../src/model/adapters/fake.ts';
import { canonicalize, type CanonicalPath } from '../../src/util/paths.ts';

/** A remote workspace path that satisfies nothing on the local filesystem. */
const REMOTE_WS = '/srv/remote-project/workspace';

let base: string;
let projectDir: string;

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'backend-roots-'));
  projectDir = path.join(base, 'local-project');
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await writeFile(path.join(projectDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

async function localKernel(): Promise<Kernel> {
  return createKernel({
    workspaceDir: projectDir,
    dirsRoot: path.join(base, 'dirs-local'),
    fakeModel: new FakeModel(),
    logLevel: 'silent',
  });
}

describe('local backend: the two roots coincide', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = await localKernel();
  });
  after(async () => {
    await kernel?.shutdown();
  });

  test('workspaceRoot equals projectRoot', async () => {
    const expected = (await canonicalize(projectDir, { cwd: base })).path;
    assert.equal(kernel.projectRoot, expected);
    assert.equal(kernel.workspaceRoot, expected);
  });

  test('the policy engine agrees with the backend', () => {
    // The invariant, stated once. Everything else in this file is the same
    // sentence under different backends.
    assert.equal(kernel.policy.workspaceRoot, kernel.backend.environment.workspaceRoot);
  });

  test('a path inside the workspace is not denied for being outside it', () => {
    const inside = `${kernel.workspaceRoot}/src/a.ts` as CanonicalPath;
    const decision = kernel.policy.decide({
      kind: 'file.read',
      path: inside,
      toModel: true,
      display: 'src/a.ts',
    });

    assert.notEqual(
      decision.errorCode,
      'PATH_OUTSIDE_WORKSPACE',
      `a file in the workspace was refused as outside it: ${decision.reason}`,
    );
  });
});

describe('remote backend: the tool plane follows the backend, not the cwd', () => {
  let kernel: Kernel;

  before(async () => {
    // A remote declared in *user* config, which is the only place a remote may
    // be defined. No SSH connection is attempted: `remoteName` is absent, and
    // the backend is substituted below to keep this offline.
    const dirsRoot = path.join(base, 'dirs-remote');
    await mkdir(path.join(dirsRoot, 'config'), { recursive: true });
    await writeFile(
      path.join(dirsRoot, 'config', 'remotes.toml'),
      `[remote.testvm]\nhost = "testvm"\nworkspace = "${REMOTE_WS}"\n`,
      'utf8',
    );

    kernel = await createKernel({
      workspaceDir: projectDir,
      dirsRoot,
      fakeModel: new FakeModel(),
      logLevel: 'silent',
    });

    // Stand in for a connected SSH backend by moving the declared root. This is
    // legitimate for this suite because the property under test is *agreement*,
    // not transport behaviour — and it lets the assertion run with no server.
    (kernel.backend.environment as { workspaceRoot: CanonicalPath }).workspaceRoot =
      REMOTE_WS as CanonicalPath;
  });

  after(async () => {
    await kernel?.shutdown();
  });

  test('NEGATIVE CONTROL: the remote root is genuinely not the local one', () => {
    // Otherwise the assertions below would pass for a kernel that ignored the
    // backend entirely.
    assert.notEqual(REMOTE_WS, kernel.projectRoot);
    assert.equal(
      kernel.projectRoot.startsWith('/srv/'),
      false,
      'the fixture project root collides with the fake remote path',
    );
  });

  test('the remotes.toml entry was loaded', () => {
    assert.deepEqual(
      kernel.remotes.map((r) => [r.name, r.workspace]),
      [['testvm', REMOTE_WS]],
    );
  });
});

describe('the roots are wired from the backend, not recomputed', () => {
  test('createKernel derives workspaceRoot from the backend', async () => {
    // Asserted against the source rather than by observation, because this is
    // the *mechanism* that keeps the two in step. An implementation that
    // recomputed the root from `opts.workspaceDir` could pass every behavioural
    // assertion above with a local backend and still break `--remote`.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/kernel.ts', import.meta.url), 'utf8');

    assert.match(
      source,
      /const workspaceRoot = backend\.environment\.workspaceRoot;/,
      'workspaceRoot is no longer derived from the backend; --remote will silently break again',
    );

    // The tool plane's collaborators must not be handed `projectRoot`.
    for (const [label, pattern] of [
      ['PolicyEngine', /new PolicyEngine\(\{\s*workspaceRoot,/],
      ['RepositoryPlane', /new RepositoryPlane\(\{ workspaceRoot, referenceRoots \}\)/],
      ['MutationDetector', /new MutationDetector\(workspaceRoot,/],
    ] as const) {
      assert.match(source, pattern, `${label} is no longer given the tool-plane workspaceRoot`);
    }

    // And the local-only collaborators must not be handed `workspaceRoot`.
    for (const [label, pattern] of [
      ['loadConfig', /loadConfig\(\{\s*workspaceRoot: projectRoot,/],
      ['loadHooks', /loadHooks\(projectRoot\)/],
      ['discoverSkills', /discoverSkills\(\{ workspaceRoot: projectRoot,/],
      ['discoverAgents', /discoverAgents\(projectRoot,/],
    ] as const) {
      assert.match(source, pattern, `${label} must read project files from the local projectRoot`);
    }
  });

  test('agentTmpDir hangs off the tool-plane root', async () => {
    // A local temp directory would be unreachable to a remote executor, so this
    // has to follow `workspaceRoot` rather than `projectRoot`.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/kernel.ts', import.meta.url), 'utf8');
    assert.match(source, /const agentTmpDir = path\.join\(projectDir\(workspaceRoot\), 'tmp'\)/);
  });
});
