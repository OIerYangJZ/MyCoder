/**
 * Permission profiles (spec §11.3 and Appendix A).
 *
 * A profile is a list of rules, not a bag of booleans, so that a rule can be
 * traced back in `/permissions explain`. Profiles are built against a workspace
 * because almost every meaningful rule is "…inside this workspace".
 *
 * Profiles never grant more than the protected-path layer allows; hard denies
 * are evaluated separately and cannot be reached by a rule.
 */

import * as path from 'node:path';

import { PROJECT_DIR } from '../app.ts';
import { toPosix, type CanonicalPath } from '../util/paths.ts';
import type { Capability } from './access.ts';

export type PolicyAction = 'hard_deny' | 'deny' | 'ask' | 'allow';

/** Strictness ordering: HARD_DENY > DENY > ASK > ALLOW (spec §11.2). */
const STRICTNESS: Record<PolicyAction, number> = {
  hard_deny: 3,
  deny: 2,
  ask: 1,
  allow: 0,
};

export function strictest(a: PolicyAction, b: PolicyAction): PolicyAction {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

export function isStricter(a: PolicyAction, b: PolicyAction): boolean {
  return STRICTNESS[a] > STRICTNESS[b];
}

export interface PolicyRule {
  action: PolicyAction;
  capability: Capability | '*';
  /** Glob matched against the request's target (path, host, executable…). */
  pattern?: string;
  /** Glob matched against the full argv, for `process.exec`. */
  argvPattern?: string;
  /** Restrict a network rule to particular egress channels. */
  via?: readonly string[];
  ports?: readonly number[];
  /** Shown in the approval prompt and in `/permissions explain`. */
  note?: string;
}

export interface PermissionProfile {
  name: string;
  description: string;
  /** Applied when no rule matches. */
  fallback: PolicyAction;
  rules: readonly PolicyRule[];
}

export interface ProfileContext {
  workspaceRoot: CanonicalPath;
  /** Scratch directory the agent may always write to. */
  agentTmpDir?: string;
  /** Build output globs that are safe to write, from `[generated_paths]`. */
  generatedPaths?: readonly string[];
}

/** Executables that are ordinary development tooling. */
const DEV_EXECUTABLES: readonly string[] = [
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'tsc',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  'python',
  'python3',
  'pytest',
  'ruff',
  'mypy',
  'go',
  'gofmt',
  'cargo',
  'rustc',
  'rustfmt',
  'clippy-driver',
  'make',
  'cmake',
  'just',
  'bash',
  'sh',
  'zsh',
  'git',
  'rg',
  'grep',
  'find',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'sed',
  'awk',
  'sort',
  'uniq',
  'diff',
  'jq',
  'echo',
  'true',
  'false',
  'env',
  'which',
  'pwd',
];

/** Subcommands that mutate dependencies and therefore always require approval. */
const PACKAGE_MUTATION_ARGV: readonly string[] = [
  'npm install*',
  'npm i *',
  'npm ci*',
  'npm add*',
  'npm update*',
  'npm uninstall*',
  'npm publish*',
  'pnpm add*',
  'pnpm install*',
  'pnpm update*',
  'pnpm remove*',
  'yarn add*',
  'yarn install*',
  'yarn upgrade*',
  'bun add*',
  'bun install*',
  'pip install*',
  'pip3 install*',
  'python -m pip install*',
  'cargo add*',
  'cargo install*',
  'go get*',
  'go install*',
  'brew install*',
  'gem install*',
];

const LOCKFILE_PATTERNS: readonly string[] = [
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/go.sum',
  '**/Gemfile.lock',
  '**/composer.lock',
];

/**
 * Matches the workspace root *and* everything under it.
 *
 * `<root>/**` alone does not match `<root>` itself, which silently turned
 * directory-scoped operations — Glob and Grep against the workspace root — into
 * approval prompts. The empty brace alternative covers the root.
 */
function workspaceGlob(root: CanonicalPath): string {
  return `${toPosix(root)}{,/**}`;
}

function readRules(root: CanonicalPath): PolicyRule[] {
  return [
    {
      action: 'allow',
      capability: 'file.read',
      pattern: workspaceGlob(root),
      note: 'workspace read',
    },
    {
      action: 'allow',
      capability: 'file.read_to_model',
      pattern: workspaceGlob(root),
      note: 'workspace read into context',
    },
    { action: 'ask', capability: 'file.read', note: 'read outside the workspace' },
    { action: 'ask', capability: 'file.read_to_model', note: 'read outside the workspace' },
  ];
}

function gitReadRules(): PolicyRule[] {
  return [
    {
      action: 'allow',
      capability: 'process.exec',
      pattern: 'git',
      argvPattern: 'git {status,diff,log,show,rev-parse,ls-files,branch,remote,blame}*',
      note: 'read-only git',
    },
  ];
}

/**
 * Search binaries are allowed outright in every profile.
 *
 * They cannot write, and Grep is unusable if searching costs an approval prompt.
 * What they *can* do — read a secret file — is stopped at the path layer, which
 * is where that decision belongs: `Shell cat .env` and `Grep -f .env` are both
 * refused by ProtectedPaths, not by an executable allowlist.
 */
function searchRules(): PolicyRule[] {
  return [
    {
      action: 'allow',
      capability: 'process.exec',
      pattern: '{rg,ripgrep,grep,egrep,fgrep}',
      note: 'read-only search',
    },
  ];
}

/**
 * Delegation is permitted by every builtin profile (alpha.4 §11, ADR-0013).
 *
 * That reads like a widening and is the opposite of one. A child's effective
 * capability is an intersection that includes its parent's, so dispatching one
 * grants nothing that was not already available — a read-only session delegating
 * to an agent whose definition asks for `workspace-dev` still produces a
 * read-only child. What delegation does spend is *budget*, and budget is bounded
 * separately and exactly (§13).
 *
 * Denying it by default would mean the useful case — a read-only reviewer child
 * under a read-only parent — needed an approval prompt to do strictly nothing
 * new, and the security property being protected would come from the prompt
 * rather than from the intersection. So the rule is `allow` with a note, and a
 * project that wants a narrower answer writes it in `permissions.toml`:
 *
 *     [[rule]] action = "deny" capability = "agent.invoke" pattern = "release-bot"
 *
 * which is what alpha.4 §11's "discovery must not imply invocation" asks for —
 * an expressible policy, not a hard-coded one.
 */
function delegationRules(): PolicyRule[] {
  return [
    {
      action: 'allow',
      capability: 'agent.invoke',
      note: 'delegate a bounded task; the child inherits this profile as a ceiling',
    },
  ];
}

export function readOnlyProfile(ctx: ProfileContext): PermissionProfile {
  return {
    name: 'read-only',
    description: 'Inspect the workspace. No writes, no network, no VCS mutation.',
    fallback: 'deny',
    rules: [
      ...readRules(ctx.workspaceRoot),
      ...gitReadRules(),
      ...searchRules(),
      ...delegationRules(),
      { action: 'deny', capability: 'file.write', note: 'read-only profile' },
      { action: 'deny', capability: 'file.delete', note: 'read-only profile' },
      { action: 'deny', capability: 'network.connect', note: 'read-only profile' },
      { action: 'deny', capability: 'vcs.mutate', note: 'read-only profile' },
      { action: 'deny', capability: 'secret.use', note: 'read-only profile' },
      // A foreign tool cannot be classified as read-only, because `readOnly`
      // would be the *server's* claim about itself, and ADR-0023 §2 says those
      // are worth nothing. A profile whose promise is "this session changes
      // nothing" cannot keep that promise while calling code it cannot see.
      {
        action: 'deny',
        capability: 'mcp.invoke',
        note: 'read-only profile: a tool whose effects are unknown is not a read',
      },
      // Appendix A: test/lint/build is `ask` under read-only.
      {
        action: 'ask',
        capability: 'process.exec',
        pattern: `{${DEV_EXECUTABLES.join(',')}}`,
        note: 'run a development command',
      },
      { action: 'ask', capability: 'remote.connect' },
    ],
  };
}

export function reviewProfile(ctx: ProfileContext): PermissionProfile {
  return {
    name: 'review',
    description: 'Read and run verification commands. No writes, no network.',
    fallback: 'deny',
    rules: [
      ...readRules(ctx.workspaceRoot),
      ...gitReadRules(),
      ...searchRules(),
      ...delegationRules(),
      { action: 'deny', capability: 'file.write', note: 'review profile is read-only' },
      { action: 'deny', capability: 'file.delete', note: 'review profile does not remove files' },
      { action: 'deny', capability: 'network.connect', note: 'review profile has no network' },
      { action: 'deny', capability: 'vcs.mutate', note: 'review profile does not mutate git' },
      { action: 'deny', capability: 'secret.use' },
      {
        action: 'deny',
        capability: 'mcp.invoke',
        note: 'review profile: a tool whose effects are unknown is not a review',
      },
      {
        action: 'allow',
        capability: 'process.exec',
        pattern: `{${DEV_EXECUTABLES.join(',')}}`,
        note: 'test / lint / build with no network',
      },
      ...PACKAGE_MUTATION_ARGV.map((argvPattern): PolicyRule => ({
        action: 'deny',
        capability: 'process.exec',
        argvPattern,
        note: 'dependency mutation is not allowed while reviewing',
      })),
      // Writing to the scratch directory keeps review tooling usable.
      ...(ctx.agentTmpDir
        ? [
            {
              action: 'allow' as const,
              capability: 'file.write' as const,
              pattern: `${toPosix(ctx.agentTmpDir)}/**`,
              note: 'agent scratch directory',
            },
          ]
        : []),
      { action: 'ask', capability: 'remote.connect' },
    ],
  };
}

export function workspaceDevProfile(ctx: ProfileContext): PermissionProfile {
  const root = ctx.workspaceRoot;
  const tmp = ctx.agentTmpDir ?? path.join(root, PROJECT_DIR, 'tmp');

  return {
    name: 'workspace-dev',
    description: 'Edit the workspace and run local verification. Network and VCS mutation ask.',
    fallback: 'ask',
    rules: [
      ...readRules(root),
      ...gitReadRules(),
      ...searchRules(),
      ...delegationRules(),

      // --- writes -------------------------------------------------------
      {
        action: 'allow',
        capability: 'file.write',
        pattern: workspaceGlob(root),
        note: 'workspace source, tests and docs',
      },
      {
        action: 'allow',
        capability: 'file.write',
        pattern: `${toPosix(tmp)}/**`,
        note: 'agent scratch directory',
      },
      ...(ctx.generatedPaths ?? []).map((p): PolicyRule => ({
        action: 'allow',
        capability: 'file.write',
        pattern: p.startsWith('/') ? p : `${toPosix(root)}/${p}`,
        note: 'declared generated path',
      })),
      ...LOCKFILE_PATTERNS.map((pattern): PolicyRule => ({
        action: 'ask',
        capability: 'file.write',
        pattern,
        note: 'lockfile changes are reviewed explicitly',
      })),
      { action: 'ask', capability: 'file.write', note: 'write outside the workspace' },

      // --- deletions ------------------------------------------------------
      //
      // `ask` everywhere except scratch, including inside the workspace where an
      // ordinary write is allowed outright. Overwriting a tracked file leaves a
      // diff and a receipt; removing one leaves neither, and the profile should
      // not treat those as the same act (ADR-0016).
      {
        action: 'allow',
        capability: 'file.delete',
        pattern: `${toPosix(tmp)}/**`,
        note: 'agent scratch directory',
      },
      { action: 'ask', capability: 'file.delete', note: 'removing or renaming a file' },

      // --- processes ----------------------------------------------------
      {
        action: 'allow',
        capability: 'process.exec',
        pattern: `{${DEV_EXECUTABLES.join(',')}}`,
        note: 'test / lint / build / formatter with a scrubbed environment',
      },
      ...PACKAGE_MUTATION_ARGV.map((argvPattern): PolicyRule => ({
        action: 'ask',
        capability: 'process.exec',
        argvPattern,
        note: 'installs or updates dependencies',
      })),
      { action: 'ask', capability: 'process.exec', note: 'run an unrecognised executable' },

      // --- everything else ----------------------------------------------
      { action: 'ask', capability: 'network.connect', note: 'network access is opt-in per host' },
      { action: 'ask', capability: 'vcs.mutate', note: 'git history changes are reviewed' },
      { action: 'ask', capability: 'secret.use', note: 'a credential would be injected' },
      { action: 'ask', capability: 'remote.connect', note: 'first connection to a remote' },
      { action: 'ask', capability: 'env.read' },
      // Per server *and* per tool — `subjectKeyOf` makes the subject
      // `mcp.invoke:<server>/<tool>`, so a server with thirty tools costs thirty
      // approvals across a session. That is deliberate and it is the cheaper of
      // the two mistakes: one approval covering twenty-nine tools the user never
      // saw is the shape alpha.6 §36 already rejected for network hosts.
      {
        action: 'ask',
        capability: 'mcp.invoke',
        note: 'a tool this kernel did not write; nothing enforces what it does',
      },
    ],
  };
}

export type ProfileBuilder = (ctx: ProfileContext) => PermissionProfile;

export const BUILTIN_PROFILES: Record<string, ProfileBuilder> = {
  'read-only': readOnlyProfile,
  'workspace-dev': workspaceDevProfile,
  review: reviewProfile,
};

export function buildProfile(name: string, ctx: ProfileContext): PermissionProfile | undefined {
  const builder = BUILTIN_PROFILES[name];
  return builder ? builder(ctx) : undefined;
}

export function listProfileNames(): string[] {
  return Object.keys(BUILTIN_PROFILES).sort();
}
