/**
 * CLI smoke tests, run as a real subprocess.
 *
 * These exist because the interesting CLI failures are process-shaped: input
 * that arrives on a pipe instead of a terminal, an exit code that a script will
 * branch on, output that lands on the wrong stream. An in-process test of
 * `main()` would not have caught the readline bug that ate piped stdin.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const CLI = path.join(process.cwd(), 'src', 'cli', 'main.ts');

/**
 * The least config a temp workspace needs to run a turn.
 *
 * Tests that run turns from `process.cwd()` inherit the repository's own
 * `.mycoder/config.toml`, which pins `model = "fake"`. A test that points `--cwd`
 * somewhere else inherits nothing and dies at startup with PROVIDER_NOT_CONFIGURED —
 * which is the correct behaviour and a confusing test failure.
 */
const FAKE_MODEL_CONFIG = '[project]\nname = "t"\nworkspace = "."\n\n[model]\ndefault = "fake"\n';

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

async function runCli(args: string[], stdin = '', cwd?: string): Promise<RunResult> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'agent-cli-'));

  return new Promise<RunResult>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd ?? process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        // Keep the test out of the developer's real session store.
        MYCODER_DATA_DIR: path.join(dataRoot, 'data'),
        MYCODER_CONFIG_DIR: path.join(dataRoot, 'config'),
        MYCODER_CACHE_DIR: path.join(dataRoot, 'cache'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.stdin.end(stdin);

    child.on('close', (code) => {
      void rm(dataRoot, { recursive: true, force: true });
      resolve({ stdout, stderr, code });
    });
  });
}

describe('CLI', () => {
  test('--help lists the documented flags and exits 0', async () => {
    const result = await runCli(['--help']);
    assert.equal(result.code, 0);
    for (const flag of [
      '--continue',
      '--resume',
      '--model',
      '--profile',
      '--cwd',
      '--remote',
      '--read-only',
      '--json',
    ]) {
      assert.ok(result.stdout.includes(flag), `${flag} is missing from the usage text`);
    }
  });

  test('an unknown flag exits non-zero rather than starting a session', async () => {
    const result = await runCli(['--not-a-real-flag']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unknown flag/);
  });

  test('--print-config reports the effective configuration', async () => {
    const result = await runCli(['--print-config']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /permission profile\s+:/);
    assert.match(result.stdout, /secret redaction\s+: on/);
  });

  test('piped slash commands are executed, one per line', async () => {
    // The regression this guards: creating a readline interface over a pipe
    // consumed the buffered lines before anything iterated them.
    const result = await runCli(['--non-interactive'], '/model list\n/goal set ship v0.1\n/goal status\n');

    assert.match(result.stdout, /Available models:/);
    assert.match(result.stdout, /Goal set: ship v0\.1/);
    assert.match(result.stdout, /Goal \(active\): ship v0\.1/);
  });

  test('status is printed on startup and states the isolation honestly', async () => {
    // The assertion is about substance, not punctuation: the startup surface names
    // the isolation, says what the network guarantee is worth, and never claims OS
    // isolation on the local backend (invariant 5). alpha.12 moved this from a
    // `/status` dump into a banner and the label lost its colon; what must not
    // change is that the line is there at all.
    const result = await runCli(['--non-interactive'], '');
    assert.match(result.stderr, /isolation\s+policy-enforced/);
    assert.match(result.stderr, /network from Shell is best-effort/);
    assert.equal(
      /os-isolated/.test(result.stderr),
      false,
      'must not claim OS isolation on the local backend',
    );
  });

  test('--json puts machine-readable records on stdout and prose on stderr', async () => {
    const result = await runCli(['--non-interactive', '--json'], '/status\n');

    const lines = result.stdout.trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'stdout carried no records');
    for (const line of lines) {
      const parsed = JSON.parse(line) as { type: string };
      assert.ok(['control', 'turn'].includes(parsed.type));
    }
  });

  test('a one-shot prompt runs a turn and exits without waiting on stdin', async () => {
    const result = await runCli(['--non-interactive', 'say something'], '');
    assert.equal(result.code, 0);
    // The default model alias is `fake`, whose empty script yields this.
    assert.match(result.stdout, /fake model/);
  });

  test('@path resolves the same way on every input path, not only interactively', async () => {
    // It was interactive-only at first, on the argument that a pipe has no user to be
    // helpful to. `mycoder "explain @src/app.ts"` is a person at a shell, and a
    // feature that works in one of three places is a feature nobody trusts.
    const ws = await mkdtemp(path.join(tmpdir(), 'agent-at-'));
    await mkdir(path.join(ws, '.mycoder'), { recursive: true });
    await writeFile(path.join(ws, '.mycoder', 'config.toml'), FAKE_MODEL_CONFIG);
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'thing.ts'), 'export const marker = 1;\n');

    const piped = await runCli(['--cwd', ws, '--non-interactive'], 'look at @src/thing.ts\n');
    assert.match(piped.stderr, /attached src\/thing\.ts/, 'a piped @ was not resolved');

    const oneShot = await runCli(['--cwd', ws, '--non-interactive', 'look at @src/thing.ts']);
    assert.match(oneShot.stderr, /attached src\/thing\.ts/, 'a one-shot @ was not resolved');

    await rm(ws, { recursive: true, force: true });
  });

  test('a reference outside the workspace stays literal text, in a pipe as well', async () => {
    // The rules do not relax because nobody is watching: the same boundary check runs
    // on every path, and what it refuses it says out loud rather than silently drops.
    const ws = await mkdtemp(path.join(tmpdir(), 'agent-at-'));
    await mkdir(path.join(ws, '.mycoder'), { recursive: true });
    await writeFile(path.join(ws, '.mycoder', 'config.toml'), FAKE_MODEL_CONFIG);
    const result = await runCli(['--cwd', ws, '--non-interactive'], 'read @../../etc/hosts\n');
    assert.match(result.stderr, /left as text — outside the workspace/);
    assert.equal(/attached/.test(result.stderr), false);
    await rm(ws, { recursive: true, force: true });
  });

  test('--read-only conflicting with --profile is refused', async () => {
    const result = await runCli(['--read-only', '--profile', 'workspace-dev']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /conflicts/);
  });

  test('a workspace with a broken config file starts anyway and warns', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'agent-badcfg-'));
    try {
      await mkdir(path.join(base, '.agent'), { recursive: true });
      await writeFile(path.join(base, '.agent', 'config.toml'), '[project\nname = "broken"\n', 'utf8');

      const result = await runCli(['--print-config', '--cwd', base]);

      // A syntax error must not stop the user working, but it must be visible:
      // a silently ignored config is a different security posture than the file
      // appears to describe.
      assert.equal(result.code, 0);
      assert.match(result.stdout, /could not be parsed/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('--profile read-only is reflected in status', async () => {
    const result = await runCli(['--non-interactive', '--profile', 'read-only'], '');
    assert.match(result.stderr, /profile\s+read-only/);
  });

  test('a misspelled --profile is refused rather than dropped', async () => {
    // It used to start a `workspace-dev` session — wider than the one asked for —
    // and say so only in a warning above the banner.
    const result = await runCli(['--non-interactive', '--profile', 'read-onl'], '');
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--profile must be one of read-only, review, workspace-dev/);
  });

  test('a misspelled --log-level is refused rather than dropped', async () => {
    const result = await runCli(['--non-interactive', '--log-level', 'verbose'], '');
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--log-level must be one of/);
  });

  test('--print-config answers for the flags on the same command line', async () => {
    // "The effective configuration" includes the flags, which sit above every
    // file layer (§22). Printing the file layers alone described a session the
    // command as typed would not have started.
    const plain = await runCli(['--print-config']);
    assert.match(plain.stdout, /permission profile\s+: workspace-dev/);

    const narrowed = await runCli(['--print-config', '--read-only']);
    assert.equal(narrowed.code, 0);
    assert.match(narrowed.stdout, /permission profile\s+: read-only/);

    const quiet = await runCli(['--print-config', '--no-telemetry']);
    assert.match(quiet.stdout, /telemetry\s+: off/);
  });

  test('-r with an id nothing was recorded under is refused, not started fresh', async () => {
    // It used to become the id of a *new* session: a resume that said nothing and
    // began from zero, whatever the mistake behind the id was.
    const result = await runCli(['--non-interactive', '-r', 'ses_not_a_session'], '');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No session "ses_not_a_session" was found/);
    assert.equal(/Resumed session/.test(result.stderr), false);
  });

  test('doctor terminates its last line', async () => {
    // Without it the last line and the next shell prompt share a row.
    const result = await runCli(['doctor']);
    assert.ok(result.stdout.endsWith('\n'), 'doctor output must end with a newline');
  });
});
