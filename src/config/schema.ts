/**
 * Configuration schema and layering rules (spec §22).
 *
 * Priority, highest first:
 *
 *   System hard ceilings
 *   CLI explicit flags
 *   User config
 *   Project config
 *   Agent profile
 *   Skill profile
 *   Model suggestions (no configuration authority at all)
 *
 * The rule that matters is at the bottom of §22: security fields do **not** use
 * last-write-wins. They intersect — the stricter value wins regardless of which
 * layer supplied it. Otherwise a checked-in `.agent/config.toml` could widen
 * what the user's own config narrowed, which is the whole attack.
 *
 * `mergeConfig` therefore takes an explicit merge mode per field, and the
 * security-relevant ones are marked `strict`.
 */

import type { TomlTable, TomlValue } from '../util/toml.ts';

export interface ProjectConfig {
  name?: string;
  workspace?: string;
  referenceRoots?: string[];
}

/**
 * A provider endpoint declared in configuration.
 *
 * **User config only.** A project file may name an alias but must never define
 * where bytes are sent — the same rule the spec applies to SSH remotes (§19.2),
 * and for the same reason: a checked-in `.agent/config.toml` that could declare
 * `base_url = "https://evil.example.com"` and set it as the default would route
 * every prompt to an attacker. `loadConfig` drops project-declared providers and
 * warns.
 */
export interface ProviderEndpointConfig {
  protocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat';
  baseUrl: string;
  /**
   * Path to a file holding the credential (alpha.3 §5). Never the credential
   * itself. Validated and registered as a protected path before first use —
   * see `src/security/credential-file.ts`.
   */
  apiKeyFile?: string;
  /** Environment variable holding the credential. Never the credential itself. */
  apiKeyEnv?: string;
  authScheme?: 'Bearer' | 'x-api-key' | 'none';
  extraHeaders?: Record<string, string>;
}

/** A behaviour profile declared in configuration (spec §7.4). */
export interface ModelProfileConfig {
  contextWindow: number;
  maxOutputTokens?: number;
  reservedOutputTokens?: number;
  supportsParallelTools?: boolean;
  supportsReasoning?: boolean;
  preferredEditStrategy?: 'exact' | 'search_replace' | 'apply_patch';
  autonomy?: 'short' | 'normal' | 'long';
  toolReliability?: 'low' | 'medium' | 'high';
  family?: string;
  inputPerMTok?: number;
  outputPerMTok?: number;
  cachedInputPerMTok?: number;
}

export interface ModelConfig {
  default?: string;
  /** alias → { provider, modelId, profile } */
  aliases?: Record<string, { provider: string; model: string; profile?: string }>;
  /** provider id → endpoint. User config only; see ProviderEndpointConfig. */
  providers?: Record<string, ProviderEndpointConfig>;
  /** profile name → behaviour. */
  profiles?: Record<string, ModelProfileConfig>;
}

export interface SecurityConfig {
  permissionProfile?: string;
  secretRedaction?: boolean;
  telemetryContent?: boolean;
  traceUpload?: boolean;
  /** Extra hard-deny read patterns. Union — more patterns is stricter. */
  extraSecretPaths?: string[];
}

export interface LoopConfig {
  maxSteps?: number;
  maxToolCalls?: number;
  maxModelRequests?: number;
  maxRepeatedFailures?: number;
  maxWallTimeMs?: number;
  maxCostUsd?: number;
  /**
   * Whether the kernel tells the model that delegation is a strategy it can use.
   *
   * Default on when the project defines agents. Off means the `Delegate` tool is
   * still there and still described; what disappears is the kernel's own nudge in
   * the system prompt. Someone who does not want the model encouraged to spend
   * budget on subagents can say so, and the delegation-utility experiment uses it
   * as the two arms of an A/B — which is only possible because it is a real
   * option rather than a test hook.
   *
   * Merged so that **off wins**: a project may switch the nudge off, never on.
   */
  delegationGuidance?: boolean;
  /**
   * How deep delegation may go (alpha.4 §12). Default 1: root → child only.
   *
   * Merged by `Math.min` like every other loop limit, so a project can lower it
   * to 0 — disabling delegation entirely — but never raise it above the user's.
   */
  maxDelegationDepth?: number;
}

export interface ShellConfig {
  defaultNetwork?: boolean;
  timeoutMs?: number;
}

export interface TelemetryConfig {
  enabled?: boolean;
  content?: boolean;
  traceUpload?: boolean;
  endpoint?: string;
}

export interface EgressConfig {
  /** kind → allowed host globs. Intersected across layers. */
  allowedHosts?: Record<string, string[]>;
}

export interface KernelConfig {
  project: ProjectConfig;
  model: ModelConfig;
  security: SecurityConfig;
  loop: LoopConfig;
  shell: ShellConfig;
  telemetry: TelemetryConfig;
  egress: EgressConfig;
  generatedPaths: string[];
  /** Non-fatal problems found while loading; surfaced by `/status`. */
  warnings: string[];
}

export function defaultConfig(): KernelConfig {
  return {
    project: {},
    model: { default: 'fake' },
    security: {
      permissionProfile: 'workspace-dev',
      secretRedaction: true,
      telemetryContent: false,
      traceUpload: false,
      extraSecretPaths: [],
    },
    loop: {
      maxSteps: 16,
      maxToolCalls: 64,
      maxModelRequests: 16,
      maxRepeatedFailures: 3,
      maxWallTimeMs: 10 * 60_000,
      maxDelegationDepth: 1,
      delegationGuidance: true,
    },
    shell: { defaultNetwork: false, timeoutMs: 120_000 },
    telemetry: { enabled: true, content: false, traceUpload: false },
    egress: { allowedHosts: {} },
    generatedPaths: ['dist/**', 'coverage/**', '.cache/**', 'target/**', 'build/**', 'node_modules/**'],
    warnings: [],
  };
}

/**
 * The immovable ceiling. Nothing in any file or flag can exceed these.
 * Kept separate from `defaultConfig` so the difference between "a default" and
 * "a limit" is visible in the type system rather than in a comment.
 */
export interface SystemCeiling {
  maxSteps: number;
  maxToolCalls: number;
  maxModelRequests: number;
  maxWallTimeMs: number;
  /** See the constant: one level, because only one level is validated. */
  maxDelegationDepth: number;
  /** Content telemetry is never permitted (Appendix A, invariant 12). */
  telemetryContent: false;
  traceUpload: false;
  secretRedaction: true;
}

export const SYSTEM_CEILING: SystemCeiling = {
  maxSteps: 200,
  maxToolCalls: 2_000,
  maxModelRequests: 200,
  maxWallTimeMs: 60 * 60_000,
  /**
   * Delegation depth the *system* permits, whatever a config layer asks for.
   *
   * One, not because deeper trees are conceptually wrong, but because alpha.4 only
   * validated one level and the accounting past it is known to be approximate: a
   * grandchild's usage is charged to the root's turn rather than to its immediate
   * parent (ADR-0013). That is conservative rather than exploitable, but it is
   * untested, and shipping a reachable capability whose accounting we know is wrong
   * is worse than not having it. `docs/alpha4-evidence-matrix.md` records the row
   * this closes.
   *
   * Raising it is a deliberate act: change this constant, and validate the
   * accounting before you do.
   */
  maxDelegationDepth: 1,
  telemetryContent: false,
  traceUpload: false,
  secretRedaction: true,
};

/** How a field combines when two layers both define it. */
type MergeMode = 'override' | 'strictBoolean' | 'min' | 'unionPatterns' | 'intersectHosts';

/**
 * Combine a lower-priority layer with a higher-priority one.
 *
 * `higher` normally wins — except where the field is security-relevant, in which
 * case the stricter of the two wins no matter where it came from.
 */
export function mergeConfig(lower: KernelConfig, higher: Partial<KernelConfig>): KernelConfig {
  const out: KernelConfig = {
    project: { ...lower.project, ...(higher.project ?? {}) },
    model: {
      ...lower.model,
      ...(higher.model ?? {}),
      aliases: { ...(lower.model.aliases ?? {}), ...(higher.model?.aliases ?? {}) },
      providers: { ...(lower.model.providers ?? {}), ...(higher.model?.providers ?? {}) },
      profiles: { ...(lower.model.profiles ?? {}), ...(higher.model?.profiles ?? {}) },
    },
    security: mergeSecurity(lower.security, higher.security ?? {}),
    loop: mergeLoop(lower.loop, higher.loop ?? {}),
    shell: {
      // Network defaults off; a layer may turn it off but not on for others.
      defaultNetwork: strictBoolean(lower.shell.defaultNetwork, higher.shell?.defaultNetwork, false),
      timeoutMs: minDefined(lower.shell.timeoutMs, higher.shell?.timeoutMs),
    },
    telemetry: {
      enabled: higher.telemetry?.enabled ?? lower.telemetry.enabled,
      content: strictBoolean(lower.telemetry.content, higher.telemetry?.content, false),
      traceUpload: strictBoolean(lower.telemetry.traceUpload, higher.telemetry?.traceUpload, false),
      ...((higher.telemetry?.endpoint ?? lower.telemetry.endpoint)
        ? { endpoint: higher.telemetry?.endpoint ?? lower.telemetry.endpoint }
        : {}),
    },
    egress: { allowedHosts: intersectHosts(lower.egress.allowedHosts, higher.egress?.allowedHosts) },
    generatedPaths: [...new Set([...lower.generatedPaths, ...(higher.generatedPaths ?? [])])],
    warnings: [...lower.warnings, ...(higher.warnings ?? [])],
  };
  return out;
}

function mergeSecurity(lower: SecurityConfig, higher: SecurityConfig): SecurityConfig {
  return {
    // A profile name is an override, but the policy engine still intersects the
    // resulting rule sets, so a "wider" name cannot actually widen anything.
    permissionProfile: higher.permissionProfile ?? lower.permissionProfile,
    secretRedaction: strictBoolean(lower.secretRedaction, higher.secretRedaction, true),
    telemetryContent: strictBoolean(lower.telemetryContent, higher.telemetryContent, false),
    traceUpload: strictBoolean(lower.traceUpload, higher.traceUpload, false),
    // Deny patterns union: adding a rule is always allowed, removing one is not.
    extraSecretPaths: [...new Set([...(lower.extraSecretPaths ?? []), ...(higher.extraSecretPaths ?? [])])],
  };
}

function mergeLoop(lower: LoopConfig, higher: LoopConfig): LoopConfig {
  const out: LoopConfig = {
    maxSteps: minDefined(lower.maxSteps, higher.maxSteps),
    maxToolCalls: minDefined(lower.maxToolCalls, higher.maxToolCalls),
    maxModelRequests: minDefined(lower.maxModelRequests, higher.maxModelRequests),
    maxRepeatedFailures: minDefined(lower.maxRepeatedFailures, higher.maxRepeatedFailures),
    maxWallTimeMs: minDefined(lower.maxWallTimeMs, higher.maxWallTimeMs),
    maxDelegationDepth: minDefined(lower.maxDelegationDepth, higher.maxDelegationDepth),
    // `false` is the sticky value: a project can silence the nudge, not add one.
    delegationGuidance: strictBoolean(lower.delegationGuidance, higher.delegationGuidance, false),
  };
  const cost = minDefined(lower.maxCostUsd, higher.maxCostUsd);
  if (cost !== undefined) out.maxCostUsd = cost;
  return out;
}

/**
 * For a boolean where one value is the safe one, the safe value is sticky: once
 * any layer says "off", no later layer can say "on".
 */
function strictBoolean(lower: boolean | undefined, higher: boolean | undefined, safeValue: boolean): boolean {
  const values = [lower, higher].filter((v): v is boolean => v !== undefined);
  if (values.length === 0) return safeValue;
  return values.some((v) => v === safeValue) ? safeValue : values[values.length - 1]!;
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Host allowlists intersect: a project cannot add a host the user did not. */
function intersectHosts(
  lower: Record<string, string[]> | undefined,
  higher: Record<string, string[]> | undefined,
): Record<string, string[]> {
  if (!lower || Object.keys(lower).length === 0) return higher ?? {};
  if (!higher || Object.keys(higher).length === 0) return lower;

  const out: Record<string, string[]> = {};
  for (const [kind, hosts] of Object.entries(higher)) {
    const permitted = lower[kind];
    if (!permitted) continue; // the lower layer never enabled this channel
    out[kind] = hosts.filter((h) => permitted.includes(h) || permitted.includes('*'));
  }
  return out;
}

/** Apply the immovable ceiling last, after every layer has had its say. */
export function applySystemCeiling(config: KernelConfig): KernelConfig {
  return {
    ...config,
    security: {
      ...config.security,
      secretRedaction: true,
      telemetryContent: false,
      traceUpload: false,
    },
    telemetry: { ...config.telemetry, content: false, traceUpload: false },
    loop: {
      ...config.loop,
      maxSteps: Math.min(config.loop.maxSteps ?? SYSTEM_CEILING.maxSteps, SYSTEM_CEILING.maxSteps),
      maxToolCalls: Math.min(
        config.loop.maxToolCalls ?? SYSTEM_CEILING.maxToolCalls,
        SYSTEM_CEILING.maxToolCalls,
      ),
      maxModelRequests: Math.min(
        config.loop.maxModelRequests ?? SYSTEM_CEILING.maxModelRequests,
        SYSTEM_CEILING.maxModelRequests,
      ),
      maxWallTimeMs: Math.min(
        config.loop.maxWallTimeMs ?? SYSTEM_CEILING.maxWallTimeMs,
        SYSTEM_CEILING.maxWallTimeMs,
      ),
      maxDelegationDepth: Math.min(
        config.loop.maxDelegationDepth ?? SYSTEM_CEILING.maxDelegationDepth,
        SYSTEM_CEILING.maxDelegationDepth,
      ),
    },
  };
}

// --- TOML → config ---------------------------------------------------------

export function configFromToml(table: TomlTable, source: string): Partial<KernelConfig> {
  const warnings: string[] = [];
  const out: Partial<KernelConfig> = { warnings };

  const project = tableAt(table, 'project');
  if (project) {
    out.project = {
      ...(str(project.name) !== undefined ? { name: str(project.name)! } : {}),
      ...(str(project.workspace) !== undefined ? { workspace: str(project.workspace)! } : {}),
      ...(strList(project.reference_roots) ? { referenceRoots: strList(project.reference_roots)! } : {}),
    };
  }

  const model = tableAt(table, 'model');
  if (model) {
    const aliases: Record<string, { provider: string; model: string; profile?: string }> = {};
    const aliasTable = tableAt(model, 'alias');
    for (const [name, value] of Object.entries(aliasTable ?? {})) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const entry = value as TomlTable;
      const provider = str(entry.provider);
      const wire = str(entry.model);
      if (!provider || !wire) {
        warnings.push(`${source}: model alias "${name}" needs both provider and model`);
        continue;
      }
      aliases[name] = {
        provider,
        model: wire,
        ...(str(entry.profile) ? { profile: str(entry.profile)! } : {}),
      };
    }
    const providers: Record<string, ProviderEndpointConfig> = {};
    const providerTable = tableAt(model, 'provider');
    for (const [name, value] of Object.entries(providerTable ?? {})) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const entry = value as TomlTable;
      const protocol = str(entry.protocol);
      const baseUrl = str(entry.base_url);

      if (
        protocol !== 'anthropic-messages' &&
        protocol !== 'openai-responses' &&
        protocol !== 'openai-chat'
      ) {
        warnings.push(
          `${source}: provider "${name}" has protocol "${String(entry.protocol)}"; ` +
            'expected one of anthropic-messages, openai-responses, openai-chat',
        );
        continue;
      }
      if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
        warnings.push(`${source}: provider "${name}" needs an absolute http(s) base_url`);
        continue;
      }

      // A literal credential in a config file is refused rather than honoured.
      // Config is the one artifact people paste into issues and check into
      // dotfile repositories, and an inline key would be readable by anything
      // that can read the file — which is the whole problem `api_key_file`
      // exists to solve. Warned loudly so it does not look like it took effect.
      if (entry.api_key !== undefined) {
        warnings.push(
          `${source}: provider "${name}" set api_key inline; this was ignored. ` +
            'Use api_key_file (a 0600 file outside the workspace) or api_key_env — ' +
            'a credential must never be stored in a configuration file.',
        );
      }

      const scheme = str(entry.auth_scheme);
      providers[name] = {
        protocol,
        baseUrl: baseUrl.replace(/\/+$/, ''),
        ...(str(entry.api_key_file) ? { apiKeyFile: str(entry.api_key_file)! } : {}),
        ...(str(entry.api_key_env) ? { apiKeyEnv: str(entry.api_key_env)! } : {}),
        ...(scheme === 'Bearer' || scheme === 'x-api-key' || scheme === 'none' ? { authScheme: scheme } : {}),
        ...(headerTable(entry.extra_headers) ? { extraHeaders: headerTable(entry.extra_headers)! } : {}),
      };
    }

    const profiles: Record<string, ModelProfileConfig> = {};
    const profileTable = tableAt(model, 'profile');
    for (const [name, value] of Object.entries(profileTable ?? {})) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const entry = value as TomlTable;
      const contextWindow = num(entry.context_window);
      if (contextWindow === undefined || contextWindow <= 0) {
        warnings.push(`${source}: model profile "${name}" needs a positive context_window`);
        continue;
      }
      profiles[name] = {
        contextWindow,
        ...(num(entry.max_output_tokens) !== undefined
          ? { maxOutputTokens: num(entry.max_output_tokens)! }
          : {}),
        ...(num(entry.reserved_output_tokens) !== undefined
          ? { reservedOutputTokens: num(entry.reserved_output_tokens)! }
          : {}),
        ...(bool(entry.supports_parallel_tools) !== undefined
          ? { supportsParallelTools: bool(entry.supports_parallel_tools)! }
          : {}),
        ...(bool(entry.supports_reasoning) !== undefined
          ? { supportsReasoning: bool(entry.supports_reasoning)! }
          : {}),
        ...(str(entry.autonomy) ? { autonomy: str(entry.autonomy) as ModelProfileConfig['autonomy'] } : {}),
        ...(str(entry.tool_reliability)
          ? { toolReliability: str(entry.tool_reliability) as ModelProfileConfig['toolReliability'] }
          : {}),
        ...(str(entry.family) ? { family: str(entry.family)! } : {}),
        ...(num(entry.input_per_mtok) !== undefined ? { inputPerMTok: num(entry.input_per_mtok)! } : {}),
        ...(num(entry.output_per_mtok) !== undefined ? { outputPerMTok: num(entry.output_per_mtok)! } : {}),
        ...(num(entry.cached_input_per_mtok) !== undefined
          ? { cachedInputPerMTok: num(entry.cached_input_per_mtok)! }
          : {}),
      };
    }

    out.model = {
      ...(str(model.default) !== undefined ? { default: str(model.default)! } : {}),
      ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
      ...(Object.keys(providers).length > 0 ? { providers } : {}),
      ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
    };
  }

  const security = tableAt(table, 'security');
  if (security) {
    out.security = {
      ...(str(security.permission_profile) !== undefined
        ? { permissionProfile: str(security.permission_profile)! }
        : {}),
      ...(bool(security.secret_redaction) !== undefined
        ? { secretRedaction: bool(security.secret_redaction)! }
        : {}),
      ...(bool(security.telemetry_content) !== undefined
        ? { telemetryContent: bool(security.telemetry_content)! }
        : {}),
      ...(bool(security.trace_upload) !== undefined ? { traceUpload: bool(security.trace_upload)! } : {}),
      ...(strList(security.extra_secret_paths)
        ? { extraSecretPaths: strList(security.extra_secret_paths)! }
        : {}),
    };
  }

  const loop = tableAt(table, 'loop');
  if (loop) {
    out.loop = {
      ...(num(loop.max_steps) !== undefined ? { maxSteps: num(loop.max_steps)! } : {}),
      ...(num(loop.max_tool_calls) !== undefined ? { maxToolCalls: num(loop.max_tool_calls)! } : {}),
      ...(num(loop.max_model_requests) !== undefined
        ? { maxModelRequests: num(loop.max_model_requests)! }
        : {}),
      ...(num(loop.max_repeated_failures) !== undefined
        ? { maxRepeatedFailures: num(loop.max_repeated_failures)! }
        : {}),
      ...(num(loop.max_wall_time_ms) !== undefined ? { maxWallTimeMs: num(loop.max_wall_time_ms)! } : {}),
      ...(num(loop.max_cost_usd) !== undefined ? { maxCostUsd: num(loop.max_cost_usd)! } : {}),
      ...(num(loop.max_delegation_depth) !== undefined
        ? { maxDelegationDepth: num(loop.max_delegation_depth)! }
        : {}),
      ...(bool(loop.delegation_guidance) !== undefined
        ? { delegationGuidance: bool(loop.delegation_guidance)! }
        : {}),
    };
  }

  const shell = tableAt(table, 'shell');
  if (shell) {
    out.shell = {
      ...(bool(shell.default_network) !== undefined ? { defaultNetwork: bool(shell.default_network)! } : {}),
      ...(num(shell.timeout_ms) !== undefined ? { timeoutMs: num(shell.timeout_ms)! } : {}),
    };
  }

  const telemetry = tableAt(table, 'telemetry');
  if (telemetry) {
    out.telemetry = {
      ...(bool(telemetry.enabled) !== undefined ? { enabled: bool(telemetry.enabled)! } : {}),
      ...(bool(telemetry.content) !== undefined ? { content: bool(telemetry.content)! } : {}),
      ...(bool(telemetry.trace_upload) !== undefined ? { traceUpload: bool(telemetry.trace_upload)! } : {}),
      ...(str(telemetry.endpoint) !== undefined ? { endpoint: str(telemetry.endpoint)! } : {}),
    };
    if (bool(telemetry.content) === true) {
      warnings.push(`${source}: telemetry.content = true was ignored; content telemetry is never permitted`);
    }
  }

  const egress = tableAt(table, 'egress');
  if (egress) {
    const allowedHosts: Record<string, string[]> = {};
    for (const [kind, value] of Object.entries(egress)) {
      const hosts = strList(value);
      if (hosts) allowedHosts[kind] = hosts;
    }
    out.egress = { allowedHosts };
  }

  const generated = tableAt(table, 'generated_paths');
  if (generated) {
    const allow = strList(generated.allow);
    if (allow) out.generatedPaths = allow;
  }

  return out;
}

function tableAt(table: TomlTable, key: string): TomlTable | undefined {
  const value = table[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as TomlTable;
}

function str(v: TomlValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: TomlValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: TomlValue | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function headerTable(v: TomlValue | undefined): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v as TomlTable)) {
    if (typeof value === 'string') out[k] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function strList(v: TomlValue | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length === v.length ? out : out;
}
