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
import { toKernelError } from './util/errors.ts';
import { newSessionId, type SessionId } from './util/ids.ts';
import { createLogger, installLogSanitizer, type Logger, type LogLevel } from './util/logger.ts';
import { systemClock, type Clock } from './util/clock.ts';
import { resolveKernelDirs, sessionsDir, type KernelDirs } from './util/platform.ts';

import { Redactor } from './security/redactor.ts';
import { InMemorySecretBroker, type SecretSource } from './security/secret-broker.ts';
import {
  checkCredentialFile,
  chooseCredentialSource,
  describeCredentialSource,
} from './security/credential-file.ts';
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
import { DelegationService, ROOT_SCOPE, type DelegateFn } from './session/delegation.ts';

import { loadConfig, projectRulesProfile } from './config/config.ts';
import { loadRemotes } from './config/remotes.ts';
import type { KernelConfig, ProviderEndpointConfig } from './config/schema.ts';

import {
  discoverSkills,
  resolveSkillActivation,
  type SkillActivationOutcome,
  type SkillActivationScope,
  type SkillDefinition,
} from './extensions/skills.ts';
import { discoverAgents, type AgentDefinition } from './extensions/agents.ts';
import { createDelegateTool } from './tools/builtin/delegate.ts';
import { createSkillTool } from './tools/builtin/skill.ts';
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
  /**
   * The root the tool plane operates on (ADR-0012).
   *
   * Equals `backend.environment.workspaceRoot`: the local project root for a
   * local backend, the **remote** workspace for an SSH one. Path resolution and
   * policy containment are both against this, so the two agree by construction.
   */
  workspaceRoot: CanonicalPath;
  /**
   * The local directory the session was started from (ADR-0012).
   *
   * Where project configuration, hooks, skills and agents are read from, and
   * where the session store is anchored. Always local, even with `--remote`.
   */
  projectRoot: CanonicalPath;
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
  /** Absent when the project defines no agents, in which case `Delegate` is not registered. */
  delegation?: DelegationService;
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
  //
  // There are **two** roots, and conflating them is what made `--remote`
  // unusable through alpha.3 (see ADR-0012):
  //
  //   projectRoot    the local directory the user invoked from. Where project
  //                  configuration lives — `.mycoder/config.toml`,
  //                  `permissions.toml`, `hooks.toml`, skills, agents — and
  //                  where the session store is anchored. Always local, because
  //                  the config that *names* a remote cannot itself be read
  //                  through that remote.
  //
  //   workspaceRoot  the root the tool plane operates on: path resolution,
  //                  policy containment, the repository plane, the mutation
  //                  detector. This is `backend.environment.workspaceRoot`,
  //                  which is the project root for a local backend and the
  //                  *remote* workspace for an SSH one (spec §19.1 puts fs,
  //                  grep, shell and git on the remote side).
  //
  // It is therefore computed **after** the backend exists, below.
  const dirs = opts.dirs ?? resolveKernelDirs(opts.dirsRoot ? { root: opts.dirsRoot } : {});
  const projectResolved = await canonicalize(opts.workspaceDir, { cwd: process.cwd() });
  const projectRoot = projectResolved.path;

  // 3. Configuration, then remotes.
  const overrides: Partial<KernelConfig> = {};
  if (opts.profileOverride) overrides.security = { permissionProfile: opts.profileOverride };
  if (opts.modelOverride) overrides.model = { default: opts.modelOverride };
  if (opts.telemetryDisabled) overrides.telemetry = { enabled: false, content: false, traceUpload: false };

  // Project configuration is read from the *local* tree. A config file that
  // names a remote cannot be read through that remote.
  const loaded = await loadConfig({
    workspaceRoot: projectRoot,
    userConfigDir: dirs.config,
    overrides,
  });
  const config = loaded.config;

  // Provider ids the *user* declared. Only these may open an egress destination.
  const userProviders = new Set(loaded.userProviderIds);

  const remotesResult = await loadRemotes(dirs.config);
  config.warnings.push(...remotesResult.warnings);

  // 4. Secrets. Provider credentials are registered by reference; the value is
  //    read from the host environment or a credential file only inside the
  //    broker.
  const secrets = new InMemorySecretBroker(redactor, clock);
  for (const [ref, variable] of [
    ['provider/anthropic', 'ANTHROPIC_API_KEY'],
    ['provider/openai', 'OPENAI_API_KEY'],
  ] as const) {
    if (process.env[variable]) secrets.register(ref, { kind: 'host-env', variable });
  }

  // 5. Protected paths and reference trees.
  // Reference trees are local paths, resolved against the local project root.
  // With a remote backend the tool plane cannot reach them — a real limitation,
  // recorded in ADR-0012 rather than papered over.
  const referenceRoots: CanonicalPath[] = [];
  for (const root of config.project.referenceRoots ?? []) {
    const resolved = await canonicalize(root, { cwd: projectRoot });
    referenceRoots.push(resolved.path);
  }

  // Credential files are resolved *before* ProtectedPaths is built, because the
  // validated path is one of its constructor inputs (alpha.3 §7). There is
  // deliberately no window in which a credential path is configured but not yet
  // protected: the object that enforces the denial cannot be constructed
  // without the list.
  const credentials = await resolveProviderCredentials({
    providers: config.model.providers ?? {},
    // The "credential inside the workspace" check is about the *local*
    // repository: that is what gets `git add`ed and published.
    workspaceRoot: projectRoot,
    referenceRoots,
    home: dirs.home,
    // A relative `api_key_file` anchors to the config directory that declared
    // it, not to the workspace — see CredentialFileCheckOptions.cwd.
    configDir: dirs.config,
    warnings: config.warnings,
  });

  const protectedPaths = new ProtectedPaths({
    home: dirs.home,
    configDir: dirs.config,
    referenceRoots,
    extraSecretPatterns: config.security.extraSecretPaths ?? [],
    credentialPaths: credentials.protectedPaths,
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
    backend = await LocalExecutionBackend.detect({
      workspaceRoot: projectRoot,
      redactor,
      logger: logger.child('local'),
    });
  }

  // The tool plane's root, and the single source of truth for it. For a local
  // backend this is `projectRoot`; for SSH it is the remote workspace. Deriving
  // it from the backend rather than recomputing it is what makes the two layers
  // agree by construction — the defect ADR-0012 describes was exactly the case
  // where they did not.
  const workspaceRoot = backend.environment.workspaceRoot;
  const agentTmpDir = path.join(projectDir(workspaceRoot), 'tmp') as CanonicalPath;

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
    const credential = credentials.byProvider.get(id);

    modelRegistry.registerEndpoint({
      id,
      protocol: entry.protocol,
      baseUrl: entry.baseUrl,
      authScheme: entry.authScheme ?? 'Bearer',
      // Declared whenever a source is *configured*, not only when its value is
      // available — see ResolvedCredential.configured.
      ...(credential?.configured ? { authSecretRef: `provider/${id}` } : {}),
      ...(entry.extraHeaders ? { extraHeaders: entry.extraHeaders } : {}),
    });

    // The credential is registered by *reference*. The broker reads the file or
    // the environment variable; nothing downstream ever sees the value, and the
    // file's path is already in the protected set by the time this runs.
    if (credential?.source) secrets.register(`provider/${id}`, credential.source);
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
  const resumedToolCalls: { issued: string[]; answered: string[] } = { issued: [], answered: [] };

  // 12b. Extensions: hooks must exist before the tool runtime and the session,
  // because both invoke lifecycle points (spec §18.1).
  // Hook definitions are a project file, so they are read locally; the commands
  // they declare execute through the backend, against `workspaceRoot`.
  const hookLoad = await loadHooks(projectRoot);
  config.warnings.push(...hookLoad.warnings);
  const hooks = new HookRunner(hookLoad.hooks, {
    backend,
    policy,
    workspaceRoot,
    agentTmpDir,
    logger: logger.child('hooks'),
    now: () => clock.now(),
  });

  // 12c. Skills and agents are project files too, read from the *local* tree.
  //
  // Discovered before the tool runtime because the `Skill` and `Delegate` tools
  // are only registered when there is something to activate or delegate to: a
  // project with no agents gets the same six-tool catalogue it had in alpha.3,
  // which keeps the model's prompt honest and every alpha.3 trajectory unchanged.
  const skills = await discoverSkills({ workspaceRoot: projectRoot, userConfigDir: dirs.config });
  const agents = await discoverAgents(projectRoot, dirs.config);

  // Assigned after the session exists; the closures below only run during a turn.
  let delegationService: DelegationService | undefined;

  /**
   * Dispatch a child on behalf of the `Delegate` tool.
   *
   * The parent's *effective* policy and catalogue are read from the runtime and
   * the session at call time rather than captured here, because a skill activated
   * mid-session narrows both — and a child derived from a stale snapshot would be
   * derived from capability its parent no longer has.
   */
  const delegate: DelegateFn = async (request, site) => {
    if (!delegationService) {
      throw new Error('delegation was requested in a session with no agents configured');
    }
    return delegationService.run(request, {
      ...site,
      parentPolicy: toolRuntime.policy,
      parentAllowedTools: session.effectiveAllowedTools,
      parentModelAlias: session.activeModelAlias,
    });
  };

  const activateSkillInSession = async (
    name: string,
    scope: SkillActivationScope,
    source: 'control' | 'model' | 'agent',
  ): Promise<SkillActivationOutcome> => {
    const resolved = resolveSkillActivation(name, {
      skills,
      registeredTools: toolRegistry.names(),
      currentAllowedTools: session.effectiveAllowedTools,
      profileContext,
      sessionMaxSteps: session.budgetCeiling.maxSteps,
    });
    if (!resolved.ok) return { ok: false, message: resolved.message };

    const applied = session.applySkillActivation(resolved.activated, scope, source);
    return {
      ok: true,
      message:
        `Skill "${name}" is active for this ${scope}. It applies from the ` +
        `${applied.appliedFrom === 'now' ? 'next' : 'following'} step, and can only narrow what is permitted.`,
      allowedTools: applied.allowedTools,
      notes: resolved.activated.notes,
    };
  };

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

    // The root session is depth 0 (ADR-0013). Both callbacks are late-bound to
    // the session below.
    delegationScope: ROOT_SCOPE,
    delegate,
    activateSkill: activateSkillInSession,

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
    // Recorded so a resume can notice the alias now points at a different
    // machine (§20 "verify remote identity"). Until this was written, the
    // metadata field existed and `checkResumeIdentity` read it, but nothing ever
    // set it — so the check could not fire.
    ...(backend.environment.hostIdentity ? { remoteIdentity: backend.environment.hostIdentity } : {}),
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
        ...(backend.environment.hostIdentity ? { remoteIdentity: backend.environment.hostIdentity } : {}),
      });
      if (!check.ok) {
        throw new Error(`Cannot resume this session:\n  ${check.problems.join('\n  ')}`);
      }
      context.replaceHistory(replayed.messages, 0);
      context.addFact({ id: 'resume-freshness', priority: 'critical', text: replayed.freshnessNote });
      config.warnings.push(...check.warnings, ...replayed.warnings);

      // The tool exchanges the previous process recorded. Carried into the new
      // session so the live half of the replay gate covers the whole log rather
      // than only the work done since the restart.
      for (const message of replayed.messages) {
        for (const part of message.parts) {
          if (part.type === 'tool_call') resumedToolCalls.issued.push(part.id);
          if (part.type === 'tool_result') resumedToolCalls.answered.push(part.toolCallId);
        }
      }
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
    ...(resumedToolCalls.issued.length > 0 || resumedToolCalls.answered.length > 0
      ? { resumedToolCalls }
      : {}),
  });

  // 15. Delegated execution (ADR-0013).
  //
  // Registered only when the project defines agents. A `Delegate` tool with no
  // agent to dispatch to would be a schema the model is invited to guess at, and
  // every refusal would cost a step to discover.
  if (agents.length > 0) {
    delegationService = new DelegationService({
      sessionId,
      agents,
      skills,
      registry: toolRegistry,
      backend,
      secrets,
      redactor,
      prompter,
      hooks,
      store,
      modelRuntime,
      modelRegistry,
      repository,
      editJournal,
      workspaceRoot,
      agentTmpDir,
      profileContext,
      logger: logger.child('delegation'),
      clock,
      kernelVersion: KERNEL_VERSION,
      environment: {
        sandboxDescription: `${sandbox.label} — ${sandbox.caveat}`,
        networkEnforcement: networkEnforcementLevel(backend.environment.sandboxStrength),
        backendDescription: backend.environment.description,
      },
      maxDepth: config.loop.maxDelegationDepth ?? ROOT_SCOPE.maxDepth,
      maxRepeatedFailures: config.loop.maxRepeatedFailures ?? 3,
      toolTimeoutMs: config.shell.timeoutMs ?? 120_000,
      rootCeiling: loopBudget,
      // The parent accounts for its children: usage, cost and the terminal state
      // the replay gate compares (§13, §14, §28).
      onRecord: (record) => session.recordDelegation(record),
    });

    toolRegistry.register(createDelegateTool({ agents: agents.map((a) => a.name) }));
  }

  if (skills.length > 0) {
    toolRegistry.register(
      createSkillTool({ skills: skills.map((s) => ({ name: s.name, description: s.description })) }),
    );
  }

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
    activateSkill: (name, scope) => activateSkillInSession(name, scope, 'control'),
    activeSkills: () => session.activeSkills(),
    delegations: () => ({
      active: delegationService?.activeDelegations() ?? [],
      finished: session.delegationRecords(),
    }),
    hooks: hookLoad.hooks.map((h: HookDefinition) => ({ event: h.event, command: h.command })),
    credentialSources: [...credentials.byProvider].map(([provider, c]) => ({
      provider,
      description: c.description,
    })),
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

    // Delegated straight through: compaction has to re-inject the same anchors
    // however it was triggered, and the second implementation that used to live
    // here did not know about delegations (§30).
    compactNow: () => session.compactNow(),

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
    projectRoot,
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
    ...(delegationService ? { delegation: delegationService } : {}),
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

interface ResolvedCredential {
  /** Absent when the provider has no *usable* credential. */
  source?: SecretSource;
  /**
   * True when configuration *declared* a credential source, usable or not.
   *
   * This drives `authSecretRef`, and the distinction from `source` matters more
   * than it looks. Gating the endpoint's auth reference on the value being
   * available means that when the value is missing the endpoint has **no auth at
   * all** — so the request is sent unauthenticated, travels to the provider, and
   * comes back 401. That is a network call that should never have left the
   * process, with the blame landing on the provider instead of on the missing
   * credential.
   *
   * Declaring the reference regardless makes the failure happen at the broker,
   * before any bytes move, as `MODEL_AUTH_ERROR` — which is exactly what the
   * startup warning promises will happen.
   */
  configured: boolean;
  /** The `/status` line: names the source, never the value. */
  description: string;
}

interface ResolvedCredentials {
  byProvider: Map<string, ResolvedCredential>;
  /** Canonical credential-file paths, for the protected-path set. */
  protectedPaths: CanonicalPath[];
}

/**
 * Resolve every provider's credential source (alpha.3 §5–§7).
 *
 * Three properties this function exists to guarantee, none of which survive
 * being spread across the call sites:
 *
 *  1. **Precedence is applied once**, by `chooseCredentialSource`, so `file`
 *     beating `env` is a single testable rule rather than an if-chain that
 *     drifts.
 *  2. **A rejected file is never a silent fallback.** If `api_key_file` is
 *     configured but insecure, the provider ends up with *no* credential even
 *     when `api_key_env` is also set and would have worked. Quietly falling
 *     back would mean the run succeeds and the user never learns their key file
 *     is world-readable — the failure has to be attached to the thing that is
 *     wrong.
 *  3. **The path is collected for protection even when validation fails.** A
 *     path the user pointed at a credential is a path the model has no business
 *     reading, whether or not the kernel could use it.
 *
 * Startup never throws here. A misconfigured credential produces a warning and
 * a `MODEL_AUTH_ERROR` on first use, which is a better failure than refusing to
 * start a session in which the user might have wanted to fix the file.
 */
async function resolveProviderCredentials(opts: {
  providers: Record<string, ProviderEndpointConfig>;
  workspaceRoot: CanonicalPath;
  referenceRoots: readonly CanonicalPath[];
  home: string;
  configDir: string;
  warnings: string[];
}): Promise<ResolvedCredentials> {
  const byProvider = new Map<string, ResolvedCredential>();
  const protectedPaths: CanonicalPath[] = [];

  for (const [id, entry] of Object.entries(opts.providers)) {
    const choice = chooseCredentialSource({
      ...(entry.apiKeyFile ? { apiKeyFile: entry.apiKeyFile } : {}),
      ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
    });

    for (const shadowed of choice.shadowed) {
      opts.warnings.push(
        `provider "${id}" configures both api_key_file and api_key_env; the file takes precedence ` +
          `and ${shadowed.selector} is unused`,
      );
    }

    if (choice.kind === 'file' && choice.selector) {
      let info;
      try {
        info = await checkCredentialFile(choice.selector, {
          cwd: opts.configDir,
          home: opts.home,
          workspaceRoot: opts.workspaceRoot,
          referenceRoots: opts.referenceRoots,
        });
      } catch (e) {
        const err = toKernelError(e);
        opts.warnings.push(
          `provider "${id}": ${err.message} Requests to it will fail with MODEL_AUTH_ERROR.`,
        );

        // Protect it anyway — see property 3 above. Canonicalised without
        // touching the filesystem, since the file may not exist.
        const lexical = await canonicalize(choice.selector, {
          cwd: opts.configDir,
          home: opts.home,
          resolveSymlinks: false,
        });
        protectedPaths.push(lexical.path);
        byProvider.set(id, { configured: true, description: describeCredentialSource(choice, false) });
        continue;
      }

      protectedPaths.push(info.path);
      byProvider.set(id, {
        source: { kind: 'file', path: info.path },
        configured: true,
        description: describeCredentialSource(choice, true),
      });
      continue;
    }

    if (choice.kind === 'env' && choice.selector) {
      // The one place outside the broker that looks at the host environment,
      // and only to decide whether the variable is *set* — the value is read
      // inside the broker, on demand, under a lease.
      if (process.env[choice.selector]) {
        byProvider.set(id, {
          source: { kind: 'host-env', variable: choice.selector },
          configured: true,
          description: describeCredentialSource(choice, true),
        });
      } else {
        opts.warnings.push(
          `provider "${id}" expects ${choice.selector}, which is not set; requests to it will fail with MODEL_AUTH_ERROR`,
        );
        byProvider.set(id, { configured: true, description: describeCredentialSource(choice, false) });
      }
      continue;
    }

    // No source configured at all: the endpoint gets no auth reference, which
    // is correct — there is nothing to reference.
    byProvider.set(id, { configured: false, description: describeCredentialSource(choice, false) });
  }

  return { byProvider, protectedPaths };
}
