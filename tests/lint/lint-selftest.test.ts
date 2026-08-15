/**
 * Self-tests for the architecture linter (alpha.3 §39).
 *
 * `pnpm lint` is a release blocker, which makes it a gate whose *own* failure
 * mode is silence: a rule whose regex stops matching does not report an error,
 * it reports zero violations, and zero violations is exactly what a healthy run
 * looks like. alpha.2 made the general version of this point — a checklist item
 * without executable coverage is not evidence — and a linter rule with no
 * fixture is the same thing wearing a different hat.
 *
 * So every rule gets three kinds of fixture:
 *
 *   must-fail   code the rule exists to catch. If it stops being reported, the
 *               rule has silently died.
 *   must-pass   code that looks similar but is legitimate. This is what stops a
 *               rule being "repaired" into `/./`, which would pass every
 *               must-fail case and make the codebase unbuildable — or, worse,
 *               make people add suppressions everywhere.
 *   exception   a path the rule deliberately does not apply to, where that
 *               matters (the egress gate may call `fetch`; the broker may read
 *               `process.env`). Asserted through `applies()`, because an
 *               exception list that drifts is how a rule quietly stops covering
 *               the file it was written for.
 *
 * The coverage assertion at the bottom is the part that keeps this honest: a
 * new rule with no fixtures fails this suite, so the self-test cannot fall
 * behind the linter it tests.
 *
 * This file is the one place a `lint-allow-file` pragma is appropriate: its
 * content is deliberate violations, so every rule it exercises would otherwise
 * fire on the fixtures themselves.
 *
 * lint-allow-file no-raw-network: fixtures for the rule under test
 * lint-allow-file explicit-ts-extension: fixtures for the rule under test
 * lint-allow-file no-real-credentials-in-tests: synthetic key shapes, by design
 * lint-allow-file no-provider-names-in-core: fixtures for the rule under test
 * lint-allow-file no-child-process-outside-execution: fixtures for the rule under test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RULES, applySuppressions, blankNonCode, type Rule, type Violation } from '../../scripts/lint.ts';

/**
 * Fixtures for one rule.
 *
 * `file` is the repo-relative path the snippet is pretended to live at, since
 * most rules key off the directory. Every snippet is a plain string here, which
 * is also why this file does not trip the linter on itself: `blankNonCode`
 * blanks string literals, so a fixture containing `fetch(` is not a call.
 */
interface RuleFixtures {
  rule: string;
  /** Path used for snippets unless one overrides it. */
  file: string;
  mustFail: Array<{ why: string; source: string; file?: string }>;
  mustPass: Array<{ why: string; source: string; file?: string }>;
  /** Paths where `applies()` must return false. */
  exceptions?: Array<{ why: string; file: string }>;
}

const FIXTURES: RuleFixtures[] = [
  {
    rule: 'no-raw-network',
    file: 'src/tools/builtin/shell.ts',
    mustFail: [
      { why: 'a bare fetch call', source: 'const r = await fetch(url);' },
      { why: 'fetch behind an await on its own line', source: 'await fetch("https://x.test");' },
      { why: 'importing node:http', source: "import { request } from 'node:http';" },
      { why: 'importing node:https', source: "import { request } from 'node:https';" },
      { why: 'a raw WebSocket', source: 'const ws = new WebSocket("wss://x.test");' },
    ],
    mustPass: [
      { why: 'going through the gate', source: 'const r = await egress.send(req);' },
      {
        why: 'a method that merely ends in fetch',
        source: 'const r = await this.prefetch(url);',
      },
      { why: 'the word fetch in a comment', source: '// we deliberately do not fetch(here)' },
      { why: 'the word fetch in a string', source: 'const doc = "call fetch(url) to do it";' },
    ],
    exceptions: [{ why: 'the gate is the one place allowed to', file: 'src/security/egress-gate.ts' }],
  },

  {
    rule: 'no-ambient-env-spawn',
    file: 'src/execution/local.ts',
    mustFail: [
      { why: 'the classic', source: 'spawn(cmd, args, { env: process.env });' },
      { why: 'spread across whitespace', source: 'spawn(cmd, args, {\n  env:   process.env,\n});' },
    ],
    mustPass: [
      { why: 'a scrubbed environment', source: 'spawn(cmd, args, { env: scrubEnv().env });' },
      { why: 'reading a single variable', source: 'const home = process.env.HOME;' },
    ],
  },

  {
    rule: 'no-host-env-read',
    file: 'src/tools/builtin/shell.ts',
    mustFail: [
      { why: 'any read at all', source: 'const key = process.env.SOME_KEY;' },
      { why: 'indexed read', source: 'const key = process.env["SOME_KEY"];' },
    ],
    mustPass: [
      { why: 'a scrubbed environment', source: 'const { env } = scrubEnv();' },
      { why: 'the phrase in a comment', source: '// never read process.env here' },
    ],
    exceptions: [
      { why: 'builds the allowlisted environment', file: 'src/security/env-scrub.ts' },
      { why: 'the one component allowed to resolve a credential', file: 'src/security/secret-broker.ts' },
      { why: 'platform directory resolution', file: 'src/util/platform.ts' },
      { why: 'PATH lookup for optional tooling', file: 'src/execution/local.ts' },
      { why: 'registers provider credentials by reference at boot', file: 'src/kernel.ts' },
      { why: 'the rule is scoped to src/', file: 'tests/security/canary.test.ts' },
    ],
  },

  {
    rule: 'no-child-process-outside-execution',
    file: 'src/tools/builtin/shell.ts',
    mustFail: [{ why: 'importing the module', source: "import { spawn } from 'node:child_process';" }],
    mustPass: [{ why: 'using the executor', source: 'const result = await executor.exec(spec);' }],
    exceptions: [
      { why: "spawning is the executor's job", file: 'src/execution/local.ts' },
      { why: 'the ssh transport spawns ssh', file: 'src/execution/ssh.ts' },
    ],
  },

  {
    rule: 'no-provider-names-in-core',
    file: 'src/session/turn.ts',
    mustFail: [
      { why: 'branching on a vendor', source: 'if (provider === "anthropic") { retry(); }' },
      { why: 'a vendor in an identifier', source: 'const openaiQuirk = true;' },
      { why: 'case-insensitively', source: 'const x = DeepSeek.mode;' },
      { why: 'a model family', source: 'if (family === "gpt-4") return;' },
    ],
    mustPass: [
      {
        why: 'protocol names are not provider names',
        source: 'if (protocol === "openai-chat") return;',
        file: 'src/model/adapters/openai-chat.ts',
      },
      { why: 'neutral vocabulary', source: 'const profile = registry.resolve(alias);' },
    ],
    exceptions: [
      { why: 'adapters are where provider quirks belong', file: 'src/model/adapters/anthropic.ts' },
      { why: 'so is the registry of endpoints', file: 'src/model/profiles.ts' },
    ],
  },

  {
    rule: 'explicit-ts-extension',
    file: 'src/session/turn.ts',
    mustFail: [
      { why: 'a relative import with no extension', source: "import { x } from './step';" },
      { why: 'a parent-relative import', source: "import { y } from '../util/paths';" },
      { why: 'a dynamic import', source: "const m = await import('./late');" },
    ],
    mustPass: [
      { why: 'the extension is present', source: "import { x } from './step.ts';" },
      { why: 'a bare specifier needs none', source: "import * as path from 'node:path';" },
      { why: 'json is allowed', source: "import data from './fixture.json' with { type: 'json' };" },
    ],
  },

  {
    rule: 'no-any',
    file: 'src/tools/runtime.ts',
    mustFail: [
      { why: 'an annotation', source: 'function f(x: any) { return x; }' },
      { why: 'a cast', source: 'const v = payload as any;' },
    ],
    mustPass: [
      { why: 'unknown forces a check', source: 'function f(x: unknown) { return x; }' },
      { why: 'a type whose name contains any', source: 'const c: Company = load();' },
      {
        why: 'the rule is scoped to src/',
        source: 'const v = payload as any;',
        file: 'tests/unit/util.test.ts',
      },
    ],
  },

  {
    rule: 'no-docker-cli-outside-container-backend',
    file: 'src/tools/builtin/shell.ts',
    mustFail: [
      { why: 'spawning the docker CLI from a tool', source: "spawn('docker', ['run', '--rm', image]);" },
      { why: 'building a docker run argv elsewhere', source: "const argv = ['docker', ['run', '--rm']];" },
    ],
    mustPass: [
      {
        why: 'talking about docker in a message is not invoking it',
        source: 'const hint = "install docker and start the daemon";',
      },
      { why: 'spawning something else', source: "spawn('git', ['status', '--porcelain']);" },
    ],
    exceptions: [
      { why: 'the shared docker transport', file: 'src/execution/docker-cli.ts' },
      { why: 'the container backend owns the transport', file: 'src/execution/container.ts' },
      { why: 'the plan module builds the argv it never runs', file: 'src/execution/container-plan.ts' },
      { why: 'the sidecar manager builds the proxy topology', file: 'src/execution/egress-sidecar.ts' },
    ],
  },

  {
    rule: 'no-scoped-egress-bridge-fallback',
    file: 'src/execution/container.ts',
    mustFail: [
      {
        why: 'the Fallback Stop: answering a setup failure with bridge networking',
        source: "if (!sidecar) { plan.network = 'bridge'; }",
      },
      { why: 'emitting the flag directly', source: "args.push('--network bridge');" },
    ],
    mustPass: [
      {
        why: 'describing the bridge in prose is not selecting it',
        source: 'const note = "an ordinary bridge network confines nothing";',
      },
      {
        why: 'the scoped network is a kernel-owned name',
        source: "args.push('--network', network.dockerNetwork);",
      },
    ],
    exceptions: [
      {
        why: 'the plan builder emits it for approved unrestricted mode',
        file: 'src/execution/container-plan.ts',
      },
      { why: 'the sidecar attaches its own egress leg', file: 'src/execution/egress-sidecar.ts' },
    ],
  },

  {
    rule: 'no-egress-proxy-workspace-mount',
    file: 'src/execution/egress-sidecar.ts',
    mustFail: [
      {
        why: 'mounting the workspace into the one container that can reach the internet',
        source: "args.push('--mount', `type=bind,source=${opts.workspaceRoot},target=/workspace`);",
      },
      { why: 'giving the proxy a home directory', source: 'const env = { HOME: homedir() };' },
    ],
    mustPass: [
      {
        why: 'mounting the proxy source and its frozen policy is the whole point',
        source: "args.push('--mount', `type=bind,source=${policyFile},target=/opt/policy.json,readonly`);",
      },
    ],
    exceptions: [
      { why: 'the container backend legitimately mounts the workspace', file: 'src/execution/container.ts' },
    ],
  },

  {
    rule: 'no-egress-proxy-secret-env',
    file: 'src/security/egress-proxy/proxy.ts',
    mustFail: [
      {
        why: 'a lease in the proxy is a credential next to the internet',
        source: 'lease.injectInto(env, name);',
      },
      { why: 'importing the broker at all', source: "import { SecretBroker } from '../secret-broker.ts';" },
    ],
    mustPass: [
      {
        why: 'the proxy deals in destinations',
        source: 'const decision = decideDestination(policy, host, port, protocol);',
      },
    ],
    exceptions: [{ why: 'the container backend does inject leases', file: 'src/execution/container.ts' }],
  },

  {
    rule: 'no-egress-content-logging',
    file: 'src/security/egress-proxy/proxy.ts',
    mustFail: [
      {
        why: 'a URL in a log line is a token in a log line',
        source: 'logger.debug("proxying " + target.pathAndQuery);',
      },
      { why: 'echoing a credential header', source: 'process.stdout.write(headers.authorization);' },
    ],
    mustPass: [
      {
        why: 'the safe vocabulary is host, port, reason',
        source: 'audit({ host, port, reason, durationMs });',
      },
      { why: 'forwarding the path is not logging it', source: 'upstream.write(target.pathAndQuery);' },
    ],
    exceptions: [{ why: 'the rule is scoped to the proxy', file: 'src/execution/container.ts' }],
  },

  {
    rule: 'no-container-escape-flags',
    file: 'src/execution/container.ts',
    mustFail: [
      { why: '--privileged defeats the boundary outright', source: "args.push('--privileged');" },
      { why: 'the host network namespace', source: "args.push('--network host');" },
      { why: 'the host PID namespace', source: "args.push('--pid host');" },
      { why: 'adding a capability back', source: "args.push('--cap-add=SYS_ADMIN');" },
      {
        why: 'mounting the docker socket is the classic sandbox escape',
        source: "args.push('-v', '/var/run/docker.sock:/var/run/docker.sock');",
      },
    ],
    mustPass: [
      { why: 'dropping capabilities is the safe direction', source: "args.push('--cap-drop=ALL');" },
      { why: 'no network at all', source: "args.push('--network', 'none');" },
      {
        why: 'the bridge network a granted capability produces',
        source: "args.push('--network', 'bridge');",
      },
    ],
    exceptions: [
      { why: 'the validator must name what it rejects', file: 'src/execution/container-plan.ts' },
      { why: 'the config schema warns about the keys it ignores', file: 'src/config/schema.ts' },
    ],
  },

  {
    rule: 'no-enforcement-overclaim',
    file: 'src/execution/ssh.ts',
    mustFail: [
      {
        why: 'claiming OS isolation literally',
        source: "const env = { sandboxStrength: 'os-isolated' };",
      },
      {
        why: 'claiming container enforcement literally',
        source: 'this.environment = { sandboxStrength: "container-enforced" };',
      },
    ],
    mustPass: [
      {
        why: 'derived from the descriptor, which is the only honest source',
        source: 'const strength = summarizeEnforcement(enforcement);',
      },
      {
        why: 'the honest default is not a claim',
        source: "const env = { sandboxStrength: 'policy-enforced' };",
      },
    ],
    exceptions: [
      { why: 'the descriptor module defines the vocabulary', file: 'src/execution/enforcement.ts' },
      { why: 'the sandbox describer renders it', file: 'src/execution/sandbox.ts' },
    ],
  },

  {
    rule: 'no-console-in-kernel',
    file: 'src/session/session.ts',
    mustFail: [
      { why: 'console.log', source: 'console.log("state", state);' },
      { why: 'console.error', source: 'console.error(err);' },
    ],
    mustPass: [
      { why: 'the logger routes through the redactor', source: 'logger.debug("state", { state });' },
    ],
    exceptions: [{ why: 'the CLI is the terminal', file: 'src/cli/main.ts' }],
  },

  {
    rule: 'no-real-credentials-in-tests',
    file: 'tests/security/canary.test.ts',
    mustFail: [
      {
        why: 'an Anthropic-shaped key',
        source: 'const k = "sk-ant-api03-QQQQWWWWEEEERRRRTTTTYYYYUUUU";',
      },
      { why: 'a GitHub-shaped token', source: 'const t = "ghp_QQQQWWWWEEEERRRRTTTTYYYYUUUUIIIIOOOO";' },
      { why: 'an AWS-shaped key id', source: 'const a = "AKIAQQQQWWWWEEEERRRR";' },
    ],
    mustPass: [
      {
        why: 'the documented fake Anthropic prefix',
        source: 'const k = "sk-ant-api03-abcdef0123456789abcdef";',
      },
      {
        why: 'the documented fake GitHub prefix',
        source: 'const t = "ghp_fake000000000000000000000000000000";',
      },
      { why: 'the documented fake AWS value', source: 'const a = "AKIAFAKEVALUE0000000";' },
      { why: 'an obviously synthetic key', source: 'const k = "sk-live-credential-isolation-9c1f4e77";' },
    ],
    exceptions: [{ why: 'the rule is scoped to tests/ and evals/', file: 'src/kernel.ts' }],
  },
];

/** Run one rule against one snippet, exactly as the driver would. */
function violationsOf(rule: Rule, file: string, source: string): number {
  if (!rule.applies(file)) return 0;
  return rule.check({
    file,
    lines: source.split('\n'),
    code: blankNonCode(source),
    text: blankNonCode(source, { keepStringContents: true }),
  }).length;
}

function ruleNamed(name: string): Rule {
  const rule = RULES.find((r) => r.name === name);
  assert.ok(rule, `no lint rule named "${name}"`);
  return rule;
}

for (const fixtures of FIXTURES) {
  describe(`lint rule: ${fixtures.rule}`, () => {
    const rule = ruleNamed(fixtures.rule);

    for (const c of fixtures.mustFail) {
      test(`MUST FAIL — ${c.why}`, () => {
        const file = c.file ?? fixtures.file;
        assert.ok(
          rule.applies(file),
          `the fixture path ${file} is outside the rule's scope, so this case proves nothing`,
        );
        assert.ok(
          violationsOf(rule, file, c.source) > 0,
          `"${fixtures.rule}" did not report:\n  ${c.source}`,
        );
      });
    }

    for (const c of fixtures.mustPass) {
      test(`MUST PASS — ${c.why}`, () => {
        const file = c.file ?? fixtures.file;
        assert.equal(
          violationsOf(rule, file, c.source),
          0,
          `"${fixtures.rule}" fired on legitimate code:\n  ${c.source}`,
        );
      });
    }

    for (const c of fixtures.exceptions ?? []) {
      test(`EXCEPTION — ${c.file}: ${c.why}`, () => {
        assert.equal(
          rule.applies(c.file),
          false,
          `"${fixtures.rule}" now applies to ${c.file}, which it is documented not to`,
        );
      });
    }
  });
}

describe('suppression pragmas', () => {
  const rule = ruleNamed('no-provider-names-in-core');
  const file = 'src/session/turn.ts';
  const offending = 'const x = "anthropic";';

  /** Lint one snippet end to end, suppressions included. */
  function surviving(source: string): Violation[] {
    const lines = source.split('\n');
    const found = rule.check({
      file,
      lines,
      code: blankNonCode(source),
      text: blankNonCode(source, { keepStringContents: true }),
    });
    return applySuppressions(found, lines);
  }

  test('NEGATIVE CONTROL: without a pragma the violation is reported', () => {
    // Every assertion below is "the pragma removed it", which is only meaningful
    // if there was something to remove.
    assert.equal(surviving(offending).length, 1);
  });

  test('a pragma on the same line suppresses it', () => {
    assert.equal(
      surviving(`${offending} // lint-allow no-provider-names-in-core: data, not coupling`).length,
      0,
    );
  });

  test('a pragma on the line above suppresses it', () => {
    assert.equal(
      surviving(`// lint-allow no-provider-names-in-core: data, not coupling\n${offending}`).length,
      0,
    );
  });

  test('a pragma at the top of a multi-line comment block still suppresses it', () => {
    // The case that silently stopped working the first time.
    assert.equal(
      surviving(
        '// lint-allow no-provider-names-in-core: the reason\n' +
          '// continues onto a second line, as real justifications do\n' +
          offending,
      ).length,
      0,
    );
  });

  test('a pragma for a different rule does not suppress this one', () => {
    assert.equal(surviving(`// lint-allow no-any: unrelated\n${offending}`).length, 1);
  });

  test('a pragma with no reason suppresses nothing', () => {
    // Otherwise `// lint-allow no-provider-names-in-core` becomes a way to turn
    // a release gate off without saying why.
    assert.equal(surviving(`// lint-allow no-provider-names-in-core\n${offending}`).length, 1);
    assert.equal(surviving(`// lint-allow no-provider-names-in-core:\n${offending}`).length, 1);
  });

  test('a pragma two lines up, separated by code, does not reach', () => {
    assert.equal(
      surviving(
        '// lint-allow no-provider-names-in-core: applies to the next line only\n' +
          'const unrelated = 1;\n' +
          offending,
      ).length,
      1,
    );
  });

  test('a file-level pragma must be in the header to count', () => {
    const header = `// lint-allow-file no-provider-names-in-core: fixtures\n${offending}`;
    assert.equal(surviving(header).length, 0);

    const buried = `${'\n'.repeat(45)}// lint-allow-file no-provider-names-in-core: fixtures\n${offending}`;
    assert.equal(
      surviving(buried).length,
      1,
      'a file-level exemption below the header would be invisible to anyone reading the top of the file',
    );
  });
});

describe('the self-test cannot fall behind the linter', () => {
  test('every rule has must-fail and must-pass fixtures', () => {
    const covered = new Set(FIXTURES.map((f) => f.rule));
    const uncovered = RULES.filter((r) => !covered.has(r.name)).map((r) => r.name);

    assert.deepEqual(
      uncovered,
      [],
      `these lint rules have no self-test fixtures: ${uncovered.join(', ')}. ` +
        'A release-blocking rule with no fixture fails silently when its pattern stops matching.',
    );

    for (const f of FIXTURES) {
      assert.ok(f.mustFail.length > 0, `${f.rule} has no must-fail fixture`);
      assert.ok(f.mustPass.length > 0, `${f.rule} has no must-pass fixture`);
    }
  });

  test('every fixture names a rule that still exists', () => {
    const names = new Set(RULES.map((r) => r.name));
    const stale = FIXTURES.filter((f) => !names.has(f.rule)).map((f) => f.rule);
    assert.deepEqual(stale, [], `fixtures reference rules that were removed: ${stale.join(', ')}`);
  });

  test('every rule states a rationale', () => {
    // A rule nobody can explain is a rule that gets deleted the first time it is
    // inconvenient. The rationale is printed with the first violation.
    for (const rule of RULES) {
      assert.ok(rule.rationale.length > 40, `rule "${rule.name}" has no meaningful rationale`);
    }
  });
});
