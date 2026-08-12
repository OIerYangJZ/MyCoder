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
  costPerMTokIn?: number;
  costPerMTokOut?: number;
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
  static usableContextTokens(profile: ModelProfile, safetyMarginTokens = 4_000): number {
    return Math.max(1_000, profile.contextWindow - profile.reservedOutputTokens - safetyMarginTokens);
  }
}
