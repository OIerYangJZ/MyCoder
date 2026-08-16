/**
 * Container plan, mount planner and validator (alpha.5 §12–§21, §50, ADR-0014).
 *
 * Everything in this file is a **pure function of a capability profile**. No
 * process is spawned here and nothing touches the network; the container backend
 * calls `planContainerMounts`, then `buildContainerPlan`, then
 * `validateContainerPlan`, and only then does it assemble a `docker` argv.
 *
 * That split exists because of what §12 forbids. The tempting implementation of
 * a container backend is one line —
 *
 *     -v "$WORKSPACE:/workspace:rw"
 *
 * — and it is wrong in a way that is invisible from the outside: every profile
 * gets the same mount, so a read-only session, a review skill and a
 * fully-trusted dev session all hand the subprocess identical write authority.
 * The container would be real and the enforcement would be theatre. So the mount
 * set is derived from the *effective* capability, the derivation is a pure
 * function with unit tests over the interesting profiles (§60), and a second
 * validator re-checks the finished plan before Docker sees it (§50) so a bug in
 * the planner cannot become a mount escape.
 *
 * The container path layout is fixed:
 *
 *     /workspace        the workspace root, read-only by default
 *     /workspace/...    capability-derived writable overlays
 *     /tmp, /var/tmp    tmpfs, writable, never shared with the host
 *
 * and nothing else is mounted. Not the host home, not `/`, not the Docker
 * socket, not `SSH_AUTH_SOCK`. §16's point is that the primary defence is
 * absence: a path that was never mounted cannot be reached by a traversal, a
 * symlink, or a bug in a path scanner.
 */

import { toPosix, type CanonicalPath } from '../util/paths.ts';
import { classifyAddress, normalizeHostOrUndefined } from '../security/egress/host.ts';
import type { CapabilityProfile } from './backend.ts';

/** Where the workspace appears inside the container. */
export const CONTAINER_WORKSPACE = '/workspace';

/** Writable ephemeral areas, on tmpfs so nothing survives the process. */
export const CONTAINER_TMP = '/tmp';
export const CONTAINER_VAR_TMP = '/var/tmp';

export type MountMode = 'ro' | 'rw';

export interface ContainerMount {
  /** Canonical host path. Symlinks already resolved by the caller. */
  hostPath: string;
  /** Absolute POSIX path inside the container. */
  containerPath: string;
  mode: MountMode;
  /** Why this mount exists. Recorded in the audit trail and in `/status`. */
  origin: 'workspace-base' | 'write-root' | 'agent-tmp' | 'mask';
  /** True when the host source is a single file rather than a directory. */
  isFile?: boolean;
}

export interface ContainerTmpfs {
  containerPath: string;
  sizeBytes: number;
  /** Octal mode, e.g. 0o1777 for a world-writable sticky /tmp. */
  mode: number;
  /** `noexec` where the workload does not need to run binaries from it. */
  noexec?: boolean;
}

/**
 * A path the profile granted that the plan could not express as a mount.
 *
 * §14: when a capability cannot be represented safely as a mount boundary, the
 * choice is to deny the execution shape or to report the enforcement as
 * incomplete — never to widen the mount until it fits. These are the reports.
 * They reach `/status`, the audit event and the model's tool result, so a write
 * that will fail inside the container fails *visibly*.
 */
export interface UnrepresentedCapability {
  path: string;
  kind: 'write' | 'read';
  reason: string;
}

export interface ContainerMountPlan {
  mounts: ContainerMount[];
  tmpfs: ContainerTmpfs[];
  workspaceContainerPath: string;
  unrepresented: UnrepresentedCapability[];
}

/**
 * What the planner needs to know about the host filesystem.
 *
 * Injected rather than imported so the planner is testable without a real tree,
 * and so the container backend can reuse the backend's own `FileSystemBackend`
 * (which is already canonicalising and symlink-resolving) instead of a second
 * path implementation that could disagree with it.
 */
export interface MountPlannerHost {
  /** Resolved through symlinks, or undefined when the path does not exist. */
  realpath(p: string): Promise<string | undefined>;
  /** `'file' | 'dir'`, or undefined when absent. Follows symlinks. */
  kind(p: string): Promise<'file' | 'dir' | undefined>;
}

export interface MountPlannerOptions {
  workspaceRoot: CanonicalPath;
  /** Kernel scratch directory. Always writable; created before the run. */
  agentTmpDir?: CanonicalPath;
  /**
   * Existing directories inside the workspace that configuration declared
   * generated (`[generated_paths]`), resolved to concrete paths by the caller.
   *
   * They are writable *when the profile already grants execution*, because a
   * build or a test run that cannot write `dist/` or a tool cache is not a build
   * (§4 "generated-path writable mounts"). They are still capability-derived in
   * the sense that matters: the list comes from the user's configuration, never
   * from the model, and an exec-less profile gets none of them.
   */
  generatedDirs?: readonly CanonicalPath[];
  /**
   * Paths inside the workspace that must not be readable by the subprocess.
   *
   * Discovered by the caller from `ProtectedPaths` — a `.env` or a `*.pem` that
   * happens to live *inside* the workspace would otherwise arrive through the
   * base mount, which is precisely the reachability §16 says to eliminate. A
   * file is masked with an empty read-only file and a directory with an empty
   * tmpfs, so the content is absent rather than merely policy-denied.
   */
  maskPaths?: readonly CanonicalPath[];
  /** Empty host file used to mask a protected file. Created by the caller. */
  maskFileHostPath?: string;
  tmpfsBytes?: number;
}

const DEFAULT_TMPFS_BYTES = 256 * 1024 * 1024;

/** Map a host path inside the workspace to its container path. */
export function toContainerPath(workspaceRoot: string, hostPath: string): string | undefined {
  const root = toPosix(workspaceRoot).replace(/\/+$/, '');
  const p = toPosix(hostPath).replace(/\/+$/, '');
  if (p === root) return CONTAINER_WORKSPACE;
  if (!p.startsWith(`${root}/`)) return undefined;
  const rel = p.slice(root.length + 1);
  // A traversal segment cannot survive canonicalisation, so its presence here
  // means the caller passed a non-canonical path. Refuse rather than normalise:
  // normalising would silently accept exactly the input this check exists for.
  if (rel.split('/').includes('..')) return undefined;
  return `${CONTAINER_WORKSPACE}/${rel}`;
}

/** Map a container path back to the host, for error messages and audit. */
export function toHostPath(workspaceRoot: string, containerPath: string): string | undefined {
  const root = toPosix(workspaceRoot).replace(/\/+$/, '');
  if (containerPath === CONTAINER_WORKSPACE) return root;
  if (!containerPath.startsWith(`${CONTAINER_WORKSPACE}/`)) return undefined;
  return `${root}/${containerPath.slice(CONTAINER_WORKSPACE.length + 1)}`;
}

/**
 * Order mounts parent-before-child, then by mode (§15).
 *
 * Docker sorts destinations itself, but relying on that would make the plan's
 * *own* correctness depend on an implementation detail of the runtime — and the
 * plan is what the validator, the audit event and the tests read. Sorting here
 * means a nested writable overlay is applied after the read-only parent it sits
 * inside, in the plan as well as in the daemon.
 */
export function sortMounts(mounts: readonly ContainerMount[]): ContainerMount[] {
  return [...mounts].sort((a, b) => {
    const depth = a.containerPath.split('/').length - b.containerPath.split('/').length;
    if (depth !== 0) return depth;
    return a.containerPath.localeCompare(b.containerPath);
  });
}

/**
 * Derive the mount plan for one capability profile.
 *
 * The shape of the result is always: exactly one read-only base mount for the
 * workspace, zero or more writable overlays inside it, zero or more masks, and
 * tmpfs for the temporary directories. There is no code path that produces a
 * mount outside the workspace, which is why "host home absent" and "no host root
 * mount" are properties of the planner rather than checks bolted on afterwards.
 */
export async function planContainerMounts(
  profile: CapabilityProfile,
  host: MountPlannerHost,
  opts: MountPlannerOptions,
): Promise<ContainerMountPlan> {
  const workspaceRoot = toPosix(opts.workspaceRoot).replace(/\/+$/, '');
  const unrepresented: UnrepresentedCapability[] = [];
  const mounts: ContainerMount[] = [
    {
      hostPath: workspaceRoot,
      containerPath: CONTAINER_WORKSPACE,
      mode: 'ro',
      origin: 'workspace-base',
    },
  ];

  /** container path → mount, so a later grant cannot silently shadow an earlier. */
  const byContainerPath = new Map<string, ContainerMount>();
  byContainerPath.set(CONTAINER_WORKSPACE, mounts[0]!);

  const addWritable = async (candidate: string, origin: ContainerMount['origin']): Promise<void> => {
    // Canonicalise first. Everything downstream — the containment check, the
    // duplicate check, the validator — is only sound on a resolved path, and a
    // symlink is the one input designed to make an unresolved check pass.
    const resolved = (await host.realpath(candidate)) ?? candidate;
    const resolvedPosix = toPosix(resolved).replace(/\/+$/, '');

    if (resolvedPosix === workspaceRoot) {
      unrepresented.push({
        path: resolvedPosix,
        kind: 'write',
        reason:
          'write was granted on the workspace root itself; mounting the whole workspace read-write ' +
          'would also make .git and every source file writable, so the base stays read-only',
      });
      return;
    }

    const containerPath = toContainerPath(workspaceRoot, resolvedPosix);
    if (containerPath === undefined) {
      unrepresented.push({
        path: resolvedPosix,
        kind: 'write',
        reason: 'resolves outside the workspace, and nothing outside the workspace is mounted',
      });
      return;
    }

    // `.git` is read-only unless an approved VCS mutation asks otherwise, which
    // alpha.5 does not implement (§17). A writable `.git` reached through a
    // broader grant is the accident this check exists to prevent.
    if (
      containerPath === `${CONTAINER_WORKSPACE}/.git` ||
      containerPath.startsWith(`${CONTAINER_WORKSPACE}/.git/`)
    ) {
      unrepresented.push({
        path: resolvedPosix,
        kind: 'write',
        reason:
          'the repository metadata directory is mounted read-only; no approved VCS mutation exists in v0.1',
      });
      return;
    }

    const kind = await host.kind(resolvedPosix);
    if (kind === undefined) {
      // A bind mount whose source does not exist makes Docker *create a
      // directory* at the source path — a side effect on the host from planning
      // alone. Refuse and report instead.
      unrepresented.push({
        path: resolvedPosix,
        kind: 'write',
        reason: 'does not exist on the host, and a bind mount would create it as a directory',
      });
      return;
    }

    const existing = byContainerPath.get(containerPath);
    if (existing) {
      // Upgrade ro → rw rather than adding a second mount on the same
      // destination: two mounts on one path is the "ro/rw conflict" of §15, and
      // the effective mode would depend on ordering.
      if (existing.mode === 'ro' && existing.origin !== 'workspace-base' && existing.origin !== 'mask') {
        existing.mode = 'rw';
      }
      return;
    }

    const mount: ContainerMount = {
      hostPath: resolvedPosix,
      containerPath,
      mode: 'rw',
      origin,
      ...(kind === 'file' ? { isFile: true } : {}),
    };
    mounts.push(mount);
    byContainerPath.set(containerPath, mount);
  };

  for (const root of profile.writeRoots) {
    await addWritable(root, 'write-root');
  }
  if (opts.agentTmpDir) {
    await addWritable(opts.agentTmpDir, 'agent-tmp');
  }
  // Generated directories only for a profile that can actually run something.
  if (profile.allowExec) {
    for (const dir of opts.generatedDirs ?? []) {
      await addWritable(dir, 'write-root');
    }
  }

  // Read grants outside the workspace are reported, never mounted. Reference
  // trees stay reachable through the trusted file broker (§28), which is a
  // different, non-subprocess path.
  for (const root of profile.readRoots) {
    const resolved = (await host.realpath(root)) ?? root;
    if (toContainerPath(workspaceRoot, toPosix(resolved)) === undefined) {
      unrepresented.push({
        path: toPosix(resolved),
        kind: 'read',
        reason:
          'outside the workspace: not mounted into the container, though the Read tool can still reach it',
      });
    }
  }

  // Masks last, so they cannot be upgraded to rw by a later write grant.
  const tmpfs: ContainerTmpfs[] = [
    { containerPath: CONTAINER_TMP, sizeBytes: opts.tmpfsBytes ?? DEFAULT_TMPFS_BYTES, mode: 0o1777 },
    { containerPath: CONTAINER_VAR_TMP, sizeBytes: opts.tmpfsBytes ?? DEFAULT_TMPFS_BYTES, mode: 0o1777 },
  ];

  for (const target of opts.maskPaths ?? []) {
    const resolvedPosix = toPosix((await host.realpath(target)) ?? target).replace(/\/+$/, '');
    const containerPath = toContainerPath(workspaceRoot, resolvedPosix);
    // A mask for something outside the workspace is unnecessary: it was never
    // mounted. Silently ignored rather than reported, since it is not a
    // capability the profile asked for.
    if (containerPath === undefined || containerPath === CONTAINER_WORKSPACE) continue;
    if (byContainerPath.has(containerPath)) {
      // A protected path that is also a granted write root is a policy defect,
      // not something to resolve by preference. Drop the writable mount and
      // report it: the safe outcome is that the process sees nothing there.
      const conflicting = byContainerPath.get(containerPath)!;
      const index = mounts.indexOf(conflicting);
      if (index >= 0) mounts.splice(index, 1);
      unrepresented.push({
        path: resolvedPosix,
        kind: 'write',
        reason: 'a protected path was also granted for writing; the mount was dropped and the path masked',
      });
    }

    const kind = await host.kind(resolvedPosix);
    if (kind === 'dir') {
      tmpfs.push({ containerPath, sizeBytes: 4096, mode: 0o500, noexec: true });
      byContainerPath.set(containerPath, {
        hostPath: '(tmpfs)',
        containerPath,
        mode: 'ro',
        origin: 'mask',
      });
      continue;
    }
    if (kind === 'file' && opts.maskFileHostPath) {
      const mount: ContainerMount = {
        hostPath: opts.maskFileHostPath,
        containerPath,
        mode: 'ro',
        origin: 'mask',
        isFile: true,
      };
      mounts.push(mount);
      byContainerPath.set(containerPath, mount);
    }
  }

  return {
    mounts: sortMounts(mounts),
    tmpfs,
    workspaceContainerPath: CONTAINER_WORKSPACE,
    unrepresented,
  };
}

// --- the plan --------------------------------------------------------------

export interface ContainerLimits {
  /** Maximum number of processes. Bounds an obvious fork bomb. */
  pids?: number;
  memoryBytes?: number;
  /** Fractional CPUs, as Docker's `--cpus`. */
  cpus?: number;
}

export interface ContainerImageRef {
  /** What configuration asked for, e.g. `node:22-bookworm`. */
  configured: string;
  /** What the daemon resolved it to, when known. Recorded for provenance (§11). */
  resolvedId?: string;
  digest?: string;
}

/**
 * The plan's network, in the three shapes alpha.6 §9 distinguishes.
 *
 * alpha.5 had `'none' | 'bridge'`, which is exactly the collapse that made a
 * host allowlist unenforceable: `{ hosts: [...] }` and "give it the internet"
 * were the same value. Splitting `unrestricted` from `scoped` means the plan —
 * the thing the validator, the audit event and `/status` all read — records
 * which of the two the capability actually asked for.
 */
export type ContainerNetworkPlan =
  /** `--network none`: no interfaces at all. */
  | { kind: 'none' }
  /** Explicitly approved broad egress: an ordinary bridge (§40). */
  | { kind: 'unrestricted' }
  /**
   * The private per-execution network, with a dual-homed proxy as the only exit
   * (§12, §13). `dockerNetwork` is `--internal`, so attaching to it *is* the
   * denial of direct egress; `dns` points the workload's resolver at its own
   * loopback so external name resolution fails too (§15).
   */
  | {
      kind: 'scoped';
      dockerNetwork: string;
      proxyAddress: string;
      proxyPort: number;
      dns: readonly string[];
      /** Normalised, sorted approved hosts. Recorded for audit and `/status`. */
      allowedHosts: readonly string[];
    };

export interface ContainerPlan {
  image: ContainerImageRef;
  mounts: readonly ContainerMount[];
  tmpfs: readonly ContainerTmpfs[];
  /** Working directory inside the container. */
  cwd: string;
  /** Non-secret environment, already scrubbed. */
  env: Record<string, string>;
  /**
   * Names whose values are passed through the docker client's own environment
   * rather than on the command line (§25).
   *
   * A secret in `-e NAME=value` is a secret in the host's process table, which
   * every user on the machine can read. `-e NAME` makes the daemon take the
   * value from the client process, whose environment the kernel controls.
   */
  envPassthrough: readonly string[];
  network: ContainerNetworkPlan;
  /** `uid:gid`, or undefined to accept the image's user. */
  user?: string;
  readOnlyRoot: boolean;
  capDropAll: boolean;
  noNewPrivileges: boolean;
  limits: ContainerLimits;
  /** `--rm`: one ephemeral container per execution (§27). */
  removeOnExit: boolean;
  /** Deterministic container name, so a leaked container can be found and killed. */
  name: string;
  argv: readonly string[];
  timeoutMs: number;
  /** Capabilities the mount plan could not express (§14). */
  unrepresented: readonly UnrepresentedCapability[];
}

export interface BuildPlanOptions {
  image: ContainerImageRef;
  mountPlan: ContainerMountPlan;
  /** Host cwd; must be inside the workspace. */
  cwd: CanonicalPath;
  workspaceRoot: CanonicalPath;
  env: Record<string, string>;
  envPassthrough?: readonly string[];
  argv: readonly string[];
  timeoutMs: number;
  network: ContainerNetworkPlan;
  user?: string;
  limits?: ContainerLimits;
  name: string;
}

/**
 * Assemble the plan.
 *
 * The hardening flags are not parameters. `--read-only`, `--cap-drop=ALL` and
 * `--security-opt=no-new-privileges` are properties of *every* plan this kernel
 * produces, so there is no configuration path — and no model-reachable path — to
 * a plan without them. §70's "Privilege Stop" is that a tool or model input
 * could inject a privileged flag; the way to make that unreachable is to not
 * have the knob.
 */
export function buildContainerPlan(opts: BuildPlanOptions): ContainerPlan {
  const cwd = toContainerPath(opts.workspaceRoot, opts.cwd);
  return {
    image: opts.image,
    mounts: opts.mountPlan.mounts,
    tmpfs: opts.mountPlan.tmpfs,
    // An out-of-workspace cwd is refused by the validator; falling back to the
    // workspace root here would run the command somewhere the caller did not
    // ask for, which is worse than failing.
    cwd: cwd ?? '(outside-workspace)',
    env: opts.env,
    envPassthrough: opts.envPassthrough ?? [],
    network: opts.network,
    ...(opts.user ? { user: opts.user } : {}),
    readOnlyRoot: true,
    capDropAll: true,
    noNewPrivileges: true,
    limits: opts.limits ?? {},
    removeOnExit: true,
    name: opts.name,
    argv: opts.argv,
    timeoutMs: opts.timeoutMs,
    unrepresented: opts.mountPlan.unrepresented,
  };
}

// --- the validator ---------------------------------------------------------

export interface ValidatePlanOptions {
  workspaceRoot: CanonicalPath;
  /** Trusted image references. A plan naming anything else is refused (§11). */
  allowedImages: readonly string[];
  /**
   * Canonical host paths that must never appear as a mount source.
   *
   * The credential files and protected directories the kernel already knows
   * about, passed in rather than re-derived, so the validator and the policy
   * engine cannot disagree about what is protected.
   */
  protectedHostPaths?: readonly string[];
  /** Predicate form, for pattern-based protection (`~/.ssh/**`). */
  isProtectedHostPath?: (hostPath: string) => boolean;
  /** Names permitted to carry a value through the client environment. */
  allowedEnvPassthrough?: readonly string[];
}

export interface PlanValidation {
  ok: boolean;
  problems: string[];
}

/** Host paths that are never a legitimate mount source, whatever asked for them. */
const FORBIDDEN_MOUNT_SOURCES: readonly RegExp[] = [
  /^\/$/,
  /^\/etc(\/|$)/,
  /^\/var\/run(\/|$)/,
  /^\/run(\/|$)/,
  /^\/proc(\/|$)/,
  /^\/sys(\/|$)/,
  /^\/dev(\/|$)/,
  /docker\.sock$/,
  /containerd.*\.sock$/,
  /\.ssh(\/|$)/,
  /\.aws(\/|$)/,
  /\.kube(\/|$)/,
  /\.azure(\/|$)/,
  /\.docker(\/|$)/,
  /\.gnupg(\/|$)/,
  /gcloud(\/|$)/,
];

/** Container destinations that would defeat the boundary if written to. */
const FORBIDDEN_MOUNT_DESTINATIONS: readonly string[] = [
  '/',
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/var/run',
  '/run',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
];

/**
 * The network half of the second boundary (alpha.6 §39, §86).
 *
 * Its job is to make the fall-back-to-bridge failure *unrepresentable in a plan
 * that reaches the daemon*, not merely absent from the code that builds one. The
 * scoped shape is only accepted when every part of the topology it names is
 * present: a private network with the kernel's own prefix, a proxy at a private
 * address, and a resolver that cannot reach outside. A plan claiming `scoped`
 * while pointing at `bridge` is the exact defect §39 calls the Fallback Stop, and
 * it is refused here even though nothing in the backend can currently produce it.
 */
function validateNetworkPlan(plan: ContainerPlan): string[] {
  const problems: string[] = [];
  const network = plan.network;

  if (network.kind === 'none' || network.kind === 'unrestricted') return problems;
  if (network.kind !== 'scoped') {
    problems.push(
      `network mode "${String((network as { kind: string }).kind)}" is not one of none/unrestricted/scoped`,
    );
    return problems;
  }

  if (!/^mycoder-egress-[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(network.dockerNetwork)) {
    problems.push(
      `scoped egress names docker network "${network.dockerNetwork}", which is not a kernel-owned private network`,
    );
  }
  // Naming a shared or built-in network would silently reintroduce a route.
  if (['bridge', 'host', 'none', 'default'].includes(network.dockerNetwork)) {
    problems.push(`scoped egress must not run on the built-in "${network.dockerNetwork}" network`);
  }
  const proxyScope = classifyAddress(network.proxyAddress)?.scope;
  if (proxyScope !== 'private') {
    problems.push(
      `the scoped-egress proxy address "${network.proxyAddress}" is ${proxyScope ?? 'unparseable'}, not a private address`,
    );
  }
  if (!Number.isInteger(network.proxyPort) || network.proxyPort < 1 || network.proxyPort > 65535) {
    problems.push('the scoped-egress proxy port is not a valid port number');
  }
  if (network.dns.length === 0) {
    problems.push(
      'scoped egress must pin the workload resolver; an unset --dns inherits external resolution',
    );
  }
  for (const server of network.dns) {
    // Loopback only: the point is that the embedded resolver has no upstream it
    // can reach, so external names do not resolve inside the workload (§15).
    if (classifyAddress(server)?.scope !== 'loopback') {
      problems.push(`scoped egress resolver "${server}" is not a loopback address`);
    }
  }
  if (network.allowedHosts.length === 0) {
    problems.push('scoped egress has an empty approved host set, which is not a valid grant (alpha.6 §9)');
  }
  for (const host of network.allowedHosts) {
    const normalized = normalizeHostOrUndefined(host);
    if (normalized !== host) {
      problems.push(
        `approved host "${host}" is not in normalised form; the plan and the proxy policy could differ`,
      );
    }
  }

  // The workload's proxy variables must name the proxy this plan created, and
  // nothing else. A `HTTP_PROXY` pointing anywhere else would be a second,
  // unvalidated destination handed to every well-behaved client.
  const expected = `http://${network.proxyAddress}:${network.proxyPort}`;
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    const value = plan.env[name];
    if (value === undefined) {
      problems.push(`scoped egress did not set ${name} for the workload`);
    } else if (value !== expected) {
      problems.push(`${name} does not point at this execution's egress proxy`);
    }
  }
  for (const name of ['NO_PROXY', 'no_proxy']) {
    // A non-empty NO_PROXY would tell a client that some destination needs no
    // proxy — which is true of nothing here, and confusing when it fails.
    if ((plan.env[name] ?? '') !== '') problems.push(`${name} must be empty under scoped egress`);
  }

  return problems;
}

/**
 * The second boundary (§50).
 *
 * Everything checked here was already supposed to be impossible by
 * construction — the planner cannot emit a mount outside the workspace, and
 * `buildContainerPlan` hard-codes the security flags. That is exactly why the
 * check is worth having: the interesting failure is not "the validator caught a
 * plan someone wrote by hand", it is "the planner acquired a bug and the
 * validator refused to let the bug reach the daemon".
 */
export function validateContainerPlan(plan: ContainerPlan, opts: ValidatePlanOptions): PlanValidation {
  const problems: string[] = [];
  const workspaceRoot = toPosix(opts.workspaceRoot).replace(/\/+$/, '');
  const protectedExact = new Set((opts.protectedHostPaths ?? []).map((p) => toPosix(p).toLowerCase()));

  if (!plan.readOnlyRoot) problems.push('the container root filesystem is not read-only');
  if (!plan.capDropAll) problems.push('Linux capabilities are not dropped');
  if (!plan.noNewPrivileges) problems.push('no-new-privileges is not set');
  if (!plan.removeOnExit) problems.push('the container would not be removed on exit');
  problems.push(...validateNetworkPlan(plan));
  if (plan.name.trim() === '' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(plan.name)) {
    problems.push('the container name is empty or not a valid Docker name');
  }
  if (plan.argv.length === 0 || (plan.argv[0] ?? '').trim() === '') {
    problems.push('the plan has no executable');
  }
  if (plan.timeoutMs <= 0) problems.push('the plan has no positive timeout');

  if (opts.allowedImages.length > 0 && !opts.allowedImages.includes(plan.image.configured)) {
    problems.push(`image "${plan.image.configured}" is not one of the trusted images`);
  }

  if (plan.cwd !== CONTAINER_WORKSPACE && !plan.cwd.startsWith(`${CONTAINER_WORKSPACE}/`)) {
    problems.push(`the working directory "${plan.cwd}" is outside ${CONTAINER_WORKSPACE}`);
  }

  let baseMounts = 0;
  const seenDestinations = new Set<string>();

  for (const mount of plan.mounts) {
    const source = toPosix(mount.hostPath).replace(/\/+$/, '');
    const destination = mount.containerPath;

    if (mount.origin === 'workspace-base') {
      baseMounts += 1;
      if (source !== workspaceRoot) {
        problems.push(`the base mount source "${source}" is not the workspace root`);
      }
      if (mount.mode !== 'ro') {
        problems.push('the workspace base mount is read-write; it must be read-only');
      }
    }

    if (!destination.startsWith('/')) {
      problems.push(`mount destination "${destination}" is not absolute`);
    }
    if (FORBIDDEN_MOUNT_DESTINATIONS.includes(destination)) {
      problems.push(`mount destination "${destination}" would shadow a system directory`);
    }
    if (destination !== CONTAINER_WORKSPACE && !destination.startsWith(`${CONTAINER_WORKSPACE}/`)) {
      problems.push(`mount destination "${destination}" is outside ${CONTAINER_WORKSPACE}`);
    }
    if (destination.split('/').includes('..')) {
      problems.push(`mount destination "${destination}" contains a traversal segment`);
    }
    if (seenDestinations.has(destination)) {
      problems.push(`mount destination "${destination}" is mounted more than once`);
    }
    seenDestinations.add(destination);

    // The mask mounts are the one legitimate case for a source outside the
    // workspace: an empty kernel-owned file, mounted to hide a protected one.
    if (mount.origin === 'mask') continue;

    if (source !== workspaceRoot && !source.startsWith(`${workspaceRoot}/`)) {
      problems.push(`mount source "${source}" is outside the workspace`);
    }
    for (const pattern of FORBIDDEN_MOUNT_SOURCES) {
      if (pattern.test(source)) {
        problems.push(`mount source "${source}" matches a forbidden host location (${String(pattern)})`);
      }
    }
    if (protectedExact.has(source.toLowerCase())) {
      problems.push(`mount source "${source}" is a protected host path`);
    }
    if (opts.isProtectedHostPath?.(source)) {
      problems.push(`mount source "${source}" is protected by kernel policy`);
    }
    if (
      mount.mode === 'rw' &&
      (destination === `${CONTAINER_WORKSPACE}/.git` ||
        destination.startsWith(`${CONTAINER_WORKSPACE}/.git/`))
    ) {
      problems.push('the repository metadata directory is mounted read-write');
    }
  }

  if (baseMounts !== 1) {
    problems.push(`the plan has ${baseMounts} workspace base mount(s); exactly one is required`);
  }

  for (const t of plan.tmpfs) {
    if (!t.containerPath.startsWith('/')) problems.push(`tmpfs "${t.containerPath}" is not absolute`);
    if (t.sizeBytes <= 0) problems.push(`tmpfs "${t.containerPath}" has no size limit`);
  }

  // The environment is built by `scrubEnv`; this is the last chance to notice
  // that something credential-shaped survived into a plan.
  for (const [name, value] of Object.entries(plan.env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) === false) {
      problems.push(`environment name "${name}" is not a valid variable name`);
    }
    if (value.includes('\0')) problems.push(`environment value for "${name}" contains a NUL byte`);
  }
  const allowedPassthrough = new Set(opts.allowedEnvPassthrough ?? []);
  for (const name of plan.envPassthrough) {
    if (!allowedPassthrough.has(name)) {
      problems.push(`environment passthrough "${name}" was not granted for this execution`);
    }
  }

  return { ok: problems.length === 0, problems };
}

// --- docker argv -----------------------------------------------------------

/**
 * Turn the plan into a `docker run` argv.
 *
 * Kept separate from the plan so the flags can be asserted directly (§61) — both
 * the ones that must be present and the ones that must never appear. A test that
 * reads the argv is checking the thing that actually reaches the daemon, which a
 * test that reads the plan is not.
 */
export function dockerRunArgs(plan: ContainerPlan): string[] {
  const args: string[] = ['run', '--rm', '--name', plan.name];

  // The three modes become three different daemon-level facts, which is the
  // whole substance of alpha.6: `none` has no interfaces, `scoped` attaches to an
  // `--internal` network whose only dual-homed member is the kernel's proxy, and
  // `unrestricted` is the ordinary bridge the user explicitly approved.
  switch (plan.network.kind) {
    case 'none':
      args.push('--network', 'none');
      break;
    case 'unrestricted':
      args.push('--network', 'bridge');
      break;
    case 'scoped':
      args.push('--network', plan.network.dockerNetwork);
      for (const server of plan.network.dns) args.push('--dns', server);
      break;
  }
  if (plan.readOnlyRoot) args.push('--read-only');
  if (plan.capDropAll) args.push('--cap-drop=ALL');
  if (plan.noNewPrivileges) args.push('--security-opt=no-new-privileges');
  if (plan.user) args.push('--user', plan.user);

  if (plan.limits.pids !== undefined) args.push('--pids-limit', String(plan.limits.pids));
  if (plan.limits.memoryBytes !== undefined) args.push('--memory', String(plan.limits.memoryBytes));
  if (plan.limits.cpus !== undefined) args.push('--cpus', String(plan.limits.cpus));

  for (const t of plan.tmpfs) {
    const flags = ['rw', `size=${t.sizeBytes}`, `mode=${t.mode.toString(8).padStart(4, '0')}`];
    if (t.noexec) flags.push('noexec');
    args.push('--tmpfs', `${t.containerPath}:${flags.join(',')}`);
  }

  for (const mount of plan.mounts) {
    // `--mount` rather than `-v`: `-v` creates a missing source directory on the
    // host, which is a side effect the planner explicitly refuses to cause, and
    // its comma-free syntax makes a path containing `:` ambiguous.
    const type = 'type=bind';
    const parts = [type, `source=${mount.hostPath}`, `target=${mount.containerPath}`];
    if (mount.mode === 'ro') parts.push('readonly');
    args.push('--mount', parts.join(','));
  }

  args.push('--workdir', plan.cwd);

  for (const [name, value] of Object.entries(plan.env)) {
    args.push('--env', `${name}=${value}`);
  }
  // Value-less form: the daemon reads it from this client process (§25).
  for (const name of plan.envPassthrough) {
    args.push('--env', name);
  }

  args.push('--interactive');
  // Bypass the image's ENTRYPOINT so what runs is exactly the argv the kernel
  // planned, not the argv as reinterpreted by an image's wrapper script.
  args.push('--entrypoint', plan.argv[0]!);
  args.push(plan.image.configured);
  args.push(...plan.argv.slice(1));

  return args;
}

/**
 * A stable, safe container name.
 *
 * Deterministic in its inputs so a leaked container is findable by name, and
 * constrained to Docker's charset so a workspace path or a tool call id cannot
 * turn into a flag.
 */
export function containerName(prefix: string, id: string): string {
  const safe = `${prefix}-${id}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 60);
  return /^[A-Za-z0-9]/.test(safe) ? safe : `x${safe.slice(1)}`;
}

/**
 * Rewrite argv tokens that are absolute host paths inside the workspace.
 *
 * Almost every command the kernel issues is relative to `cwd` — `rg -e pat .`,
 * `git status --porcelain`, `node --test tests/x.test.ts` — so translating the
 * working directory covers the ordinary case. The exception is a tool or a model
 * that passes an absolute path, which is legitimate on every other backend and
 * would simply not exist inside the container.
 *
 * The mapping is deliberately narrow: exactly the workspace root and its
 * descendants, matched literally. A token naming a path *outside* the workspace
 * is left alone, so it fails inside the container by being absent — which is the
 * enforcement working, and is a far better outcome than a rewrite that quietly
 * pointed it at something that does exist.
 */
export function translateArgvPaths(
  argv: readonly string[],
  workspaceRoot: CanonicalPath,
): { argv: string[]; translated: number } {
  const root = toPosix(workspaceRoot).replace(/\/+$/, '');
  let translated = 0;
  const out = argv.map((token) => {
    if (token !== root && !token.startsWith(`${root}/`)) return token;
    const mapped = toContainerPath(root, toPosix(token));
    if (mapped === undefined) return token;
    translated += 1;
    return mapped;
  });
  return { argv: out, translated };
}
