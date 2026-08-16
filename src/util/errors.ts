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
  'MODEL_TIMEOUT',
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
  'CREDENTIAL_FILE_INSECURE',
  'NETWORK_DENIED',
  'PATH_OUTSIDE_WORKSPACE',
  'PROTECTED_PATH',
  'UNDECLARED_WORKSPACE_MUTATION',
  'REMOTE_UNAVAILABLE',
  'REMOTE_HOST_KEY_ERROR',
  // Container runtime failures (alpha.5 §10, §62). Distinct codes rather than one
  // `CONTAINER_FAILED`, because the recoveries differ and a session that cannot
  // tell them apart cannot tell the user what to do: install docker, start the
  // daemon, pull an image, or stop asking for a flag this runtime lacks. They are
  // never collapsed into TOOL_FAILED, and never into a silent local fallback.
  'CONTAINER_RUNTIME_NOT_FOUND',
  'CONTAINER_RUNTIME_UNAVAILABLE',
  'CONTAINER_IMAGE_NOT_FOUND',
  'CONTAINER_UNSUPPORTED_FEATURE',
  'CONTAINER_INVALID_MOUNT',
  'CONTAINER_START_FAILED',
  'CONTAINER_RESOURCE_LIMIT',
  // The plan validator refused a plan (§50). Always a kernel defect: no tool
  // argument is supposed to be able to produce an invalid plan.
  'CONTAINER_PLAN_REJECTED',
  // Scoped subprocess egress (alpha.6 §79, ADR-0015). Split by *what refused*,
  // because a model that is told "the destination host is not approved" can ask
  // for it, and a model that is told "the network could not be set up" cannot —
  // and collapsing the two would make the first look like infrastructure.
  //
  //   SCOPE_DENIED          the host/port is not in the approved set
  //   TARGET_ADDRESS_DENIED it resolved to a private/loopback/metadata address
  //   TARGET_RESOLUTION     it did not resolve at all
  //   PROTOCOL_UNSUPPORTED  outside the enforced HTTP/HTTPS scope
  //   IDENTITY_MISMATCH     Host header or TLS SNI disagreed with the authority
  //   PROXY_UNAVAILABLE     the proxy stopped serving mid-execution
  //   ENFORCEMENT_SETUP     the topology could not be built — never a fallback
  'NETWORK_SCOPE_DENIED',
  'NETWORK_TARGET_ADDRESS_DENIED',
  'NETWORK_TARGET_RESOLUTION_FAILED',
  'NETWORK_PROTOCOL_UNSUPPORTED',
  'NETWORK_IDENTITY_MISMATCH',
  'NETWORK_PROXY_UNAVAILABLE',
  'NETWORK_ENFORCEMENT_SETUP_FAILED',
  // alpha.7. Kept apart from the network family because they answer a different
  // question: not "where may this go" but "can this machine impose the boundary
  // the user asked for at all".
  //
  //   UNSUPPORTED    the platform cannot provide the requested guarantee — a
  //                  kernel without Landlock, a host allowlist on a backend
  //                  whose primitive has no notion of hostnames. Never a
  //                  fallback (§9).
  //   SETUP_FAILED   the guarantee is supported and could not be applied.
  //   SYSCALL_DENIED the sandbox refused a syscall the workload attempted.
  'SANDBOX_UNSUPPORTED',
  'SANDBOX_SETUP_FAILED',
  'SANDBOX_SYSCALL_DENIED',
  // alpha.8, ADR-0019/ADR-0021. Three failures that happen *before* a session
  // exists, which is why they are not in any family above: nothing has been
  // asked of a model, a tool or a boundary yet. They are the ones a first run on
  // a machine that was never set up will actually hit, and each maps to its own
  // exit code so a wrapper can tell "install something" from "edit something".
  //
  //   RUNTIME_UNSUPPORTED     the Node running this is below the ADR-0019 floor
  //   CONFIG_INVALID          a config file exists and cannot be honoured
  //   PROVIDER_NOT_CONFIGURED no provider is reachable; nothing to talk to
  'RUNTIME_UNSUPPORTED',
  'CONFIG_INVALID',
  'PROVIDER_NOT_CONFIGURED',
  'LOOP_BUDGET_EXCEEDED',
  'REPEATED_FAILURE',
  'DELEGATION_DENIED',
  'DELEGATION_DEPTH_EXCEEDED',
  'DELEGATION_FAILED',
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
  MODEL_TIMEOUT: 'environment',
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
  // The file is the user's to fix, and only the user can fix it: the kernel
  // deliberately does not chmod it back into shape.
  CREDENTIAL_FILE_INSECURE: 'user',
  NETWORK_DENIED: 'kernel',
  PATH_OUTSIDE_WORKSPACE: 'model',
  PROTECTED_PATH: 'kernel',
  UNDECLARED_WORKSPACE_MUTATION: 'tool',
  REMOTE_UNAVAILABLE: 'environment',
  REMOTE_HOST_KEY_ERROR: 'environment',
  CONTAINER_RUNTIME_NOT_FOUND: 'environment',
  CONTAINER_RUNTIME_UNAVAILABLE: 'environment',
  // The image is named by configuration, so a missing one is the user's to fix —
  // and deliberately so: the alternative, pulling on demand, would make a tool
  // call reach the network as a side effect (§11).
  CONTAINER_IMAGE_NOT_FOUND: 'user',
  CONTAINER_UNSUPPORTED_FEATURE: 'environment',
  CONTAINER_INVALID_MOUNT: 'kernel',
  CONTAINER_START_FAILED: 'environment',
  CONTAINER_RESOURCE_LIMIT: 'environment',
  CONTAINER_PLAN_REJECTED: 'kernel',
  // A denied destination is the *model's* to fix: it asked for a host the user
  // did not approve, and the remedy is to ask for it or to stop. The setup
  // failures are the environment's.
  NETWORK_SCOPE_DENIED: 'model',
  NETWORK_TARGET_ADDRESS_DENIED: 'model',
  NETWORK_TARGET_RESOLUTION_FAILED: 'environment',
  NETWORK_PROTOCOL_UNSUPPORTED: 'model',
  NETWORK_IDENTITY_MISMATCH: 'model',
  NETWORK_PROXY_UNAVAILABLE: 'environment',
  NETWORK_ENFORCEMENT_SETUP_FAILED: 'environment',
  SANDBOX_UNSUPPORTED: 'environment',
  SANDBOX_SETUP_FAILED: 'kernel',
  SANDBOX_SYSCALL_DENIED: 'model',
  RUNTIME_UNSUPPORTED: 'environment',
  CONFIG_INVALID: 'user',
  PROVIDER_NOT_CONFIGURED: 'user',
  LOOP_BUDGET_EXCEEDED: 'kernel',
  REPEATED_FAILURE: 'model',
  // A refused delegation is the configuration speaking, the same as TOOL_DENIED.
  DELEGATION_DENIED: 'user',
  // Depth is a kernel ceiling, and the model asked for something past it.
  DELEGATION_DEPTH_EXCEEDED: 'model',
  // The child ran and did not finish its task. Blame sits with the child's own
  // failure, which travels in `DelegationResult.error`; this code is the wrapper
  // the parent sees, so it blames the tool layer rather than guessing.
  DELEGATION_FAILED: 'tool',
  CANCELLED: 'user',
  INTERNAL_ERROR: 'kernel',
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'MODEL_RATE_LIMIT',
  'MODEL_INVALID_RESPONSE',
  'MODEL_TIMEOUT',
  'TOOL_TIMEOUT',
  'CONCURRENT_MODIFICATION',
  'REMOTE_UNAVAILABLE',
  // A daemon that is starting up is the common case, and it is genuinely
  // transient. A missing binary or a missing image is not, and neither is here.
  'CONTAINER_RUNTIME_UNAVAILABLE',
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
