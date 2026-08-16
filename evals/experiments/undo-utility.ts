#!/usr/bin/env node
/**
 * Does having undo change what the model does? (alpha.10 §17.)
 *
 *   KERNEL_LIVE_MODEL=deepseek node evals/experiments/undo-utility.ts --runs=5
 *   node evals/experiments/undo-utility.ts --scripted        # harness smoke test
 *
 * An **experiment, not a gate**, for the same reason `delegation-utility.ts` is
 * one: its bad outcome is a fact about a model and a tool surface, not a
 * regression in the kernel. Golden tasks gate a tag; this produces a measurement.
 *
 * Three tasks × two arms × N. The arms differ by exactly one thing — whether
 * `Undo` exists in the catalogue — and each arm asserts that difference before
 * the turn runs.
 *
 * The question §17 actually asks is not "is undo useful". It is:
 *
 * > Undo is a tool with an unusually inviting description, and a model that
 * > undoes its way out of a difficulty instead of reading the error is a real
 * > failure mode worth measuring before it is anecdote.
 *
 * What it can conclude:
 *
 *   - **Whether the model reaches for `Undo` at all**, unprompted. A count, and
 *     a count of zero is unambiguous — the delegation experiment's hard-won
 *     lesson is that zero is a real possible answer, not a broken harness.
 *   - **Whether `Undo` displaces the correct recovery.** Two of the three tasks
 *     put a difficulty in the way whose right answer is to re-read; an `Undo`
 *     call there is the failure mode, and it is visible as a call rather than
 *     inferred from a step count.
 *   - **What the extra tool costs the others.** alpha.7 found that adding a tool
 *     makes a *different* tool harder to call, and alpha.9 reproduced that on
 *     two models. The rejected-call ratio per arm is the same metric.
 *
 * What it cannot: resolve a small step-count difference at N=5. Stated in the
 * write-up rather than left implied.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  distribution,
  median,
  mergeFriction,
  renderFriction,
  runTask,
  wastedCallRatio,
  type TaskMetrics,
} from '../runners/run.ts';
import { ALPHA10_UNDO_TOOLS, undoUtilityTasks, type Arm } from './undo-utility-fixtures.ts';

const RUNS = (() => {
  const flag = process.argv.find((a) => a.startsWith('--runs='));
  const parsed = flag ? Number.parseInt(flag.slice('--runs='.length), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();

interface Cell {
  baseId: string;
  arm: Arm;
  attempts: TaskMetrics[];
}

/** Attempts in which the model called Undo at all. A count of zero is a real answer. */
function usedUndo(attempt: TaskMetrics): boolean {
  return ALPHA10_UNDO_TOOLS.some((tool) => (attempt.toolFriction[tool]?.calls ?? 0) > 0);
}

function summarise(cell: Cell) {
  const n = cell.attempts.length;
  const friction = mergeFriction(cell.attempts.map((a) => a.toolFriction));

  return {
    baseId: cell.baseId,
    arm: cell.arm,
    attempts: n,
    solved: cell.attempts.filter((a) => a.passed).length,
    kernelCorrect: cell.attempts.filter((a) => a.kernelCorrect).length,
    attemptsUsingUndo: cell.attempts.filter(usedUndo).length,
    modelRequests: distribution(cell.attempts.map((a) => a.modelRequests)),
    toolCalls: distribution(cell.attempts.map((a) => a.toolCalls)),
    approvalPrompts: distribution(cell.attempts.map((a) => a.approvalPrompts)),
    tokens: distribution(cell.attempts.map((a) => a.inputTokens + a.outputTokens)),
    costUsd: median(cell.attempts.map((a) => a.costUsd)),
    wallTimeMs: distribution(cell.attempts.map((a) => a.durationMs)),
    /** The friction metric: what fraction of this arm's calls were rejected. */
    wastedCallRatio: wastedCallRatio(friction),
    toolFriction: friction,
    failureClasses: cell.attempts.reduce<Record<string, number>>((acc, a) => {
      if (a.failureClass) acc[a.failureClass] = (acc[a.failureClass] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

async function main(): Promise<number> {
  const scripted = process.argv.includes('--scripted');
  if (!process.env.KERNEL_LIVE_MODEL && !scripted) {
    process.stderr.write(
      'This experiment is live-only: the question is what a real model does when undo is available.\n' +
        'Run it as: KERNEL_LIVE_MODEL=<alias> node evals/experiments/undo-utility.ts --runs=5\n' +
        'Or as: node evals/experiments/undo-utility.ts --scripted   (harness smoke test, no model)\n',
    );
    return 2;
  }

  const runs = scripted ? 1 : RUNS;
  const cells: Cell[] = [];

  for (const task of undoUtilityTasks()) {
    const cell: Cell = { baseId: task.baseId, arm: task.arm, attempts: [] };
    for (let run = 1; run <= runs; run += 1) {
      const metrics = await runTask(task, `r${run}`);
      cell.attempts.push(metrics);
      process.stdout.write(
        `${metrics.passed ? 'pass' : 'FAIL'}  ${task.baseId.padEnd(26)} ${task.arm.padEnd(16)} r${run}  ` +
          `${String(metrics.toolCalls).padStart(2)} tools  ` +
          `${String(metrics.modelRequests).padStart(2)} reqs  ` +
          `${String(metrics.approvalPrompts).padStart(2)} prompts  ` +
          `${String(metrics.inputTokens + metrics.outputTokens).padStart(6)} tok\n`,
      );
      for (const failure of metrics.failures) process.stdout.write(`      ${failure}\n`);
    }
    cells.push(cell);
  }

  const summaries = cells.map(summarise);
  const byArm = (arm: Arm) => cells.filter((c) => c.arm === arm).flatMap((c) => c.attempts);

  const armTotals = (['undo-available', 'undo-withheld'] as const).map((arm) => {
    const attempts = byArm(arm);
    const friction = mergeFriction(attempts.map((a) => a.toolFriction));
    return {
      arm,
      attempts: attempts.length,
      solved: attempts.filter((a) => a.passed).length,
      attemptsUsingUndo: attempts.filter(usedUndo).length,
      modelRequests: distribution(attempts.map((a) => a.modelRequests)),
      toolCalls: distribution(attempts.map((a) => a.toolCalls)),
      approvalPrompts: distribution(attempts.map((a) => a.approvalPrompts)),
      tokens: distribution(attempts.map((a) => a.inputTokens + a.outputTokens)),
      costUsd: median(attempts.map((a) => a.costUsd)),
      wastedCallRatio: wastedCallRatio(friction),
      toolFriction: friction,
    };
  });

  const artifact = {
    generatedAt: new Date().toISOString(),
    experiment: 'undo-utility',
    question:
      'Does having Undo change what a real model does — and does it reach for a reversal instead of ' +
      'reading the error?',
    mode: scripted ? 'scripted' : 'live',
    provider: cells[0]?.attempts[0]?.provider ?? 'unknown',
    model: cells[0]?.attempts[0]?.model ?? 'unknown',
    runsPerCell: runs,
    toolsUnderTest: [...ALPHA10_UNDO_TOOLS],
    arms: armTotals,
    cells: summaries,
  };

  const dir = path.join(process.cwd(), 'evals', 'results', 'experiments');
  await mkdir(dir, { recursive: true });
  const stamp = artifact.generatedAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `undo-utility-${artifact.model}-${runs}x-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  // --- report --------------------------------------------------------------
  process.stdout.write(`\n── Per task, N=${runs} per cell ${'─'.repeat(34)}\n`);
  process.stdout.write(
    'task                       arm               solved  used Undo  reqs  tools  tok (med)\n',
  );
  for (const s of summaries) {
    process.stdout.write(
      `${s.baseId.padEnd(27)}${s.arm.padEnd(18)}${`${s.solved}/${s.attempts}`.padEnd(8)}` +
        `${`${s.attemptsUsingUndo}/${s.attempts}`.padEnd(10)}` +
        `${String(s.modelRequests.median).padEnd(6)}${String(s.toolCalls.median).padEnd(7)}${s.tokens.median}\n`,
    );
  }

  process.stdout.write(`\n── Arm totals ${'─'.repeat(46)}\n`);
  for (const a of armTotals) {
    process.stdout.write(
      `${a.arm.padEnd(18)}solved ${`${a.solved}/${a.attempts}`.padEnd(7)}` +
        `reqs ${String(a.modelRequests.median).padEnd(4)}` +
        `tools ${String(a.toolCalls.median).padEnd(4)}` +
        `prompts ${String(a.approvalPrompts.median).padEnd(4)}` +
        `tokens ${String(a.tokens.median).padEnd(8)}` +
        `rejected ${(a.wastedCallRatio * 100).toFixed(1)}%\n`,
    );
    for (const line of renderFriction(a.toolFriction)) process.stdout.write(`    ${line}\n`);
  }

  const available = armTotals.find((a) => a.arm === 'undo-available')!;
  const withheld = armTotals.find((a) => a.arm === 'undo-withheld')!;

  process.stdout.write(
    `\n── What that answers ${'─'.repeat(39)}\n` +
      `Undo was called in ${available.attemptsUsingUndo}/${available.attempts} attempts where it existed.\n` +
      `Solve: ${available.solved}/${available.attempts} with it vs ${withheld.solved}/${withheld.attempts} without.\n` +
      `Median tool calls: ${available.toolCalls.median} vs ${withheld.toolCalls.median}; ` +
      `median requests: ${available.modelRequests.median} vs ${withheld.modelRequests.median}; ` +
      `median tokens: ${available.tokens.median} vs ${withheld.tokens.median}.\n` +
      `Rejected calls: ${(available.wastedCallRatio * 100).toFixed(1)}% vs ${(withheld.wastedCallRatio * 100).toFixed(1)}%.\n` +
      (scripted
        ? 'MODE: scripted. Both arms follow trajectories written to succeed, so this run proves the\n' +
          '      harness and the controls work — it says nothing about what a model would choose.\n'
        : '') +
      `artifact: ${path.relative(process.cwd(), file)}\n`,
  );

  // Only a kernel fault fails the run. A model that ignores a tool, or an arm
  // that scores worse, is the measurement.
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
