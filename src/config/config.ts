/**
 * Configuration loading (spec §22, Appendix B/C).
 *
 * Reads, in increasing priority:
 *   ~/.config/mycoder/config.toml          (user)
 *   <workspace>/.agent/config.toml       (project)
 *   <workspace>/.agent/permissions.toml  (project permission rules)
 *   CLI flags                            (applied by the caller, on top)
 *
 * and then clamps everything with `applySystemCeiling`. A malformed file is a
 * warning, not a crash: a syntax error in a project config should not stop the
 * user working, but it must be visible in `/status` rather than silently
 * producing a different security posture than the file appears to describe.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { posix } from 'node:path';

import { PROJECT_DIR, projectDirCandidates } from '../app.ts';
import { parseToml, TomlParseError, type TomlTable, type TomlValue } from '../util/toml.ts';
import { toPosix, type CanonicalPath } from '../util/paths.ts';
import type { Capability } from '../policy/access.ts';
import type { PermissionProfile, PolicyAction, PolicyRule } from '../policy/profiles.ts';
import {
  applySystemCeiling,
  configFromToml,
  defaultConfig,
  mergeConfig,
  type KernelConfig,
} from './schema.ts';

export interface LoadedConfig {
  config: KernelConfig;
  /** Rules parsed from `.agent/permissions.toml`, as an extra policy layer. */
  projectRules: PolicyRule[];
  sources: string[];
  /**
   * Provider ids declared in **user** config. Only these have their host added
   * to the model egress allowlist automatically — a project cannot open an
   * egress destination by declaring an endpoint.
   */
  userProviderIds: string[];
}

export interface LoadConfigOptions {
  workspaceRoot: CanonicalPath;
  userConfigDir: string;
  /** Overrides from CLI flags, applied last (before the ceiling). */
  overrides?: Partial<KernelConfig>;
  readFileImpl?: (p: string) => Promise<string>;
}

export async function loadConfig(opts: LoadConfigOptions): Promise<LoadedConfig> {
  const read = opts.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const sources: string[] = [];
  const userProviderIds = new Set<string>();
  let config = defaultConfig();

  const userPath = path.join(opts.userConfigDir, 'config.toml');
  const projectPath = await firstExisting(read, projectDirCandidates(opts.workspaceRoot), 'config.toml');

  for (const [file, label] of [
    [userPath, 'user config'],
    [projectPath, 'project config'],
  ] as const) {
    const parsed = await readTomlFile(read, file, label);
    if (!parsed) continue;
    sources.push(file);

    const layer = configFromToml(parsed.table, label);

    // A project file may *name* a provider but must never *define* one. This is
    // the rule the spec already applies to SSH remotes (§19.2), for the same
    // reason: a checked-in config that could set `base_url` and make itself the
    // default would route every prompt — and every file the model has read — to
    // a host the repository chose. Refused loudly, never silently ignored.
    if (label === 'project config' && layer.model?.providers) {
      const declared = Object.keys(layer.model.providers);
      layer.warnings = [
        ...(layer.warnings ?? []),
        `project config declared model provider endpoint(s) ${declared.join(', ')}; ` +
          'these were ignored. Provider endpoints may only be defined in ' +
          `${userPath} — a project may select an alias, not decide where prompts are sent.`,
      ];
      delete layer.model.providers;
    }
    if (label === 'user config' && layer.model?.providers) {
      for (const id of Object.keys(layer.model.providers)) userProviderIds.add(id);
    }

    config = mergeConfig(config, layer);
    config.warnings.push(...parsed.warnings);
  }

  if (opts.overrides) config = mergeConfig(config, opts.overrides);
  config = applySystemCeiling(config);

  const permissionsPath = await firstExisting(
    read,
    projectDirCandidates(opts.workspaceRoot),
    'permissions.toml',
  );
  const permissions = await readTomlFile(read, permissionsPath, 'project permissions');
  let projectRules: PolicyRule[] = [];
  if (permissions) {
    sources.push(permissionsPath);
    const parsedRules = parsePermissionRules(permissions.table, opts.workspaceRoot);
    projectRules = parsedRules.rules;
    config.warnings.push(...parsedRules.warnings, ...permissions.warnings);
  }

  return { config, projectRules, sources, userProviderIds: [...userProviderIds] };
}

/**
 * First candidate directory that actually contains `name`.
 *
 * Falls back to the primary path when none exists, so the "file is absent"
 * message names the directory people should create.
 */
async function firstExisting(
  read: (p: string) => Promise<string>,
  dirs: readonly string[],
  name: string,
): Promise<string> {
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      await read(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return path.join(dirs[0] ?? PROJECT_DIR, name);
}

async function readTomlFile(
  read: (p: string) => Promise<string>,
  file: string,
  label: string,
): Promise<{ table: TomlTable; warnings: string[] } | undefined> {
  let content: string;
  try {
    content = await read(file);
  } catch {
    return undefined; // absent is the normal case
  }

  try {
    return { table: parseToml(content), warnings: [] };
  } catch (e) {
    const detail = e instanceof TomlParseError ? e.message : 'parse error';
    // Fail visible, not silent: an unparsed permissions file must not look like
    // an empty one, or a project's deny rules would quietly stop applying.
    return { table: {}, warnings: [`${label} at ${file} could not be parsed (${detail}); it was ignored`] };
  }
}

const VALID_ACTIONS: readonly PolicyAction[] = ['hard_deny', 'deny', 'ask', 'allow'];
const VALID_CAPABILITIES: readonly string[] = [
  'file.read',
  'file.read_to_model',
  'file.write',
  'process.exec',
  'network.connect',
  'secret.use',
  'env.read',
  'vcs.mutate',
  'remote.connect',
  '*',
];

/**
 * Parse `[[rule]]` entries (Appendix C).
 *
 * Relative path patterns are anchored to the workspace, so a project rule cannot
 * accidentally match outside it, and `hard_deny` from a project file is honoured
 * — a project may always be *stricter* than the user's configuration.
 */
export function parsePermissionRules(
  table: TomlTable,
  workspaceRoot: CanonicalPath,
): { rules: PolicyRule[]; warnings: string[] } {
  const warnings: string[] = [];
  const rules: PolicyRule[] = [];

  const raw = table.rule;
  const entries: TomlValue[] = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];

  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(`permissions rule #${index + 1} is not a table; ignored`);
      return;
    }
    const record = entry as TomlTable;

    const action = record.action;
    if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as PolicyAction)) {
      warnings.push(`permissions rule #${index + 1} has an unknown action "${String(action)}"; ignored`);
      return;
    }

    const capability = record.capability;
    if (typeof capability !== 'string' || !VALID_CAPABILITIES.includes(capability)) {
      warnings.push(
        `permissions rule #${index + 1} has an unknown capability "${String(capability)}"; ignored`,
      );
      return;
    }

    const rule: PolicyRule = {
      action: action as PolicyAction,
      capability: capability as Capability | '*',
      note: typeof record.note === 'string' ? record.note : `project rule #${index + 1}`,
    };

    const pattern = record.pattern;
    if (typeof pattern === 'string' && pattern !== '') {
      rule.pattern = anchorPattern(pattern, capability, workspaceRoot);
    }

    const argv = record.argv_pattern;
    if (typeof argv === 'string' && argv !== '') rule.argvPattern = argv;

    if (Array.isArray(record.via)) {
      rule.via = record.via.filter((v): v is string => typeof v === 'string');
    }
    if (Array.isArray(record.ports)) {
      rule.ports = record.ports.filter((v): v is number => typeof v === 'number');
    }

    rules.push(rule);
  });

  return { rules, warnings };
}

/**
 * Turn a relative path pattern into an absolute one.
 *
 * `src/**` in a project file means "src inside this workspace", not "any src
 * anywhere". Leaving it relative would make the rule match by accident against
 * paths from a different tree.
 */
function anchorPattern(pattern: string, capability: string, workspaceRoot: CanonicalPath): string {
  if (!capability.startsWith('file.')) return pattern;

  // `~/…` is expanded here rather than left literal: rules are matched against
  // canonical paths, which never contain a tilde, so an unexpanded `~/.ssh/**`
  // would silently match nothing.
  if (pattern.startsWith('~/')) return `${toPosix(homedir())}/${pattern.slice(2)}`;
  if (pattern === '~') return toPosix(homedir());

  if (pattern.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pattern)) return pattern;
  if (pattern.startsWith('**/')) return pattern;

  // Collapse `..` so `../reference/**` next to a workspace of `/lab/kernel`
  // becomes `/lab/reference/**` rather than an un-matchable literal.
  return posix.normalize(`${toPosix(workspaceRoot)}/${pattern.replace(/^\.\//, '')}`);
}

/** Wrap project rules as a permission profile so the engine can layer them. */
export function projectRulesProfile(rules: readonly PolicyRule[]): PermissionProfile {
  return {
    name: 'project-rules',
    description: 'Rules from .agent/permissions.toml',
    // A project file that says nothing about a capability must not constrain it;
    // the layers above have already decided.
    fallback: 'allow',
    rules,
  };
}

/** Render the effective configuration for `/status`. */
export function describeConfig(config: KernelConfig, sources: readonly string[]): string {
  const lines = [
    `permission profile : ${config.security.permissionProfile}`,
    `model              : ${config.model.default}`,
    `secret redaction   : ${config.security.secretRedaction ? 'on' : 'OFF'}`,
    `telemetry          : ${config.telemetry.enabled ? 'metadata only' : 'off'}`,
    `shell network      : ${config.shell.defaultNetwork ? 'default on' : 'default off'}`,
    `loop budget        : ${config.loop.maxSteps} steps, ${config.loop.maxToolCalls} tool calls`,
    `config sources     : ${sources.length > 0 ? sources.join(', ') : '(defaults only)'}`,
  ];
  if (config.warnings.length > 0) {
    lines.push('warnings:');
    for (const w of config.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}
