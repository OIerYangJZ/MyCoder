/**
 * Execution diagnosis (alpha.7 Closure C, §46–§54).
 *
 * The recurring UX failure across alpha.5 and alpha.6 was not wrong errors — it
 * was errors that are *technically true and operationally misleading*:
 *
 *     `npm install` into a read-only workspace   → EROFS, which reads like a disk fault
 *     a missing executable in a container        → OCI transport text
 *     a strict-address egress denial             → an opaque TLS error
 *
 * In each case the user is told the last thing that went wrong instead of the
 * first thing that blocked them. This module names the first blocking capability.
 *
 * Two rules shape everything here:
 *
 *   **Diagnosis explains; it never authorises (§47, §53).** Nothing in this file
 *   grants a capability, switches a backend, widens a network mode or retries.
 *   The output is a sentence and, at most, the *name* of a capability the user
 *   could choose to grant. Wiring it to anything that acts would turn the one
 *   component that reads error text into a component that can change policy.
 *
 *   **`unknown` beats a confident misdiagnosis (§49).** Structured inputs —
 *   kernel error codes, errno, launcher exit codes, proxy reason codes — are
 *   authoritative. Matching words in stderr is not, and anything resting on it
 *   comes back `medium` confidence at best.
 */

import type { ErrorCode, KernelError } from '../util/errors.ts';
import type { EnforcementDescriptor } from './enforcement.ts';

export type DiagnosisCategory =
  | 'executable_missing'
  | 'workspace_write_blocked'
  | 'network_scope_denied'
  | 'sandbox_syscall_denied'
  | 'sandbox_unavailable'
  | 'resource_limit'
  | 'runtime_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export interface ExecutionDiagnosis {
  category: DiagnosisCategory;
  /** `high` only when a structured input decided it (§49). */
  confidence: 'high' | 'medium';
  /** One sentence, safe to show a user and to send to the model. */
  message: string;
  /**
   * The capability that would unblock this, *named* — never granted (§53).
   *
   * A string like `file.write` or `network.connect`, so a UI can offer the right
   * next question rather than a generic "try again".
   */
  suggestedCapability?: string;
  blame: KernelError['blame'];
  retryable: boolean;
  /** Structured facts, kept separate from the prose (§48). */
  details?: Record<string, unknown>;
}

export interface DiagnosisInput {
  /** The structured error, when there was one. */
  error?: KernelError;
  /** Process outcome, when the command ran at all. */
  result?: {
    exitCode: number | null;
    stderr: string;
    timedOut: boolean;
    signal?: string | null;
  };
  /** What the execution was actually granted. */
  granted?: {
    writeRoots: readonly string[];
    network: 'deny' | 'scoped' | 'unrestricted';
    allowExec: boolean;
  };
  backend?: EnforcementDescriptor & { kind?: string };
}

/**
 * Error codes that decide a category on their own.
 *
 * Everything in this table is produced by *our* code at the point the decision
 * was made, which is what makes it authoritative: `NETWORK_TARGET_ADDRESS_DENIED`
 * is not a guess about a TLS failure, it is the proxy saying which rule it
 * applied.
 */
const BY_ERROR_CODE: Partial<Record<ErrorCode, { category: DiagnosisCategory; capability?: string }>> = {
  PATH_OUTSIDE_WORKSPACE: { category: 'workspace_write_blocked', capability: 'file.write' },
  PROTECTED_PATH: { category: 'workspace_write_blocked', capability: 'file.write' },
  NETWORK_DENIED: { category: 'network_scope_denied', capability: 'network.connect' },
  NETWORK_SCOPE_DENIED: { category: 'network_scope_denied', capability: 'network.connect' },
  NETWORK_TARGET_ADDRESS_DENIED: { category: 'network_scope_denied', capability: 'network.connect' },
  NETWORK_TARGET_RESOLUTION_FAILED: { category: 'network_scope_denied' },
  NETWORK_PROTOCOL_UNSUPPORTED: { category: 'network_scope_denied' },
  NETWORK_IDENTITY_MISMATCH: { category: 'network_scope_denied' },
  NETWORK_PROXY_UNAVAILABLE: { category: 'runtime_unavailable' },
  NETWORK_ENFORCEMENT_SETUP_FAILED: { category: 'runtime_unavailable' },
  SANDBOX_UNSUPPORTED: { category: 'sandbox_unavailable' },
  SANDBOX_SETUP_FAILED: { category: 'sandbox_unavailable' },
  SANDBOX_SYSCALL_DENIED: { category: 'sandbox_syscall_denied' },
  TOOL_TIMEOUT: { category: 'timeout' },
  CANCELLED: { category: 'cancelled' },
  REMOTE_UNAVAILABLE: { category: 'runtime_unavailable' },
};

/** Human sentences, kept next to each other so the vocabulary stays consistent. */
const MESSAGES: Record<DiagnosisCategory, string> = {
  executable_missing: 'The command was not found on this backend.',
  workspace_write_blocked: 'This operation needs to write somewhere the execution was not granted.',
  network_scope_denied: 'The network destination was refused by the egress policy in force.',
  sandbox_syscall_denied: 'The sandbox refused a system call the command attempted.',
  sandbox_unavailable: 'The requested sandbox could not be provided on this machine.',
  resource_limit: 'The command hit a resource limit.',
  runtime_unavailable: 'The execution environment itself was unavailable.',
  timeout: 'The command did not finish within its time budget.',
  cancelled: 'The execution was cancelled.',
  unknown: 'The command failed, and there is not enough structured evidence to say why.',
};

/**
 * Diagnose one failed execution.
 *
 * Order matters and encodes §50: when several things are wrong, the *first
 * blocker* is what gets named. A read-only workspace with a working network must
 * be diagnosed as a write problem, not as a network one, because granting
 * network would change nothing and the user would be sent down the wrong path.
 */
export function diagnose(input: DiagnosisInput): ExecutionDiagnosis {
  // 1. A structured error we produced ourselves — always authoritative.
  if (input.error) {
    const mapped = BY_ERROR_CODE[input.error.code];
    if (mapped) {
      return {
        category: mapped.category,
        confidence: 'high',
        message: input.error.message || MESSAGES[mapped.category],
        ...(mapped.capability ? { suggestedCapability: mapped.capability } : {}),
        blame: input.error.blame,
        retryable: input.error.retryable,
        ...(input.error.safeDetails ? { details: input.error.safeDetails } : {}),
      };
    }
    if (input.error.code === 'TOOL_FAILED' && /not found|ENOENT/i.test(input.error.message)) {
      // §51: one semantic answer across Local, Container and Linux Native. The
      // backend's own words differ wildly and belong in details, not in the
      // sentence the user reads.
      return {
        category: 'executable_missing',
        confidence: 'high',
        message: MESSAGES.executable_missing,
        suggestedCapability: 'process.exec',
        blame: 'model',
        retryable: false,
        ...(input.error.safeDetails ? { details: input.error.safeDetails } : {}),
      };
    }
  }

  const result = input.result;
  if (result?.timedOut) {
    return {
      category: 'timeout',
      confidence: 'high',
      message: MESSAGES.timeout,
      blame: 'model',
      retryable: true,
    };
  }

  // 2. Process outcomes with a structured meaning.
  if (result) {
    // 127 is the shell's own "command not found", and 126 is "found, not
    // executable" — both are conventions, not guesses about wording.
    if (result.exitCode === 127) {
      return {
        category: 'executable_missing',
        confidence: 'high',
        message: MESSAGES.executable_missing,
        suggestedCapability: 'process.exec',
        blame: 'model',
        retryable: false,
      };
    }
    if (result.signal === 'SIGKILL' || result.exitCode === 137) {
      return {
        category: 'resource_limit',
        confidence: 'medium',
        message: `${MESSAGES.resource_limit} It was killed rather than exiting on its own.`,
        blame: 'environment',
        retryable: false,
      };
    }

    // 3. errno-shaped stderr. Structured enough to act on, weak enough that §49
    //    caps the confidence at medium — the text still came from a program we
    //    do not control.
    const stderr = result.stderr;
    if (/EACCES|EROFS|Permission denied|Read-only file system/i.test(stderr)) {
      // §50: with a write-capable grant this is probably not a permission
      // problem at all, so the two cases get different sentences.
      const wroteNowhere = (input.granted?.writeRoots.length ?? 0) === 0;
      return {
        category: 'workspace_write_blocked',
        confidence: 'medium',
        message: wroteNowhere
          ? 'This execution was granted no writable path, and the command tried to write.'
          : MESSAGES.workspace_write_blocked,
        suggestedCapability: 'file.write',
        blame: 'user',
        retryable: false,
        details: { grantedWriteRoots: input.granted?.writeRoots.length ?? 0 },
      };
    }
    if (
      input.granted?.network === 'deny' &&
      /getaddrinfo|ENOTFOUND|ECONNREFUSED|network is unreachable|Could not resolve host/i.test(stderr)
    ) {
      // Naming the *grant* rather than the socket error: the command did not
      // fail because DNS is broken, it failed because this execution has no
      // network and DNS is the first thing that notices.
      return {
        category: 'network_scope_denied',
        confidence: 'medium',
        message: 'This execution was granted no network, and the command tried to reach one.',
        suggestedCapability: 'network.connect',
        blame: 'user',
        retryable: false,
      };
    }
  }

  return {
    category: 'unknown',
    confidence: 'medium',
    message: MESSAGES.unknown,
    blame: input.error?.blame ?? 'model',
    retryable: input.error?.retryable ?? false,
  };
}

/**
 * Render a diagnosis for a human or a model.
 *
 * The capability is named, and the sentence is phrased as something the *user*
 * may decide — never as an action the kernel is about to take (§53).
 */
export function renderDiagnosis(d: ExecutionDiagnosis): string {
  const lines = [d.message];
  if (d.suggestedCapability) {
    lines.push(
      `This would need the "${d.suggestedCapability}" capability. Nothing has been granted or retried; ` +
        'ask the user if you believe it should be.',
    );
  }
  if (d.confidence === 'medium') {
    lines.push('(Inferred from the command output rather than from a policy decision.)');
  }
  return lines.join('\n');
}
