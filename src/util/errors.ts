/**
 * Structured kernel error model (spec §24).
 *
 * Every failure that can reach the model, the user, or the event log is one of
 * these. Free-form `throw new Error(...)` is reserved for genuine programmer
 * bugs, which are converted to INTERNAL_ERROR at the boundary.
 */

export const ERROR_CODES = [
  'MODEL_AUTH_ERROR',
  'MODEL_RATE_LIMIT',
  'MODEL_CONTEXT_OVERFLOW',
  'MODEL_INVALID_RESPONSE',
  'TOOL_NOT_FOUND',
  'TOOL_INVALID_ARGS',
  'TOOL_DENIED',
  'TOOL_TIMEOUT',
  'TOOL_FAILED',
  'STALE_FILE',
  'INSUFFICIENT_READ_COVERAGE',
  'NON_UNIQUE_MATCH',
  'CONCURRENT_MODIFICATION',
  'SECRET_ACCESS_DENIED',
  'SECRET_EGRESS_BLOCKED',
  'NETWORK_DENIED',
  'PATH_OUTSIDE_WORKSPACE',
  'PROTECTED_PATH',
  'UNDECLARED_WORKSPACE_MUTATION',
  'REMOTE_UNAVAILABLE',
  'REMOTE_HOST_KEY_ERROR',
  'LOOP_BUDGET_EXCEEDED',
  'REPEATED_FAILURE',
  'CANCELLED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type Blame = 'user' | 'model' | 'tool' | 'provider' | 'kernel' | 'environment';

export interface KernelError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  blame: Blame;
  /**
   * Details that are safe to show the model and to persist. Never put secret
   * values, raw environment, or the content that triggered a secret denial here.
   */
  safeDetails?: Record<string, unknown>;
}

export class KernelErrorException extends Error {
  readonly kernelError: KernelError;

  constructor(err: KernelError) {
    super(`${err.code}: ${err.message}`);
    this.name = 'KernelErrorException';
    this.kernelError = err;
  }
}

const DEFAULT_BLAME: Record<ErrorCode, Blame> = {
  MODEL_AUTH_ERROR: 'user',
  MODEL_RATE_LIMIT: 'provider',
  MODEL_CONTEXT_OVERFLOW: 'kernel',
  MODEL_INVALID_RESPONSE: 'provider',
  TOOL_NOT_FOUND: 'model',
  TOOL_INVALID_ARGS: 'model',
  TOOL_DENIED: 'user',
  TOOL_TIMEOUT: 'environment',
  TOOL_FAILED: 'tool',
  STALE_FILE: 'model',
  INSUFFICIENT_READ_COVERAGE: 'model',
  NON_UNIQUE_MATCH: 'model',
  CONCURRENT_MODIFICATION: 'environment',
  SECRET_ACCESS_DENIED: 'kernel',
  SECRET_EGRESS_BLOCKED: 'kernel',
  NETWORK_DENIED: 'kernel',
  PATH_OUTSIDE_WORKSPACE: 'model',
  PROTECTED_PATH: 'kernel',
  UNDECLARED_WORKSPACE_MUTATION: 'tool',
  REMOTE_UNAVAILABLE: 'environment',
  REMOTE_HOST_KEY_ERROR: 'environment',
  LOOP_BUDGET_EXCEEDED: 'kernel',
  REPEATED_FAILURE: 'model',
  CANCELLED: 'user',
  INTERNAL_ERROR: 'kernel',
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'MODEL_RATE_LIMIT',
  'MODEL_INVALID_RESPONSE',
  'TOOL_TIMEOUT',
  'CONCURRENT_MODIFICATION',
  'REMOTE_UNAVAILABLE',
]);

export function kernelError(
  code: ErrorCode,
  message: string,
  opts: { blame?: Blame; retryable?: boolean; safeDetails?: Record<string, unknown> } = {},
): KernelError {
  const err: KernelError = {
    code,
    message,
    retryable: opts.retryable ?? RETRYABLE.has(code),
    blame: opts.blame ?? DEFAULT_BLAME[code],
  };
  if (opts.safeDetails) err.safeDetails = opts.safeDetails;
  return err;
}

export function fail(
  code: ErrorCode,
  message: string,
  opts: { blame?: Blame; retryable?: boolean; safeDetails?: Record<string, unknown> } = {},
): never {
  throw new KernelErrorException(kernelError(code, message, opts));
}

export function isKernelErrorException(e: unknown): e is KernelErrorException {
  return e instanceof KernelErrorException;
}

/** Convert anything thrown into a KernelError without leaking stack internals. */
export function toKernelError(e: unknown): KernelError {
  if (isKernelErrorException(e)) return e.kernelError;
  if (e instanceof Error && e.name === 'AbortError') {
    return kernelError('CANCELLED', 'Operation was cancelled.');
  }
  const message = e instanceof Error ? e.message : String(e);
  return kernelError('INTERNAL_ERROR', message);
}

/**
 * Render an error for the model. Deliberately omits `safeDetails` keys that are
 * marked private and never includes the offending content of a secret denial.
 */
export function renderErrorForModel(err: KernelError): string {
  const lines = [`error: ${err.code}`, err.message];
  if (err.safeDetails) {
    for (const [k, v] of Object.entries(err.safeDetails)) {
      lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}
