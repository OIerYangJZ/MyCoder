/**
 * Skills (spec §16).
 *
 * A skill is discovered from `SKILL.md`, and its frontmatter can only ever
 * **narrow** what the session already permits (§16.3, invariant 14):
 *
 *   - `tools:` intersects with the registered catalogue;
 *   - `permission_profile:` becomes an additional policy layer, and the engine
 *     combines layers by taking the strictest vote, so naming a wider profile
 *     has no effect;
 *   - `max_steps:` is clamped to the session ceiling;
 *   - a skill declaring `network: true` in a session without network gets
 *     nothing, because the network decision is made by the policy engine, not by
 *     this file.
 *
 * Skill markdown is untrusted project content. It becomes *instructions*, which
 * the model may follow, and never *permissions*.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { projectDirCandidates } from '../app.ts';
import { asStringList, parseFrontmatter } from '../util/frontmatter.ts';
import { truncateForModel } from '../util/text.ts';
import { buildProfile, type PermissionProfile, type ProfileContext } from '../policy/profiles.ts';
import type { PolicyEngine, PolicyLayer } from '../policy/policy-engine.ts';

export interface SkillDefinition {
  name: string;
  description: string;
  /** Requested tool subset; intersected with what is registered. */
  requestedTools?: string[];
  requestedProfile?: string;
  requestedMaxSteps?: number;
  instructions: string;
  sourcePath: string;
  /** Set when the definition asked for something it cannot have. */
  narrowedNotes: string[];
}

/** Search order (spec §16.1); earlier wins on a name collision. */
export function skillSearchPaths(workspaceRoot: string, userConfigDir: string, compat = true): string[] {
  const paths = [
    ...projectDirCandidates(workspaceRoot).map((d) => path.join(d, 'skills')),
    path.join(userConfigDir, 'skills'),
  ];
  if (compat) {
    paths.push(path.join(workspaceRoot, '.claude', 'skills'), path.join(workspaceRoot, '.agents', 'skills'));
  }
  return paths;
}

export interface DiscoverSkillsOptions {
  workspaceRoot: string;
  userConfigDir: string;
  compatPaths?: boolean;
  maxInstructionBytes?: number;
}

export async function discoverSkills(opts: DiscoverSkillsOptions): Promise<SkillDefinition[]> {
  const found = new Map<string, SkillDefinition>();

  for (const root of skillSearchPaths(opts.workspaceRoot, opts.userConfigDir, opts.compatPaths ?? true)) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const file = path.join(root, entry, 'SKILL.md');
      try {
        const s = await stat(file);
        if (!s.isFile()) continue;
      } catch {
        continue;
      }

      const skill = await parseSkillFile(file, entry, opts.maxInstructionBytes ?? 24 * 1024);
      if (skill && !found.has(skill.name)) found.set(skill.name, skill);
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function parseSkillFile(
  file: string,
  directoryName: string,
  maxInstructionBytes: number,
): Promise<SkillDefinition | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  const parsed = parseFrontmatter(raw);
  const attrs = parsed.attributes;

  const name = typeof attrs.name === 'string' && attrs.name.trim() !== '' ? attrs.name.trim() : directoryName;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return undefined;

  const narrowedNotes = [...parsed.errors];
  const definition: SkillDefinition = {
    name,
    description: typeof attrs.description === 'string' ? attrs.description : `Skill "${name}"`,
    instructions: truncateForModel(parsed.body.trim(), { maxBytes: maxInstructionBytes, maxLines: 600 }).text,
    sourcePath: file,
    narrowedNotes,
  };

  const tools = asStringList(attrs.tools);
  if (tools) definition.requestedTools = tools;

  if (typeof attrs.permission_profile === 'string') definition.requestedProfile = attrs.permission_profile;

  if (typeof attrs.max_steps === 'number' && attrs.max_steps > 0) {
    definition.requestedMaxSteps = Math.floor(attrs.max_steps);
  }

  // Anything that reads like a capability request gets an explicit note, so the
  // user can see that the file asked and the kernel declined.
  for (const key of ['network', 'allow_network', 'dangerously_skip_permissions', 'bypass']) {
    if (key in attrs) {
      narrowedNotes.push(
        `"${key}" in ${path.basename(file)} was ignored: a skill can only narrow capabilities, never widen them.`,
      );
    }
  }

  return definition;
}

export interface ActivatedSkill {
  skill: SkillDefinition;
  /** Tools available while this skill is active. */
  allowedTools: string[];
  /** The policy layer to append. Undefined when the skill named no profile. */
  layer?: PolicyLayer;
  maxSteps?: number;
  notes: string[];
}

/**
 * Compute the effective capability set for a skill.
 *
 * Every branch here narrows. There is deliberately no code path that adds a
 * tool, widens a profile, or raises a step budget.
 */
export function activateSkill(
  skill: SkillDefinition,
  ctx: {
    registeredTools: readonly string[];
    currentAllowedTools?: readonly string[];
    profileContext: ProfileContext;
    sessionMaxSteps: number;
  },
): ActivatedSkill {
  const notes = [...skill.narrowedNotes];

  const available = ctx.currentAllowedTools ?? ctx.registeredTools;
  let allowedTools = [...available];

  if (skill.requestedTools) {
    const requested = new Set(skill.requestedTools);
    const unknown = skill.requestedTools.filter((t) => !available.includes(t));
    allowedTools = available.filter((t) => requested.has(t));
    if (unknown.length > 0) {
      notes.push(
        `Skill "${skill.name}" requested tool(s) not available in this session: ${unknown.join(', ')}. ` +
          'They were not added.',
      );
    }
  }

  const activated: ActivatedSkill = { skill, allowedTools, notes };

  if (skill.requestedProfile) {
    const profile = buildProfile(skill.requestedProfile, ctx.profileContext);
    if (profile) {
      activated.layer = { name: `skill:${skill.name}`, source: 'skill', profile };
    } else {
      // An unknown profile name must fail closed, not fall back to the session's.
      activated.layer = {
        name: `skill:${skill.name}`,
        source: 'skill',
        profile: denyAllProfile(`skill "${skill.name}" named unknown profile "${skill.requestedProfile}"`),
      };
      notes.push(
        `Skill "${skill.name}" requested unknown permission profile "${skill.requestedProfile}". ` +
          'The skill was restricted rather than run with the session profile.',
      );
    }
  }

  if (skill.requestedMaxSteps !== undefined) {
    activated.maxSteps = Math.min(skill.requestedMaxSteps, ctx.sessionMaxSteps);
  }

  return activated;
}

/** Apply an activated skill's layer to an engine. Narrowing is structural. */
export function narrowForSkill(engine: PolicyEngine, activated: ActivatedSkill): PolicyEngine {
  return activated.layer ? engine.narrow(activated.layer) : engine;
}

function denyAllProfile(reason: string): PermissionProfile {
  return {
    name: 'deny-all',
    description: reason,
    fallback: 'deny',
    rules: [],
  };
}

/** Render a skill's instructions for injection into the system prompt. */
export function renderSkillInstructions(activated: ActivatedSkill): string {
  const lines = [
    `Active skill: ${activated.skill.name}`,
    activated.skill.description,
    '',
    activated.skill.instructions,
  ];
  if (activated.notes.length > 0) {
    lines.push('', 'Kernel notes about this skill:', ...activated.notes.map((n) => `- ${n}`));
  }
  return lines.join('\n');
}
