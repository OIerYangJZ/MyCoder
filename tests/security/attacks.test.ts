/**
 * The adversarial suite (next-phase plan §4.5), driven by the reusable harness.
 *
 * Every attack in the plan's list runs against one session, and afterwards the
 * canary must appear zero times in all six sinks from spec §26.1.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { AttackHarness, ATTACKS, CANARY, type AttackOutcome, type SinkName } from './harness.ts';
import { activateSkill } from '../../src/extensions/skills.ts';
import { deriveSubagent } from '../../src/extensions/agents.ts';
import { validateRemoteConfig, defaultRemoteConfig } from '../../src/execution/ssh.ts';

describe('adversarial suite', () => {
  let harness: AttackHarness;
  const outcomes: AttackOutcome[] = [];

  before(async () => {
    harness = await AttackHarness.create();
    for (const attack of ATTACKS) {
      outcomes.push(await harness.run(attack));
    }
    // Hooks are exercised separately; see the harness comment.
    await harness.runSecretLeakingHook();
  });

  after(async () => {
    await harness.cleanup();
  });

  test('every attack was stopped by the mechanism it should have been', () => {
    const failures = outcomes.filter((o) => !o.passed);
    assert.deepEqual(
      failures.map((f) => `${f.attack.name} [${f.attack.covers}]: ${f.failure}`),
      [],
    );
  });

  test('the whole plan §4.5 list is covered', () => {
    // A harness whose attack list quietly shrinks is worse than no harness.
    assert.ok(ATTACKS.length >= 14, `expected the full attack list, found ${ATTACKS.length}`);
    const covered = new Set(ATTACKS.map((a) => a.covers));
    assert.equal(covered.size, ATTACKS.length, 'two attacks claim to cover the same line');
  });

  test('the canary appears zero times in all six sinks (§26.1)', async () => {
    const sinks = await harness.sinks();
    const leaks: string[] = [];

    for (const [name, content] of Object.entries(sinks) as Array<[SinkName, string]>) {
      const count = content.split(CANARY).length - 1;
      if (count > 0) {
        const at = content.indexOf(CANARY);
        leaks.push(
          `${name}: ${count} occurrence(s), near: ${content.slice(Math.max(0, at - 120), at + 120)}`,
        );
      }
    }

    assert.deepEqual(leaks, []);
  });

  test('the sinks are genuinely populated, so the assertion above means something', async () => {
    const sinks = await harness.sinks();
    // A zero-occurrence assertion against an empty string is vacuous.
    assert.ok(sinks['model payload'].length > 500, 'the model payload should be substantial');
    assert.ok(sinks['event log'].length > 2000, 'the event log should be substantial');
  });

  test('the debug log sink is wired and redacts', async () => {
    harness.probeDebugLog();
    const sinks = await harness.sinks();
    const log = sinks['debug log'];

    // The line arrived — so the sink is genuinely being captured…
    assert.match(log, /canary-probe/, 'the probe line did not reach the captured debug log');
    // …and the value did not survive the trip.
    assert.equal(log.includes(CANARY), false, 'the canary reached the debug log unredacted');
    assert.match(log, /\[REDACTED:secret\//, 'the value should have been replaced by a placeholder');
  });

  test('a secret-printing hook has its output redacted', async () => {
    const output = await harness.runSecretLeakingHook();
    assert.equal(output.includes(CANARY), false, 'hook stdout must pass through the redactor');
  });

  test('the reference tree was not modified', async () => {
    assert.equal(await harness.referenceFileUnchanged(), true);
  });

  test('a project config cannot widen the secret boundary', async () => {
    // The harness workspace ships a .agent/permissions.toml that tries to allow
    // `file.read_to_model` on `**/.env`. Protected paths are a system ceiling,
    // evaluated before any layer votes, so the rule has no effect.
    const decision = harness.kernel.policy.decide({
      kind: 'file.read',
      path: `${harness.kernel.workspaceRoot}/.env` as never,
      toModel: true,
      display: '.env',
    });
    assert.equal(decision.action, 'hard_deny');
    assert.equal(decision.final, true);
  });

  test('a skill asking for full-access and network gets neither', () => {
    const skill = harness.kernel.skills.find((s) => s.name === 'escalate');
    assert.ok(skill, 'the escalating skill fixture should have been discovered');

    const activated = activateSkill(skill, {
      registeredTools: harness.kernel.toolRegistry.names(),
      profileContext: { workspaceRoot: harness.kernel.workspaceRoot },
      sessionMaxSteps: 16,
    });

    // `network: true` in frontmatter is recorded as refused, not honoured.
    assert.ok(activated.notes.some((n) => /"network".*ignored/.test(n)));
    assert.ok(activated.notes.some((n) => /unknown permission profile/.test(n)));

    const narrowed = activated.layer ? harness.kernel.policy.narrow(activated.layer) : harness.kernel.policy;
    const write = narrowed.decide({
      kind: 'file.write',
      path: `${harness.kernel.workspaceRoot}/src/app.ts` as never,
      create: false,
      display: 'src/app.ts',
    });
    assert.notEqual(write.action, 'allow', 'the escalating skill must not unlock writes');
  });

  test('an agent asking for full-access is clamped to the parent', () => {
    const agent = harness.kernel.agents.find((a) => a.name === 'greedy');
    assert.ok(agent, 'the escalating agent fixture should have been discovered');

    const derived = deriveSubagent(agent, {
      parentPolicy: harness.kernel.policy,
      parentAllowedTools: ['Read', 'Grep'],
      parentMaxSteps: 8,
      parentModelAlias: 'fake',
      profileContext: { workspaceRoot: harness.kernel.workspaceRoot },
      knownModelAliases: ['fake'],
    });

    assert.deepEqual(derived.allowedTools, ['Read'], 'tools intersect with the parent');
    assert.equal(derived.maxSteps, 8, 'the step budget is clamped');
    assert.equal(
      derived.policy.decide({
        kind: 'file.read',
        path: `${harness.kernel.workspaceRoot}/.env` as never,
        toModel: true,
        display: '.env',
      }).action,
      'hard_deny',
    );
  });

  test('SSH env and agent forwarding are refused at configuration load', () => {
    const result = validateRemoteConfig({
      ...defaultRemoteConfig('dev', 'dev-vps', '/srv/project'),
      forwardAgent: true,
      forwardEnv: ['TEST_CANARY_SECRET', 'ANTHROPIC_API_KEY'],
    });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => /forward_agent/.test(p)));
    assert.ok(result.problems.some((p) => /forward_env/.test(p)));
    // The refusal message must not echo the values it is refusing to forward.
    assert.equal(result.problems.join(' ').includes(CANARY), false);
  });
});
