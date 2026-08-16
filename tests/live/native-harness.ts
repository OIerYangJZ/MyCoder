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

import { SANDBOX_BINARY } from '../../src/execution/linux-native/paths.ts';
import { buildSandbox, sandboxBinaryState } from '../../src/execution/linux-native/build.ts';
import { probeLauncher } from '../../src/execution/linux-native/probe.ts';
import { KERNEL_VERSION } from '../../src/kernel.ts';

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

  // Rebuild whenever the launcher does not *verify*, not merely when the file is
  // absent (ADR-0020). Since alpha.8 the backend refuses a binary with no
  // manifest, so "the file exists" is no longer the question — and a binary left
  // over from a previous source is exactly the case the identity check exists to
  // catch. Going through `buildSandbox` rather than a bare `cc` line is what
  // writes the manifest at all; the ad-hoc invocation here used to skip the
  // hardening flags too, so the suite was testing a differently-compiled binary
  // from the one `pnpm build:sandbox` produces.
  if (!sandboxBinaryState().ok) {
    const build = buildSandbox({ kernelVersion: KERNEL_VERSION });
    if (!build.ok) {
      cached = { run: false, required, reason: `the launcher could not be built: ${build.detail.trim()}` };
      return cached;
    }
  }

  const verified = sandboxBinaryState();
  if (!verified.ok) {
    cached = { run: false, required, reason: `the launcher does not verify: ${verified.reason}` };
    return cached;
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
