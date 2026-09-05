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
import { PROJECT_DIR } from '../app.ts';
import { estimateTokens } from '../util/text.ts';
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
  type ReasoningEffort,
} from '../model/ir.ts';
import type { ModelRegistry, ResolvedModelProfile } from '../model/profiles.ts';
import { addUsage, emptyUsage, estimateCost, resolveUsage, type UsageReport } from '../model/usage.ts';
import { CONTEXT_SAFETY_MARGIN_TOKENS, ModelRegistry as Registry } from '../model/profiles.ts';
import { ContextEngine, type GoalState } from '../context/context-engine.ts';
import { ContextProjector, type ContextOverlay } from '../context/projector.ts';
import { compact, needsCompaction } from '../context/compaction.ts';
import type { EditJournal } from '../edit/atomic-write.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { ToolRuntime, syntheticInterruptedResult } from '../tools/runtime.ts';
import type { ToolResult } from '../tools/contract.ts';
import type { ExecutionBackend } from '../execution/backend.ts';
import type { SessionStore, SessionMetadata } from './store.ts';
import { sessionTitle } from './resume.ts';
import type {
  BudgetExceededPayload,
  ModelRequestPayload,
  ModelResponsePayload,
  TurnStartedPayload,
} from './events.ts';
import { Turn } from './turn.ts';
import type { DelegationOutcomeRecord, SessionTerminalState, TurnOutcomeRecord } from './terminal-state.ts';
import { renderHookOutput, type HookEvent, type HookRunner } from '../extensions/hooks.ts';
import {
  renderSkillInstructions,
  type ActivatedSkill,
  type SkillActivationScope,
  type SkillActivationSource,
} from '../extensions/skills.ts';
import type { PolicyLayer } from '../policy/policy-engine.ts';
import { ApprovalModeState, weakensApproval, type ApprovalMode } from '../policy/approval-mode.ts';
import type { DelegationRecord } from './delegation.ts';
import type { TurnOrigin } from './turn.ts';
import {
  DEFAULT_LOOP_BUDGET,
  describeBudgetLimit,
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
  /**
   * `[model] effort`, when configuration set one.
   *
   * An override rather than the effective level: the profile's own default and
   * its ceiling still apply, and `ModelRegistry.effortFor` is the only place
   * those three meet. Absent means every profile runs at its own default.
   */
  effortOverride?: ReasoningEffort;
  permissionProfile: string;
  /**
   * The approval mode, shared with the gate that reads it (spec §11.4).
   *
   * Passed in rather than constructed here because the approval prompter is built
   * before this session is, and both have to see the same value. Absent means a
   * session that is always in `manual` — which is what a delegated child gets:
   * see the note on `planModeLayer`.
   */
  approvalModeState?: ApprovalModeState;
  /**
   * The read-only layer to intersect while in plan mode.
   *
   * Supplied by the kernel because building a permission profile needs the
   * workspace root, the agent tmp directory and the declared generated paths —
   * all of which the kernel already resolved and the session has no business
   * re-deriving. Absent means plan mode has no layer to push, so it narrows
   * nothing: correct for a delegated child, whose capabilities were already
   * intersected by `DelegationService` before it existed.
   */
  planModeLayer?: PolicyLayer;
  /** Session-level ceiling; `/loop` may narrow but never widen it. */
  loopBudgetCeiling?: LoopBudget;
  /** Tool names the active agent/skill permits. */
  allowedTools?: readonly string[];
  /** Lifecycle hooks (spec §18.1). Absent means no project hooks are configured. */
  hooks?: HookRunner;
  /**
   * Set when this session *is* a delegated child scope (ADR-0013).
   *
   * Its only effects are provenance: every event this session appends carries the
   * delegation id, and the turn it runs records the agent it belongs to. The
   * capability narrowing happened before construction, in `DelegationService` —
   * a child is not less privileged because of this field.
   */
  delegation?: ChildScopeInfo;
  /**
   * Skills already folded into the policy and catalogue at construction.
   *
   * Reported and recorded, never re-applied: an agent definition's skills are
   * intersected by `DelegationService` before the child exists, and applying them
   * twice would be harmless but would make the effective set impossible to reason
   * about from one place.
   */
  activeSkills?: readonly ActivatedSkill[];
  /** Instruction overlays present before any activation (agent, delegation brief). */
  baseOverlays?: readonly ContextOverlay[];
  /**
   * Facts a *previous* process recorded, reconstructed from the event log.
   *
   * Without this the live half of the replay gate would only know about work done
   * since the restart while the log knows about all of it, so a resumed session
   * could never satisfy the gate — and "the log is a faithful record" is exactly
   * the property resume depends on.
   *
   * Worth being precise about what this does and does not prove. The seed comes
   * from `replayTerminalState`, so for *pre-restart* facts the two halves share a
   * source and the comparison is not independent. What stays independent is
   * everything the new process does, and the pre-restart half was already compared
   * independently before the shutdown. The soak suite checks both halves in that
   * order for exactly this reason.
   */
  resumedState?: SessionTerminalState;
  /**
   * Cumulative usage the previous process persisted (`session.json`).
   *
   * The event log can rebuild *counts* — how many requests, which tool calls —
   * but token totals and cost are only aggregated in the metadata snapshot, and
   * recomputing them from per-request events would be a second, drifting
   * implementation. So counts come from the log and money comes from the
   * snapshot, and the soak asserts the two agree where they overlap.
   */
  resumedUsage?: SessionMetadata['usage'];
  onEvent?: (type: string, payload: unknown) => void;
}

/** Provenance that joins a child session back to the call that created it. */
export interface ChildScopeInfo {
  delegationId: string;
  childRunId: string;
  agent: string;
  depth: number;
  parentTurnId: TurnId;
  parentStepId: StepId;
  toolCallId: string;
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
  private effortOverride: ReasoningEffort | undefined;
  private readonly approvalModeState: ApprovalModeState;
  private loopCeiling: LoopBudget;
  private turnBudgetOverride: Partial<LoopBudget> | undefined;
  private currentTurn: Turn | undefined;
  private abortController: AbortController | undefined;
  /**
   * The first thing the user asked, kept as this session's title (ADR-0029).
   *
   * What `-r` with no id shows, because an id identifies nothing to a human. The
   * first user turn rather than the latest: it is what the session *is about*,
   * and a title that changed under you every turn would be no easier to
   * recognise than the id. Redacted on the way to disk like everything else the
   * store writes.
   */
  private firstUserInput: string | undefined;
  /** One entry per finished turn; the live half of the replay gate (§4.2). */
  private readonly turnOutcomes: TurnOutcomeRecord[] = [];
  /**
   * Tool calls issued and answered, accumulated as they happen.
   *
   * Deriving these from `context.history()` was a latent defect the delegation
   * tests exposed: compaction *rewrites* the conversation, so a tool exchange in
   * the summarised head vanished from the live half of the replay gate while the
   * event log kept it. The gate then failed with a divergence that pointed at
   * delegation and was really about compaction — and would have fired for any
   * compacted tool call, delegated or not, if a test had ever put one there.
   *
   * Accumulating them mirrors the log by construction: both are append-only
   * records of what happened, rather than views of what is still in the window.
   */
  private readonly issuedToolCalls = new Set<string>();
  private readonly answeredToolCalls = new Set<string>();
  /** Facts carried over from a resumed log; see `SessionOptions.resumedState`. */
  private readonly seededDelegations: DelegationOutcomeRecord[] = [];
  private readonly seededDirtyFiles: string[] = [];
  private seededCompactions = 0;
  private compactionCount = 0;
  private stepsTotal = 0;
  /** Finished delegations, in order. The live half of the §28 replay gate. */
  private readonly delegations: DelegationRecord[] = [];
  /** Budget a child spent, not yet charged to the running turn's tracker. */
  private pendingCharge = { modelRequests: 0, toolCalls: 0, costUsd: 0 };
  /** Cost this session spent *directly*, excluding delegated work (§14). */
  private directCostUsd = 0;
  private delegatedCostUsd = 0;
  /**
   * Model requests whose cost could not be priced at all.
   *
   * Counted because the total on its own cannot express them. `estimateCost`
   * already returns `provenance: 'unknown'` when a profile has no pricing, and
   * this session already refuses to add such a figure to the running total — so
   * the total stays at `0`, and `0` is indistinguishable from "this was free".
   * The CLI printed `$0.0000` for a session that had spent real money against a
   * model nobody had priced, which is the one number people paste into a report.
   *
   * `ModelProfile.pricing` says "unset means cost is reported as `unknown`
   * (§18)". This is what makes that true above the model layer as well.
   */
  private unpricedRequests = 0;
  /** Once per session; see . */
  private toolCatalogueWarned = false;
  /** Skill activations in force, and the ones staged for the next step (§22). */
  private skillEntries: Array<{ activated: ActivatedSkill; scope: SkillActivationScope }> = [];
  private pendingSkillEntries: Array<{ activated: ActivatedSkill; scope: SkillActivationScope }> = [];
  private effectiveTools: readonly string[] | undefined;
  /** Cumulative usage with per-field provenance (§17). */
  private usageReport = emptyUsage();
  private usage: SessionMetadata['usage'] = {
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
    this.effortOverride = opts.effortOverride;
    this.approvalModeState = opts.approvalModeState ?? new ApprovalModeState();
    this.loopCeiling = opts.loopBudgetCeiling ?? DEFAULT_LOOP_BUDGET;
    this.effectiveTools = opts.allowedTools;

    const resumed = opts.resumedState;
    if (resumed) {
      for (const id of resumed.toolCalls) this.issuedToolCalls.add(id);
      for (const id of resumed.answeredToolCalls) this.answeredToolCalls.add(id);
      this.turnOutcomes.push(...resumed.turns);
      this.seededDelegations.push(...resumed.delegations);
      this.seededDirtyFiles.push(...resumed.dirtyFiles);
      this.seededCompactions = resumed.compactions;
    }

    if (opts.resumedUsage) {
      this.usage = { ...opts.resumedUsage };
      // Restore the *split*, not just the total.
      //
      // Found by the alpha.5 dogfood (D-003). `usage.costUsd` was restored here
      // and `directCostUsd` was not, so after a restart `/status` printed a
      // usage line of $0.0033 directly above a cost line of $0.0006 — the same
      // session, two totals, and the smaller one labelled "total". Anything
      // reading the breakdown to decide whether a budget was spent got the
      // post-restart figure only.
      this.delegatedCostUsd = opts.resumedUsage.delegatedCostUsd ?? 0;
      this.directCostUsd = Math.max(0, opts.resumedUsage.costUsd - this.delegatedCostUsd);
    } else if (resumed) {
      this.usage.modelRequests = resumed.modelRequests;
      this.usage.toolCalls = resumed.toolCallCount;
    }
    // Overlays are owned here rather than by the projector, because skill
    // activation has to be able to recompute the whole list between steps and a
    // second source of truth would drift from it.
    this.refreshOverlays();
  }

  // --- control-plane surface (called by ControlPlane, never by the model) ---

  get activeModelAlias(): string {
    return this.pendingModelAlias ?? this.modelAlias;
  }

  get approvalMode(): ApprovalMode {
    return this.approvalModeState.mode;
  }

  /**
   * Change the approval mode, and re-derive what the policy engine enforces.
   *
   * Applied immediately rather than staged like `selectModel`, and the asymmetry
   * is deliberate. A model change mid-step would mean a turn whose steps ran on
   * different models, which makes the transcript a lie. A mode change is about
   * the *next* question anybody is asked, so applying it at once is the only
   * reading that matches what the user just pressed — a Shift-Tab into plan mode
   * that let one more write through would be the surprising version.
   *
   * Returns the disclosure when the new mode is weaker than the default, so the
   * caller can print it. §12 requires the disclosure at startup; a mode that can
   * be switched at runtime owes it on every switch as well, because "it was in
   * the banner an hour ago" is not disclosure.
   */
  setApprovalMode(mode: ApprovalMode): { changed: boolean; previous: ApprovalMode; disclosure?: string } {
    const result = this.approvalModeState.set(mode);
    if (result.changed) this.recomputeNarrowing();
    return {
      ...result,
      // Only what the summary does not already say. The first version restated
      // the summary and then listed `stillAsks` again, which the caller had
      // already printed — three copies of the same sentence, because both sides
      // were composing the same two pieces. The summary carries the capability
      // list (it is generated from the table); this carries the ceiling.
      ...(weakensApproval(mode)
        ? {
            disclosure:
              'Nothing a policy layer denied becomes permitted by this: privilege escalation, ' +
              'protected paths and host-environment reads stay refused.',
          }
        : {}),
    };
  }

  /**
   * The effort override, and the level each registered alias resolves to.
   *
   * Both, because the override alone does not answer the question `/effort` is
   * asked: an override of `max` still reaches Haiku as `high`, and a screen that
   * printed only the override would be telling the user something that is not
   * true of the model actually answering.
   */
  effortState(): {
    override: ReasoningEffort | undefined;
    resolved: Array<{ alias: string; effort: ReasoningEffort | 'provider default' }>;
  } {
    const resolved = this.opts.modelRegistry.listAliases().map((entry) => {
      const model = this.opts.modelRegistry.resolve(entry.alias);
      const level = model ? Registry.effortFor(model.profile, this.effortOverride) : undefined;
      return { alias: entry.alias, effort: level ?? ('provider default' as const) };
    });
    return { override: this.effortOverride, resolved };
  }

  /**
   * Change how hard the model thinks.
   *
   * Applies from the next request, not to the one in flight — the same rule as
   * `selectModel`, for the same reason: a request already on the wire has its
   * effort baked into the body, and pretending otherwise would make `/effort`
   * report a level the current answer was not produced at.
   */
  setEffortOverride(effort: ReasoningEffort | undefined): void {
    this.effortOverride = effort;
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

  /**
   * The budget the *next* turn will actually run under.
   *
   * The ceiling narrowed by `/loop` and by any active skill — computed through
   * the same `applyCeiling` the loop uses, so the two cannot disagree. `/status`
   * read `budgetCeiling` and reported 16 steps to a session that `/loop start
   * --max-steps 2` had narrowed to 2, which is the number the turn then stopped
   * at. A budget nobody can see is a budget that looks like a bug when it fires.
   */
  get effectiveBudget(): LoopBudget {
    const override = this.budgetOverride();
    if (!override) return this.loopCeiling;
    const tracker = new LoopBudgetTracker(this.loopCeiling, () => this.clock.now());
    tracker.applyCeiling(override, this.loopCeiling);
    return tracker.current;
  }

  /** What narrowed `effectiveBudget` below the ceiling, for the surfaces that say so. */
  get budgetNarrowedBy(): string | undefined {
    const skills = [...this.skillEntries, ...this.pendingSkillEntries].filter(
      (e) => typeof e.activated.maxSteps === 'number',
    );
    const sources = [
      ...(this.turnBudgetOverride ? ['/loop start'] : []),
      ...skills.map((e) => `skill "${e.activated.skill.name}"`),
    ];
    return sources.length === 0 ? undefined : sources.join(' and ');
  }

  get usageSnapshot(): typeof this.usage {
    return { ...this.usage };
  }

  /** Steps this session has taken across all its turns, for `/status`. */
  get stepsUsed(): number {
    return this.stepsTotal;
  }

  /**
   * Cost split three ways (§14).
   *
   * alpha.4 only makes delegated cost *measurable*; nothing routes on it yet.
   * Reporting the split rather than a total is what makes the later question —
   * "does delegation pay for itself?" — answerable from recorded runs instead of
   * from a new experiment.
   */
  /**
   * What was spent, and how much of the session that figure actually covers.
   *
   * `unpricedRequests` is part of the answer, not a footnote to it: with any
   * unpriced request the total is a floor rather than a cost, and a caller that
   * prints it as a cost is making a claim the kernel did not.
   */
  get costBreakdown(): {
    directUsd: number;
    delegatedUsd: number;
    totalUsd: number;
    unpricedRequests: number;
  } {
    return {
      directUsd: this.directCostUsd,
      delegatedUsd: this.delegatedCostUsd,
      totalUsd: this.directCostUsd + this.delegatedCostUsd,
      unpricedRequests: this.unpricedRequests,
    };
  }

  /** Finished delegations, for `/status`, the eval schema and the replay gate. */
  delegationRecords(): readonly DelegationRecord[] {
    return this.delegations;
  }

  /** The catalogue in force, after every skill intersection. */
  get effectiveAllowedTools(): readonly string[] {
    return this.effectiveTools ?? this.opts.toolRegistry.names();
  }

  /** Skills in force, including any an agent definition pre-applied. */
  activeSkills(): Array<{ name: string; scope: SkillActivationScope; preApplied: boolean }> {
    return [
      ...(this.opts.activeSkills ?? []).map((s) => ({
        name: s.skill.name,
        scope: 'run' as SkillActivationScope,
        preApplied: true,
      })),
      ...[...this.skillEntries, ...this.pendingSkillEntries].map((e) => ({
        name: e.activated.skill.name,
        scope: e.scope,
        preApplied: false,
      })),
    ];
  }

  /** The delegation scope this session runs in, if it is a child. */
  get childScope(): ChildScopeInfo | undefined {
    return this.opts.delegation;
  }

  /**
   * Apply a skill activation (alpha.4 §22).
   *
   * Staged, not immediate. A step's context and tool catalogue are frozen for the
   * duration of its model request (invariant 2), so an activation that arrived
   * mid-step takes effect on the next one — the same rule `/model use` follows.
   * The event is appended now, because what was *asked for* is part of the record
   * even if the turn ends before it applies.
   */
  applySkillActivation(
    activated: ActivatedSkill,
    scope: SkillActivationScope,
    source: SkillActivationSource,
  ): { allowedTools: string[]; appliedFrom: 'now' | 'next-step' } {
    const already = [...this.skillEntries, ...this.pendingSkillEntries].some(
      (e) => e.activated.skill.name === activated.skill.name,
    );
    if (!already) this.pendingSkillEntries.push({ activated, scope });

    const sampling = this.currentTurn?.state === 'sampling';
    if (!sampling) this.applyPendingSkills();

    void this.append('skill.activated', {
      skill: activated.skill.name,
      scope,
      source,
      allowedTools: this.projectedTools(),
      ...(activated.layer ? { policyLayer: activated.layer.name } : {}),
      ...(activated.maxSteps !== undefined ? { maxSteps: activated.maxSteps } : {}),
      notes: activated.notes,
    });

    return { allowedTools: this.projectedTools(), appliedFrom: sampling ? 'next-step' : 'now' };
  }

  /**
   * Record a finished delegation (§13, §14, §28).
   *
   * Three things happen here, and the order matters less than the fact that all
   * three happen in one place: the child's usage is added to the root's, so the
   * session's totals include delegated work; the same usage is queued as a charge
   * against the running turn's budget, so a parent cannot buy unlimited work by
   * delegating; and the record is kept for the terminal state, so replay has
   * something to be compared against.
   */
  recordDelegation(record: DelegationRecord): void {
    this.delegations.push(record);

    this.usage.modelRequests += record.usage.modelRequests;
    this.usage.toolCalls += record.usage.toolCalls;
    // Tokens too, or the totals describe different sets of requests: the count
    // would include the child and the tokens would not.
    this.usage.inputTokens += record.usage.inputTokens;
    this.usage.outputTokens += record.usage.outputTokens;
    this.usage.cachedInputTokens += record.usage.cachedInputTokens;
    this.pendingCharge.modelRequests += record.usage.modelRequests;
    this.pendingCharge.toolCalls += record.usage.toolCalls;

    const cost = record.usage.estimatedCostUsd;
    if (cost !== undefined && cost > 0) {
      this.usage.costUsd += cost;
      this.delegatedCostUsd += cost;
      this.pendingCharge.costUsd += cost;
    }
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
    const toolCalls = new Set<string>(this.issuedToolCalls);
    const answered = new Set<string>(this.answeredToolCalls);

    const goal = this.context.goal;

    // Delegated work belongs to the root's totals (§13, §14): the event log
    // contains the child's `tool.call` and `model.request.started` events, so a
    // replay that counted them while the live state did not would diverge — and
    // the honest reading is that a root task's cost includes its children's.
    // The per-delegation breakdown is kept beside the union so a divergence names
    // the scope it happened in.
    const delegations: DelegationOutcomeRecord[] = this.delegations.map((record) => ({
      delegationId: record.delegationId,
      agent: record.agent,
      depth: record.depth,
      status: record.status,
      childTurns: record.child.turns.map((t) => t.state),
      childToolCalls: [...record.child.toolCalls].sort(),
      childModelRequests: record.child.modelRequests,
      childCompactions: record.child.compactions,
    }));

    for (const record of this.delegations) {
      for (const id of record.child.toolCalls) toolCalls.add(id);
      for (const id of record.child.answeredToolCalls) answered.add(id);
    }

    return {
      turns: [...this.turnOutcomes],
      ...(goal
        ? { goal: { objective: goal.objective, status: goal.status, criteria: [...goal.criteria] } }
        : {}),
      toolCalls: [...toolCalls].sort(),
      answeredToolCalls: [...answered].sort(),
      dirtyFiles: [...new Set([...this.seededDirtyFiles, ...this.editJournal.dirtyPaths()])].sort(),
      modelRequests: this.usage.modelRequests,
      toolCallCount: toolCalls.size,
      compactions:
        this.seededCompactions +
        this.compactionCount +
        this.delegations.reduce((n, d) => n + d.child.compactions, 0),
      delegations: [...this.seededDelegations, ...delegations],
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

  async runTurn(input: string, origin: TurnOrigin = 'user'): Promise<TurnOutcome> {
    if (origin === 'user') this.firstUserInput ??= sessionTitle(input);

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
    const override = this.budgetOverride();
    if (override) budget.applyCeiling(override, this.loopCeiling);

    const failures = new FailureTracker(budget.current.maxRepeatedEquivalentFailures);

    await this.append(
      'turn.started',
      {
        input,
        origin,
        ...(this.opts.delegation ? { agent: this.opts.delegation.agent } : {}),
      } satisfies TurnStartedPayload,
      turn.turnId,
    );

    if (origin === 'user') this.context.appendUser(input);
    else if (origin === 'control') this.context.appendControlResult(input);
    // A delegated task is not the user speaking (§18). It enters the child's
    // conversation as an injection naming the parent, so the child model can weigh
    // it as an instruction from another agent — which is what it is.
    else if (origin === 'delegation') {
      this.context.appendInjection(`delegation:${this.opts.delegation?.agent ?? 'parent'}`, input);
    }

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

    // A turn-scoped skill stops applying here, whatever the outcome. Leaving one
    // in force after a failed turn would silently narrow the next one.
    await this.expireTurnScopedSkills();

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
        // Named, bounded and recoverable, in that order. `Turn stopped: step
        // limit reached.` was all of it: it did not say what the limit was, that
        // it is per *turn*, that every edit already made is still there, or that
        // saying "continue" buys a fresh budget. Three of those four are the
        // difference between "the tool broke" and "the tool stopped where I told
        // it to". The delegation refusal has named its remedy since alpha.4; this
        // one, which far more people meet, named nothing.
        const limit = describeBudgetLimit(violation.budget, violation.limit);
        turn.fail(
          kernelError(
            'LOOP_BUDGET_EXCEEDED',
            `Turn stopped: ${violation.message} — ${limit.value} per turn. ` +
              'Everything done so far is kept. Say "continue" to carry on with a fresh budget, ' +
              `raise it for this session with /loop start, or set [loop] ${limit.configKey} in ` +
              `${PROJECT_DIR}/config.toml.`,
            {
              blame: 'kernel',
              safeDetails: { budget: violation.budget, limit: violation.limit },
            },
          ),
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

      // Same rule for a skill activated during the previous step: it narrows the
      // catalogue and the policy from *this* step onward, never retroactively.
      if (this.pendingSkillEntries.length > 0) {
        this.applyPendingSkills();
        const narrowed = this.budgetOverride();
        if (narrowed) budget.applyCeiling(narrowed, this.loopCeiling);
      }

      // What the model is spending, before it spends the next one.
      //
      // The budget was enforced against a model that had never been told it
      // existed: it could not pace itself, could not decide to summarise instead
      // of reading one more file, and met the ceiling as a cut-off mid-sentence.
      // The user then saw a turn that stopped for no reason it had given. Steps
      // and tool calls only — the wall clock would put a moving number in the
      // prompt and make an identical turn non-deterministic (§31).
      const inForce = budget.current;
      this.context.addFact({
        id: 'turn-budget',
        priority: 'normal',
        text:
          `Turn budget: this is step ${budget.steps + 1} of ${inForce.maxSteps}, and ` +
          `${budget.toolCalls} of ${inForce.maxToolCalls} tool calls are spent. When either runs out ` +
          'the turn stops where it stands. Before that happens, say what you found and what is left — ' +
          'a stopped turn with no report is the one outcome the user cannot use.',
      });

      const model = this.resolveModel();
      this.checkToolCatalogueFitsMargin(model);
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
          // Deliberately *not* transitioning back to 'preparing' here: the top of
          // the loop does that, and doing it twice is an illegal
          // preparing -> preparing transition. That threw INTERNAL_ERROR on the
          // first overflow, so the compact-and-retry this block exists to
          // perform never actually happened.
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
      if (cost.provenance === 'unknown') {
        this.unpricedRequests += 1;
      } else {
        this.usage.costUsd += cost.usd;
        this.directCostUsd += cost.usd;
      }

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
        this.issuedToolCalls.add(call.id);
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
        this.answeredToolCalls.add(result.toolCallId);
        await this.append(
          'tool.result',
          {
            toolCallId: result.toolCallId,
            isError: result.isError,
            // *Why* it failed, not just that it did.
            //
            // The renderer has always read `errorCode` off this payload and the
            // payload has never carried one, so both halves were dead: the
            // result line could not mark a refusal, and the turn footer counted
            // a refused call as one that ran. A short code, never content — the
            // same thing `policy.decision` already records.
            ...(outcome.errorCodes.get(result.toolCallId) === undefined
              ? {}
              : { errorCode: outcome.errorCodes.get(result.toolCallId) }),
            contentBytes: Buffer.byteLength(result.content, 'utf8'),
            // Absent unless the host asked for it (ADR-0031).
            ...(outcome.previews.get(result.toolCallId) === undefined
              ? {}
              : { preview: outcome.previews.get(result.toolCallId) }),
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

      // Budget a child spent is charged to the parent's turn here, after the
      // batch that dispatched it (§13). Without this a parent could buy unbounded
      // work by delegating: the child's own ceiling was respected, but nothing
      // subtracted it from the parent's.
      if (this.pendingCharge.modelRequests > 0 || this.pendingCharge.toolCalls > 0) {
        budget.modelRequests += this.pendingCharge.modelRequests;
        budget.toolCalls += this.pendingCharge.toolCalls;
        budget.costUsd += this.pendingCharge.costUsd;
        this.pendingCharge = { modelRequests: 0, toolCalls: 0, costUsd: 0 };
      }

      budget.steps += 1;
      this.stepsTotal += 1;
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
    // Resolved per request rather than cached on the session, because the profile
    // is part of the answer and `/model use` can change the profile between
    // steps. Caching it is how a session ends up sending Haiku the level it
    // resolved for Opus.
    const effort = Registry.effortFor(step.model.profile, this.effortOverride);
    if (effort !== undefined) request.effort = effort;
    return request;
  }

  /**
   * Run one tool on the **user's** behalf, from the control plane (ADR-0026 §6).
   *
   * `/undo` is the first caller. The step context is synthesised rather than
   * borrowed from a turn, because a slash command may be typed when no turn is
   * running — but everything the runtime does with it below is the ordinary
   * path: schema validation, the policy decision, the approval prompt and a
   * narrowed executor. There is no shortcut here, only a different origin.
   */
  async runControlTool(name: string, args: unknown): Promise<ToolResult> {
    const step = freezeStepContext({
      sessionId: this.sessionId,
      turnId: this.turn?.turnId ?? (newTurnId(this.clock.now()) as TurnId),
      stepId: newStepId(this.clock.now()),
      context: this.opts.projector.project(this.context, this.context.repository.facts),
      tools: this.opts.toolRegistry.view(this.effectiveTools ? { allowed: this.effectiveTools } : {}),
      model: this.resolveModel(),
      execution: this.opts.backend.environment,
      loopBudget: new LoopBudgetTracker(this.budgetCeiling, () => this.clock.now()).snapshot(),
      frozenAt: this.clock.now(),
    });
    return this.opts.toolRuntime.executeControlCall(name, args, step, new AbortController().signal);
  }

  private freezeStep(turn: Turn, model: ResolvedModelProfile, budget: LoopBudgetTracker): StepContext {
    const snapshot = this.opts.projector.project(this.context, this.context.repository.facts);
    const tools = this.opts.toolRegistry.view(this.effectiveTools ? { allowed: this.effectiveTools } : {});

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

  /**
   * What the tool catalogue costs — the part of every request nothing counts.
   *
   * `ContextEngine.estimatedTokens` covers the system prompt and the messages.
   * The tool schemas go on the wire too and are not in that number, which is why
   * a live first request measured 845 estimated against 3,436 billed.
   *
   * That gap is *supposed* to be absorbed by `CONTEXT_SAFETY_MARGIN_TOKENS`, and
   * today it is. This exists to check that it still is, because the catalogue
   * grows — an MCP server adds its tools to it — and the margin does not.
   */
  private toolCatalogueTokens(): number {
    const view = this.opts.toolRegistry.view(this.effectiveTools ? { allowed: this.effectiveTools } : {});
    return estimateTokens(JSON.stringify(view.tools));
  }

  /**
   * Warn when the tool catalogue has outgrown the margin that hides it.
   *
   * Once per session, not per step: the catalogue only changes when a skill
   * narrows it, and narrowing can only make it smaller. Left implicit, the
   * failure mode is a provider length error on a session the kernel believed was
   * comfortably inside its window.
   */
  private checkToolCatalogueFitsMargin(model: ResolvedModelProfile): void {
    if (this.toolCatalogueWarned) return;
    this.toolCatalogueWarned = true;

    const catalogue = this.toolCatalogueTokens();
    if (catalogue <= CONTEXT_SAFETY_MARGIN_TOKENS) return;

    this.logger.warn('the tool catalogue no longer fits the context safety margin', {
      catalogueTokens: catalogue,
      safetyMarginTokens: CONTEXT_SAFETY_MARGIN_TOKENS,
      model: model.alias,
      detail:
        'Every request carries the tool schemas and the context estimate does not count them. ' +
        'While the catalogue fits inside the safety margin the estimate stays conservative; past ' +
        'that point compaction triggers later than the real window allows, and the symptom is a ' +
        'provider length error rather than anything this kernel reports.',
    });
  }

  private async maybeCompact(turn: Turn, model: ResolvedModelProfile): Promise<void> {
    const snapshot = this.opts.projector.project(this.context, this.context.repository.facts);
    const budgetTokens = Registry.usableContextTokens(model.profile);
    if (!needsCompaction(snapshot.estimatedTokens, budgetTokens)) return;

    turn.transition('compacting', this.clock.now(), 'context budget exceeded');
    const result = this.runCompaction(snapshot.system, budgetTokens);

    // What it cost *and* whether it worked. Compaction can run, drop nothing and
    // leave the context over budget — `compact` has a branch for exactly that
    // ("the tail alone is over budget") whose comment says to report it, and
    // nothing was reporting it. A live run produced
    // `droppedMessages: 0, tokensBefore: 8460, tokensAfter: 8460` against a
    // 6,000-token budget, and the turn then sent the oversized request without a
    // word to anyone.
    const stillOver = needsCompaction(result.tokensAfter, budgetTokens);
    await this.append(
      'compaction.boundary',
      {
        level: result.levelsApplied.at(-1) ?? 'L1',
        droppedMessages: result.droppedMessages,
        summaryLength: result.summaryLength,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        preservedExchanges: result.preservedExchanges,
        overBudget: stillOver,
        budgetTokens,
      },
      turn.turnId,
    );

    if (stillOver) {
      this.logger.warn('compaction could not reach the context budget', {
        tokensAfter: result.tokensAfter,
        budgetTokens,
        droppedMessages: result.droppedMessages,
      });
      // Told to the model, not only logged — it is the only party that can act.
      // The precedent is the turn budget two hundred lines up: a limit enforced
      // against a model that was never told it existed produces a turn that
      // stops for no reason the model can explain. The same is true here, except
      // that the stop is a provider error rather than a clean halt.
      this.context.addFact({
        id: 'context-over-budget',
        priority: 'critical',
        text:
          `Context is over budget: about ${result.tokensAfter} tokens against a ` +
          `${budgetTokens}-token window, and compaction could not reduce it because everything in it is ` +
          'recent. Stop reading new files and stop running commands that return long output. Summarise ' +
          'what you already have, write down anything that must survive, and finish. The next request may ' +
          'be refused by the provider for length.',
      });
    }

    // Back to `preparing` before the step is frozen. `compacting → sampling` is
    // not a legal move (§5.2), and taking it threw INTERNAL_ERROR *and failed the
    // turn* — so until this line existed, any turn whose context outgrew the
    // window mid-flight died at the moment compaction was supposed to save it.
    // The same shape as the alpha.2 overflow defect: a state machine that is
    // enforced will punish a missing transition, and the punishment looks like an
    // unrelated internal error.
    turn.transition('preparing', this.clock.now(), 'compaction complete');
  }

  /**
   * Compact on request from the control plane (`/compact`).
   *
   * Lives here rather than in the kernel's control host so that *every* path into
   * compaction goes through `runCompaction` and therefore re-injects the same
   * anchors — the goal, the dirty-file summary and the delegation record (§30).
   * The duplicate implementation this replaces did not re-inject delegated work,
   * so a user-triggered compaction could lose a child's result while an automatic
   * one kept it.
   */
  async compactNow(): Promise<{ droppedMessages: number; tokensBefore: number; tokensAfter: number }> {
    const snapshot = this.opts.projector.project(this.context, this.context.repository.facts);
    const resolved = this.opts.modelRegistry.resolve(this.activeModelAlias);
    const budgetTokens = resolved ? Math.floor(Registry.usableContextTokens(resolved.profile) * 0.6) : 8_000;

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
        trigger: 'control',
      },
      this.currentTurn?.turnId,
    );

    return {
      droppedMessages: result.droppedMessages,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    };
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
      // Delegated work has to survive compaction (§30). A summarised conversation
      // that forgot a child's result would either lose work or invite the parent
      // to dispatch the same task again — and re-running a child that already
      // edited files is the expensive kind of forgetting.
      reinject: [this.editJournal.summary(), ...this.delegationAnchors()],
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

  // --- skill state ---------------------------------------------------------

  /**
   * Recompute the effective scope from the *baseline* every time (§23).
   *
   * Folding forward from scratch rather than mutating incrementally is what makes
   * "a skill can only narrow" true by construction: whatever the sequence of
   * activations and expiries, the result is the session's original catalogue and
   * policy intersected with the activations currently in force. An incremental
   * implementation would have to get every path right, and the paths that matter
   * are the ones nobody exercises — an activation during a cancelled turn, two
   * skills sharing a tool, a turn-scoped skill expiring while a run-scoped one
   * stays.
   */
  private applyPendingSkills(): void {
    if (this.pendingSkillEntries.length > 0) {
      this.skillEntries = [...this.skillEntries, ...this.pendingSkillEntries];
      this.pendingSkillEntries = [];
    }
    this.recomputeNarrowing();
  }

  /**
   * Recompute the narrowing layers from the baseline: skills, plus plan mode.
   *
   * Plan mode belongs here and not in the approval gate, and the distinction is
   * the point. The gate answers questions; plan mode has to stop them being
   * asked. A read-only layer intersected into the engine makes mutation `deny`
   * rather than `ask`, so nothing reaches an approval and there is nothing for
   * any mode to answer — which is what "the model cannot" means in this kernel,
   * as opposed to "the model was told no".
   *
   * Folded in on the same from-scratch recompute as the skills for the same
   * reason: an incremental version would have to get every interleaving right —
   * leaving plan mode while a turn-scoped skill is active, activating a skill
   * while in plan mode — and those are exactly the paths nobody exercises.
   */
  private recomputeNarrowing(): void {
    const baseline = this.opts.allowedTools ?? this.opts.toolRegistry.names();
    let tools = [...baseline];
    const layers: PolicyLayer[] = [];

    for (const entry of this.skillEntries) {
      const permitted = new Set(entry.activated.allowedTools);
      tools = tools.filter((t) => permitted.has(t));
      if (entry.activated.layer) layers.push(entry.activated.layer);
    }

    if (this.approvalModeState.mode === 'plan' && this.opts.planModeLayer) {
      layers.push(this.opts.planModeLayer);
    }

    this.effectiveTools = tools;
    this.opts.toolRuntime.setNarrowingLayers(layers);
    this.refreshOverlays();
  }

  /** Tools that will be in force once staged activations apply. */
  private projectedTools(): string[] {
    const baseline = this.opts.allowedTools ?? this.opts.toolRegistry.names();
    let tools = [...baseline];
    for (const entry of [...this.skillEntries, ...this.pendingSkillEntries]) {
      const permitted = new Set(entry.activated.allowedTools);
      tools = tools.filter((t) => permitted.has(t));
    }
    return tools;
  }

  /** Base overlays plus one per active skill, each labelled with its source. */
  private refreshOverlays(): void {
    const overlays: ContextOverlay[] = [...(this.opts.baseOverlays ?? [])];
    for (const entry of this.skillEntries) {
      overlays.push({
        source: `skill:${entry.activated.skill.name}`,
        text: renderSkillInstructions(entry.activated),
      });
    }
    this.opts.projector.setOverlays(overlays);
  }

  private async expireTurnScopedSkills(): Promise<void> {
    const expiring = this.skillEntries.filter((e) => e.scope === 'turn');
    if (expiring.length === 0) return;
    this.skillEntries = this.skillEntries.filter((e) => e.scope !== 'turn');
    this.recomputeNarrowing();
    for (const entry of expiring) {
      await this.append('skill.deactivated', {
        skill: entry.activated.skill.name,
        scope: entry.scope,
        reason: 'turn ended',
      });
    }
  }

  /**
   * The narrowest budget in force: `/loop` narrowing and any active skill's.
   *
   * Merged into one partial and applied once, because `applyCeiling` replaces the
   * whole budget — two separate calls would silently drop the first one's fields.
   */
  private budgetOverride(): Partial<LoopBudget> | undefined {
    const skillLimits = [...this.skillEntries, ...this.pendingSkillEntries]
      .map((e) => e.activated.maxSteps)
      .filter((n): n is number => typeof n === 'number');

    if (!this.turnBudgetOverride && skillLimits.length === 0) return undefined;

    const merged: Partial<LoopBudget> = { ...this.turnBudgetOverride };
    if (skillLimits.length > 0) {
      const narrowest = Math.min(...skillLimits);
      merged.maxSteps = Math.min(narrowest, merged.maxSteps ?? narrowest);
    }
    return merged;
  }

  // --- delegation ----------------------------------------------------------

  /**
   * What compaction must not lose about delegated work (§30).
   *
   * Statuses and one-line summaries, not the child's full report: the report is
   * already in the tool result, and the tail-preservation rules decide whether
   * that survives. What this guarantees is that the *fact* of the delegation, its
   * outcome and the files it touched are still present after the head is
   * summarised away.
   */
  private delegationAnchors(): string[] {
    if (this.delegations.length === 0) return [];
    const lines = ['Delegated work in this session:'];
    for (const record of this.delegations) {
      lines.push(
        `  - ${record.agent} (${record.status}): ${record.usage.modelRequests} model request(s), ` +
          `${record.usage.toolCalls} tool call(s)` +
          (record.child.dirtyFiles.length > 0 ? `, modified ${record.child.dirtyFiles.join(', ')}` : ''),
      );
    }
    lines.push('  Do not re-dispatch a delegation that already completed; its effects are in the workspace.');
    return [lines.join('\n')];
  }

  /** Answer every dangling tool call, so the conversation stays well formed. */
  private async closeOpenToolCalls(turnId: TurnId, reason: string): Promise<void> {
    const open = this.context.openToolCalls();
    if (open.length === 0) return;

    const results = open.map((id) => syntheticInterruptedResult(id, reason));
    this.context.appendToolResults(results);

    for (const result of results) {
      this.answeredToolCalls.add(result.toolCallId);
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

  /**
   * Fields that go to the host and never to disk.
   *
   * `preview` is a bounded look at tool output (ADR-0031). It exists so a person
   * watching can see what a tool returned; nothing downstream of the log needs it,
   * and a persisted copy is a copy of tool output sitting on disk forever. Emitting
   * it in-process and stripping it before `store.append` gives the terminal the
   * bytes and leaves the record exactly as it was before the feature existed.
   */
  private static readonly EPHEMERAL_FIELDS = ['preview'] as const;

  private static forTheRecord(payload: unknown): unknown {
    if (payload === null || typeof payload !== 'object') return payload;
    const copy = { ...(payload as Record<string, unknown>) };
    let stripped = false;
    for (const field of Session.EPHEMERAL_FIELDS) {
      if (field in copy) {
        delete copy[field];
        stripped = true;
      }
    }
    return stripped ? copy : payload;
  }

  private async append(type: string, payload: unknown, turnId?: TurnId, stepId?: StepId): Promise<void> {
    this.opts.onEvent?.(type, payload);
    await this.opts.store.append(this.sessionId, {
      type: type as Parameters<SessionStore['append']>[1]['type'],
      payload: Session.forTheRecord(payload),
      ...(turnId ? { turnId } : {}),
      ...(stepId ? { stepId } : {}),
      // Every event a child session writes is tagged, which is what lets replay
      // rebuild the parent's transcript without folding the child's tool calls
      // into it (see `KernelEvent.delegationId`).
      ...(this.opts.delegation ? { delegationId: this.opts.delegation.delegationId } : {}),
    });
  }

  async persistMetadata(): Promise<void> {
    const existing = await this.opts.store.loadMetadata(this.sessionId);
    if (!existing) return;
    const title = existing.title ?? this.firstUserInput;
    const next: SessionMetadata = {
      ...existing,
      ...(title !== undefined ? { title } : {}),
      model: this.modelAlias,
      // The profile in force, not the one the session was created under: a
      // resume can run under a different one (permissions are never restored
      // from a log), and the record should say which one actually applied.
      permissionProfile: this.opts.permissionProfile,
      // The delegated share travels with the total, so a resume can rebuild the
      // breakdown rather than guessing at it (D-003).
      usage: { ...this.usage, delegatedCostUsd: this.delegatedCostUsd },
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
