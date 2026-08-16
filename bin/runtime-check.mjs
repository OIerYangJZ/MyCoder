/**
 * The runtime-version policy, as pure functions (ADR-0019 §3).
 *
 * Separate from `mycoder.mjs` for one reason found the hard way: the entry point
 * cannot have an `isMain` guard.
 *
 * `npm install -g` links `<prefix>/bin/mycoder` as a **symlink** to the real file
 * under `lib/node_modules/`. Node sets `process.argv[1]` to the symlink path and
 * `import.meta.url` to the resolved one, so the usual
 * `import.meta.url === pathToFileURL(process.argv[1]).href` guard is false on
 * every global install — and the shim did nothing at all. No output, exit 0. The
 * install dogfood (§25) found it in the first command it ran.
 *
 * The guard existed only so the test suite could import `checkRuntime` without
 * starting a session. Moving those two functions here removes the need for it:
 * `mycoder.mjs` is now unconditionally an entry point, which is what it is.
 *
 * Plain JavaScript, ES2018, no type annotations — this file is loaded by the
 * version check itself, so it has to parse on the versions being rejected.
 */

/** Exit code 5 = UNAVAILABLE (ADR-0021): the machine cannot provide it. */
export var EXIT_UNAVAILABLE = 5;

export function parseVersion(text) {
  var m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `a` is strictly older than `b`. Numeric, never lexical. */
export function isOlder(a, b) {
  for (var i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/**
 * The message §8 asks for: what is wrong, what is required, and what to do.
 *
 * In that order, and the order is asserted by the test. A remedy printed above
 * the problem reads as a suggestion rather than an instruction.
 */
export function runtimeUnsupportedMessage(found, required) {
  return [
    'mycoder: RUNTIME_UNSUPPORTED',
    '',
    '  This is Node ' + found + '. MyCoder needs Node >= ' + required + '.',
    '',
    '  Why: MyCoder needs a Node new enough to run what it ships (ADR-0019).',
    '  Below ' + required + ' the package will not load.',
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

/**
 * Is `foundText` at or above `floor`?
 *
 * Fails **open** when either is unparseable. Uniquely in this codebase, and
 * deliberately: this check guards ergonomics, not a boundary. Refusing to start
 * because a version string could not be parsed would turn a cosmetic problem into
 * an outage, and the real failure on a genuinely old runtime is still legible
 * even if less pretty.
 */
export function checkRuntime(foundText, floor) {
  var found = parseVersion(foundText);
  if (!found || !floor) return { ok: true };
  if (!isOlder(found, floor)) return { ok: true };
  return { ok: false, message: runtimeUnsupportedMessage(found.join('.'), floor.join('.')) };
}
