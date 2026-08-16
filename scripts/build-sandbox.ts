#!/usr/bin/env node
/**
 * Build the native launcher, from a checkout.
 *
 *   pnpm build:sandbox
 *
 * A thin front end since alpha.8. The build itself lives in
 * `src/execution/linux-native/build.ts`, because a packaged install has no
 * `scripts/` entry in its manifest and no pnpm to run one with, and
 * `mycoder build-sandbox` (ADR-0020 §1) has to reach the same code.
 *
 * The re-exports below are the compatibility surface for anything that imported
 * this module before the move.
 */

import { pathToFileURL } from 'node:url';

import { SANDBOX_BINARY, SANDBOX_SOURCE } from '../src/execution/linux-native/paths.ts';
import { buildSandbox, sandboxBinaryState, CFLAGS } from '../src/execution/linux-native/build.ts';
import { KERNEL_VERSION } from '../src/kernel.ts';

export { SANDBOX_BINARY, SANDBOX_SOURCE, buildSandbox, sandboxBinaryState, CFLAGS };
export type { BuildResult, BuildOptions } from '../src/execution/linux-native/build.ts';

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

if (isMain(import.meta.url)) {
  const result = buildSandbox({ kernelVersion: KERNEL_VERSION });
  process.stdout.write(`${result.detail}\n`);
  if (result.remedy) process.stdout.write(`\n${result.remedy}\n`);
  // 0 or 5 (UNAVAILABLE, ADR-0021): a build that cannot run because the machine
  // lacks a compiler is an environment fact, not a usage error.
  process.exitCode = result.ok ? 0 : 5;
}
