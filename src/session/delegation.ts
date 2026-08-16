/**
 * Delegated execution (alpha.4 §6–§20, ADR-0013).
 *
 * A parent agent asks for a bounded child scope; this file produces one. The
 * central rule is stated once, in `deriveChildScope`, and everything else follows
 * from it:
 *
 *   EffectiveChildCapability = SystemCeiling ∩ RootSessionCeiling
 *                            ∩ ParentEffectiveCapability ∩ AgentDefinition
 *                            ∩ ActiveSkillConstraints ∩ ToolRequest
 *
 * There is deliberately **no second agent loop** here. The child is a `Session`,
 * driven by the same `StepEngine`, sampling through the same `ModelRuntime`,
 * executing through the same `ToolRuntime`, against the same `PolicyEngine`
 * lineage, the same `SecretBroker`, the same `EgressGate`, the same
 * `ExecutionBackend` and the same event log. What this file adds is the *scope*:
 * a narrower policy, a narrower catalogue, a smaller budget, a fresh context, a
 * fresh freshness ledger, and provenance that joins the child back to the tool
 * call that asked for it.
 *
 * Three properties are structural rather than checked:
 *
 *  - **A child cannot widen anything.** Its policy engine exists only as
 *    `parentPolicy.narrow(...)`; its catalogue only as an intersection; its
 *    budget only as a `Math.min` against what the parent has left.
 *  - **A child cannot see the parent's conversation.** It gets a new
 *    `ContextEngine`. Nothing copies history into it, so there is no code path
 *    that could leak a parent-only marker (§17) or an unredacted tool result.
 *  - **A child cannot outlive its parent's turn.** `run()` awaits the child turn
 *    and links the parent's `AbortSignal` to `child.cancel()`, so cancellation
 *    propagates and there is no background continuation to leak (§19).
 */

import { truncateForModel } from '../util/text.ts';
import { kernelError, toKernelError, type KernelError } from '../util/errors.ts';
import {
  newChildRunId,
  newDelegationId,
  sha256Hex,
  type SessionId,
  type StepId,
  type TurnId,
} from '../util/ids.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { CanonicalPath } from '../util/paths.ts';

import type { ModelRuntime } from '../model/ir.ts';
import type { ModelRegistry } from '../model/profiles.ts';
import type { PolicyEngine } from '../policy/policy-engine.ts';
import type { ProfileContext } from '../policy/profiles.ts';
import type { ExecutionBackend } from '../execution/backend.ts';
import type { SecretBroker } from '../security/secret-broker.ts';
import type { Redactor } from '../security/redactor.ts';
import { ContextEngine } from '../context/context-engine.ts';
import { ContextProjector, type ContextOverlay } from '../context/projector.ts';
import { FreshnessLedger } from '../context/freshness.ts';
import type { RepositoryPlane } from '../context/repository-plane.ts';
import type { EditJournal } from '../edit/atomic-write.ts';
import { journalEntriesOf, journalEventPayload } from '../edit/journal-log.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { ToolRuntime, type ApprovalPrompter } from '../tools/runtime.ts';
import {
  activateSkill,
  renderSkillInstructions,
  resolveSkillActivation,
  type ActivatedSkill,
  type SkillDefinition,
} from '../extensions/skills.ts';
import { deriveSubagent, type AgentDefinition } from '../extensions/agents.ts';
import type { HookRunner } from '../extensions/hooks.ts';

import { Session } from './session.ts';
import { FailureTracker, type LoopBudget, type LoopBudgetSnapshot } from './step.ts';
import type { SessionStore } from './store.ts';
import type { TurnOutcomeRecord } from './terminal-state.ts';

/**
 * What a model may ask for (alpha.4 §7).
 *
 * Note what is missing and cannot be added: no permission profile, no secret
 * list, no environment forwarding, no sandbox flag, no depth. Those are the
 * fields whose absence makes the request safe to accept from an untrusted
 * source, so the schema is the enforcement.
 */
export interface DelegationRequest {
  agent: string;
  task: string;
  /**
   * Names of things the child may need, projected as *references* rather than
   * content (§16).
   *
   * The child is told these paths exist and re-reads them through its own tools,
   * under its own policy. Passing the bytes instead would make the parent's
   * redaction decisions the child's, and would put unreviewed parent context
   * inside a scope that was never granted it.
   */
  contextRefs?: string[];
  maxSteps?: number;
  maxToolCalls?: number;
  maxModelRequests?: number;
  maxWallTimeMs?: number;
  maxCostUsd?: number;
}

export type DelegationStatus = 'completed' | 'failed' | 'cancelled' | 'budget_exceeded' | 'denied';

export interface DelegationUsage {
  modelRequests: number;
  toolCalls: number;
  wallTimeMs: number;
  /**
   * Tokens the child spent.
   *
   * Present for the same reason the request count is: §13 says root usage includes
   * child usage, and a root that counted the child's *requests* but not its
   * *tokens* was internally contradictory wherever the two appear together — which
   * is `/status`, the eval artifact and any cost arithmetic derived from tokens.
   * Found against a live relay whose per-request token count was large enough to
   * make the omission obvious.
   */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Absent when no pricing is configured — never a fabricated zero (§18). */
  estimatedCostUsd?: number;
}

/** What the child was actually granted, after every intersection. */
export interface DelegationGrant {
  model: string;
  allowedTools: string[];
  policyLayers: string[];
  skills: string[];
  budget: LoopBudget;
}

/** The structured value the parent receives (alpha.4 §8). */
export interface DelegationResult {
  delegationId: string;
  childRunId: string;
  agent: string;
  status: DelegationStatus;
  summary: string;
  usage: DelegationUsage;
  error?: KernelError;
  grant?: DelegationGrant;
  /** Anything the definition or the request asked for and did not get. */
  notes: string[];
  /** Workspace-relative paths the child modified. */
  dirtyFiles: string[];
}

/**
 * The parent-side record of a finished delegation.
 *
 * Kept separate from `DelegationResult` because it answers a different question:
 * the result is what the *model* is told, this is what *replay* must reproduce.
 * The child's facts are nested rather than merged so a divergence names the
 * scope it happened in.
 */
export interface DelegationRecord {
  delegationId: string;
  childRunId: string;
  agent: string;
  depth: number;
  status: DelegationStatus;
  usage: DelegationUsage;
  child: {
    turns: TurnOutcomeRecord[];
    toolCalls: string[];
    answeredToolCalls: string[];
    modelRequests: number;
    compactions: number;
    dirtyFiles: string[];
  };
}

/** Where the currently executing code sits in the delegation tree. */
export interface DelegationScope {
  /** 0 for the root session, 1 for its children. */
  depth: number;
  maxDepth: number;
  delegationId?: string;
  agent?: string;
}

export const ROOT_SCOPE: DelegationScope = { depth: 0, maxDepth: 1 };

/**
 * Default child allowance (§13).
 *
 * A child is a bounded errand, not a second session: without a default cap the
 * first delegation could spend the parent's entire remaining budget, and the
 * parent would discover that only when its own next step was refused. These are
 * ceilings — the effective budget is still the minimum of these, what the parent
 * has left, the agent definition and the request.
 */
export const DEFAULT_CHILD_BUDGET: LoopBudget = {
  maxSteps: 8,
  maxModelRequests: 8,
  maxToolCalls: 24,
  maxWallTimeMs: 5 * 60_000,
  maxRepeatedEquivalentFailures: 3,
};

/**
 * What the *tool* knows about the call site.
 *
 * Deliberately everything a tool can honestly supply and nothing more: it knows
 * which call it is, which step it belongs to, what the turn's budget looks like
 * and how deep it is. It does **not** know the parent's policy engine or effective
 * catalogue, so it cannot misreport them — the wiring supplies those from the
 * runtime that is actually enforcing them.
 */
export interface DelegateCallSite {
  toolCallId: string;
  turnId: TurnId;
  stepId: StepId;
  signal: AbortSignal;
  /** The parent turn's budget and what it has spent so far. */
  loopBudget: LoopBudgetSnapshot;
  /** The scope the *calling* tool runs in. */
  scope: DelegationScope;
}

export interface DelegationCallOptions extends DelegateCallSite {
  /** The parent's effective policy at the moment of the call. */
  parentPolicy: PolicyEngine;
  parentAllowedTools: readonly string[];
  parentModelAlias: string;
}

/** The callback shape a tool uses to dispatch a child (see `ToolResolveContext`). */
export type DelegateFn = (request: DelegationRequest, site: DelegateCallSite) => Promise<DelegationResult>;

export interface DelegationServiceOptions {
  sessionId: SessionId;
  agents: readonly AgentDefinition[];
  skills: readonly SkillDefinition[];
  registry: ToolRegistry;
  backend: ExecutionBackend;
  secrets: SecretBroker;
  redactor: Redactor;
  prompter: ApprovalPrompter;
  hooks?: HookRunner;
  store: SessionStore;
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  repository: RepositoryPlane;
  editJournal: EditJournal;
  workspaceRoot: CanonicalPath;
  agentTmpDir?: CanonicalPath;
  profileContext: ProfileContext;
  logger: Logger;
  clock: Clock;
  kernelVersion: string;
  /**
   * Honest isolation description for the child's system prompt.
   *
   * The child is told exactly what the parent is told: a subagent that believed
   * it had a stronger sandbox than it does would spend its budget on commands the
   * boundary will refuse, and one that believed it had a weaker sandbox would
   * refuse to try things that are permitted.
   */
  environment: {
    sandboxDescription: string;
    networkEnforcement: 'enforced' | 'best-effort' | 'unenforced';
    backendDescription: string;
  };
  maxDepth?: number;
  maxRepeatedFailures?: number;
  toolTimeoutMs?: number;
  /** Ceiling the root session was created with; a child never exceeds it. */
  rootCeiling: LoopBudget;
  /** Called when a child finishes, so the parent can account for it. */
  onRecord?: (record: DelegationRecord) => void;
}

interface ActiveDelegation {
  delegationId: string;
  childRunId: string;
  agent: string;
  depth: number;
  startedAt: number;
  grant: DelegationGrant;
  /** Latest child activity, for `/status`. Never a hidden prompt (§41). */
  activity: string;
  session: Session;
}

export class DelegationService {
  private readonly opts: DelegationServiceOptions;
  private readonly maxDepth: number;
  /** Doom-loop guard (§32), keyed by agent + normalised task + failure code. */
  private readonly repeats: FailureTracker;
  private readonly active = new Map<string, ActiveDelegation>();
  private readonly finished: DelegationRecord[] = [];

  constructor(opts: DelegationServiceOptions) {
    this.opts = opts;
    this.maxDepth = opts.maxDepth ?? ROOT_SCOPE.maxDepth;
    this.repeats = new FailureTracker(opts.maxRepeatedFailures ?? 3);
  }

  /** Agents that may be delegated to, for the tool schema and `/agents`. */
  agentNames(): string[] {
    return this.opts.agents.map((a) => a.name);
  }

  /** Safe operational state for `/status` (§41). */
  activeDelegations(): Array<{
    delegationId: string;
    agent: string;
    depth: number;
    model: string;
    activity: string;
    elapsedMs: number;
    budgetRemaining: { steps: number; toolCalls: number; modelRequests: number };
  }> {
    return [...this.active.values()].map((entry) => {
      const used = entry.session.usageSnapshot;
      return {
        delegationId: entry.delegationId,
        agent: entry.agent,
        depth: entry.depth,
        model: entry.grant.model,
        activity: entry.activity,
        elapsedMs: this.opts.clock.now() - entry.startedAt,
        budgetRemaining: {
          steps: Math.max(0, entry.grant.budget.maxSteps - entry.session.stepsUsed),
          toolCalls: Math.max(0, entry.grant.budget.maxToolCalls - used.toolCalls),
          modelRequests: Math.max(0, entry.grant.budget.maxModelRequests - used.modelRequests),
        },
      };
    });
  }

  records(): readonly DelegationRecord[] {
    return this.finished;
  }

  /**
   * Dispatch one child, and do not return until it is finished.
   *
   * Sequential by design (§5: parallel subagents are a non-goal). The parent's
   * step is blocked while the child runs, which is what keeps the event log
   * ordered and therefore replayable.
   */
  async run(request: DelegationRequest, call: DelegationCallOptions): Promise<DelegationResult> {
    const startedAt = this.opts.clock.now();
    const delegationId = newDelegationId(startedAt);
    const childRunId = newChildRunId(startedAt);
    const depth = call.scope.depth + 1;

    const refuse = async (
      status: Exclude<DelegationStatus, 'completed'>,
      error: KernelError,
      notes: string[] = [],
    ): Promise<DelegationResult> => {
      const result: DelegationResult = {
        delegationId,
        childRunId,
        agent: request.agent,
        status,
        summary: error.message,
        usage: {
          modelRequests: 0,
          toolCalls: 0,
          wallTimeMs: this.opts.clock.now() - startedAt,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
        },
        error,
        notes,
        dirtyFiles: [],
      };
      await this.appendParent(
        status === 'cancelled' ? 'delegation.cancelled' : 'delegation.denied',
        this.finishedPayload(result, depth),
        call,
      );
      this.record({
        delegationId,
        childRunId,
        agent: request.agent,
        depth,
        status,
        usage: result.usage,
        child: {
          turns: [],
          toolCalls: [],
          answeredToolCalls: [],
          modelRequests: 0,
          compactions: 0,
          dirtyFiles: [],
        },
      });
      return result;
    };

    await this.appendParent(
      'delegation.requested',
      {
        delegationId,
        agent: request.agent,
        depth,
        toolCallId: call.toolCallId,
        task: truncateForModel(request.task, { maxBytes: 2_000, maxLines: 40 }).text,
        taskHash: sha256Hex(normalizeTask(request.task)).slice(0, 16),
        requested: {
          ...(request.maxSteps !== undefined ? { maxSteps: request.maxSteps } : {}),
          ...(request.maxToolCalls !== undefined ? { maxToolCalls: request.maxToolCalls } : {}),
          ...(request.maxModelRequests !== undefined ? { maxModelRequests: request.maxModelRequests } : {}),
          ...(request.maxWallTimeMs !== undefined ? { maxWallTimeMs: request.maxWallTimeMs } : {}),
          ...(request.maxCostUsd !== undefined ? { maxCostUsd: request.maxCostUsd } : {}),
        },
        ...(request.contextRefs ? { contextRefs: request.contextRefs.slice(0, 20) } : {}),
      },
      call,
    );

    // ---- depth (§12) ----------------------------------------------------
    if (depth > this.maxDepth) {
      return refuse(
        'denied',
        kernelError(
          'DELEGATION_DEPTH_EXCEEDED',
          `Delegation depth ${depth} exceeds the limit of ${this.maxDepth}. ` +
            'A subagent cannot dispatch another subagent. Do the work in this scope, or report back ' +
            'and let the parent decide.',
          { safeDetails: { depth, maxDepth: this.maxDepth, agent: request.agent } },
        ),
      );
    }

    // ---- the agent has to exist -----------------------------------------
    const agent = this.opts.agents.find((a) => a.name === request.agent);
    if (!agent) {
      return refuse(
        'denied',
        kernelError(
          'DELEGATION_DENIED',
          `There is no agent named "${request.agent}". ` +
            (this.opts.agents.length > 0
              ? `Available agents: ${this.agentNames().join(', ')}.`
              : 'This project defines no agents.'),
          { blame: 'model', safeDetails: { agent: request.agent } },
        ),
      );
    }

    // ---- doom-loop guard (§32) ------------------------------------------
    const loopKey = repeatKey(request.agent, request.task);
    if (this.repeats.isTerminal(loopKey)) {
      return refuse(
        'denied',
        kernelError(
          'DELEGATION_DENIED',
          `This delegation to "${request.agent}" has already failed ${this.repeats.count(loopKey)} times ` +
            'with the same task. Repeating it will not help: change the task, do the work here, or ' +
            'report what is blocking you.',
          { blame: 'model', safeDetails: { agent: request.agent, occurrences: this.repeats.count(loopKey) } },
        ),
      );
    }

    // ---- capability, catalogue, model, budget (§10, §13, §15) ------------
    const scope = this.deriveChildScope(agent, request, call);
    if (scope.exhausted) {
      return refuse(
        'budget_exceeded',
        kernelError(
          'LOOP_BUDGET_EXCEEDED',
          `There is not enough budget left to delegate: ${scope.exhausted}. ` +
            'Finish the work in this turn, or ask the user to raise the budget with /loop.',
          { safeDetails: { agent: request.agent, budget: scope.exhausted } },
        ),
        scope.notes,
      );
    }
    if (scope.allowedTools.length === 0) {
      return refuse(
        'denied',
        kernelError(
          'DELEGATION_DENIED',
          `Agent "${agent.name}" would have no tools at all in this session, so the delegation was refused ` +
            'rather than started as a child that can do nothing.',
          { blame: 'user', safeDetails: { agent: agent.name } },
        ),
        scope.notes,
      );
    }

    // A cancelled parent never starts a child (§19).
    if (call.signal.aborted) {
      return refuse(
        'cancelled',
        kernelError('CANCELLED', 'The parent turn was cancelled before the child started.'),
      );
    }

    const child = this.buildChild({ delegationId, childRunId, depth, agent, scope, request, call });

    const grant: DelegationGrant = {
      model: scope.modelAlias,
      allowedTools: scope.allowedTools,
      policyLayers: scope.policy.describeLayers().map((l) => l.name),
      skills: scope.skills.map((s) => s.skill.name),
      budget: scope.budget,
    };

    await this.appendParent(
      'delegation.started',
      {
        delegationId,
        childRunId,
        agent: agent.name,
        depth,
        model: grant.model,
        allowedTools: grant.allowedTools,
        policyLayers: grant.policyLayers,
        skills: grant.skills,
        granted: {
          maxSteps: scope.budget.maxSteps,
          maxToolCalls: scope.budget.maxToolCalls,
          maxModelRequests: scope.budget.maxModelRequests,
          maxWallTimeMs: scope.budget.maxWallTimeMs,
          ...(scope.budget.maxCostUsd !== undefined ? { maxCostUsd: scope.budget.maxCostUsd } : {}),
        },
        notes: scope.notes,
      },
      call,
    );

    const entry: ActiveDelegation = {
      delegationId,
      childRunId,
      agent: agent.name,
      depth,
      startedAt,
      grant,
      activity: 'starting',
      session: child.session,
    };
    this.active.set(delegationId, entry);

    // Parent cancellation reaches the child's model and tool calls through the
    // child's own AbortController, which `cancel()` triggers.
    const onAbort = (): void => {
      child.session.cancel('the parent turn was cancelled');
    };
    call.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const outcome = await child.session.runTurn(renderChildTask(request, agent), 'delegation');

      const status: DelegationStatus = call.signal.aborted
        ? 'cancelled'
        : statusOf(outcome.turn.state, outcome.error);

      const usage = child.session.usageSnapshot;
      const result: DelegationResult = {
        delegationId,
        childRunId,
        agent: agent.name,
        status,
        summary: renderChildSummary(agent.name, status, outcome.finalText, child.dirtyFiles(), outcome.error),
        usage: {
          modelRequests: usage.modelRequests,
          toolCalls: usage.toolCalls,
          wallTimeMs: this.opts.clock.now() - startedAt,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          ...(usage.costUsd > 0 ? { estimatedCostUsd: usage.costUsd } : {}),
        },
        ...(outcome.error ? { error: outcome.error } : {}),
        grant,
        notes: scope.notes,
        dirtyFiles: child.dirtyFiles(),
      };

      if (status !== 'completed') this.repeats.record(loopKey);

      const childState = child.session.terminalState();
      await this.appendParent(eventFor(status), this.finishedPayload(result, depth), call);
      this.record({
        delegationId,
        childRunId,
        agent: agent.name,
        depth,
        status,
        usage: result.usage,
        child: {
          turns: childState.turns,
          toolCalls: childState.toolCalls,
          answeredToolCalls: childState.answeredToolCalls,
          modelRequests: childState.modelRequests,
          compactions: childState.compactions,
          dirtyFiles: child.dirtyFiles(),
        },
      });

      return result;
    } catch (e) {
      // A throw here is a kernel bug rather than a child failure, but the parent
      // still gets a structured result: an unanswered delegating tool call would
      // violate invariant 1 from the other side.
      const err = toKernelError(e);
      this.opts.logger.error('delegation crashed', { delegationId, code: err.code });
      const result: DelegationResult = {
        delegationId,
        childRunId,
        agent: agent.name,
        status: 'failed',
        summary: `The delegation to ${agent.name} failed inside the kernel: ${err.message}`,
        usage: {
          modelRequests: child.session.usageSnapshot.modelRequests,
          toolCalls: child.session.usageSnapshot.toolCalls,
          wallTimeMs: this.opts.clock.now() - startedAt,
          inputTokens: child.session.usageSnapshot.inputTokens,
          outputTokens: child.session.usageSnapshot.outputTokens,
          cachedInputTokens: child.session.usageSnapshot.cachedInputTokens,
        },
        error: err,
        grant,
        notes: scope.notes,
        dirtyFiles: child.dirtyFiles(),
      };
      await this.appendParent('delegation.failed', this.finishedPayload(result, depth), call);
      this.record({
        delegationId,
        childRunId,
        agent: agent.name,
        depth,
        status: 'failed',
        usage: result.usage,
        child: {
          turns: child.session.terminalState().turns,
          toolCalls: child.session.terminalState().toolCalls,
          answeredToolCalls: child.session.terminalState().answeredToolCalls,
          modelRequests: child.session.usageSnapshot.modelRequests,
          compactions: child.session.terminalState().compactions,
          dirtyFiles: child.dirtyFiles(),
        },
      });
      return result;
    } finally {
      call.signal.removeEventListener('abort', onAbort);
      this.active.delete(delegationId);
    }
  }

  // --- capability derivation ----------------------------------------------

  /**
   * The intersection, in one place (§10).
   *
   * Every branch below narrows. There is no code path that adds a tool, widens a
   * profile, raises a budget or picks a model the session has not registered —
   * which is why the runtime tests can assert "narrower or equal" as a property
   * rather than case by case.
   */
  private deriveChildScope(
    agent: AgentDefinition,
    request: DelegationRequest,
    call: DelegationCallOptions,
  ): {
    policy: PolicyEngine;
    allowedTools: string[];
    modelAlias: string;
    budget: LoopBudget;
    skills: ActivatedSkill[];
    notes: string[];
    exhausted?: string;
  } {
    const remaining = remainingBudget(call.loopBudget);

    // The agent definition's own request, resolved against the parent.
    const derived = deriveSubagent(agent, {
      parentPolicy: call.parentPolicy,
      parentAllowedTools: call.parentAllowedTools,
      parentMaxSteps: remaining.maxSteps,
      parentModelAlias: call.parentModelAlias,
      profileContext: this.opts.profileContext,
      knownModelAliases: this.opts.modelRegistry.listAliases().map((a) => a.alias),
    });

    const notes = [...derived.notes];
    let policy = derived.policy;
    let allowedTools = derived.allowedTools;

    // Skills the definition activates, each narrowing again (§26).
    const skills: ActivatedSkill[] = [];
    for (const name of agent.requestedSkills ?? []) {
      const definition = this.opts.skills.find((s) => s.name === name);
      if (!definition) {
        notes.push(
          `Agent "${agent.name}" activates skill "${name}", which this session has not discovered. ` +
            'It was not applied.',
        );
        continue;
      }
      const activated = activateSkill(definition, {
        registeredTools: this.opts.registry.names(),
        currentAllowedTools: allowedTools,
        profileContext: this.opts.profileContext,
        sessionMaxSteps: remaining.maxSteps,
      });
      allowedTools = activated.allowedTools;
      if (activated.layer) policy = policy.narrow(activated.layer);
      notes.push(...activated.notes);
      skills.push(activated);
    }

    // Budget: the minimum of the default ceiling, what the parent has left, the
    // agent definition, the active skills and the request (§13).
    const skillMaxSteps = skills.map((s) => s.maxSteps).filter((n): n is number => typeof n === 'number');

    const budget: LoopBudget = {
      maxSteps: minOf([
        DEFAULT_CHILD_BUDGET.maxSteps,
        remaining.maxSteps,
        this.opts.rootCeiling.maxSteps,
        agent.requestedMaxSteps,
        ...skillMaxSteps,
        request.maxSteps,
      ]),
      maxModelRequests: minOf([
        DEFAULT_CHILD_BUDGET.maxModelRequests,
        remaining.maxModelRequests,
        this.opts.rootCeiling.maxModelRequests,
        request.maxModelRequests,
      ]),
      maxToolCalls: minOf([
        DEFAULT_CHILD_BUDGET.maxToolCalls,
        remaining.maxToolCalls,
        this.opts.rootCeiling.maxToolCalls,
        agent.requestedMaxToolCalls,
        request.maxToolCalls,
      ]),
      maxWallTimeMs: minOf([
        DEFAULT_CHILD_BUDGET.maxWallTimeMs,
        remaining.maxWallTimeMs,
        this.opts.rootCeiling.maxWallTimeMs,
        request.maxWallTimeMs,
      ]),
      maxRepeatedEquivalentFailures: minOf([
        DEFAULT_CHILD_BUDGET.maxRepeatedEquivalentFailures,
        this.opts.rootCeiling.maxRepeatedEquivalentFailures,
      ]),
      ...(remaining.maxCostUsd !== undefined || request.maxCostUsd !== undefined
        ? {
            maxCostUsd: minOf([remaining.maxCostUsd, request.maxCostUsd], Number.POSITIVE_INFINITY),
          }
        : {}),
    };

    // Report anything the model asked for and did not get, so a shrunken budget
    // is visible rather than mysterious.
    for (const [field, asked] of [
      ['maxSteps', request.maxSteps],
      ['maxToolCalls', request.maxToolCalls],
      ['maxModelRequests', request.maxModelRequests],
      ['maxWallTimeMs', request.maxWallTimeMs],
    ] as const) {
      const granted = budget[field];
      if (asked !== undefined && granted < asked) {
        notes.push(
          `Requested ${field}=${asked}; granted ${granted} (bounded by the parent's remaining budget).`,
        );
      }
    }

    const exhausted = firstExhausted(budget);
    return {
      policy,
      allowedTools,
      modelAlias: derived.modelAlias,
      budget,
      skills,
      notes,
      ...(exhausted ? { exhausted } : {}),
    };
  }

  // --- child construction --------------------------------------------------

  /**
   * Build the child scope out of the *existing* runtime components.
   *
   * The only things constructed fresh are the ones that must not be shared: the
   * context engine (§16), the freshness ledger (a parent's read receipt must not
   * authorise a child's edit), the tool runtime (so its base policy *is* the
   * narrowed engine and cannot be widened later), the failure tracker and the
   * projector. Everything security-relevant — backend, secrets, redactor, egress
   * via the model runtime, store, hook definitions — is the parent's.
   */
  private buildChild(input: {
    delegationId: string;
    childRunId: string;
    depth: number;
    agent: AgentDefinition;
    scope: ReturnType<DelegationService['deriveChildScope']>;
    request: DelegationRequest;
    call: DelegationCallOptions;
  }): { session: Session; dirtyFiles: () => string[] } {
    const { delegationId, childRunId, depth, agent, scope, request, call } = input;
    const opts = this.opts;
    const clock = opts.clock;

    const freshness = new FreshnessLedger();
    const context = new ContextEngine({
      repository: opts.repository,
      freshness,
      now: () => clock.now(),
    });

    const overlays: ContextOverlay[] = [
      {
        source: `delegation:${agent.name}`,
        text: renderDelegationBriefing(agent, scope.budget, depth, this.maxDepth),
      },
      { source: `agent:${agent.name}`, text: agent.instructions },
      ...scope.skills.map((skill) => ({
        source: `skill:${skill.skill.name}`,
        text: renderSkillInstructions(skill),
      })),
    ];

    // Overlays are handed to the `Session` rather than to the projector, because
    // skill activation recomputes the whole overlay list between steps and two
    // owners of that list would drift apart.
    const projector = new ContextProjector({
      sandboxDescription: opts.environment.sandboxDescription,
      networkEnforcement: opts.environment.networkEnforcement,
      permissionProfile: scope.policy.describeLayers().at(-1)?.profile ?? 'inherited',
      backendDescription: opts.environment.backendDescription,
      editJournal: opts.editJournal,
      // Never for a child: at the default depth it cannot delegate, and its own
      // briefing says so in the sentence right below. Two pieces of advice that
      // contradict each other are worse than one.
      delegationGuidance: false,
    });

    // Dirty paths *this child* produced. Read from the child's own tool records
    // rather than from the shared journal, which also holds the parent's edits.
    const dirty = new Set<string>();

    const childScope: DelegationScope = {
      depth,
      maxDepth: this.maxDepth,
      delegationId,
      agent: agent.name,
    };

    // Both are declared before either is built because each callback the other
    // installs needs to read the *current* state of its partner at call time.
    let session: Session;
    let toolRuntime: ToolRuntime;

    toolRuntime = new ToolRuntime({
      registry: opts.registry,
      policy: scope.policy,
      backend: opts.backend,
      secrets: opts.secrets,
      redactor: opts.redactor,
      freshness,
      // The prompt has to say which agent is asking (§40). Wrapping the parent's
      // prompter rather than replacing it keeps `--non-interactive` and the
      // scripted prompter behaving identically inside a child.
      prompter: {
        request: (approval) =>
          opts.prompter.request({
            ...approval,
            delegation: { agent: agent.name, delegationId, depth },
          }),
      },
      logger: opts.logger.child(`child:${agent.name}`),
      workspaceRoot: opts.workspaceRoot,
      ...(opts.agentTmpDir ? { agentTmpDir: opts.agentTmpDir } : {}),
      failures: new FailureTracker(scope.budget.maxRepeatedEquivalentFailures),
      now: () => clock.now(),
      ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
      writeArtifact: (name, content) => opts.store.writeArtifact(opts.sessionId, name, content),
      delegationScope: childScope,
      // Depth is checked in `run()`, so a grandchild attempt reaches the same
      // structured refusal as any other over-limit request rather than being
      // impossible only because the tool was withheld. The child's *own* effective
      // policy and catalogue are what a grandchild would be measured against —
      // read from the runtime that enforces them, not from a copy.
      delegate: (nested, site): Promise<DelegationResult> =>
        this.run(nested, {
          ...site,
          parentPolicy: toolRuntime.policy,
          parentAllowedTools: session.effectiveAllowedTools,
          parentModelAlias: session.activeModelAlias,
        }),
      activateSkill: async (name, activationScope, source) => {
        const resolved = resolveSkillActivation(name, {
          skills: opts.skills,
          registeredTools: opts.registry.names(),
          currentAllowedTools: session.effectiveAllowedTools,
          profileContext: opts.profileContext,
          sessionMaxSteps: scope.budget.maxSteps,
        });
        if (!resolved.ok) return { ok: false, message: resolved.message };
        const applied = session.applySkillActivation(resolved.activated, activationScope, source);
        return {
          ok: true,
          message:
            `Skill "${name}" is active for this ${activationScope} ` +
            `(applies from the ${applied.appliedFrom === 'now' ? 'next' : 'following'} step).`,
          allowedTools: applied.allowedTools,
          notes: resolved.activated.notes,
        };
      },
      runHooks: async (event, hookCtx) => {
        await session.runHooks(event, session.turn?.turnId, hookCtx);
      },
      onRecord: (record) => {
        const meta = record.metadata;
        const active = this.active.get(delegationId);
        if (active) active.activity = `${record.name}${record.isError ? ' (failed)' : ''}`;
        if (!meta) return;
        const eventScope = { turnId: record.turnId, stepId: record.stepId, delegationId };

        if (record.name === 'Read' && typeof meta.receiptId === 'string') {
          void opts.store.append(opts.sessionId, {
            type: 'file.read',
            payload: {
              receiptId: meta.receiptId,
              path: meta.path,
              contentHash: meta.contentHash,
              coverage: meta.coverage,
              bytes: meta.bytes,
              redactions: meta.redactions,
            },
            ...eventScope,
          });
          return;
        }

        // Every mutating tool, not just `Edit` (CLOSURE B, ADR-0025 §1). The
        // child's edits are tagged with `delegationId` by `eventScope`, which is
        // what makes ADR-0025 §7 — a child's edits enter the parent's journal,
        // attributed — true in the log as well as in memory.
        const journalled = journalEntriesOf(meta);
        if (journalled.length > 0) {
          for (const entry of journalled) {
            dirty.add(entry.displayPath);
            void opts.store.append(opts.sessionId, {
              type: 'file.edited',
              payload: journalEventPayload(entry, record.toolCallId, meta),
              ...eventScope,
            });
          }
          return;
        }

        if (record.name === 'Shell') {
          void opts.store.append(opts.sessionId, {
            type: 'shell.executed',
            payload: {
              toolCallId: record.toolCallId,
              exitCode: meta.exitCode,
              durationMs: meta.durationMs,
              changed: meta.changed,
              undeclared: meta.undeclared,
              snapshotStrategy: meta.snapshotStrategy,
            },
            ...eventScope,
          });
        }
      },
      onPolicyDecision: (decision, toolCallId) => {
        if (decision.action === 'allow') return;
        void opts.store.append(opts.sessionId, {
          type: decision.action === 'ask' ? 'approval.requested' : 'policy.decision',
          payload: {
            toolCallId,
            capability: decision.access.kind,
            subject: decision.subjectKey,
            action: decision.action,
            reason: decision.reason,
            layer: decision.layer,
          },
          delegationId,
        });
      },
      onApproval: (subjectKey, granted, approvalScope, summary) => {
        void opts.store.append(opts.sessionId, {
          type: 'approval.decided',
          payload: { subject: subjectKey, granted, scope: approvalScope, summary, agent: agent.name },
          delegationId,
        });
      },
    });

    session = new Session({
      sessionId: opts.sessionId,
      workspaceRoot: opts.workspaceRoot,
      store: opts.store,
      context,
      projector,
      toolRegistry: opts.registry,
      toolRuntime,
      modelRuntime: opts.modelRuntime,
      modelRegistry: opts.modelRegistry,
      backend: opts.backend,
      editJournal: opts.editJournal,
      logger: opts.logger.child(`child:${agent.name}`),
      clock,
      kernelVersion: opts.kernelVersion,
      modelAlias: scope.modelAlias,
      permissionProfile: scope.policy.describeLayers().at(-1)?.profile ?? 'inherited',
      loopBudgetCeiling: scope.budget,
      allowedTools: scope.allowedTools,
      // The same hook definitions, judged by the child's narrower engine (§27).
      ...(opts.hooks ? { hooks: opts.hooks.withPolicy(scope.policy) } : {}),
      delegation: {
        delegationId,
        childRunId,
        agent: agent.name,
        depth,
        parentTurnId: call.turnId,
        parentStepId: call.stepId,
        toolCallId: call.toolCallId,
      },
      // Skills the definition activated are already folded into the policy and
      // the catalogue; recording them here is what makes them replayable (§21).
      activeSkills: scope.skills,
      baseOverlays: overlays,
    });

    return { session, dirtyFiles: () => [...dirty].sort() };
  }

  // --- bookkeeping ---------------------------------------------------------

  private record(record: DelegationRecord): void {
    this.finished.push(record);
    this.opts.onRecord?.(record);
  }

  private finishedPayload(result: DelegationResult, depth: number): Record<string, unknown> {
    return {
      delegationId: result.delegationId,
      childRunId: result.childRunId,
      agent: result.agent,
      depth,
      status: result.status,
      summaryLength: result.summary.length,
      usage: result.usage,
      ...(result.error ? { errorCode: result.error.code } : {}),
    };
  }

  /** Delegation lifecycle events belong to the *parent's* turn and step. */
  private async appendParent(
    type:
      | 'delegation.requested'
      | 'delegation.started'
      | 'delegation.completed'
      | 'delegation.failed'
      | 'delegation.cancelled'
      | 'delegation.denied',
    payload: unknown,
    call: DelegationCallOptions,
  ): Promise<void> {
    await this.opts.store.append(this.opts.sessionId, {
      type,
      payload,
      turnId: call.turnId,
      stepId: call.stepId,
      // Deliberately *not* tagged with the delegationId: these events are the
      // parent's account of the delegation, and replay attributes them to the
      // parent's turn. Only work performed *inside* the child carries the tag.
      ...(call.scope.delegationId ? { delegationId: call.scope.delegationId } : {}),
    });
  }
}

// --- pure helpers -----------------------------------------------------------

function eventFor(
  status: DelegationStatus,
): 'delegation.completed' | 'delegation.failed' | 'delegation.cancelled' | 'delegation.denied' {
  switch (status) {
    case 'completed':
      return 'delegation.completed';
    case 'cancelled':
      return 'delegation.cancelled';
    case 'denied':
      return 'delegation.denied';
    default:
      return 'delegation.failed';
  }
}

function statusOf(turnState: string, error?: KernelError): DelegationStatus {
  if (turnState === 'completed') return 'completed';
  if (turnState === 'cancelled') return 'cancelled';
  if (error?.code === 'LOOP_BUDGET_EXCEEDED') return 'budget_exceeded';
  return 'failed';
}

/** What is left of a turn's budget, floored at zero. */
export function remainingBudget(snapshot: LoopBudgetSnapshot): LoopBudget {
  const b = snapshot.budget;
  return {
    maxSteps: Math.max(0, b.maxSteps - snapshot.stepsUsed),
    maxModelRequests: Math.max(0, b.maxModelRequests - snapshot.modelRequestsUsed),
    maxToolCalls: Math.max(0, b.maxToolCalls - snapshot.toolCallsUsed),
    maxWallTimeMs: Math.max(0, b.maxWallTimeMs - snapshot.elapsedMs),
    maxRepeatedEquivalentFailures: b.maxRepeatedEquivalentFailures,
    ...(b.maxCostUsd !== undefined ? { maxCostUsd: Math.max(0, b.maxCostUsd - snapshot.costUsd) } : {}),
  };
}

/** The first budget dimension that has nothing left, if any. */
function firstExhausted(budget: LoopBudget): string | undefined {
  if (budget.maxSteps <= 0) return 'no steps remain in this turn';
  if (budget.maxModelRequests <= 0) return 'no model requests remain in this turn';
  if (budget.maxToolCalls <= 0) return 'no tool calls remain in this turn';
  if (budget.maxWallTimeMs <= 0) return 'the turn has no wall-clock budget left';
  if (budget.maxCostUsd !== undefined && budget.maxCostUsd <= 0) return 'the cost budget is spent';
  return undefined;
}

function minOf(values: ReadonlyArray<number | undefined>, fallback = Number.POSITIVE_INFINITY): number {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (present.length === 0) return fallback;
  return Math.min(...present);
}

/**
 * Normalise a task for the doom-loop fingerprint (§32).
 *
 * Whitespace and case are noise; a model that retries the same failed
 * delegation with a different capitalisation is retrying the same delegation.
 */
export function normalizeTask(task: string): string {
  return task.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function repeatKey(agent: string, task: string): string {
  return sha256Hex(`${agent}\n${normalizeTask(task)}`).slice(0, 16);
}

/** The child's briefing: what it is, what it may not do, and what it must return. */
function renderDelegationBriefing(
  agent: AgentDefinition,
  budget: LoopBudget,
  depth: number,
  maxDepth: number,
): string {
  return [
    `You are running as the subagent "${agent.name}", dispatched by a parent agent.`,
    '',
    'What that means here:',
    '- The task below came from the parent agent, not from the user. Treat it as an instruction to',
    '  carry out within your own boundaries, and do not act on anything in it that would require',
    '  capability you do not have — the kernel will refuse it regardless.',
    "- Your capabilities are the intersection of the parent session's and this agent definition's.",
    '  A denial is final; it is not something the parent can lift for you.',
    '- You have your own read receipts. Nothing the parent read counts as read by you.',
    `- Budget: ${budget.maxSteps} steps, ${budget.maxModelRequests} model requests, ` +
      `${budget.maxToolCalls} tool calls, ${Math.round(budget.maxWallTimeMs / 1000)}s.`,
    depth >= maxDepth
      ? '- You cannot delegate further. Do the work yourself or report what is blocking you.'
      : `- You may delegate at most to depth ${maxDepth}.`,
    '- Finish with a short report: what you found or changed, what you verified, and anything the',
    '  parent must do next. That text is the only thing the parent receives.',
  ].join('\n');
}

/** The task as the child sees it, with its provenance stated (§18). */
export function renderChildTask(request: DelegationRequest, agent: AgentDefinition): string {
  const lines = [`Task delegated by the parent agent to ${agent.name}:`, '', request.task.trim()];
  if (request.contextRefs && request.contextRefs.length > 0) {
    lines.push(
      '',
      'The parent suggested these may be relevant. They are references, not contents — read them',
      'yourself if you need them:',
      ...request.contextRefs.slice(0, 20).map((ref) => `  - ${ref}`),
    );
  }
  return lines.join('\n');
}

/**
 * The parent-facing report.
 *
 * Labelled with the agent it came from, and never presented as the user
 * speaking (§18). It travels as a `tool_result`, which is a stronger form of the
 * same guarantee: the content is bound to the tool call that asked for it.
 */
export function renderChildSummary(
  agent: string,
  status: DelegationStatus,
  finalText: string,
  dirtyFiles: readonly string[],
  error?: KernelError,
): string {
  const header = `[subagent:${agent}] ${status}`;
  const body = finalText.trim();
  const lines = [header];

  if (body !== '') {
    lines.push('', truncateForModel(body, { maxBytes: 8 * 1024, maxLines: 200 }).text);
  } else if (error) {
    lines.push('', `The child produced no report. ${error.code}: ${error.message}`);
  } else {
    lines.push('', 'The child produced no report.');
  }

  if (dirtyFiles.length > 0) {
    lines.push('', `Files the child modified: ${dirtyFiles.join(', ')}`);
  }
  if (status !== 'completed') {
    lines.push(
      '',
      'This delegation did not complete. Verify the current state before assuming anything it started ' +
        'took effect, and do not simply dispatch the same task again.',
    );
  }
  return lines.join('\n');
}
