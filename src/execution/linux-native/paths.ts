/**
 * Where the native launcher lives (ADR-0018).
 *
 * In `src/` rather than in the build script because the *backend* is the thing
 * that must know: `scripts/` is a build-time convenience, and a kernel that
 * imported its own binary's location from a build script would have the
 * dependency the wrong way round.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, from `src/execution/linux-native/`. */
const root = path.resolve(here, '..', '..', '..');

export const SANDBOX_SOURCE = path.join(root, 'native', 'mycoder-sandbox.c');
export const SANDBOX_BINARY = path.join(root, 'build', 'mycoder-sandbox');

/**
 * The launcher this session will use.
 *
 * `MYCODER_SANDBOX_BIN` exists for the live suites, which build the binary into
 * a temp directory rather than the repository, and for a packaged install where
 * the binary ships next to the code rather than in `build/`.
 */
export function resolveLauncherPath(): string {
  return process.env.MYCODER_SANDBOX_BIN ?? SANDBOX_BINARY;
}
