/**
 * Public surface of the kernel.
 *
 * Everything exported here is a contract described by the spec. Internal
 * reorganisation is free; changing one of these shapes needs an ADR
 * (AGENTS.md rule 4).
 */

export { createKernel, KERNEL_VERSION, type Kernel, type CreateKernelOptions } from './kernel.ts';

// --- lifecycle ---
export { Session, type TurnOutcome } from './session/session.ts';
export { Turn, type TurnState, TERMINAL_STATES } from './session/turn.ts';
export {
  type StepContext,
  type LoopBudget,
  DEFAULT_LOOP_BUDGET,
  LoopBudgetTracker,
  FailureTracker,
  freezeStepContext,
  assertStepUnchanged,
} from './session/step.ts';
export { type KernelEvent, type KernelEventType } from './session/events.ts';
export {
  FileSessionStore,
  MemorySessionStore,
  type SessionStore,
  type SessionMetadata,
} from './session/store.ts';
export { replaySession, checkResumeIdentity, workspaceIdentity, describeResume } from './session/resume.ts';

// --- model ---
export type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  MediaPart,
  ModelMessage,
  ModelRequest,
  ModelEvent,
  ModelRuntime,
  ModelTurn,
  FinishReason,
  ToolSchema,
} from './model/ir.ts';
export { collectModelEvents } from './model/ir.ts';
export { ModelRegistry, type ModelProfile, type ResolvedModelProfile } from './model/profiles.ts';
export { HttpModelRuntime, RoutingModelRuntime, type ProtocolAdapter } from './model/runtime.ts';
export { FakeModel, type FakeStep, toolStep, finalStep, errorStep } from './model/adapters/fake.ts';
export { AnthropicMessagesAdapter } from './model/adapters/anthropic.ts';
export { OpenAiChatAdapter } from './model/adapters/openai-chat.ts';
export { OpenAiResponsesAdapter } from './model/adapters/openai-responses.ts';

// --- context ---
export { ContextEngine, type ContextSnapshot, type GoalState } from './context/context-engine.ts';
export { ContextProjector } from './context/projector.ts';
export { RepositoryPlane, type RepositoryFacts } from './context/repository-plane.ts';
export { FreshnessLedger, type SourceReceipt, type Coverage, freshnessError } from './context/freshness.ts';
export { compact, needsCompaction, structuralSummary, type CompactionResult } from './context/compaction.ts';

// --- tools ---
export {
  type ToolDefinition,
  type ToolExecution,
  type ToolResult,
  type ToolResolveContext,
  type ApprovalSubject,
  okResult,
  errorResult,
} from './tools/contract.ts';
export { ToolRegistry, type ToolCatalogView } from './tools/registry.ts';
export {
  ToolRuntime,
  DenyAllPrompter,
  syntheticInterruptedResult,
  type ApprovalPrompter,
  type ApprovalRequest,
  type ApprovalOutcome,
} from './tools/runtime.ts';
export { createReadTool } from './tools/builtin/read.ts';
export { createGrepTool } from './tools/builtin/grep.ts';
export { createGlobTool } from './tools/builtin/glob.ts';
export { createEditTool } from './tools/builtin/edit.ts';
export { createShellTool } from './tools/builtin/shell.ts';
export { createGitDiffTool } from './tools/builtin/git-diff.ts';

// --- edit ---
export { ExactEditEngine, type EditProposal, type EditPlan } from './edit/edit-engine.ts';
export { unifiedDiff, summarizeDiff, type DiffResult } from './edit/diff.ts';
export { EditJournal, type RollbackMetadata } from './edit/atomic-write.ts';

// --- policy ---
export type { AccessRequest, Capability } from './policy/access.ts';
export { capabilityOf, subjectKeyOf, describeAccess } from './policy/access.ts';
export {
  PolicyEngine,
  SessionApprovalStore,
  decisionToError,
  type PolicyDecision,
  type PolicyLayer,
} from './policy/policy-engine.ts';
export {
  buildProfile,
  listProfileNames,
  readOnlyProfile,
  workspaceDevProfile,
  reviewProfile,
  type PermissionProfile,
  type PolicyAction,
  type PolicyRule,
} from './policy/profiles.ts';
export { ProtectedPaths } from './policy/protected-paths.ts';

// --- security ---
export { Redactor, redactionPlaceholder } from './security/redactor.ts';
export { scanSecrets, hasSecret, SECRET_RULES } from './security/secret-scanner.ts';
export {
  InMemorySecretBroker,
  SecretLease,
  type SecretBroker,
  type SecretRef,
} from './security/secret-broker.ts';
export {
  scrubEnv,
  assertNoCredentialEnv,
  DEFAULT_ENV_ALLOWLIST,
  CREDENTIAL_ENV_PATTERNS,
} from './security/env-scrub.ts';
export {
  DefaultEgressGate,
  DeniedEgressGate,
  defaultEgressPolicy,
  TELEMETRY_FIELD_ALLOWLIST,
  type EgressGate,
  type EgressKind,
  type EgressTransport,
} from './security/egress-gate.ts';

// --- execution ---
export type {
  ExecutionBackend,
  CapabilityExecutor,
  CapabilityProfile,
  EnvironmentDescriptor,
  SandboxStrength,
} from './execution/backend.ts';
export { LocalExecutionBackend } from './execution/local.ts';
export { SshExecutionBackend, validateRemoteConfig, type RemoteConfig } from './execution/ssh.ts';
export { SandboxPlanner, describeSandbox, networkEnforcementLevel } from './execution/sandbox.ts';
export { MutationDetector, type WorkspaceChange } from './execution/mutation-detector.ts';

// --- extensions ---
export { discoverSkills, activateSkill, narrowForSkill, type SkillDefinition } from './extensions/skills.ts';
export {
  discoverAgents,
  deriveSubagent,
  RECOMMENDED_AGENTS,
  type AgentDefinition,
} from './extensions/agents.ts';
export {
  HookRunner,
  loadHooks,
  USER_HOOK_EVENTS,
  TRUSTED_KERNEL_HOOKS,
  type HookDefinition,
} from './extensions/hooks.ts';

// --- control plane ---
export { ControlPlane, type ControlResult, type ControlHost } from './control/control-plane.ts';
export { parseArgs, USAGE } from './cli/args.ts';
export { parseShellLine, describePlan, type ShellPlan } from './cli/shell-parse.ts';
export { TerminalApprovalPrompter, ScriptedPrompter, renderApproval } from './cli/prompter.ts';

// --- config ---
export { loadConfig, describeConfig, projectRulesProfile } from './config/config.ts';
export { loadRemotes } from './config/remotes.ts';
export {
  defaultConfig,
  mergeConfig,
  applySystemCeiling,
  SYSTEM_CEILING,
  type KernelConfig,
} from './config/schema.ts';

// --- errors and utilities that cross module boundaries ---
export {
  kernelError,
  toKernelError,
  renderErrorForModel,
  KernelErrorException,
  ERROR_CODES,
  type KernelError,
  type ErrorCode,
} from './util/errors.ts';
export { canonicalize, isWithin, displayPath, type CanonicalPath } from './util/paths.ts';
export { createLogger, type Logger, type LogLevel } from './util/logger.ts';
export { systemClock, FakeClock, type Clock } from './util/clock.ts';
export { resolveKernelDirs, sessionsDir, type KernelDirs } from './util/platform.ts';
