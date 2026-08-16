#!/usr/bin/env node
/**
 * Build the native launcher (ADR-0018).
 *
 *   pnpm build:sandbox
 *
 * Deliberately a separate, explicit step rather than something the backend does
 * on demand. Compiling is running a compiler, and a kernel that shelled out to
 * `cc` in the middle of a tool call would be doing exactly the kind of unaudited
 * execution it exists to prevent. So: a human (or CI) runs this, and the backend
 * refuses to start when the binary is missing or older than its source — a stale
 * launcher would enforce yesterday's rules while claiming today's.
 *
 * ADR-0009 is untouched: the *runtime* dependency set is still empty. This adds a
 * build-time requirement of a C compiler, on Linux only, for a backend that only
 * exists on Linux.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { SANDBOX_BINARY, SANDBOX_SOURCE } from '../src/execution/linux-native/paths.ts';

export { SANDBOX_BINARY, SANDBOX_SOURCE };

/** Flags chosen once, here, so every build of this binary is the same build. */
const CFLAGS = [
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-std=c11',
  // The launcher runs with the user's rights and parses a plan; the usual
  // hardening set costs nothing measurable for a program this small.
  '-D_FORTIFY_SOURCE=2',
  '-fstack-protector-strong',
  '-fPIE',
  '-pie',
  '-Wl,-z,relro,-z,now',
];

export interface BuildResult {
  ok: boolean;
  binary: string;
  detail: string;
}

export function buildSandbox(compiler = process.env.CC ?? 'cc'): BuildResult {
  if (process.platform !== 'linux') {
    return {
      ok: false,
      binary: SANDBOX_BINARY,
      detail: `the native launcher is Linux-only; this is ${process.platform}`,
    };
  }

  mkdirSync(path.dirname(SANDBOX_BINARY), { recursive: true });

  const result = spawnSync(compiler, [...CFLAGS, '-o', SANDBOX_BINARY, SANDBOX_SOURCE], {
    encoding: 'utf8',
  });

  if (result.error) {
    return {
      ok: false,
      binary: SANDBOX_BINARY,
      detail: `${compiler} could not be run: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      binary: SANDBOX_BINARY,
      detail: `${compiler} exited ${result.status}\n${result.stderr}`,
    };
  }
  return { ok: true, binary: SANDBOX_BINARY, detail: `built ${SANDBOX_BINARY}` };
}

/**
 * Is the built binary present and newer than its source?
 *
 * The staleness half matters more than the presence half: a launcher built from
 * an older source enforces older rules, and the failure mode is a guarantee that
 * silently is not the one the code describes.
 */
export function sandboxBinaryState(): { present: boolean; stale: boolean; binary: string } {
  try {
    const binary = statSync(SANDBOX_BINARY);
    const source = statSync(SANDBOX_SOURCE);
    return { present: true, stale: binary.mtimeMs < source.mtimeMs, binary: SANDBOX_BINARY };
  } catch {
    return { present: false, stale: false, binary: SANDBOX_BINARY };
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const result = buildSandbox();
  process.stdout.write(`${result.detail}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
