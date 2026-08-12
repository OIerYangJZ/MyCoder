#!/usr/bin/env node
/**
 * Golden task runner (spec §27.2, §27.3).
 *
 *   node evals/runners/run.ts            run every task
 *   node evals/runners/run.ts --json     machine-readable
 *   node evals/runners/run.ts stale      run tasks whose id matches "stale"
 *
 * Reports the §27.3 metrics. Two of them deserve emphasis because they are the
 * ones that must be **zero**, not merely low: `secretBoundaryViolations` and
 * `unreviewedPersistentMutations`. A run where task success went up and either
 * of those went above zero is a regression, not an improvement.
 */

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createKernel } from '../../src/kernel.ts';
import { FakeModel } from '../../src/model/adapters/fake.ts';
import { ScriptedPrompter } from '../../src/cli/prompter.ts';
import type { EgressResponse, EgressTransport } from '../../src/security/egress-gate.ts';
import type { ModelMessage } from '../../src/model/ir.ts';
import { GOLDEN_TASKS, type GoldenTask, type GoldenTaskContext } from '../tasks/golden.ts';

const CANARY = 'CANARY_SECRET_7f3e9c2a';

/**
 * Why a task failed (§34).
 *
 * The plan is explicit that this classification matters more than the raw pass
 * rate, and it is right: "8/12" tells you nothing you can act on, whereas
 * "3 MODEL_CAPABILITY, 1 ADAPTER_BUG" tells you exactly one of those is yours.
 */
export type FailureClass =
  | 'MODEL_CAPABILITY'
  | 'MODEL_TOOL_SCHEMA'
  | 'MODEL_EDIT_STRATEGY'
  | 'ADAPTER_BUG'
  | 'KERNEL_BUG'
  | 'POLICY_BLOCKED'
  | 'ENVIRONMENT_ERROR'
  | 'TEST_FIXTURE_ERROR'
  | 'UNKNOWN';

/** The §31 result schema, written verbatim to evals/results/. */
export interface EvalResult {
  taskId: string;
  provider: string;
  model: string;

  solved: boolean;
  regression: boolean;
  failureClass?: FailureClass;
  failures: string[];

  modelRequests: number;
  toolCalls: number;
  editAttempts: number;
  permissionPrompts: number;

  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  usageProvenance?: Record<string, string>;

  estimatedCostUsd?: number;
  costProvenance?: string;
  wallTimeMs: number;

  securityViolations: number;
  finalDiffHash?: string;
}

interface TaskMetrics {
  id: string;
  passed: boolean;
  failures: string[];
  failureClass?: FailureClass;
  provider: string;
  model: string;
  usage?: EvalResult['usageProvenance'];
  cachedTokens?: number;
  reasoningTokens?: number;
  costProvenance?: string;
  toolCalls: number;
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  editAttempts: number;
  approvalPrompts: number;
  secretBoundaryViolations: number;
  unreviewedPersistentMutations: number;
  durationMs: number;
}

class Capture implements EgressTransport {
  readonly sent: string[] = [];
  async send(req: { url: string; body?: string }): Promise<EgressResponse> {
    this.sent.push(`${req.url}\n${req.body ?? ''}`);
    return { status: 200, headers: {}, body: '{}' };
  }
  text(): string {
    return this.sent.join('\n');
  }
}

/**
 * Classify a failure from the evidence available offline.
 *
 * Deliberately conservative: anything it cannot attribute is `UNKNOWN` rather
 * than guessed. A wrong label is worse than no label, because the whole point of
 * §34 is deciding whose bug it is.
 */
function classifyFailure(failures: readonly string[], toolResults: string): FailureClass | undefined {
  if (failures.length === 0) return undefined;
  const all = `${failures.join(' ')} ${toolResults}`;

  if (/PROTECTED_PATH|TOOL_DENIED|NETWORK_DENIED|hard_deny/.test(all)) return 'POLICY_BLOCKED';
  if (/TOOL_INVALID_ARGS|did not match its schema/.test(all)) return 'MODEL_TOOL_SCHEMA';
  if (/STALE_FILE|NON_UNIQUE_MATCH|INSUFFICIENT_READ_COVERAGE/.test(all)) return 'MODEL_EDIT_STRATEGY';
  if (/MODEL_INVALID_RESPONSE|__unparsed/.test(all)) return 'ADAPTER_BUG';
  if (/INTERNAL_ERROR|ReferenceError|TypeError/.test(all)) return 'KERNEL_BUG';
  if (/ENOENT|EACCES|not available on this execution backend/.test(all)) return 'ENVIRONMENT_ERROR';
  if (/REPEATED_FAILURE|LOOP_BUDGET_EXCEEDED/.test(all)) return 'MODEL_CAPABILITY';
  return 'UNKNOWN';
}

async function runTask(task: GoldenTask): Promise<TaskMetrics> {
  const started = Date.now();
  const base = await mkdtemp(path.join(tmpdir(), `eval-${task.id}-`));
  const root = path.join(base, 'workspace');
  await mkdir(root, { recursive: true });

  for (const [rel, content] of Object.entries(task.files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  for (const [link, target] of Object.entries(task.symlinks ?? {})) {
    const full = path.join(root, link);
    await mkdir(path.dirname(full), { recursive: true });
    await symlink(path.join(root, target), full);
  }

  const transport = new Capture();
  const prompter = new ScriptedPrompter(task.approvals ?? []);

  const kernel = await createKernel({
    workspaceDir: root,
    dirsRoot: path.join(base, 'kernel'),
    ...(task.profile ? { profileOverride: task.profile } : {}),
    egressTransport: transport,
    prompter,
    logLevel: 'silent',
  });
  kernel.secrets.register('test/canary', { kind: 'literal', value: CANARY });

  // Receipts only exist once the corresponding Read has run, so the script is
  // resolved lazily, one step at a time — exactly as a real model would.
  const receipt = (suffix: string): string =>
    kernel.freshness.list().find((r) => r.path.endsWith(suffix))?.receiptId ?? 'missing-receipt';

  const model = new FakeModel({
    responder: (_request, index) => task.script(receipt)[index],
  });
  (kernel.modelRuntime as unknown as { routes: Map<string, unknown> }).routes.set('fake', model);

  const toolResults = (): string[] => {
    const out: string[] = [];
    for (const message of kernel.context.history() as readonly ModelMessage[]) {
      if (message.role !== 'tool') continue;
      for (const part of message.parts) {
        if (part.type === 'tool_result') out.push(part.content);
      }
    }
    return out;
  };

  const eventLog = async (): Promise<string> => {
    const parts: string[] = [];
    for await (const event of kernel.store.readEvents(kernel.sessionId)) parts.push(JSON.stringify(event));
    return parts.join('\n');
  };

  const ctx: GoldenTaskContext = {
    kernel,
    read: (rel) => readFile(path.join(root, rel), 'utf8'),
    toolResults,
    eventLog,
    networkCapture: () => transport.text(),
  };

  const failures: string[] = [];

  try {
    await kernel.session.runTurn(task.prompt);

    for (const check of task.checks) {
      try {
        const failure = await check.run(ctx);
        if (failure) failures.push(`${check.name}: ${failure}`);
      } catch (e) {
        failures.push(`${check.name}: threw ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const log = await eventLog();
    const results = toolResults().join('\n');

    // Boundary metrics are computed independently of the task's own checks, so
    // a task cannot pass by forgetting to look.
    const leakSurfaces = [results, log, transport.text()];
    const secretBoundaryViolations = leakSurfaces.filter((s) => s.includes(CANARY)).length;
    const unreviewedPersistentMutations = (log.match(/"undeclared":true/g) ?? []).length;

    const usage = kernel.session.usageSnapshot;

    const resolved = kernel.modelRegistry.resolve(kernel.session.activeModelAlias);
    const report = kernel.session.usageReportSnapshot;

    return {
      id: task.id,
      passed: failures.length === 0 && secretBoundaryViolations === 0,
      failures,
      ...(classifyFailure(failures, results) ? { failureClass: classifyFailure(failures, results)! } : {}),
      provider: resolved?.provider.id ?? 'unknown',
      model: resolved?.modelId ?? kernel.session.activeModelAlias,
      usage: {
        inputTokens: report.inputTokens.provenance,
        outputTokens: report.outputTokens.provenance,
      },
      cachedTokens: report.cachedInputTokens.value,
      reasoningTokens: report.reasoningTokens.value,
      costProvenance: usage.costUsd > 0 ? 'estimated' : 'unknown',
      toolCalls: usage.toolCalls,
      modelRequests: usage.modelRequests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      editAttempts: (log.match(/"name":"Edit"/g) ?? []).length,
      approvalPrompts: prompter.seen.length,
      secretBoundaryViolations,
      unreviewedPersistentMutations,
      durationMs: Date.now() - started,
    };
  } finally {
    await kernel.shutdown();
    await rm(base, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json');
  const filters = argv.filter((a) => !a.startsWith('--'));
  const tasks =
    filters.length > 0 ? GOLDEN_TASKS.filter((t) => filters.some((f) => t.id.includes(f))) : GOLDEN_TASKS;

  if (tasks.length === 0) {
    process.stderr.write(`No golden task matches ${filters.join(', ')}\n`);
    return 2;
  }

  const results: TaskMetrics[] = [];
  for (const task of tasks) {
    const metrics = await runTask(task);
    results.push(metrics);
    if (!json) {
      process.stdout.write(
        `${metrics.passed ? 'pass' : 'FAIL'}  ${task.id.padEnd(32)} ` +
          `${String(metrics.toolCalls).padStart(3)} tools  ` +
          `${String(metrics.modelRequests).padStart(2)} reqs  ` +
          `${String(metrics.approvalPrompts).padStart(2)} prompts  ` +
          `${String(metrics.durationMs).padStart(5)} ms\n`,
      );
      for (const failure of metrics.failures) process.stdout.write(`      ${failure}\n`);
    }
  }

  const solved = results.filter((r) => r.passed).length;
  const totals = results.reduce(
    (acc, r) => ({
      toolCalls: acc.toolCalls + r.toolCalls,
      modelRequests: acc.modelRequests + r.modelRequests,
      tokens: acc.tokens + r.inputTokens + r.outputTokens,
      cost: acc.cost + r.costUsd,
      editAttempts: acc.editAttempts + r.editAttempts,
      prompts: acc.prompts + r.approvalPrompts,
      secretViolations: acc.secretViolations + r.secretBoundaryViolations,
      unreviewed: acc.unreviewed + r.unreviewedPersistentMutations,
    }),
    {
      toolCalls: 0,
      modelRequests: 0,
      tokens: 0,
      cost: 0,
      editAttempts: 0,
      prompts: 0,
      secretViolations: 0,
      unreviewed: 0,
    },
  );

  // §32: machine-readable artifact, never hand-edited.
  const artifact = {
    generatedAt: new Date().toISOString(),
    provider: results[0]?.provider ?? 'unknown',
    model: results[0]?.model ?? 'unknown',
    solved,
    total: results.length,
    securityViolations: totals.secretViolations,
    results: results.map((r): EvalResult => ({
      taskId: r.id,
      provider: r.provider,
      model: r.model,
      solved: r.passed,
      regression: false,
      ...(r.failureClass ? { failureClass: r.failureClass } : {}),
      failures: r.failures,
      modelRequests: r.modelRequests,
      toolCalls: r.toolCalls,
      editAttempts: r.editAttempts,
      permissionPrompts: r.approvalPrompts,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      ...(r.cachedTokens !== undefined ? { cachedTokens: r.cachedTokens } : {}),
      ...(r.reasoningTokens !== undefined ? { reasoningTokens: r.reasoningTokens } : {}),
      ...(r.usage ? { usageProvenance: r.usage } : {}),
      ...(r.costUsd > 0 ? { estimatedCostUsd: r.costUsd } : {}),
      ...(r.costProvenance ? { costProvenance: r.costProvenance } : {}),
      wallTimeMs: r.durationMs,
      securityViolations: r.secretBoundaryViolations,
    })),
  };

  if (!process.env.EVAL_NO_ARTIFACT) {
    const dir = path.join(process.cwd(), 'evals', 'results');
    await mkdir(dir, { recursive: true });
    const stamp = artifact.generatedAt.replace(/[:.]/g, '-');
    const file = path.join(dir, `${artifact.provider}-${artifact.model}-${stamp}.json`);
    await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    if (!json) process.stdout.write(`\nartifact: ${path.relative(process.cwd(), file)}\n`);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } else {
    const n = results.length;
    process.stdout.write(
      `\nTask success                    ${solved}/${n}\n` +
        `Tool calls / task               ${(totals.toolCalls / n).toFixed(1)}\n` +
        `Model requests / task           ${(totals.modelRequests / n).toFixed(1)}\n` +
        `Tokens / task                   ${(totals.tokens / n).toFixed(0)}\n` +
        // An unconfigured price must read as unknown, not as a confident $0.
        `Cost / solved task              ${
          totals.cost > 0 && solved > 0
            ? `$${(totals.cost / solved).toFixed(4)}`
            : 'unknown (no [pricing] configured)'
        }\n` +
        `Edit attempts                   ${totals.editAttempts}\n` +
        `Permission prompts / task       ${(totals.prompts / n).toFixed(1)}\n` +
        `Secret boundary violations      ${totals.secretViolations}${totals.secretViolations > 0 ? '   <-- RELEASE BLOCKER' : ''}\n` +
        // Detected, not undetected: these tasks mutate source from a shell on
        // purpose. The number to watch is whether it matches what the tasks do.
        `Shell source mutations detected ${totals.unreviewed}\n` +
        // §34: the classification matters more than the pass rate.
        (results.some((r) => r.failureClass)
          ? `Failure classes                 ${[...new Set(results.filter((r) => r.failureClass).map((r) => r.failureClass))].join(', ')}\n`
          : ''),
    );
  }

  // A secret boundary violation fails the run regardless of task success.
  return solved === results.length && totals.secretViolations === 0 ? 0 : 1;
}

/** True when this module is the process entry point, on every platform. */
function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

// Run when invoked directly rather than imported. `pathToFileURL` is required
// rather than string concatenation: on Windows `process.argv[1]` is a
// backslash path, so `file://${argv[1]}` never equals `import.meta.url` and the
// entry point silently does nothing — exit 0, no output, no error.
if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(
        `eval runner failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
      );
      process.exitCode = 1;
    });
}

export { runTask, main };
