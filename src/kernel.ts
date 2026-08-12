/**
 * Kernel bootstrap.
 *
 * Assembles the whole object graph in dependency order and returns a `Kernel`
 * the CLI (or a test) can drive. This is the only place that knows how the
 * pieces fit; everything else takes its collaborators as parameters, which is
 * what makes the security tests able to substitute a capturing transport or a
 * fake clock without touching the components under test.
 *
 * Assembly order matters in one respect: the redactor is created first and
 * installed as the logger's sanitiser before anything else can log, so there is
 * no window in which a credential could reach the terminal unredacted.
 */

import * as path from 'node:path';

import { PROJECT_DIR, projectDir } from './app.ts';
import { canonicalize, displayPath, type CanonicalPath } from './util/paths.ts';
import { newSessionId, type SessionId } from './util/ids.ts';
import { createLogger, installLogSanitizer, type Logger, type LogLevel } from './util/logger.ts';
import { systemClock, type Clock } from './util/clock.ts';
import { resolveKernelDirs, sessionsDir, type KernelDirs } from './util/platform.ts';

import { Redactor } from './security/redactor.ts';
import { InMemorySecretBroker } from './security/secret-broker.ts';
import {
  DefaultEgressGate,
  defaultEgressPolicy,
  type EgressGate,
  type EgressTransport,
} from './security/egress-gate.ts';

import { ProtectedPaths } from './policy/protected-paths.ts';
import { buildProfile, workspaceDevProfile, type PermissionProfile } from './policy/profiles.ts';
import { PolicyEngine, SessionApprovalStore, type PolicyLayer } from './policy/policy-engine.ts';

import { LocalExecutionBackend } from './execution/local.ts';
import { SshExecutionBackend, type RemoteConfig } from './execution/ssh.ts';
import { MutationDetector } from './execution/mutation-detector.ts';
import { describeSandbox, networkEnforcementLevel } from './execution/sandbox.ts';
import type { ExecutionBackend } from './execution/backend.ts';

import { ModelRegistry, type ResolvedModelProfile } from './model/profiles.ts';
import { HttpModelRuntime, RoutingModelRuntime } from './model/runtime.ts';
import { AnthropicMessagesAdapter } from './model/adapters/anthropic.ts';
import { OpenAiChatAdapter } from './model/adapters/openai-chat.ts';
import { OpenAiResponsesAdapter } from './model/adapters/openai-responses.ts';
import { FakeModel } from './model/adapters/fake.ts';
import type { ModelRuntime } from './model/ir.ts';

import { FreshnessLedger } from './context/freshness.ts';
import { RepositoryPlane } from './context/repository-plane.ts';
import { ContextEngine } from './context/context-engine.ts';
import { ContextProjector } from './context/projector.ts';
import { compact } from './context/compaction.ts';

import { EditJournal } from './edit/atomic-write.ts';

import { ToolRegistry } from './tools/registry.ts';
import { ToolRuntime, DenyAllPrompter, type ApprovalPrompter } from './tools/runtime.ts';
import { createReadTool } from './tools/builtin/read.ts';
import { createGrepTool } from './tools/builtin/grep.ts';
import { createGlobTool } from './tools/builtin/glob.ts';
import { createEditTool } from './tools/builtin/edit.ts';
import { createShellTool } from './tools/builtin/shell.ts';
import { createGitDiffTool } from './tools/builtin/git-diff.ts';

import { FileSessionStore, type SessionMetadata, type SessionStore } from './session/store.ts';
import { Session } from './session/session.ts';
import { DEFAULT_LOOP_BUDGET, FailureTracker, type LoopBudget } from './session/step.ts';
import { replaySession, workspaceIdentity, checkResumeIdentity } from './session/resume.ts';

import { loadConfig, projectRulesProfile } from './config/config.ts';
import { loadRemotes } from './config/remotes.ts';
import type { KernelConfig } from './config/schema.ts';

import { discoverSkills, type SkillDefinition } from './extensions/skills.ts';
import { discoverAgents, type AgentDefinition } from './extensions/agents.ts';
import { HookRunner, loadHooks, type HookDefinition } from './extensions/hooks.ts';

import { ControlPlane, type ControlHost } from './control/control-plane.ts';

export const KERNEL_VERSION = '0.1.0';

export interface CreateKernelOptions {
  workspaceDir: string;
  /** CLI-level overrides, applied above project and user config. */
  profileOverride?: string;
  modelOverride?: string;
  remoteName?: string;
  telemetryDisabled?: boolean;
  logLevel?: LogLevel;
  json?: boolean;
  /** Redirect log output. Used by the security suite to capture the debug sink. */
  logSink?: (line: string) => void;
  nonInteractive?: boolean;
  prompter?: ApprovalPrompter;
  clock?: Clock;
  /** Test seams. */
  dirs?: KernelDirs;
  dirsRoot?: string;
  egressTransport?: EgressTransport;
  fakeModel?: FakeModel;
  store?: SessionStore;
  resumeSessionId?: string;
}

export interface Kernel {
  sessionId: SessionId;
  workspaceRoot: CanonicalPath;
  config: KernelConfig;
  configSources: string[];
  dirs: KernelDirs;
  logger: Logger;
  redactor: Redactor;
  secrets: InMemorySecretBroker;
  egress: DefaultEgressGate;
  policy: PolicyEngine;
  backend: ExecutionBackend;
  modelRegistry: ModelRegistry;
  modelRuntime: ModelRuntime;
  toolRegistry: ToolRegistry;
  toolRuntime: ToolRuntime;
  context: ContextEngine;
  projector: ContextProjector;
  freshness: FreshnessLedger;
  editJournal: EditJournal;
  store: SessionStore;
  session: Session;
  control: ControlPlane;
  hooks: HookRunner;
  skills: SkillDefinition[];
  agents: AgentDefinition[];
  remotes: RemoteConfig[];
  fakeModel?: FakeModel;
  shutdown(): Promise<void>;
}

export async function createKernel(opts: CreateKernelOptions): Promise<Kernel> {
  const clock = opts.clock ?? systemClock;

  // 1. Redaction first, so nothing can log a credential before it is installed.
  const redactor = new Redactor();
  installLogSanitizer((text) => redactor.redact(text, { minConfidence: 'high' }));

  const logger = createLogger({
    level: opts.logLevel ?? 'info',
    scope: 'kernel',
    json: opts.json ?? false,
    // The debug log is one of the six sinks spec §26.1 requires the canary to
    // stay out of, so it has to be capturable by the security suite. Without
    // this seam that sink could only be checked by reading the terminal.
    ...(opts.logSink ? { write: opts.logSink } : {}),
  });

  // 2. Paths.
  const dirs = opts.dirs ?? resolveKernelDirs(opts.dirsRoot ? { root: opts.dirsRoot } : {});
  const workspaceResolved = await canonicalize(opts.workspaceDir, { cwd: process.cwd() });
  const workspaceRoot = workspaceResolved.path;
  const agentTmpDir = path.join(projectDir(workspaceRoot), 'tmp') as CanonicalPath;

  // 3. Configuration, then remotes.
  const overrides: Partial<KernelConfig> = {};
  if (opts.profileOverride) overrides.security = { permissionProfile: opts.profileOverride };
  if (opts.modelOverride) overrides.model = { default: opts.modelOverride };
  if (opts.telemetryDisabled) overrides.telemetry = { enabled: false, content: false, traceUpload: false };

  const loaded = await loadConfig({
    workspaceRoot,
    userConfigDir: dirs.config,
    overrides,
  });
  const config = loaded.config;

  // Provider ids the *user* declared. Only these may open an egress destination.
  const userProviders = new Set(loaded.userProviderIds);

  const remotesResult = await loadRemotes(dirs.config);
  config.warnings.push(...remotesResult.warnings);

  // 4. Secrets. Provider credentials are registered by reference; the value is
  //    read from the host environment only inside the broker.
  const secrets = new InMemorySecretBroker(redactor, clock);
  for (const [ref, variable] of [
    ['provider/anthropic', 'ANTHROPIC_API_KEY'],
    ['provider/openai', 'OPENAI_API_KEY'],
  ] as const) {
    if (process.env[variable]) secrets.register(ref, { kind: 'host-env', variable });
  }

  // 5. Protected paths and reference trees.
  const referenceRoots: CanonicalPath[] = [];
  for (const root of config.project.referenceRoots ?? []) {
    const resolved = await canonicalize(root, { cwd: workspaceRoot });
    referenceRoots.push(resolved.path);
  }
  const protectedPaths = new ProtectedPaths({
    home: dirs.home,
    configDir: dirs.config,
    referenceRoots,
    extraSecretPatterns: config.security.extraSecretPaths ?? [],
  });

  // 6. Execution backend.
  const remotes = remotesResult.remotes;
  let backend: ExecutionBackend;
  let activeRemote: string | undefined;

  if (opts.remoteName) {
    const remote = remotes.find((r) => r.name === opts.remoteName);
    if (!remote) {
      throw new Error(
        `Remote "${opts.remoteName}" is not configured. Add it to ${path.join(dirs.config, 'remotes.toml')}.`,
      );
    }
    backend = await SshExecutionBackend.connect({ config: remote, redactor, logger: logger.child('ssh') });
    activeRemote = remote.name;
  } else {
    backend = await LocalExecutionBackend.detect({ workspaceRoot, redactor, logger: logger.child('local') });
  }

  // 7. Policy layers, broadest to narrowest. The engine takes the strictest
  //    vote across all of them, so order is presentational only.
  const profileContext = {
    workspaceRoot,
    agentTmpDir,
    generatedPaths: config.generatedPaths,
  };
  const profileName = config.security.permissionProfile ?? 'workspace-dev';
  const sessionProfile: PermissionProfile =
    buildProfile(profileName, profileContext) ?? workspaceDevProfile(profileContext);
  if (!buildProfile(profileName, profileContext)) {
    config.warnings.push(`Unknown permission profile "${profileName}"; using workspace-dev.`);
  }

  const layers: PolicyLayer[] = [
    { name: `session:${sessionProfile.name}`, source: 'session', profile: sessionProfile },
  ];
  if (loaded.projectRules.length > 0) {
    layers.push({
      name: `project:${PROJECT_DIR}/permissions.toml`,
      source: 'project',
      profile: projectRulesProfile(loaded.projectRules),
    });
  }

  const policy = new PolicyEngine({
    workspaceRoot,
    protectedPaths,
    layers,
    approvals: new SessionApprovalStore(),
  });

  // 8. Egress. Model hosts come from the provider endpoints; everything else
  //    stays closed unless configuration opens it.
  const egressPolicy = defaultEgressPolicy();

  // A provider endpoint the user declared in their own config is, by that act,
  // an intended destination — requiring them to repeat the host under [egress]
  // would be friction with no added safety. Project-declared endpoints never
  // reach here, so a repository cannot open an egress destination this way.
  for (const id of userProviders) {
    const entry = config.model.providers?.[id];
    if (!entry) continue;
    try {
      const host = new URL(entry.baseUrl).hostname;
      egressPolicy.model = {
        ...egressPolicy.model,
        allowedHosts: [...egressPolicy.model.allowedHosts, host],
      };
    } catch {
      config.warnings.push(
        `provider "${id}" has an unparsable base_url; it was not added to the egress allowlist`,
      );
    }
  }

  for (const [kind, hosts] of Object.entries(config.egress.allowedHosts ?? {})) {
    const key = kind as keyof typeof egressPolicy;
    if (egressPolicy[key]) {
      egressPolicy[key] = {
        ...egressPolicy[key],
        allowedHosts: [...egressPolicy[key].allowedHosts, ...hosts],
      };
    }
  }
  const egress = new DefaultEgressGate({
    policy: egressPolicy,
    redactor,
    ...(opts.egressTransport ? { transport: opts.egressTransport } : {}),
    now: () => clock.now(),
    onAudit: (record) => logger.debug('egress', { ...record }),
  });

  // 9. Models.
  const modelRegistry = new ModelRegistry();

  // Config-declared behaviour profiles, before the aliases that reference them.
  // A wrong context window is not cosmetic: it drives compaction, so a model
  // stuck with a default profile compacts at the wrong point.
  for (const [name, entry] of Object.entries(config.model.profiles ?? {})) {
    modelRegistry.registerProfile(name, {
      family: entry.family ?? name,
      contextWindow: entry.contextWindow,
      ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      reservedOutputTokens: entry.reservedOutputTokens ?? Math.min(entry.maxOutputTokens ?? 8_000, 8_000),
      supportsParallelTools: entry.supportsParallelTools ?? false,
      supportsReasoning: entry.supportsReasoning ?? false,
      preferredEditStrategy: entry.preferredEditStrategy ?? 'exact',
      autonomy: entry.autonomy ?? 'normal',
      toolReliability: entry.toolReliability ?? 'medium',
      ...(entry.inputPerMTok !== undefined || entry.outputPerMTok !== undefined
        ? {
            pricing: {
              ...(entry.inputPerMTok !== undefined ? { inputPerMTok: entry.inputPerMTok } : {}),
              ...(entry.outputPerMTok !== undefined ? { outputPerMTok: entry.outputPerMTok } : {}),
              ...(entry.cachedInputPerMTok !== undefined
                ? { cachedInputPerMTok: entry.cachedInputPerMTok }
                : {}),
            },
          }
        : {}),
    });
  }

  // Config-declared provider endpoints. `loadConfig` has already dropped any
  // that a project file tried to define, so everything here came from the
  // user's own config.
  for (const [id, entry] of Object.entries(config.model.providers ?? {})) {
    modelRegistry.registerEndpoint({
      id,
      protocol: entry.protocol,
      baseUrl: entry.baseUrl,
      authScheme: entry.authScheme ?? 'Bearer',
      ...(entry.apiKeyEnv ? { authSecretRef: `provider/${id}` } : {}),
      ...(entry.extraHeaders ? { extraHeaders: entry.extraHeaders } : {}),
    });

    // The credential is registered by *reference*: the broker reads the host
    // environment variable, and nothing downstream ever sees the value.
    if (entry.apiKeyEnv && process.env[entry.apiKeyEnv]) {
      secrets.register(`provider/${id}`, { kind: 'host-env', variable: entry.apiKeyEnv });
    } else if (entry.apiKeyEnv) {
      config.warnings.push(
        `provider "${id}" expects ${entry.apiKeyEnv}, which is not set; requests to it will fail with MODEL_AUTH_ERROR`,
      );
    }
  }

  for (const [alias, entry] of Object.entries(config.model.aliases ?? {})) {
    modelRegistry.registerAlias({
      alias,
      provider: entry.provider,
      modelId: entry.model,
      profile: entry.profile ?? 'frontier-normal',
    });
  }

  const resolveModel = (modelId: string, provider: string): ResolvedModelProfile | undefined => {
    for (const alias of modelRegistry.listAliases()) {
      const resolved = modelRegistry.resolve(alias.alias);
      if (resolved && resolved.modelId === modelId && resolved.provider.id === provider) return resolved;
    }
    return undefined;
  };

  const httpRuntime = new HttpModelRuntime({
    egress,
    secrets,
    adapters: [new AnthropicMessagesAdapter(), new OpenAiChatAdapter(), new OpenAiResponsesAdapter()],
    resolveModel,
    logger: logger.child('model'),
  });

  const fakeModel = opts.fakeModel ?? new FakeModel();
  const modelRuntime = new RoutingModelRuntime(
    new Map<string, ModelRuntime>([
      ['anthropic-messages', httpRuntime],
      ['openai-chat', httpRuntime],
      ['openai-responses', httpRuntime],
      ['fake', fakeModel],
    ]) as Map<ResolvedModelProfile['provider']['protocol'], ModelRuntime>,
    resolveModel,
  );

  // 10. Context planes.
  const freshness = new FreshnessLedger();
  const repository = new RepositoryPlane({ workspaceRoot, referenceRoots });
  const context = new ContextEngine({ repository, freshness, now: () => clock.now() });
  const editJournal = new EditJournal();

  const sandbox = describeSandbox(backend.environment.sandboxStrength);
  const projector = new ContextProjector({
    sandboxDescription: `${sandbox.label} — ${sandbox.caveat}`,
    networkEnforcement: networkEnforcementLevel(backend.environment.sandboxStrength),
    permissionProfile: sessionProfile.name,
    backendDescription: backend.environment.description,
    editJournal,
  });

  // 11. Tools.
  const detector = new MutationDetector(workspaceRoot, config.generatedPaths, backend.environment.hasGit);
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createReadTool());
  toolRegistry.register(createGrepTool());
  toolRegistry.register(createGlobTool());
  toolRegistry.register(createGitDiffTool());
  toolRegistry.register(createEditTool({ journal: editJournal }));
  toolRegistry.register(
    createShellTool({
      detector,
      defaultTimeoutMs: config.shell.timeoutMs ?? 120_000,
      onUndeclaredMutation: (changes) => {
        // Surface the change as a fact for the next step (spec §10.4) rather
        // than letting it disappear into the shell output.
        context.addFact({
          id: 'undeclared-mutation',
          priority: 'critical',
          text:
            `A shell command changed ${changes.length} source/test/config file(s) without an Edit: ` +
            `${changes
              .slice(0, 5)
              .map((c) => c.path)
              .join(', ')}. Review them before continuing.`,
        });
      },
    }),
  );

  // 12. Session store.
  const store = opts.store ?? new FileSessionStore({ rootDir: sessionsDir(dirs), redactor, clock });

  const sessionId = (opts.resumeSessionId as SessionId | undefined) ?? newSessionId(clock.now());

  // 12b. Extensions: hooks must exist before the tool runtime and the session,
  // because both invoke lifecycle points (spec §18.1).
  const hookLoad = await loadHooks(workspaceRoot);
  config.warnings.push(...hookLoad.warnings);
  const hooks = new HookRunner(hookLoad.hooks, {
    backend,
    policy,
    workspaceRoot,
    agentTmpDir,
    logger: logger.child('hooks'),
    now: () => clock.now(),
  });

  // 13. Tool runtime.
  const prompter: ApprovalPrompter =
    opts.prompter ??
    (opts.nonInteractive
      ? new DenyAllPrompter()
      : new DenyAllPrompter(
          `Approval is required. Run without --non-interactive, or grant it in ${PROJECT_DIR}/permissions.toml.`,
        ));

  const toolRuntime = new ToolRuntime({
    registry: toolRegistry,
    policy,
    backend,
    secrets,
    redactor,
    freshness,
    prompter,
    logger: logger.child('tools'),
    workspaceRoot,
    agentTmpDir,
    failures: new FailureTracker(config.loop.maxRepeatedFailures ?? 3),
    now: () => clock.now(),
    toolTimeoutMs: config.shell.timeoutMs ?? 120_000,
    writeArtifact: (name, content) => store.writeArtifact(sessionId, name, content),

    // PreToolUse / PostToolUse / PermissionRequest. Routed through the session
    // so hook output lands in the conversation with its provenance attached.
    runHooks: async (event, hookCtx) => {
      await session.runHooks(event, session.turn?.turnId, hookCtx);
    },

    // Domain audit events (spec §21.2). `tool.call` / `tool.result` record that
    // a call happened; these record *what it did to the world* — which read
    // produced which receipt, which edit changed which hash, which command ran.
    // Without them the log can tell you a file changed but not why.
    onRecord: (record) => {
      const meta = record.metadata;
      if (!meta) return;
      const scope = { turnId: record.turnId, stepId: record.stepId };

      if (record.name === 'Read' && typeof meta.receiptId === 'string') {
        void store.append(sessionId, {
          type: 'file.read',
          payload: {
            receiptId: meta.receiptId,
            path: meta.path,
            contentHash: meta.contentHash,
            coverage: meta.coverage,
            bytes: meta.bytes,
            redactions: meta.redactions,
          },
          ...scope,
        });
        return;
      }

      if (record.name === 'Edit' && typeof meta.newHash === 'string') {
        void store.append(sessionId, {
          type: 'file.edited',
          payload: {
            path: meta.path,
            toolCallId: record.toolCallId,
            oldHash: meta.oldHash,
            newHash: meta.newHash,
            diff: meta.diff,
            linesAdded: meta.linesAdded,
            linesRemoved: meta.linesRemoved,
            eol: meta.eol,
            created: meta.created,
          },
          ...scope,
        });
        return;
      }

      if (record.name === 'Shell') {
        void store.append(sessionId, {
          type: 'shell.executed',
          payload: {
            toolCallId: record.toolCallId,
            exitCode: meta.exitCode,
            durationMs: meta.durationMs,
            changed: meta.changed,
            undeclared: meta.undeclared,
            snapshotStrategy: meta.snapshotStrategy,
          },
          ...scope,
        });
        if (typeof meta.undeclared === 'number' && meta.undeclared > 0) {
          void store.append(sessionId, {
            type: 'workspace.mutation',
            payload: {
              detectedBy: 'shell',
              toolCallId: record.toolCallId,
              undeclared: true,
              count: meta.undeclared,
            },
            ...scope,
          });
        }
      }
    },

    // Only non-allow decisions are logged. Recording every permitted read would
    // bury the interesting ones in noise.
    onPolicyDecision: (decision, toolCallId) => {
      if (decision.action === 'allow') return;
      void store.append(sessionId, {
        type: decision.action === 'ask' ? 'approval.requested' : 'policy.decision',
        payload: {
          toolCallId,
          capability: decision.access.kind,
          subject: decision.subjectKey,
          action: decision.action,
          reason: decision.reason,
          layer: decision.layer,
        },
      });
    },

    onApproval: (subjectKey, granted, scope, summary) => {
      void store.append(sessionId, {
        type: 'approval.decided',
        payload: { subject: subjectKey, granted, scope, summary },
      });
    },
  });

  // 14. Session.
  const loopBudget: LoopBudget = {
    maxSteps: config.loop.maxSteps ?? DEFAULT_LOOP_BUDGET.maxSteps,
    maxWallTimeMs: config.loop.maxWallTimeMs ?? DEFAULT_LOOP_BUDGET.maxWallTimeMs,
    maxModelRequests: config.loop.maxModelRequests ?? DEFAULT_LOOP_BUDGET.maxModelRequests,
    maxToolCalls: config.loop.maxToolCalls ?? DEFAULT_LOOP_BUDGET.maxToolCalls,
    maxRepeatedEquivalentFailures: config.loop.maxRepeatedFailures ?? 3,
    ...(config.loop.maxCostUsd !== undefined ? { maxCostUsd: config.loop.maxCostUsd } : {}),
  };

  const facts = await repository.load(async (argv) => {
    if (!backend.environment.hasGit) return { stdout: '', exitCode: 1 };
    const executor = await backend.enforce({
      readRoots: [workspaceRoot],
      writeRoots: [],
      allowExec: true,
      network: false,
      envAllow: [],
      secretInjections: [],
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024,
    });
    try {
      const result = await executor.exec({ argv, cwd: workspaceRoot, timeoutMs: 15_000 });
      return { stdout: result.stdout, exitCode: result.exitCode };
    } finally {
      executor.dispose();
    }
  });

  const modelAlias = config.model.default ?? 'fake';
  const metadata: SessionMetadata = {
    sessionId,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    kernelVersion: KERNEL_VERSION,
    workspaceRoot,
    workspaceIdentity: workspaceIdentity(workspaceRoot, facts.git.root),
    ...(activeRemote ? { remote: activeRemote } : {}),
    model: modelAlias,
    permissionProfile: sessionProfile.name,
    backendKind: backend.kind,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      modelRequests: 0,
      toolCalls: 0,
    },
    lastSeq: 0,
  };

  if (opts.resumeSessionId) {
    const replayed = await replaySession(store, sessionId);
    if (replayed) {
      const check = checkResumeIdentity(replayed.metadata, {
        workspaceRoot,
        workspaceIdentity: metadata.workspaceIdentity,
        ...(activeRemote ? { remote: activeRemote } : {}),
      });
      if (!check.ok) {
        throw new Error(`Cannot resume this session:\n  ${check.problems.join('\n  ')}`);
      }
      context.replaceHistory(replayed.messages, 0);
      context.addFact({ id: 'resume-freshness', priority: 'critical', text: replayed.freshnessNote });
      config.warnings.push(...check.warnings, ...replayed.warnings);
    }
  } else {
    await store.createSession(metadata);
    await store.append(sessionId, {
      type: 'session.started',
      payload: {
        workspaceRoot,
        workspaceIdentity: metadata.workspaceIdentity,
        model: modelAlias,
        permissionProfile: sessionProfile.name,
        backend: backend.environment.description,
        sandboxStrength: backend.environment.sandboxStrength,
        kernelVersion: KERNEL_VERSION,
      },
    });
  }

  const session = new Session({
    sessionId,
    workspaceRoot,
    store,
    context,
    projector,
    toolRegistry,
    toolRuntime,
    modelRuntime,
    modelRegistry,
    backend,
    editJournal,
    logger: logger.child('session'),
    clock,
    kernelVersion: KERNEL_VERSION,
    modelAlias,
    permissionProfile: sessionProfile.name,
    loopBudgetCeiling: loopBudget,
    hooks,
  });

  const skills = await discoverSkills({ workspaceRoot, userConfigDir: dirs.config });
  const agents = await discoverAgents(workspaceRoot, dirs.config);

  // 16. Control plane.
  const host: ControlHost = {
    session,
    policy,
    config,
    environment: backend.environment,
    modelRegistry,
    configSources: loaded.sources,
    remotes,
    ...(activeRemote ? { activeRemote } : {}),
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
    agents: agents.map((a) => ({ name: a.name, description: a.description })),
    hooks: hookLoad.hooks.map((h: HookDefinition) => ({ event: h.event, command: h.command })),
    now: () => clock.now(),

    async connectRemote(name: string) {
      const remote = remotes.find((r) => r.name === name);
      if (!remote) return { ok: false, message: `Remote "${name}" is not configured.` };
      return {
        ok: false,
        message:
          `Switching backend mid-session is applied after the current tool call completes (spec §19.4), ` +
          `and is not wired up in v0.1. Restart with: agent --remote ${name}`,
      };
    },

    async disconnectRemote() {
      return {
        ok: false,
        message: 'Backend switching mid-session is not available in v0.1. Restart without --remote.',
      };
    },

    async compactNow() {
      const snapshot = projector.project(context, repository.facts);
      const resolved = modelRegistry.resolve(session.activeModelAlias);
      const budgetTokens = resolved
        ? Math.floor(ModelRegistry.usableContextTokens(resolved.profile) * 0.6)
        : 8_000;
      const result = compact(context.history(), snapshot.system, {
        budgetTokens,
        ...(context.goal ? { goal: context.goal } : {}),
        reinject: [editJournal.summary()],
      });
      context.replaceHistory(result.messages, result.boundary);
      for (const receipt of freshness.list()) freshness.invalidatePath(receipt.path);
      await store.append(sessionId, {
        type: 'compaction.boundary',
        payload: {
          level: result.levelsApplied.at(-1) ?? 'L1',
          droppedMessages: result.droppedMessages,
          summaryLength: result.summaryLength,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          preservedExchanges: result.preservedExchanges,
        },
      });
      return {
        droppedMessages: result.droppedMessages,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      };
    },

    contextUsage() {
      const snapshot = projector.project(context, repository.facts);
      const resolved = modelRegistry.resolve(session.activeModelAlias);
      return {
        estimatedTokens: snapshot.estimatedTokens,
        budgetTokens: resolved ? ModelRegistry.usableContextTokens(resolved.profile) : 0,
      };
    },
  };

  const control = new ControlPlane(host);

  // SessionStart fires once the whole graph exists, so a hook can observe a
  // fully-formed session rather than a half-built one.
  await session.runHooks('SessionStart', undefined, {});

  return {
    sessionId,
    workspaceRoot,
    config,
    configSources: loaded.sources,
    dirs,
    logger,
    redactor,
    secrets,
    egress,
    policy,
    backend,
    modelRegistry,
    modelRuntime,
    toolRegistry,
    toolRuntime,
    context,
    projector,
    freshness,
    editJournal,
    store,
    session,
    control,
    hooks,
    skills,
    agents,
    remotes,
    ...(opts.fakeModel ? { fakeModel: opts.fakeModel } : { fakeModel }),

    async shutdown() {
      // SessionEnd runs before anything is torn down, so a hook can still use
      // the executor. Its failure must not stop the shutdown.
      await session.runHooks('SessionEnd', undefined, {}).catch(() => {});
      await session.persistMetadata();
      await store.close();
      await backend.close();
      secrets.releaseAll();
    },
  };
}

/** Display helper shared by the CLI. */
export function relative(workspaceRoot: CanonicalPath, p: CanonicalPath): string {
  return displayPath(workspaceRoot, p);
}
