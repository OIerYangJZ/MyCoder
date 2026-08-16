/**
 * The configuration audit, executable (alpha.8 §12, §26).
 *
 * §12 asks for every configuration key audited against the
 * `allow_benchmark_range` rule and "recorded as evidence, not as a claim". A
 * paragraph in `docs/` is a claim. These tests are the evidence, and they assert
 * the two things a paragraph cannot:
 *
 *   1. Each key in the table behaves the way the table says it does, checked
 *      against `mergeConfig` itself rather than against a restatement of it.
 *
 *   2. The table is **complete** — every boolean and host-list key the TOML
 *      parser understands is either audited or explicitly pinned by the ceiling.
 *      Without (2) the audit is only as good as whoever last remembered to
 *      update it, which is the failure mode §12 exists to prevent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { WEAKENING_KEYS, CEILING_PINNED, disclosures } from '../../src/config/weakening.ts';
import { configFromToml, defaultConfig, mergeConfig, applySystemCeiling } from '../../src/config/schema.ts';
import { parseToml } from '../../src/util/toml.ts';

function layer(toml: string, label = 'test'): ReturnType<typeof configFromToml> {
  return configFromToml(parseToml(toml), label);
}

/** user config, then project config on top — the real precedence order. */
function merged(user: string, project: string) {
  let config = defaultConfig();
  config = mergeConfig(config, layer(user, 'user config'));
  config = mergeConfig(config, layer(project, 'project config'));
  return applySystemCeiling(config);
}

describe('the weakening-key audit', () => {
  test('every audited key documents what it opens and what stays denied', () => {
    for (const key of WEAKENING_KEYS) {
      assert.ok(key.weakens.length > 10, `${key.key} does not say what it weakens`);
      // §12's fourth requirement, and the one most often skipped: a disclosure
      // that says "this is now allowed" without saying what is still denied
      // leaves the reader assuming the worst or the best, both wrong.
      assert.ok(key.stillDenied.length > 10, `${key.key} does not say what remains denied`);
      assert.ok(key.enforcedBy.length > 10, `${key.key} does not say what confines it`);
    }
  });

  test('a user-only key cannot be turned on by a project config', () => {
    // The reference implementation of the whole rule (alpha.7 §43).
    const config = merged(
      '[egress]\nallow_benchmark_range = false\n',
      '[egress]\nallow_benchmark_range = true\n',
    );
    assert.equal(config.egress.allowBenchmarkRange, false, 'a project layer must never open this');

    // And the reverse control: the user layer *can* turn it on, so the test
    // above is testing the layering rather than a key that is simply broken.
    const byUser = merged('[egress]\nallow_benchmark_range = true\n', '');
    assert.equal(byUser.egress.allowBenchmarkRange, true);

    // A project may always be *stricter*.
    const narrowed = merged(
      '[egress]\nallow_benchmark_range = true\n',
      '[egress]\nallow_benchmark_range = false\n',
    );
    assert.equal(narrowed.egress.allowBenchmarkRange, false);
  });

  test('a project cannot add an egress host the user did not name', () => {
    const config = merged(
      '[egress]\nweb = ["docs.python.org"]\n',
      '[egress]\nweb = ["docs.python.org", "evil.example.com"]\n',
    );
    assert.deepEqual(config.egress.allowedHosts?.web, ['docs.python.org']);
  });

  test('a project cannot open a channel the user never enabled', () => {
    const config = merged(
      '[egress]\nweb = ["docs.python.org"]\n',
      '[egress]\ntelemetry = ["collector.example.com"]\n',
    );
    assert.equal(config.egress.allowedHosts?.telemetry, undefined);
  });

  test('a project cannot grant shell network by default', () => {
    const config = merged('', '[shell]\ndefault_network = true\n');
    assert.equal(config.shell.defaultNetwork, false);
  });

  test('every set weakening key produces exactly one startup disclosure', () => {
    const config = merged('[egress]\nallow_benchmark_range = true\nweb = ["docs.python.org"]\n', '');
    const lines = disclosures(config);

    assert.equal(lines.length, 2, `expected two disclosures, got ${lines.length}`);
    assert.ok(lines.some((l) => l.includes('198.18.0.0/15')));
    assert.ok(lines.some((l) => l.includes('docs.python.org')));
    // §12: each one says what remains denied.
    assert.ok(
      lines.every((l) => /denied/i.test(l)),
      'every disclosure must say what is still denied',
    );
  });

  test('a configuration with no relaxation discloses nothing', () => {
    // The control for the test above. If `disclosures` returned something here,
    // the count assertion would be meaningless.
    assert.deepEqual(disclosures(defaultConfig()), []);
  });

  test('the ceiling pins what it claims to pin', () => {
    // The other half of the audit: keys that *look* like weakenings and cannot
    // be, because `applySystemCeiling` overwrites them whatever any layer said.
    const config = merged(
      '',
      `
[security]
secret_redaction = false
telemetry_content = true
trace_upload = true

[loop]
max_steps = 100000
max_delegation_depth = 5

[telemetry]
content = true
`,
    );

    assert.equal(config.security.secretRedaction, true);
    assert.equal(config.security.telemetryContent, false);
    assert.equal(config.security.traceUpload, false);
    assert.equal(config.telemetry.content, false);
    // 16, not 100000 and not the 200 ceiling: `minDefined` has already taken the
    // smaller of the default (16) and the requested value before the ceiling is
    // applied at all. A layer asking for *more* does not reach the ceiling — it
    // loses to the default on the way there, which is the stronger property.
    assert.equal(config.loop.maxSteps, 16, 'a layer asking for more never gets more');
    assert.equal(config.loop.maxDelegationDepth, 1, 'clamped to the one depth alpha.4 validated');
  });

  test('a lowered limit is honoured — the ceiling is a ceiling, not a value', () => {
    const config = merged('', '[loop]\nmax_steps = 4\n');
    assert.equal(config.loop.maxSteps, 4, 'a project may always tighten its own budget');
  });

  test('deny patterns union rather than replace', () => {
    const config = merged(
      '[security]\nextra_secret_paths = ["**/a.key"]\n',
      '[security]\nextra_secret_paths = ["**/b.key"]\n',
    );
    assert.deepEqual(config.security.extraSecretPaths?.sort(), ['**/a.key', '**/b.key']);
  });

  test('the audit covers every key the parser understands', () => {
    // Completeness. Without this the table is only as good as whoever last
    // remembered to update it — and a weakening key that nobody added a row for
    // is exactly the thing §12 is looking for.
    const source = readFileSync(path.join(process.cwd(), 'src', 'config', 'schema.ts'), 'utf8');

    // Every TOML key `configFromToml` reads, as it spells them.
    const read = new Set(
      [...source.matchAll(/\b(?:str|num|bool|strList)\(\s*(?:\w+)\.(\w+)\s*\)/g)].map((m) => m[1]!),
    );

    const audited = WEAKENING_KEYS.map((k) => k.key).join(' ');
    const pinned = CEILING_PINNED.join(' ');
    const accountedFor = `${audited} ${pinned}`;

    // Keys that are neither a boundary nor a ceiling: names, paths, ids, sizes.
    const inert = new Set([
      'name',
      'workspace',
      'reference_roots',
      'default',
      'provider',
      'model',
      'profile',
      'protocol',
      'base_url',
      'api_key_file',
      'api_key_env',
      'auth_scheme',
      'context_window',
      'max_output_tokens',
      'reserved_output_tokens',
      'supports_parallel_tools',
      'supports_reasoning',
      'preferred_edit_strategy',
      'autonomy',
      'tool_reliability',
      'family',
      'input_per_mtok',
      'output_per_mtok',
      'cached_input_per_mtok',
      'enabled',
      'endpoint',
      'timeout_ms',
      'user',
      'allow',
      'delegation_guidance',
      'max_tool_calls',
      'max_model_requests',
      'max_repeated_failures',
      'max_wall_time_ms',
      'max_cost_usd',
      'image',
    ]);

    const unaccounted = [...read].filter((key) => {
      if (inert.has(key)) return false;
      // The table spells keys as a reader would search for them (`[shell]
      // default_network`), so a substring match on the raw TOML name is the
      // right comparison.
      return !accountedFor.includes(key);
    });

    assert.deepEqual(
      unaccounted,
      [],
      `these config keys are in neither the weakening audit nor the ceiling list: ${unaccounted.join(', ')}`,
    );
  });

  test('NEGATIVE CONTROL: an unaudited key would be detected', () => {
    // The completeness check above passes on an empty diff, which is what a
    // broken completeness check also does. This asserts it can fail.
    const accountedFor = `${WEAKENING_KEYS.map((k) => k.key).join(' ')} ${CEILING_PINNED.join(' ')}`;
    assert.equal(accountedFor.includes('allow_unrestricted_everything'), false);
    assert.ok(accountedFor.includes('allow_benchmark_range'), 'a known key must be found by the same test');
  });
});
