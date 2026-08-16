/**
 * ExecutionBackend (spec §12.1).
 *
 * The agent loop must not be able to tell local from ssh from container
 * (invariant: §12.1). Everything a tool can do to the outside world goes through
 * this interface, and a tool only ever receives a `CapabilityExecutor` — a
 * backend already narrowed to what the policy engine granted for this call.
 *
 * `enforce(profile)` is the seam where a real OS sandbox will slot in. Today the
 * local backend enforces in-process, which is honest `policy-enforced` strength;
 * `sandboxStrength` exists so the UI can say so rather than implying isolation
 * we do not have (invariant 5).
 */

import type { CanonicalPath } from '../util/paths.ts';
import type { SecretLease } from '../security/secret-broker.ts';
import type { ProfileNetwork } from '../security/egress/network-mode.ts';
import type { EnforcementDescriptor, SandboxStrength } from './enforcement.ts';

export type BackendKind = 'local' | 'ssh' | 'container';

export type { EnforcementDescriptor, SandboxStrength };
export type { ProfileNetwork };

export interface FileStat {
  path: CanonicalPath;
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  /** True when the *link itself* is a symlink, before resolution. */
  isSymlink: boolean;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface WriteOptions {
  /** Preserve the file's existing mode when replacing it. */
  mode?: number;
  /** Create parent directories. */
  createParents?: boolean;
}

export interface RemoveOptions {
  /**
   * Remove an empty directory rather than a file.
   *
   * Explicit because the two are different syscalls and guessing from a `stat`
   * inside the backend would make "the path became a directory between the check
   * and the call" a silent success. Recursive removal is deliberately absent
   * (ADR-0016).
   */
  directory?: boolean;
}

export interface FileSystemBackend {
  readFile(path: CanonicalPath): Promise<Buffer>;
  /** Temp file + fsync + rename. Never a partial file on failure (spec §10.2). */
  writeFileAtomic(path: CanonicalPath, data: Buffer, opts?: WriteOptions): Promise<void>;
  stat(path: CanonicalPath): Promise<FileStat | undefined>;
  listDir(path: CanonicalPath): Promise<DirEntry[]>;
  mkdirp(path: CanonicalPath): Promise<void>;
  /** Resolve symlinks. Returns undefined when the path does not exist. */
  realpath(path: CanonicalPath): Promise<CanonicalPath | undefined>;
  /** Unlink a file, or rmdir an empty directory (ADR-0016). */
  remove(path: CanonicalPath, opts?: RemoveOptions): Promise<void>;
  /**
   * Rename within the same filesystem, refusing to clobber `to`.
   *
   * POSIX `rename(2)` replaces the destination silently, which is the one
   * behaviour a move tool must not have: it would turn a typo into data loss
   * with no diff and no prompt. Backends must fail with `TOOL_FAILED` instead.
   */
  rename(from: CanonicalPath, to: CanonicalPath): Promise<void>;
}

export interface ProcessSpec {
  /**
   * Argv only. A raw shell string is never accepted as the sole protocol
   * (spec §9.2); the CLI parses user input into argv before it reaches here.
   */
  argv: readonly string[];
  cwd: CanonicalPath;
  /** Already scrubbed. Backends must not merge in the host environment. */
  env: Record<string, string>;
  timeoutMs: number;
  stdin?: string;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** True when output was cut off at `maxOutputBytes`. */
  outputTruncated: boolean;
}

export interface ProcessBackend {
  exec(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessResult>;
}

export interface EnvironmentDescriptor {
  platform: string;
  kind: BackendKind;
  workspaceRoot: CanonicalPath;
  /**
   * A stable identifier for the machine this backend executes on.
   *
   * Recorded in session metadata so `checkResumeIdentity` can notice that a
   * resumed remote session is pointing at a *different host* than the one it
   * started on — the same alias re-provisioned, a DNS change, a moved container.
   * Absent for the local backend, where `workspaceRoot` already implies the
   * machine.
   *
   * It is a hash of hostname, `uname -sm` and the machine-id where one exists.
   * That detects a replaced machine; it does **not** authenticate one — OpenSSH's
   * `StrictHostKeyChecking` is what does that, before this value is ever read.
   */
  hostIdentity?: string;
  homeDir: string;
  tmpDir: string;
  /** Discovered once; Grep falls back to a built-in scanner when absent. */
  hasRipgrep: boolean;
  hasGit: boolean;
  /**
   * One-word summary, **derived** from `enforcement` (alpha.5 §7).
   *
   * Kept because the event log and `/status` have always carried it, and never
   * asserted independently: `summarizeEnforcement()` computes it from the weakest
   * process-facing dimension, so a backend cannot claim a label its enforcement
   * does not support.
   */
  sandboxStrength: SandboxStrength;
  /**
   * What this backend enforces, dimension by dimension.
   *
   * A container moves the process's filesystem view to a kernel boundary while
   * leaving the trusted file broker exactly as policy-enforced as before, and
   * enforces network *denial* absolutely while enforcing a host *allowlist* not at
   * all. One field cannot say that; six can. See `./enforcement.ts`.
   */
  enforcement: EnforcementDescriptor;
  /** Free-form label shown in `/status`, e.g. "local (policy-enforced)". */
  description: string;
}

/**
 * The capability set granted for one tool execution.
 *
 * Derived from policy decisions by the sandbox planner. It is deliberately
 * concrete — roots, not booleans — so the executor can re-check every path.
 */
export interface CapabilityProfile {
  readRoots: readonly CanonicalPath[];
  writeRoots: readonly CanonicalPath[];
  allowExec: boolean;
  /**
   * The process's network grant (alpha.6 §9, ADR-0015).
   *
   * Three states, not two. `false` is deny-all, `{ hosts }` is an exact-host
   * allowlist that the container backend enforces through an egress proxy, and
   * `{ unrestricted: true }` is explicitly approved broad egress. `{ hosts: [] }`
   * is none of them and is refused by `normalizeNetworkMode` rather than being
   * read as either extreme.
   */
  network: ProfileNetwork;
  /** Extra environment names permitted beyond the default allowlist. */
  envAllow: readonly string[];
  /** Credentials to inject, as `{ envName, lease }`. */
  secretInjections: ReadonlyArray<{ envName: string; lease: SecretLease }>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export function emptyCapabilityProfile(timeoutMs = 30_000): CapabilityProfile {
  return {
    readRoots: [],
    writeRoots: [],
    allowExec: false,
    network: false,
    envAllow: [],
    secretInjections: [],
    timeoutMs,
    maxOutputBytes: 8 * 1024 * 1024,
  };
}

/**
 * A backend narrowed to one capability profile.
 *
 * This is the only object a tool's `execute()` receives. It cannot widen itself:
 * there is no accessor for the unconstrained backend.
 */
export interface CapabilityExecutor {
  readonly profile: CapabilityProfile;
  readonly environment: EnvironmentDescriptor;
  readonly fs: FileSystemBackend;
  exec(
    spec: Omit<ProcessSpec, 'env'> & { env?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<ProcessResult>;
  /** Release any leases handed to this executor. Called after every tool call. */
  dispose(): void;
}

export interface ExecutionBackend {
  readonly id: string;
  readonly kind: BackendKind;
  readonly fs: FileSystemBackend;
  readonly process: ProcessBackend;
  readonly environment: EnvironmentDescriptor;
  enforce(profile: CapabilityProfile): Promise<CapabilityExecutor>;
  /** Verify the backend is reachable and the workspace is present. */
  probe(): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}
