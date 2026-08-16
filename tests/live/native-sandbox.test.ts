/**
 * The native Linux sandbox, against a real kernel (alpha.7 §20–§28, §37).
 *
 *   KERNEL_NATIVE=1 node --test --experimental-strip-types tests/live/native-sandbox.test.ts
 *
 * Live-only and Linux-only, like the container suites: the whole point is what
 * *this kernel* does, so there is nothing to stub. It skips with a reason
 * elsewhere rather than passing vacuously, and `KERNEL_NATIVE_REQUIRED=1` turns
 * the skip into a failure for release runs (§65).
 *
 * Every security assertion here has its reverse control, because "the read
 * failed" is not evidence — the file might not have existed, the binary might
 * not have run, the plan might have been empty. The controls are what make each
 * denial attributable to the mechanism it claims.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { LinuxNativeExecutionBackend } from '../../src/execution/linux-native/backend.ts';
import { buildPlan, PlanRefused, RUNTIME_BASE } from '../../src/execution/linux-native/plan.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { nullLogger } from '../../src/util/logger.ts';
import { SANDBOX_SOURCE } from '../../src/execution/linux-native/paths.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';
import type { CapabilityProfile } from '../../src/execution/backend.ts';

const CANARY = 'CANARY_SECRET_7f3e9c2a';

const REQUIRED = process.env.KERNEL_NATIVE_REQUIRED === '1';
const ENABLED = process.env.KERNEL_NATIVE === '1' || REQUIRED;

function unavailable(): string | undefined {
  if (!ENABLED) return 'set KERNEL_NATIVE=1 to run the native sandbox suite (Linux with Landlock only)';
  if (process.platform !== 'linux') return `the native sandbox is Linux-only; this is ${process.platform}`;
  return undefined;
}

let base: string;
let workspace: CanonicalPath;
let outside: string;
/** The production launcher, and the one built without descriptor hygiene (§21). */
let launcher: string;
let launcherNoHygiene: string;
let backend: LinuxNativeExecutionBackend;

const reason = unavailable();

before(async () => {
  if (reason) {
    if (REQUIRED) throw new Error(`KERNEL_NATIVE_REQUIRED=1 but the suite cannot run: ${reason}`);
    return;
  }

  base = await mkdtemp(path.join(tmpdir(), 'mycoder-native-'));
  workspace = path.join(base, 'workspace') as CanonicalPath;
  outside = path.join(base, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(workspace, 'file.txt'), 'workspace content\n', 'utf8');
  await writeFile(path.join(outside, 'secret.env'), `API_KEY=${CANARY}\n`, 'utf8');

  launcher = path.join(base, 'mycoder-sandbox');
  launcherNoHygiene = path.join(base, 'mycoder-sandbox-nc');
  compile(launcher, []);
  // §21's paired control is a *build*, never a runtime flag: a switch that
  // disabled descriptor hygiene would be reachable by anything that can shape an
  // argv, and the guarantee is that nothing can.
  compile(launcherNoHygiene, ['-DMYCODER_NEGATIVE_CONTROL_KEEP_FDS']);

  backend = await LinuxNativeExecutionBackend.create({
    workspaceRoot: workspace,
    redactor: new Redactor(),
    launcherPath: launcher,
    logger: nullLogger,
    sandboxHome: path.join(base, 'sandbox-home') as CanonicalPath,
  });
});

after(async () => {
  await backend?.close();
  if (base) await rm(base, { recursive: true, force: true });
});

function compile(output: string, extraFlags: readonly string[]): void {
  const result = spawnSync(
    process.env.CC ?? 'cc',
    ['-O2', '-Wall', '-Wextra', '-Werror', '-std=c11', ...extraFlags, '-o', output, SANDBOX_SOURCE],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`could not build the launcher: ${result.stderr}`);
}

function guard(t: { skip(why: string): void }): boolean {
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

function profile(over: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    readRoots: [workspace],
    writeRoots: [workspace],
    allowExec: true,
    network: false,
    envAllow: [],
    secretInjections: [],
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
    ...over,
  };
}

async function run(argv: string[], over: Partial<CapabilityProfile> = {}) {
  const executor = await backend.enforce(profile(over));
  try {
    return await executor.exec({ argv, cwd: workspace, timeoutMs: 20_000 });
  } finally {
    executor.dispose();
  }
}

// --- §12/§13: the probe -----------------------------------------------------

describe('feature probe (§12)', () => {
  test('reports a measured ABI rather than inferring one', (t) => {
    if (guard(t)) return;
    assert.equal(backend.features.landlockAvailable, true);
    assert.ok(backend.features.abi >= 1, `expected a Landlock ABI, got ${backend.features.abi}`);
    // §28: Landlock has no UDP rules, and the probe must not pretend otherwise.
    assert.equal(backend.features.networkUdp, false);
  });

  test('the enforcement descriptor claims only what the ABI carries (§13, §30)', (t) => {
    if (guard(t)) return;
    const e = backend.environment.enforcement;
    assert.equal(e.processFilesystem, 'os-enforced');
    assert.equal(e.processPrivileges, 'os-enforced');
    // The file broker is the kernel's own, exactly as on the container backend.
    assert.equal(e.hostFileBroker, 'policy-enforced');
    // §27: no hostname allowlist exists here, and `none` is how that is said.
    assert.equal(e.networkAllowlist, 'none');
    assert.equal(e.processNetwork, backend.features.networkTcp ? 'os-enforced' : 'none');
    assert.match((e.platformNotes ?? []).join(' '), /no UDP or raw-socket rules/);
  });
});

// --- §14–§18: filesystem ----------------------------------------------------

describe('filesystem enforcement (§14, §16)', () => {
  test('POSITIVE CONTROL: a granted path is readable and writable', async (t) => {
    if (guard(t)) return;
    const read = await run(['cat', path.join(workspace, 'file.txt')]);
    assert.equal(read.exitCode, 0, read.stderr);
    assert.match(read.stdout, /workspace content/);

    const write = await run([
      'sh',
      '-c',
      `echo made > ${path.join(workspace, 'new.txt')} && cat ${path.join(workspace, 'new.txt')}`,
    ]);
    assert.equal(write.exitCode, 0, write.stderr);
    assert.match(write.stdout, /made/);
  });

  test('a path outside every granted root is denied by the kernel', async (t) => {
    if (guard(t)) return;
    const result = await run(['cat', path.join(outside, 'secret.env')]);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Permission denied/);
    assert.doesNotMatch(result.stdout, new RegExp(CANARY));
  });

  test('writing outside the granted roots is denied', async (t) => {
    if (guard(t)) return;
    const result = await run(['sh', '-c', `echo pwned > ${path.join(outside, 'pwned.txt')}`]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Permission denied/);
  });

  test('a read-only workspace cannot be written (§50)', async (t) => {
    if (guard(t)) return;
    const result = await run(['sh', '-c', `echo x > ${path.join(workspace, 'ro.txt')}`], { writeRoots: [] });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Permission denied/);
  });
});

// --- §20/§21: descriptor hygiene, with its paired control -------------------

describe('descriptor hygiene (§20, §21)', () => {
  test('NEGATIVE CONTROL: without hygiene, a pre-opened fd bypasses every path rule', async (t) => {
    if (guard(t)) return;
    // Landlock governs path *resolution*, so this is the bypass being closed —
    // and a test that only showed the production launcher closing the fd would
    // not have established that there was anything to close.
    const result = spawnSync(
      'sh',
      [
        '-c',
        `exec 9< ${path.join(outside, 'secret.env')}; ${launcherNoHygiene} --plan-fd 3 -- /bin/sh -c 'cat <&9' 3< ${planFile()}`,
      ],
      { encoding: 'utf8' },
    );
    assert.match(result.stdout, new RegExp(CANARY), 'the control must show the fd surviving');
  });

  test('the production launcher closes it, and the same read fails', async (t) => {
    if (guard(t)) return;
    const result = spawnSync(
      'sh',
      [
        '-c',
        `exec 9< ${path.join(outside, 'secret.env')}; ${launcher} --plan-fd 3 -- /bin/sh -c 'cat <&9' 3< ${planFile()}`,
      ],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(result.stdout, new RegExp(CANARY));
    assert.match(`${result.stderr}`, /Bad file descriptor/);
  });
});

/** Write the current plan to a file the shell can redirect from. */
function planFile(): string {
  const plan = buildPlan({
    profile: profile(),
    sandboxHome: path.join(base, 'sandbox-home') as CanonicalPath,
    protectedInsideRoots: [],
  });
  const file = path.join(base, 'plan.txt');
  writeFileSync(file, plan.text, 'utf8');
  return file;
}

// --- §22/§23: process inspection --------------------------------------------

describe('process inspection (§22, §23)', () => {
  test('another process environ is unreachable, and the control shows it would not be', async (t) => {
    if (guard(t)) return;
    // A same-uid process outside the sandbox holding the canary in its
    // environment: the exact shape of the leak §22 is about.
    // The background process must not hold stdout, or `spawnSync` waits for it
    // and the pid is already dead by the time the reads happen.
    const victim = spawnSync('sh', ['-c', `env ${CANARY}=1 sleep 20 >/dev/null 2>&1 & echo $!`], {
      encoding: 'utf8',
    });
    const pid = victim.stdout.trim();
    assert.match(pid, /^\d+$/, 'the fixture must report a pid');

    // NEGATIVE CONTROL: unsandboxed, the same read succeeds. Without this the
    // denial below could be a dead pid or a typo in the path.
    const control = spawnSync('sh', ['-c', `cat /proc/${pid}/environ`], { encoding: 'utf8' });
    assert.match(control.stdout, new RegExp(CANARY), 'the control must show the environ is readable');

    const result = await run(['sh', '-c', `cat /proc/${pid}/environ`]);
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(result.stdout, new RegExp(CANARY));
  });

  test('procfs is absent entirely, rather than present for one process (§18)', async (t) => {
    if (guard(t)) return;
    // The asymmetry this avoids: a `/proc/self` rule resolves to one pid, so the
    // first process would see its own entry and every forked child would not.
    const own = await run(['sh', '-c', 'cat /proc/self/cmdline']);
    assert.notEqual(own.exitCode, 0, 'no procfs access is granted at all');
    assert.ok(
      !RUNTIME_BASE.some((r) => r.path.startsWith('/proc')),
      'the runtime base must not grant any part of procfs',
    );
  });

  test('ptrace and process_vm_readv are denied by our filter, not by the host sysctl', async (t) => {
    if (guard(t)) return;
    // The distinction matters: `kernel.yama.ptrace_scope` is the host's setting
    // and could be 0 on another machine. Our seccomp filter answers EACCES where
    // Yama answers EPERM, so the errno says which mechanism refused (§25).
    const probe = path.join(workspace, 'ptrace-probe');
    const source = path.join(base, 'ptrace-probe.c');
    await writeFile(
      source,
      `#define _GNU_SOURCE
#include <stdio.h>
#include <errno.h>
#include <sys/ptrace.h>
int main(void) {
  errno = 0;
  ptrace(PTRACE_ATTACH, 1, 0, 0);
  printf("errno=%d\\n", errno);
  return 0;
}
`,
      'utf8',
    );
    const built = spawnSync(process.env.CC ?? 'cc', ['-O2', '-o', probe, source], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);

    const result = await run([probe]);
    assert.match(result.stdout, /errno=13/, `expected EACCES (13) from seccomp, got: ${result.stdout}`);
  });
});

// --- §24: privilege transitions --------------------------------------------

describe('privilege (§24)', () => {
  test('no_new_privs is set, so a setuid exec cannot gain privilege', async (t) => {
    if (guard(t)) return;
    // Read the flag from the horse's mouth. `/proc/self/status` would be the
    // usual way and procfs is deliberately absent (ADR-0018 §5), so the probe
    // asks prctl directly — which is also the value the kernel actually acts on.
    const probe = path.join(workspace, 'nnp-probe');
    const source = path.join(base, 'nnp-probe.c');
    await writeFile(
      source,
      `#include <stdio.h>
#include <sys/prctl.h>
int main(void) { printf("nnp=%d\\n", prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0)); return 0; }
`,
      'utf8',
    );
    const built = spawnSync(process.env.CC ?? 'cc', ['-O2', '-o', probe, source], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);

    const inside = await run([probe]);
    assert.match(inside.stdout, /nnp=1/, `expected no_new_privs inside the sandbox: ${inside.stderr}`);

    // NEGATIVE CONTROL: the same binary outside reports 0, so the assertion above
    // is about the sandbox rather than about the machine's default.
    const outsideRun = spawnSync(probe, [], { encoding: 'utf8' });
    assert.match(outsideRun.stdout, /nnp=0/, 'the control must show the flag is not set by default');
  });

  test('a setuid binary confers nothing under the sandbox', async (t) => {
    if (guard(t)) return;
    // `mount` is setuid root on this image and reports its effective uid through
    // behaviour: unprivileged it refuses. With no_new_privs the setuid bit is
    // ignored at exec, so the refusal is the expected outcome either way — what
    // this asserts is that it never *succeeds*, which is the property §24 wants.
    const result = await run(['sh', '-c', 'mount -o remount,rw / 2>&1; echo "exit=$?"']);
    assert.doesNotMatch(result.stdout, /^exit=0$/m, 'a privileged remount must not succeed');
  });
});

// --- §38: the unknown canary ------------------------------------------------

describe('unknown canary (§38)', () => {
  test('a secret the kernel has never been told about is still unreachable', async (t) => {
    if (guard(t)) return;
    // The point of §38: the boundary must hold by *path*, not by redaction. This
    // value is registered with nothing — no broker, no redactor — so if it came
    // back, nothing downstream would have masked it.
    const unknown = `UNREGISTERED_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const file = path.join(outside, 'unknown-canary.txt');
    await writeFile(file, `${unknown}\n`, 'utf8');

    const result = await run(['sh', '-c', `cat ${file} 2>&1; grep -r ${unknown} / 2>/dev/null | head -1`]);

    assert.doesNotMatch(result.stdout, new RegExp(unknown));
    assert.doesNotMatch(result.stderr, new RegExp(unknown));

    // NEGATIVE CONTROL: unsandboxed, the same read succeeds — so the denial above
    // is the sandbox and not a missing file.
    const control = spawnSync('cat', [file], { encoding: 'utf8' });
    assert.match(control.stdout, new RegExp(unknown));
  });
});

// --- §27/§28: network -------------------------------------------------------

describe('network (§27, §28)', () => {
  test('TCP is denied when the profile denies network', async (t) => {
    if (guard(t)) return;
    const result = await run(['sh', '-c', 'exec 3<>/dev/tcp/1.1.1.1/443 && echo connected']);
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(result.stdout, /connected/);
  });

  test('a host-scoped allowlist is refused, not silently unenforced', async (t) => {
    if (guard(t)) return;
    // §27: the alpha.5 mistake was accepting host lists and enforcing nothing.
    await assert.rejects(
      () => run(['true'], { network: { hosts: ['registry.npmjs.org'] } }),
      (e: Error) => /not supported by the native Linux backend/.test(e.message),
    );
  });
});

// --- §31: cancellation ------------------------------------------------------

describe('cancellation and timeout (§31)', () => {
  test('a timeout kills the whole process tree, not just the leader', async (t) => {
    if (guard(t)) return;
    // The child ignores SIGTERM and outlives its parent, which is why signalling
    // the *group* is the requirement rather than killing the leader (§31).
    const started = Date.now();
    const executor = await backend.enforce(profile());
    let result;
    try {
      result = await executor.exec({
        argv: ['sh', '-c', 'trap "" TERM; sleep 30 & wait'],
        cwd: workspace,
        timeoutMs: 3_000,
      });
    } finally {
      executor.dispose();
    }
    const elapsed = Date.now() - started;

    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 20_000, `the tree should die at the timeout, took ${elapsed}ms`);
  });
});

// --- §16/§17: plan refusal --------------------------------------------------

describe('the plan refuses what it cannot enforce (§16, §17)', () => {
  test('a protected file inside a granted root refuses the plan', (t) => {
    if (guard(t)) return;
    assert.throws(
      () =>
        buildPlan({
          profile: profile(),
          sandboxHome: path.join(base, 'sandbox-home') as CanonicalPath,
          protectedInsideRoots: [path.join(workspace, 'packages/app/.env') as CanonicalPath],
        }),
      PlanRefused,
    );
  });

  test('a truncated protected-path scan refuses the plan', (t) => {
    if (guard(t)) return;
    assert.throws(
      () =>
        buildPlan({
          profile: profile(),
          sandboxHome: path.join(base, 'sandbox-home') as CanonicalPath,
          protectedInsideRoots: [],
          discoveryTruncated: true,
        }),
      /did not complete/,
    );
  });

  test('the runtime base grants no broad root, home or /etc (§18)', (t) => {
    if (guard(t)) return;
    const paths = RUNTIME_BASE.map((r) => r.path);
    assert.ok(!paths.includes('/'), 'the root must never be granted');
    assert.ok(!paths.includes('/etc'), '/etc as a whole carries credentials on plenty of machines');
    assert.ok(!paths.some((p) => p.startsWith('/home')), 'no home directory is in the base policy');
    assert.ok(
      !paths.some((p) => p.startsWith('/proc')),
      'procfs is granted nowhere: a per-pid rule would be an asymmetric guarantee',
    );
  });
});
