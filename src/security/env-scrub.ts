/**
 * Environment scrubbing (spec §13.4).
 *
 * `spawn(cmd, { env: process.env })` is banned in this codebase. Child processes
 * get an environment built from scratch by `scrubEnv()`.
 *
 * The mechanism is an **allowlist**. A denylist of `*_TOKEN`-style names is
 * included too, but only as an assertion used by tests and audits — relying on a
 * denylist means every new credential variable in the ecosystem is a silent leak
 * until someone notices.
 */

import { globMatch } from '../util/glob.ts';

/** Variables a build/test/lint command legitimately needs. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_*',
  'TERM',
  'TMPDIR',
  'TZ',
  'PWD',
  'USER',
  'LOGNAME',
  // Locale/encoding knobs that make tool output deterministic.
  'COLUMNS',
  'LINES',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
];

/**
 * Names that must never appear in a child environment unless injected as an
 * explicit `SecretLease`. Used by `assertNoCredentialEnv()` and the audit path.
 */
export const CREDENTIAL_ENV_PATTERNS: readonly string[] = [
  '*_API_KEY',
  '*_APIKEY',
  '*_TOKEN',
  '*_SECRET',
  '*_PASSWORD',
  '*_CREDENTIALS',
  '*_PRIVATE_KEY',
  'AWS_*',
  'GOOGLE_*',
  'GCP_*',
  'AZURE_*',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'KUBECONFIG',
  'DOCKER_*',
  'NETLIFY_*',
  'VERCEL_*',
  'STRIPE_*',
  'SLACK_*',
  'CLOUDSDK_*',
];

export interface ScrubEnvOptions {
  /** Base environment to filter. Defaults to the host environment. */
  source?: NodeJS.ProcessEnv;
  /** Extra allowlist entries from configuration. Glob syntax. */
  allow?: readonly string[];
  /** Non-secret variables the tool explicitly asked for. */
  extra?: Record<string, string>;
  /** Replace HOME, e.g. with a sandbox home directory. */
  home?: string;
  /** Include SHELL. Off by default; only needed by a few build systems. */
  includeShell?: boolean;
  /** Working directory to advertise as PWD. */
  cwd?: string;
}

export interface ScrubEnvResult {
  env: Record<string, string>;
  /** Names dropped because they were not on the allowlist. Values never kept. */
  droppedNames: string[];
  /** Dropped names that also looked credential-shaped. For audit events. */
  droppedCredentialNames: string[];
}

export function scrubEnv(opts: ScrubEnvOptions = {}): ScrubEnvResult {
  const source = opts.source ?? process.env;
  const allow = [...DEFAULT_ENV_ALLOWLIST, ...(opts.allow ?? [])];
  if (opts.includeShell) allow.push('SHELL');

  const env: Record<string, string> = {};
  const droppedNames: string[] = [];
  const droppedCredentialNames: string[] = [];

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allow.some((pattern) => globMatch(pattern, name, { caseInsensitive: false }))) {
      env[name] = value;
      continue;
    }
    droppedNames.push(name);
    if (looksLikeCredentialName(name)) droppedCredentialNames.push(name);
  }

  if (opts.home !== undefined) env.HOME = opts.home;
  if (opts.cwd !== undefined) env.PWD = opts.cwd;

  // Extras are applied last so a tool can override PATH for a toolchain, but
  // they are still ordinary non-secret values: secrets arrive via SecretLease.
  for (const [name, value] of Object.entries(opts.extra ?? {})) {
    env[name] = value;
  }

  return { env, droppedNames, droppedCredentialNames };
}

export function looksLikeCredentialName(name: string): boolean {
  return CREDENTIAL_ENV_PATTERNS.some((p) => globMatch(p, name, { caseInsensitive: false }));
}

/**
 * Assert that a prepared environment carries no credential-shaped variable other
 * than the ones explicitly injected as leases. Called by the local backend right
 * before spawn, and directly by the security test suite.
 */
export function assertNoCredentialEnv(
  env: Record<string, string>,
  injectedNames: readonly string[] = [],
): { ok: boolean; offending: string[] } {
  const injected = new Set(injectedNames);
  const offending = Object.keys(env).filter((n) => !injected.has(n) && looksLikeCredentialName(n));
  return { ok: offending.length === 0, offending };
}

/**
 * A minimal environment for a process that should see nothing at all — used for
 * hooks and for the strictest profiles.
 */
export function minimalEnv(home: string, cwd: string): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    PWD: cwd,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
}
