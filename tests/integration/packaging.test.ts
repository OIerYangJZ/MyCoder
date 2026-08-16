/**
 * What the artifact actually contains (alpha.8 §9, §26; ADR-0019 §4/§5).
 *
 * §9 is precise about the shape this has to take: a **content assertion**, not an
 * `.npmignore` review. So these tests pack the real tree with `npm pack
 * --dry-run` and inspect the file list npm produces — the same list a consumer's
 * disk would receive.
 *
 * The reverse controls matter more here than usual. `checkPackedFiles` returning
 * "nothing forbidden" is exactly what a check with a broken predicate returns, so
 * every rule is also fed a path it must reject. AGENTS.md rule: a security test
 * is not evidence until the opposite result is demonstrably possible under its
 * control configuration.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkPackedFiles, packedFileList, FORBIDDEN, REQUIRED } from '../../scripts/package-check.ts';

// npm has to shell out and stat the tree; slower than a unit test and still well
// under a second on a warm cache.
describe('the packaged artifact', { timeout: 60_000 }, () => {
  const files = packedFileList();

  test('contains nothing forbidden and nothing is missing', () => {
    const result = checkPackedFiles(files);

    assert.deepEqual(
      result.violations,
      [],
      `forbidden paths in the package:\n${result.violations.map((v) => `  ${v.path} (${v.rule})`).join('\n')}`,
    );
    assert.deepEqual(result.missing, [], 'the package is missing files it cannot work without');
  });

  test('NEGATIVE CONTROL: every forbidden rule rejects something', () => {
    // Without this, a rule whose predicate stopped matching would report a clean
    // package forever — which is what a clean package looks like. This is the
    // same failure the lint self-tests were written for in alpha.3, where five
    // rules turned out to be incapable of firing.
    const probes: Record<string, string> = {
      'reference tree': 'reference/spec/kernel.md',
      'research tree': 'research/v0.1.0-alpha.8_productization.md',
      'eval results': 'evals/results/release/run.json',
      tests: 'tests/security/canary.test.ts',
      'milestone documents': 'docs/alpha7-status.md',
      'credential or key material': 'config/secrets/provider.key',
      'local state': '.mycoder/sessions/ses_1/events.jsonl',
      'CI and repository plumbing': '.github/workflows/ci.yml',
      'build output': 'build/mycoder-sandbox',
    };

    for (const rule of FORBIDDEN) {
      const probe = probes[rule.rule];
      assert.ok(probe, `no probe path is defined for the rule "${rule.rule}"`);
      assert.ok(rule.match(probe!), `the rule "${rule.rule}" did not reject ${probe}`);
    }

    // And the whole checker, end to end, on a list that contains one of each.
    const result = checkPackedFiles([...REQUIRED, ...Object.values(probes)]);
    assert.equal(
      result.violations.length,
      Object.keys(probes).length,
      'each planted path should have produced exactly one violation',
    );
    assert.deepEqual(result.missing, []);
  });

  test('NEGATIVE CONTROL: a missing required file is reported', () => {
    const result = checkPackedFiles(files.filter((f) => f !== 'bin/mycoder.mjs'));
    assert.deepEqual(result.missing, ['bin/mycoder.mjs']);
  });

  test('the entry point is the plain-JS shim, not a TypeScript file', () => {
    // ADR-0019 §3. If `bin` ever points at a `.ts` file again, an unsupported
    // runtime goes back to failing with `SyntaxError: Unexpected token ':'` —
    // the failure §8 exists to prevent, and one that would not otherwise show up
    // in any test on a machine new enough to run the suite.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      bin: Record<string, string>;
      files: string[];
      engines: { node: string };
    };

    assert.equal(pkg.bin.mycoder, './bin/mycoder.mjs');
    assert.ok(pkg.bin.mycoder.endsWith('.mjs'), 'the bin entry must be parseable without type stripping');

    const shim = readFileSync('bin/mycoder.mjs', 'utf8');
    // The check has to happen before anything with type annotations is loaded.
    const checkAt = shim.indexOf('checkRuntime(process.versions.node');
    const importAt = shim.indexOf("import('../src/cli/main.ts')");
    assert.ok(checkAt > 0 && importAt > 0, 'the shim should check the runtime and then import the kernel');
    assert.ok(checkAt < importAt, 'the version check must run before the TypeScript entry point is imported');
  });

  test('the declared engine floor is the one the shim enforces', () => {
    // ADR-0019 §2 keeps the floor in exactly one place. Two copies of a version
    // floor is one copy that goes stale, so the shim reads `engines.node` rather
    // than repeating it — and this asserts that it still does.
    const shim = readFileSync('bin/mycoder.mjs', 'utf8');
    assert.match(shim, /engines/, 'the shim should read the floor from package.json');
    assert.doesNotMatch(
      shim.replace(/^\s*\*.*$/gm, ''),
      /2[0-9]\.\d+\.\d+/,
      'the shim must not hard-code a version outside its comments',
    );
  });

  test('the package declares a floor at or above the type-stripping default', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { engines: { node: string } };
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(pkg.engines.node);
    assert.ok(m, 'engines.node should carry a concrete version');
    const [major, minor] = [Number(m![1]), Number(m![2])];
    // 22.18 is where `--experimental-strip-types` stopped being required. A floor
    // below it is a floor the `bin` entry cannot honour.
    assert.ok(
      major > 22 || (major === 22 && minor >= 18),
      `engines.node is ${pkg.engines.node}, below 22.18.0`,
    );
  });
});
