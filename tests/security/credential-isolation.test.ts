/**
 * The provider credential must not reach extension code (§50 "Security").
 *
 * `tests/live/model-live.test.ts` asserts this for the *real* credential, but
 * only runs when someone has one exported. These cases run in ordinary CI, with
 * a synthetic credential, so the boundary is checked on every commit rather than
 * only when a human chooses to spend money.
 *
 * Hooks and Skills are covered separately because they fail differently: a hook
 * is a subprocess and could inherit the environment, while a skill has no
 * execution path of its own and could only leak by acquiring one.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { HookRunner, parseHookTable } from '../../src/extensions/hooks.ts';
import { PolicyEngine } from '../../src/policy/policy-engine.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';
import { workspaceDevProfile } from '../../src/policy/profiles.ts';
import { LocalExecutionBackend } from '../../src/execution/local.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { scrubEnv } from '../../src/security/env-scrub.ts';
import { nullLogger } from '../../src/util/logger.ts';
import { parseToml } from '../../src/util/toml.ts';
import { canonicalize, type CanonicalPath } from '../../src/util/paths.ts';

// A value distinctive enough that finding it anywhere is unambiguous, and a
// variable named the way a real provider credential is named.
const CREDENTIAL_VAR = 'FAKEPROVIDER_API_KEY';
const CREDENTIAL_VALUE = 'sk-live-credential-isolation-9c1f4e77';

let base: string;
let root: CanonicalPath;
let backend: LocalExecutionBackend;

before(async () => {
  process.env[CREDENTIAL_VAR] = CREDENTIAL_VALUE;
  base = await mkdtemp(path.join(tmpdir(), 'credential-isolation-'));
  root = (await canonicalize(base, { cwd: base })).path;
  backend = await LocalExecutionBackend.detect({
    workspaceRoot: root,
    redactor: new Redactor(),
    logger: nullLogger,
  });
});

after(async () => {
  delete process.env[CREDENTIAL_VAR];
  await backend?.close();
  await rm(base, { recursive: true, force: true });
});

function runner(config: string): HookRunner {
  const policy = new PolicyEngine({
    workspaceRoot: root,
    protectedPaths: new ProtectedPaths({ home: base }),
    layers: [
      {
        name: 'session:workspace-dev',
        source: 'session',
        profile: workspaceDevProfile({ workspaceRoot: root }),
      },
    ],
  });
  const parsed = parseHookTable(parseToml(config), 'test');
  assert.deepEqual(parsed.warnings, [], 'the fixture config should parse cleanly');
  return new HookRunner(parsed.hooks, {
    backend,
    policy,
    workspaceRoot: root,
    logger: nullLogger,
    now: () => Date.now(),
  });
}

describe('a Hook cannot see the provider credential', () => {
  test('the credential is absent from a hook subprocess environment', async () => {
    const dump = path.join(base, 'hook-env.txt');
    const outcomes = await runner(`
[[hooks]]
event = "PostToolUse"
matcher = "Edit"
command = ["sh", "-c", "env > ${dump}"]
`).run({ event: 'PostToolUse', toolName: 'Edit', path: 'src/a.ts', sessionId: 's1' });

    assert.equal(outcomes[0]?.ran, true, `hook did not run: ${outcomes[0]?.blocked ?? 'unknown'}`);

    const env = await readFile(dump, 'utf8');
    assert.equal(env.includes(CREDENTIAL_VALUE), false, 'the credential reached a hook subprocess');
    assert.equal(env.includes(CREDENTIAL_VAR), false, 'even the variable name should be absent');
  });

  test('a hook that asks for the credential by name gets nothing', async () => {
    // The environment is built from an allowlist, so this is not a matter of
    // the hook failing to look hard enough.
    const outcomes = await runner(`
[[hooks]]
event = "PostToolUse"
matcher = "Edit"
command = ["sh", "-c", "echo \\"value=[$${CREDENTIAL_VAR}]\\""]
inject_output = true
`).run({ event: 'PostToolUse', toolName: 'Edit', path: 'src/a.ts', sessionId: 's1' });

    const output = outcomes[0]?.output ?? '';
    assert.match(output, /value=\[\]/, `expected an empty expansion, got: ${output}`);
    assert.equal(output.includes(CREDENTIAL_VALUE), false);
  });
});

describe('a Skill cannot see the provider credential', () => {
  test('skills have no execution path of their own', async () => {
    // This is why the Shell and Hook assertions are sufficient for skills: a
    // skill contributes instructions and a policy layer, and every command it
    // causes runs through the executor those tests already cover. If that ever
    // stops being true, this test is the one that should fail first.
    const source = await readFile(new URL('../../src/extensions/skills.ts', import.meta.url), 'utf8');

    for (const forbidden of ['child_process', 'spawn(', 'exec(', 'execFile', 'node:vm']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `skills.ts references "${forbidden}" — a skill would then have an execution path that no ` +
          'credential-isolation test covers',
      );
    }
  });

  test('the scrubbed environment omits credential-shaped variables generally', async () => {
    // Not a list of known vendors: a kernel that only hid the credentials it had
    // heard of would leak the next one. The environment is built from an
    // allowlist, so an unknown variable is absent by construction.
    process.env.SOME_UNKNOWN_VENDOR_TOKEN = 'tok-unknown-vendor-1234';
    try {
      const { env } = scrubEnv();
      assert.equal(env[CREDENTIAL_VAR], undefined);
      assert.equal(env.SOME_UNKNOWN_VENDOR_TOKEN, undefined);
      assert.equal(
        Object.values(env).some((v) => v === CREDENTIAL_VALUE),
        false,
        'the credential appeared under some other variable name',
      );
    } finally {
      delete process.env.SOME_UNKNOWN_VENDOR_TOKEN;
    }
  });
});
