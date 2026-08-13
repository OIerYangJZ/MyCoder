/**
 * Tool Runtime.
 *
 * Executes the tool calls a model produced, enforcing the whole chain for each:
 *
 *   lookup → validate args → resolve → policy → approval → secret leases
 *          → sandbox plan → constrained execute → redact → result
 *
 * Two properties are non-negotiable:
 *
 *  - **Every call produces a result** (invariant 1). Unknown tool, malformed
 *    arguments, denial, timeout, crash, cancellation — each has a result path.
 *    There is no branch where a call disappears.
 *  - **Execution is sequential.** Parallel read-only tools would be faster, but
 *    ordering is what makes a session replayable, and a deterministic log is
 *    worth more than a few hundred milliseconds at this stage.
 */

import { renderErrorForModel, toKernelError, type KernelError } from '../util/errors.ts';
import { formatIssues, validate } from '../util/jsonschema.ts';
import type { Logger } from '../util/logger.ts';
import type { CanonicalPath } from '../util/paths.ts';
import { canonicalize, displayPath } from '../util/paths.ts';
import type { ToolCallPart, ToolResultPart } from '../model/ir.ts';
import { describeAccess } from '../policy/access.ts';
import { PolicyEngine, decisionToError, type PolicyDecision } from '../policy/policy-engine.ts';
import type { ExecutionBackend } from '../execution/backend.ts';
import { SandboxPlanner } from '../execution/sandbox.ts';
import type { SecretBroker, SecretLease } from '../security/secret-broker.ts';
import type { Redactor } from '../security/redactor.ts';
import type { FreshnessLedger } from '../context/freshness.ts';
import { FailureTracker } from '../session/step.ts';
import type { StepContext } from '../session/step.ts';
import type { ToolRegistry } from './registry.ts';
import type { ApprovalSubject, ToolExecution, ToolResolveContext, ToolResult } from './contract.ts';

export interface ApprovalRequest {
  subject: ApprovalSubject;
  toolName: string;
  toolCallId: string;
  /** Every access that needs approval, already described in plain language. */
  pending: readonly PolicyDecision[];
  /** Unified diff when the tool is an Edit. */
  diff?: string;
}

export type ApprovalOutcome =
  | { decision: 'allow'; scope: 'once' | 'session' }
  | { decision: 'deny'; scope: 'once' | 'session'; reason?: string };

export interface ApprovalPrompter {
  request(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

/** Prompter used in non-interactive contexts: every `ask` becomes a denial. */
export class DenyAllPrompter implements ApprovalPrompter {
  private readonly reason: string;

  constructor(reason = 'Approval is required, but this session is non-interactive.') {
    this.reason = reason;
  }

  async request(): Promise<ApprovalOutcome> {
    return { decision: 'deny', scope: 'once', reason: this.reason };
  }
}

export interface ToolExecutionRecord {
  toolCallId: string;
  name: string;
  turnId: string;
  stepId: string;
  isError: boolean;
  durationMs: number;
  contentBytes: number;
  truncated: boolean;
  errorCode?: string;
  artifactRef?: string;
  decisions: PolicyDecision[];
  metadata?: Record<string, unknown>;
}

export interface ToolRuntimeOptions {
  registry: ToolRegistry;
  policy: PolicyEngine;
  backend: ExecutionBackend;
  secrets: SecretBroker;
  redactor: Redactor;
  freshness: FreshnessLedger;
  prompter: ApprovalPrompter;
  logger: Logger;
  workspaceRoot: CanonicalPath;
  agentTmpDir?: CanonicalPath;
  failures: FailureTracker;
  now(): number;
  /** Per-tool wall clock ceiling. */
  toolTimeoutMs?: number;
  /** Spill oversized output and return a reference. */
  writeArtifact?: (name: string, content: string) => Promise<string>;
  /**
   * Lifecycle hook invocation (spec §18.1).
   *
   * Passed as a callback rather than a `HookRunner` so the tool runtime stays
   * unaware of the extension system: it knows *when* a lifecycle point is
   * reached, not what runs there. A hook that fails or is denied must never
   * fail the tool call, so the callback returns nothing actionable.
   */
  runHooks?: (
    event: 'PreToolUse' | 'PostToolUse' | 'PermissionRequest',
    ctx: { toolName: string; path?: string },
  ) => Promise<void>;
  onRecord?: (record: ToolExecutionRecord) => void;
  onPolicyDecision?: (decision: PolicyDecision, toolCallId: string) => void;
  onApproval?: (subjectKey: string, granted: boolean, scope: 'once' | 'session', summary: string) => void;
}

export interface BatchOutcome {
  results: ToolResultPart[];
  /** Set when the doom-loop guard decided the turn must stop. */
  terminalFailure?: KernelError;
}

export class ToolRuntime {
  private readonly opts: ToolRuntimeOptions;

  constructor(opts: ToolRuntimeOptions) {
    this.opts = opts;
  }

  /**
   * Run a batch of tool calls, in order.
   *
   * Cancellation stops *starting* further calls; calls already begun are aborted
   * through their signal, and every remaining call still receives a synthetic
   * cancelled result so the exchange closes.
   */
  async executeBatch(
    calls: readonly ToolCallPart[],
    step: StepContext,
    signal: AbortSignal,
  ): Promise<BatchOutcome> {
    const results: ToolResultPart[] = [];
    let terminalFailure: KernelError | undefined;

    for (const call of calls) {
      if (signal.aborted) {
        results.push({
          type: 'tool_result',
          toolCallId: call.id,
          content: 'error: CANCELLED\nThe turn was cancelled before this tool call ran.',
          isError: true,
        });
        continue;
      }

      const started = this.opts.now();

      // PreToolUse / PostToolUse bracket the call. They run whatever the outcome
      // was — a hook that only fires on success cannot be used for auditing.
      const hookPath = pathArgumentOf(call.arguments);
      await this.opts.runHooks?.('PreToolUse', {
        toolName: call.name,
        ...(hookPath ? { path: hookPath } : {}),
      });

      const { result, decisions } = await this.executeOne(call, step, signal);
      const durationMs = this.opts.now() - started;

      await this.opts.runHooks?.('PostToolUse', {
        toolName: call.name,
        ...(hookPath ? { path: hookPath } : {}),
      });

      // Doom-loop accounting.
      if (result.isError) {
        const fingerprint = FailureTracker.fingerprint(
          call.name,
          call.arguments,
          result.errorCode ?? 'TOOL_FAILED',
          result.content,
        );
        const count = this.opts.failures.record(fingerprint);

        if (this.opts.failures.isTerminal(fingerprint)) {
          terminalFailure = {
            code: 'REPEATED_FAILURE',
            message:
              `The same call to ${call.name} has failed identically ${count} times. ` +
              'Stopping this turn rather than repeating it again.',
            retryable: false,
            blame: 'model',
            safeDetails: { tool: call.name, occurrences: count },
          };
        } else if (this.opts.failures.isRepeating(fingerprint)) {
          // Feed the repetition back as a synthetic observation, so the model
          // has a chance to change approach before the turn is cut short.
          result.content +=
            `\n\n[This exact call has now failed ${count} times. Repeating it will end the turn. ` +
            'Change the approach: re-read the file, use different arguments, or explain what is blocking you.]';
        }
      }

      const contentBytes = Buffer.byteLength(result.content, 'utf8');
      let artifactRef = result.artifactRef;

      if (!artifactRef && result.fullOutput && this.opts.writeArtifact) {
        try {
          artifactRef = await this.opts.writeArtifact(`${call.name}-${call.id}.txt`, result.fullOutput);
          result.content += `\n\n[Full output saved as ${artifactRef}]`;
        } catch {
          // An artifact we could not write is not worth failing the call over.
        }
      }

      const record: ToolExecutionRecord = {
        toolCallId: call.id,
        name: call.name,
        turnId: step.turnId,
        stepId: step.stepId,
        isError: result.isError,
        durationMs,
        contentBytes,
        truncated: Boolean(result.fullOutput),
        decisions,
      };
      if (result.errorCode) record.errorCode = result.errorCode;
      if (artifactRef) record.artifactRef = artifactRef;
      if (result.metadata) record.metadata = result.metadata;
      this.opts.onRecord?.(record);

      const part: ToolResultPart = {
        type: 'tool_result',
        toolCallId: call.id,
        // Final redaction pass. Everything upstream should already be clean;
        // this is the last checkpoint before content enters the conversation.
        content: this.opts.redactor.redact(result.content),
        isError: result.isError,
      };
      if (result.structured !== undefined) part.structured = result.structured;
      results.push(part);

      if (terminalFailure) break;
    }

    // Any call not reached because the batch stopped early still needs a result.
    for (const call of calls) {
      if (results.some((r) => r.toolCallId === call.id)) continue;
      results.push({
        type: 'tool_result',
        toolCallId: call.id,
        content: 'error: CANCELLED\nThis tool call was not run because the turn stopped.',
        isError: true,
      });
    }

    return terminalFailure ? { results, terminalFailure } : { results };
  }

  private async executeOne(
    call: ToolCallPart,
    step: StepContext,
    signal: AbortSignal,
  ): Promise<{ result: ToolResult; decisions: PolicyDecision[] }> {
    const tool = this.opts.registry.get(call.name);
    if (!tool) {
      return {
        result: {
          content:
            `error: TOOL_NOT_FOUND\nThere is no tool named "${call.name}". ` +
            `Available tools: ${step.tools.tools.map((t) => t.name).join(', ')}.`,
          isError: true,
          errorCode: 'TOOL_NOT_FOUND',
        },
        decisions: [],
      };
    }

    // The catalogue frozen for this step is the authority on what the model was
    // allowed to call — not the registry, which may contain deferred tools.
    if (!step.tools.tools.some((t) => t.name === call.name)) {
      return {
        result: {
          content: `error: TOOL_NOT_FOUND\n"${call.name}" was not available in this step.`,
          isError: true,
          errorCode: 'TOOL_NOT_FOUND',
        },
        decisions: [],
      };
    }

    const validation = validate(tool.inputSchema, call.arguments);
    if (!validation.ok) {
      return {
        result: {
          content:
            `error: TOOL_INVALID_ARGS\nArguments for ${call.name} did not match its schema: ` +
            `${formatIssues(validation.issues)}.`,
          isError: true,
          errorCode: 'TOOL_INVALID_ARGS',
        },
        decisions: [],
      };
    }

    let execution: ToolExecution;
    try {
      execution = await tool.resolve(validation.value as never, this.buildResolveContext(call, step, signal));
    } catch (e) {
      const err = toKernelError(e);
      return {
        result: { content: renderErrorForModel(err), isError: true, errorCode: err.code },
        decisions: [],
      };
    }

    // ---- policy ---------------------------------------------------------
    const decisions = this.opts.policy.decideBatch(execution.accesses);
    for (const decision of decisions) this.opts.onPolicyDecision?.(decision, call.id);

    // Report the unappealable reason first when there is one: telling the model
    // "npm is not permitted here" when the real blocker is a hard-denied path
    // sends it off to find a workaround that cannot exist.
    const blocking = decisions
      .filter((d) => d.action === 'deny' || d.action === 'hard_deny')
      .sort((a, b) => Number(b.action === 'hard_deny') - Number(a.action === 'hard_deny'));

    if (blocking.length > 0) {
      const first = blocking[0]!;
      const err = decisionToError(first);
      const extra =
        blocking.length > 1
          ? `\nAlso blocked: ${blocking
              .slice(1)
              .map((d) => describeAccess(d.access))
              .join('; ')}.`
          : '';
      return {
        result: { content: renderErrorForModel(err) + extra, isError: true, errorCode: err.code },
        decisions,
      };
    }

    // ---- approval -------------------------------------------------------
    const asking = decisions.filter((d) => d.action === 'ask');
    if (asking.length > 0) {
      const request: ApprovalRequest = {
        subject: execution.approvalSubject,
        toolName: call.name,
        toolCallId: call.id,
        pending: asking,
      };
      if (execution.display.diff) request.diff = execution.display.diff;

      await this.opts.runHooks?.('PermissionRequest', { toolName: call.name });

      const outcome = await this.opts.prompter.request(request);
      const summary = execution.approvalSubject.title;

      if (outcome.scope === 'session') {
        this.opts.policy.approvals.record(
          execution.approvalSubject.key,
          outcome.decision === 'allow',
          summary,
          this.opts.now(),
        );
      }
      this.opts.onApproval?.(
        execution.approvalSubject.key,
        outcome.decision === 'allow',
        outcome.scope,
        summary,
      );

      if (outcome.decision === 'deny') {
        return {
          result: {
            content:
              `error: TOOL_DENIED\nThe user declined: ${summary}.` +
              (outcome.reason ? `\nReason: ${outcome.reason}` : '') +
              '\nDo not retry this. Choose a different approach, or ask the user what they would prefer.',
            isError: true,
            errorCode: 'TOOL_DENIED',
          },
          decisions,
        };
      }

      // Approved: upgrade those decisions so the sandbox planner grants them.
      for (const decision of asking) decision.action = 'allow';
    }

    // ---- secret leases --------------------------------------------------
    const leases: Array<{ envName: string; lease: SecretLease }> = [];
    try {
      for (const decision of decisions) {
        if (decision.action !== 'allow' || decision.access.kind !== 'secret.use') continue;
        const envName = envNameFor(decision.access.display, decision.access.secretRef);
        const lease = await this.opts.secrets.resolve(decision.access.secretRef, 'subprocess.env');
        leases.push({ envName, lease });
      }
    } catch (e) {
      for (const l of leases) l.lease.release();
      const err = toKernelError(e);
      return {
        result: { content: renderErrorForModel(err), isError: true, errorCode: err.code },
        decisions,
      };
    }

    // ---- sandbox plan and execute ---------------------------------------
    const planner = new SandboxPlanner({
      workspaceRoot: this.opts.workspaceRoot,
      ...(this.opts.agentTmpDir ? { agentTmpDir: this.opts.agentTmpDir } : {}),
      timeoutMs: this.opts.toolTimeoutMs ?? 120_000,
      secretInjections: leases,
    });
    const plan = planner.plan(decisions);

    const executor = await this.opts.backend.enforce(plan.profile);
    try {
      const result = await execution.execute(executor, signal);
      return { result, decisions };
    } catch (e) {
      const err = toKernelError(e);
      this.opts.logger.debug('tool execution failed', { tool: call.name, code: err.code });
      return {
        result: { content: renderErrorForModel(err), isError: true, errorCode: err.code },
        decisions,
      };
    } finally {
      // Disposing releases every lease, which also removes the secret from the
      // redactor's active set.
      executor.dispose();
    }
  }

  private buildResolveContext(
    call: ToolCallPart,
    step: StepContext,
    signal: AbortSignal,
  ): ToolResolveContext {
    const workspaceRoot = this.opts.workspaceRoot;
    return {
      sessionId: step.sessionId,
      turnId: step.turnId,
      stepId: step.stepId,
      toolCallId: call.id,
      workspaceRoot,
      environment: this.opts.backend.environment,
      /**
       * Canonicalise a tool path — against the filesystem the tools actually
       * run on (ADR-0012).
       *
       * The local filesystem is the wrong oracle for a remote backend, and not
       * subtly wrong. macOS resolves `/home` through autofs, so a perfectly
       * ordinary remote path came back as
       * `/System/Volumes/Data/home/…/probe.txt` — and `/System/**` is
       * hard-denied, so *every* remote file operation was refused as a
       * protected system location. Only `Shell` worked, because it never asks
       * for a canonical path.
       *
       * So: local backend resolves locally; a remote backend resolves lexically
       * here and then asks the *backend* to resolve symlinks and report
       * existence. Symlink resolution still happens — it has to, or a remote
       * `src/x.txt -> ../../.ssh/id_ed25519` would escape the jail — it just
       * happens on the machine that owns the symlinks.
       */
      canonicalize: async (input: string) => {
        if (this.opts.backend.kind === 'local') {
          const resolved = await canonicalize(input, { cwd: workspaceRoot });
          return { path: resolved.path, existed: resolved.existed };
        }

        const lexical = await canonicalize(input, { cwd: workspaceRoot, resolveSymlinks: false });
        const real = (await this.opts.backend.fs.realpath(lexical.path)) ?? lexical.path;
        const stat = await this.opts.backend.fs.stat(real);
        return { path: real, existed: stat !== undefined };
      },
      display: (p: CanonicalPath) => displayPath(workspaceRoot, p),
      freshness: this.opts.freshness,
      secrets: this.opts.secrets,
      redactor: this.opts.redactor,
      logger: this.opts.logger,
      now: this.opts.now,
      signal,
    };
  }
}

/**
 * The `{path}` substitution a PostToolUse hook expects.
 *
 * Read from the model's arguments rather than from the resolved access, because
 * a hook fires even when resolution failed and there is no access to read.
 */
function pathArgumentOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === 'string' && path !== '' ? path : undefined;
}

/** Recover the requested env slot from the access's display string. */
function envNameFor(display: string, ref: string): string {
  const match = /\$([A-Za-z_][A-Za-z0-9_]*)/.exec(display);
  if (match) return match[1]!;
  return ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Build a synthetic result for a tool call that was interrupted.
 *
 * Used by resume (spec §21.3, step 6) and by cancellation, so an unanswered call
 * from a previous process never reaches the model as a dangling exchange.
 */
export function syntheticInterruptedResult(toolCallId: string, reason: string): ToolResultPart {
  return {
    type: 'tool_result',
    // Callers hold the id as a plain string — it comes back from the event log
    // on resume, where branding has been erased by serialisation.
    toolCallId: toolCallId as ToolResultPart['toolCallId'],
    content:
      `error: CANCELLED\n${reason}\n` +
      'The outcome of this call is unknown. Verify the current state before assuming it did or did not take effect.',
    isError: true,
  };
}
