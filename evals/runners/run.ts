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

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createKernel, KERNEL_VERSION } from '../../src/kernel.ts';
import { FakeModel } from '../../src/model/adapters/fake.ts';
import { ScriptedPrompter } from '../../src/cli/prompter.ts';
import { resolveKernelDirs } from '../../src/util/platform.ts';
import { fetchTransport, type EgressResponse, type EgressTransport } from '../../src/security/egress-gate.ts';
import type { ModelMessage } from '../../src/model/ir.ts';
import { GOLDEN_TASKS, type EvalFamily, type GoldenTask, type GoldenTaskContext } from '../tasks/golden.ts';
import { startWebFixture } from '../tasks/web-fixture.ts';

const CANARY = 'CANARY_SECRET_7f3e9c2a';

/**
 * Live mode (§29): drive the tasks with a **real** model instead of the scripted
 * FakeModel.
 *
 * The scripted mode tests the kernel — given this exact sequence of tool calls,
 * do freshness, policy and the ledger behave? It cannot tell you whether a real
 * model can *produce* that sequence, which is the entire question §29 asks. The
 * task definitions need no change: the checks are already written against
 * outcomes (file contents, tool results, leak surfaces), not against the script.
 *
 *   KERNEL_LIVE_MODEL=deepseek node evals/runners/run.ts
 */
const LIVE_ALIAS = process.env.KERNEL_LIVE_MODEL;
const LIVE = Boolean(LIVE_ALIAS);

/**
 * How many times each task runs (§26).
 *
 * Live defaults to 5 because a single live score is not a measurement: the same
 * configuration produced 10/10, 8/10 and 10/10 across three alpha.2 runs with no
 * kernel change in between. §26 permits dropping to 3 when cost bites, but the
 * sample size has to be recorded either way — it is written into the artifact.
 *
 * Scripted runs default to 1. The fake provider is deterministic and there is a
 * separate ×100 determinism gate; repeating it here would spend time proving
 * something already proven.
 */
const RUNS = (() => {
  const flag = process.argv.find((a) => a.startsWith('--runs='));
  const parsed = flag ? Number.parseInt(flag.slice('--runs='.length), 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return LIVE ? 5 : 1;
})();

/**
 * Why a task failed (§34).
 *
 * The plan is explicit that this classification matters more than the raw pass
 * rate, and it is right: "8/12" tells you nothing you can act on, whereas
 * "3 MODEL_CAPABILITY, 1 ADAPTER_BUG" tells you exactly one of those is yours.
 */
export type FailureClass =
  // The model simply did not perform a needed step, while the runtime behaved
  // correctly throughout (§25). This is the class alpha.2 was missing, and its
  // absence is why a model that forgot to re-run the tests was indistinguishable
  // from a kernel that lost the tool result.
  | 'MODEL_ACTION_OMISSION'
  // The model acted, but did the wrong thing — a different edit, a different
  // file. Distinguished from omission because the remedies differ: omission is
  // usually a prompt or an autonomy-profile problem, wrong action is usually a
  // capability one.
  | 'MODEL_WRONG_ACTION'
  | 'MODEL_CAPABILITY'
  | 'MODEL_TOOL_SCHEMA'
  | 'MODEL_EDIT_STRATEGY'
  // alpha.4 §35. The delegation classes exist because "the task failed" hides
  // three different problems that need three different responses: the model
  // delegated something unsuitable, the model delegated when it should have done
  // the work, or the delegation runtime misbehaved. Only the third is ours.
  | 'MODEL_BAD_DELEGATION'
  | 'MODEL_UNNECESSARY_DELEGATION'
  | 'DELEGATION_RUNTIME_BUG'
  | 'SKILL_RUNTIME_BUG'
  | 'ADAPTER_BUG'
  | 'KERNEL_BUG'
  | 'POLICY_BLOCKED'
  | 'BUDGET_BLOCKED'
  | 'ENVIRONMENT_ERROR'
  | 'TEST_FIXTURE_ERROR'
  | 'UNKNOWN';

/**
 * Failure classes that mean *the kernel* was wrong (§28).
 *
 * Everything else leaves Kernel Correctness at PASS, which is the whole point:
 * a model's off run must not read as a runtime regression.
 */
const KERNEL_FAULTS: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'KERNEL_BUG',
  'ADAPTER_BUG',
  'TEST_FIXTURE_ERROR',
  // A delegation or skill runtime bug is a kernel fault by definition: the model
  // asked for something the plan says must work.
  'DELEGATION_RUNTIME_BUG',
  'SKILL_RUNTIME_BUG',
]);

/** The alpha.3 §29 attempt schema, written verbatim to evals/results/. */
export interface EvalResult {
  taskId: string;
  /** Which scoreboard this belongs to (§24). Never summed across families. */
  family: EvalFamily;
  /** Distinguishes the repeats of one task within a run set (§26). */
  runId: string;
  provider: string;
  model: string;

  solved: boolean;
  /**
   * True when the runtime did its job, whatever the model did (§28).
   *
   * `solved` and `kernelCorrect` are reported separately because they answer
   * different questions, and collapsing them is exactly how alpha.2's 8/10 was
   * unreadable: three of those points were the model forgetting a step.
   */
  kernelCorrect: boolean;
  /** No secret reached an unauthorised sink during this attempt. */
  securityPreserved: boolean;
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

  /** Delegation metrics (alpha.4 §36). Absent fields mean "no delegation". */
  delegations?: number;
  childSuccesses?: number;
  childModelRequests?: number;
  childToolCalls?: number;
  delegationLatencyMs?: number;
  delegatedCostUsd?: number;
  parentDirectCostUsd?: number;
  capabilityDenials?: number;
  delegationFailureStatuses?: string[];

  /** §B: per-tool friction for this attempt. */
  toolFriction?: Record<string, ToolFriction>;
  wastedCallRatio?: number;

  /** §31: what would be needed to reproduce or to compare across models. */
  fixtureVersion: number;
  promptHash: string;
  kernelVersion: string;
  kernelCommit?: string;
}

export interface TaskMetrics {
  id: string;
  family: EvalFamily;
  runId: string;
  passed: boolean;
  /** §28: the runtime behaved, whatever the model did. */
  kernelCorrect: boolean;
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
  fixtureVersion: number;
  promptHash: string;
  /** §33: which delegation scoreboard, when the task belongs to one. */
  delegationSuite?: string;
  /** §36. */
  delegations: number;
  childSuccesses: number;
  childModelRequests: number;
  childToolCalls: number;
  delegationLatencyMs: number;
  delegatedCostUsd: number;
  parentDirectCostUsd: number;
  capabilityDenials: number;
  delegationFailureStatuses: string[];
  /** §B: per-tool calls, rejections and repeats, read from the event log. */
  toolFriction: Record<string, ToolFriction>;
}

/**
 * Records every outbound payload *and* performs it.
 *
 * Live mode still has to answer "did the canary reach the network?", so the leak
 * surface must be captured on the real path rather than by replacing it.
 */
class RecordingPassthrough implements EgressTransport {
  readonly sent: string[] = [];
  async send(req: Parameters<EgressTransport['send']>[0]): Promise<EgressResponse> {
    this.sent.push(`${req.url}\n${req.body ?? ''}`);
    return fetchTransport.send(req);
  }
  /** Every byte sent, model traffic included — the surface a canary must not reach. */
  text(): string {
    return this.sent.join('\n');
  }
  /**
   * Bytes sent by *tools*.
   *
   * "Did anything leave the process?" means something different once the model
   * itself is on the network: in live mode the provider request is expected
   * traffic, and counting it would fail every network-denial task for a reason
   * that has nothing to do with the denial.
   */
  toolText(providerBaseUrl?: string): string {
    const rest = providerBaseUrl
      ? this.sent.filter((entry) => !entry.startsWith(providerBaseUrl))
      : this.sent;
    return rest.join('\n');
  }
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
 * Remove fetched web content before anything reads tool results as evidence.
 *
 * A real defect found by the §B web task, not a hypothetical one: the fixture
 * page documents a `TypeError`, the classifier looks for `TypeError` as a sign of
 * a kernel fault, and a perfectly healthy run was reported as `KERNEL_BUG`. Once
 * a tool can pull third-party text into the transcript, any heuristic over the
 * transcript is reading attacker-chosen input — a page containing
 * "INTERNAL_ERROR" could make a release run claim a runtime regression.
 *
 * The boundary `WebFetch` prints for the *model's* benefit turns out to be the
 * thing that makes this fixable, which is an argument for machine-recognisable
 * markers rather than prose.
 */
export function stripUntrustedContent(text: string): string {
  return text.replace(
    /--- begin untrusted web content ---[\s\S]*?--- end untrusted web content ---/g,
    '[fetched content omitted]',
  );
}

/**
 * Classify a failure from the evidence available offline.
 *
 * Deliberately conservative: anything it cannot attribute is `UNKNOWN` rather
 * than guessed. A wrong label is worse than no label, because the whole point of
 * §34 is deciding whose bug it is.
 */
export function classifyFailure(
  failures: readonly string[],
  toolResults: string,
  evidence: {
    turnState?: string;
    originalFiles: Record<string, string>;
    /** Delegation outcomes, for the §35 delegation classes. */
    delegations?: ReadonlyArray<{ status: string; modelRequests: number; toolCalls: number }>;
    /** True when the task's own checks say the delegation should not have happened. */
    delegationSuite?: string;
  },
): FailureClass | undefined {
  if (failures.length === 0) return undefined;
  const all = `${failures.join(' ')} ${stripUntrustedContent(toolResults)}`;

  // --- delegation and skill classes first (§35) --------------------------
  //
  // Ordered ahead of the generic ones because a delegation failure surfaces
  // *through* a generic symptom — a denied write, a budget stop — and attributing
  // it to the symptom loses the only fact that decides whose bug it is.
  if (/DELEGATION_DEPTH_EXCEEDED/.test(all)) return 'MODEL_BAD_DELEGATION';
  if (/no delegation was dispatched|the child executed no tool|the child made no model request/.test(all)) {
    return 'DELEGATION_RUNTIME_BUG';
  }
  if (/a child report was injected as user text|a read-only child modified/.test(all)) {
    return 'DELEGATION_RUNTIME_BUG';
  }
  if (/skill/i.test(all) && /widen|not narrowed|still available/i.test(all)) return 'SKILL_RUNTIME_BUG';

  const delegations = evidence.delegations ?? [];
  if (delegations.length > 0) {
    // A refused delegation and an unaffordable one are different problems. The
    // model chose to dispatch something the policy or the depth limit refused —
    // its judgement. Running out of allowance is the *configuration* speaking, and
    // §35 gives it its own class so a session that was simply too small to finish
    // does not read as a model that cannot delegate.
    //
    // Note what this class deliberately does not cover: a plain
    // LOOP_BUDGET_EXCEEDED on the parent's own loop stays MODEL_CAPABILITY, which
    // is the distinction alpha.3 §25 drew and is still right — a model that spent
    // sixteen steps without finishing has a capability problem, not a budget one.
    if (delegations.some((d) => d.status === 'budget_exceeded')) return 'BUDGET_BLOCKED';
    if (delegations.some((d) => d.status === 'denied')) return 'MODEL_BAD_DELEGATION';
    if (
      evidence.delegationSuite === undefined &&
      delegations.every((d) => d.toolCalls === 0) &&
      /has the expected contents/.test(all)
    ) {
      return 'MODEL_UNNECESSARY_DELEGATION';
    }
  }

  if (/PROTECTED_PATH|TOOL_DENIED|NETWORK_DENIED|hard_deny/.test(all)) return 'POLICY_BLOCKED';
  if (/TOOL_INVALID_ARGS|did not match its schema/.test(all)) return 'MODEL_TOOL_SCHEMA';
  if (/STALE_FILE|NON_UNIQUE_MATCH|INSUFFICIENT_READ_COVERAGE/.test(all)) return 'MODEL_EDIT_STRATEGY';
  // Before the adapter/runtime branches: an account with no credit, a rejected key
  // or a rate limit is the *environment* being broken. It used to reach
  // `ADAPTER_BUG` — a kernel fault — so an unpaid provider bill made a live run
  // read as a runtime regression.
  if (/MODEL_AUTH_ERROR|billing reasons|insufficient[_ ](quota|balance)|MODEL_RATE_LIMIT/.test(all)) {
    return 'ENVIRONMENT_ERROR';
  }
  if (/MODEL_INVALID_RESPONSE|__unparsed/.test(all)) return 'ADAPTER_BUG';
  if (/INTERNAL_ERROR|ReferenceError|TypeError/.test(all)) return 'KERNEL_BUG';
  if (/ENOENT|EACCES|not available on this execution backend/.test(all)) return 'ENVIRONMENT_ERROR';
  if (/REPEATED_FAILURE|LOOP_BUDGET_EXCEEDED/.test(all)) return 'MODEL_CAPABILITY';

  // Omission vs wrong action (§25).
  //
  // Both look like "a check failed", and both are the model's doing rather than
  // the kernel's — but they are different problems, so they are separated by
  // *evidence* rather than by guessing. The turn has to have ended cleanly: a
  // model that crashed or ran out of budget is a different story, and those
  // cases are already classified above.
  //
  // The discriminator is whether the target file still holds what the fixture
  // put there. Untouched means the model never acted; changed-but-wrong means
  // it acted and got it wrong.
  if (evidence.turnState === 'completed') {
    const contentFailures = failures.filter((f) => f.includes('has the expected contents'));
    if (contentFailures.length > 0) {
      const untouched = contentFailures.some((f) => {
        const got = /got (".*")$/.exec(f)?.[1];
        if (got === undefined) return false;
        try {
          return Object.values(evidence.originalFiles).includes(JSON.parse(got) as string);
        } catch {
          return false;
        }
      });
      return untouched ? 'MODEL_ACTION_OMISSION' : 'MODEL_WRONG_ACTION';
    }
    // A clean turn that simply did not produce the required observable effect —
    // the missing `grep` re-run, the unreported mutation — is the canonical
    // omission the plan describes.
    return 'MODEL_ACTION_OMISSION';
  }

  return 'UNKNOWN';
}

// --- §26/§27: distributions rather than a single score ----------------------

/**
 * Median, not mean.
 *
 * One pathological attempt — a retry storm, a provider hiccup — moves a mean
 * enough to make the whole column misleading. §27 asks for medians with a range
 * beside them for exactly that reason: the range is where the outlier shows up,
 * instead of being smeared across the central number.
 */
/**
 * What one tool cost the model, beyond being called (§B).
 *
 * The distinction the tool surface has never been able to make: `toolCalls: 14`
 * says nothing about whether those were fourteen useful calls or seven useful
 * ones and seven rejections. `errors` and `codes` say which, and `repeats` says
 * whether the model understood the rejection — an identical call issued twice is
 * a message the model could not act on.
 */
export interface ToolFriction {
  calls: number;
  errors: number;
  /** Calls with an identical tool + argument hash issued more than once. */
  repeats: number;
  /** Error code histogram, e.g. `{ STALE_FILE: 2, TOOL_INVALID_ARGS: 1 }`. */
  codes: Record<string, number>;
}

/**
 * Per-tool friction, read from the event log.
 *
 * Derived rather than counted during the run on purpose: the log is what a
 * dogfood, a release run and a replay all have in common, so a metric computed
 * from it can be recomputed later for a session nobody instrumented in advance.
 */
export function toolFrictionFromLog(log: string): Record<string, ToolFriction> {
  const byTool: Record<string, ToolFriction> = {};
  const seenCalls = new Map<string, number>();
  const nameByCallId = new Map<string, string>();

  const get = (name: string): ToolFriction => {
    byTool[name] ??= { calls: 0, errors: 0, repeats: 0, codes: {} };
    return byTool[name]!;
  };

  for (const line of log.split('\n')) {
    if (line.trim() === '') continue;
    let event: { type?: string; payload?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    const payload = event.payload ?? {};

    if (event.type === 'tool.call' && typeof payload.name === 'string') {
      const entry = get(payload.name);
      entry.calls += 1;
      if (typeof payload.toolCallId === 'string') nameByCallId.set(payload.toolCallId, payload.name);

      // Identity is the tool plus its arguments, which is exactly what the
      // doom-loop guard fingerprints — a repeat here is the same behaviour, seen
      // before it becomes terminal.
      if (typeof payload.argsHash === 'string') {
        const key = `${payload.name}:${payload.argsHash}`;
        const count = (seenCalls.get(key) ?? 0) + 1;
        seenCalls.set(key, count);
        if (count > 1) entry.repeats += 1;
      }
      continue;
    }

    if (event.type === 'tool.error') {
      const name =
        typeof payload.name === 'string'
          ? payload.name
          : (nameByCallId.get(String(payload.toolCallId)) ?? 'unknown');
      const entry = get(name);
      entry.errors += 1;
      const code = typeof payload.errorCode === 'string' ? payload.errorCode : 'UNKNOWN';
      entry.codes[code] = (entry.codes[code] ?? 0) + 1;
    }
  }

  return byTool;
}

/** Merge per-attempt friction into one table. */
export function mergeFriction(
  tables: ReadonlyArray<Record<string, ToolFriction>>,
): Record<string, ToolFriction> {
  const out: Record<string, ToolFriction> = {};
  for (const table of tables) {
    for (const [name, friction] of Object.entries(table)) {
      const entry = (out[name] ??= { calls: 0, errors: 0, repeats: 0, codes: {} });
      entry.calls += friction.calls;
      entry.errors += friction.errors;
      entry.repeats += friction.repeats;
      for (const [code, n] of Object.entries(friction.codes)) {
        entry.codes[code] = (entry.codes[code] ?? 0) + n;
      }
    }
  }
  return out;
}

/**
 * The one-number version: what fraction of tool calls were rejected.
 *
 * Reported alongside the solve rate rather than instead of it. A harness can buy
 * a lower ratio by making tools permissive, which is why this number is only
 * meaningful next to "was the task solved" and "did anything unreviewed change".
 */
export function wastedCallRatio(table: Record<string, ToolFriction>): number {
  const calls = Object.values(table).reduce((n, f) => n + f.calls, 0);
  const errors = Object.values(table).reduce((n, f) => n + f.errors, 0);
  return calls === 0 ? 0 : errors / calls;
}

/** `Edit 12 calls · 3 err (STALE_FILE 2, TOOL_INVALID_ARGS 1) · 1 repeat` */
export function renderFriction(table: Record<string, ToolFriction>): string[] {
  return Object.entries(table)
    .sort((a, b) => b[1].errors - a[1].errors || b[1].calls - a[1].calls)
    .map(([name, f]) => {
      const codes = Object.entries(f.codes)
        .sort((a, b) => b[1] - a[1])
        .map(([code, n]) => `${code} ${n}`)
        .join(', ');
      return (
        `${name.padEnd(12)}${String(f.calls).padStart(4)} calls  ${String(f.errors).padStart(3)} err  ` +
        `${String(f.repeats).padStart(2)} repeat  ${codes}`
      );
    });
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface Distribution {
  median: number;
  min: number;
  max: number;
}

export function distribution(values: readonly number[]): Distribution {
  return { median: median(values), min: Math.min(...values, 0), max: Math.max(...values, 0) };
}

export interface FamilySummary {
  attempts: number;
  solved: number;
  kernelCorrect: number;
  securityViolations: number;
}

/** The §24 scoreboards, computed separately and never added together. */
export function summariseFamilies(results: readonly TaskMetrics[]): Record<EvalFamily, FamilySummary> {
  const one = (family: EvalFamily): FamilySummary => {
    const rows = results.filter((r) => r.family === family);
    return {
      attempts: rows.length,
      solved: rows.filter((r) => r.passed).length,
      // §28: reported on its own, because it is the number that should stay at
      // 100% even when task success moves around.
      kernelCorrect: rows.filter((r) => r.kernelCorrect).length,
      securityViolations: rows.reduce((n, r) => n + r.secretBoundaryViolations, 0),
    };
  };
  return { 'kernel-invariant': one('kernel-invariant'), 'model-capability': one('model-capability') };
}

/** Per-task distributions across the repeats (§27). */
export function summarisePerTask(results: readonly TaskMetrics[]) {
  const byTask = new Map<string, TaskMetrics[]>();
  for (const r of results) byTask.set(r.id, [...(byTask.get(r.id) ?? []), r]);

  return [...byTask].map(([taskId, rows]) => ({
    taskId,
    family: rows[0]!.family,
    attempts: rows.length,
    solved: rows.filter((r) => r.passed).length,
    successRate: rows.filter((r) => r.passed).length / rows.length,
    kernelCorrect: rows.filter((r) => r.kernelCorrect).length,
    securityViolations: rows.reduce((n, r) => n + r.secretBoundaryViolations, 0),
    modelActionOmissions: rows.filter((r) => r.failureClass === 'MODEL_ACTION_OMISSION').length,
    modelWrongActions: rows.filter((r) => r.failureClass === 'MODEL_WRONG_ACTION').length,
    modelRequests: distribution(rows.map((r) => r.modelRequests)),
    toolCalls: distribution(rows.map((r) => r.toolCalls)),
    editAttempts: distribution(rows.map((r) => r.editAttempts)),
    permissionPrompts: distribution(rows.map((r) => r.approvalPrompts)),
    tokens: distribution(rows.map((r) => r.inputTokens + r.outputTokens)),
    costUsd: distribution(rows.map((r) => r.costUsd)),
    wallTimeMs: distribution(rows.map((r) => r.durationMs)),
  }));
}

/**
 * The two delegation scoreboards (§33), plus the §36 metrics.
 *
 * Reported separately and never summed, for the reason `DelegationSuite`
 * documents: one measures the runtime, the other measures the model. A task that
 * belongs to neither suite still contributes its delegation *metrics* — a model
 * that delegated during an ordinary task is exactly the behaviour §36 asks to
 * measure — but not to either scoreboard.
 */
export function summariseDelegation(results: readonly TaskMetrics[]): {
  suites: Record<string, { attempts: number; solved: number; kernelCorrect: number }>;
  metrics: {
    delegationsPerTask: number;
    childSuccessRate: number | undefined;
    childModelRequests: Distribution;
    childToolCalls: Distribution;
    delegationLatencyMs: Distribution;
    delegatedCostUsd: number;
    parentDirectCostUsd: number;
    totalCostUsd: number;
    capabilityDenials: number;
    failureStatuses: Record<string, number>;
  };
} {
  const suites: Record<string, { attempts: number; solved: number; kernelCorrect: number }> = {};
  for (const row of results) {
    if (!row.delegationSuite) continue;
    const bucket = (suites[row.delegationSuite] ??= { attempts: 0, solved: 0, kernelCorrect: 0 });
    bucket.attempts += 1;
    if (row.passed) bucket.solved += 1;
    if (row.kernelCorrect) bucket.kernelCorrect += 1;
  }

  const withDelegation = results.filter((r) => r.delegations > 0);
  const children = results.reduce((n, r) => n + r.delegations, 0);
  const successes = results.reduce((n, r) => n + r.childSuccesses, 0);

  const failureStatuses: Record<string, number> = {};
  for (const row of results) {
    for (const status of row.delegationFailureStatuses) {
      failureStatuses[status] = (failureStatuses[status] ?? 0) + 1;
    }
  }

  return {
    suites,
    metrics: {
      delegationsPerTask: results.length === 0 ? 0 : children / results.length,
      // Undefined rather than 1.0 when nothing was delegated: a rate over zero
      // attempts is not 100%, it is unmeasured.
      childSuccessRate: children === 0 ? undefined : successes / children,
      childModelRequests: distribution(withDelegation.map((r) => r.childModelRequests)),
      childToolCalls: distribution(withDelegation.map((r) => r.childToolCalls)),
      delegationLatencyMs: distribution(withDelegation.map((r) => r.delegationLatencyMs)),
      delegatedCostUsd: results.reduce((n, r) => n + r.delegatedCostUsd, 0),
      parentDirectCostUsd: results.reduce((n, r) => n + r.parentDirectCostUsd, 0),
      totalCostUsd: results.reduce((n, r) => n + r.costUsd, 0),
      capabilityDenials: results.reduce((n, r) => n + r.capabilityDenials, 0),
      failureStatuses,
    },
  };
}

export function countFailureClasses(results: readonly TaskMetrics[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    if (!r.failureClass) continue;
    out[r.failureClass] = (out[r.failureClass] ?? 0) + 1;
  }
  return out;
}

/** Stable identity for a prompt, so a reworded fixture is visibly different (§31). */
export function promptHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** The commit under test, when the runner is executed inside a git checkout. */
function kernelCommit(): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const out = r.stdout?.trim();
  return r.status === 0 && out ? out : undefined;
}

async function runTask(task: GoldenTask, runId = 'r1'): Promise<TaskMetrics> {
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

  const transport = LIVE ? new RecordingPassthrough() : new Capture();
  const prompter = new ScriptedPrompter(task.approvals ?? []);

  // A loopback fixture, for tasks that read a URL. The port is only known once
  // it is listening, so the prompt carries a placeholder rather than a URL.
  const web = task.webFixture ? await startWebFixture() : undefined;
  const substitute = (text: string): string => (web ? text.replaceAll('{{webBase}}', web.base) : text);

  // Live mode reads the *real* config directory, because that is the only place
  // a provider endpoint may be declared (a project config that could define one
  // would be a redirection vector). Data and cache stay in the temp tree so a
  // run never touches the developer's session store.
  const real = resolveKernelDirs();
  let dirs = LIVE
    ? {
        config: real.config,
        data: path.join(base, 'data'),
        cache: path.join(base, 'cache'),
        home: real.home,
      }
    : undefined;

  // A task that needs a *user* config setting gets its own config directory,
  // built from the one the run would have used. Live keeps the real file's
  // contents — the provider endpoint lives there and nowhere else — and appends;
  // scripted starts from nothing.
  if (task.configExtra) {
    const configDir = path.join(base, 'config');
    await mkdir(configDir, { recursive: true });
    // Live inherits the real config's text, with one rewrite: `api_key_file` is
    // resolved **relative to the config directory**, and this config directory is
    // not that one. Absolutising the path keeps the credential where it is, at
    // the permissions it has — copying the key into a temp tree to make a
    // relative path work would be trading an eval convenience for a second copy
    // of a secret, which is precisely the thing this kernel exists to refuse.
    const inherited = LIVE
      ? (await readFile(path.join(real.config, 'config.toml'), 'utf8').catch(() => '')).replace(
          /^(\s*api_key_file\s*=\s*)"([^"]+)"/gm,
          (line, prefix: string, value: string) =>
            path.isAbsolute(value) || value.startsWith('~')
              ? line
              : `${prefix}"${path.join(real.config, value)}"`,
        )
      : '';
    await writeFile(path.join(configDir, 'config.toml'), `${inherited}\n${task.configExtra}\n`, 'utf8');
    dirs = {
      config: configDir,
      data: path.join(base, 'data'),
      cache: path.join(base, 'cache'),
      home: LIVE ? real.home : path.join(base, 'home'),
    };
  }

  const kernel = await createKernel({
    workspaceDir: root,
    ...(dirs ? { dirs } : { dirsRoot: path.join(base, 'kernel') }),
    ...(task.profile ? { profileOverride: task.profile } : {}),
    ...(LIVE ? { modelOverride: LIVE_ALIAS! } : {}),
    egressTransport: transport,
    prompter,
    logLevel: 'silent',
  });
  kernel.secrets.register('test/canary', { kind: 'literal', value: CANARY });

  // Receipts only exist once the corresponding Read has run, so the script is
  // resolved lazily, one step at a time — exactly as a real model would.
  const receipt = (suffix: string): string =>
    kernel.freshness.list().find((r) => r.path.endsWith(suffix))?.receiptId ?? 'missing-receipt';

  // In live mode the model decides for itself; the script is exactly what we are
  // no longer supplying.
  if (!LIVE) {
    const model = new FakeModel({
      // A delegation task needs the *request* to decide, because parent and child
      // share one runtime and a flat index cannot tell them apart.
      responder: (request, index) => {
        const step = task.responder?.(request, index, receipt) ?? task.script(receipt)[index];
        // `{{webBase}}` appears in scripted tool arguments as well as in prompts:
        // the fixture's port is not known when the task is written.
        if (!step || !web) return step;
        return JSON.parse(substitute(JSON.stringify(step))) as typeof step;
      },
    });
    (kernel.modelRuntime as unknown as { routes: Map<string, unknown> }).routes.set('fake', model);
  } else {
    void receipt; // scripts are unused live
  }

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

  const providerBaseUrl = kernel.modelRegistry.resolve(kernel.session.activeModelAlias)?.provider.baseUrl;

  const ctx: GoldenTaskContext = {
    kernel,
    read: (rel) => readFile(path.join(root, rel), 'utf8'),
    toolResults,
    eventLog,
    networkCapture: () =>
      transport instanceof RecordingPassthrough ? transport.toolText(providerBaseUrl) : transport.text(),
  };

  const failures: string[] = [];

  try {
    // Harness-level variation, for experiments (see `GoldenTask.prepare`). Runs
    // after the kernel exists and before the turn, so an override lands in the
    // catalogue the first step is frozen against.
    await task.prepare?.(kernel);

    await kernel.session.runTurn(substitute(LIVE ? (task.livePrompt ?? task.prompt) : task.prompt));

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

    // §B: the friction table says *which* tool was rejected and with what code;
    // this prints the message the model actually read. Opt-in, because it is a
    // diagnostic for "why is this tool costing steps" rather than something a
    // release run should page through.
    if (process.env.EVAL_DUMP_ERRORS) {
      for (const text of toolResults()) {
        if (!text.startsWith('error:')) continue;
        process.stdout.write(`      ┌ ${task.id}/${runId}\n`);
        for (const line of text.split('\n').slice(0, 6)) process.stdout.write(`      │ ${line}\n`);
      }
    }

    // Boundary metrics are computed independently of the task's own checks, so
    // a task cannot pass by forgetting to look.
    const leakSurfaces = [results, log, transport.text()];
    const secretBoundaryViolations = leakSurfaces.filter((s) => s.includes(CANARY)).length;
    const unreviewedPersistentMutations = (log.match(/"undeclared":true/g) ?? []).length;

    const usage = kernel.session.usageSnapshot;

    // §36: delegation metrics, read from the session's own records rather than
    // parsed back out of the log.
    const records = kernel.session.delegationRecords();
    const cost = kernel.session.costBreakdown;
    const capabilityDenials = (log.match(/"type":"policy.decision"/g) ?? []).length;

    const resolved = kernel.modelRegistry.resolve(kernel.session.activeModelAlias);
    const report = kernel.session.usageReportSnapshot;

    // The *template*, before `{{webBase}}` becomes a port that changes every run.
    const effectivePrompt = LIVE ? (task.livePrompt ?? task.prompt) : task.prompt;
    const failureClass = classifyFailure(failures, results, {
      ...(kernel.session.turn?.state ? { turnState: kernel.session.turn.state } : {}),
      originalFiles: task.files,
      delegations: records.map((r) => ({
        status: r.status,
        modelRequests: r.usage.modelRequests,
        toolCalls: r.usage.toolCalls,
      })),
      ...(task.delegationSuite ? { delegationSuite: task.delegationSuite } : {}),
    });

    return {
      id: task.id,
      family: task.family,
      runId,
      passed: failures.length === 0 && secretBoundaryViolations === 0,
      // §28: a model omission leaves Kernel Correctness at PASS. A security
      // violation never does — that is a runtime failure by definition.
      kernelCorrect: secretBoundaryViolations === 0 && !(failureClass && KERNEL_FAULTS.has(failureClass)),
      failures,
      fixtureVersion: task.fixtureVersion,
      promptHash: promptHash(effectivePrompt),
      ...(failureClass ? { failureClass } : {}),
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
      ...(task.delegationSuite ? { delegationSuite: task.delegationSuite } : {}),
      delegations: records.length,
      childSuccesses: records.filter((r) => r.status === 'completed').length,
      childModelRequests: records.reduce((n, r) => n + r.usage.modelRequests, 0),
      childToolCalls: records.reduce((n, r) => n + r.usage.toolCalls, 0),
      delegationLatencyMs: records.reduce((n, r) => n + r.usage.wallTimeMs, 0),
      delegatedCostUsd: cost.delegatedUsd,
      parentDirectCostUsd: cost.directUsd,
      capabilityDenials,
      delegationFailureStatuses: records.filter((r) => r.status !== 'completed').map((r) => r.status),
      toolFriction: toolFrictionFromLog(log),
    };
  } finally {
    await kernel.shutdown();
    await rm(base, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json');
  const filters = argv.filter((a) => !a.startsWith('--'));
  const selected =
    filters.length > 0 ? GOLDEN_TASKS.filter((t) => filters.some((f) => t.id.includes(f))) : GOLDEN_TASKS;

  // Reported, never silently dropped: a run that quietly shrank its own task set
  // would read as a clean sheet.
  const skipped = LIVE ? selected.filter((t) => t.scriptedOnly) : [];
  const tasks = LIVE ? selected.filter((t) => !t.scriptedOnly) : selected;

  if (tasks.length === 0) {
    process.stderr.write(`No golden task matches ${filters.join(', ')}\n`);
    return 2;
  }

  const results: TaskMetrics[] = [];
  for (const task of tasks) {
    // Every repeat of a task is its own attempt, kept separately (§26). An
    // average computed here rather than reported as a distribution would hide
    // exactly the variance the plan exists to expose.
    for (let run = 1; run <= RUNS; run += 1) {
      results.push(await runTask(task, `r${run}`));
    }
  }

  for (const metrics of results) {
    const task = tasks.find((t) => t.id === metrics.id)!;
    if (!json) {
      process.stdout.write(
        `${metrics.passed ? 'pass' : 'FAIL'}  ${`${task.id}${RUNS > 1 ? `#${metrics.runId}` : ''}`.padEnd(36)} ` +
          `${String(metrics.toolCalls).padStart(3)} tools  ` +
          `${String(metrics.modelRequests).padStart(2)} reqs  ` +
          `${String(metrics.approvalPrompts).padStart(2)} prompts  ` +
          `${String(metrics.durationMs).padStart(5)} ms\n`,
      );
      for (const failure of metrics.failures) process.stdout.write(`      ${failure}\n`);
    }
  }

  if (!json && skipped.length > 0) {
    for (const task of skipped) {
      process.stdout.write(`skip  ${task.id.padEnd(32)} ${task.scriptedOnly}\n`);
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

  const commit = kernelCommit();

  // §32: machine-readable artifact, never hand-edited.
  const artifact = {
    generatedAt: new Date().toISOString(),
    provider: results[0]?.provider ?? 'unknown',
    model: results[0]?.model ?? 'unknown',
    mode: LIVE ? 'live' : 'scripted',
    // §26: the sample size is part of the result. A distribution over an
    // unrecorded N is not comparable to anything.
    runsPerTask: RUNS,
    solved,
    total: results.length,
    securityViolations: totals.secretViolations,
    /** §24: the two scoreboards, never added together. */
    families: summariseFamilies(results),
    /** §27: per-task distributions across the repeats. */
    perTask: summarisePerTask(results),
    /** alpha.4 §33 scoreboards and §36 metrics. */
    delegation: summariseDelegation(results),
    /**
     * §B: what the tools cost the model across the whole run.
     *
     * Reported next to the solve rate, never folded into it. A run can have a
     * perfect solve rate and a friction table full of `STALE_FILE`, and that is
     * a usable finding about the tools rather than a failure of the run.
     */
    toolFriction: mergeFriction(results.map((r) => r.toolFriction)),
    wastedCallRatio: wastedCallRatio(mergeFriction(results.map((r) => r.toolFriction))),
    failureClasses: countFailureClasses(results),
    results: results.map((r): EvalResult => ({
      taskId: r.id,
      family: r.family,
      runId: r.runId,
      provider: r.provider,
      model: r.model,
      solved: r.passed,
      kernelCorrect: r.kernelCorrect,
      securityPreserved: r.secretBoundaryViolations === 0,
      fixtureVersion: r.fixtureVersion,
      promptHash: r.promptHash,
      kernelVersion: KERNEL_VERSION,
      ...(commit ? { kernelCommit: commit } : {}),
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
      toolFriction: r.toolFriction,
      wastedCallRatio: wastedCallRatio(r.toolFriction),
      ...(r.delegations > 0
        ? {
            delegations: r.delegations,
            childSuccesses: r.childSuccesses,
            childModelRequests: r.childModelRequests,
            childToolCalls: r.childToolCalls,
            delegationLatencyMs: r.delegationLatencyMs,
            delegatedCostUsd: r.delegatedCostUsd,
            parentDirectCostUsd: r.parentDirectCostUsd,
            capabilityDenials: r.capabilityDenials,
            ...(r.delegationFailureStatuses.length > 0
              ? { delegationFailureStatuses: r.delegationFailureStatuses }
              : {}),
          }
        : {}),
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
    const fam = artifact.families;

    // §24: two scoreboards, printed apart. Adding them was how alpha.2 produced
    // a number that answered neither question.
    process.stdout.write(
      `\n── Kernel Invariants ${'─'.repeat(40)}\n` +
        `enforced                        ${fam['kernel-invariant'].solved}/${fam['kernel-invariant'].attempts}\n` +
        `kernel correct                  ${fam['kernel-invariant'].kernelCorrect}/${fam['kernel-invariant'].attempts}\n` +
        `\n── Model Capability (${LIVE ? `live, N=${RUNS}` : 'scripted'}) ${'─'.repeat(28)}\n` +
        `solved                          ${fam['model-capability'].solved}/${fam['model-capability'].attempts}\n` +
        // §28: this is the line that should stay at 100% even when the one
        // above moves. If it drops, the runtime regressed; if only `solved`
        // drops, the model had an off run.
        `kernel correct                  ${fam['model-capability'].kernelCorrect}/${fam['model-capability'].attempts}\n`,
    );

    if (RUNS > 1) {
      process.stdout.write(`\n── Per-task distribution (N=${RUNS}) ${'─'.repeat(30)}\n`);
      for (const t of artifact.perTask) {
        const reqs = t.modelRequests;
        process.stdout.write(
          `${t.taskId.padEnd(30)} ${t.solved}/${t.attempts} solved  ` +
            `reqs ${reqs.median} [${reqs.min}-${reqs.max}]  ` +
            `omissions ${t.modelActionOmissions}  wrong ${t.modelWrongActions}\n`,
        );
      }
    }

    // alpha.4 §33/§36: the delegation scoreboards, printed apart from each other
    // and apart from the two families above.
    const del = artifact.delegation;
    if (Object.keys(del.suites).length > 0 || del.metrics.delegationsPerTask > 0) {
      process.stdout.write(`\n── Delegation ${'─'.repeat(46)}\n`);
      for (const [suite, score] of Object.entries(del.suites)) {
        process.stdout.write(
          `${suite.padEnd(30)} ${score.solved}/${score.attempts} solved, ` +
            `${score.kernelCorrect}/${score.attempts} kernel correct\n`,
        );
      }
      const m = del.metrics;
      process.stdout.write(
        `delegations / task             ${m.delegationsPerTask.toFixed(2)}\n` +
          `child success rate             ${
            m.childSuccessRate === undefined
              ? 'unmeasured (none dispatched)'
              : `${Math.round(m.childSuccessRate * 100)}%`
          }\n` +
          `child model requests           ${m.childModelRequests.median} [${m.childModelRequests.min}-${m.childModelRequests.max}]\n` +
          `child tool calls               ${m.childToolCalls.median} [${m.childToolCalls.min}-${m.childToolCalls.max}]\n` +
          `delegation latency (ms)        ${m.delegationLatencyMs.median} [${m.delegationLatencyMs.min}-${m.delegationLatencyMs.max}]\n` +
          `cost: parent / delegated       ${
            m.totalCostUsd > 0
              ? `$${m.parentDirectCostUsd.toFixed(4)} / $${m.delegatedCostUsd.toFixed(4)}`
              : 'unknown (no [pricing] configured)'
          }\n` +
          `capability denials             ${m.capabilityDenials}\n` +
          (Object.keys(m.failureStatuses).length > 0
            ? `child failure statuses         ${Object.entries(m.failureStatuses)
                .map(([k, v]) => `${k}×${v}`)
                .join(', ')}\n`
            : ''),
      );
    }

    process.stdout.write(
      `\n── Totals ${'─'.repeat(50)}\n` +
        `Attempts                        ${n}` +
        (skipped.length > 0 ? ` (${skipped.length} scripted-only, skipped live)` : '') +
        '\n' +
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
        // §25/§34: the distribution of classes, not just which ones occurred.
        // "3 MODEL_ACTION_OMISSION" and "3 KERNEL_BUG" are the same length as a
        // set and mean opposite things.
        (Object.keys(artifact.failureClasses).length > 0
          ? `Failure classes                 ${Object.entries(artifact.failureClasses)
              .map(([k, v]) => `${k}×${v}`)
              .join(', ')}\n`
          : ''),
    );

    // §B: the tool surface's own scoreboard. Deliberately printed *after* the
    // totals and never folded into them — a rejected call is not a failed task,
    // and a solve rate that hid ten of them would be the tool-side version of
    // the single number §24 exists to prevent.
    const friction = artifact.toolFriction;
    if (Object.keys(friction).length > 0) {
      process.stdout.write(
        `\n── Tool friction ${'─'.repeat(43)}\n` +
          `${renderFriction(friction).join('\n')}\n` +
          `\nRejected calls                  ${(artifact.wastedCallRatio * 100).toFixed(1)}% of all tool calls\n` +
          (LIVE
            ? ''
            : 'NOTE: scripted mode. The trajectories are written to succeed, so a low ratio here\n' +
              '      measures the script, not the tools. Only a live run makes this number mean anything.\n'),
      );
    }
  }

  // What fails the run.
  //
  // A secret boundary violation always does, regardless of task success.
  //
  // Beyond that the two modes are gated differently, which is the practical
  // consequence of §28. Scripted runs are deterministic, so anything less than
  // a clean sheet is a real regression. Live runs are not: failing CI because a
  // model forgot to re-run a grep would make the gate meaningless within a
  // week, and people would stop reading it. So live gates on the two things
  // that are genuinely ours — the kernel behaved, and nothing leaked — and
  // reports the solve rate as a measurement rather than a verdict.
  if (totals.secretViolations > 0) return 1;
  if (LIVE) return results.every((r) => r.kernelCorrect) ? 0 : 1;
  return solved === results.length ? 0 : 1;
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

export { runTask, main, KERNEL_FAULTS, RUNS };
