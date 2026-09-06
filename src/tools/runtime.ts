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

import { renderErrorForModel, toKernelError, type ErrorCode, type KernelError } from '../util/errors.ts';
import { truncateForModel, type TruncationBudget } from '../util/text.ts';
import { formatIssues, validate } from '../util/jsonschema.ts';
import type { Logger } from '../util/logger.ts';
import type { CanonicalPath } from '../util/paths.ts';
import { canonicalize, displayPath } from '../util/paths.ts';
import type { ToolCallPart, ToolResultPart } from '../model/ir.ts';
import { describeAccess } from '../policy/access.ts';
import { PolicyEngine, decisionToError, type PolicyDecision } from '../policy/policy-engine.ts';
import type { ExecutionBackend } from '../execution/backend.ts';
import { SandboxPlanner } from '../execution/sandbox.ts';
import { diagnose, renderDiagnosis } from '../execution/diagnosis.ts';
import { isUnrestricted } from '../security/egress/network-mode.ts';
import type { SecretBroker, SecretLease } from '../security/secret-broker.ts';
import type { Redactor } from '../security/redactor.ts';
import type { FreshnessLedger } from '../context/freshness.ts';
import { FailureTracker } from '../session/step.ts';
import type { StepContext } from '../session/step.ts';
import { ROOT_SCOPE, type DelegateFn, type DelegationScope } from '../session/delegation.ts';
import type { ActivateSkillFn } from '../extensions/skills.ts';
import type { PolicyLayer } from '../policy/policy-engine.ts';
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
  /**
   * Set when the action is a *child's* (alpha.4 §40).
   *
   * The user is being asked to approve something a subagent wants to do, which is
   * a different decision from approving the same action from the root agent: the
   * agent it came from is part of what makes it reasonable or not. Showing it
   * without attribution would present a delegated `npm install` as if the user's
   * own session had asked for it.
   */
  delegation?: { agent: string; delegationId: string; depth: number };
}

/**
 * How an approval was answered — and, since alpha.12, **who** answered it.
 *
 * `answeredByMode` exists because the durable log could not tell the difference.
 * An approval mode that answers on the user's behalf still returns
 * `{decision: 'allow'}`, so `approval.decided` recorded `granted: true` for a
 * deletion nobody looked at in exactly the bytes it records one the user pressed
 * `y` for. The event log is what an audit reads after the fact, and "which of
 * these did a human actually review" is the first question anybody would ask of
 * a session that ran in `auto`.
 *
 * A boolean rather than a `decidedBy: 'user' | 'mode'` enum on purpose: with an
 * enum, absent has to mean one of the two, and the one it would mean is the
 * consequential one. Absent here means "not answered by a mode", which is true
 * of the terminal prompter, the scripted prompter and the non-interactive
 * refusal alike, and stays true of a prompter nobody has written yet.
 *
 * `consulted` answers a different question — **was this put to a person at
 * all?** — and the two are not each other's negation. A mode answering is one
 * way nobody was asked; a non-interactive session refusing is another, and it is
 * not a mode. They are separate fields because they are separate facts: the
 * first is what the audit log records, the second is what the refusal is allowed
 * to claim. Absent means yes, because every prompter that exists to ask somebody
 * does.
 *
 * The message is why this exists. Every denial said "The user declined", and
 * under `--non-interactive` no user was ever asked — seen on a live run, where
 * the model dutifully reported a refusal by a user who was not there.
 */
export type ApprovalOutcome =
  | { decision: 'allow'; scope: 'once' | 'session'; answeredByMode?: boolean; consulted?: boolean }
  | {
      decision: 'deny';
      scope: 'once' | 'session';
      reason?: string;
      answeredByMode?: boolean;
      consulted?: boolean;
    };

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
    // `consulted: false` — there is nobody to consult, which is the entire
    // reason this prompter exists. Without it the refusal claimed a user
    // declined, in a session that by definition has no user to decline.
    return { decision: 'deny', scope: 'once', reason: this.reason, consulted: false };
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
  /**
   * A bounded, redacted look at what the tool actually returned (ADR-0031).
   *
   * Absent unless the host asked for it. A session that never asks carries no tool
   * content in its record at all — "off" means the bytes were never put here, not
   * that something declined to print them.
   */
  preview?: string;
  decisions: PolicyDecision[];
  metadata?: Record<string, unknown>;
}

/**
 * How much of a tool's output a preview may carry (ADR-0031).
 *
 * Small and fixed. It is a look at what happened, not a copy of it.
 */
export const PREVIEW_BUDGET: TruncationBudget = { maxBytes: 2048, maxLines: 20 };

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
  /**
   * Whether to attach a redacted preview of tool output to each record (ADR-0031).
   * A function rather than a flag: `/verbose` changes it mid-session.
   */
  previewOutput?: () => boolean;
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
  /**
   * An approval was answered. One object, not five positional arguments.
   *
   * It was four positional arguments until `answeredByMode` had to join them,
   * and a fifth boolean at the end of a positional list is how the wrong value
   * lands in the wrong slot at the one call site nobody re-reads.
   */
  onApproval?: (event: {
    subjectKey: string;
    granted: boolean;
    scope: 'once' | 'session';
    summary: string;
    /** True when an approval mode answered instead of the user. */
    answeredByMode: boolean;
  }) => void;
  /** Where calls executed by this runtime sit in the delegation tree. */
  delegationScope?: DelegationScope;
  /** Dispatch a bounded child scope, for the `Delegate` tool. */
  delegate?: DelegateFn;
  /** Activate a skill in the owning session, for the `Skill` tool. */
  activateSkill?: ActivateSkillFn;
}

export interface BatchOutcome {
  results: ToolResultPart[];
  /** Set when the doom-loop guard decided the turn must stop. */
  terminalFailure?: KernelError;
  /**
   * Bounded, redacted previews by tool call id (ADR-0031), when the host asked.
   *
   * Carried here rather than on `ToolResultPart` because that part is the IR the
   * model is shown, and a preview is for the person watching. Empty unless
   * `previewOutput` says otherwise.
   */
  previews: ReadonlyMap<string, string>;
  /**
   * Kernel-authored one-liners by tool call id, for the result line.
   *
   * Unlike `previews` this is not conditional on `previewOutput`: the text is
   * the kernel's own and contains no tool output, so there is nothing to gate.
   */
  safeMessages: ReadonlyMap<string, string>;
  /**
   * Why a call failed, by tool call id. Absent for calls that succeeded.
   *
   * Alongside the results rather than on `ToolResultPart` for the same reason
   * `previews` is: that part is the IR the model is shown, and an `ErrorCode` is
   * a kernel concept. The session puts these on the `tool.result` event, which is
   * what lets a reader — and the turn footer — tell a refusal from a failure.
   * Without it the footer counted a refused call as one that ran.
   */
  errorCodes: ReadonlyMap<string, ErrorCode>;
}

export class ToolRuntime {
  private readonly opts: ToolRuntimeOptions;
  /**
   * The engine this runtime was constructed with. Never replaced.
   *
   * Skill activation narrows the effective policy between steps, and the obvious
   * way to implement that — a setter taking an engine — would make widening a
   * one-line mistake away: pass any engine and the runtime adopts it. So the
   * runtime keeps the base and only ever *derives* from it (`setNarrowingLayers`),
   * which makes "a skill cannot widen permissions" structural instead of a rule
   * someone has to remember.
   */
  private readonly basePolicy: PolicyEngine;
  private activePolicy: PolicyEngine;
  private narrowingLayers: readonly PolicyLayer[] = [];

  constructor(opts: ToolRuntimeOptions) {
    this.opts = opts;
    this.basePolicy = opts.policy;
    this.activePolicy = opts.policy;
  }

  /** The engine in force right now: the base, narrowed by any active layers. */
  get policy(): PolicyEngine {
    return this.activePolicy;
  }

  /** Layer names in force, for `/permissions` and the step's audit record. */
  activeLayers(): readonly string[] {
    return this.narrowingLayers.map((l) => l.name);
  }

  /**
   * Replace the set of narrowing layers (skills, in alpha.4).
   *
   * Idempotent and absolute: the caller passes the layers that should be in
   * force, not a delta, so deactivating a turn-scoped skill is the same operation
   * as activating one. The result is always `basePolicy.narrow(...)`, so it is
   * provably ≤ the engine this runtime started with.
   */
  setNarrowingLayers(layers: readonly PolicyLayer[]): void {
    this.narrowingLayers = [...layers];
    this.activePolicy = this.narrowingLayers.reduce((engine, layer) => engine.narrow(layer), this.basePolicy);
  }

  /** The delegation scope calls run in. Root sessions are depth 0. */
  get delegationScope(): DelegationScope {
    return this.opts.delegationScope ?? ROOT_SCOPE;
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
    const previews = new Map<string, string>();
    const safeMessages = new Map<string, string>();
    const errorCodes = new Map<string, ErrorCode>();
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
      if (result.errorCode) {
        record.errorCode = result.errorCode;
        errorCodes.set(call.id, result.errorCode);
      }
      if (artifactRef) record.artifactRef = artifactRef;
      if (result.metadata) record.metadata = result.metadata;
      const preview = this.previewOf(result.content);
      if (preview !== undefined) {
        record.preview = preview;
        previews.set(call.id, preview);
      }
      if (result.safeMessage) safeMessages.set(call.id, result.safeMessage);
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

    return terminalFailure
      ? { results, previews, safeMessages, errorCodes, terminalFailure }
      : { results, previews, safeMessages, errorCodes };
  }

  /**
   * Run one tool call on the **user's** behalf, from the control plane.
   *
   * `/undo` needs the same policy decision, the same approval prompt and the
   * same narrowed executor that a model-issued call gets. The alternative — the
   * control plane assembling its own executor — would be a second copy of the
   * sequence in `executeOne`, and a second copy of a security-critical sequence
   * is how the two come to disagree.
   *
   * What it does *not* do is pretend a person is a model: no doom-loop
   * accounting, no hooks, no `tool.call` pair in the transcript. The command's
   * own `control.command` event is the record.
   */
  async executeControlCall(
    name: string,
    args: unknown,
    step: StepContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const call: ToolCallPart = {
      type: 'tool_call',
      id: `ctl_${this.opts.now().toString(36)}` as ToolCallPart['id'],
      name,
      arguments: args,
    };
    const { result } = await this.executeOne(call, step, signal, true);
    this.opts.onRecord?.({
      toolCallId: call.id,
      name,
      isError: result.isError,
      durationMs: 0,
      contentBytes: Buffer.byteLength(result.content, 'utf8'),
      truncated: false,
      decisions: [],
      turnId: step.turnId,
      stepId: step.stepId,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(this.previewOf(result.content) === undefined ? {} : { preview: this.previewOf(result.content) }),
    });
    return result;
  }

  /**
   * A bounded, redacted look at what a tool returned (ADR-0031).
   *
   * **Redacted before it is truncated, and that order is the point.** Truncating
   * first can cut a secret in half; half a token matches no literal and no shape, so
   * it survives redaction and gets printed. Redacting more text than is kept costs
   * one pass per tool call and is worth it.
   *
   * Truncation is `truncateForModel` with a smaller budget rather than a rule of its
   * own — a second truncation rule is how the two end up disagreeing, which is what
   * A15 is about.
   */
  private previewOf(content: string): string | undefined {
    if (this.opts.previewOutput?.() !== true) return undefined;
    if (content === '') return undefined;
    return truncateForModel(this.opts.redactor.redact(content), PREVIEW_BUDGET).text;
  }
  private async executeOne(
    call: ToolCallPart,
    step: StepContext,
    signal: AbortSignal,
    operator = false,
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
          safeMessage: `there is no tool named "${call.name}"`,
        },
        decisions: [],
      };
    }

    // The catalogue frozen for this step is the authority on what the model was
    // allowed to call — not the registry, which may contain deferred tools.
    //
    // Skipped for a control-plane call, because the catalogue answers a question
    // that does not apply: it records what the *model* was offered this step, and
    // a user typing a slash command was offered nothing. Everything below —
    // schema validation, the policy decision, the approval prompt, the sandbox
    // profile — is unchanged, which is the part that must not be skippable.
    if (!operator && !step.tools.tools.some((t) => t.name === call.name)) {
      return {
        result: {
          content: `error: TOOL_NOT_FOUND\n"${call.name}" was not available in this step.`,
          isError: true,
          errorCode: 'TOOL_NOT_FOUND',
          safeMessage: `"${call.name}" was not available in this step`,
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
          safeMessage: formatIssues(validation.issues),
        },
        decisions: [],
      };
    }

    let execution: ToolExecution;
    try {
      execution = await tool.resolve(
        validation.value as never,
        this.buildResolveContext(call, step, signal, operator),
      );
    } catch (e) {
      const err = toKernelError(e);
      return {
        result: { content: renderErrorForModel(err), isError: true, errorCode: err.code },
        decisions: [],
      };
    }

    // ---- policy ---------------------------------------------------------
    const decisions = this.activePolicy.decideBatch(execution.accesses);
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
      const scope = this.delegationScope;
      const request: ApprovalRequest = {
        subject: execution.approvalSubject,
        toolName: call.name,
        toolCallId: call.id,
        pending: asking,
      };
      if (execution.display.diff) request.diff = execution.display.diff;
      if (scope.depth > 0 && scope.delegationId && scope.agent) {
        request.delegation = { agent: scope.agent, delegationId: scope.delegationId, depth: scope.depth };
      }

      await this.opts.runHooks?.('PermissionRequest', { toolName: call.name });

      const outcome = await this.opts.prompter.request(request);
      const summary = execution.approvalSubject.title;

      if (outcome.scope === 'session') {
        this.activePolicy.approvals.record(
          execution.approvalSubject.key,
          outcome.decision === 'allow',
          summary,
          this.opts.now(),
        );
      }
      this.opts.onApproval?.({
        subjectKey: execution.approvalSubject.key,
        granted: outcome.decision === 'allow',
        scope: outcome.scope,
        summary,
        answeredByMode: outcome.answeredByMode === true,
      });

      if (outcome.decision === 'deny') {
        return {
          result: {
            content:
              // Who refused, only when that is known. "The user declined" was
              // printed unconditionally, including where nobody was asked.
              (outcome.consulted === false
                ? `error: TOOL_DENIED\nNot approved: ${summary}. Nobody was asked.`
                : `error: TOOL_DENIED\nThe user declined: ${summary}.`) +
              (outcome.reason ? `\nReason: ${outcome.reason}` : '') +
              '\nDo not retry this. Choose a different approach, or ask the user what they would prefer.',
            isError: true,
            errorCode: 'TOOL_DENIED',
            safeMessage:
              outcome.consulted === false
                ? `not approved: ${summary} — nobody was asked`
                : `declined: ${summary}${outcome.reason ? ` — ${outcome.reason}` : ''}`,
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

      // alpha.7 Closure C: say which capability was the *first* blocker, rather
      // than handing the model the last thing that went wrong. The diagnosis
      // explains and never acts — see `src/execution/diagnosis.ts` §47/§53.
      const diagnosis = diagnose({
        error: err,
        granted: {
          writeRoots: plan.profile.writeRoots,
          network:
            plan.profile.network === false
              ? 'deny'
              : isUnrestricted(plan.profile.network)
                ? 'unrestricted'
                : 'scoped',
          allowExec: plan.profile.allowExec,
        },
        backend: this.opts.backend.environment.enforcement,
      });

      const explained =
        diagnosis.category === 'unknown'
          ? renderErrorForModel(err)
          : `${renderErrorForModel(err)}\n\n${renderDiagnosis(diagnosis)}`;

      return {
        result: {
          content: explained,
          isError: true,
          errorCode: err.code,
          metadata: { diagnosis: diagnosis.category, diagnosisConfidence: diagnosis.confidence },
        },
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
    operator = false,
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
      delegation: this.delegationScope,
      loopBudget: step.loopBudget,
      ...(operator ? { operator: true } : {}),
      ...(this.opts.delegate ? { delegate: this.opts.delegate } : {}),
      ...(this.opts.activateSkill ? { activateSkill: this.opts.activateSkill } : {}),
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
