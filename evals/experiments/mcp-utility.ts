#!/usr/bin/env node
/**
 * Does a foreign tool surface pay? (alpha.9 §17.)
 *
 *   KERNEL_LIVE_MODEL=deepseek node evals/experiments/mcp-utility.ts --runs=5
 *   node evals/experiments/mcp-utility.ts --scripted        # harness smoke test
 *
 * An **experiment, not a gate**, like `tool-utility.ts` and for the same reason:
 * a bad outcome here is a fact about a model and a catalogue, not a regression in
 * the kernel. Golden tasks gate a tag; this produces a measurement.
 *
 * Three tasks × two arms × N. The arms differ by exactly one thing — whether a
 * stdio MCP server is attached — and each arm asserts that difference before the
 * turn runs.
 *
 * The question is **not** "does MCP work". It is the one §17 names: *does a
 * foreign tool surface make the model better, worse, or merely busier* — and
 * alpha.7 already found that adding a tool can make a **different** tool harder
 * to call. So the headline number is not the foreign tools' own friction. It is
 * `builtinWasted`: what fraction of the model's calls to *the kernel's own tools*
 * were rejected, in each arm. If that rises when a server is attached, the cost
 * of MCP is not paid by MCP.
 *
 * What it cannot conclude: anything at N=5 about a small difference, and
 * anything at all about a model it was not run on. §18 is why the second model
 * is not optional, and both are stated in the write-up rather than left implied.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  mergeFriction,
  renderFriction,
  runTask,
  splitFriction,
  wastedCallRatio,
  type TaskMetrics,
} from '../runners/run.ts';
import { closeAttachedServers, mcpUtilityTasks, type Arm } from './mcp-utility-fixtures.ts';
import { MCP_TOOL_PREFIX } from '../../src/mcp/naming.ts';

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

/** Attempts in which the model reached for a tool the kernel did not write. */
function usedForeignTool(attempt: TaskMetrics): boolean {
  return Object.entries(attempt.toolFriction).some(
    ([name, f]) => name.startsWith(MCP_TOOL_PREFIX) && f.calls > 0,
  );
}

function summarise(cell: Cell) {
  const n = cell.attempts.length;
  const friction = mergeFriction(cell.attempts.map((a) => a.toolFriction));
  const { builtin, foreign } = splitFriction(friction);

  return {
    baseId: cell.baseId,
    arm: cell.arm,
    n,
    solved: cell.attempts.filter((a) => a.passed).length,
    usedForeignTool: cell.attempts.filter(usedForeignTool).length,
    // The headline. Rejections of the *kernel's own* tools, which is where
    // alpha.7's finding says the cost of a bigger catalogue actually lands.
    builtinWasted: wastedCallRatio(builtin),
    foreignWasted: wastedCallRatio(foreign),
    totalWasted: wastedCallRatio(friction),
    builtinCalls: Object.values(builtin).reduce((t, f) => t + f.calls, 0),
    foreignCalls: Object.values(foreign).reduce((t, f) => t + f.calls, 0),
    toolFriction: friction,
  };
}

async function main(): Promise<void> {
  // `runTask` reads KERNEL_LIVE_MODEL itself; `--scripted` is the explicit way
  // to say "I meant to run the fake", so a forgotten env var fails loudly rather
  // than producing a fake-model measurement that looks like a real one.
  const scripted = process.argv.includes('--scripted');
  const model = process.env.KERNEL_LIVE_MODEL;
  if (!scripted && !model) {
    process.stderr.write('mcp-utility: set KERNEL_LIVE_MODEL=<alias> for a live run, or pass --scripted.\n');
    process.exit(2);
  }

  const tasks = mcpUtilityTasks();
  const cells = new Map<string, Cell>();

  try {
    for (let run = 1; run <= (scripted ? 1 : RUNS); run += 1) {
      for (const task of tasks) {
        const key = `${task.baseId}:${task.arm}`;
        const cell = cells.get(key) ?? { baseId: task.baseId, arm: task.arm, attempts: [] };
        cells.set(key, cell);

        process.stderr.write(`run ${run}: ${task.id}\n`);
        cell.attempts.push(await runTask(task, `r${run}`));
      }
    }
  } finally {
    // A stdio server attached in `prepare` outlives the kernel that used it, and
    // an orphan holds the event loop open. See the note in the fixtures.
    await closeAttachedServers();
  }

  const summaries = [...cells.values()].map(summarise);
  const attached = summaries.filter((s) => s.arm === 'server-attached');
  const absent = summaries.filter((s) => s.arm === 'server-absent');

  const total = (rows: typeof summaries, k: 'solved' | 'n' | 'usedForeignTool') =>
    rows.reduce((t, r) => t + r[k], 0);

  const report = {
    experiment: 'mcp-utility',
    question:
      'Does attaching an MCP server make the model better, worse, or merely busier — and does it ' +
      "make the kernel's own tools harder to call?",
    model: model ?? 'fake (scripted)',
    runs: scripted ? 1 : RUNS,
    generatedAt: new Date().toISOString(),
    perCell: summaries,
    arms: {
      'server-attached': {
        solved: `${total(attached, 'solved')}/${total(attached, 'n')}`,
        attemptsUsingAForeignTool: total(attached, 'usedForeignTool'),
        builtinWasted: wastedCallRatio(
          splitFriction(mergeFriction(attached.flatMap((s) => [s.toolFriction]))).builtin,
        ),
      },
      'server-absent': {
        solved: `${total(absent, 'solved')}/${total(absent, 'n')}`,
        attemptsUsingAForeignTool: total(absent, 'usedForeignTool'),
        builtinWasted: wastedCallRatio(
          splitFriction(mergeFriction(absent.flatMap((s) => [s.toolFriction]))).builtin,
        ),
      },
    },
    friction: renderFriction(mergeFriction(summaries.map((s) => s.toolFriction))),
  };

  const dir = path.join(process.cwd(), 'evals', 'results', 'experiments');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `mcp-utility-${model ?? 'scripted'}-${report.runs}x-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(report.arms, null, 2)}\n`);
  process.stdout.write(`\nwritten: ${path.relative(process.cwd(), file)}\n`);

  // Never non-zero on a behavioural outcome. This is a measurement; the only
  // failure it can report is a broken harness, and that throws.
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
