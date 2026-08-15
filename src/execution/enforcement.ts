/**
 * Enforcement levels (alpha.5 §7, ADR-0014).
 *
 * Through alpha.4 the whole security posture of a backend was one field with two
 * values: `policy-enforced` or `os-isolated`. That was honest while there was
 * only one answer to give — every backend was `policy-enforced` — and it stops
 * being honest the moment a container is involved, because a container does not
 * move one dial. It makes the process's *filesystem view* a kernel-enforced
 * fact, leaves the *trusted file broker* exactly as policy-enforced as it was,
 * enforces network denial absolutely while enforcing a host allowlist not at
 * all, and its strength against the host boundary depends on whether Docker is
 * a native engine or a virtual machine.
 *
 * Collapsing those into one word can only be done by rounding, and rounding up
 * is the failure invariant 5 exists to prevent: `/status`, the model's system
 * prompt and the audit log must never say "enforced" for something that is a
 * string comparison. So each dimension is reported separately, and the summary
 * label is *derived* from the weakest relevant dimension rather than asserted.
 */

/**
 * How a restriction is actually imposed, weakest first.
 *
 * The ordering is meaningful — `weakest()` and `atLeast()` compare on it — and
 * the two strongest values are deliberately distinct:
 *
 *   `container-enforced`  the container runtime imposes it. The subprocess
 *                         cannot reach what is not in its namespace, but the
 *                         boundary is the container runtime's, and on a
 *                         Docker Desktop VM there is a hypervisor and a file
 *                         sharing layer between it and the host.
 *   `os-enforced`         the host kernel imposes it directly, with no
 *                         intervening runtime to trust.
 *
 * Nothing in alpha.5 returns `os-enforced`; it exists so that a future
 * namespace/seccomp backend has somewhere honest to sit, and so that
 * `container-enforced` is not silently the ceiling of the vocabulary.
 */
export type EnforcementLevel =
  'none' | 'best-effort' | 'policy-enforced' | 'container-enforced' | 'os-enforced';

const ORDER: readonly EnforcementLevel[] = [
  'none',
  'best-effort',
  'policy-enforced',
  'container-enforced',
  'os-enforced',
];

export function enforcementRank(level: EnforcementLevel): number {
  return ORDER.indexOf(level);
}

/** The weaker of two levels. Used to derive summaries, never to upgrade one. */
export function weakest(a: EnforcementLevel, b: EnforcementLevel): EnforcementLevel {
  return enforcementRank(a) <= enforcementRank(b) ? a : b;
}

export function atLeast(level: EnforcementLevel, floor: EnforcementLevel): boolean {
  return enforcementRank(level) >= enforcementRank(floor);
}

/**
 * What a backend enforces, dimension by dimension.
 *
 * Every field answers a different question, and a reader who only wants one of
 * them must not have to infer it from the others:
 *
 *   processFilesystem    what an arbitrary subprocess can open.
 *   processNetwork       whether that subprocess can reach the network *at all*.
 *   processPrivileges    uid, capabilities, privilege escalation.
 *   environmentIsolation what variables that subprocess inherits.
 *   hostFileBroker       the *kernel's own* Read/Edit/Grep path (§28). This is
 *                        policy-enforced on every backend in v0.1, container or
 *                        not, because those operations are performed by trusted
 *                        kernel code against the host filesystem rather than by
 *                        the untrusted process.
 *   networkAllowlist     whether `network = { hosts: [...] }` is imposed on the
 *                        process. Split from `processNetwork` because §23 makes
 *                        the distinction release-critical: `--network none` is a
 *                        real boundary, while an ordinary bridge network does
 *                        nothing whatsoever to confine *which* hosts are
 *                        reachable.
 */
export interface EnforcementDescriptor {
  processFilesystem: EnforcementLevel;
  processNetwork: EnforcementLevel;
  processPrivileges: EnforcementLevel;
  environmentIsolation: EnforcementLevel;
  hostFileBroker: EnforcementLevel;
  networkAllowlist: EnforcementLevel;
  /** Platform caveats, shown verbatim in `/status`. Never a substitute for a level. */
  platformNotes?: readonly string[];
}

/**
 * The one-word summary, kept only because the event log and `/status` have
 * always had one.
 *
 * `container-enforced` is a third value rather than a reuse of `os-isolated`:
 * a reader of an alpha.4 log who sees `os-isolated` should keep believing what
 * that meant, and a reader of an alpha.5 log should be able to tell that the
 * boundary was a container runtime.
 */
export type SandboxStrength = 'policy-enforced' | 'container-enforced' | 'os-isolated';

/**
 * Derive the summary rather than asserting it.
 *
 * The rule is the weakest of the two dimensions that describe *arbitrary code*:
 * a backend whose filesystem view is container-enforced but whose network is
 * only policy-enforced has not contained a process, and must not be summarised
 * as though it had.
 */
export function summarizeEnforcement(d: EnforcementDescriptor): SandboxStrength {
  const process = weakest(d.processFilesystem, d.processNetwork);
  if (atLeast(process, 'os-enforced')) return 'os-isolated';
  if (atLeast(process, 'container-enforced')) return 'container-enforced';
  return 'policy-enforced';
}

/** The local backend: policy all the way down, and it says so (spec §12.2). */
export function localEnforcement(): EnforcementDescriptor {
  return {
    processFilesystem: 'policy-enforced',
    processNetwork: 'best-effort',
    processPrivileges: 'none',
    environmentIsolation: 'policy-enforced',
    hostFileBroker: 'policy-enforced',
    networkAllowlist: 'best-effort',
    platformNotes: [
      'Subprocesses run as your user with your process rights; nothing but kernel policy stops one from opening a file it was not granted.',
    ],
  };
}

/**
 * The SSH backend.
 *
 * Stronger than local in one specific respect and not in the others: the
 * *host's* files are genuinely unreachable, because the process runs on another
 * machine — but that is a property of the remote being a different computer, and
 * the remote workspace jail itself is still policy.
 */
export function sshEnforcement(host: string): EnforcementDescriptor {
  return {
    processFilesystem: 'policy-enforced',
    processNetwork: 'best-effort',
    processPrivileges: 'none',
    environmentIsolation: 'policy-enforced',
    hostFileBroker: 'policy-enforced',
    networkAllowlist: 'best-effort',
    platformNotes: [
      `Commands run on ${host}, so this machine's files are out of reach — but on the remote the workspace jail is policy, not an OS boundary.`,
      'No agent forwarding and no environment forwarding, enforced on the ssh command line.',
    ],
  };
}

/**
 * How the container backend's network grant is being imposed *right now*.
 *
 * alpha.5 had a boolean here, and a boolean was enough while there were only two
 * outcomes worth distinguishing. alpha.6 has three, and the middle one is the
 * whole milestone: an approved host list is now imposed by a topology rather
 * than recorded in a policy note.
 */
export type ContainerNetworkPosture = 'deny-all' | 'scoped-egress' | 'unrestricted';

export interface ContainerEnforcementInput {
  /** True when `--network none` is in force for this session's default. */
  networkDenied: boolean;
  /**
   * The posture this descriptor should describe. Defaults to deriving it from
   * `networkDenied`, so every existing caller keeps its alpha.5 meaning.
   */
  networkPosture?: ContainerNetworkPosture;
  /** Approved hosts, for the `/status` line. Only meaningful under scoped egress. */
  allowedHosts?: readonly string[];
  /** True when the plan drops capabilities and sets no-new-privileges. */
  privilegesRestricted: boolean;
  /** True when the container's rootfs is read-only. */
  readOnlyRoot: boolean;
  /** Docker Desktop / Linux engine, and whatever else is worth saying. */
  platformNotes: readonly string[];
}

/**
 * The container backend.
 *
 * `processFilesystem` is `container-enforced` unconditionally, because the mount
 * namespace is what it is whether or not the rootfs is read-only: a path that is
 * not mounted is not reachable. `readOnlyRoot` and `privilegesRestricted` move
 * `processPrivileges`, which is the dimension they actually describe.
 *
 * `networkAllowlist` was `best-effort` in alpha.5, and that was not a
 * placeholder — without an egress proxy in the container's network namespace,
 * `hosts = ["registry.npmjs.org"]` was a note in a policy record rather than a
 * rule anything imposed. alpha.6 (ADR-0015) builds that topology, so the level
 * moves to `container-enforced` — but only for the posture that actually has it:
 *
 *   deny-all      the allowlist question does not arise; there is no network.
 *   scoped-egress the workload has no route except a kernel-owned proxy whose
 *                 policy is frozen from the capability decision. Enforced.
 *   unrestricted  the user explicitly approved broad egress. There is no
 *                 allowlist to enforce, and saying `best-effort` would imply one
 *                 exists, so this is `none`.
 *
 * The level is never asserted by a caller; it is derived here from the posture,
 * which is derived from the mode the plan actually ran with.
 */
export function containerEnforcement(input: ContainerEnforcementInput): EnforcementDescriptor {
  const posture: ContainerNetworkPosture =
    input.networkPosture ?? (input.networkDenied ? 'deny-all' : 'unrestricted');
  return {
    processFilesystem: 'container-enforced',
    // Scoped egress is still a container-enforced network boundary: the workload
    // is in a namespace attached to an `--internal` network, so "which packets
    // can leave" is a runtime fact either way.
    processNetwork: posture === 'deny-all' || posture === 'scoped-egress' ? 'container-enforced' : 'none',
    processPrivileges:
      input.privilegesRestricted && input.readOnlyRoot
        ? 'container-enforced'
        : input.privilegesRestricted
          ? 'best-effort'
          : 'none',
    environmentIsolation: 'container-enforced',
    // Unchanged by containerisation, and deliberately so (§28, §30): Read, Edit
    // and the freshness ledger are trusted kernel operations on the host
    // filesystem. Reporting them as container-enforced would be the exact
    // overclaim §7's invariant forbids.
    hostFileBroker: 'policy-enforced',
    // The dimension's question is "is `network = { hosts: [...] }` imposed on the
    // process?", and on this backend the answer is now yes *whenever there is a
    // host list*, whatever the current execution happens to be doing. Reporting
    // it per-posture would make `/status` say "not enforced" during a deny-all
    // session — true of that moment and false of the backend, and a user reading
    // `/status` is asking about the backend.
    //
    // Deliberately not conditional on `scopedEgress`: there is no configuration
    // that turns the proxy off. A container backend that could not build the
    // topology fails the execution (§39) rather than running without it, so
    // there is no state in which this claim is made and not honoured.
    networkAllowlist: 'container-enforced',
    platformNotes: [
      ...input.platformNotes,
      posture === 'scoped-egress'
        ? 'Scoped egress is in force: the container has no route to the internet. Its only external path is a ' +
          `kernel-owned proxy that permits HTTP/HTTPS to ${describeHosts(input.allowedHosts ?? [])} and nothing ` +
          'else — checked by destination host, resolved address, HTTP authority and TLS SNI.'
        : posture === 'unrestricted'
          ? 'Unrestricted network: this session explicitly approved broad egress, so no host allowlist is in force.'
          : 'When a command is granted specific hosts, it runs on a private network whose only exit is a ' +
            'kernel-owned proxy enforcing that host set over HTTP and HTTPS. Ports other than 80 and 443, and ' +
            'protocols other than HTTP/HTTPS, are denied rather than tunnelled.',
      // The limit, stated wherever the guarantee is stated (§42). Destination
      // enforcement says where bytes may go; it does not inspect what bytes an
      // approved destination receives.
      'Scoped egress governs destinations, not payloads: a host the user approved can still be sent anything.',
    ],
  };
}

function describeHosts(hosts: readonly string[]): string {
  if (hosts.length === 0) return 'no hosts';
  if (hosts.length <= 3) return hosts.join(', ');
  return `${hosts.slice(0, 3).join(', ')} and ${hosts.length - 3} more`;
}

export interface EnforcementSummary {
  label: SandboxStrength;
  /** One line per dimension, in a fixed order, for `/status`. */
  lines: string[];
  /** The caveat sentence the model and the CLI both see. */
  caveat: string;
}

const DIMENSION_LABELS: ReadonlyArray<[keyof EnforcementDescriptor, string]> = [
  ['processFilesystem', 'process filesystem'],
  ['processNetwork', 'process network (default deny)'],
  ['networkAllowlist', 'process network (host allowlist)'],
  ['processPrivileges', 'process privileges'],
  ['environmentIsolation', 'environment isolation'],
  ['hostFileBroker', 'trusted file broker'],
];

/**
 * Render a descriptor for humans.
 *
 * The caveat is assembled from the levels rather than written per backend, so a
 * backend cannot acquire a reassuring sentence without acquiring the enforcement
 * that justifies it.
 */
export function describeEnforcement(d: EnforcementDescriptor): EnforcementSummary {
  const label = summarizeEnforcement(d);
  const lines = DIMENSION_LABELS.map(([key, name]) => `${name}: ${d[key] as EnforcementLevel}`);

  const parts: string[] = [];
  if (atLeast(d.processFilesystem, 'container-enforced')) {
    parts.push(
      'Commands run inside a container that can only see the paths mounted into it: host home, credential ' +
        'directories and container sockets are absent rather than merely denied.',
    );
  } else {
    parts.push(
      'Kernel policy governs what tools may request, and all tool output is redacted, but subprocesses are ' +
        'not OS-isolated: a process that runs can still reach the filesystem with your user rights.',
    );
  }
  if (atLeast(d.processNetwork, 'container-enforced')) {
    parts.push('Network access is removed at the container network namespace, not merely refused by policy.');
  } else if (d.processNetwork === 'none') {
    parts.push(
      'Network is available to commands in this session; only the declared hosts are policy-checked.',
    );
  } else {
    parts.push('Network denial for subprocesses is best-effort: policy declines to help, the OS does not.');
  }
  if (atLeast(d.networkAllowlist, 'container-enforced')) {
    // The sentence alpha.5 could not write. It is emitted only when the
    // descriptor says the mechanism is there, so it cannot be acquired by
    // wording.
    parts.push(
      'The approved host list is enforced: the process reaches the network only through a proxy that ' +
        'checks the destination host, the resolved address, the HTTP authority and the TLS server name.',
    );
  } else if (d.networkAllowlist === 'none') {
    parts.push('No host allowlist is in force for subprocesses in this session.');
  } else {
    parts.push(
      'A host allowlist is not enforced on subprocesses: enabling network is broader than the hostnames named.',
    );
  }
  if (d.hostFileBroker === 'policy-enforced' && atLeast(d.processFilesystem, 'container-enforced')) {
    parts.push(
      'Read/Edit/Grep are trusted kernel operations on the host filesystem and remain policy-enforced.',
    );
  }
  for (const note of d.platformNotes ?? []) parts.push(note);

  return { label, lines, caveat: parts.join(' ') };
}

/**
 * What `/status` and the system prompt may say about "network is off".
 *
 * Three values rather than two, because the container case is a fact and the
 * local case is a hope, and alpha.4's two-valued version had to call them the
 * same thing. `unenforced` is the third: a session that has network *enabled*
 * has no subprocess-level network boundary at all, which is neither "enforced"
 * nor the local backend's "best-effort".
 */
export function networkEnforcementLabel(d: EnforcementDescriptor): 'enforced' | 'best-effort' | 'unenforced' {
  if (atLeast(d.processNetwork, 'container-enforced')) return 'enforced';
  if (d.processNetwork === 'none') return 'unenforced';
  return 'best-effort';
}
