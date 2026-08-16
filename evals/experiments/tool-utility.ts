#!/usr/bin/env node
/**
 * Do the alpha.7 file tools pay? (§B — the question the tool surface could not answer.)
 *
 *   KERNEL_LIVE_MODEL=deepseek node evals/experiments/tool-utility.ts --runs=5
 *   node evals/experiments/tool-utility.ts --scripted        # harness smoke test
 *
 * An **experiment, not a gate**, for the same reason `delegation-utility.ts` is
 * one: its bad outcome is a fact about a model and a tool surface, not a
 * regression in the kernel. Golden tasks gate a tag; this produces a measurement.
 *
 * Three tasks × two arms × N. The arms differ by exactly one thing — whether
 * `Write`, `Delete` and `Move` exist in the catalogue — and each arm asserts that
 * difference before the turn runs.
 *
 * What it can conclude:
 *
 *   - **Whether the model reaches for the new tools at all**, unprompted. A
 *     count, and a count of zero is unambiguous (the delegation experiment's
 *     hard-won lesson: that is a real possible answer).
 *   - **What the tools cost in friction**: rejected calls per arm, by error code.
 *     `STALE_FILE` and `INSUFFICIENT_READ_COVERAGE` are the receipt discipline
 *     being paid for; if the available arm spends more calls than the withheld
 *     one, the receipt rules are costing more than the tools save.
 *   - **Whether the tasks are solvable either way.** They are, by construction —
 *     the withheld arm's scripted trajectory does it with Edit and Shell — so a
 *     difference in solve rate would be about the model, not about possibility.
 *
 * What it cannot: resolve a small step-count difference at N=5, or say anything
 * about a second model. Both are stated in the write-up rather than left implied.
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
import { ALPHA7_FILE_TOOLS, toolUtilityTasks, type Arm } from './tool-utility-fixtures.ts';

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

/** Attempts in which the model called one of the tools under test. */
function usedNewTools(attempt: TaskMetrics): boolean {
  return ALPHA7_FILE_TOOLS.some((tool) => (attempt.toolFriction[tool]?.calls ?? 0) > 0);
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
    attemptsUsingNewTools: cell.attempts.filter(usedNewTools).length,
    modelRequests: distribution(cell.attempts.map((a) => a.modelRequests)),
    toolCalls: distribution(cell.attempts.map((a) => a.toolCalls)),
    approvalPrompts: distribution(cell.attempts.map((a) => a.approvalPrompts)),
    tokens: distribution(cell.attempts.map((a) => a.inputTokens + a.outputTokens)),
    costUsd: median(cell.attempts.map((a) => a.costUsd)),
    wallTimeMs: distribution(cell.attempts.map((a) => a.durationMs)),
    /** The §B metric: what fraction of calls the tools rejected. */
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
      'This experiment is live-only: the question is what a real model does with the tools.\n' +
        'Run it as: KERNEL_LIVE_MODEL=<alias> node evals/experiments/tool-utility.ts --runs=5\n' +
        'Or as: node evals/experiments/tool-utility.ts --scripted   (harness smoke test, no model)\n',
    );
    return 2;
  }

  const runs = scripted ? 1 : RUNS;
  const cells: Cell[] = [];

  for (const task of toolUtilityTasks()) {
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

  const armTotals = (['tools-available', 'tools-withheld'] as const).map((arm) => {
    const attempts = byArm(arm);
    const friction = mergeFriction(attempts.map((a) => a.toolFriction));
    return {
      arm,
      attempts: attempts.length,
      solved: attempts.filter((a) => a.passed).length,
      attemptsUsingNewTools: attempts.filter(usedNewTools).length,
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
    experiment: 'tool-utility',
    question: 'Do Write, Delete and Move change what a real model does, and what do they cost in friction?',
    mode: scripted ? 'scripted' : 'live',
    provider: cells[0]?.attempts[0]?.provider ?? 'unknown',
    model: cells[0]?.attempts[0]?.model ?? 'unknown',
    runsPerCell: runs,
    toolsUnderTest: [...ALPHA7_FILE_TOOLS],
    arms: armTotals,
    cells: summaries,
  };

  const dir = path.join(process.cwd(), 'evals', 'results', 'experiments');
  await mkdir(dir, { recursive: true });
  const stamp = artifact.generatedAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `tool-utility-${artifact.model}-${runs}x-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  // --- report --------------------------------------------------------------
  process.stdout.write(`\n── Per task, N=${runs} per cell ${'─'.repeat(34)}\n`);
  process.stdout.write(
    'task                       arm               solved  used new  reqs  tools  tok (med)\n',
  );
  for (const s of summaries) {
    process.stdout.write(
      `${s.baseId.padEnd(27)}${s.arm.padEnd(18)}${`${s.solved}/${s.attempts}`.padEnd(8)}` +
        `${`${s.attemptsUsingNewTools}/${s.attempts}`.padEnd(10)}` +
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

  const available = armTotals.find((a) => a.arm === 'tools-available')!;
  const withheld = armTotals.find((a) => a.arm === 'tools-withheld')!;

  process.stdout.write(
    `\n── What that answers ${'─'.repeat(39)}\n` +
      `The new tools were used in ${available.attemptsUsingNewTools}/${available.attempts} attempts where they existed.\n` +
      `Solve: ${available.solved}/${available.attempts} with them vs ${withheld.solved}/${withheld.attempts} without.\n` +
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
