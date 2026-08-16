/**
 * Control Plane (spec §2.2, §15).
 *
 * Commands here change kernel state **directly**. They are never handed to the
 * model as natural language and never depend on the model's cooperation. The
 * model learns what happened only through the `projection` field, which the
 * context engine appends as a `control`-origin message.
 *
 * That separation is what makes `/permissions` trustworthy: a session cannot be
 * talked into widening itself, because the widening path does not run through
 * anything the model can influence.
 */

import { APP_DISPLAY_NAME, PROJECT_DIR } from '../app.ts';
import { describeEnforcement, networkEnforcementLabel } from '../execution/enforcement.ts';
import type { EnforcementDescriptor } from '../execution/enforcement.ts';
import { ModelRegistry } from '../model/profiles.ts';
import type { GoalState } from '../context/context-engine.ts';
import type { LoopBudget } from '../session/step.ts';
import type { PolicyEngine } from '../policy/policy-engine.ts';
import type { Session } from '../session/session.ts';
import type { KernelConfig } from '../config/schema.ts';
import type { EnvironmentDescriptor } from '../execution/backend.ts';
import type { RemoteConfig } from '../execution/ssh.ts';
import { listProfileNames } from '../policy/profiles.ts';
import type { SkillActivationOutcome, SkillActivationScope } from '../extensions/skills.ts';
import type { DelegationRecord } from '../session/delegation.ts';

export interface ControlResult {
  ok: boolean;
  command: string;
  /** Shown to the user. */
  message: string;
  /**
   * Projected into the conversation so the model knows the state changed.
   * Absent when the command is purely informational for the human.
   */
  projection?: string;
  data?: Record<string, unknown>;
}

/**
 * What the control plane is allowed to touch.
 *
 * Narrow by design: the surface a slash command can reach is the surface a
 * future `/dangerously-...` command could reach, so it stays small and explicit.
 */
export interface ControlHost {
  session: Session;
  policy: PolicyEngine;
  config: KernelConfig;
  environment: EnvironmentDescriptor;
  /**
   * What this **session** enforces, which is not always what the backend does.
   *
   * `environment.enforcement` describes the backend and is still true. It does
   * not know which MCP servers this session attached, and alpha.9 §14 requires
   * `/status` to say that the boundary does not extend inside one. A separate
   * field rather than a mutation of the backend's descriptor, because both are
   * true and a reader of either should get the one they asked for — and because
   * the last time this was left implicit, `/status` silently kept reporting the
   * backend's view while the model was being told the session's.
   */
  enforcement: EnforcementDescriptor;
  modelRegistry: ModelRegistry;
  configSources: readonly string[];
  remotes: readonly RemoteConfig[];
  activeRemote?: string;
  skills: ReadonlyArray<{ name: string; description: string }>;
  agents: ReadonlyArray<{ name: string; description: string }>;
  /**
   * Activate a skill from the control plane (alpha.4 §22).
   *
   * A control-plane activation is the *user* asking, which is why it exists
   * alongside the model-facing `Skill` tool: the two share one resolver, so
   * neither can grant what the other would refuse.
   */
  activateSkill(name: string, scope: SkillActivationScope): Promise<SkillActivationOutcome>;
  activeSkills(): Array<{ name: string; scope: SkillActivationScope; preApplied: boolean }>;
  /** Live and finished delegated scopes, for `/status` (§41). */
  delegations(): {
    active: Array<{
      delegationId: string;
      agent: string;
      depth: number;
      model: string;
      activity: string;
      elapsedMs: number;
      budgetRemaining: { steps: number; toolCalls: number; modelRequests: number };
    }>;
    finished: readonly DelegationRecord[];
  };
  hooks: ReadonlyArray<{ event: string; command: string[] }>;
  /**
   * Reverse edits, on the user's behalf (ADR-0026 §6).
   *
   * A callback rather than the control plane reaching for the journal itself,
   * because an undo is an edit: it must go through the policy engine, the
   * approval prompt and a narrowed executor, and the only component that owns
   * that sequence is the tool runtime. The kernel wires this to
   * `ToolRuntime.executeControlCall`, so `/undo` and the model's `Undo` cannot
   * disagree about what may be reversed.
   */
  undo(request: { scope: 'last' | 'turn' | 'path'; count?: number; path?: string }): Promise<{
    ok: boolean;
    message: string;
  }>;
  /** The journal inventory, for `/undo list`. */
  undoInventory(): {
    entries: Array<{ entryId: string; kind: string; displayPath: string; turnId: string; undoOf?: string }>;
    uncovered: string;
  };
  /**
   * Per-provider credential *source* lines (alpha.3 §8).
   *
   * "file" / "environment (X)" / "none", and whether a credential was found.
   * Never the value, and never a fingerprint of it: `/status` is the screen
   * people paste into bug reports.
   */
  credentialSources: ReadonlyArray<{ provider: string; description: string }>;
  /**
   * Extra `/status` lines contributed by the active backend (alpha.5 §41).
   *
   * The container backend uses this to report its runtime, image reference and
   * digest, network mode and mount shape. It is a callback returning strings
   * rather than a typed `container?: {...}` field on purpose: the control plane
   * has no business knowing what a container is, and a backend-shaped union here
   * would be the first `if (kind === 'container')` in shared code.
   *
   * Whatever it returns is user-visible, so it must be safe to paste into a bug
   * report: an image digest yes, a host path layout no.
   */
  backendDetail?: () => string[];
  now(): number;
  /** Switch execution backend. Applied after the current tool call (§19.4). */
  connectRemote(name: string): Promise<{ ok: boolean; message: string }>;
  disconnectRemote(): Promise<{ ok: boolean; message: string }>;
  /** Force a compaction pass. */
  compactNow(): Promise<{ droppedMessages: number; tokensBefore: number; tokensAfter: number }>;
  contextUsage(): { estimatedTokens: number; budgetTokens: number };
}

export type ControlHandler = (args: string[], host: ControlHost) => Promise<ControlResult> | ControlResult;

export class ControlPlane {
  private readonly handlers = new Map<string, ControlHandler>();
  private readonly host: ControlHost;

  constructor(host: ControlHost) {
    this.host = host;
    this.register('model', handleModel);
    this.register('goal', handleGoal);
    this.register('loop', handleLoop);
    this.register('permissions', handlePermissions);
    this.register('status', handleStatus);
    this.register('compact', handleCompact);
    this.register('remote', handleRemote);
    this.register('skills', handleSkills);
    this.register('agents', handleAgents);
    this.register('hooks', handleHooks);
    this.register('undo', handleUndo);
    this.register('cancel', handleCancel);
    this.register('help', (args) => handleHelp(args, this.commandNames()));
  }

  register(name: string, handler: ControlHandler): void {
    this.handlers.set(name, handler);
  }

  commandNames(): string[] {
    return [...this.handlers.keys()].sort();
  }

  isCommand(input: string): boolean {
    return input.trimStart().startsWith('/');
  }

  /**
   * Execute a slash command.
   *
   * Returns a structured result; the caller decides whether to print it, project
   * it to the model, or both.
   */
  async execute(input: string): Promise<ControlResult> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return { ok: false, command: '', message: 'Not a control command.' };
    }

    const tokens = tokenize(trimmed.slice(1));
    const name = (tokens[0] ?? '').toLowerCase();
    const args = tokens.slice(1);

    const handler = this.handlers.get(name);
    if (!handler) {
      const suggestion = closest(name, this.commandNames());
      return {
        ok: false,
        command: name,
        message:
          `Unknown command "/${name}".` + (suggestion ? ` Did you mean "/${suggestion}"?` : ` Try /help.`),
      };
    }

    try {
      return await handler(args, this.host);
    } catch (e) {
      return {
        ok: false,
        command: name,
        message: `/${name} failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

// --- handlers --------------------------------------------------------------

const handleModel: ControlHandler = (args, host) => {
  const sub = args[0] ?? 'status';

  if (sub === 'list') {
    const lines = host.modelRegistry.listAliases().map((a) => {
      const resolved = host.modelRegistry.resolve(a.alias);
      const marker = a.alias === host.session.activeModelAlias ? '*' : ' ';
      return (
        `${marker} ${a.alias.padEnd(16)} ${a.provider}/${a.modelId}` +
        (resolved
          ? `  (${resolved.profile.contextWindow.toLocaleString()} ctx, ${resolved.profile.autonomy} autonomy)`
          : '')
      );
    });
    return { ok: true, command: 'model', message: `Available models:\n${lines.join('\n')}` };
  }

  if (sub === 'use') {
    const alias = args[1];
    if (!alias) return { ok: false, command: 'model', message: 'Usage: /model use <alias>' };

    const resolved = host.modelRegistry.resolve(alias);
    if (!resolved) {
      return {
        ok: false,
        command: 'model',
        message: `Unknown model "${alias}". Run /model list to see what is configured.`,
      };
    }

    // Context pressure check *before* switching: a smaller window may not fit
    // the conversation, and the user should know before the next step fails.
    const usage = host.contextUsage();
    const newBudget = ModelRegistry.usableContextTokens(resolved.profile);
    const warning =
      usage.estimatedTokens > newBudget
        ? `\nWarning: the conversation is about ${usage.estimatedTokens.toLocaleString()} tokens and ` +
          `${alias} allows about ${newBudget.toLocaleString()}. It will be compacted before the next step.`
        : '';

    const applied = host.session.selectModel(alias);
    return {
      ok: true,
      command: 'model',
      message:
        `Model set to ${alias} (${resolved.provider.id}/${resolved.modelId}).` +
        (applied.applied === 'next-step' ? ' It takes effect on the next step.' : '') +
        warning,
      projection: `[control] The model was changed to ${alias}. It takes effect from the next step.`,
      data: { alias, applied: applied.applied },
    };
  }

  const current = host.modelRegistry.resolve(host.session.activeModelAlias);
  return {
    ok: true,
    command: 'model',
    message: current
      ? `Current model: ${current.alias} (${current.provider.id}/${current.modelId})\n` +
        `  context window : ${current.profile.contextWindow.toLocaleString()}\n` +
        `  edit strategy  : ${current.profile.preferredEditStrategy}\n` +
        `  autonomy       : ${current.profile.autonomy}\n` +
        `  parallel tools : ${current.profile.supportsParallelTools ? 'yes' : 'no'}`
      : `Current model alias "${host.session.activeModelAlias}" is not resolvable.`,
  };
};

const handleGoal: ControlHandler = (args, host) => {
  const sub = args[0] ?? 'status';
  const goal = host.session.goal;

  switch (sub) {
    case 'set': {
      const objective = args.slice(1).join(' ').trim();
      if (objective === '') return { ok: false, command: 'goal', message: 'Usage: /goal set <objective>' };
      const next: GoalState = {
        objective,
        criteria: goal?.criteria ?? [],
        status: 'active',
        createdAt: host.now(),
      };
      host.session.setGoal(next);
      return {
        ok: true,
        command: 'goal',
        message: `Goal set: ${objective}`,
        // Note what this does *not* do: a goal never widens permissions (§15.3).
        projection: `[control] The user set the goal: ${objective}\nThis does not change what you are permitted to do.`,
      };
    }

    case 'criteria': {
      const text = args.slice(1).join(' ').trim();
      if (text === '') return { ok: false, command: 'goal', message: 'Usage: /goal criteria <text>' };
      if (!goal) return { ok: false, command: 'goal', message: 'Set a goal first with /goal set.' };
      const next: GoalState = { ...goal, criteria: [...goal.criteria, text] };
      host.session.setGoal(next);
      return {
        ok: true,
        command: 'goal',
        message: `Added criterion: ${text}`,
        projection: `[control] A success criterion was added: ${text}`,
      };
    }

    case 'pause':
    case 'resume': {
      if (!goal) return { ok: false, command: 'goal', message: 'There is no goal to change.' };
      const status = sub === 'pause' ? ('paused' as const) : ('active' as const);
      host.session.setGoal({ ...goal, status });
      return {
        ok: true,
        command: 'goal',
        message: `Goal ${status}.`,
        projection: `[control] The goal is now ${status}.`,
      };
    }

    case 'clear': {
      host.session.setGoal(undefined);
      return {
        ok: true,
        command: 'goal',
        message: 'Goal cleared.',
        projection: '[control] The goal was cleared.',
      };
    }

    default:
      return {
        ok: true,
        command: 'goal',
        message: goal
          ? `Goal (${goal.status}): ${goal.objective}` +
            (goal.criteria.length > 0
              ? `\nDone when:\n${goal.criteria.map((c) => `  - ${c}`).join('\n')}`
              : '')
          : 'No goal is set. Use /goal set <objective>.',
      };
  }
};

const handleLoop: ControlHandler = (args, host) => {
  const sub = args[0] ?? 'status';
  const ceiling = host.session.budgetCeiling;

  if (sub === 'start') {
    const requested = parseLoopFlags(args.slice(1));
    if (requested.errors.length > 0) {
      return { ok: false, command: 'loop', message: requested.errors.join('\n') };
    }
    host.session.setTurnBudget(requested.budget);

    const effective: LoopBudget = {
      maxSteps: Math.min(requested.budget.maxSteps ?? ceiling.maxSteps, ceiling.maxSteps),
      maxWallTimeMs: Math.min(requested.budget.maxWallTimeMs ?? ceiling.maxWallTimeMs, ceiling.maxWallTimeMs),
      maxModelRequests: Math.min(
        requested.budget.maxModelRequests ?? ceiling.maxModelRequests,
        ceiling.maxModelRequests,
      ),
      maxToolCalls: Math.min(requested.budget.maxToolCalls ?? ceiling.maxToolCalls, ceiling.maxToolCalls),
      maxRepeatedEquivalentFailures: ceiling.maxRepeatedEquivalentFailures,
      ...(requested.budget.maxCostUsd !== undefined ? { maxCostUsd: requested.budget.maxCostUsd } : {}),
    };

    const clamped = Object.entries(requested.budget)
      .filter(([k, v]) => typeof v === 'number' && v > (ceiling as unknown as Record<string, number>)[k]!)
      .map(([k]) => k);

    return {
      ok: true,
      command: 'loop',
      message:
        `Autonomous continuation enabled with a hard budget:\n` +
        `  steps          : ${effective.maxSteps}\n` +
        `  model requests : ${effective.maxModelRequests}\n` +
        `  tool calls     : ${effective.maxToolCalls}\n` +
        `  wall clock     : ${Math.round(effective.maxWallTimeMs / 1000)}s\n` +
        (effective.maxCostUsd !== undefined
          ? `  cost           : $${effective.maxCostUsd.toFixed(2)}\n`
          : '') +
        (clamped.length > 0 ? `Clamped to the session ceiling: ${clamped.join(', ')}.\n` : '') +
        'This is not unlimited autonomy: the turn stops when the budget or the goal criteria are met.',
      projection:
        '[control] Autonomous continuation is enabled with a hard budget. ' +
        'Keep working toward the goal until it is met or the budget runs out.',
      data: { budget: effective },
    };
  }

  if (sub === 'stop') {
    host.session.setTurnBudget(undefined);
    return {
      ok: true,
      command: 'loop',
      message: 'Autonomous continuation disabled; budgets return to the interactive defaults.',
      projection: '[control] Autonomous continuation was stopped. Finish the current step and report back.',
    };
  }

  return {
    ok: true,
    command: 'loop',
    message:
      `Session budget ceiling:\n` +
      `  steps          : ${ceiling.maxSteps}\n` +
      `  model requests : ${ceiling.maxModelRequests}\n` +
      `  tool calls     : ${ceiling.maxToolCalls}\n` +
      `  wall clock     : ${Math.round(ceiling.maxWallTimeMs / 1000)}s\n` +
      `  repeated failures before stopping: ${ceiling.maxRepeatedEquivalentFailures}`,
  };
};

const handlePermissions: ControlHandler = (args, host) => {
  const sub = args[0] ?? 'show';

  if (sub === 'reset-session') {
    const count = host.policy.approvals.size;
    host.policy.approvals.reset();
    return {
      ok: true,
      command: 'permissions',
      message: `Cleared ${count} session approval(s). Future requests will ask again.`,
      projection: '[control] Session approvals were cleared. Previously approved actions will ask again.',
    };
  }

  if (sub === 'explain') {
    const subject = args[1];
    if (!subject) {
      return {
        ok: false,
        command: 'permissions',
        message: 'Usage: /permissions explain <subject-or-tool-call-id>',
      };
    }
    const record = host.policy.approvals.lookup(subject);
    return {
      ok: true,
      command: 'permissions',
      message: record
        ? `${subject}\n  decision : ${record.granted ? 'allowed' : 'denied'} for this session\n` +
          `  summary  : ${record.summary}\n  decided  : ${new Date(record.decidedAt).toISOString()}`
        : `No session-scoped decision is recorded for "${subject}".`,
    };
  }

  const layers = host.policy.describeLayers();
  const approvals = host.policy.approvals.entries();
  const sandbox = describeEnforcement(host.enforcement);

  return {
    ok: true,
    command: 'permissions',
    message:
      `Permission profile : ${host.config.security.permissionProfile}\n` +
      `Available profiles : ${listProfileNames().join(', ')}\n` +
      `Policy layers      : ${layers.map((l) => `${l.name}(${l.profile})`).join(' ∩ ')}\n` +
      `Isolation          : ${sandbox.label}\n` +
      // Per dimension, not just the summary: the summary is a rounding of these,
      // and a reader asking "is my `.env` reachable by a subprocess?" needs the
      // filesystem line rather than a label that averages six answers (§7).
      sandbox.lines.map((l) => `                     ${l}\n`).join('') +
      `                     ${sandbox.caveat}\n` +
      `Session approvals  : ${approvals.length}\n` +
      approvals.map((a) => `  ${a.granted ? 'allow' : 'deny '} ${a.subjectKey}`).join('\n') +
      '\n\nPermanently denied and not configurable: secret file contents, credential directories, ' +
      'SSH agent forwarding, privilege escalation, and telemetry carrying content.',
  };
};

const handleStatus: ControlHandler = (_args, host) => {
  const usage = host.contextUsage();
  const session = host.session;
  const model = host.modelRegistry.resolve(session.activeModelAlias);
  const sandbox = describeEnforcement(host.enforcement);
  const dirty = session.editJournal.dirtyPaths();
  const inventory = host.undoInventory();
  const u = session.usageSnapshot;
  const { active, finished } = host.delegations();
  const cost = session.costBreakdown;
  const skills = host.activeSkills();

  const pct = usage.budgetTokens > 0 ? Math.round((usage.estimatedTokens / usage.budgetTokens) * 100) : 0;

  return {
    ok: true,
    command: 'status',
    message: [
      `session      : ${session.sessionId}`,
      `model        : ${session.activeModelAlias}${model ? ` (${model.provider.id}/${model.modelId})` : ''}`,
      `workspace    : ${session.workspaceRoot}`,
      `backend      : ${host.environment.description}`,
      `remote       : ${host.activeRemote ?? 'none (local)'}`,
      `profile      : ${host.config.security.permissionProfile}`,
      `isolation    : ${sandbox.label} — network from Shell is ${networkEnforcementLabel(host.enforcement)}`,
      // §41. The backend contributes its own lines rather than the control plane
      // learning what a container is: the runtime, the image and its digest, the
      // network mode and the mount shape all mean something different per backend,
      // and a `if (kind === 'container')` here would be the branch ADR-0007 exists
      // to keep out of shared code.
      ...(host.backendDetail?.() ?? []).map((line) => `             ${line}`),
      ...sandbox.lines.map((line) => `             ${line}`),
      ...(host.enforcement.platformNotes ?? []).map((note) => `platform     : ${note}`),
      `context      : ~${usage.estimatedTokens.toLocaleString()} / ${usage.budgetTokens.toLocaleString()} tokens (${pct}%)`,
      `loop budget  : ${session.budgetCeiling.maxSteps} steps, ${session.budgetCeiling.maxToolCalls} tool calls`,
      `goal         : ${session.goal ? `${session.goal.objective} (${session.goal.status})` : 'none'}`,
      `usage        : ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out, ` +
        `${u.modelRequests} requests, ${u.toolCalls} tool calls` +
        (u.costUsd > 0 ? `, $${u.costUsd.toFixed(4)}` : ''),
      `dirty files  : ${dirty.length === 0 ? 'none' : `${dirty.length} (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''})`}`,
      // alpha.10 §12. The count on its own would be the dishonest half — a user
      // reading "12 reversible" would take the workspace to be 12 steps from
      // where it started. The enumeration below is what makes the number mean
      // something, and it is derived from this session, never from a constant.
      `undo         : ${inventory.entries.length === 0 ? 'nothing reversible' : `${inventory.entries.length} reversible edit(s) — /undo list`}`,
      ...inventory.uncovered.split('\n').map((line) => `               ${line}`),
      `skills       : ${skills.length === 0 ? 'none active' : skills.map((s) => `${s.name} (${s.preApplied ? 'agent' : s.scope})`).join(', ')}`,
      // §41: enough to know what a child is doing, and nothing about how it was
      // prompted. No instructions, no credentials, no task text.
      `delegation   : ${
        active.length === 0
          ? finished.length === 0
            ? 'none'
            : `${finished.length} finished`
          : active
              .map(
                (a) =>
                  `${a.agent} (${a.delegationId}, depth ${a.depth}, ${a.model}) — ${a.activity}; ` +
                  `${a.budgetRemaining.steps}/${a.budgetRemaining.toolCalls}/${a.budgetRemaining.modelRequests} ` +
                  `steps/tools/requests left, ${Math.round(a.elapsedMs / 1000)}s elapsed`,
              )
              .join('\n               ')
      }`,
      ...(cost.totalUsd > 0
        ? [
            `cost         : $${cost.totalUsd.toFixed(4)} total — $${cost.directUsd.toFixed(4)} direct, ` +
              `$${cost.delegatedUsd.toFixed(4)} delegated`,
          ]
        : []),
      `telemetry    : ${host.config.telemetry.enabled ? 'metadata only' : 'off'}; trace upload off; content upload permanently off`,
      ...(host.credentialSources.length > 0
        ? ['credentials  :', ...host.credentialSources.map((c) => `  ${c.provider}: ${c.description}`)]
        : []),
      `config from  : ${host.configSources.length > 0 ? host.configSources.join(', ') : '(defaults)'}`,
      ...(host.config.warnings.length > 0
        ? ['warnings     :', ...host.config.warnings.map((w) => `  - ${w}`)]
        : []),
    ].join('\n'),
  };
};

const handleCompact: ControlHandler = async (args, host) => {
  if ((args[0] ?? '') === 'status') {
    const usage = host.contextUsage();
    return {
      ok: true,
      command: 'compact',
      message:
        `Context is about ${usage.estimatedTokens.toLocaleString()} of ${usage.budgetTokens.toLocaleString()} usable tokens.\n` +
        (usage.estimatedTokens > usage.budgetTokens
          ? 'Compaction will run before the next step.'
          : 'No compaction is needed yet.'),
    };
  }

  const result = await host.compactNow();
  return {
    ok: true,
    command: 'compact',
    message:
      `Compacted: ${result.droppedMessages} older message(s) summarised, ` +
      `${result.tokensBefore.toLocaleString()} → ${result.tokensAfter.toLocaleString()} tokens.`,
    projection:
      '[control] The earlier conversation was compacted into a summary. ' +
      'Read receipts from before the summary are no longer valid — re-read a file before editing it.',
  };
};

const handleRemote: ControlHandler = async (args, host) => {
  const sub = args[0] ?? 'status';

  if (sub === 'list') {
    if (host.remotes.length === 0) {
      return {
        ok: true,
        command: 'remote',
        message: `No remotes are configured. Add them to your ${APP_DISPLAY_NAME} config directory as remotes.toml.`,
      };
    }
    return {
      ok: true,
      command: 'remote',
      message:
        'Configured remotes:\n' +
        host.remotes
          .map(
            (r) =>
              `  ${r.name === host.activeRemote ? '*' : ' '} ${r.name.padEnd(16)} ${r.host}:${r.workspace}` +
              `  (profile ${r.profile ?? 'default'}, agent forwarding off)`,
          )
          .join('\n'),
    };
  }

  if (sub === 'connect') {
    const name = args[1];
    if (!name) return { ok: false, command: 'remote', message: 'Usage: /remote connect <name>' };
    const result = await host.connectRemote(name);
    return {
      ok: result.ok,
      command: 'remote',
      message: result.message,
      ...(result.ok
        ? {
            projection: `[control] Execution moved to remote "${name}". Paths now refer to the remote workspace.`,
          }
        : {}),
    };
  }

  if (sub === 'disconnect') {
    const result = await host.disconnectRemote();
    return {
      ok: result.ok,
      command: 'remote',
      message: result.message,
      projection: '[control] Execution returned to the local workspace.',
    };
  }

  return {
    ok: true,
    command: 'remote',
    message: host.activeRemote
      ? `Connected to "${host.activeRemote}". ${host.environment.description}`
      : 'Running locally. Use /remote list to see configured remotes.',
  };
};

const handleSkills: ControlHandler = async (args, host) => {
  const sub = args[0] ?? 'list';

  if (sub === 'use') {
    const name = args[1];
    if (!name) {
      return { ok: false, command: 'skills', message: 'Usage: /skills use <name> [--turn|--run]' };
    }
    // Run scope is the default for a user activation: someone who typed
    // `/skills use security-review` means "for this piece of work", not "for the
    // next model call". The model-facing tool defaults the other way, because a
    // model activating a skill for the rest of the session is a much longer
    // commitment than it can reasonably judge.
    const scope: SkillActivationScope = args.includes('--turn') ? 'turn' : 'run';
    const outcome = await host.activateSkill(name, scope);
    if (!outcome.ok) return { ok: false, command: 'skills', message: outcome.message };

    return {
      ok: true,
      command: 'skills',
      message:
        outcome.message +
        (outcome.allowedTools ? `\n  tools now  : ${outcome.allowedTools.join(', ') || 'none'}` : '') +
        (outcome.notes && outcome.notes.length > 0
          ? `\n  notes      :\n${outcome.notes.map((n) => `    - ${n}`).join('\n')}`
          : ''),
      projection:
        `[control] The skill "${name}" was activated for this ${scope}. Its instructions are in your ` +
        'context as third-party content, and your tools and permissions may now be narrower.',
      data: { skill: name, scope },
    };
  }

  const active = host.activeSkills();
  const activeLine =
    active.length === 0
      ? 'Active: none.'
      : `Active: ${active.map((a) => `${a.name} (${a.preApplied ? 'agent' : a.scope})`).join(', ')}.`;

  return {
    ok: true,
    command: 'skills',
    message:
      (host.skills.length === 0
        ? `No skills discovered. Add them under ${PROJECT_DIR}/skills/<name>/SKILL.md.`
        : 'Skills:\n' + host.skills.map((s) => `  ${s.name.padEnd(24)} ${s.description}`).join('\n')) +
      `\n\n${activeLine}` +
      "\n\nA skill can only narrow this session's capabilities, never widen them. " +
      'Activate one with /skills use <name>.',
  };
};

const handleAgents: ControlHandler = (_args, host) => {
  const { active, finished } = host.delegations();

  const history =
    finished.length === 0
      ? ''
      : '\n\nDelegations this session:\n' +
        finished
          .map(
            (d) =>
              `  ${d.agent.padEnd(22)} ${d.status.padEnd(16)} ` +
              `${d.usage.modelRequests} req, ${d.usage.toolCalls} tools` +
              (d.usage.estimatedCostUsd !== undefined ? `, ~$${d.usage.estimatedCostUsd.toFixed(4)}` : ''),
          )
          .join('\n');

  const running =
    active.length === 0
      ? ''
      : '\n\nRunning now:\n' +
        active
          .map(
            (a) =>
              `  ${a.agent} (depth ${a.depth}, ${a.model}) — ${a.activity}; ` +
              `${a.budgetRemaining.steps} step(s) left`,
          )
          .join('\n');

  return {
    ok: true,
    command: 'agents',
    message:
      (host.agents.length === 0
        ? `No agents discovered. Add them under ${PROJECT_DIR}/agents/<name>.md.`
        : 'Agents:\n' + host.agents.map((a) => `  ${a.name.padEnd(24)} ${a.description}`).join('\n')) +
      "\n\nA subagent's capabilities are always a subset of this session's, and its budget comes out of " +
      'the delegating turn.' +
      running +
      history,
  };
};

const handleHooks: ControlHandler = (_args, host) => ({
  ok: true,
  command: 'hooks',
  message:
    host.hooks.length === 0
      ? `No hooks configured. Add them to ${PROJECT_DIR}/hooks.toml.`
      : 'Hooks:\n' +
        host.hooks.map((h) => `  ${h.event.padEnd(18)} ${h.command.join(' ')}`).join('\n') +
        '\n\nProject hooks run through the executor with a scrubbed environment and are never trusted kernel hooks.',
});

/**
 * `/undo` (ADR-0026 §1).
 *
 * ```text
 * /undo                reverse the most recent reversible edit
 * /undo last <n>       reverse the last n
 * /undo path <p>       reverse every edit to one file
 * /undo turn           reverse everything the current turn did
 * /undo list           reverse nothing; show the inventory and the limits
 * ```
 *
 * There is deliberately no "undo everything since the session started". A
 * session-wide revert with no VCS underneath it is a restore, not an undo, and
 * it should look like one.
 */
const handleUndo: ControlHandler = async (args, host) => {
  const sub = (args[0] ?? '').toLowerCase();

  if (sub === 'list' || sub === 'status') {
    const inventory = host.undoInventory();
    if (inventory.entries.length === 0) {
      return {
        ok: true,
        command: 'undo',
        message: `No edit in this session can be reversed.\n\n${inventory.uncovered}`,
      };
    }
    return {
      ok: true,
      command: 'undo',
      message: [
        `${inventory.entries.length} reversible edit(s), newest first:`,
        ...inventory.entries.map(
          (e) =>
            `  ${e.entryId}  ${e.kind.padEnd(9)} ${e.displayPath}` +
            (e.undoOf ? '  (itself a reversal)' : ''),
        ),
        '',
        inventory.uncovered,
      ].join('\n'),
    };
  }

  if (sub === 'path') {
    const target = args[1];
    if (!target) return { ok: false, command: 'undo', message: 'Usage: /undo path <file>' };
    const outcome = await host.undo({ scope: 'path', path: target });
    return { ok: outcome.ok, command: 'undo', message: outcome.message, projection: outcome.message };
  }

  if (sub === 'turn') {
    const outcome = await host.undo({ scope: 'turn' });
    return { ok: outcome.ok, command: 'undo', message: outcome.message, projection: outcome.message };
  }

  const count = sub === 'last' ? Number.parseInt(args[1] ?? '1', 10) : 1;
  if (!Number.isFinite(count) || count < 1) {
    return { ok: false, command: 'undo', message: 'Usage: /undo last <n>' };
  }
  if (sub !== '' && sub !== 'last') {
    return {
      ok: false,
      command: 'undo',
      message:
        `Unknown subcommand "/undo ${sub}". Try /undo, /undo last <n>, /undo path <f>, ` +
        '/undo turn, or /undo list.',
    };
  }

  const outcome = await host.undo({ scope: 'last', count });
  // Projected, because the model's picture of those files is now wrong and it
  // did not cause that. A control command that silently changed the workspace
  // under the model is the failure this projection exists to prevent.
  return { ok: outcome.ok, command: 'undo', message: outcome.message, projection: outcome.message };
};

const handleCancel: ControlHandler = (_args, host) => {
  const cancelled = host.session.cancel();
  return {
    ok: cancelled,
    command: 'cancel',
    message: cancelled ? 'Cancelling the current turn.' : 'There is no turn in progress.',
  };
};

function handleHelp(args: string[], commands: readonly string[]): ControlResult {
  void args;
  return {
    ok: true,
    command: 'help',
    message: [
      'Control commands (these change kernel state directly and are never interpreted by the model):',
      '  /model [list|use <alias>|status]        select the model; takes effect next step',
      '  /goal [set|criteria|status|pause|resume|clear]',
      '  /loop [status|start [--max-steps N --max-time 20m --max-cost 1.50]|stop]',
      '  /permissions [show|explain <subject>|reset-session]',
      '  /status                                 session, model, context, budget, dirty files',
      '  /compact [status]                       summarise older conversation',
      '  /remote [list|connect <name>|status|disconnect]',
      '  /skills [list|use <name> [--turn|--run]]  activate a skill; it can only narrow',
      '  /agents, /hooks                         what is discovered and how it is constrained',
      '  /undo [last <n>|path <f>|turn|list]     reverse edits; all of them or none, and it',
      '                                          always says what it could not reach',
      '  /cancel                                 stop the current turn',
      '',
      `Registered: ${commands.map((c) => `/${c}`).join(' ')}`,
    ].join('\n'),
  };
}

// --- helpers ---------------------------------------------------------------

/** Split a command line, honouring quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;

  for (let i = 0; i < input.length; i += 1) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += c;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

export function parseLoopFlags(args: readonly string[]): {
  budget: Partial<LoopBudget>;
  errors: string[];
} {
  const budget: Partial<LoopBudget> = {};
  const errors: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    const value = args[i + 1];

    switch (flag) {
      case '--max-steps': {
        const n = Number.parseInt(value ?? '', 10);
        if (!Number.isFinite(n) || n <= 0) errors.push('--max-steps needs a positive integer');
        else budget.maxSteps = n;
        i += 1;
        break;
      }
      case '--max-tool-calls': {
        const n = Number.parseInt(value ?? '', 10);
        if (!Number.isFinite(n) || n <= 0) errors.push('--max-tool-calls needs a positive integer');
        else budget.maxToolCalls = n;
        i += 1;
        break;
      }
      case '--max-time': {
        const ms = parseDuration(value ?? '');
        if (ms === undefined) errors.push('--max-time needs a duration such as 20m, 90s or 1h');
        else budget.maxWallTimeMs = ms;
        i += 1;
        break;
      }
      case '--max-cost': {
        const n = Number.parseFloat(value ?? '');
        if (!Number.isFinite(n) || n <= 0) errors.push('--max-cost needs a positive number');
        else budget.maxCostUsd = n;
        i += 1;
        break;
      }
      default:
        errors.push(`Unknown flag "${flag}" for /loop start`);
    }
  }

  return { budget, errors };
}

export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]!);
  switch (match[2] ?? 's') {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    default:
      return undefined;
  }
}

/** Cheap edit-distance suggestion for a mistyped command. */
function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const d = distance(input, candidate);
    if (d <= 2 && (!best || d < best.distance)) best = { name: candidate, distance: d };
  }
  return best?.name;
}

function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);

  for (let i = 1; i < rows; i += 1) {
    const row = [i, ...Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j += 1) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[cols - 1]!;
}
