/**
 * First run and credential setup (alpha.8 §10, §11, §26).
 *
 * §10 permits exactly two outcomes and forbids three. The forbidden ones are
 * asserted as *absences* here, which is deliberate: "no stack trace" and "no
 * silently degraded session" are the assertions that would have caught the defect
 * this milestone found, and a test that only checks the happy path would not
 * have.
 *
 * §11's rules are asserted against the filesystem rather than against the
 * command's own report. A setup flow that says it wrote 0600 and wrote 0644 is
 * precisely the failure mode being guarded against.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { runCli, cliRoot } from '../helpers/cli.ts';
import { EXIT } from '../../src/cli/exit-codes.ts';
import { assessReadiness } from '../../src/config/first-run.ts';
import { defaultConfig } from '../../src/config/schema.ts';

const isWindows = process.platform === 'win32';

function configWith(aliases: string): string {
  return `
[model.provider.p]
protocol = "openai-chat"
base_url = "https://api.example.com"
api_key_file = "secrets/p.key"

[model.profile.f]
context_window = 128000
${aliases}
`;
}

describe('first run reaches one of exactly two states', () => {
  test('nothing configured: blocked, naming file, keys and verify command', () => {
    const readiness = assessReadiness({
      config: defaultConfig(),
      sources: [],
      explicitModelDefault: false,
      userConfigDir: '/home/u/.config/mycoder',
    });

    assert.equal(readiness.ready, false);
    assert.ok(!readiness.ready);
    assert.equal(readiness.problem, 'no-provider-configured');
    assert.match(readiness.remedy, /\/home\/u\/\.config\/mycoder\/config\.toml/, 'names the file');
    assert.match(readiness.remedy, /\[model\.provider\./, 'names the keys');
    assert.match(readiness.remedy, /mycoder doctor/, 'names the verify command');
  });

  test('one alias and no default: usable, because a provider was discoverable', () => {
    const config = defaultConfig();
    config.model.providers = { p: { protocol: 'openai-chat', baseUrl: 'https://x' } };
    config.model.aliases = { only: { provider: 'p', model: 'm' } };

    const readiness = assessReadiness({
      config,
      sources: ['/c/config.toml'],
      explicitModelDefault: false,
      userConfigDir: '/c',
    });

    assert.ok(readiness.ready);
    assert.equal(readiness.alias, 'only');
    assert.equal(readiness.inferred, 'only', 'inference is reported, never silent');
  });

  test('two aliases and no default: blocked rather than guessed', () => {
    // Guessing would silently send prompts to one provider rather than another,
    // which is the one thing a default must never do quietly.
    const config = defaultConfig();
    config.model.providers = {
      a: { protocol: 'openai-chat', baseUrl: 'https://a' },
      b: { protocol: 'openai-chat', baseUrl: 'https://b' },
    };
    config.model.aliases = { one: { provider: 'a', model: 'm' }, two: { provider: 'b', model: 'm' } };

    const readiness = assessReadiness({
      config,
      sources: ['/c/config.toml'],
      explicitModelDefault: false,
      userConfigDir: '/c',
    });

    assert.ok(!readiness.ready);
    assert.equal(readiness.problem, 'ambiguous-default');
    assert.match(readiness.message, /one, two|two, one/);
    assert.match(readiness.remedy, /default = /);
  });

  test('fake chosen deliberately is ready — the offline suite depends on it', () => {
    const config = defaultConfig();
    const readiness = assessReadiness({
      config,
      sources: ['/c/config.toml'],
      explicitModelDefault: true,
      userConfigDir: '/c',
    });
    assert.ok(readiness.ready);
    assert.equal(readiness.alias, 'fake');
    assert.equal(readiness.inferred, undefined);
  });

  test('-m fake is an explicit choice, even with no config at all', () => {
    // A regression, found by running `pnpm eval` after the readiness check
    // landed. `mycoder -m fake "…"` is the offline path the README documents and
    // the eval runner's scripted mode; refusing it treated a flag on the command
    // line as if it were a default nobody chose, which is the opposite of what
    // §10 is about.
    const readiness = assessReadiness({
      config: defaultConfig(),
      sources: [],
      explicitModelDefault: false,
      userConfigDir: '/c',
      aliasOverride: 'fake',
    });

    assert.ok(readiness.ready);
    assert.equal(readiness.alias, 'fake');
  });

  test('an alias override still has to resolve to something', () => {
    // The control for the test above: `-m` makes the choice explicit, it does
    // not make an undefined alias acceptable.
    const readiness = assessReadiness({
      config: defaultConfig(),
      sources: [],
      explicitModelDefault: false,
      userConfigDir: '/c',
      aliasOverride: 'not-a-model',
    });

    assert.ok(!readiness.ready);
    assert.equal(readiness.problem, 'alias-undefined');
  });

  test('an injected fake model is always ready, whatever the config says', () => {
    const readiness = assessReadiness({
      config: defaultConfig(),
      sources: [],
      explicitModelDefault: false,
      userConfigDir: '/c',
      injectedFakeModel: true,
    });
    assert.ok(readiness.ready);
  });
});

describe('the workspace itself (ADR-0028)', { timeout: 120_000 }, () => {
  // Until alpha.12 this was refused only for people whose credential happened to
  // be a *file*: the credential check refuses a key inside the workspace, so
  // `api_key_file` users were stopped in a home directory and `api_key_env` users
  // started a session with write access to everything under it. Same directory,
  // same exposure, opposite outcome — and the message told the file users to move
  // a correctly-placed credential.

  /** A config whose credential comes from the environment, not a file. */
  const envCredentialConfig = [
    '[model.provider.p]',
    'protocol = "openai-chat"',
    'base_url = "https://api.example.com"',
    'api_key_env = "FAKE_KEY"',
    '',
    '[model.profile.f]',
    'context_window = 8192',
    '',
    '[model.alias.m]',
    'provider = "p"',
    'model = "m-1"',
    'profile = "f"',
    '',
    '[model]',
    'default = "m"',
    '',
  ].join('\n');

  test('a workspace containing the config directory is refused, with an env credential', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config'), { recursive: true });
      await writeFile(path.join(f.root, 'config', 'config.toml'), envCredentialConfig, 'utf8');

      // cwd is the root, which contains `config/` — the shape of running in `$HOME`.
      const result = await runCli({
        args: ['--non-interactive', 'do nothing'],
        root: f.root,
        cwd: f.root,
        env: { FAKE_KEY: 'sk-not-real' },
      });

      assert.equal(result.code, EXIT.USAGE, `expected USAGE, got ${result.code}:\n${result.stderr}`);
      assert.match(result.stderr, /contains your configuration directory/);
      assert.match(result.stderr, /--cwd/, 'the remedy has to name the lever that fixes it');
      assert.doesNotMatch(
        result.stderr,
        /Move it outside the repository/,
        'the credential is not the thing that is misplaced',
      );
    } finally {
      await f.cleanup();
    }
  });

  test('NEGATIVE CONTROL: an ordinary project workspace is accepted', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config'), { recursive: true });
      await writeFile(path.join(f.root, 'config', 'config.toml'), envCredentialConfig, 'utf8');

      // The same root, but the workspace is a directory beside the config rather
      // than above it — which is every real project.
      const result = await runCli({
        args: ['--print-config'],
        root: f.root,
        env: { FAKE_KEY: 'sk-not-real' },
      });

      assert.equal(result.code, EXIT.OK, `expected OK, got ${result.code}:\n${result.stderr}`);
      assert.doesNotMatch(result.stdout + result.stderr, /contains your configuration directory/);
    } finally {
      await f.cleanup();
    }
  });

  test('doctor blocks on it, and says the same thing', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config'), { recursive: true });
      await writeFile(path.join(f.root, 'config', 'config.toml'), envCredentialConfig, 'utf8');

      const result = await runCli({
        args: ['doctor', '--json'],
        root: f.root,
        cwd: f.root,
        env: { FAKE_KEY: 'sk-not-real' },
      });
      const report = JSON.parse(result.stdout.trim()) as {
        ok: boolean;
        findings: Array<{ area: string; level: string; detail: string }>;
      };

      const workspace = report.findings.find((x) => x.area === 'workspace');
      assert.ok(workspace, 'doctor reports no workspace finding at all');
      assert.equal(workspace!.level, 'blocked');
      assert.equal(report.ok, false);
      assert.equal(result.code, EXIT.CONFIG, 'doctor is contracted to exit 0 or 3');
    } finally {
      await f.cleanup();
    }
  });
});

describe('doctor', { timeout: 120_000 }, () => {
  test('reports every area, and blocks only on what is actually blocking', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config', 'secrets'), { recursive: true });
      await writeFile(
        path.join(f.root, 'config', 'config.toml'),
        configWith('\n[model.alias.m]\nprovider = "p"\nmodel = "m-1"\nprofile = "f"\n'),
        'utf8',
      );
      await writeFile(path.join(f.root, 'config', 'secrets', 'p.key'), 'sk-x', 'utf8');
      if (!isWindows) await chmod(path.join(f.root, 'config', 'secrets', 'p.key'), 0o600);

      const result = await runCli({ args: ['doctor', '--json'], root: f.root });
      const report = JSON.parse(result.stdout.trim()) as {
        ok: boolean;
        findings: Array<{ area: string; level: string; detail: string }>;
      };

      const areas = new Set(report.findings.map((x) => x.area));
      for (const expected of ['install', 'runtime', 'config', 'provider', 'credential', 'boundaries']) {
        assert.ok(areas.has(expected), `doctor should report on ${expected}`);
      }

      assert.equal(report.ok, true, `expected ready, got:\n${result.stdout}`);
      assert.equal(result.code, EXIT.OK);

      // A missing container runtime is a `warn`, not a block: it stops
      // `--backend container` and nothing else.
      const container = report.findings.find((x) => x.area === 'backend/container');
      assert.ok(container);
      assert.notEqual(container!.level, 'blocked');
    } finally {
      await f.cleanup();
    }
  });

  test('every path it prints is one the reader can actually open', async () => {
    // alpha.12. The footer used to point at `docs/configuration-audit.md`, a
    // relative path that resolves in a checkout and nowhere else — an installed
    // package lives under `node_modules`, so a reader following it from their own
    // project directory found nothing. A pointer only the author can follow is
    // worse than no pointer, because it reads like an answer.
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config'), { recursive: true });
      await writeFile(path.join(f.root, 'config', 'config.toml'), configWith(''), 'utf8');

      const result = await runCli({ args: ['doctor'], root: f.root });
      const pointers = [...result.stdout.matchAll(/(\S*docs\/[a-z0-9-]+\.md)/g)].map((m) => m[1]!);

      assert.ok(pointers.length > 0, `doctor printed no document pointer:\n${result.stdout}`);
      for (const pointer of pointers) {
        assert.ok(
          path.isAbsolute(pointer),
          `doctor printed the relative pointer "${pointer}"; a reader's cwd is their own project`,
        );
        assert.ok(existsSync(pointer), `doctor printed "${pointer}", which does not exist on this machine`);
      }
    } finally {
      await f.cleanup();
    }
  });

  test('changes nothing on disk', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config'), { recursive: true });
      const configPath = path.join(f.root, 'config', 'config.toml');
      await writeFile(configPath, configWith(''), 'utf8');
      const before = await readFile(configPath, 'utf8');

      await runCli({ args: ['doctor'], root: f.root });

      assert.equal(await readFile(configPath, 'utf8'), before, 'doctor must not rewrite configuration');
      assert.equal(
        existsSync(path.join(f.root, 'config', 'secrets')),
        false,
        'doctor must not create anything',
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe('setup-credential', { skip: isWindows ? 'POSIX modes' : undefined, timeout: 120_000 }, () => {
  test('writes 0600 from a pipe and never echoes the value', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config', 'secrets'), { recursive: true });
      const target = path.join(f.root, 'config', 'secrets', 'k.key');
      const secret = 'sk-canary-9f3a2b1c-do-not-print';

      const result = await runCli({
        args: ['setup-credential', target],
        stdin: secret,
        root: f.root,
      });

      assert.equal(result.code, EXIT.OK);
      assert.equal((await stat(target)).mode & 0o777, 0o600, 'the mode must be 0600');
      assert.equal((await readFile(target, 'utf8')).trim(), secret, 'the value must round-trip exactly');

      // §11: never echo it. The value must appear on neither stream.
      assert.equal(result.stdout.includes(secret), false, 'the secret must not reach stdout');
      assert.equal(result.stderr.includes(secret), false, 'the secret must not reach stderr');
    } finally {
      await f.cleanup();
    }
  });

  test('refuses a terminal rather than reading a key from one', async () => {
    // Asserted through the pure function: spawning a real PTY to prove we refuse
    // it would be a lot of machinery to test a branch that is one boolean.
    const { setupCredential } = await import('../../src/cli/setup-credential.ts');
    const result = await setupCredential({
      target: '/tmp/x.key',
      configDir: '/tmp',
      workspaceRoot: '/tmp/ws' as never,
      stdinIsTty: true,
      readSecret: async () => {
        throw new Error('readSecret must not be called when stdin is a terminal');
      },
    });

    assert.equal(result.exit, EXIT.USAGE);
    assert.match(result.message, /never from the terminal/);
    assert.match(result.message, /printf %s/, 'the message shows the form that does work');
  });

  test('refuses to write inside the workspace, before writing anything', async () => {
    const f = await cliRoot();
    try {
      const target = path.join(f.workspace, 'leak.key');
      const result = await runCli({
        args: ['setup-credential', target],
        stdin: 'sk-x',
        root: f.root,
      });

      assert.equal(result.code, EXIT.CONFIG);
      assert.match(result.stderr, /inside the workspace/);
      // "Refusing to write" and not "wrote, then removed": a key that existed in
      // a repository for a millisecond has still existed in a repository, and on
      // a filesystem with snapshots "briefly" guarantees nothing.
      assert.match(result.stderr, /Refusing to write/);
      assert.equal(existsSync(target), false, 'nothing may be created at the refused path');
    } finally {
      await f.cleanup();
    }
  });

  test('refuses to clobber an existing key without --force', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config', 'secrets'), { recursive: true });
      const target = path.join(f.root, 'config', 'secrets', 'k.key');
      await writeFile(target, 'the-working-key', 'utf8');
      await chmod(target, 0o600);

      const result = await runCli({ args: ['setup-credential', target], stdin: 'the-new-key', root: f.root });

      assert.equal(result.code, EXIT.CONFIG);
      assert.match(result.stderr, /already exists/);
      assert.equal((await readFile(target, 'utf8')).trim(), 'the-working-key', 'the old key must survive');
    } finally {
      await f.cleanup();
    }
  });

  test('--force replaces the file and still lands on 0600', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config', 'secrets'), { recursive: true });
      const target = path.join(f.root, 'config', 'secrets', 'k.key');
      await writeFile(target, 'old', 'utf8');
      // A pre-existing world-readable file is the case that matters: `open`'s
      // mode argument applies only on *creation*, so without the explicit chmod
      // this path would produce exactly the credential §11 forbids.
      await chmod(target, 0o644);

      const result = await runCli({
        args: ['setup-credential', target, '--force'],
        stdin: 'the-new-key',
        root: f.root,
      });

      assert.equal(result.code, EXIT.OK);
      assert.equal(
        (await stat(target)).mode & 0o777,
        0o600,
        'a replaced file must be tightened, not inherited',
      );
      assert.equal((await readFile(target, 'utf8')).trim(), 'the-new-key');
    } finally {
      await f.cleanup();
    }
  });

  test('an empty stdin is a usage error, not an empty credential file', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config', 'secrets'), { recursive: true });
      const target = path.join(f.root, 'config', 'secrets', 'k.key');
      const result = await runCli({ args: ['setup-credential', target], stdin: '', root: f.root });

      assert.equal(result.code, EXIT.USAGE);
      assert.equal(
        existsSync(target),
        false,
        'an empty key file would fail later, for a reason nobody would find',
      );
    } finally {
      await f.cleanup();
    }
  });

  test('the whole path works end to end: setup, then doctor says ready', async () => {
    const f = await cliRoot();
    try {
      await mkdir(path.join(f.root, 'config', 'secrets'), { recursive: true });
      await writeFile(
        path.join(f.root, 'config', 'config.toml'),
        configWith(
          '\n[model.alias.m]\nprovider = "p"\nmodel = "m-1"\nprofile = "f"\n\n[model]\ndefault = "m"\n',
        ),
        'utf8',
      );

      const setup = await runCli({
        args: ['setup-credential', path.join(f.root, 'config', 'secrets', 'p.key')],
        stdin: 'sk-x',
        root: f.root,
      });
      assert.equal(setup.code, EXIT.OK);

      const doctor = await runCli({ args: ['doctor', '--json'], root: f.root });
      const report = JSON.parse(doctor.stdout.trim()) as { ok: boolean };
      // §11's own rule: a setup flow must not produce a file the kernel then
      // refuses. This is that rule, executed across two processes.
      assert.equal(report.ok, true, `doctor should accept what setup-credential wrote:\n${doctor.stdout}`);
    } finally {
      await f.cleanup();
    }
  });
});
