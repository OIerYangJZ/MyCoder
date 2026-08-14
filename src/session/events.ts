/**
 * Kernel event log (spec §21.2).
 *
 * The event log is the source of truth for replay, audit and resume. Two rules
 * make it trustworthy:
 *
 *   - **Append only.** Events are never rewritten or deleted. Compaction adds a
 *     boundary event; it does not edit history (spec §20.3).
 *   - **No secrets, ever.** Payloads are redacted on the way in, and the event
 *     types below are deliberately shaped to hold references and hashes rather
 *     than content: `model.request` carries a payload hash and byte count, not
 *     the prompt; `file.read` carries a receipt, not the file.
 */

import type { EventId, SessionId, StepId, ToolCallId, TurnId } from '../util/ids.ts';

export type KernelEventType =
  // session lifecycle
  | 'session.started'
  | 'session.resumed'
  | 'session.ended'
  // turn / step lifecycle
  | 'turn.started'
  | 'turn.state_changed'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'step.started'
  | 'step.context_frozen'
  | 'step.completed'
  // model
  | 'model.request.started'
  | 'model.request.completed'
  | 'model.request.failed'
  | 'model.error'
  // tools
  | 'tool.call'
  | 'tool.result'
  | 'tool.denied'
  | 'tool.error'
  | 'tool.synthetic_result'
  // policy / approvals
  | 'policy.decision'
  | 'approval.requested'
  | 'approval.decided'
  // filesystem
  | 'file.read'
  | 'file.edited'
  | 'workspace.mutation'
  // execution
  | 'shell.executed'
  // security
  | 'egress.audit'
  | 'secret.denied'
  | 'secret.redacted'
  // context
  | 'compaction.boundary'
  | 'context.pressure'
  // control plane
  | 'control.command'
  | 'goal.changed'
  | 'budget.exceeded'
  // extensions
  | 'skill.loaded'
  | 'skill.activated'
  | 'skill.deactivated'
  | 'agent.started'
  | 'agent.finished'
  // delegation (alpha.4 §9)
  | 'delegation.requested'
  | 'delegation.started'
  | 'delegation.completed'
  | 'delegation.failed'
  | 'delegation.cancelled'
  | 'delegation.denied'
  | 'hook.executed'
  // catch-all
  | 'error';

export interface KernelEvent<P = unknown> {
  eventId: EventId;
  /** Monotonic within a session, starting at 1. Gaps mean corruption. */
  seq: number;
  ts: number;
  sessionId: SessionId;
  turnId?: TurnId;
  stepId?: StepId;
  /**
   * Set on every event produced *inside* a delegated child scope (alpha.4 §9).
   *
   * One event log per root session, with the child's work tagged rather than
   * split into a second file. Two things depend on that choice. Replay can
   * reconstruct the whole tree from one ordered stream, which is what makes
   * "live == replay" checkable across a delegation boundary at all. And the
   * parent's own conversation stays reconstructible, because the replayer knows
   * which `tool.call` events were the child's and must not be folded into the
   * parent's message list — without this field a child's tool calls appeared as
   * the parent's, which is both a wrong transcript and a wrong terminal state.
   */
  delegationId?: string;
  type: KernelEventType;
  payload: P;
}

// --- payload shapes -------------------------------------------------------
// These are the events replay actually depends on. Everything else may carry a
// loosely-typed payload; the log is deliberately tolerant of unknown types so an
// older kernel can still read a newer log's session skeleton.

export interface SessionStartedPayload {
  workspaceRoot: string;
  workspaceIdentity: string;
  model: string;
  permissionProfile: string;
  backend: string;
  sandboxStrength: 'policy-enforced' | 'os-isolated';
  kernelVersion: string;
}

export interface TurnStartedPayload {
  /** Redacted user input. Stored so a resumed session can show what was asked. */
  input: string;
  origin: 'user' | 'control' | 'loop' | 'delegation';
  /** Set for a delegated child turn, so replay can attribute it. */
  agent?: string;
}

export interface TurnStateChangedPayload {
  from: string;
  to: string;
  reason?: string;
}

export interface ModelRequestPayload {
  requestId: string;
  provider: string;
  model: string;
  messageCount: number;
  toolCount: number;
  /** Hash + size only. The prompt itself is never written (spec §21.2). */
  payloadHash: string;
  payloadBytes: number;
}

export interface ModelResponsePayload {
  requestId: string;
  finishReason: string;
  rawFinishReason?: string;
  toolCallCount: number;
  textLength: number;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  /** Whether each token count was reported by the provider or estimated (§17). */
  usageProvenance?: { inputTokens: string; outputTokens: string };
  /** Absent when no pricing is configured — never a fabricated figure (§18). */
  costUsd?: number;
  costProvenance?: string;
}

export interface ToolCallPayload {
  toolCallId: ToolCallId;
  name: string;
  /** Arguments with secrets redacted and long values elided. */
  argsSummary: string;
  argsHash: string;
}

export interface ToolResultPayload {
  toolCallId: ToolCallId;
  name: string;
  isError: boolean;
  durationMs: number;
  contentBytes: number;
  truncated: boolean;
  errorCode?: string;
  /** Set when full output was spilled to `artifacts/`. */
  artifactRef?: string;
}

export interface PolicyDecisionPayload {
  toolCallId?: ToolCallId;
  capability: string;
  subject: string;
  action: 'allow' | 'ask' | 'deny' | 'hard_deny';
  reason: string;
  layer?: string;
}

export interface ApprovalDecidedPayload {
  subject: string;
  granted: boolean;
  scope: 'once' | 'session';
  summary: string;
}

export interface FileReadPayload {
  receiptId: string;
  /** Workspace-relative where possible. */
  path: string;
  contentHash: string;
  coverage: { kind: 'full' } | { kind: 'lines'; start: number; end: number };
  bytes: number;
  redactions: number;
}

export interface FileEditedPayload {
  path: string;
  toolCallId: ToolCallId;
  modelRequestId?: string;
  oldHash: string;
  newHash: string;
  /** Unified diff, redacted. Kept so an edit can be reviewed or rolled back. */
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  eol: 'lf' | 'crlf';
  created: boolean;
}

export interface WorkspaceMutationPayload {
  detectedBy: 'shell';
  toolCallId?: ToolCallId;
  changed: Array<{ path: string; kind: 'added' | 'modified' | 'deleted'; classification: string }>;
  undeclared: boolean;
}

export interface ShellExecutedPayload {
  toolCallId: ToolCallId;
  executable: string;
  argvHash: string;
  argvSummary: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  networkRequested: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  droppedEnvCount: number;
}

export interface EgressAuditPayload {
  kind: string;
  host: string;
  method: string;
  pathClass: string;
  requestBytes: number;
  bodyHash?: string;
  status?: number;
  durationMs?: number;
  outcome: 'sent' | 'blocked' | 'error';
  blockedReason?: string;
}

export interface SecretDeniedPayload {
  channel: 'file.read' | 'egress' | 'env' | 'shell.output';
  /** Never the value; never the full path if it is outside the workspace. */
  displayPath?: string;
  rule?: string;
  reason: string;
}

export interface CompactionBoundaryPayload {
  level: 'L0' | 'L1' | 'L2' | 'L3';
  droppedMessages: number;
  summaryLength: number;
  tokensBefore: number;
  tokensAfter: number;
  preservedExchanges: number;
}

export interface ControlCommandPayload {
  command: string;
  args: string[];
  ok: boolean;
  message: string;
}

export interface BudgetExceededPayload {
  budget: string;
  limit: number;
  observed: number;
}

/**
 * Delegation lifecycle payloads (alpha.4 §8, §9).
 *
 * `delegation.requested` records what was *asked for*, before any narrowing;
 * `delegation.started` records what was actually granted. Keeping them apart is
 * what makes the intersection auditable after the fact: the pair says "the model
 * asked for 12 steps and a workspace-dev child, and got 4 steps and read-only",
 * which a single merged event could not express.
 */
export interface DelegationRequestedPayload {
  delegationId: string;
  agent: string;
  depth: number;
  /** The delegating tool call, so parent and child are joinable. */
  toolCallId?: string;
  /** Redacted, truncated task text. */
  task: string;
  taskHash: string;
  requested: {
    maxSteps?: number;
    maxToolCalls?: number;
    maxModelRequests?: number;
    maxWallTimeMs?: number;
    maxCostUsd?: number;
  };
  contextRefs?: string[];
}

export interface DelegationStartedPayload {
  delegationId: string;
  childRunId: string;
  agent: string;
  depth: number;
  /** Alias the child resolved to, after model policy. */
  model: string;
  /** The effective tool catalogue, already intersected with the parent's. */
  allowedTools: string[];
  /** Policy layer names, broadest to narrowest. */
  policyLayers: string[];
  /** Skills the agent definition activated. */
  skills: string[];
  granted: {
    maxSteps: number;
    maxToolCalls: number;
    maxModelRequests: number;
    maxWallTimeMs: number;
    maxCostUsd?: number;
  };
  /** Notes about anything the definition asked for and did not get. */
  notes: string[];
}

export interface DelegationFinishedPayload {
  delegationId: string;
  childRunId: string;
  agent: string;
  depth: number;
  status: 'completed' | 'failed' | 'cancelled' | 'budget_exceeded' | 'denied';
  /** Length only for the summary; the text travels in the tool result. */
  summaryLength: number;
  usage: {
    modelRequests: number;
    toolCalls: number;
    wallTimeMs: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    estimatedCostUsd?: number;
  };
  errorCode?: string;
}

export interface SkillActivatedPayload {
  skill: string;
  scope: 'run' | 'turn';
  /** Where the activation came from; never the model asserting a permission. */
  source: 'control' | 'model' | 'agent';
  /** Effective catalogue after intersection. */
  allowedTools: string[];
  /** Present when the skill named a permission profile. */
  policyLayer?: string;
  maxSteps?: number;
  notes: string[];
}

/** Turn-level view of an event, used when rebuilding conversation state. */
export function isTurnScoped(event: KernelEvent): boolean {
  return event.turnId !== undefined;
}

/** Events replay must process to rebuild conversation state. */
export const REPLAY_EVENT_TYPES: ReadonlySet<KernelEventType> = new Set<KernelEventType>([
  'session.started',
  'delegation.requested',
  'delegation.started',
  'delegation.completed',
  'delegation.failed',
  'delegation.cancelled',
  'delegation.denied',
  'skill.activated',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'model.request.completed',
  'tool.call',
  'tool.result',
  'tool.synthetic_result',
  'file.read',
  'file.edited',
  'compaction.boundary',
  'goal.changed',
]);
