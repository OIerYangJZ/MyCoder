/**
 * Build the native launcher (ADR-0018, ADR-0020).
 *
 * In `src/` rather than in `scripts/` since alpha.8, for one reason: a packaged
 * install has no `scripts/` entry in its `package.json` and no pnpm to run it
 * with, so `mycoder build-sandbox` has to reach this code from the CLI. The
 * `scripts/build-sandbox.ts` wrapper stays for the checkout workflow and is now
 * a thin front end.
 *
 * Deliberately a separate, explicit step rather than something the backend does
 * on demand, and never a `postinstall` (ADR-0020 §1). Compiling is running a
 * compiler: a kernel that shelled out to `cc` in the middle of a tool call — or
 * as a side effect of dependency resolution — would be doing exactly the kind of
 * unaudited execution it exists to prevent. So a human or CI runs this, and the
 * backend refuses to start when the result is missing, stale or not the binary
 * its manifest describes.
 *
 * ADR-0009 is untouched: the *runtime* dependency set is still empty. This adds a
 * build-time requirement of a C compiler, on Linux only, for a backend that only
 * exists on Linux.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';

import { SANDBOX_BINARY, SANDBOX_SOURCE } from './paths.ts';
import { manifestPathFor, verifyLauncher, writeLauncherManifest, type LauncherVerdict } from './identity.ts';

/** Flags chosen once, here, so every build of this binary is the same build. */
export const CFLAGS = [
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
  /** Set when the failure is a writability problem, which has its own remedy. */
  remedy?: string;
}

export interface BuildOptions {
  compiler?: string;
  /** Where to write. Defaults to the installation's `build/` directory. */
  binary?: string;
  source?: string;
  kernelVersion?: string;
}

export function buildSandbox(opts: BuildOptions = {}): BuildResult {
  const compiler = opts.compiler ?? process.env.CC ?? 'cc';
  const binary = opts.binary ?? SANDBOX_BINARY;
  const source = opts.source ?? SANDBOX_SOURCE;

  if (process.platform !== 'linux') {
    return {
      ok: false,
      binary,
      detail: `the native launcher is Linux-only; this is ${process.platform}`,
    };
  }

  try {
    mkdirSync(path.dirname(binary), { recursive: true });
  } catch (e) {
    // The case ADR-0020 §5 calls out: a root-owned global install whose `build/`
    // the user cannot write. Naming `MYCODER_SANDBOX_BIN` here is the difference
    // between a remedy and an EACCES.
    return {
      ok: false,
      binary,
      detail: `${path.dirname(binary)} could not be created: ${(e as Error).message}`,
      remedy:
        'Build somewhere you can write and point the kernel at it:\n' +
        '  MYCODER_SANDBOX_BIN=$HOME/.local/lib/mycoder-sandbox mycoder build-sandbox',
    };
  }

  const result = spawnSync(compiler, [...CFLAGS, '-o', binary, source], { encoding: 'utf8' });

  if (result.error) {
    return {
      ok: false,
      binary,
      detail: `${compiler} could not be run: ${result.error.message}`,
      remedy:
        'Install a C compiler:\n' +
        '  apt install build-essential      # Debian / Ubuntu\n' +
        '  dnf install gcc                  # Fedora / RHEL\n' +
        'or set CC to the compiler you have.',
    };
  }
  if (result.status !== 0) {
    return { ok: false, binary, detail: `${compiler} exited ${result.status}\n${result.stderr}` };
  }

  // The manifest is what makes the binary verifiable later (ADR-0020 §2). It is
  // written *after* a successful compile and describes what was actually
  // produced — hashing the source again here rather than trusting it did not
  // change during the compile, which is cheap and removes a race nobody would
  // ever reproduce but everybody would have to reason about.
  const manifest = writeLauncherManifest(binary, source, {
    kernelVersion: opts.kernelVersion ?? 'unknown',
    compiler,
    flags: CFLAGS,
  });

  return {
    ok: true,
    binary,
    detail:
      `built ${binary}\n` +
      `manifest ${manifestPathFor(binary)}\n` +
      `source sha256 ${manifest.sourceSha256.slice(0, 12)} · binary sha256 ${manifest.binarySha256.slice(0, 12)}`,
  };
}

/**
 * Is the built launcher present, current, and the one its manifest describes?
 *
 * Replaces alpha.7's mtime comparison, which could not survive packaging: `npm`,
 * `tar` and `git checkout` all set mtimes from the extraction, so on an installed
 * tree the old check answered a question about unpacking order. See
 * `identity.ts` for the full argument.
 */
export function sandboxBinaryState(binary = SANDBOX_BINARY, source = SANDBOX_SOURCE): LauncherVerdict {
  return verifyLauncher(binary, source);
}
