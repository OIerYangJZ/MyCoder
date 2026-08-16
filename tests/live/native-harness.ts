/**
 * Shared setup for the native-sandbox live suites (alpha.7).
 *
 * Mirrors `container-harness.ts`: decide once whether this machine can run the
 * suite, say *why* when it cannot, and turn "cannot" into a failure when a
 * release run demands it (`KERNEL_NATIVE_REQUIRED=1`, §65).
 *
 * The launcher is built here rather than assumed, because a stale binary would
 * enforce yesterday's rules while the tests describe today's.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { SANDBOX_BINARY, SANDBOX_SOURCE } from '../../src/execution/linux-native/paths.ts';
import { probeLauncher } from '../../src/execution/linux-native/probe.ts';

export interface NativeRequirement {
  run: boolean;
  required: boolean;
  reason: string;
}

let cached: NativeRequirement | undefined;

export function nativeRequirement(): NativeRequirement {
  if (cached) return cached;

  const required = process.env.KERNEL_NATIVE_REQUIRED === '1';
  const enabled = process.env.KERNEL_NATIVE === '1' || required;

  if (!enabled) {
    cached = { run: false, required, reason: 'set KERNEL_NATIVE=1 to run the native sandbox suites' };
    return cached;
  }
  if (process.platform !== 'linux') {
    cached = {
      run: false,
      required,
      reason: `the native sandbox is Linux-only; this is ${process.platform}`,
    };
    return cached;
  }

  if (!existsSync(SANDBOX_BINARY)) {
    const build = spawnSync(
      process.env.CC ?? 'cc',
      ['-O2', '-Wall', '-Wextra', '-Werror', '-std=c11', '-o', SANDBOX_BINARY, SANDBOX_SOURCE],
      { encoding: 'utf8' },
    );
    if (build.status !== 0) {
      cached = { run: false, required, reason: `the launcher could not be built: ${build.stderr.trim()}` };
      return cached;
    }
  }

  const probe = probeLauncher(SANDBOX_BINARY);
  cached = probe.ok
    ? { run: true, required, reason: `Landlock ABI ${probe.probe.abi}` }
    : { run: false, required, reason: probe.reason };
  return cached;
}

/** `{ skip }` for `describe`, or a thrown error when the run is mandatory. */
export function nativeSkip(): { skip?: string } {
  const requirement = nativeRequirement();
  if (requirement.run) return {};
  if (requirement.required) {
    throw new Error(`KERNEL_NATIVE_REQUIRED=1 but the native suite cannot run: ${requirement.reason}`);
  }
  return { skip: requirement.reason };
}
