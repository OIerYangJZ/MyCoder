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
        AGENT_DATA_DIR: path.join(dataRoot, 'data'),
        AGENT_CONFIG_DIR: path.join(dataRoot, 'config'),
        AGENT_CACHE_DIR: path.join(dataRoot, 'cache'),
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
    const result = await runCli(['--non-interactive'], '');
    assert.match(result.stderr, /isolation\s+: policy-enforced/);
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
    assert.match(result.stderr, /profile\s+: read-only/);
  });
});
