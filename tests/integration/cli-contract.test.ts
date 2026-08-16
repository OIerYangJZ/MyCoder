/**
 * The CLI contract (alpha.8 §14, §15, §26; ADR-0021).
 *
 * Every case here is something a wrapper script depends on and cannot recover if
 * we break it silently: an exit code it branches on, a JSON field it reads, a
 * flag it passes. The whole point of writing them down is that "we did not mean
 * to change that" is not available as a defence once somebody's cron job has been
 * running for a year.
 *
 * Run as real subprocesses. An in-process `main()` call cannot observe which
 * stream something landed on, and the stream split is half the contract.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { runCli, cliRoot } from '../helpers/cli.ts';
import { EXIT, EXIT_NAMES, exitCodeForError, exitCodeForTurn } from '../../src/cli/exit-codes.ts';
import { CONTRACT_FLAGS, EXPERIMENTAL_FLAGS, USAGE } from '../../src/cli/args.ts';
import { ERROR_CODES } from '../../src/util/errors.ts';

const WORKING_CONFIG = `
[model.provider.p]
protocol = "openai-chat"
base_url = "https://api.example.com"
api_key_env = "MYCODER_TEST_KEY_ABSENT"

[model.profile.f]
context_window = 128000

[model.alias.m]
provider = "p"
model = "m-1"
profile = "f"

[model]
default = "m"
`;

async function seedConfig(root: string, toml: string): Promise<void> {
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'config.toml'), toml, 'utf8');
}

describe('exit codes are a contract', { timeout: 120_000 }, () => {
  test('every error code maps to a documented exit code', () => {
    // Exhaustiveness is enforced by `Record<ErrorCode, ExitCode>` at compile
    // time; this asserts the runtime consequence, which is what a script sees.
    for (const code of ERROR_CODES) {
      const exit = exitCodeForError(code);
      assert.ok(
        Object.values(EXIT).includes(exit),
        `${code} maps to ${exit}, which is not one of ${Object.values(EXIT).join('/')}`,
      );
      assert.ok(EXIT_NAMES[exit], `${exit} has no name`);
    }
  });

  test('the six meanings are distinct and none collides with a shell code', () => {
    const values = Object.values(EXIT);
    assert.equal(new Set(values).size, values.length, 'two exit codes share a number');
    for (const v of values) {
      assert.ok(v >= 0 && v <= 6, `${v} is outside 0-6; 127 and >=128 belong to the shell`);
    }
  });

  test('CONFIG and UNAVAILABLE are not conflated — the user file vs the user machine', () => {
    // The distinction ADR-0021 calls the most important one. A script that
    // retries is right to retry UNAVAILABLE and wrong to retry CONFIG.
    assert.equal(exitCodeForError('CREDENTIAL_FILE_INSECURE'), EXIT.CONFIG);
    assert.equal(exitCodeForError('PROVIDER_NOT_CONFIGURED'), EXIT.CONFIG);
    assert.equal(exitCodeForError('CONFIG_INVALID'), EXIT.CONFIG);

    assert.equal(exitCodeForError('CONTAINER_RUNTIME_NOT_FOUND'), EXIT.UNAVAILABLE);
    assert.equal(exitCodeForError('SANDBOX_UNSUPPORTED'), EXIT.UNAVAILABLE);
    assert.equal(exitCodeForError('RUNTIME_UNSUPPORTED'), EXIT.UNAVAILABLE);
  });

  test('a denial is not an incompletion', () => {
    // "The agent is unreliable" gets reported for sessions that were doing
    // exactly what they were configured to do, when these two are the same code.
    assert.equal(exitCodeForError('TOOL_DENIED'), EXIT.DENIED);
    assert.equal(exitCodeForError('PROTECTED_PATH'), EXIT.DENIED);
    assert.equal(exitCodeForError('NETWORK_SCOPE_DENIED'), EXIT.DENIED);

    assert.equal(exitCodeForError('LOOP_BUDGET_EXCEEDED'), EXIT.INCOMPLETE);
    assert.equal(exitCodeForError('REPEATED_FAILURE'), EXIT.INCOMPLETE);
    assert.equal(exitCodeForError('CANCELLED'), EXIT.INCOMPLETE);
  });

  test('a completed turn is 0; a turn that carried a denial reports the denial', () => {
    assert.equal(exitCodeForTurn('completed'), EXIT.OK);
    assert.equal(exitCodeForTurn('failed'), EXIT.INCOMPLETE);
    assert.equal(exitCodeForTurn('cancelled'), EXIT.INCOMPLETE);
    // Not INCOMPLETE: the reason the turn ended is the useful fact.
    assert.equal(exitCodeForTurn('failed', 'TOOL_DENIED'), EXIT.DENIED);
    assert.equal(exitCodeForTurn('failed', 'CONTAINER_RUNTIME_NOT_FOUND'), EXIT.UNAVAILABLE);
  });

  test('an unknown flag exits USAGE (2)', async () => {
    const result = await runCli({ args: ['--not-a-flag'] });
    assert.equal(result.code, EXIT.USAGE);
    assert.match(result.stderr, /Unknown flag/);
  });

  test('conflicting flags exit USAGE (2) and say which two', async () => {
    const result = await runCli({ args: ['--read-only', '--profile', 'workspace-dev'] });
    assert.equal(result.code, EXIT.USAGE);
    assert.match(result.stderr, /conflicts/);
  });

  test('no provider configured exits CONFIG (3), with a remedy and no session', async () => {
    const result = await runCli({ args: ['--non-interactive', 'hello'] });

    assert.equal(result.code, EXIT.CONFIG);
    assert.match(result.stderr, /PROVIDER_NOT_CONFIGURED/, 'names the problem');
    assert.match(result.stderr, /config\.toml/, 'names the file to create');
    assert.match(result.stderr, /\[model\.provider\./, 'names the keys to set');
    assert.match(result.stderr, /mycoder doctor/, 'names the command to verify');

    // §10's forbidden outcomes, asserted as absences.
    assert.doesNotMatch(result.stderr, /at [A-Za-z]+ \(.*:\d+:\d+\)/, 'no stack trace');
    assert.doesNotMatch(result.stdout, /fake model/, 'no silently degraded session');
    assert.equal(result.stdout.trim(), '', 'nothing on stdout for a failed start');
  });

  test('an undefined alias exits CONFIG (3) and lists the ones that exist', async () => {
    const f = await cliRoot();
    try {
      await seedConfig(f.root, WORKING_CONFIG);
      const result = await runCli({ args: ['-m', 'nope', '--non-interactive', 'hi'], root: f.root });
      assert.equal(result.code, EXIT.CONFIG);
      assert.match(result.stderr, /not defined/);
      assert.match(result.stderr, /Defined aliases: m/);
    } finally {
      await f.cleanup();
    }
  });

  test('an insecure credential file exits CONFIG (3) and is never repaired', async () => {
    const f = await cliRoot();
    try {
      const keyPath = path.join(f.root, 'config', 'provider.key');
      await seedConfig(
        f.root,
        WORKING_CONFIG.replace('api_key_env = "MYCODER_TEST_KEY_ABSENT"', 'api_key_file = "provider.key"'),
      );
      await writeFile(keyPath, 'sk-test', 'utf8');
      await chmod(keyPath, 0o644);

      const result = await runCli({ args: ['--non-interactive', 'hi'], root: f.root });

      // CONFIG (3), not INCOMPLETE and not a first turn that fails with
      // MODEL_AUTH_ERROR. Before alpha.8 this started a session, printed a
      // status screen and failed on the first request — §10's "an empty prompt
      // that fails on the first turn".
      assert.equal(result.code, EXIT.CONFIG);
      assert.match(result.stderr, /PROVIDER_NOT_CONFIGURED/, 'names the problem');
      assert.match(result.stderr, /0644/, 'says what the mode is');
      assert.match(result.stderr, /chmod 600/, 'says how to fix it');
      assert.doesNotMatch(result.stdout, /session\s+:/, 'no session was started');

      // The kernel never repairs the file: a tool that silently fixes a
      // permission problem trains people not to look at it.
      assert.equal((await stat(keyPath)).mode & 0o777, 0o644, 'the mode must be untouched');
    } finally {
      await f.cleanup();
    }
  });

  test('a malformed config is visible and does not change the posture silently', async () => {
    const f = await cliRoot();
    try {
      await seedConfig(f.root, '[model\nbroken = ');
      // `--print-config` must work on a config that cannot be honoured: it is
      // the tool you reach for precisely then.
      const result = await runCli({ args: ['--print-config'], root: f.root });
      assert.equal(result.code, EXIT.OK);
      assert.match(result.stdout, /could not be parsed/);
      // Not silently treated as an empty file with default (permissive) values.
      assert.match(result.stdout, /permission profile\s*: workspace-dev/);
    } finally {
      await f.cleanup();
    }
  });
});

describe('--json is a versioned shape', { timeout: 120_000 }, () => {
  test('an error under --json is a JSON object on stdout, not prose on stderr', async () => {
    const result = await runCli({ args: ['--json', '--non-interactive', 'hello'] });

    assert.equal(result.code, EXIT.CONFIG);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `expected one JSON object, got:\n${result.stdout}`);

    const payload = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(payload.schema, 'mycoder.v1');
    assert.equal(payload.type, 'error');
    assert.equal(payload.code, 'PROVIDER_NOT_CONFIGURED');
    assert.equal(payload.exit, EXIT.CONFIG);
    assert.equal(typeof payload.message, 'string');
    assert.equal(typeof payload.remedy, 'string');
  });

  test('every line on stdout under --json parses as JSON', async () => {
    // ADR-0021 §3's rule with teeth: a script doing `mycoder --json | jq` must
    // never have to filter human text out of its input.
    const result = await runCli({ args: ['--json', '--version'] });
    assert.equal(result.code, EXIT.OK);
    for (const line of result.stdout.split('\n').filter((l) => l.trim() !== '')) {
      const parsed = JSON.parse(line) as { schema?: string };
      assert.equal(parsed.schema, 'mycoder.v1', `every object carries the schema tag: ${line}`);
    }
  });

  test('doctor emits the same envelope and a machine-readable verdict', async () => {
    const result = await runCli({ args: ['doctor', '--json'] });
    const payload = JSON.parse(result.stdout.trim()) as {
      schema: string;
      type: string;
      ok: boolean;
      exit: number;
      findings: Array<{ area: string; level: string; detail: string }>;
    };

    assert.equal(payload.schema, 'mycoder.v1');
    assert.equal(payload.type, 'doctor');
    assert.equal(payload.ok, false, 'an unconfigured install is not ready');
    assert.equal(payload.exit, EXIT.CONFIG);
    assert.equal(result.code, EXIT.CONFIG, 'the reported exit and the real one agree');
    assert.ok(
      payload.findings.some((f) => f.area === 'provider' && f.level === 'blocked'),
      'the blocking finding is identified by area, not only by prose',
    );
  });
});

describe('flag stability is declared', () => {
  test('every flag the parser accepts is classified as contract or experimental', () => {
    // A flag in neither list is a flag whose stability nobody decided — the
    // state every flag was in before ADR-0021.
    const source = readFileSync(path.join(process.cwd(), 'src', 'cli', 'args.ts'), 'utf8');

    // The `case '--x':` labels in the switch are the accepted set.
    const accepted = [...source.matchAll(/case '(-[^']+)':/g)].map((m) => m[1]!);
    const classified = new Set([...CONTRACT_FLAGS, ...EXPERIMENTAL_FLAGS]);

    const unclassified = accepted.filter((f) => !classified.has(f));
    assert.deepEqual(
      unclassified,
      [],
      `these flags are in neither stability list: ${unclassified.join(', ')}`,
    );
  });

  test('--help marks the experimental flags as experimental', () => {
    assert.match(USAGE, /Experimental/);
    for (const flag of EXPERIMENTAL_FLAGS) {
      if (flag === '--force') continue; // a modifier of setup-credential, listed there
      assert.ok(USAGE.includes(flag), `${flag} should appear in --help`);
    }
  });

  test('--help documents the exit codes', () => {
    // The contract is only usable if the person writing the wrapper can find it.
    assert.match(USAGE, /Exit codes/);
    for (const name of Object.values(EXIT_NAMES)) {
      assert.ok(USAGE.toLowerCase().includes(name.toLowerCase()), `${name} should be documented in --help`);
    }
  });
});
