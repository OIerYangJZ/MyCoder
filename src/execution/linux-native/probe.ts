/**
 * Landlock feature probe (alpha.7 §12, §13).
 *
 * Support is **measured, never inferred**. A distribution kernel can carry the
 * syscall and have Landlock disabled at boot; `lsm=` on the command line decides
 * it, and nothing about that is visible from `uname`. So the launcher is asked,
 * on the machine, and what it answers is what the backend reports and claims.
 *
 * Features are reported one by one rather than as a single "supported" flag,
 * because they genuinely differ: ABI 3 restricts the filesystem and cannot touch
 * TCP, and a backend that rounded that up to "network enforced" would be making
 * exactly the claim invariant 5 exists to prevent.
 */

import { spawnSync } from 'node:child_process';

export interface LandlockProbe {
  launcherVersion: number;
  landlockAvailable: boolean;
  /** 0 when unavailable. Higher ABIs are supersets. */
  abi: number;
  filesystem: boolean;
  refer: boolean;
  truncate: boolean;
  /** Landlock governs TCP bind/connect from ABI 4. */
  networkTcp: boolean;
  ioctlDev: boolean;
  scopes: boolean;
  /**
   * Always false, and it is a load-bearing false (§28).
   *
   * Landlock has no UDP rules, so "no network" via Landlock alone means "no TCP".
   * The backend reports the denial as covering TCP rather than claiming a
   * complete network boundary it cannot impose.
   */
  networkUdp: boolean;
  closeRange: boolean;
  reason?: string;
}

export type ProbeResult = { ok: true; probe: LandlockProbe } | { ok: false; reason: string; remedy?: string };

/** ABI 4 is the floor for a network claim; ABI 1 is the floor for anything. */
export const MIN_ABI_FILESYSTEM = 1;
export const MIN_ABI_NETWORK = 4;

export function probeLauncher(binary: string, timeoutMs = 5_000): ProbeResult {
  const result = spawnSync(binary, ['--probe'], { encoding: 'utf8', timeout: timeoutMs });

  if (result.error) {
    return {
      ok: false,
      reason: `the native launcher could not be run: ${result.error.message}`,
      remedy: 'Build it with `pnpm build:sandbox` on this machine.',
    };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `the native launcher exited ${result.status}: ${result.stderr.trim()}` };
  }

  let parsed: LandlockProbe;
  try {
    parsed = JSON.parse(result.stdout) as LandlockProbe;
  } catch {
    return { ok: false, reason: 'the native launcher produced output that is not a probe document' };
  }

  if (!parsed.landlockAvailable || parsed.abi < MIN_ABI_FILESYSTEM) {
    return {
      ok: false,
      reason:
        `Landlock is not available on this kernel${parsed.reason ? ` (${parsed.reason})` : ''}. ` +
        'The native backend has nothing to enforce with.',
      remedy:
        'Check that the kernel is 5.13 or newer and that `landlock` appears in ' +
        '/sys/kernel/security/lsm; some distributions require lsm=landlock,... on the command line.',
    };
  }

  return { ok: true, probe: parsed };
}

/**
 * What this kernel can and cannot carry, in the words `/status` will use.
 *
 * Returned as a list rather than a sentence so the caller can decide how much to
 * show, and so a note can never be mistaken for an enforcement level.
 */
export function describeProbe(probe: LandlockProbe): string[] {
  const notes = [`Landlock ABI ${probe.abi}: filesystem rules are kernel-enforced.`];

  if (probe.networkTcp) {
    notes.push(
      'Network denial covers TCP bind and connect. Landlock has no UDP rules, so UDP and raw ' +
        'sockets are not restricted by this backend — use the container backend when that matters.',
    );
  } else {
    notes.push(
      `This kernel's Landlock ABI (${probe.abi}) has no network rules, so a network-denied ` +
        'execution cannot be granted here at all rather than being run unrestricted.',
    );
  }

  if (!probe.closeRange) {
    notes.push('close_range is unavailable; descriptor hygiene falls back to a bounded loop.');
  }
  return notes;
}
