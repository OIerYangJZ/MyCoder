/**
 * Application identity (`src/app.ts`).
 *
 * The name the kernel claims on a filesystem was previously spelled out in ten
 * files. This suite exists so that stays fixed: if a hard-coded `agent` creeps
 * back into a path, a test fails rather than a user's `~/.config` gaining a
 * directory that half a dozen unrelated tools would also want.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import * as path from 'node:path';

import {
  APP_NAME,
  APP_DISPLAY_NAME,
  PROJECT_DIR,
  LEGACY_PROJECT_DIRS,
  projectDir,
  projectDirCandidates,
} from '../../src/app.ts';
import { resolveKernelDirs } from '../../src/util/platform.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';
import { loadConfig } from '../../src/config/config.ts';
import { loadHooks } from '../../src/extensions/hooks.ts';
import { skillSearchPaths } from '../../src/extensions/skills.ts';
import { agentSearchPaths } from '../../src/extensions/agents.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

describe('the app name is specific enough not to collide', () => {
  test('it is not a generic word', () => {
    // `agent`, `cli`, `tool` are names with no owner: whichever tool writes
    // there first wins, and the user cannot tell whose state it is.
    const tooGeneric = ['agent', 'cli', 'tool', 'kernel', 'ai', 'assistant', 'bot'];
    assert.equal(tooGeneric.includes(APP_NAME), false, `"${APP_NAME}" is too generic for ~/.config`);
    assert.match(APP_NAME, /^[a-z][a-z0-9-]{3,}$/, 'must be a safe lowercase path component');
    assert.equal(PROJECT_DIR, `.${APP_NAME}`, 'the project directory should follow the app name');
    assert.equal(APP_DISPLAY_NAME.toLowerCase(), APP_NAME);
  });

  test('every platform derives its directories from the one constant', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const dirs = resolveKernelDirs({ home: '/home/u', platform, env: {} });
      for (const [which, dir] of Object.entries(dirs)) {
        if (which === 'home') continue;
        assert.ok(
          dir.includes(APP_NAME),
          `${platform} ${which} directory "${dir}" does not carry the app name`,
        );
        assert.equal(
          /(^|[/\\])agent([/\\]|$)/.test(dir),
          false,
          `${platform} ${which} still uses the placeholder name`,
        );
      }
    }
  });

  test('the prefixed environment overrides win on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const dirs = resolveKernelDirs({
        home: '/home/u',
        platform,
        env: {
          MYCODER_CONFIG_DIR: '/tmp/c',
          MYCODER_DATA_DIR: '/tmp/d',
          MYCODER_CACHE_DIR: '/tmp/x',
        },
      });
      assert.equal(dirs.config, '/tmp/c', platform);
      assert.equal(dirs.data, '/tmp/d', platform);
      assert.equal(dirs.cache, '/tmp/x', platform);
    }
  });
});

describe('no source file hard-codes the old name', () => {
  test('src/ carries no literal .agent path or ~/.config/agent, except where deliberate', async () => {
    const allowed = new Set([
      'src/app.ts', // defines the legacy fallback
      'src/policy/protected-paths.ts', // protects the legacy directory too
      'src/context/repository-plane.ts', // reads legacy instruction files
    ]);

    const offenders: string[] = [];
    for (const file of await walk(path.join(process.cwd(), 'src'))) {
      const rel = path.relative(process.cwd(), file);
      if (allowed.has(rel)) continue;
      const content = await readFile(file, 'utf8');
      if (/['"`]\.agent['"`]|\.config\/agent\b/.test(content)) offenders.push(rel);
    }

    assert.deepEqual(offenders, [], 'the app name must come from src/app.ts');
  });
});

describe('the legacy project directory still works', () => {
  test('config is read from .agent when .mycoder is absent', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'legacy-dir-'));
    try {
      const workspace = path.join(base, 'workspace');
      await mkdir(path.join(workspace, '.agent'), { recursive: true });
      await writeFile(
        path.join(workspace, '.agent', 'config.toml'),
        '[security]\npermission_profile = "read-only"\n',
        'utf8',
      );

      const loaded = await loadConfig({
        workspaceRoot: workspace as CanonicalPath,
        userConfigDir: path.join(base, 'config'),
      });

      assert.equal(loaded.config.security.permissionProfile, 'read-only');
      assert.ok(loaded.sources.some((s) => s.includes('.agent')));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('the new directory wins when both exist', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'both-dirs-'));
    try {
      const workspace = path.join(base, 'workspace');
      await mkdir(path.join(workspace, '.agent'), { recursive: true });
      await mkdir(path.join(workspace, PROJECT_DIR), { recursive: true });
      await writeFile(path.join(workspace, '.agent', 'config.toml'), '[model]\ndefault = "old"\n', 'utf8');
      await writeFile(path.join(workspace, PROJECT_DIR, 'config.toml'), '[model]\ndefault = "new"\n', 'utf8');

      const loaded = await loadConfig({
        workspaceRoot: workspace as CanonicalPath,
        userConfigDir: path.join(base, 'config'),
      });

      // Unambiguous rather than merged: one file is in effect, and it is the
      // current one.
      assert.equal(loaded.config.model.default, 'new');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('hooks are read from the legacy directory too', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'legacy-hooks-'));
    try {
      const workspace = path.join(base, 'workspace');
      await mkdir(path.join(workspace, '.agent'), { recursive: true });
      await writeFile(
        path.join(workspace, '.agent', 'hooks.toml'),
        '[[hooks]]\nevent = "TurnEnd"\ncommand = ["echo", "hi"]\n',
        'utf8',
      );

      const loaded = await loadHooks(workspace);
      assert.equal(loaded.hooks.length, 1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('skill and agent discovery search both directories, new first', () => {
    const skills = skillSearchPaths('/repo', '/cfg');
    const agents = agentSearchPaths('/repo', '/cfg');

    assert.ok(skills[0]?.includes(PROJECT_DIR), 'the current directory must be searched first');
    assert.ok(skills.some((p) => p.includes(LEGACY_PROJECT_DIRS[0]!)));
    assert.ok(agents[0]?.includes(PROJECT_DIR));
    assert.ok(agents.some((p) => p.includes(LEGACY_PROJECT_DIRS[0]!)));
  });

  test('writes always go to the current directory, never the legacy one', () => {
    assert.equal(projectDir('/repo'), `/repo/${PROJECT_DIR}`);
    assert.equal(projectDirCandidates('/repo')[0], `/repo/${PROJECT_DIR}`);
  });
});

describe('both config directories stay protected', () => {
  test('a session cannot rewrite its own policy under either name', () => {
    const home = homedir();
    const pp = new ProtectedPaths({ home });

    for (const dir of [APP_NAME, 'agent']) {
      const target = path.join(home, '.config', dir, 'permissions.toml');
      assert.equal(
        pp.checkWrite(target as CanonicalPath).protected,
        true,
        `${target} must not be writable from inside a session`,
      );
    }
  });
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
