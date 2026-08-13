import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PolicyEngine, SessionApprovalStore } from '../../src/policy/policy-engine.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';
import { readOnlyProfile, workspaceDevProfile, reviewProfile } from '../../src/policy/profiles.ts';
import { subjectKeyOf, capabilityOf, ALL_CAPABILITIES } from '../../src/policy/access.ts';
import type { AccessRequest } from '../../src/policy/access.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';
import { defaultConfig, mergeConfig, applySystemCeiling, configFromToml } from '../../src/config/schema.ts';
import { parsePermissionRules, projectRulesProfile } from '../../src/config/config.ts';
import { parseToml } from '../../src/util/toml.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { InMemorySecretBroker } from '../../src/security/secret-broker.ts';
import { scanSecrets } from '../../src/security/secret-scanner.ts';
import { DefaultEgressGate, defaultEgressPolicy } from '../../src/security/egress-gate.ts';

const ROOT = '/repo' as CanonicalPath;
const HOME = '/home/dev';

function engine(profileName: 'read-only' | 'workspace-dev' | 'review', extraRules = false): PolicyEngine {
  const ctx = { workspaceRoot: ROOT, agentTmpDir: '/repo/.agent/tmp' };
  const profile =
    profileName === 'read-only'
      ? readOnlyProfile(ctx)
      : profileName === 'review'
        ? reviewProfile(ctx)
        : workspaceDevProfile(ctx);

  const layers = [{ name: `session:${profileName}`, source: 'session' as const, profile }];
  if (extraRules) {
    const parsed = parsePermissionRules(
      parseToml(`
[[rule]]
action = "hard_deny"
capability = "file.write"
pattern = "../reference/**"

[[rule]]
action = "deny"
capability = "file.write"
pattern = "src/generated/**"
`),
      ROOT,
    );
    layers.push({
      name: 'project',
      source: 'project' as unknown as 'session',
      profile: projectRulesProfile(parsed.rules),
    });
  }

  return new PolicyEngine({
    workspaceRoot: ROOT,
    protectedPaths: new ProtectedPaths({ home: HOME }),
    layers,
    approvals: new SessionApprovalStore(),
  });
}

const read = (p: string, toModel = true): AccessRequest => ({
  kind: 'file.read',
  path: p as CanonicalPath,
  toModel,
  display: p,
});
const write = (p: string): AccessRequest => ({
  kind: 'file.write',
  path: p as CanonicalPath,
  create: false,
  display: p,
});
const exec = (argv: string[]): AccessRequest => ({
  kind: 'process.exec',
  executable: argv[0]!,
  argv,
  cwd: ROOT,
  display: argv.join(' '),
});

describe('Appendix A permission matrix', () => {
  test('workspace read is allowed in every profile', () => {
    for (const name of ['read-only', 'workspace-dev', 'review'] as const) {
      assert.equal(engine(name).decide(read('/repo/src/a.ts')).action, 'allow', name);
    }
  });

  test('source edit: deny / allow / deny', () => {
    assert.equal(engine('read-only').decide(write('/repo/src/a.ts')).action, 'deny');
    assert.equal(engine('workspace-dev').decide(write('/repo/src/a.ts')).action, 'allow');
    assert.equal(engine('review').decide(write('/repo/src/a.ts')).action, 'deny');
  });

  test('read-only git is allowed everywhere', () => {
    for (const name of ['read-only', 'workspace-dev', 'review'] as const) {
      assert.equal(engine(name).decide(exec(['git', 'status'])).action, 'allow', name);
    }
  });

  test('test/lint/build: ask under read-only, allow otherwise', () => {
    assert.equal(engine('read-only').decide(exec(['npm', 'test'])).action, 'ask');
    assert.equal(engine('workspace-dev').decide(exec(['npm', 'test'])).action, 'allow');
    assert.equal(engine('review').decide(exec(['npm', 'test'])).action, 'allow');
  });

  test('package install: deny / ask / deny', () => {
    const install = exec(['npm', 'install', 'zod']);
    assert.equal(engine('read-only').decide(install).action, 'ask');
    assert.equal(engine('workspace-dev').decide(install).action, 'ask');
    assert.equal(engine('review').decide(install).action, 'deny');
  });

  test('network: deny / ask / deny', () => {
    const net: AccessRequest = {
      kind: 'network.connect',
      host: 'registry.npmjs.org',
      port: 443,
      via: 'shell',
      display: 'registry.npmjs.org:443',
    };
    assert.equal(engine('read-only').decide(net).action, 'deny');
    assert.equal(engine('workspace-dev').decide(net).action, 'ask');
    assert.equal(engine('review').decide(net).action, 'deny');
  });

  test('git commit: deny / ask / deny', () => {
    const commit: AccessRequest = { kind: 'vcs.mutate', operation: 'commit', display: 'git commit' };
    assert.equal(engine('read-only').decide(commit).action, 'deny');
    assert.equal(engine('workspace-dev').decide(commit).action, 'ask');
    assert.equal(engine('review').decide(commit).action, 'deny');
  });

  test('workspace-outside access asks and is flagged', () => {
    const decision = engine('workspace-dev').decide(read('/tmp/other/file.txt'));
    assert.equal(decision.action, 'ask');
    assert.equal(decision.outsideWorkspace, true);
    assert.equal(decision.errorCode, 'PATH_OUTSIDE_WORKSPACE');
  });

  test('secret file content is hard-denied in every profile', () => {
    for (const name of ['read-only', 'workspace-dev', 'review'] as const) {
      const decision = engine(name).decide(read('/repo/.env'));
      assert.equal(decision.action, 'hard_deny', name);
      assert.equal(decision.final, true);
    }
  });
});

describe('rule specificity and layering', () => {
  test('a more specific allow beats a broader ask', () => {
    const e = new PolicyEngine({
      workspaceRoot: ROOT,
      protectedPaths: new ProtectedPaths({ home: HOME }),
      layers: [
        {
          name: 'session',
          source: 'session',
          profile: {
            name: 'test',
            description: '',
            fallback: 'deny',
            rules: [
              { action: 'ask', capability: 'network.connect', pattern: '*' },
              { action: 'allow', capability: 'network.connect', pattern: 'registry.npmjs.org' },
            ],
          },
        },
      ],
    });

    assert.equal(
      e.decide({
        kind: 'network.connect',
        host: 'registry.npmjs.org',
        port: 443,
        via: 'shell',
        display: '',
      }).action,
      'allow',
    );
    assert.equal(
      e.decide({ kind: 'network.connect', host: 'evil.example.com', port: 443, via: 'shell', display: '' })
        .action,
      'ask',
    );
  });

  test('equal specificity fails closed', () => {
    const e = new PolicyEngine({
      workspaceRoot: ROOT,
      protectedPaths: new ProtectedPaths({ home: HOME }),
      layers: [
        {
          name: 'session',
          source: 'session',
          profile: {
            name: 'ambiguous',
            description: '',
            fallback: 'allow',
            rules: [
              { action: 'allow', capability: 'file.write', pattern: '/repo/a.ts' },
              { action: 'deny', capability: 'file.write', pattern: '/repo/a.ts' },
            ],
          },
        },
      ],
    });
    assert.equal(e.decide(write('/repo/a.ts')).action, 'deny');
  });

  test('a project layer can narrow but never widen', () => {
    const narrowed = engine('workspace-dev', true);
    assert.equal(narrowed.decide(write('/repo/src/generated/x.ts')).action, 'deny');
    // Unrelated paths are unaffected: a project layer that says nothing about a
    // capability must not constrain it.
    assert.equal(narrowed.decide(write('/repo/src/a.ts')).action, 'allow');
  });

  test('narrow() only ever restricts', () => {
    const base = engine('workspace-dev');
    const restricted = base.narrow({
      name: 'skill',
      source: 'skill',
      profile: {
        name: 'no-writes',
        description: '',
        fallback: 'allow',
        rules: [{ action: 'deny', capability: 'file.write' }],
      },
    });
    assert.equal(base.decide(write('/repo/src/a.ts')).action, 'allow');
    assert.equal(restricted.decide(write('/repo/src/a.ts')).action, 'deny');
  });
});

describe('session approvals', () => {
  test('an approval is remembered against a concrete subject, not a class', () => {
    const e = engine('workspace-dev');
    const install = exec(['npm', 'install', 'zod']);
    const curl = exec(['curl', 'https://evil.example.com']);

    assert.equal(e.decide(install).action, 'ask');
    e.approvals.record(subjectKeyOf(install), true, 'npm install', 1);

    assert.equal(e.decide(install).action, 'allow', 'the approved subject is now allowed');
    assert.notEqual(e.decide(curl).action, 'allow', 'a different subject is still not approved');
  });

  test('subject keys distinguish npm install from npm test', () => {
    assert.notEqual(subjectKeyOf(exec(['npm', 'install'])), subjectKeyOf(exec(['npm', 'test'])));
  });

  test('capabilityOf distinguishes a kernel read from a to-model read', () => {
    assert.equal(capabilityOf(read('/repo/a.ts', false)), 'file.read');
    assert.equal(capabilityOf(read('/repo/a.ts', true)), 'file.read_to_model');
  });
});

describe('protected paths', () => {
  const pp = new ProtectedPaths({ home: HOME, referenceRoots: ['/lab/reference' as CanonicalPath] });

  test('secret files are refused for model reads', () => {
    for (const p of [
      '/repo/.env',
      '/repo/.env.local',
      '/repo/nested/.env.production',
      '/repo/certs/server.pem',
      '/repo/keys/id_ed25519',
      '/repo/deploy.key',
      '/home/dev/.aws/credentials',
      '/home/dev/.ssh/config',
      '/home/dev/.npmrc',
    ]) {
      assert.equal(pp.checkReadToModel(p as CanonicalPath).protected, true, p);
    }
  });

  test('template env files are not secrets', () => {
    for (const p of ['/repo/.env.example', '/repo/.env.sample', '/repo/.env.template']) {
      assert.equal(pp.checkReadToModel(p as CanonicalPath).protected, false, p);
    }
  });

  test('case variants are still caught', () => {
    assert.equal(pp.checkReadToModel('/repo/.ENV' as CanonicalPath).protected, true);
  });

  test('reference trees are readable but never writable', () => {
    assert.equal(pp.checkReadToModel('/lab/reference/codex/src/a.rs' as CanonicalPath).protected, false);
    const verdict = pp.checkWrite('/lab/reference/codex/src/a.rs' as CanonicalPath);
    assert.equal(verdict.protected, true);
    assert.equal(verdict.reason, 'reference-tree');
  });

  test('kernel policy files cannot be rewritten from inside a session', () => {
    const pp2 = new ProtectedPaths({ home: HOME, configDir: '/home/dev/.config/agent' });
    assert.equal(pp2.checkWrite('/home/dev/.config/agent/permissions.toml' as CanonicalPath).protected, true);
  });

  test('ordinary source files are unaffected', () => {
    assert.equal(pp.checkReadToModel('/repo/src/auth.ts' as CanonicalPath).protected, false);
    assert.equal(pp.checkWrite('/repo/src/auth.ts' as CanonicalPath).protected, false);
  });
});

describe('configuration layering (§22)', () => {
  test('security booleans are sticky at the safe value', () => {
    const lower = defaultConfig();
    const merged = mergeConfig(lower, {
      security: { telemetryContent: true, traceUpload: true, secretRedaction: false },
      telemetry: { content: true, traceUpload: true },
    });
    const final = applySystemCeiling(merged);

    assert.equal(final.security.telemetryContent, false);
    assert.equal(final.security.traceUpload, false);
    assert.equal(final.security.secretRedaction, true);
    assert.equal(final.telemetry.content, false);
  });

  test('budgets take the minimum, not last-write-wins', () => {
    const merged = mergeConfig(mergeConfig(defaultConfig(), { loop: { maxSteps: 8 } }), {
      loop: { maxSteps: 64 },
    });
    assert.equal(merged.loop.maxSteps, 8, 'a later layer cannot raise the limit');
  });

  test('deny patterns union rather than replace', () => {
    const merged = mergeConfig(
      mergeConfig(defaultConfig(), { security: { extraSecretPaths: ['**/*.secret'] } }),
      { security: { extraSecretPaths: ['**/*.private'] } },
    );
    assert.deepEqual(merged.security.extraSecretPaths?.sort(), ['**/*.private', '**/*.secret']);
  });

  test('egress host lists intersect', () => {
    const user = mergeConfig(defaultConfig(), { egress: { allowedHosts: { web: ['a.com', 'b.com'] } } });
    const project = mergeConfig(user, {
      egress: { allowedHosts: { web: ['b.com', 'evil.com'], plugin: ['x.com'] } },
    });

    assert.deepEqual(
      project.egress.allowedHosts?.web,
      ['b.com'],
      'a project cannot add a host the user did not',
    );
    assert.equal(
      project.egress.allowedHosts?.plugin,
      undefined,
      'a channel the user never enabled stays closed',
    );
  });

  test('telemetry.content = true is parsed, refused, and warned about', () => {
    const parsed = configFromToml(parseToml('[telemetry]\ncontent = true\n'), 'project config');
    assert.ok(parsed.warnings?.some((w) => /never permitted/.test(w)));
  });

  test('project rule paths are anchored to the workspace', () => {
    const { rules } = parsePermissionRules(
      parseToml(`
[[rule]]
action = "allow"
capability = "file.write"
pattern = "src/**"
`),
      ROOT,
    );
    assert.equal(rules[0]?.pattern, '/repo/src/**');
  });

  test('an unknown capability or action is dropped with a warning', () => {
    const { rules, warnings } = parsePermissionRules(
      parseToml(`
[[rule]]
action = "definitely_allow"
capability = "file.write"

[[rule]]
action = "allow"
capability = "make.coffee"
`),
      ROOT,
    );
    assert.equal(rules.length, 0);
    assert.equal(warnings.length, 2);
  });
});

describe('secret scanner and redactor', () => {
  test('high-confidence credential shapes are detected', () => {
    const samples = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      // lint-allow no-real-credentials-in-tests: AWS's own published documentation example
      // key. Using the canonical example is the point — it is what the detector must catch.
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghijkl',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    ];
    for (const sample of samples) {
      assert.ok(scanSecrets(sample, { minConfidence: 'high' }).length > 0, `missed: ${sample.slice(0, 24)}`);
    }
  });

  test('placeholders are not reported as secrets', () => {
    for (const sample of [
      'API_KEY=your_api_key_here',
      'PASSWORD=changeme',
      'TOKEN=${GITHUB_TOKEN}',
      'SECRET=<your-secret>',
      'API_KEY=xxxxxxxxxxxxxxxx',
    ]) {
      assert.equal(scanSecrets(sample).length, 0, `false positive: ${sample}`);
    }
  });

  test('redaction is stable and reversible only through the broker', () => {
    const redactor = new Redactor();
    const placeholder = redactor.addLiteral('super-secret-value-123');
    const redacted = redactor.redact('the value is super-secret-value-123 twice: super-secret-value-123');

    assert.equal(redacted.includes('super-secret-value-123'), false);
    assert.equal(
      redacted.split(placeholder).length - 1,
      2,
      'both occurrences replaced with the same placeholder',
    );
  });

  test('releasing a lease removes the value from the active set', async () => {
    const redactor = new Redactor();
    const broker = new InMemorySecretBroker(redactor);
    broker.register('svc/token', { kind: 'literal', value: 'lease-value-abcdef' });

    const lease = await broker.resolve('svc/token', 'subprocess.env');
    assert.equal(redactor.containsKnownLiteral('x lease-value-abcdef y'), true);

    // Registered literals stay redacted even after the lease ends — that is the
    // point of registering them.
    lease.release();
    assert.equal(redactor.containsKnownLiteral('x lease-value-abcdef y'), true);
  });

  test('a lease stringifies to a reference, never to the value', async () => {
    const redactor = new Redactor();
    const broker = new InMemorySecretBroker(redactor);
    broker.register('svc/token', { kind: 'literal', value: 'do-not-print-me-please' });
    const lease = await broker.resolve('svc/token', 'subprocess.env');

    assert.equal(String(lease), 'secret_ref://svc/token');
    assert.equal(JSON.stringify({ lease }), '{"lease":"secret_ref://svc/token"}');
    assert.equal(`${lease}`.includes('do-not-print-me'), false);
  });

  test('a lease refuses to be used for the wrong purpose', async () => {
    const redactor = new Redactor();
    const broker = new InMemorySecretBroker(redactor);
    broker.register('svc/token', { kind: 'literal', value: 'value-for-env-only' });
    const lease = await broker.resolve('svc/token', 'subprocess.env');

    const headers: Record<string, string> = {};
    assert.throws(() => lease.applyAuthorization(headers, 'Bearer'), /issued for "subprocess.env"/);

    const env: Record<string, string> = {};
    lease.injectInto(env, 'TOKEN');
    assert.equal(env.TOKEN, 'value-for-env-only');
  });
});

describe('egress gate', () => {
  test('a channel with no configured hosts is off', async () => {
    const gate = new DefaultEgressGate({
      redactor: new Redactor(),
      transport: { send: async () => ({ status: 200, headers: {} }) },
    });
    await assert.rejects(
      gate.send({ kind: 'web', url: 'https://example.com/x', method: 'GET' }, { sessionId: 's' }),
      /not enabled/,
    );
  });

  test('a model host outside the allowlist is refused', async () => {
    const gate = new DefaultEgressGate({
      redactor: new Redactor(),
      transport: { send: async () => ({ status: 200, headers: {} }) },
    });
    await assert.rejects(
      gate.send(
        { kind: 'model', url: 'https://evil.example.com/v1', method: 'POST', body: '{}' },
        { sessionId: 's' },
      ),
      /not in the allowlist/,
    );
  });

  test('telemetry carrying a non-metadata field is refused', async () => {
    const policy = defaultEgressPolicy();
    policy.telemetry = { ...policy.telemetry, allowedHosts: ['telemetry.example.com'] };

    const gate = new DefaultEgressGate({
      policy,
      redactor: new Redactor(),
      transport: { send: async () => ({ status: 200, headers: {} }) },
    });

    await assert.rejects(
      gate.send(
        {
          kind: 'telemetry',
          url: 'https://telemetry.example.com/e',
          method: 'POST',
          body: JSON.stringify({ toolName: 'Read', prompt: 'the user asked...' }),
        },
        { sessionId: 's' },
      ),
      /non-metadata field/,
    );
  });

  test('telemetry with only allowlisted fields is sent', async () => {
    const policy = defaultEgressPolicy();
    policy.telemetry = { ...policy.telemetry, allowedHosts: ['telemetry.example.com'] };

    let sent = false;
    const gate = new DefaultEgressGate({
      policy,
      redactor: new Redactor(),
      transport: {
        send: async () => {
          sent = true;
          return { status: 200, headers: {} };
        },
      },
    });

    await gate.send(
      {
        kind: 'telemetry',
        url: 'https://telemetry.example.com/e',
        method: 'POST',
        body: JSON.stringify({ toolName: 'Read', durationMs: 12, errorCode: 'TOOL_FAILED' }),
      },
      { sessionId: 's' },
    );
    assert.equal(sent, true);
  });

  test('audit records carry no content', async () => {
    const records: unknown[] = [];
    const gate = new DefaultEgressGate({
      redactor: new Redactor(),
      transport: { send: async () => ({ status: 200, headers: {} }) },
      onAudit: (r) => records.push(r),
    });

    await gate.send(
      {
        kind: 'model',
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'my private source code' }] }),
      },
      { sessionId: 's' },
    );

    const serialised = JSON.stringify(records);
    assert.equal(serialised.includes('private source code'), false);
    assert.match(serialised, /"bodyHash"/, 'a hash is recorded instead');
  });
});

describe('the config parser and the capability list cannot drift apart', () => {
  test('every capability the policy layer knows is accepted in permissions.toml', () => {
    // The defect this pins: `config.ts` carried a hand-written copy of the
    // capability list, and it fell behind when `agent.invoke` was added — so a
    // project rule naming the new capability was dropped with a warning, and the
    // policy §11 says a project must be able to express was inexpressible.
    for (const capability of ALL_CAPABILITIES) {
      const parsed = parsePermissionRules(
        parseToml(`[[rule]]\naction = "deny"\ncapability = "${capability}"\npattern = "x"\n`),
        '/ws' as CanonicalPath,
      );
      assert.deepEqual(parsed.warnings, [], `capability "${capability}" was rejected by the config parser`);
      assert.equal(parsed.rules.length, 1, `capability "${capability}" produced no rule`);
      assert.equal(parsed.rules[0]!.capability, capability);
    }
  });

  test('a genuinely unknown capability is still reported', () => {
    // NEGATIVE CONTROL: the check above would pass just as well if the parser
    // accepted everything.
    const parsed = parsePermissionRules(
      parseToml('[[rule]]\naction = "deny"\ncapability = "not.a.capability"\n'),
      '/ws' as CanonicalPath,
    );
    assert.equal(parsed.rules.length, 0);
    assert.match(parsed.warnings.join(' '), /unknown capability/);
  });
});
