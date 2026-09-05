/**
 * Model profiles (spec §7.4, invariant 7).
 *
 * A profile describes **model behaviour** — how long it can stay on task, how
 * reliable its tool calls are, which edit strategy suits it. A provider endpoint
 * describes **where to send bytes**. Conflating the two is how "switch to a
 * cheaper model" turns into "silently change the edit strategy and the context
 * budget", so they are separate objects joined only by an alias.
 */

export type EditStrategyName = 'exact' | 'search_replace' | 'apply_patch';

import { clampEffort, type ReasoningEffort } from './ir.ts';
import type { ModelPricing } from './usage.ts';

export interface ModelProfile {
  family: string;
  contextWindow: number;
  maxOutputTokens?: number;
  supportsParallelTools: boolean;
  supportsReasoning: boolean;
  preferredEditStrategy: EditStrategyName;
  autonomy: 'short' | 'normal' | 'long';
  toolReliability: 'low' | 'medium' | 'high';
  /** Tokens reserved for the response when deciding whether to compact. */
  reservedOutputTokens: number;
  /**
   * How hard this class of model should think by default.
   *
   * A profile property because a profile already describes *model behaviour* —
   * `autonomy` and `toolReliability` are the same kind of statement — and because
   * one global number cannot be right for both a frontier model and a small fast
   * one. `[model] effort` overrides it; `effortCeiling` bounds that override.
   *
   * Only sent when `supportsReasoning` is true. On a profile that does not claim
   * reasoning this value is therefore dormant rather than decorative: pointing
   * such a profile at a thinking model means setting `supports_reasoning = true`
   * in config, and this is the level it then runs at.
   */
  effort?: ReasoningEffort;
  /**
   * The strongest level this class of model actually accepts.
   *
   * Exists because the levels are not universally supported — Haiku 4.5 rejects
   * `xhigh` and `max` outright — and a global `[model] effort = "max"` must not
   * turn a working small-model session into a 400. Absent means all five.
   */
  effortCeiling?: ReasoningEffort;
  /**
   * Pricing is configuration, never a constant baked into the kernel: it
   * changes, it varies by tier, and a wrong number produces confident wrong
   * costs. Unset means cost is reported as `unknown` (§18).
   */
  pricing?: ModelPricing;
}

export type ProviderProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'fake';

export interface ProviderEndpoint {
  id: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** Secret ref for the credential; never a literal key. */
  authSecretRef?: string;
  authScheme: 'Bearer' | 'x-api-key' | 'none';
  extraHeaders?: Record<string, string>;
}

export interface ModelAlias {
  alias: string;
  provider: string;
  /** Wire model id sent to the provider. */
  modelId: string;
  profile: string;
}

export interface ResolvedModelProfile {
  alias: string;
  modelId: string;
  provider: ProviderEndpoint;
  profile: ModelProfile;
}

const DEFAULT_PROFILES: Record<string, ModelProfile> = {
  'frontier-long': {
    family: 'frontier',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supportsParallelTools: true,
    supportsReasoning: true,
    preferredEditStrategy: 'exact',
    autonomy: 'long',
    toolReliability: 'high',
    reservedOutputTokens: 32_000,
    // The long-horizon profile is the one that answers hard questions, and this
    // is the level the providers recommend for coding and agentic work. It is
    // one notch below `max` deliberately: `max` buys thoroughness at a cost that
    // only a genuinely hard problem repays, and it is the level to raise *to*
    // once a measurement shows headroom — not the level to sit at.
    effort: 'xhigh',
  },
  'frontier-normal': {
    family: 'frontier',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsParallelTools: true,
    supportsReasoning: true,
    preferredEditStrategy: 'exact',
    autonomy: 'normal',
    toolReliability: 'high',
    reservedOutputTokens: 16_000,
    effort: 'high',
  },
  'mid-tier': {
    family: 'mid',
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    supportsParallelTools: true,
    supportsReasoning: false,
    preferredEditStrategy: 'exact',
    autonomy: 'normal',
    toolReliability: 'medium',
    reservedOutputTokens: 8_000,
    effort: 'medium',
    // Haiku 4.5 is what this profile points at, and it rejects `xhigh`/`max`.
    effortCeiling: 'high',
  },
  'small-fast': {
    family: 'small',
    contextWindow: 64_000,
    maxOutputTokens: 4_000,
    supportsParallelTools: false,
    supportsReasoning: false,
    preferredEditStrategy: 'exact',
    autonomy: 'short',
    toolReliability: 'low',
    reservedOutputTokens: 4_000,
    effort: 'low',
    effortCeiling: 'high',
  },
  fake: {
    family: 'fake',
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
    supportsParallelTools: true,
    supportsReasoning: false,
    preferredEditStrategy: 'exact',
    autonomy: 'normal',
    toolReliability: 'high',
    reservedOutputTokens: 1_000,
  },
};

const DEFAULT_ENDPOINTS: Record<string, ProviderEndpoint> = {
  anthropic: {
    id: 'anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    authSecretRef: 'provider/anthropic',
    authScheme: 'x-api-key',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  openai: {
    id: 'openai',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com',
    authSecretRef: 'provider/openai',
    authScheme: 'Bearer',
  },
  fake: {
    id: 'fake',
    protocol: 'fake',
    baseUrl: 'fake://local',
    authScheme: 'none',
  },
};

/**
 * Aliases are the only model identifier the rest of the kernel uses. Wire ids
 * live here so that renaming a provider's model does not ripple through the
 * session, the context engine or the event log.
 */
const DEFAULT_ALIASES: ModelAlias[] = [
  { alias: 'fake', provider: 'fake', modelId: 'fake-1', profile: 'fake' },
  { alias: 'strongest', provider: 'anthropic', modelId: 'claude-opus-5', profile: 'frontier-long' },
  { alias: 'balanced', provider: 'anthropic', modelId: 'claude-sonnet-5', profile: 'frontier-normal' },
  { alias: 'fast', provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', profile: 'mid-tier' },
  { alias: 'openai/gpt', provider: 'openai', modelId: 'gpt-5', profile: 'frontier-normal' },
];

/**
 * The slack between what the kernel counts and what the provider bills.
 *
 * Named, because measuring it turned out to be the only way to know what it was
 * for. `ContextEngine.estimatedTokens` counts the system prompt and the
 * messages; a request also carries the **tool schemas**, and nothing counts
 * those. On the first request of a live session the kernel estimated 845 tokens
 * and the provider counted 3,436 — a 2,591-token gap that is almost exactly the
 * eleven serialised JSON schemas.
 *
 * So this margin is not general prudence: it is what absorbs that gap, plus
 * whatever the provider's tokeniser does differently from `bytes / 3.6`. Today
 * it covers it with about 1,400 tokens to spare.
 *
 * That spare is the thing to watch. The catalogue is not fixed — an MCP server
 * contributes its tools to it (ADR-0022), and a few servers could double it.
 * When the catalogue outgrows this margin the estimate stops being conservative
 * and compaction starts triggering *after* the real window is already full,
 * which surfaces as a provider length error rather than as anything the kernel
 * says. `Session` checks for that and warns rather than leaving it implicit.
 */
export const CONTEXT_SAFETY_MARGIN_TOKENS = 4_000;

export class ModelRegistry {
  private readonly profiles = new Map<string, ModelProfile>(Object.entries(DEFAULT_PROFILES));
  private readonly endpoints = new Map<string, ProviderEndpoint>(Object.entries(DEFAULT_ENDPOINTS));
  private readonly aliases = new Map<string, ModelAlias>(DEFAULT_ALIASES.map((a) => [a.alias, a]));

  registerProfile(name: string, profile: ModelProfile): void {
    this.profiles.set(name, profile);
  }

  registerEndpoint(endpoint: ProviderEndpoint): void {
    this.endpoints.set(endpoint.id, endpoint);
  }

  registerAlias(alias: ModelAlias): void {
    this.aliases.set(alias.alias, alias);
  }

  listAliases(): ModelAlias[] {
    return [...this.aliases.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  hasAlias(alias: string): boolean {
    return this.aliases.has(alias);
  }

  resolve(alias: string): ResolvedModelProfile | undefined {
    const entry = this.aliases.get(alias);
    if (!entry) return undefined;
    const provider = this.endpoints.get(entry.provider);
    const profile = this.profiles.get(entry.profile);
    if (!provider || !profile) return undefined;
    return { alias: entry.alias, modelId: entry.modelId, provider, profile };
  }

  /**
   * Usable context, after reserving room for the response and a safety margin
   * (spec §20.1). Compaction triggers when the projection exceeds this.
   */
  static usableContextTokens(
    profile: ModelProfile,
    safetyMarginTokens = CONTEXT_SAFETY_MARGIN_TOKENS,
  ): number {
    return Math.max(1_000, profile.contextWindow - profile.reservedOutputTokens - safetyMarginTokens);
  }

  /**
   * The effort level a request actually runs at.
   *
   * Three inputs, in one order that does not vary: the profile's default, the
   * configured override if there is one, then the profile's ceiling. The ceiling
   * comes last because it is a ceiling — an override may pick any level and still
   * cannot exceed what the model accepts, which is the same shape as the loop
   * budget's `Math.min` and the policy engine's strictest-wins.
   *
   * `undefined` means send nothing at all. A profile that does not claim
   * `supportsReasoning` gets that regardless of what is configured: naming a
   * level for a model that has no thinking to steer would put a parameter on the
   * wire that the provider either ignores or rejects, and both of those are
   * worse than the provider's own default.
   */
  static effortFor(profile: ModelProfile, override?: ReasoningEffort): ReasoningEffort | undefined {
    if (!profile.supportsReasoning) return undefined;
    const chosen = override ?? profile.effort;
    if (chosen === undefined) return undefined;
    return profile.effortCeiling ? clampEffort(chosen, profile.effortCeiling) : chosen;
  }
}
