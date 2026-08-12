/**
 * The remote workspace guard.
 *
 * `tests/live/ssh-harness.ts` deletes the contents of `KERNEL_SSH_WORKSPACE` on
 * teardown, on a machine that belongs to someone else. That is the only
 * genuinely destructive thing in this repository, and it is driven by an
 * environment variable — one typo or one unexpanded `$FOO` away from being
 * empty or `/`.
 *
 * The original check was `workspace.startsWith('/')`, which `/` satisfies. So
 * `KERNEL_SSH_WORKSPACE=/` would have run `rm -rf /*` on a real VPS.
 *
 * These cases run offline, on every commit, with no VPS and no sshd, because
 * the guard is a pure function and a destructive-action check should not be
 * reachable only by people who happen to rent a server. Each rejection has a
 * matching acceptance, so the guard cannot be "fixed" into one that refuses
 * everything and quietly disables the SSH suite instead.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkRemoteWorkspace } from './ssh-harness.ts';

const HOME = '/home/agent-test';

const rejects = (workspace: string, expected: RegExp, home = HOME): void => {
  const result = checkRemoteWorkspace(workspace, home);
  assert.equal(result.ok, false, `${JSON.stringify(workspace)} was accepted as a deletable workspace`);
  assert.match(result.problem ?? '', expected);
};

const accepts = (workspace: string, home = HOME): void => {
  const result = checkRemoteWorkspace(workspace, home);
  assert.equal(result.ok, true, `${JSON.stringify(workspace)} was rejected: ${result.problem}`);
};

describe('the guard refuses paths cleanup must not touch', () => {
  test('the root directory', () => {
    // The case the old `startsWith('/')` check let through.
    rejects('/', /segment/);
  });

  test('an empty or unexpanded variable', () => {
    // `KERNEL_SSH_WORKSPACE=$NOT_SET` expands to the empty string.
    rejects('', /absolute/);
    rejects('$UNSET/workspaces/ws', /absolute/);
  });

  test('a relative path', () => {
    rejects('workspaces/ws', /absolute/);
    rejects('./ws', /absolute/);
  });

  test('a path containing a traversal segment', () => {
    // Otherwise the effective target could climb out of everything below.
    rejects('/home/agent-test/../../etc', /traversal/);
    rejects('/home/agent-test/ws/..', /traversal/);
  });

  test('a whole user account', () => {
    rejects('/home/agent-test', /segment/);
  });

  test('the home directory, even when it is deep enough', () => {
    rejects('/srv/data/agent-home', /home directory/, '/srv/data/agent-home');
  });

  test('a top-level mount point', () => {
    rejects('/srv', /segment/);
    rejects('/mnt', /segment/);
    rejects('/data', /segment/);
  });

  for (const systemPath of [
    '/etc/agent/ws',
    '/usr/local/ws',
    '/var/lib/agent-ws',
    '/root/ws/inner',
    '/boot/efi/ws',
    '/dev/shm/ws',
    '/proc/1/ws',
    '/sys/fs/ws',
    '/bin/x/y',
    '/sbin/x/y',
    '/lib/x/y',
    '/run/user/ws',
  ]) {
    test(`a system location: ${systemPath}`, () => {
      rejects(systemPath, /system location/);
    });
  }

  test('a trailing slash does not smuggle a short path through', () => {
    // `/srv/` has the same segment count as `/srv`.
    rejects('/srv/', /segment/);
    rejects('/home/agent-test/', /segment/);
  });
});

describe('the guard accepts a genuine disposable workspace', () => {
  test('the layout the runbook recommends', () => {
    // §12's recommended remote layout. If this ever starts failing, the SSH
    // suite silently stops being runnable against a real host, which is a worse
    // outcome than an over-permissive guard.
    accepts('/home/agent-test/workspaces/kernel-ssh-fixture');
  });

  test('other reasonable shapes', () => {
    accepts('/home/ubuntu/agent/ws');
    accepts('/opt/agent-test/workspaces/ws');
    accepts('/srv/agent/kernel-ssh-fixture');
    accepts('/data/ci/kernel-ssh-fixture');
  });

  test('a deep path under the home directory', () => {
    accepts('/home/agent-test/a/b/c/d');
  });

  test('a trailing slash on an otherwise valid path', () => {
    accepts('/home/agent-test/workspaces/ws/');
  });

  test('a path whose name merely resembles a system directory', () => {
    // `/opt/etc-backup/ws` is not inside `/etc`. A prefix check that matched on
    // substring rather than on a path boundary would refuse it.
    accepts('/opt/etc-backup/ws');
    accepts('/home/user/usr-local/ws');
    accepts('/srv/variants/ws');
  });
});
