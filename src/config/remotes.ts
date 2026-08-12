/**
 * Remote configuration (spec §19.2).
 *
 * Remotes live in the **user's** config directory, never in the project:
 *
 *   ~/.config/mycoder/remotes.toml
 *
 * A project file may reference a remote by name and nothing more. It cannot
 * define one, cannot supply a host, and certainly cannot supply a key — which is
 * what stops a cloned repository from pointing an agent at a machine the user
 * never chose.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { parseToml, TomlParseError, type TomlTable, type TomlValue } from '../util/toml.ts';
import { defaultRemoteConfig, validateRemoteConfig, type RemoteConfig } from '../execution/ssh.ts';

export interface LoadRemotesResult {
  remotes: RemoteConfig[];
  warnings: string[];
  source?: string;
}

export async function loadRemotes(
  userConfigDir: string,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<LoadRemotesResult> {
  const file = path.join(userConfigDir, 'remotes.toml');

  let content: string;
  try {
    content = await readFileImpl(file);
  } catch {
    return { remotes: [], warnings: [] };
  }

  let table: TomlTable;
  try {
    table = parseToml(content);
  } catch (e) {
    const detail = e instanceof TomlParseError ? e.message : 'parse error';
    return {
      remotes: [],
      warnings: [`remotes.toml could not be parsed (${detail}); no remotes were loaded`],
    };
  }

  const parsed = parseRemotesTable(table);
  return { ...parsed, source: file };
}

export function parseRemotesTable(table: TomlTable): { remotes: RemoteConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  const remotes: RemoteConfig[] = [];

  const remoteSection = table.remote;
  if (typeof remoteSection !== 'object' || remoteSection === null || Array.isArray(remoteSection)) {
    return { remotes, warnings };
  }

  for (const [name, value] of Object.entries(remoteSection as TomlTable)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      warnings.push(`remote "${name}" is not a table; ignored`);
      continue;
    }
    const entry = value as TomlTable;

    const host = str(entry.host);
    const workspace = str(entry.workspace);
    if (!host || !workspace) {
      warnings.push(`remote "${name}" needs both host and workspace; ignored`);
      continue;
    }

    const config: RemoteConfig = {
      ...defaultRemoteConfig(name, host, workspace),
      ...(str(entry.profile) ? { profile: str(entry.profile)! } : {}),
      ...(str(entry.ssh_config_file) ? { sshConfigFile: str(entry.ssh_config_file)! } : {}),
      ...(str(entry.user) ? { user: str(entry.user)! } : {}),
      ...(num(entry.port) !== undefined ? { port: num(entry.port)! } : {}),
      ...(num(entry.connect_timeout_sec) !== undefined
        ? { connectTimeoutSec: num(entry.connect_timeout_sec)! }
        : {}),
      ...(bool(entry.control_master) !== undefined ? { controlMaster: bool(entry.control_master)! } : {}),
      // The three security fields below are read so they can be *rejected*
      // explicitly rather than silently ignored: a user who wrote
      // `forward_agent = true` needs to be told it did not take effect.
      ...(bool(entry.forward_agent) !== undefined ? { forwardAgent: bool(entry.forward_agent)! } : {}),
      ...(strList(entry.forward_env) ? { forwardEnv: strList(entry.forward_env)! } : {}),
      ...(bool(entry.strict_host_key_checking) !== undefined
        ? { strictHostKeyChecking: bool(entry.strict_host_key_checking)! }
        : {}),
    };

    const validation = validateRemoteConfig(config);
    if (!validation.ok) {
      for (const problem of validation.problems) {
        warnings.push(`remote "${name}": ${problem}`);
      }
      // Keep the remote, with the offending fields forced back to safe values.
      // Dropping it entirely would leave the user with a remote that silently
      // does not exist; this way it works, and the refusal is visible.
      remotes.push({
        ...config,
        forwardAgent: false,
        forwardEnv: [],
        strictHostKeyChecking: true,
        ...(config.user === 'root' ? { user: undefined as unknown as string } : {}),
      });
      continue;
    }

    remotes.push(config);
  }

  return { remotes: remotes.sort((a, b) => a.name.localeCompare(b.name)), warnings };
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

function strList(v: TomlValue | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}
