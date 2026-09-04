/**
 * Approval modes (spec §11.4, `src/policy/approval-mode.ts`).
 *
 * The feature is one sentence — a mode decides who answers an `ask` — and the
 * whole risk is in what it must *not* be able to do. So most of this file is
 * negative: `auto` does not answer for a credential, no mode turns a `deny` into
 * an `allow`, a mode-answered action is not recorded as a user approval, and the
 * gate leaves `manual` byte-for-byte as it was before the gate existed.
 *
 * The one property worth stating in prose because no single test shows it: a mode
 * is not a capability. `ToolRuntime` returns before the approval for `deny` and
 * `hard_deny`, so the gate never sees them — the test below asserts that from the
 * policy engine's side rather than trusting the comment.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_MODES,
  ApprovalModeState,
  cycleApprovalMode,
  DEFAULT_APPROVAL_MODE,
  describeApprovalMode,
  isApprovalMode,
  ModeGatedPrompter,
  NEVER_ANSWERED,
  autoAnswered,
  weakensApproval,
  type ApprovalMode,
} from '../../src/policy/approval-mode.ts';
import { ALL_CAPABILITIES, type AccessRequest } from '../../src/policy/access.ts';
import { PolicyEngine, SessionApprovalStore, type PolicyDecision } from '../../src/policy/policy-engine.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';
import { readOnlyProfile, workspaceDevProfile } from '../../src/policy/profiles.ts';
import type { ApprovalOutcome, ApprovalPrompter, ApprovalRequest } from '../../src/tools/runtime.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

const ROOT = '/repo' as CanonicalPath;
const CTX = { workspaceRoot: ROOT, agentTmpDir: '/repo/.agent/tmp' as CanonicalPath };

/** A prompter that records what reached it and answers from a script. */
class RecordingPrompter implements ApprovalPrompter {
  readonly seen: ApprovalRequest[] = [];
  private readonly answer: ApprovalOutcome;

  // Not a parameter property: `node --experimental-strip-types` erases types
  // rather than compiling them, and `constructor(private x)` is syntax with a
  // runtime effect. The whole suite runs under strip-only mode.
  constructor(answer: ApprovalOutcome = { decision: 'deny', scope: 'once' }) {
    this.answer = answer;
  }

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.seen.push(request);
    return this.answer;
  }
}

const FILE = '/repo/src/a.ts' as CanonicalPath;

const access = {
  write: { kind: 'file.write', path: FILE, create: false, display: 'src/a.ts' },
  del: { kind: 'file.delete', path: FILE, display: 'src/a.ts' },
  exec: { kind: 'process.exec', executable: 'npm', argv: ['npm', 'test'], cwd: ROOT, display: 'npm test' },
  secret: { kind: 'secret.use', secretRef: 'provider/anthropic', display: 'ANTHROPIC_API_KEY' },
  net: { kind: 'network.connect', host: 'registry.npmjs.org', port: 443, via: 'shell', display: 'npmjs' },
  mcp: {
    kind: 'mcp.invoke',
    server: 'linear',
    tool: 'create_issue',
    transport: 'stdio',
    display: 'linear/create_issue',
  },
  vcs: { kind: 'vcs.mutate', operation: 'commit', display: 'git commit' },
} satisfies Record<string, AccessRequest>;

/** An approval request whose pending decisions draw on `accesses`. */
function requestFor(...accesses: AccessRequest[]): ApprovalRequest {
  const pending = accesses.map((a): PolicyDecision => ({
    action: 'ask',
    access: a,
    subjectKey: `subject:${a.kind}`,
    reason: 'test',
    final: false,
    errorCode: 'TOOL_DENIED',
  }));
  return {
    subject: { key: 'Tool:subject', title: 'do the thing', details: [], risk: 'low' },
    toolName: 'Tool',
    toolCallId: 'call_1',
    pending,
  };
}

function gate(mode: ApprovalMode, delegate: ApprovalPrompter, onAutoAnswer?: () => void): ModeGatedPrompter {
  return new ModeGatedPrompter({
    delegate,
    mode: () => mode,
    ...(onAutoAnswer ? { onAutoAnswer } : {}),
  });
}

describe('the vocabulary', () => {
  test('manual is the default, and it answers nothing on your behalf', () => {
    assert.equal(DEFAULT_APPROVAL_MODE, 'manual');
    assert.deepEqual(autoAnswered('manual'), []);
    assert.deepEqual(autoAnswered('plan'), []);
  });

  test('the cycle visits every mode and returns to where it started', () => {
    let mode: ApprovalMode = 'plan';
    const visited: ApprovalMode[] = [mode];
    for (let i = 0; i < APPROVAL_MODES.length - 1; i += 1) {
      mode = cycleApprovalMode(mode);
      visited.push(mode);
    }
    assert.deepEqual([...visited].sort(), [...APPROVAL_MODES].sort());
    assert.equal(cycleApprovalMode(mode), 'plan');
  });

  test('the cycle is ordered by increasing autonomy, so Shift-Tab never skips a step', () => {
    // Not just "it is a permutation": the order is what a keystroke walks, and a
    // cycle that went manual → auto → accept-edits would hand somebody full
    // autonomy on the way to asking for less of it.
    const answered = APPROVAL_MODES.map((m) => autoAnswered(m).length);
    for (let i = 1; i < answered.length; i += 1) {
      assert.ok(
        answered[i]! >= answered[i - 1]!,
        `${APPROVAL_MODES[i]} answers less than ${APPROVAL_MODES[i - 1]}`,
      );
    }
  });

  test('only the two weakening modes are declared as weakening', () => {
    assert.deepEqual(
      APPROVAL_MODES.filter(weakensApproval),
      ['accept-edits', 'auto'],
      'the disclosure requirement follows this predicate; a wrong answer here silences §12',
    );
  });

  test('an unrecognised mode name is not a mode', () => {
    assert.ok(!isApprovalMode('bypassPermissions'));
    assert.ok(!isApprovalMode('yolo'));
    assert.ok(!isApprovalMode(''));
    assert.ok(isApprovalMode('auto'));
  });
});

describe('what each mode answers', () => {
  test('plan and manual answer nothing at all', () => {
    for (const capability of ALL_CAPABILITIES) {
      assert.ok(!autoAnswered('plan').includes(capability), `plan answered ${capability}`);
      assert.ok(!autoAnswered('manual').includes(capability), `manual answered ${capability}`);
    }
  });

  test('accept-edits answers workspace writes and nothing else', () => {
    assert.ok(autoAnswered('accept-edits').includes('file.write'));
    for (const capability of ALL_CAPABILITIES.filter((c) => c !== 'file.write')) {
      assert.ok(!autoAnswered('accept-edits').includes(capability), `accept-edits answered ${capability}`);
    }
  });

  test('auto answers edits, deletions and commands — and stops there', () => {
    for (const capability of ['file.write', 'file.delete', 'process.exec'] as const) {
      assert.ok(autoAnswered('auto').includes(capability), `auto did not answer ${capability}`);
    }
  });

  /**
   * The boundary this feature was designed around, asserted by name.
   *
   * Written as four explicit assertions rather than a loop over "everything
   * else", because these four are the reason `auto` is not `bypassPermissions`:
   * each one has a consequence that leaves the workspace. A change that moved any
   * of them into `AUTO_ANSWERED` should have to delete a line here that says why
   * it was not.
   */
  test('no mode ever answers for a credential, a host, git history or an MCP tool', () => {
    for (const mode of APPROVAL_MODES) {
      assert.ok(!autoAnswered(mode).includes('secret.use'), `${mode} would inject a credential unasked`);
      assert.ok(!autoAnswered(mode).includes('network.connect'), `${mode} would open a channel unasked`);
      assert.ok(!autoAnswered(mode).includes('vcs.mutate'), `${mode} would rewrite history unasked`);
      assert.ok(!autoAnswered(mode).includes('mcp.invoke'), `${mode} would run a foreign tool unasked`);
    }
  });

  test('reads and env.read are nobody’s business, so no mode claims them', () => {
    for (const mode of APPROVAL_MODES) {
      for (const capability of NEVER_ANSWERED) {
        // env.read in particular is a system hard deny; it can never become an
        // approval, so a mode listing it would describe something impossible.
        assert.ok(!autoAnswered(mode).includes(capability), `${mode} claims ${capability}`);
      }
    }
    // And the exclusion list itself is the three it claims to be. It derives from
    // `ALL_CAPABILITIES`, so a renamed capability is a compile error rather than a
    // silently shorter list — this pins the membership as well.
    assert.deepEqual([...NEVER_ANSWERED].sort(), ['env.read', 'file.read', 'file.read_to_model']);
  });

  test('the prose is generated from the table, so it cannot describe the old arrangement', () => {
    // `describeApprovalMode` used to spell the list out by hand. If it ever does
    // again, this fails: every capability the summary names has to be one
    // `autoAnswered` actually returns, and every one it returns has to appear.
    for (const mode of APPROVAL_MODES) {
      const summary = describeApprovalMode(mode).summary;
      for (const capability of autoAnswered(mode)) {
        assert.ok(summary.includes(capability), `the ${mode} summary omits ${capability}`);
      }
      for (const capability of ALL_CAPABILITIES) {
        if (autoAnswered(mode).includes(capability)) continue;
        assert.ok(
          !summary.includes(capability),
          `the ${mode} summary names ${capability}, which it does not answer`,
        );
      }
    }
  });

  /**
   * The defect the first version shipped, kept as a regression test.
   *
   * `/status` and `/mode` printed the *complement* of `AUTO_ANSWERED` under the
   * label "still asks". That number is a fact about the mode; the sentence built
   * from it was a claim about the whole policy stack, and in plan mode it was
   * false — the read-only layer denies writes, deletions, network, VCS, secrets
   * and MCP outright, so the line reported a session that cannot write as being
   * about to ask permission to write.
   *
   * The fix was to stop deriving an "asks" list anywhere. This asserts the
   * summaries never make that claim again, in any mode.
   */
  /**
   * `NO_GRANT_PROSE` is a `Partial` record with a `??` fallback, so a fifth mode
   * that answers nothing would compile and quietly describe itself with a
   * generic sentence. This is what turns that into a failure instead.
   */
  test('every mode has a real summary, not the generic fallback', () => {
    for (const mode of APPROVAL_MODES) {
      const summary = describeApprovalMode(mode).summary;
      assert.ok(summary.length > 30, `${mode} has no substantive summary: ${JSON.stringify(summary)}`);
      assert.notEqual(
        summary,
        'This mode answers nothing on your behalf.',
        `${mode} fell back to the generic summary; give it prose in NO_GRANT_PROSE`,
      );
    }
  });

  test('no summary claims to know what will be asked — only what it answers', () => {
    for (const mode of APPROVAL_MODES) {
      const summary = describeApprovalMode(mode).summary;
      assert.ok(!/still asks/i.test(summary), `the ${mode} summary predicts what will be asked`);
      if (autoAnswered(mode).length > 0) {
        // The one claim it may make about the remainder is a qualified one.
        assert.match(summary, /unless a policy layer denies it first/);
      }
    }
  });
});

describe('the gate', () => {
  test('manual passes every request through untouched', async () => {
    const delegate = new RecordingPrompter({ decision: 'allow', scope: 'session' });
    const outcome = await gate('manual', delegate).request(requestFor(access.write));
    assert.equal(delegate.seen.length, 1);
    // Including the scope: the gate must not quietly downgrade a session grant.
    // And it must not stamp a human's answer as the mode's — `answeredByMode`
    // is what the durable log uses to say who decided.
    assert.deepEqual(outcome, { decision: 'allow', scope: 'session' });
  });

  test('accept-edits answers a write without consulting the prompter', async () => {
    const delegate = new RecordingPrompter();
    const outcome = await gate('accept-edits', delegate).request(requestFor(access.write));
    assert.deepEqual(outcome, { decision: 'allow', scope: 'once', answeredByMode: true });
    assert.equal(delegate.seen.length, 0);
  });

  /**
   * The provenance the durable log depends on.
   *
   * `approval.decided` records `granted: true` for both a mode-answered action
   * and one the user pressed `y` for. Without this flag those two are the same
   * bytes, and "which of these did a human review" is unanswerable for exactly
   * the session where it matters most.
   */
  test('a mode-answered outcome is marked, and a delegated one is not', async () => {
    const answered = await gate('auto', new RecordingPrompter()).request(requestFor(access.exec));
    assert.equal(answered.answeredByMode, true);

    // The gate must not stamp what it merely passed on. A prompter's answer is
    // the user's, whatever mode the session happens to be in.
    const passedOn = await gate('auto', new RecordingPrompter({ decision: 'allow', scope: 'once' })).request(
      requestFor(access.secret),
    );
    assert.notEqual(passedOn.answeredByMode, true);
  });

  test('accept-edits still asks about a deletion', async () => {
    const delegate = new RecordingPrompter();
    await gate('accept-edits', delegate).request(requestFor(access.del));
    assert.equal(delegate.seen.length, 1, 'a deletion leaves no diff and must not be answered by a mode');
  });

  test('auto answers a deletion and a command, and asks about a credential', async () => {
    const delegate = new RecordingPrompter();
    const g = gate('auto', delegate);
    assert.equal((await g.request(requestFor(access.del))).decision, 'allow');
    assert.equal((await g.request(requestFor(access.exec))).decision, 'allow');
    assert.equal(delegate.seen.length, 0);

    await g.request(requestFor(access.secret));
    await g.request(requestFor(access.net));
    await g.request(requestFor(access.mcp));
    await g.request(requestFor(access.vcs));
    assert.equal(delegate.seen.length, 4);
  });

  /**
   * The one that matters most, and the one a per-capability implementation gets
   * wrong: a tool call is a *set* of accesses under one approval.
   */
  test('a mixed request is not answered because part of it was covered', async () => {
    const delegate = new RecordingPrompter();
    // A write auto answers; the host does not. Together they must reach the user,
    // or approving the write would have granted the host silently.
    await gate('auto', delegate).request(requestFor(access.write, access.net));
    assert.equal(delegate.seen.length, 1);
    assert.equal(delegate.seen[0]?.pending.length, 2);
  });

  test('an empty pending list is never answered by a mode', async () => {
    const delegate = new RecordingPrompter();
    await gate('auto', delegate).request(requestFor());
    assert.equal(delegate.seen.length, 1, 'nothing to classify is not the same as everything covered');
  });

  test('a mode-answered action is reported, so the transcript can say it happened', async () => {
    let calls = 0;
    await gate('auto', new RecordingPrompter(), () => {
      calls += 1;
    }).request(requestFor(access.write));
    assert.equal(calls, 1);
  });

  test('the gate answers "once", so a grant lasts exactly as long as the mode', async () => {
    // `session` would outlive a Shift-Tab back to manual and turn a mode into a
    // set of standing approvals — which `/permissions show` would then print as
    // decisions the user made.
    const outcome = await gate('auto', new RecordingPrompter()).request(requestFor(access.exec));
    assert.equal(outcome.scope, 'once');
  });

  test('the mode is read per request, not captured at construction', async () => {
    const delegate = new RecordingPrompter();
    let mode: ApprovalMode = 'manual';
    const g = new ModeGatedPrompter({ delegate, mode: () => mode });

    await g.request(requestFor(access.write));
    assert.equal(delegate.seen.length, 1, 'manual should have asked');

    mode = 'accept-edits';
    await g.request(requestFor(access.write));
    assert.equal(delegate.seen.length, 1, 'accept-edits should not have asked');
  });

  test('a denial from the delegate is passed back unchanged, reason included', async () => {
    const delegate = new RecordingPrompter({ decision: 'deny', scope: 'session', reason: 'no' });
    const outcome = await gate('auto', delegate).request(requestFor(access.secret));
    assert.deepEqual(outcome, { decision: 'deny', scope: 'session', reason: 'no' });
  });
});

describe('a mode is not a capability', () => {
  function engine(profile: 'workspace-dev' | 'read-only'): PolicyEngine {
    return new PolicyEngine({
      workspaceRoot: ROOT,
      protectedPaths: new ProtectedPaths({ home: '/home/dev' }),
      layers: [
        {
          name: 'session',
          source: 'session',
          profile: profile === 'read-only' ? readOnlyProfile(CTX) : workspaceDevProfile(CTX),
        },
      ],
      approvals: new SessionApprovalStore(),
    });
  }

  /**
   * The property the whole design rests on, from the engine's side.
   *
   * `ToolRuntime` filters `deny` and `hard_deny` out before the approval, so the
   * gate is structurally unable to see them. Asserting that here rather than
   * trusting the comment: what these decisions are is what makes the filter
   * sufficient.
   */
  test('privilege escalation is hard-denied, so no mode can reach it', () => {
    const sudo: AccessRequest = {
      kind: 'process.exec',
      executable: 'sudo',
      argv: ['sudo', 'rm', '-rf', '/'],
      cwd: ROOT,
      display: 'sudo rm -rf /',
    };
    const decision = engine('workspace-dev').decide(sudo);
    assert.equal(decision.action, 'hard_deny');
    assert.equal(decision.final, true, 'a final decision is one no approval and no mode can answer');
  });

  test('plan mode is the read-only profile, so mutation is denied rather than asked', () => {
    // Which is why plan mode is a layer and not a gate entry: `deny` never
    // becomes an approval, so there is nothing for any mode to answer.
    const decision = engine('read-only').decide(access.write);
    assert.ok(
      decision.action === 'deny' || decision.action === 'hard_deny',
      `a write under read-only was ${decision.action}, so plan mode would leave it answerable`,
    );
    assert.ok(!autoAnswered('plan').includes('file.write'));
  });

  test('intersecting the read-only layer can only narrow what workspace-dev allowed', () => {
    const base = engine('workspace-dev');
    const planned = base.narrow({ name: 'mode:plan', source: 'session', profile: readOnlyProfile(CTX) });

    // The write is allowed outright under workspace-dev and must not be after.
    assert.equal(base.decide(access.write).action, 'allow');
    assert.notEqual(planned.decide(access.write).action, 'allow');

    // And nothing the base denied became permitted.
    for (const a of Object.values(access)) {
      const before = base.decide(a).action;
      const after = planned.decide(a).action;
      if (before === 'allow') continue;
      assert.notEqual(after, 'allow', `${a.kind} was ${before} and became ${after}`);
    }
  });
});

describe('the mode state', () => {
  test('it starts where configuration put it', () => {
    assert.equal(new ApprovalModeState('auto').mode, 'auto');
    assert.equal(new ApprovalModeState().mode, DEFAULT_APPROVAL_MODE);
  });

  test('setting the same mode twice reports no change, so nothing is re-derived', () => {
    const state = new ApprovalModeState('manual');
    assert.deepEqual(state.set('manual'), { changed: false, previous: 'manual' });
    assert.deepEqual(state.set('auto'), { changed: true, previous: 'manual' });
  });

  test('a change notifies once, with both sides of it', () => {
    const seen: Array<[ApprovalMode, ApprovalMode]> = [];
    const state = new ApprovalModeState('manual', (mode, previous) => seen.push([mode, previous]));
    state.set('plan');
    state.set('plan');
    assert.deepEqual(seen, [['plan', 'manual']]);
  });

  test('cycling reports where it came from, which is what the message prints', () => {
    const state = new ApprovalModeState('manual');
    assert.deepEqual(state.cycle(), { mode: 'accept-edits', previous: 'manual' });
  });
});
