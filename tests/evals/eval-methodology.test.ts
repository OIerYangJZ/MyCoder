/**
 * Eval methodology v2 (alpha.3 §24–§31).
 *
 * The methodology is itself a release gate, so it needs the same treatment §32
 * demands of everything else: executable evidence rather than a description.
 * These cases exercise the pieces that make a score interpretable —
 *
 *   the family split, so two different questions stop sharing a number;
 *   the omission/wrong-action distinction, so a model's off run stops reading
 *     as a runtime regression;
 *   Kernel Correctness, computed independently of task success;
 *   distributions with a recorded N, so a single run stops being a measurement.
 *
 * — against synthetic attempt records, because the arithmetic and the
 * classification are the parts that can silently drift. Whether the runner
 * *executes* correctly is covered by `pnpm eval` itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  KERNEL_FAULTS,
  classifyFailure,
  mergeFriction,
  stripUntrustedContent,
  toolFrictionFromLog,
  wastedCallRatio,
  countFailureClasses,
  distribution,
  median,
  promptHash,
  summariseFamilies,
  summarisePerTask,
  type FailureClass,
  type TaskMetrics,
} from '../../evals/runners/run.ts';
import { GOLDEN_TASKS, type EvalFamily } from '../../evals/tasks/golden.ts';

/** A minimal attempt record; every field the summaries touch. */
function attempt(over: Partial<TaskMetrics> = {}): TaskMetrics {
  return {
    id: 't',
    family: 'model-capability',
    runId: 'r1',
    passed: true,
    kernelCorrect: true,
    failures: [],
    provider: 'fake',
    model: 'fake-1',
    toolCalls: 3,
    modelRequests: 4,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0,
    editAttempts: 1,
    approvalPrompts: 0,
    secretBoundaryViolations: 0,
    unreviewedPersistentMutations: 0,
    durationMs: 20,
    fixtureVersion: 1,
    promptHash: 'abc123',
    // alpha.4 §36. Zeroed rather than optional so a summary that forgets to read
    // one of them is a type error rather than a silently missing column.
    delegations: 0,
    childSuccesses: 0,
    childModelRequests: 0,
    childToolCalls: 0,
    delegationLatencyMs: 0,
    delegatedCostUsd: 0,
    parentDirectCostUsd: 0,
    capabilityDenials: 0,
    delegationFailureStatuses: [],
    // §B: empty rather than optional, for the same reason as the delegation
    // block above — a summary that forgets the friction table should not
    // typecheck.
    toolFriction: {},
    ...over,
  };
}

// --- §24: two scoreboards ---------------------------------------------------

describe('the two eval families (§24)', () => {
  test('every task declares a family, and the families are disjoint', () => {
    const families: EvalFamily[] = ['kernel-invariant', 'model-capability'];

    for (const task of GOLDEN_TASKS) {
      assert.ok(
        families.includes(task.family),
        `task "${task.id}" has family "${task.family}", which is not one of ${families.join('/')}`,
      );
    }

    // Both scoreboards must actually have members. A split where everything
    // landed on one side would report the same single number as alpha.2 did,
    // with more ceremony.
    for (const family of families) {
      assert.ok(
        GOLDEN_TASKS.some((t) => t.family === family),
        `no task is classified as ${family}; the split would be decorative`,
      );
    }
  });

  test('a scripted-only task is always a kernel invariant', () => {
    // `scriptedOnly` means the premise requires a pathological model. That is
    // the definition of an invariant test, and classifying one as a capability
    // task would make a live run's skip look like a capability gap.
    for (const task of GOLDEN_TASKS.filter((t) => t.scriptedOnly)) {
      assert.equal(
        task.family,
        'kernel-invariant',
        `"${task.id}" is scripted-only but not an invariant task`,
      );
    }
  });

  test('every model-capability task has a natural live prompt (§30)', () => {
    for (const task of GOLDEN_TASKS.filter((t) => t.family === 'model-capability')) {
      const live = task.livePrompt ?? task.prompt;

      // §30 rejects labels like "Edit with a stale receipt." — an instruction to
      // a scripted harness, useless to a real model. The proxy for "natural" is
      // that it names something concrete the model can act on.
      assert.ok(live.length > 30, `"${task.id}" live prompt is too terse to be a real instruction: ${live}`);
      assert.match(
        live,
        /\.(ts|js|json|md)\b|`/,
        `"${task.id}" live prompt names no concrete target: ${live}`,
      );
    }
  });

  test('every task carries a fixture version', () => {
    for (const task of GOLDEN_TASKS) {
      assert.ok(
        Number.isInteger(task.fixtureVersion) && task.fixtureVersion > 0,
        `"${task.id}" has no usable fixtureVersion`,
      );
    }
  });

  test('the two scoreboards are computed independently', () => {
    const results = [
      attempt({ family: 'kernel-invariant', passed: true, kernelCorrect: true }),
      attempt({ family: 'kernel-invariant', passed: true, kernelCorrect: true }),
      // A capability task the model failed, with the runtime behaving.
      attempt({ family: 'model-capability', passed: false, kernelCorrect: true }),
      attempt({ family: 'model-capability', passed: true, kernelCorrect: true }),
    ];

    const summary = summariseFamilies(results);

    assert.deepEqual(summary['kernel-invariant'], {
      attempts: 2,
      solved: 2,
      kernelCorrect: 2,
      securityViolations: 0,
    });
    assert.deepEqual(summary['model-capability'], {
      attempts: 2,
      solved: 1,
      kernelCorrect: 2,
      securityViolations: 0,
    });

    // The point of the split: the model's miss did not move the invariant score.
    assert.equal(summary['kernel-invariant'].solved, summary['kernel-invariant'].attempts);
  });
});

// --- §25: failure classification -------------------------------------------

describe('failure classification (§25)', () => {
  const originalFiles = { 'src/math.ts': 'export const add = (a, b) => a - b;\n' };

  const classify = (
    failures: string[],
    turnState = 'completed',
    toolResults = '',
  ): FailureClass | undefined => classifyFailure(failures, toolResults, { turnState, originalFiles });

  test('no failures means no class', () => {
    assert.equal(classify([]), undefined);
  });

  test('a clean turn that left the file untouched is an omission', () => {
    // The model finished, reported success, and changed nothing — the canonical
    // "forgot to actually do it" case §25 names.
    const failure =
      'src/math.ts has the expected contents: expected "export const add = (a, b) => a + b;\\n", ' +
      'got "export const add = (a, b) => a - b;\\n"';

    assert.equal(classify([failure]), 'MODEL_ACTION_OMISSION');
  });

  test('a clean turn that changed the file to the wrong value is a wrong action', () => {
    const failure =
      'src/math.ts has the expected contents: expected "export const add = (a, b) => a + b;\\n", ' +
      'got "export const add = (a, b) => a * b;\\n"';

    assert.equal(classify([failure]), 'MODEL_WRONG_ACTION');
  });

  test('a missing observable effect on a clean turn is an omission', () => {
    assert.equal(
      classify(['a tool result mentions exit 0: no tool result mentioned exit 0']),
      'MODEL_ACTION_OMISSION',
    );
  });

  test('a runtime error outranks the omission heuristic', () => {
    // Order matters: a kernel bug that also leaves the file untouched must not
    // be recorded as the model's fault.
    assert.equal(classify(['check threw TypeError: x is not a function']), 'KERNEL_BUG');
    assert.equal(classify(['MODEL_INVALID_RESPONSE from the adapter']), 'ADAPTER_BUG');
  });

  test('a policy denial is classified as such, not as an omission', () => {
    assert.equal(classify(['tool result: PROTECTED_PATH']), 'POLICY_BLOCKED');
  });

  test('an exhausted provider account is an environment error, not an adapter bug', () => {
    // Prompted by a live experiment that ran the provider account dry. That run
    // classified as UNKNOWN, not as a kernel fault — the error never reached a tool
    // result for this classifier to read. But `MODEL_INVALID_RESPONSE` does map to
    // ADAPTER_BUG, so a 4xx whose text *does* surface would have read as our bug,
    // and an unpaid bill must never read as a runtime regression (§28).
    assert.equal(classify(['MODEL_AUTH_ERROR: refused for billing reasons (HTTP 402)']), 'ENVIRONMENT_ERROR');
    assert.equal(classify(['error: MODEL_RATE_LIMIT from the provider']), 'ENVIRONMENT_ERROR');
    assert.equal(
      KERNEL_FAULTS.has('ENVIRONMENT_ERROR'),
      false,
      'an environment error must not count against Kernel Correctness',
    );
  });

  describe('the alpha.4 delegation classes (§35)', () => {
    /** Classify with delegation evidence attached. */
    const withDelegations = (
      failures: string[],
      delegations: Array<{ status: string; modelRequests: number; toolCalls: number }>,
    ): FailureClass | undefined =>
      classifyFailure(failures, '', { turnState: 'completed', originalFiles: {}, delegations });

    test('a refused delegation is bad judgement by the model', () => {
      assert.equal(
        withDelegations(
          ['the answer names the parsing function: no'],
          [{ status: 'denied', modelRequests: 0, toolCalls: 0 }],
        ),
        'MODEL_BAD_DELEGATION',
      );
    });

    test('an unaffordable delegation is a budget problem, not a model one', () => {
      // The distinction matters for what you do next: BUDGET_BLOCKED means raise
      // the allowance, MODEL_BAD_DELEGATION means the model asked for the wrong
      // thing.
      assert.equal(
        withDelegations(['a check failed'], [{ status: 'budget_exceeded', modelRequests: 0, toolCalls: 0 }]),
        'BUDGET_BLOCKED',
      );
    });

    test("a parent's own budget exhaustion is still MODEL_CAPABILITY", () => {
      // alpha.3 §25 drew this line and it is still right: sixteen steps without
      // finishing is a capability problem. BUDGET_BLOCKED is for a *delegation*
      // that could not be afforded, which is the configuration speaking.
      assert.equal(classify(['turn ended as failed LOOP_BUDGET_EXCEEDED']), 'MODEL_CAPABILITY');
    });

    test('a child that never ran the runtime is our bug rather than the model', () => {
      assert.equal(
        classify(['a delegation completed: no delegation was dispatched']),
        'DELEGATION_RUNTIME_BUG',
      );
      assert.equal(
        classify(['the child actually sampled a model and ran a tool: the child executed no tool']),
        'DELEGATION_RUNTIME_BUG',
      );
    });

    test('a nested delegation attempt is a bad delegation', () => {
      assert.equal(classify(['tool result: error: DELEGATION_DEPTH_EXCEEDED']), 'MODEL_BAD_DELEGATION');
    });

    test('a skill that failed to narrow is a skill runtime bug', () => {
      assert.equal(classify(['the skill did not narrow: Edit was still available']), 'SKILL_RUNTIME_BUG');
    });

    test('NEGATIVE CONTROL: delegation evidence with no failure classifies as nothing', () => {
      assert.equal(withDelegations([], [{ status: 'completed', modelRequests: 2, toolCalls: 1 }]), undefined);
    });
  });

  test('a budget exhaustion is a capability problem, not an omission', () => {
    assert.equal(
      classify(['turn ends as completed: turn ended as failed LOOP_BUDGET_EXCEEDED']),
      'MODEL_CAPABILITY',
    );
  });

  test('a turn that did not complete cleanly is not classified as an omission', () => {
    // Omission means "finished, but skipped a step". A crashed turn is a
    // different story and must not borrow the label.
    assert.equal(classify(['some unattributable failure'], 'failed'), 'UNKNOWN');
  });

  test('the failure-class distribution counts occurrences', () => {
    // §25/§34: "3 MODEL_ACTION_OMISSION" and "3 KERNEL_BUG" are the same as a
    // set and mean opposite things, so the counts have to survive.
    const counts = countFailureClasses([
      attempt({ failureClass: 'MODEL_ACTION_OMISSION' }),
      attempt({ failureClass: 'MODEL_ACTION_OMISSION' }),
      attempt({ failureClass: 'KERNEL_BUG' }),
      attempt({}),
    ]);

    assert.deepEqual(counts, { MODEL_ACTION_OMISSION: 2, KERNEL_BUG: 1 });
  });
});

// --- §28: Kernel Correctness ------------------------------------------------

describe('Kernel Correctness is separate from task success (§28)', () => {
  test('a model omission leaves kernel correctness intact', () => {
    // The example §28 gives verbatim: model forgot to rerun tests → task
    // unsolved → MODEL_ACTION_OMISSION → Kernel Correctness = PASS.
    const results = [
      attempt({ passed: false, kernelCorrect: true, failureClass: 'MODEL_ACTION_OMISSION' }),
      attempt({ passed: false, kernelCorrect: true, failureClass: 'MODEL_WRONG_ACTION' }),
    ];
    const summary = summariseFamilies(results);

    assert.equal(summary['model-capability'].solved, 0);
    assert.equal(
      summary['model-capability'].kernelCorrect,
      2,
      'a model omission was counted as a kernel failure',
    );
  });

  test('a kernel bug fails kernel correctness', () => {
    const summary = summariseFamilies([
      attempt({ passed: false, kernelCorrect: false, failureClass: 'KERNEL_BUG' }),
    ]);
    assert.equal(summary['model-capability'].kernelCorrect, 0);
  });

  test('a security violation always fails kernel correctness', () => {
    // Even when the task was otherwise solved. A leak is a runtime failure by
    // definition, and there is no model behaviour that excuses it.
    const summary = summariseFamilies([
      attempt({ passed: false, kernelCorrect: false, secretBoundaryViolations: 1 }),
    ]);

    assert.equal(summary['model-capability'].securityViolations, 1);
    assert.equal(summary['model-capability'].kernelCorrect, 0);
  });
});

// --- §26/§27: distributions -------------------------------------------------

describe('repeated runs and distributions (§26, §27)', () => {
  test('the median resists a single outlier', () => {
    // Why §27 asks for medians: one retry storm should move the range, not the
    // central number.
    assert.equal(median([4, 4, 4, 4, 40]), 4);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), 0);
  });

  test('per-task distributions report median and range', () => {
    const rows = [
      attempt({ id: 'fix', runId: 'r1', modelRequests: 4, passed: true }),
      attempt({ id: 'fix', runId: 'r2', modelRequests: 4, passed: true }),
      attempt({
        id: 'fix',
        runId: 'r3',
        modelRequests: 11,
        passed: false,
        failureClass: 'MODEL_ACTION_OMISSION',
      }),
    ];

    const [summary] = summarisePerTask(rows);

    assert.equal(summary?.attempts, 3);
    assert.equal(summary?.solved, 2);
    assert.ok(Math.abs((summary?.successRate ?? 0) - 2 / 3) < 1e-9);
    assert.deepEqual(summary?.modelRequests, { median: 4, min: 0, max: 11 });
    assert.equal(summary?.modelActionOmissions, 1);
  });

  test('the runner accepts a run count and records it', async () => {
    // Asserted through the runner's own parsing rather than by re-implementing
    // it, so a change to the flag name fails here.
    const source = await readRunner();
    assert.match(source, /--runs=/, 'the runner has no --runs flag');
    assert.match(
      source,
      /return LIVE \? 5 : 1;/,
      'the live default is no longer 5 (§26 requires N>=3, default 5)',
    );
  });

  test('the sample size is written into the artifact', async () => {
    // §26: "sample size must be recorded". A distribution over an unrecorded N
    // is not comparable to anything.
    const source = await readRunner();
    assert.match(source, /runsPerTask: RUNS/, 'the artifact does not record N');
    assert.match(source, /kernelVersion: KERNEL_VERSION/, 'the artifact does not record the kernel version');
    assert.match(source, /kernelCommit: commit/, 'the artifact does not record the commit');
  });

  test('distribution of a single value is that value', () => {
    assert.deepEqual(distribution([7]), { median: 7, min: 0, max: 7 });
  });
});

// --- §31: reproducibility ---------------------------------------------------

describe('reproducibility fields (§31)', () => {
  test('the prompt hash changes when the prompt changes', () => {
    const a = promptHash('Fix add() in src/math.ts.');
    const b = promptHash('Fix add() in src/math.ts, then run the check.');

    assert.notEqual(a, b, 'a reworded prompt produced the same hash, so the rewording would be invisible');
    assert.equal(promptHash('Fix add() in src/math.ts.'), a, 'the hash is not stable');
    assert.match(a, /^[0-9a-f]{12}$/);
  });
});

async function readRunner(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('../../evals/runners/run.ts', import.meta.url), 'utf8');
}

// --- §B: the tool-friction metric ------------------------------------------

describe('tool friction, read from the event log (§B)', () => {
  const log = [
    { type: 'tool.call', payload: { toolCallId: 'a', name: 'Edit', argsHash: 'h1' } },
    { type: 'tool.error', payload: { toolCallId: 'a', name: 'Edit', errorCode: 'STALE_FILE' } },
    { type: 'tool.call', payload: { toolCallId: 'b', name: 'Edit', argsHash: 'h1' } },
    { type: 'tool.error', payload: { toolCallId: 'b', name: 'Edit', errorCode: 'STALE_FILE' } },
    { type: 'tool.call', payload: { toolCallId: 'c', name: 'Read', argsHash: 'h2' } },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');

  test('counts calls, rejections and error codes per tool', () => {
    const table = toolFrictionFromLog(log);
    assert.equal(table.Edit?.calls, 2);
    assert.equal(table.Edit?.errors, 2);
    assert.deepEqual(table.Edit?.codes, { STALE_FILE: 2 });
    assert.equal(table.Read?.calls, 1);
    assert.equal(table.Read?.errors, 0);
  });

  test('an identical call issued twice is counted as a repeat', () => {
    // The signal that a rejection told the model nothing it could act on.
    assert.equal(toolFrictionFromLog(log).Edit?.repeats, 1);
  });

  test('the rejected-call ratio is over calls, not over tasks', () => {
    assert.equal(wastedCallRatio(toolFrictionFromLog(log)), 2 / 3);
  });

  test('merging preserves counts across attempts', () => {
    const merged = mergeFriction([toolFrictionFromLog(log), toolFrictionFromLog(log)]);
    assert.equal(merged.Edit?.calls, 4);
    assert.equal(merged.Edit?.codes.STALE_FILE, 4);
  });

  test('a malformed line is skipped rather than throwing', () => {
    const table = toolFrictionFromLog(`not json\n${log}`);
    assert.equal(table.Edit?.calls, 2);
  });
});

describe('fetched content is not evidence about the kernel (§B)', () => {
  // A live defect, not a hypothetical: the web fixture's page documents a
  // `TypeError`, and the classifier read it out of the transcript and reported a
  // healthy run as KERNEL_BUG.
  const transcript =
    'WebFetch result\n' +
    '--- begin untrusted web content ---\n' +
    'Calling it with one argument throws TypeError: taxRate is required.\n' +
    '--- end untrusted web content ---\n';

  test('the untrusted block is removed before classification', () => {
    assert.doesNotMatch(stripUntrustedContent(transcript), /TypeError/);
    assert.match(stripUntrustedContent(transcript), /fetched content omitted/);
  });

  test('a page that names a kernel error does not produce a kernel fault', () => {
    const cls = classifyFailure(
      ['the call passes a tax rate: expected computeTotal(items, 0.2)'],
      transcript,
      {
        turnState: 'completed',
        originalFiles: {},
        delegations: [],
      },
    );
    assert.notEqual(cls, 'KERNEL_BUG');
    assert.ok(!KERNEL_FAULTS.has(cls!), `a fetched page must not blame the kernel, got ${cls}`);
  });

  test('NEGATIVE CONTROL: a real TypeError outside the block still classifies', () => {
    const cls = classifyFailure(['check threw TypeError: x is not a function'], '', {
      turnState: 'failed',
      originalFiles: {},
      delegations: [],
    });
    assert.equal(cls, 'KERNEL_BUG');
  });
});
