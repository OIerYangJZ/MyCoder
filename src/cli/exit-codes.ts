/**
 * Process exit codes (ADR-0021, alpha.8 §15).
 *
 * The requirement in one sentence: a wrapper script must be able to tell "your
 * config is wrong" from "the model gave up" without parsing English.
 *
 * Before alpha.8 every failure exited `1` — a malformed config, a denied tool, a
 * model that ran out of steps and an unreachable Docker daemon were the same
 * observable event. The distinctions below cost nothing to emit and cannot be
 * recovered afterwards.
 *
 * The split that matters most is CONFIG from UNAVAILABLE: **CONFIG is the user's
 * file, UNAVAILABLE is the user's machine.** One is fixed by editing something,
 * the other by installing or starting something, so a script that retries is
 * right to retry UNAVAILABLE and wrong to retry CONFIG.
 *
 * The second is INCOMPLETE from DENIED: a model that gave up is not a boundary
 * that said no. Conflating them is how "the agent is unreliable" gets reported
 * for a session that was doing exactly what it was configured to do.
 *
 * Nothing here goes above 6. `>=128` is a signal death and `127` is the shell's
 * "command not found"; claiming either would make our failures indistinguishable
 * from the shell's.
 */

import type { ErrorCode } from '../util/errors.ts';

export const EXIT = {
  /** The run completed. For a turn: the model finished the task. */
  OK: 0,
  /** The model did not complete the task — gave up, hit a budget, cancelled. */
  INCOMPLETE: 1,
  /** The command line is wrong: unknown flag, missing value, conflicting flags. */
  USAGE: 2,
  /** The configuration is wrong: unparseable file, no provider, insecure credential. */
  CONFIG: 3,
  /** Policy denied something the run needed, and the run stopped because of it. */
  DENIED: 4,
  /** The environment cannot provide what was asked: runtime, backend, network. */
  UNAVAILABLE: 5,
  /** A defect in this kernel. Anything unmapped lands here, loudly. */
  INTERNAL: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_NAMES: Record<ExitCode, string> = {
  [EXIT.OK]: 'OK',
  [EXIT.INCOMPLETE]: 'INCOMPLETE',
  [EXIT.USAGE]: 'USAGE',
  [EXIT.CONFIG]: 'CONFIG',
  [EXIT.DENIED]: 'DENIED',
  [EXIT.UNAVAILABLE]: 'UNAVAILABLE',
  [EXIT.INTERNAL]: 'INTERNAL',
};

/**
 * Every error code's exit code, exhaustively.
 *
 * A `Record<ErrorCode, ExitCode>` rather than a `switch` with a default, and
 * rather than a derivation from `blame`, for two different reasons:
 *
 *   - exhaustive: adding an error code fails the typecheck until somebody
 *     decides what it means to a script. The same discipline `DEFAULT_BLAME`
 *     uses, and for the same reason — a new code that silently inherited a
 *     neighbour's exit status would be a contract change nobody reviewed.
 *
 *   - not derived from `blame`: the mapping is genuinely not a function of it.
 *     `TOOL_DENIED` and `CREDENTIAL_FILE_INSECURE` are both `blame: 'user'` and
 *     they are DENIED and CONFIG respectively, because one is a boundary
 *     answering and the other is a file to edit.
 */
const EXIT_FOR_ERROR: Record<ErrorCode, ExitCode> = {
  // --- the model's own outcomes ---------------------------------------------
  MODEL_CONTEXT_OVERFLOW: EXIT.INCOMPLETE,
  TOOL_NOT_FOUND: EXIT.INCOMPLETE,
  TOOL_INVALID_ARGS: EXIT.INCOMPLETE,
  TOOL_FAILED: EXIT.INCOMPLETE,
  STALE_FILE: EXIT.INCOMPLETE,
  INSUFFICIENT_READ_COVERAGE: EXIT.INCOMPLETE,
  NON_UNIQUE_MATCH: EXIT.INCOMPLETE,
  LOOP_BUDGET_EXCEEDED: EXIT.INCOMPLETE,
  REPEATED_FAILURE: EXIT.INCOMPLETE,
  DELEGATION_FAILED: EXIT.INCOMPLETE,
  CANCELLED: EXIT.INCOMPLETE,

  // --- the user's configuration ---------------------------------------------
  // A rejected credential is the user's file to fix, not their machine's state,
  // and not a boundary refusing a request.
  MODEL_AUTH_ERROR: EXIT.CONFIG,
  CREDENTIAL_FILE_INSECURE: EXIT.CONFIG,
  CONFIG_INVALID: EXIT.CONFIG,
  PROVIDER_NOT_CONFIGURED: EXIT.CONFIG,

  // --- a boundary said no ----------------------------------------------------
  TOOL_DENIED: EXIT.DENIED,
  SECRET_ACCESS_DENIED: EXIT.DENIED,
  SECRET_EGRESS_BLOCKED: EXIT.DENIED,
  NETWORK_DENIED: EXIT.DENIED,
  PATH_OUTSIDE_WORKSPACE: EXIT.DENIED,
  PROTECTED_PATH: EXIT.DENIED,
  UNDECLARED_WORKSPACE_MUTATION: EXIT.DENIED,
  NETWORK_SCOPE_DENIED: EXIT.DENIED,
  NETWORK_TARGET_ADDRESS_DENIED: EXIT.DENIED,
  NETWORK_PROTOCOL_UNSUPPORTED: EXIT.DENIED,
  NETWORK_IDENTITY_MISMATCH: EXIT.DENIED,
  SANDBOX_SYSCALL_DENIED: EXIT.DENIED,
  DELEGATION_DENIED: EXIT.DENIED,
  DELEGATION_DEPTH_EXCEEDED: EXIT.DENIED,

  // --- the machine cannot provide it -----------------------------------------
  RUNTIME_UNSUPPORTED: EXIT.UNAVAILABLE,
  MODEL_RATE_LIMIT: EXIT.UNAVAILABLE,
  MODEL_INVALID_RESPONSE: EXIT.UNAVAILABLE,
  MODEL_TIMEOUT: EXIT.UNAVAILABLE,
  TOOL_TIMEOUT: EXIT.UNAVAILABLE,
  CONCURRENT_MODIFICATION: EXIT.UNAVAILABLE,
  REMOTE_UNAVAILABLE: EXIT.UNAVAILABLE,
  REMOTE_HOST_KEY_ERROR: EXIT.UNAVAILABLE,
  CONTAINER_RUNTIME_NOT_FOUND: EXIT.UNAVAILABLE,
  CONTAINER_RUNTIME_UNAVAILABLE: EXIT.UNAVAILABLE,
  CONTAINER_IMAGE_NOT_FOUND: EXIT.UNAVAILABLE,
  CONTAINER_UNSUPPORTED_FEATURE: EXIT.UNAVAILABLE,
  CONTAINER_INVALID_MOUNT: EXIT.UNAVAILABLE,
  CONTAINER_START_FAILED: EXIT.UNAVAILABLE,
  CONTAINER_RESOURCE_LIMIT: EXIT.UNAVAILABLE,
  NETWORK_TARGET_RESOLUTION_FAILED: EXIT.UNAVAILABLE,
  NETWORK_PROXY_UNAVAILABLE: EXIT.UNAVAILABLE,
  NETWORK_ENFORCEMENT_SETUP_FAILED: EXIT.UNAVAILABLE,
  // A missing, stale or mismatched launcher lands here (ADR-0020): the remedy is
  // to build it, which is an action on the machine.
  SANDBOX_UNSUPPORTED: EXIT.UNAVAILABLE,
  SANDBOX_SETUP_FAILED: EXIT.UNAVAILABLE,

  // --- ours ------------------------------------------------------------------
  // Documented as always a kernel defect: no tool argument is supposed to be
  // able to produce an invalid plan.
  CONTAINER_PLAN_REJECTED: EXIT.INTERNAL,
  INTERNAL_ERROR: EXIT.INTERNAL,
};

/** The documented exit code for a kernel error. */
export function exitCodeForError(code: ErrorCode): ExitCode {
  return EXIT_FOR_ERROR[code] ?? EXIT.INTERNAL;
}

/**
 * The exit code for a finished turn.
 *
 * Separate from `exitCodeForError` because a turn can fail without an error —
 * the model simply stops — and because a turn that carried a *denial* should
 * report the denial rather than the generic incompleteness that followed it.
 */
export function exitCodeForTurn(state: string, errorCode?: ErrorCode): ExitCode {
  if (state === 'completed') return EXIT.OK;
  if (errorCode) return exitCodeForError(errorCode);
  return EXIT.INCOMPLETE;
}
