/**
 * Tool contract (spec §9.1).
 *
 * Definition and execution are separate on purpose:
 *
 *   resolve(args, ctx) -> ToolExecution { accesses, approvalSubject, display }
 *                            ↓  policy engine rules on `accesses`
 *   execution.execute(executor, signal) -> ToolResult
 *
 * `resolve()` may read metadata (stat, canonicalise, count matches) but must not
 * perform the effect. `execute()` receives an executor already narrowed to what
 * was granted, and is forbidden from prompting for permission, reading a global
 * API key, or reaching the network by any route other than the executor.
 *
 * The practical payoff: the approval prompt can describe *semantics* — "install
 * a package from registry.npmjs.org, touching package.json and the lockfile" —
 * instead of echoing a command string back at the user (spec §11.4).
 */

import type { ErrorCode } from '../util/errors.ts';
import type { JsonSchema } from '../util/jsonschema.ts';
import type { Logger } from '../util/logger.ts';
import type { CanonicalPath } from '../util/paths.ts';
import type { SessionId, StepId, ToolCallId, TurnId } from '../util/ids.ts';
import type { AccessRequest } from '../policy/access.ts';
import type { CapabilityExecutor, EnvironmentDescriptor } from '../execution/backend.ts';
import type { SecretBroker } from '../security/secret-broker.ts';
import type { Redactor } from '../security/redactor.ts';
import type { FreshnessLedger } from '../context/freshness.ts';

/** How eagerly a tool's schema is sent to the model (spec §9.3). */
export type ToolDisclosure = 'eager' | 'deferred' | 'discoverable';

export interface ToolResolveContext {
  sessionId: SessionId;
  turnId: TurnId;
  stepId: StepId;
  toolCallId: ToolCallId;
  workspaceRoot: CanonicalPath;
  environment: EnvironmentDescriptor;
  /** Resolve an untrusted, model-supplied path string. Always use this. */
  canonicalize(input: string): Promise<{ path: CanonicalPath; existed: boolean }>;
  /** Workspace-relative rendering for prompts and results. */
  display(p: CanonicalPath): string;
  freshness: FreshnessLedger;
  secrets: SecretBroker;
  redactor: Redactor;
  logger: Logger;
  now(): number;
  signal: AbortSignal;
}

export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * What a session-scoped approval is remembered against, plus everything the
 * prompt needs to be meaningful.
 */
export interface ApprovalSubject {
  /** Stable identity. Two calls with the same key share one approval. */
  key: string;
  title: string;
  /** Bullet points: target, expected file impact, network destination. */
  details: string[];
  risk: RiskLevel;
}

export interface HumanReviewDisplay {
  title: string;
  summary: string;
  /** Full detail, shown on request. */
  body?: string;
  /** Unified diff, for edits. */
  diff?: string;
}

export interface ToolResult {
  /** Text the model receives. Already truncated and redacted. */
  content: string;
  isError: boolean;
  /** Machine-readable companion to `content`. */
  structured?: unknown;
  errorCode?: ErrorCode;
  /** Recorded in the event log, never sent to the model verbatim. */
  metadata?: Record<string, unknown>;
  /** Reference to spilled full output (spec invariant 9). */
  artifactRef?: string;
  /** Full untruncated output, for the artifact writer. Not sent to the model. */
  fullOutput?: string;
}

export interface ToolExecution {
  accesses: AccessRequest[];
  approvalSubject: ApprovalSubject;
  display: HumanReviewDisplay;
  execute(executor: CapabilityExecutor, signal: AbortSignal): Promise<ToolResult>;
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  disclosure: ToolDisclosure;
  /** True for tools with no side effects; used to allow parallel execution. */
  readOnly: boolean;
  resolve(args: TArgs, ctx: ToolResolveContext): Promise<ToolExecution>;
}

/** Convenience for building an ok result. */
export function okResult(content: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { content, isError: false, ...extra };
}

/** Convenience for building an error result the model can act on. */
export function errorResult(code: ErrorCode, message: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { content: `error: ${code}\n${message}`, isError: true, errorCode: code, ...extra };
}

/**
 * An execution that does nothing.
 *
 * Used when `resolve()` already knows the call cannot proceed — a stale receipt,
 * a malformed path — but must still return an execution so the call produces a
 * result and the tool-call closure invariant holds.
 */
export function refusedExecution(
  subject: ApprovalSubject,
  display: HumanReviewDisplay,
  result: ToolResult,
): ToolExecution {
  return {
    accesses: [],
    approvalSubject: subject,
    display,
    execute: async () => result,
  };
}
