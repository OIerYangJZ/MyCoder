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
 * a temp directory rather than the repository; for a packaged install whose
 * `build/` is not writable (a root-owned global install); and for a distribution
 * packager who builds the launcher elsewhere.
 *
 * There is deliberately no install-mode branch. `root` is derived from
 * `import.meta.url`, so it is the repository in a checkout and the installed tree
 * under `node_modules/mycoder/` in a packaged install — the same code path, and
 * therefore the same path the build step writes to (ADR-0020 §5).
 */
export function resolveLauncherPath(): string {
  return process.env.MYCODER_SANDBOX_BIN ?? SANDBOX_BINARY;
}

/**
 * The launcher source that ships with *this* installation.
 *
 * Kept beside `resolveLauncherPath` because the two are only meaningful
 * together: verifying a binary means comparing it against the source the
 * installation currently carries, not against the one recorded when it was built
 * (ADR-0020 §2).
 */
export function resolveLauncherSourcePath(): string {
  return process.env.MYCODER_SANDBOX_SRC ?? SANDBOX_SOURCE;
}
