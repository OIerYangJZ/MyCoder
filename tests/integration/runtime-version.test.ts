/**
 * The unsupported-runtime failure (alpha.8 §8, §26; ADR-0019 §3).
 *
 * The awkward thing about testing this is that the suite runs on a *supported*
 * runtime by definition — the test file itself has type annotations in it. So the
 * check cannot be exercised by "run on an old Node"; it has to be exercised by
 * calling the shim's pure functions with a version this process is not running.
 *
 * That is why `checkRuntime` and `runtimeUnsupportedMessage` are exported from
 * `bin/mycoder.mjs` rather than buried in its `run()`. The alternative —
 * downloading an old Node in CI to watch it fail — tests npm's cache more than it
 * tests the message.
 *
 * What is still tested for real: that the shim *parses* under a parser with no
 * type stripping at all, which is the property the whole design turns on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { checkRuntime, runtimeUnsupportedMessage } from '../../bin/runtime-check.mjs';

const FLOOR = [22, 18, 0] as const;

describe('the runtime version check', () => {
  test('an older Node is refused, and the message names problem, version and remedy', () => {
    const verdict = checkRuntime('20.11.1', FLOOR);

    assert.equal(verdict.ok, false);
    const message = verdict.message!;

    // §26's assertion set, applied to this case.
    assert.match(message, /RUNTIME_UNSUPPORTED/, 'the message must name the problem');
    assert.match(message, /20\.11\.1/, 'it must say what was found');
    assert.match(message, /22\.18\.0/, 'it must say what is required');
    assert.match(message, /nvm install 22|nodejs\.org/, 'it must say what to do');
    assert.match(message, /node --version/, 'it must say how to verify');

    // A stack trace is the outcome §10 forbids; so is a bare parser error.
    assert.doesNotMatch(message, /SyntaxError|Unexpected token|at Object\./);
  });

  test('the boundary is inclusive: exactly the floor is supported', () => {
    assert.equal(checkRuntime('22.18.0', FLOOR).ok, true);
    assert.equal(checkRuntime('22.17.9', FLOOR).ok, false);
    assert.equal(checkRuntime('22.19.0', FLOOR).ok, true);
    assert.equal(checkRuntime('24.0.0', FLOOR).ok, true);
    // A double-digit minor must not compare as a string: '22.9' > '22.18'
    // lexically, and that would refuse a supported runtime.
    assert.equal(checkRuntime('22.9.0', FLOOR).ok, false);
    assert.equal(checkRuntime('23.1.0', FLOOR).ok, true);
  });

  test('an unparseable version is allowed through rather than blocking a valid runtime', () => {
    // Fail *open* here, uniquely. This check guards ergonomics, not a boundary:
    // refusing to start because we could not parse a version string would turn a
    // cosmetic problem into an outage, and the real failure that follows on a
    // genuinely old runtime is still legible even if less pretty.
    assert.equal(checkRuntime('not-a-version', FLOOR).ok, true);
    assert.equal(checkRuntime('22.18.0', null).ok, true);
  });

  test('the exit code is UNAVAILABLE, not a generic failure', () => {
    // ADR-0021: "the machine cannot provide it" is 5, and a wrapper retrying
    // after an install is right to branch on that rather than on prose.
    const shim = readFileSync(path.join(process.cwd(), 'bin', 'runtime-check.mjs'), 'utf8');
    assert.match(shim, /EXIT_UNAVAILABLE = 5/);
  });

  test('the shim parses with type stripping disabled', () => {
    // The property everything else rests on. `--no-experimental-strip-types`
    // gives us a parser that behaves like a Node below the floor, so this is as
    // close to the real failure as it is possible to get on a supported runtime.
    const result = spawnSync(
      process.execPath,
      ['--no-experimental-strip-types', '--input-type=module', '-e', 'process.exit(0)'],
      { encoding: 'utf8' },
    );
    // Older/newer Node may not accept the negated flag; skip rather than fail on
    // a runtime where the control itself is unavailable.
    if (result.status !== 0) return;

    const parsed = spawnSync(
      process.execPath,
      ['--no-experimental-strip-types', '--check', path.join(process.cwd(), 'bin', 'mycoder.mjs')],
      { encoding: 'utf8' },
    );
    assert.equal(
      parsed.status,
      0,
      `bin/mycoder.mjs must parse without type stripping, got:\n${parsed.stderr}`,
    );
  });

  test('NEGATIVE CONTROL: the kernel entry point does NOT parse without type stripping', () => {
    // The control that makes the test above mean something. If `src/cli/main.ts`
    // also parsed here, the shim would be proving nothing about why it exists.
    const probe = spawnSync(
      process.execPath,
      ['--no-experimental-strip-types', '--input-type=module', '-e', 'process.exit(0)'],
      { encoding: 'utf8' },
    );
    if (probe.status !== 0) return;

    const parsed = spawnSync(
      process.execPath,
      ['--no-experimental-strip-types', '--check', path.join(process.cwd(), 'src', 'cli', 'main.ts')],
      { encoding: 'utf8' },
    );
    assert.notEqual(parsed.status, 0, 'src/cli/main.ts should be unparseable without type stripping');
  });

  test('the message is the one a user would act on, not a description of one', () => {
    const message = runtimeUnsupportedMessage('18.20.0', '22.18.0');
    // Three sections, in the order a reader needs them: what happened, why, what
    // to do. Asserted by position rather than presence, because a remedy printed
    // above the problem reads as a suggestion rather than an instruction.
    const problemAt = message.indexOf('This is Node 18.20.0');
    const whyAt = message.indexOf('Why:');
    const fixAt = message.indexOf('To fix');
    assert.ok(problemAt >= 0 && whyAt > problemAt && fixAt > whyAt);
  });
});
