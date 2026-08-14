#!/usr/bin/env node
/**
 * Does delegation pay? (alpha.4 §36's open question.)
 *
 *   KERNEL_LIVE_MODEL=deepseek node evals/experiments/delegation-utility.ts --runs=5
 *
 * This is an **experiment, not a gate**. It lives outside `evals/tasks/golden.ts`
 * on purpose: the golden set is a release gate whose failure blocks a tag, while
 * this produces a measurement whose "bad" result is a fact about a model rather
 * than a regression in the kernel. Mixing the two is how a gate stops meaning
 * anything — the same reason §24 keeps the two scoreboards apart.
 *
 * The design is a 3×2: three task sizes against two conditions that differ by
 * exactly one thing, whether an agent definition exists in the workspace. With no
 * agents the kernel does not register `Delegate` at all, so the control is a model
 * that cannot see the tool rather than one politely declining it.
 *
 * What it can and cannot conclude, stated up front because N is small:
 *
 *   - It can say **whether the model reaches for delegation unprompted**, and at
 *     which size. That is a count, and a count of zero is unambiguous.
 *   - It can say **what offering delegation costs** when it goes unused: the
 *     difference between the two conditions is then just an extra tool schema in
 *     every request.
 *   - At N=5 per cell it **cannot** resolve a small difference in solve rate. Any
 *     such difference is reported as a distribution and left as a distribution.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { distribution, median, runTask, type TaskMetrics } from '../runners/run.ts';
import {
  delegationUtilityTasks,
  descriptionVariantTasks,
  type Condition,
  type Size,
} from './delegation-utility-fixtures.ts';

const RUNS = (() => {
  const flag = process.argv.find((a) => a.startsWith('--runs='));
  const parsed = flag ? Number.parseInt(flag.slice('--runs='.length), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();

interface Cell {
  size: Size;
  condition: Condition;
  intent: string;
  attempts: TaskMetrics[];
}

function summarise(cell: Cell) {
  const n = cell.attempts.length;
  const solved = cell.attempts.filter((a) => a.passed).length;
  const delegated = cell.attempts.filter((a) => a.delegations > 0).length;

  return {
    size: cell.size,
    condition: cell.condition,
    intent: cell.intent,
    attempts: n,
    solved,
    solveRate: n === 0 ? 0 : solved / n,
    /** Attempts in which the model *chose* to delegate at least once. */
    attemptsThatDelegated: delegated,
    delegationsTotal: cell.attempts.reduce((s, a) => s + a.delegations, 0),
    kernelCorrect: cell.attempts.filter((a) => a.kernelCorrect).length,
    modelRequests: distribution(cell.attempts.map((a) => a.modelRequests)),
    toolCalls: distribution(cell.attempts.map((a) => a.toolCalls)),
    tokens: distribution(cell.attempts.map((a) => a.inputTokens + a.outputTokens)),
    costUsd: median(cell.attempts.map((a) => a.costUsd)),
    wallTimeMs: distribution(cell.attempts.map((a) => a.durationMs)),
    failureClasses: cell.attempts.reduce<Record<string, number>>((acc, a) => {
      if (a.failureClass) acc[a.failureClass] = (acc[a.failureClass] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

async function main(): Promise<number> {
  if (!process.env.KERNEL_LIVE_MODEL) {
    process.stderr.write(
      'This experiment is live-only: the question is what a real model chooses.\n' +
        'Run it as: KERNEL_LIVE_MODEL=<alias> node evals/experiments/delegation-utility.ts --runs=5\n',
    );
    return 2;
  }

  // Phase 2 runs only when asked for, because it is a follow-up question: it is
  // worth the money once phase 1 has shown the answer is "never".
  const phase2 = process.argv.includes('--descriptions');
  const tasks = phase2 ? [] : delegationUtilityTasks();
  const cells: Cell[] = [];

  for (const task of tasks) {
    const cell: Cell = { size: task.size, condition: task.condition, intent: task.intent, attempts: [] };
    for (let run = 1; run <= RUNS; run += 1) {
      const metrics = await runTask(task, `r${run}`);
      cell.attempts.push(metrics);
      process.stdout.write(
        `${metrics.passed ? 'pass' : 'FAIL'}  ${task.size.padEnd(7)} ${task.condition.padEnd(17)} ` +
          `r${run}  ${String(metrics.delegations).padStart(2)} delegation(s)  ` +
          `${String(metrics.modelRequests).padStart(2)} reqs  ` +
          `${String(metrics.inputTokens + metrics.outputTokens).padStart(6)} tok  ` +
          `${String(metrics.durationMs).padStart(6)} ms\n`,
      );
      for (const failure of metrics.failures) process.stdout.write(`      ${failure}\n`);
    }
    cells.push(cell);
  }

  // --- phase 2: the same large task, two tool descriptions ----------------
  const variantCells: Array<{ variant: string; intent: string; attempts: TaskMetrics[] }> = [];
  if (phase2) {
    for (const task of descriptionVariantTasks()) {
      const attempts: TaskMetrics[] = [];
      for (let run = 1; run <= RUNS; run += 1) {
        const metrics = await runTask(task, `r${run}`);
        attempts.push(metrics);
        process.stdout.write(
          `${metrics.passed ? 'pass' : 'FAIL'}  ${task.variant.padEnd(8)} description  r${run}  ` +
            `${String(metrics.delegations).padStart(2)} delegation(s)  ` +
            `${String(metrics.modelRequests).padStart(2)} reqs  ` +
            `${String(metrics.inputTokens + metrics.outputTokens).padStart(6)} tok\n`,
        );
        for (const failure of metrics.failures) process.stdout.write(`      ${failure}\n`);
      }
      variantCells.push({ variant: task.variant, intent: task.intent, attempts });
    }
  }

  const summaries = cells.map(summarise);

  const artifact = {
    generatedAt: new Date().toISOString(),
    experiment: 'delegation-utility',
    question: 'Does offering delegation change what a real model does, and does it pay?',
    // Read from whichever phase ran: phase 2 leaves `cells` empty, and an artifact
    // that records the model as "unknown" is an artifact nobody can compare.
    provider: (cells[0]?.attempts[0] ?? variantCells[0]?.attempts[0])?.provider ?? 'unknown',
    model: (cells[0]?.attempts[0] ?? variantCells[0]?.attempts[0])?.model ?? 'unknown',
    runsPerCell: RUNS,
    cells: summaries,
    descriptionVariants: variantCells.map((c) => ({
      variant: c.variant,
      attempts: c.attempts.length,
      solved: c.attempts.filter((a) => a.passed).length,
      attemptsThatDelegated: c.attempts.filter((a) => a.delegations > 0).length,
      delegationsTotal: c.attempts.reduce((s, a) => s + a.delegations, 0),
      modelRequests: distribution(c.attempts.map((a) => a.modelRequests)),
      tokens: distribution(c.attempts.map((a) => a.inputTokens + a.outputTokens)),
    })),
  };

  const dir = path.join(process.cwd(), 'evals', 'results', 'experiments');
  await mkdir(dir, { recursive: true });
  const file = path.join(
    dir,
    `delegation-${phase2 ? 'description' : 'utility'}-${artifact.model}-${RUNS}x.json`,
  );
  await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  // --- report ------------------------------------------------------------
  if (phase2) {
    process.stdout.write(`\n── Delegate description, N=${RUNS} per variant ${'─'.repeat(22)}\n`);
    process.stdout.write('variant   solved  chose delegation  reqs (med)  tokens (med)\n');
    for (const v of artifact.descriptionVariants) {
      process.stdout.write(
        `${v.variant.padEnd(10)}${`${v.solved}/${v.attempts}`.padEnd(8)}` +
          `${`${v.attemptsThatDelegated}/${v.attempts}`.padEnd(18)}` +
          `${String(v.modelRequests.median).padEnd(12)}${v.tokens.median}\n`,
      );
    }
    process.stdout.write(`\nartifact: ${path.relative(process.cwd(), file)}\n`);

    const faults = variantCells.flatMap((c) => c.attempts).filter((a) => !a.kernelCorrect);
    if (faults.length > 0) {
      process.stdout.write(`\n${faults.length} attempt(s) recorded a kernel fault\n`);
      return 1;
    }
    return 0;
  }

  process.stdout.write(`\n── Delegation utility, N=${RUNS} per cell ${'─'.repeat(28)}\n`);
  process.stdout.write(
    'size     condition          solved  chose delegation  reqs (med)  tokens (med)  wall (med)\n',
  );
  for (const s of summaries) {
    process.stdout.write(
      `${s.size.padEnd(9)}${s.condition.padEnd(19)}${`${s.solved}/${s.attempts}`.padEnd(8)}` +
        `${`${s.attemptsThatDelegated}/${s.attempts}`.padEnd(18)}` +
        `${String(s.modelRequests.median).padEnd(12)}` +
        `${String(s.tokens.median).padEnd(14)}` +
        `${Math.round(s.wallTimeMs.median)}ms\n`,
    );
  }

  process.stdout.write(`\n── What that answers ${'─'.repeat(39)}\n`);
  for (const size of ['small', 'medium', 'large'] as const) {
    const withAgents = summaries.find((s) => s.size === size && s.condition === 'agents-available');
    const without = summaries.find((s) => s.size === size && s.condition === 'no-agents');
    if (!withAgents || !without) continue;

    const chose = withAgents.attemptsThatDelegated;
    const tokenDelta = withAgents.tokens.median - without.tokens.median;

    process.stdout.write(
      `${size.padEnd(8)} ${withAgents.intent}\n` +
        `         delegated in ${chose}/${withAgents.attempts} attempts; ` +
        `solve ${withAgents.solved}/${withAgents.attempts} with agents vs ${without.solved}/${without.attempts} without; ` +
        `${tokenDelta >= 0 ? '+' : ''}${tokenDelta} median tokens\n`,
    );
  }

  const everDelegated = summaries.reduce((n, s) => n + s.attemptsThatDelegated, 0);
  process.stdout.write(
    `\nDelegation was chosen in ${everDelegated} of ` +
      `${summaries.filter((s) => s.condition === 'agents-available').reduce((n, s) => n + s.attempts, 0)} ` +
      'attempts where it was available.\n' +
      `artifact: ${path.relative(process.cwd(), file)}\n`,
  );

  // The experiment fails only on a *kernel* fault. A model declining to delegate,
  // or failing a task, is the measurement — not a broken run.
  const kernelFaults = cells.flatMap((c) => c.attempts).filter((a) => !a.kernelCorrect);
  if (kernelFaults.length > 0) {
    process.stdout.write(
      `\n${kernelFaults.length} attempt(s) recorded a kernel fault: ` +
        `${kernelFaults.map((a) => `${a.id}/${a.runId} ${a.failureClass ?? ''}`).join(', ')}\n`,
    );
    return 1;
  }
  return 0;
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`experiment failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    });
}

export { main, summarise };
