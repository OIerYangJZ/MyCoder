#!/usr/bin/env node
/**
 * The `mycoder` entry point (ADR-0019, alpha.8 §8).
 *
 * This file is plain JavaScript, and that is its entire reason to exist.
 *
 * `bin` used to point straight at `src/cli/main.ts`, which meant a user on a Node
 * that cannot strip types met:
 *
 *     SyntaxError: Unexpected token ':'
 *
 * That names neither the problem nor the remedy, points at a line of our source
 * rather than at their runtime, and reads like a bug in the kernel. §8 asks for a
 * named error, the required version, and what to do — and a version check that
 * cannot be parsed by the version it is checking for is not a version check.
 *
 * So: no type annotations, no syntax newer than ES2018, no top-level `await`, and
 * nothing from `src/` or `dist/` imported until after the check has passed.
 *
 * Two things this file deliberately does **not** do, both because the install
 * dogfood found what happens when it did:
 *
 *   **No `isMain` guard.** `npm install -g` links `<prefix>/bin/mycoder` as a
 *   symlink; Node sets `argv[1]` to the link and `import.meta.url` to the target,
 *   so the usual guard is false on every global install. The shim ran nothing,
 *   printed nothing and exited 0. The pure functions live in `runtime-check.mjs`
 *   so this file can simply be an entry point.
 *
 *   **No hard-coded version floor.** It is read from `engines.node`, which npm
 *   already enforces and a reader will look at first. Two copies of a version
 *   floor is one copy that goes stale.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkRuntime, parseVersion, EXIT_UNAVAILABLE } from './runtime-check.mjs';

function readFloor() {
  try {
    var pkgUrl = new URL('../package.json', import.meta.url);
    var pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8'));
    return parseVersion(pkg && pkg.engines && pkg.engines.node);
  } catch (e) {
    return null;
  }
}

/**
 * Which build to load: the emitted JavaScript, or the TypeScript sources.
 *
 * `dist/` in a published package; `src/` in a git checkout, where Node strips the
 * types happily because the checkout is not under `node_modules`. The same
 * decision, made the same way, in both — there is no install-mode flag and no
 * environment variable, only "is the emitted build present".
 */
function entryUrl() {
  var dist = new URL('../dist/cli/main.js', import.meta.url);
  if (existsSync(fileURLToPath(dist))) return dist;
  return new URL('../src/cli/main.ts', import.meta.url);
}

function run() {
  var verdict = checkRuntime(process.versions.node, readFloor());
  if (!verdict.ok) {
    process.stderr.write(verdict.message);
    process.exitCode = EXIT_UNAVAILABLE;
    return;
  }

  // Only now. Everything below this line may contain type annotations.
  import(entryUrl().href)
    .then(function (mod) {
      return mod.main(process.argv.slice(2)).then(function (code) {
        process.exitCode = code;
      });
    })
    .catch(function (e) {
      process.stderr.write('mycoder: failed to start: ' + (e && e.message ? e.message : String(e)) + '\n');
      process.exitCode = 6; // INTERNAL
    });
}

run();
