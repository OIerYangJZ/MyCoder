/**
 * Session and Turn Coordinator (spec §5, §6).
 *
 * This is the agent loop. The conceptual version in spec §6.1 is six lines; the
 * real one has to handle the list in §6.1's second half — cancellation, provider
 * retry, malformed tool calls, timeouts, denials, approvals, repeated failure,
 * context overflow, empty responses, and budget exhaustion. Each of those is a
 * branch below, and each ends with the turn in a legal terminal state and every
 * tool call answered.
 */

import {
  newModelRequestId,
  newStepId,
  newTurnId,
  sha256Hex,
  type SessionId,
  type StepId,
  type TurnId,
} from '../util/ids.ts';
import { kernelError, toKernelError, type KernelError } from '../util/errors.ts';
import type { Logger } from '../util/logger.ts';
import type { Clock } from '../util/clock.ts';
import type { CanonicalPath } from '../util/paths.ts';
import {
  collectModelEvents,
  type ModelEvent,
  type ModelRequest,
  type ModelRuntime,
  type ModelTurn,
} from '../model/ir.ts';
import type { ModelRegistry, ResolvedModelProfile } from '../model/profiles.ts';
import { addUsage, emptyUsage, estimateCost, resolveUsage, type UsageReport } from '../model/usage.ts';
import { ModelRegistry as Registry } from '../model/profiles.ts';
import { ContextEngine, type GoalState } from '../context/context-engine.ts';
import { ContextProjector } from '../context/projector.ts';
import { compact, needsCompaction } from '../context/compaction.ts';
import type { EditJournal } from '../edit/atomic-write.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { ToolRuntime, syntheticInterruptedResult } from '../tools/runtime.ts';
import type { ExecutionBackend } from '../execution/backend.ts';
import type { SessionStore, SessionMetadata } from './store.ts';
import type {
  BudgetExceededPayload,
  ModelRequestPayload,
  ModelResponsePayload,
  TurnStartedPayload,
} from './events.ts';
import { Turn } from './turn.ts';
import type { SessionTerminalState, TurnOutcomeRecord } from './terminal-state.ts';
import { renderHookOutput, type HookEvent, type HookRunner } from '../extensions/hooks.ts';
import {
  DEFAULT_LOOP_BUDGET,
  FailureTracker,
  freezeStepContext,
  LoopBudgetTracker,
  type LoopBudget,
  type StepContext,
} from './step.ts';

export interface SessionOptions {
  sessionId: SessionId;
  workspaceRoot: CanonicalPath;
  store: SessionStore;
  context: ContextEngine;
  projector: ContextProjector;
  toolRegistry: ToolRegistry;
  toolRuntime: ToolRuntime;
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  backend: ExecutionBackend;
  editJournal: EditJournal;
  logger: Logger;
  clock: Clock;
  kernelVersion: string;
  /** The alias currently selected. `/model use` changes this between steps. */
  modelAlias: string;
  permissionProfile: string;
  /** Session-level ceiling; `/loop` may narrow but never widen it. */
  loopBudgetCeiling?: LoopBudget;
  /** Tool names the active agent/skill permits. */
  allowedTools?: readonly string[];
  /** Lifecycle hooks (spec §18.1). Absent means no project hooks are configured. */
  hooks?: HookRunner;
  onEvent?: (type: string, payload: unknown) => void;
}

export interface TurnOutcome {
  turn: Turn;
  finalText: string;
  steps: number;
  error?: KernelError;
}

export class Session {
  readonly sessionId: SessionId;
  readonly workspaceRoot: CanonicalPath;
  readonly context: ContextEngine;
  readonly editJournal: EditJournal;

  private readonly opts: SessionOptions;
  private readonly clock: Clock;
  private readonly logger: Logger;

  private modelAlias: string;
  private pendingModelAlias: string | undefined;
  private loopCeiling: LoopBudget;
  private turnBudgetOverride: Partial<LoopBudget> | undefined;
  private currentTurn: Turn | undefined;
  private abortController: AbortController | undefined;
  /** One entry per finished turn; the live half of the replay gate (§4.2). */
  private readonly turnOutcomes: TurnOutcomeRecord[] = [];
  private compactionCount = 0;
  /** Cumulative usage with per-field provenance (§17). */
  private usageReport = emptyUsage();
  private usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    modelRequests: 0,
    toolCalls: 0,
  };

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.workspaceRoot = opts.workspaceRoot;
    this.context = opts.context;
    this.editJournal = opts.editJournal;
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.modelAlias = opts.modelAlias;
    this.loopCeiling = opts.loopBudgetCeiling ?? DEFAULT_LOOP_BUDGET;
  }

  // --- control-plane surface (called by ControlPlane, never by the model) ---

  get activeModelAlias(): string {
    return this.pendingModelAlias ?? this.modelAlias;
  }

  /**
   * Select a different model.
   *
   * Deliberately does not touch the in-flight step: the change is staged and
   * applied when the next step is frozen (spec §15.2, invariant 2).
   */
  selectModel(alias: string): { applied: 'now' | 'next-step' } {
    if (this.currentTurn && this.currentTurn.state === 'sampling') {
      this.pendingModelAlias = alias;
      return { applied: 'next-step' };
    }
    this.modelAlias = alias;
    this.pendingModelAlias = undefined;
    return { applied: 'now' };
  }

  /**
   * Set or clear the goal.
   *
   * This appends a `goal.changed` event, because the replay gate requires goal
   * state to be reconstructible from the log alone. Holding it only in memory
   * would mean a resumed session silently forgot what it was doing.
   */
  setGoal(goal: GoalState | undefined): void {
    this.context.setGoal(goal);
    void this.append(
      'goal.changed',
      goal
        ? { objective: goal.objective, status: goal.status, criteria: goal.criteria, cleared: false }
        : { cleared: true },
    );
  }

  get goal(): GoalState | undefined {
    return this.context.goal;
  }

  /** `/loop start --max-steps ...`. Narrowing only. */
  setTurnBudget(requested: Partial<LoopBudget> | undefined): void {
    this.turnBudgetOverride = requested;
  }

  get budgetCeiling(): LoopBudget {
    return this.loopCeiling;
  }

  get usageSnapshot(): typeof this.usage {
    return { ...this.usage };
  }

  /** Cumulative usage with provenance, for the eval result schema (§31). */
  get usageReportSnapshot(): UsageReport {
    return this.usageReport;
  }

  /**
   * The live half of the replay gate (plan §4.2).
   *
   * Computed from in-memory objects only. `replayTerminalState()` computes the
   * same shape from `events.jsonl` alone, and the two must be identical — see
   * `tests/integration/replay-gate.test.ts`.
   */
  terminalState(): SessionTerminalState {
    const toolCalls = new Set<string>();
    const answered = new Set<string>();

    for (const message of this.context.history()) {
      for (const part of message.parts) {
        if (part.type === 'tool_call') toolCalls.add(part.id);
        if (part.type === 'tool_result') answered.add(part.toolCallId);
      }
    }

    const goal = this.context.goal;

    return {
      turns: [...this.turnOutcomes],
      ...(goal
        ? { goal: { objective: goal.objective, status: goal.status, criteria: [...goal.criteria] } }
        : {}),
      toolCalls: [...toolCalls].sort(),
      answeredToolCalls: [...answered].sort(),
      dirtyFiles: [...this.editJournal.dirtyPaths()].sort(),
      modelRequests: this.usage.modelRequests,
      toolCallCount: toolCalls.size,
      compactions: this.compactionCount,
    };
  }

  get turn(): Turn | undefined {
    return this.currentTurn;
  }

  cancel(reason = 'cancelled by the user'): boolean {
    if (!this.currentTurn || this.currentTurn.isTerminal()) return false;
    this.abortController?.abort();
    this.currentTurn.cancel(this.clock.now(), reason);
    return true;
  }

  // --- the agent loop -----------------------------------------------------

  async runTurn(input: string, origin: 'user' | 'control' | 'loop' = 'user'): Promise<TurnOutcome> {
    const turn = new Turn({
      turnId: newTurnId(this.clock.now()),
      input,
      origin,
      startedAt: this.clock.now(),
    });
    this.currentTurn = turn;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const budget = new LoopBudgetTracker(this.loopCeiling, () => this.clock.now());
    if (this.turnBudgetOverride) budget.applyCeiling(this.turnBudgetOverride, this.loopCeiling);

    const failures = new FailureTracker(budget.current.maxRepeatedEquivalentFailures);

    await this.append('turn.started', { input, origin } satisfies TurnStartedPayload, turn.turnId);

    if (origin === 'user') this.context.appendUser(input);
    else if (origin === 'control') this.context.appendControlResult(input);

    if (origin === 'user') await this.runHooks('UserPromptSubmit', turn.turnId, {});

    try {
      await this.loop(turn, budget, failures, signal);
    } catch (e) {
      const err = toKernelError(e);
      this.logger.error('turn failed', { code: err.code });
      turn.fail(err, this.clock.now());
    }

    // Whatever happened, no tool call may be left dangling (invariant 1).
    await this.closeOpenToolCalls(turn.turnId, 'The turn ended before this tool call produced a result.');

    // Exactly one place emits the terminal event. The loop reaches `failed`
    // through several paths — budget exhausted, provider error, repeated failure
    // — and emitting from each of them is how one of them ends up not emitting
    // at all, leaving a turn that the event log says never finished.
    if (turn.state === 'completed') {
      await this.append(
        'turn.completed',
        { steps: turn.steps, textLength: turn.finalText?.length ?? 0 },
        turn.turnId,
      );
    } else if (turn.state === 'cancelled') {
      await this.append('turn.cancelled', { steps: turn.steps }, turn.turnId);
    } else if (turn.state === 'failed') {
      await this.append(
        'turn.failed',
        { code: turn.error?.code ?? 'INTERNAL_ERROR', message: turn.error?.message ?? '' },
        turn.turnId,
      );
    }

    this.turnOutcomes.push({
      state: turn.state,
      ...(turn.error ? { errorCode: turn.error.code } : {}),
      finalTextLength: turn.finalText?.length ?? 0,
    });

    // TurnEnd fires for every terminal state, including failure and
    // cancellation — a hook that only runs on success is useless for cleanup.
    await this.runHooks('TurnEnd', turn.turnId, {});

    await this.persistMetadata();
    this.abortController = undefined;

    const outcome: TurnOutcome = {
      turn,
      finalText: turn.finalText ?? '',
      steps: turn.steps,
    };
    if (turn.error) outcome.error = turn.error;
    return outcome;
  }

  private async loop(
    turn: Turn,
    budget: LoopBudgetTracker,
    failures: FailureTracker,
    signal: AbortSignal,
  ): Promise<void> {
    while (!turn.isTerminal()) {
      if (signal.aborted) {
        turn.cancel(this.clock.now());
        return;
      }

      const violation = budget.check();
      if (violation) {
        await this.append(
          'budget.exceeded',
          {
            budget: violation.budget,
            limit: violation.limit,
            observed: violation.observed,
          } satisfies BudgetExceededPayload,
          turn.turnId,
        );
        turn.fail(
          kernelError('LOOP_BUDGET_EXCEEDED', `Turn stopped: ${violation.message}.`, {
            blame: 'kernel',
            safeDetails: { budget: violation.budget, limit: violation.limit },
          }),
          this.clock.now(),
        );
        return;
      }

      turn.transition('preparing', this.clock.now());
      await this.runHooks('BeforeStep', turn.turnId, {});

      // Apply any staged control-plane change now, between steps.
      if (this.pendingModelAlias) {
        this.modelAlias = this.pendingModelAlias;
        this.pendingModelAlias = undefined;
      }

      const model = this.resolveModel();
      await this.maybeCompact(turn, model);

      const step = this.freezeStep(turn, model, budget);
      await this.append(
        'step.context_frozen',
        {
          contextHash: step.contextHash,
          toolsHash: step.toolsHash,
          estimatedTokens: step.context.estimatedTokens,
          model: model.alias,
        },
        turn.turnId,
        step.stepId,
      );

      turn.transition('sampling', this.clock.now());

      const modelTurn = await this.sample(step, signal);
      budget.modelRequests += 1;
      this.usage.modelRequests += 1;
      this.accumulateUsage(modelTurn, model);

      if (signal.aborted) {
        turn.cancel(this.clock.now());
        return;
      }

      if (modelTurn.error) {
        // §42: a failed request gets its own event. Recording it as a
        // `completed` response with an error field made failure classification
        // (§34) guess from the payload shape.
        await this.append(
          'model.request.failed',
          {
            requestId: modelTurn.requestId,
            code: modelTurn.error.code,
            retryable: modelTurn.error.retryable,
            blame: modelTurn.error.blame,
          },
          turn.turnId,
          step.stepId,
        );

        if (modelTurn.error.code === 'MODEL_CONTEXT_OVERFLOW') {
          // The provider rejected the request as too large. Compact and retry
          // once; the loop budget stops this becoming an infinite cycle.
          turn.transition('compacting', this.clock.now(), 'provider reported context overflow');
          await this.forceCompact(model, turn.turnId);
          await this.append('context.pressure', { source: 'provider' }, turn.turnId, step.stepId);
          turn.transition('preparing', this.clock.now());
          continue;
        }
        turn.fail(modelTurn.error, this.clock.now());
        return;
      }

      // Record what the model said before doing anything with it, so a crash
      // during tool execution still leaves an auditable assistant turn.
      if (modelTurn.parts.length > 0) this.context.appendAssistant(modelTurn.parts);

      const usageReport = resolveUsage(modelTurn.usage, { responseText: modelTurn.text });
      const cost = estimateCost(usageReport, model.profile.pricing);
      this.usageReport = addUsage(this.usageReport, usageReport);
      if (cost.provenance !== 'unknown') this.usage.costUsd += cost.usd;

      await this.append(
        'model.request.completed',
        {
          requestId: modelTurn.requestId,
          finishReason: modelTurn.finishReason,
          ...(modelTurn.rawFinishReason ? { rawFinishReason: modelTurn.rawFinishReason } : {}),
          toolCallCount: modelTurn.toolCalls.length,
          textLength: modelTurn.text.length,
          usage: modelTurn.usage,
          // §17: provenance travels with the number, so an eval can tell a
          // reported token count from one we estimated.
          usageProvenance: {
            inputTokens: usageReport.inputTokens.provenance,
            outputTokens: usageReport.outputTokens.provenance,
          },
          costUsd: cost.provenance === 'unknown' ? undefined : cost.usd,
          costProvenance: cost.provenance,
        } satisfies ModelResponsePayload,
        turn.turnId,
        step.stepId,
      );

      // ---- no tool calls: the turn is done -----------------------------
      if (modelTurn.toolCalls.length === 0) {
        if (modelTurn.text.trim() === '') {
          // An empty assistant message is legal on the wire but useless here.
          // Nudge once rather than completing a turn with nothing in it.
          this.context.appendControlResult(
            'That response was empty. Say what you found, what you changed, or what you need — or state that you are done.',
          );
          turn.transition('executing_tools', this.clock.now(), 'empty response');
          continue;
        }
        turn.transition('verifying', this.clock.now());
        turn.complete(modelTurn.text, this.clock.now());
        return;
      }

      // ---- tool calls ---------------------------------------------------
      turn.transition('executing_tools', this.clock.now());
      budget.toolCalls += modelTurn.toolCalls.length;
      this.usage.toolCalls += modelTurn.toolCalls.length;

      for (const call of modelTurn.toolCalls) {
        await this.append(
          'tool.call',
          {
            toolCallId: call.id,
            name: call.name,
            argsSummary: summarizeArgs(call.arguments),
            argsHash: sha256Hex(JSON.stringify(call.arguments ?? {})).slice(0, 16),
          },
          turn.turnId,
          step.stepId,
        );
      }

      const outcome = await this.opts.toolRuntime.executeBatch(modelTurn.toolCalls, step, signal);
      this.context.appendToolResults(outcome.results);

      for (const result of outcome.results) {
        await this.append(
          'tool.result',
          {
            toolCallId: result.toolCallId,
            isError: result.isError,
            contentBytes: Buffer.byteLength(result.content, 'utf8'),
          },
          turn.turnId,
          step.stepId,
        );
      }

      if (outcome.terminalFailure) {
        turn.fail(outcome.terminalFailure, this.clock.now());
        return;
      }

      if (signal.aborted) {
        turn.cancel(this.clock.now());
        return;
      }

      budget.steps += 1;
      this.context.consumeOneShotFacts();
    }
  }

  private async sample(step: StepContext, signal: AbortSignal): Promise<ModelTurn> {
    const request = this.buildRequest(step);

    await this.append(
      'model.request.started',
      {
        requestId: request.requestId,
        provider: request.provider,
        model: request.modelId,
        messageCount: request.messages.length,
        toolCount: request.tools.length,
        // Hash and size only. The prompt itself is never written (spec §21.2).
        payloadHash: sha256Hex(JSON.stringify({ s: request.system, m: request.messages.length })).slice(
          0,
          16,
        ),
        payloadBytes: Buffer.byteLength(JSON.stringify(request.messages), 'utf8'),
      } satisfies ModelRequestPayload,
      step.turnId,
      step.stepId,
    );

    try {
      const stream = await this.opts.modelRuntime.generate(request, {
        sessionId: this.sessionId,
        turnId: step.turnId,
        stepId: step.stepId,
        signal,
      });
      return await collectModelEvents(stream, (event: ModelEvent) => {
        this.opts.onEvent?.('model.stream', event);
      });
    } catch (e) {
      const err = toKernelError(e);
      return {
        requestId: request.requestId,
        text: '',
        parts: [],
        toolCalls: [],
        finishReason: 'error',
        usage: {},
        error: err,
      };
    }
  }

  private buildRequest(step: StepContext): ModelRequest {
    const request: ModelRequest = {
      requestId: newModelRequestId(this.clock.now()),
      modelId: step.model.modelId,
      provider: step.model.provider.id,
      system: step.context.system,
      messages: step.context.messages,
      tools: step.tools.tools,
    };
    if (step.model.profile.maxOutputTokens !== undefined) {
      request.maxOutputTokens = step.model.profile.maxOutputTokens;
    }
    return request;
  }

  private freezeStep(turn: Turn, model: ResolvedModelProfile, budget: LoopBudgetTracker): StepContext {
    const snapshot = this.opts.projector.project(this.context, this.context.repository.facts);
    const tools = this.opts.toolRegistry.view(
      this.opts.allowedTools ? { allowed: this.opts.allowedTools } : {},
    );

    return freezeStepContext({
      sessionId: this.sessionId,
      turnId: turn.turnId,
      stepId: newStepId(this.clock.now()),
      context: snapshot,
      tools,
      model,
      execution: this.opts.backend.environment,
      loopBudget: budget.snapshot(),
      frozenAt: this.clock.now(),
    });
  }

  private resolveModel(): ResolvedModelProfile {
    const resolved = this.opts.modelRegistry.resolve(this.modelAlias);
    if (!resolved) {
      throw new Error(`model alias "${this.modelAlias}" is not registered`);
    }
    return resolved;
  }

  private async maybeCompact(turn: Turn, model: ResolvedModelProfile): Promise<void> {
    const snapshot = this.opts.projector.project(this.context, this.context.repository.facts);
    const budgetTokens = Registry.usableContextTokens(model.profile);
    if (!needsCompaction(snapshot.estimatedTokens, budgetTokens)) return;

    turn.transition('compacting', this.clock.now(), 'context budget exceeded');
    const result = this.runCompaction(snapshot.system, budgetTokens);

    await this.append(
      'compaction.boundary',
      {
        level: result.levelsApplied.at(-1) ?? 'L1',
        droppedMessages: result.droppedMessages,
        summaryLength: result.summaryLength,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        preservedExchanges: result.preservedExchanges,
      },
      turn.turnId,
    );
  }

  /**
   * Compact unconditionally, after a provider-side overflow.
   *
   * This also appends a boundary event. Compaction that happens without one is
   * invisible to replay, and §20.3 requires the boundary to be recorded.
   */
  private async forceCompact(model: ResolvedModelProfile, turnId: TurnId): Promise<void> {
    const snapshot = this.opts.projector.project(this.context, this.context.repository.facts);
    const budgetTokens = Math.floor(Registry.usableContextTokens(model.profile) * 0.6);
    const result = this.runCompaction(snapshot.system, budgetTokens);

    await this.append(
      'compaction.boundary',
      {
        level: result.levelsApplied.at(-1) ?? 'L1',
        droppedMessages: result.droppedMessages,
        summaryLength: result.summaryLength,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        preservedExchanges: result.preservedExchanges,
        trigger: 'provider-overflow',
      },
      turnId,
    );
  }

  private runCompaction(system: string, budgetTokens: number): ReturnType<typeof compact> {
    this.compactionCount += 1;
    const result = compact(this.context.history(), system, {
      budgetTokens,
      ...(this.context.goal ? { goal: this.context.goal } : {}),
      reinject: [this.editJournal.summary()],
    });
    this.context.replaceHistory(result.messages, result.boundary);
    // Receipts predate the summary and their coverage claims no longer match
    // what the model can see, so they are dropped rather than left to authorise
    // an edit against content that was compacted away.
    for (const receipt of this.context.freshness.list()) {
      this.context.freshness.invalidatePath(receipt.path);
    }
    return result;
  }

  /**
   * Run the project hooks registered for a lifecycle point.
   *
   * Three properties, all deliberate:
   *
   *  - **A hook can never fail the turn.** `HookRunner` already reports rather
   *    than throws, and this wraps it again: a broken `.agent/hooks.toml` must
   *    not be able to take a session down.
   *  - **Output is injected with its provenance.** It arrives as an
   *    `injection` message naming the hook, so the model can weigh it as
   *    third-party text rather than as the user speaking.
   *  - **Every run is audited**, including the ones policy refused.
   */
  async runHooks(
    event: HookEvent,
    turnId: TurnId | undefined,
    ctx: { toolName?: string; path?: string },
  ): Promise<void> {
    const runner = this.opts.hooks;
    if (!runner) return;

    try {
      const outcomes = await runner.run({
        event,
        sessionId: this.sessionId,
        ...(turnId ? { turnId } : {}),
        ...(ctx.toolName ? { toolName: ctx.toolName } : {}),
        ...(ctx.path ? { path: ctx.path } : {}),
      });
      if (outcomes.length === 0) return;

      for (const outcome of outcomes) {
        await this.append(
          'hook.executed',
          {
            event,
            command: outcome.hook.command[0] ?? '',
            ran: outcome.ran,
            exitCode: outcome.exitCode ?? null,
            durationMs: outcome.durationMs ?? 0,
            ...(outcome.blocked ? { blocked: outcome.blocked } : {}),
          },
          turnId,
        );
      }

      const injected = renderHookOutput(outcomes);
      if (injected) this.context.appendInjection(`hook:${event}`, injected);
    } catch (e) {
      this.logger.warn('hook execution failed', {
        event,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Answer every dangling tool call, so the conversation stays well formed. */
  private async closeOpenToolCalls(turnId: TurnId, reason: string): Promise<void> {
    const open = this.context.openToolCalls();
    if (open.length === 0) return;

    const results = open.map((id) => syntheticInterruptedResult(id, reason));
    this.context.appendToolResults(results);

    for (const result of results) {
      await this.append('tool.synthetic_result', { toolCallId: result.toolCallId, reason }, turnId);
    }
  }

  private accumulateUsage(modelTurn: ModelTurn, model: ResolvedModelProfile): void {
    this.usage.inputTokens += modelTurn.usage.inputTokens ?? 0;
    this.usage.outputTokens += modelTurn.usage.outputTokens ?? 0;
    this.usage.cachedInputTokens += modelTurn.usage.cachedInputTokens ?? 0;

    // Cost is computed from the provenance-aware report at the call site, so
    // an estimated token count cannot silently become a confident dollar figure.
    void model;
  }

  private async append(type: string, payload: unknown, turnId?: TurnId, stepId?: StepId): Promise<void> {
    this.opts.onEvent?.(type, payload);
    await this.opts.store.append(this.sessionId, {
      type: type as Parameters<SessionStore['append']>[1]['type'],
      payload,
      ...(turnId ? { turnId } : {}),
      ...(stepId ? { stepId } : {}),
    });
  }

  async persistMetadata(): Promise<void> {
    const existing = await this.opts.store.loadMetadata(this.sessionId);
    if (!existing) return;
    const next: SessionMetadata = {
      ...existing,
      model: this.modelAlias,
      usage: { ...this.usage },
    };
    if (this.context.goal) next.goal = this.context.goal;
    await this.opts.store.saveMetadata(next);
  }
}

function summarizeArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > 400 ? `${json.slice(0, 400)}…` : json;
  } catch {
    return '(unserialisable)';
  }
}
