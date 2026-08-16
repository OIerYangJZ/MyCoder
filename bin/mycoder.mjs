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
 * nothing imported from `src/` until after the check has passed.
 *
 * The floor itself is **not** duplicated here. It is read from `engines.node` in
 * package.json, which is the field npm already enforces and the one a reader will
 * look at first. Two copies of a version floor is one copy that goes stale.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Exit code 5 = UNAVAILABLE (ADR-0021): the machine cannot provide it. */
var EXIT_UNAVAILABLE = 5;

function parseVersion(text) {
  var m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `a` is strictly older than `b`. */
function isOlder(a, b) {
  for (var i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

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
 * The message §8 asks for: what is wrong, what is required, and what to do.
 *
 * Exported so the regression matrix can assert its content without spawning a
 * different Node — `tests/integration/runtime-version.test.ts` calls this
 * directly, which is the only way to test the message for a version this process
 * is not running.
 */
export function runtimeUnsupportedMessage(found, required) {
  return [
    'mycoder: RUNTIME_UNSUPPORTED',
    '',
    '  This is Node ' + found + '. MyCoder needs Node >= ' + required + '.',
    '',
    '  Why: MyCoder ships TypeScript sources and lets Node strip the types at',
    '  runtime (ADR-0019). That is on by default from Node ' + required + '; below it',
    '  the type annotations in this package are a syntax error.',
    '',
    '  To fix, install a supported Node and re-run:',
    '',
    '    nvm install 22 && nvm use 22        # nvm',
    '    brew install node@22                # macOS / Homebrew',
    '    https://nodejs.org/en/download      # everyone else',
    '',
    '  To verify:  node --version',
    '',
  ].join('\n');
}

export function checkRuntime(foundText, floor) {
  var found = parseVersion(foundText);
  if (!found || !floor) return { ok: true };
  if (!isOlder(found, floor)) return { ok: true };
  return {
    ok: false,
    message: runtimeUnsupportedMessage(found.join('.'), floor.join('.')),
  };
}

function run() {
  var verdict = checkRuntime(process.versions.node, readFloor());
  if (!verdict.ok) {
    process.stderr.write(verdict.message);
    process.exitCode = EXIT_UNAVAILABLE;
    return;
  }

  // Only now. Every module below this line may contain type annotations.
  import('../src/cli/main.ts')
    .then(
      function (mod) {
        return mod.main(process.argv.slice(2)).then(function (code) {
          process.exitCode = code;
        });
      },
      function (e) {
        process.stderr.write('mycoder: failed to start: ' + (e && e.message ? e.message : String(e)) + '\n');
        process.exitCode = 6; // INTERNAL
      },
    )
    .catch(function (e) {
      process.stderr.write('mycoder: fatal: ' + (e && e.stack ? e.stack : String(e)) + '\n');
      process.exitCode = 6;
    });
}

// `argv[1]` is this file when invoked as the `mycoder` binary. Guarded so the
// test suite can import `checkRuntime` without starting a session.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
