/**
 * Credential-file checks, per platform (alpha.3 §6, threat model).
 *
 * In the smoke suite because it is the one suite that runs on **Windows** in CI,
 * and Windows is where the honest answer differs.
 *
 * The permission rule — mode 0600 or stricter — has no meaning without POSIX
 * mode bits, so on Windows it is skipped and `mode` comes back undefined. That is
 * a real gap, and it was previously recorded only as prose in
 * `docs/threat-model.md` and as a `NOT TESTED` row. Prose is what alpha.2 proved
 * unreliable, so this file turns the gap into an assertion: on Windows the mode
 * check is *expected* to be absent, and every other rule is *expected* to still
 * apply.
 *
 * The value is directional. If someone later implements an ACL-based check, the
 * Windows expectation here fails and has to be updated deliberately — which is
 * the point. And if the *other* rules ever stop applying on Windows, that fails
 * too, which is the part that would otherwise go unnoticed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { checkCredentialFile } from '../../src/security/credential-file.ts';
import { toKernelError } from '../../src/util/errors.ts';
import { canonicalize } from '../../src/util/paths.ts';

const WINDOWS = process.platform === 'win32';

describe('credential file checks that apply on every platform', () => {
  test('a plain readable file is accepted, and mode is reported only where it exists', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'cred-platform-'));
    try {
      const file = path.join(base, 'ok.key');
      await writeFile(file, 'sk-platform-probe\n', 'utf8');
      if (!WINDOWS) await chmod(file, 0o600);

      const info = await checkCredentialFile(file, { cwd: base });
      assert.ok(info.path.endsWith('ok.key'));

      if (WINDOWS) {
        // The documented gap, asserted rather than assumed. There are no POSIX
        // mode bits here, so "no other local account can read this" is a
        // property this platform does not give us.
        assert.equal(
          info.mode,
          undefined,
          'a mode was reported on Windows; if an ACL check was added, update this expectation and the threat model',
        );
      } else {
        assert.equal(info.mode, 0o600);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('a directory is refused on every platform', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'cred-platform-'));
    try {
      const dir = path.join(base, 'a-dir');
      await mkdir(dir, { recursive: true });

      await assert.rejects(
        () => checkCredentialFile(dir, { cwd: base }),
        (e: unknown) => {
          const err = toKernelError(e);
          assert.equal(err.code, 'CREDENTIAL_FILE_INSECURE');
          assert.equal(err.safeDetails?.problem, 'directory');
          return true;
        },
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('a missing file is refused on every platform', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'cred-platform-'));
    try {
      await assert.rejects(
        () => checkCredentialFile(path.join(base, 'nope.key'), { cwd: base }),
        (e: unknown) => {
          assert.equal(toKernelError(e).safeDetails?.problem, 'missing');
          return true;
        },
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('a workspace-local credential is refused on every platform', async () => {
    // The rule that does *not* depend on mode bits, and the one that protects
    // against the worst outcome: a key committed to the repository.
    const base = await mkdtemp(path.join(tmpdir(), 'cred-platform-'));
    try {
      const workspace = (await canonicalize(path.join(base, 'ws'), { cwd: base })).path;
      await mkdir(workspace, { recursive: true });
      const inside = path.join(workspace, 'k.key');
      await writeFile(inside, 'sk-inside\n', 'utf8');
      if (!WINDOWS) await chmod(inside, 0o600);

      await assert.rejects(
        () => checkCredentialFile(inside, { cwd: base, workspaceRoot: workspace }),
        (e: unknown) => {
          assert.equal(toKernelError(e).safeDetails?.problem, 'inside-workspace');
          return true;
        },
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('the mode check is skipped only where the platform lacks mode bits', async () => {
    // Guards the *reason* rather than the outcome: `skipModeCheck` must be driven
    // by the platform, not left permanently on by an unrelated change.
    const base = await mkdtemp(path.join(tmpdir(), 'cred-platform-'));
    try {
      const file = path.join(base, 'loose.key');
      await writeFile(file, 'sk-loose\n', 'utf8');
      if (!WINDOWS) await chmod(file, 0o644);

      // Forced on: accepted regardless of platform, which is what makes the
      // Windows behaviour a *skip* rather than a silent pass.
      const forced = await checkCredentialFile(file, { cwd: base, skipModeCheck: true });
      assert.equal(forced.mode, undefined);

      if (!WINDOWS) {
        // Forced off on POSIX: the same file is refused.
        await assert.rejects(
          () => checkCredentialFile(file, { cwd: base, skipModeCheck: false }),
          (e: unknown) => {
            assert.equal(toKernelError(e).safeDetails?.problem, 'permissive-mode');
            return true;
          },
        );
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
