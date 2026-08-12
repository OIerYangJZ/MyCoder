/**
 * Agents / subagents (spec §17).
 *
 * The parent-ceiling rule (§17.2) is the whole of this file:
 *
 *   effective capability ≤ parent capability ≤ session ceiling
 *
 * A subagent definition is a *request*, resolved against the parent's actual
 * capabilities. It cannot switch to a higher-privilege profile, reach a secret
 * the parent cannot, make a reference tree writable, or inherit network the
 * parent did not have — not because those cases are checked one by one, but
 * because the agent's profile is appended as another policy layer and layers
 * combine by strictest vote.
 */

import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

import { asStringList, parseFrontmatter } from '../util/frontmatter.ts';
import { truncateForModel } from '../util/text.ts';
import { buildProfile, type PermissionProfile, type ProfileContext } from '../policy/profiles.ts';
import type { PolicyEngine, PolicyLayer } from '../policy/policy-engine.ts';

export interface AgentDefinition {
  name: string;
  description: string;
  requestedModel?: string;
  requestedProfile?: string;
  requestedTools?: string[];
  requestedMaxSteps?: number;
  instructions: string;
  sourcePath: string;
  notes: string[];
}

export function agentSearchPaths(workspaceRoot: string, userConfigDir: string): string[] {
  return [
    path.join(workspaceRoot, '.agent', 'agents'),
    path.join(userConfigDir, 'agents'),
    path.join(workspaceRoot, '.claude', 'agents'),
  ];
}

export async function discoverAgents(
  workspaceRoot: string,
  userConfigDir: string,
): Promise<AgentDefinition[]> {
  const found = new Map<string, AgentDefinition>();

  for (const root of agentSearchPaths(workspaceRoot, userConfigDir)) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const file = path.join(root, entry);
      const agent = await parseAgentFile(file, entry.replace(/\.md$/, ''));
      if (agent && !found.has(agent.name)) found.set(agent.name, agent);
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function parseAgentFile(
  file: string,
  fallbackName: string,
): Promise<AgentDefinition | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  const parsed = parseFrontmatter(raw);
  const attrs = parsed.attributes;
  const name = typeof attrs.name === 'string' && attrs.name.trim() !== '' ? attrs.name.trim() : fallbackName;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return undefined;

  const definition: AgentDefinition = {
    name,
    description: typeof attrs.description === 'string' ? attrs.description : `Agent "${name}"`,
    instructions: truncateForModel(parsed.body.trim(), { maxBytes: 24 * 1024, maxLines: 600 }).text,
    sourcePath: file,
    notes: [...parsed.errors],
  };

  if (typeof attrs.model === 'string') definition.requestedModel = attrs.model;
  if (typeof attrs.permission_profile === 'string') definition.requestedProfile = attrs.permission_profile;
  const tools = asStringList(attrs.tools);
  if (tools) definition.requestedTools = tools;
  if (typeof attrs.max_steps === 'number' && attrs.max_steps > 0) {
    definition.requestedMaxSteps = Math.floor(attrs.max_steps);
  }

  return definition;
}

export interface SubagentCapabilities {
  agent: AgentDefinition;
  /** Engine narrowed by the agent's profile layer. Never wider than the parent. */
  policy: PolicyEngine;
  allowedTools: string[];
  maxSteps: number;
  modelAlias: string;
  notes: string[];
}

export interface DeriveSubagentOptions {
  parentPolicy: PolicyEngine;
  parentAllowedTools: readonly string[];
  parentMaxSteps: number;
  parentModelAlias: string;
  profileContext: ProfileContext;
  /** Aliases the session is permitted to use. */
  knownModelAliases: readonly string[];
}

/**
 * Derive a subagent's capabilities from a definition and its parent.
 *
 * Note what is absent: there is no way for the returned policy engine to be
 * wider than `parentPolicy`, because it is produced only by `narrow()`.
 */
export function deriveSubagent(agent: AgentDefinition, opts: DeriveSubagentOptions): SubagentCapabilities {
  const notes = [...agent.notes];

  // --- tools: intersection only ---
  let allowedTools = [...opts.parentAllowedTools];
  if (agent.requestedTools) {
    const requested = new Set(agent.requestedTools);
    const unavailable = agent.requestedTools.filter((t) => !opts.parentAllowedTools.includes(t));
    allowedTools = opts.parentAllowedTools.filter((t) => requested.has(t));
    if (unavailable.length > 0) {
      notes.push(
        `Agent "${agent.name}" requested tool(s) the parent does not have: ${unavailable.join(', ')}. Not granted.`,
      );
    }
  }

  // --- profile: an extra layer, so it can only narrow ---
  let policy = opts.parentPolicy;
  if (agent.requestedProfile) {
    const profile = buildProfile(agent.requestedProfile, opts.profileContext);
    const layer: PolicyLayer = {
      name: `agent:${agent.name}`,
      source: 'agent',
      profile: profile ?? denyAll(`agent "${agent.name}" named unknown profile "${agent.requestedProfile}"`),
    };
    if (!profile) {
      notes.push(
        `Agent "${agent.name}" requested unknown permission profile "${agent.requestedProfile}"; ` +
          'it was restricted instead of inheriting the parent profile.',
      );
    }
    policy = opts.parentPolicy.narrow(layer);
  }

  // --- model: must already be registered for this session ---
  let modelAlias = opts.parentModelAlias;
  if (agent.requestedModel) {
    if (opts.knownModelAliases.includes(agent.requestedModel)) {
      modelAlias = agent.requestedModel;
    } else {
      notes.push(
        `Agent "${agent.name}" requested model "${agent.requestedModel}", which is not configured. ` +
          `Using "${opts.parentModelAlias}".`,
      );
    }
  }

  const maxSteps =
    agent.requestedMaxSteps !== undefined
      ? Math.min(agent.requestedMaxSteps, opts.parentMaxSteps)
      : opts.parentMaxSteps;

  return { agent, policy, allowedTools, maxSteps, modelAlias, notes };
}

function denyAll(reason: string): PermissionProfile {
  return { name: 'deny-all', description: reason, fallback: 'deny', rules: [] };
}

/** The three starter agents the spec recommends (§17.3). */
export const RECOMMENDED_AGENTS: ReadonlyArray<{
  name: string;
  profile: string;
  tools: string[];
  purpose: string;
}> = [
  {
    name: 'kernel-architect',
    profile: 'read-only',
    tools: ['Read', 'Grep', 'Glob'],
    purpose: 'Architecture, interfaces and ADRs. Does not modify code.',
  },
  {
    name: 'implementation-worker',
    profile: 'workspace-dev',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Shell', 'GitDiff'],
    purpose: 'Implements against the spec. May edit src/** and tests/**; reference/** stays read-only.',
  },
  {
    name: 'security-reviewer',
    profile: 'review',
    tools: ['Read', 'Grep', 'Glob', 'Shell', 'GitDiff'],
    purpose: 'Attacks permissions, secrets, egress and path boundaries. Read-only plus sandboxed shell.',
  },
];
