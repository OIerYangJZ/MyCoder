/**
 * Cross-platform smoke suite (plan §3.5: "Windows smoke pass").
 *
 * The full suite assumes POSIX: the local backend spawns `sh`, fixtures use
 * `grep`/`cat`, and the SSH backend builds POSIX snippets. That is a real
 * limitation of v0.1, not something to paper over with `continue-on-error`.
 *
 * What this suite covers is the part that *must* behave identically everywhere,
 * because it is where a platform difference would be a security bug rather than
 * an inconvenience:
 *
 *   - path canonicalisation and containment (separators, case, Unicode form);
 *   - protected-path matching on native paths;
 *   - the permission matrix on native paths;
 *   - secret detection and redaction;
 *   - the pure parsers, which must not depend on line endings;
 *   - the CLI actually starting.
 *
 * Everything here uses `path.join` / `os.tmpdir()` rather than hard-coded POSIX
 * strings, so a failure means a genuine portability defect.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import * as path from 'node:path';

import { canonicalize, isWithin, toPosix, displayPath, type CanonicalPath } from '../../src/util/paths.ts';
import { globMatch } from '../../src/util/glob.ts';
import { detectEol, applyEol, sliceLines } from '../../src/util/text.ts';
import { parseToml } from '../../src/util/toml.ts';
import { validate } from '../../src/util/jsonschema.ts';
import { unifiedDiff } from '../../src/edit/diff.ts';
import { scanSecrets } from '../../src/security/secret-scanner.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { scrubEnv } from '../../src/security/env-scrub.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';
import { PolicyEngine } from '../../src/policy/policy-engine.ts';
import { workspaceDevProfile } from '../../src/policy/profiles.ts';
import { ExactEditEngine } from '../../src/edit/edit-engine.ts';

const CANARY = 'CANARY_SECRET_7f3e9c2a';

describe('paths are portable', () => {
  test('containment uses the native separator', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'smoke-'));
    try {
      const root = (await canonicalize(base, { cwd: base })).path;
      const inside = (await canonicalize(path.join(base, 'src', 'a.ts'), { cwd: base })).path;

      assert.equal(isWithin(root, inside), true);
      assert.equal(isWithin(root, root), true);
      // A sibling sharing a prefix must not be treated as contained, on any OS.
      assert.equal(isWithin(root, `${root}-evil` as CanonicalPath), false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('traversal is collapsed before any check runs', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'smoke-'));
    try {
      await mkdir(path.join(base, 'src'), { recursive: true });
      await writeFile(path.join(base, 'secret.txt'), 'x', 'utf8');

      const resolved = await canonicalize(path.join('src', '..', 'secret.txt'), { cwd: base });
      assert.equal(path.basename(resolved.path), 'secret.txt');
      assert.equal(
        resolved.path.includes('..'),
        false,
        'the canonical form must contain no traversal segment',
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('display paths are workspace-relative', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'smoke-'));
    try {
      const root = (await canonicalize(base, { cwd: base })).path;
      const file = path.join(root, 'src', 'a.ts') as CanonicalPath;
      assert.equal(displayPath(root, file), path.join('src', 'a.ts'));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('glob rules match native paths once posix-ised', () => {
    const native = path.join(path.sep === '\\' ? 'C:\\repo' : '/repo', 'nested', '.env');
    assert.equal(globMatch('**/.env', toPosix(native)), true);
    // Deny rules are case-insensitive, because APFS and NTFS both are.
    assert.equal(globMatch('**/.env', toPosix(native).toUpperCase()), true);
  });
});

describe('protected paths hold on native paths', () => {
  test('secret files and credential directories are refused', () => {
    const home = homedir();
    const pp = new ProtectedPaths({ home });

    const cases = [
      path.join(tmpdir(), 'repo', '.env'),
      path.join(tmpdir(), 'repo', 'certs', 'server.pem'),
      path.join(home, '.ssh', 'id_ed25519'),
      path.join(home, '.aws', 'credentials'),
    ];

    for (const p of cases) {
      assert.equal(pp.checkReadToModel(p as CanonicalPath).protected, true, p);
    }
    assert.equal(
      pp.checkReadToModel(path.join(tmpdir(), 'repo', 'src', 'a.ts') as CanonicalPath).protected,
      false,
    );
    assert.equal(
      pp.checkReadToModel(path.join(tmpdir(), 'repo', '.env.example') as CanonicalPath).protected,
      false,
    );
  });
});

describe('permission matrix holds on native paths', () => {
  test('workspace writes allowed, secrets hard-denied, sudo hard-denied', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'smoke-'));
    try {
      const root = (await canonicalize(base, { cwd: base })).path;
      const engine = new PolicyEngine({
        workspaceRoot: root,
        protectedPaths: new ProtectedPaths({ home: homedir() }),
        layers: [
          {
            name: 'session',
            source: 'session',
            profile: workspaceDevProfile({ workspaceRoot: root }),
          },
        ],
      });

      const src = path.join(root, 'src', 'a.ts') as CanonicalPath;
      assert.equal(
        engine.decide({ kind: 'file.write', path: src, create: false, display: 'src/a.ts' }).action,
        'allow',
      );

      const env = path.join(root, '.env') as CanonicalPath;
      const secret = engine.decide({ kind: 'file.read', path: env, toModel: true, display: '.env' });
      assert.equal(secret.action, 'hard_deny');
      assert.equal(secret.final, true);

      const sudo = engine.decide({
        kind: 'process.exec',
        executable: 'sudo',
        argv: ['sudo', 'ls'],
        cwd: root,
        display: 'sudo ls',
      });
      assert.equal(sudo.action, 'hard_deny');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('secret handling is platform independent', () => {
  test('credential shapes are detected and redacted', () => {
    const redactor = new Redactor();
    redactor.addLiteral(CANARY);

    assert.equal(redactor.redact(`value=${CANARY}`).includes(CANARY), false);
    assert.ok(scanSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789', { minConfidence: 'high' }).length > 0);
    assert.equal(scanSecrets('API_KEY=your_api_key_here').length, 0);
  });

  test('environment scrubbing drops credentials on any platform', () => {
    const { env } = scrubEnv({
      source: { PATH: 'x', HOME: 'y', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'z' },
    });
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
  });
});

describe('parsers do not depend on line endings', () => {
  test('TOML parses identically with CRLF', () => {
    const lf = parseToml('[loop]\nmax_steps = 16\n');
    const crlf = parseToml('[loop]\r\nmax_steps = 16\r\n');
    assert.deepEqual(lf, crlf);
  });

  test('line slicing and EOL detection round-trip', () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    assert.equal(detectEol(crlf).style, 'crlf');
    assert.equal(applyEol('a\nb\nc\n', 'crlf'), crlf);
    assert.equal(sliceLines(crlf, 2, 1).text, 'b');
  });

  test('diff output is LF regardless of input endings', () => {
    const result = unifiedDiff('a\r\nb\r\n', 'a\r\nB\r\n');
    assert.equal(result.text.includes('\r'), false, 'a diff must not carry CR into its own framing');
    assert.equal(result.stats.linesAdded, 1);
  });

  test('JSON Schema validation is unaffected', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } as const;
    assert.equal(validate(schema, { a: 'x' }).ok, true);
    assert.equal(validate(schema, {}).ok, false);
  });
});

describe('atomic write works on the native filesystem', () => {
  test('a create leaves exactly one file and preserves content', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'smoke-'));
    try {
      const root = (await canonicalize(base, { cwd: base })).path;
      const engine = new ExactEditEngine();
      const target = path.join(root, 'new.ts') as CanonicalPath;

      // A minimal executor: the edit engine only needs fs + a capability profile.
      const { LocalExecutionBackend } = await import('../../src/execution/local.ts');
      const backend = new LocalExecutionBackend({ workspaceRoot: root, redactor: new Redactor() });
      const executor = await backend.enforce({
        readRoots: [root],
        writeRoots: [root],
        allowExec: false,
        network: false,
        envAllow: [],
        secretInjections: [],
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      });

      const ctx = {
        freshness: new (await import('../../src/context/freshness.ts')).FreshnessLedger(),
        toolCallId: 'c1' as never,
        turnId: 't1' as never,
        stepId: 's1' as never,
        now: () => Date.now(),
      };

      const planned = await engine.plan(
        { mode: 'create', path: target, displayPath: 'new.ts', content: 'export const a = 1;\n' },
        ctx,
        executor,
      );
      assert.equal(planned.ok, true);
      if (!planned.ok) return;

      await engine.apply(planned.plan, ctx, executor);
      executor.dispose();

      const { readFile, readdir } = await import('node:fs/promises');
      assert.equal(await readFile(target, 'utf8'), 'export const a = 1;\n');
      assert.deepEqual(await readdir(root), ['new.ts'], 'no temp file was left behind');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('the CLI starts', () => {
  const CLI = path.join(process.cwd(), 'src', 'cli', 'main.ts');

  async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'smoke-cli-'));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? homedir(),
          USERPROFILE: process.env.USERPROFILE ?? homedir(),
          SystemRoot: process.env.SystemRoot ?? '',
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
      child.stdin.end('');
      child.on('close', (code) => {
        void rm(dataRoot, { recursive: true, force: true });
        resolve({ stdout, stderr, code });
      });
    });
  }

  test('--version and --help work', async () => {
    const version = await runCli(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /\d+\.\d+\.\d+/);

    const help = await runCli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage:/);
  });

  test('--print-config resolves platform directories', async () => {
    const result = await runCli(['--print-config']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /permission profile\s+:/);
  });
});
