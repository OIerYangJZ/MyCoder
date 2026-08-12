/**
 * Egress Gate (spec §14).
 *
 * Every byte the kernel sends to the network leaves through `EgressGate.send()`.
 * Model requests, telemetry, hook HTTP, plugins, MCP transports, web tools and
 * the update checker all use it; nothing else in this codebase may call `fetch`
 * (see AGENTS.md rule 9, enforced by tests/security/no-raw-network.test.ts).
 *
 * The gate does four things, in order:
 *   1. classify — each `kind` has its own host allowlist and content policy;
 *   2. inspect  — the payload is scanned for secrets before it is serialised out;
 *   3. audit    — metadata only: host, kind, byte count, body hash. Never the body;
 *   4. transmit — through an injectable transport, so tests capture real payloads.
 */

import { fingerprint, sha256Hex } from '../util/ids.ts';
import { kernelError, KernelErrorException, type KernelError } from '../util/errors.ts';
import { globMatch } from '../util/glob.ts';
import type { Redactor } from './redactor.ts';
import { scanSecrets } from './secret-scanner.ts';

export type EgressKind = 'model' | 'telemetry' | 'hook' | 'plugin' | 'mcp' | 'web' | 'update';

export const EGRESS_KINDS: readonly EgressKind[] = [
  'model',
  'telemetry',
  'hook',
  'plugin',
  'mcp',
  'web',
  'update',
];

export interface EgressRequest {
  kind: EgressKind;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Ask the transport for a streaming body instead of a buffered one. */
  stream?: boolean;
}

export interface EgressContext {
  sessionId: string;
  turnId?: string;
  stepId?: string;
  /** Free-form label used in audit records, e.g. the provider or hook name. */
  purpose?: string;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  /** Present when `stream` was not requested. */
  body?: string;
  /** Present when `stream` was requested. */
  stream?: ReadableStream<Uint8Array>;
}

/** What the gate records. Note the absence of any content field. */
export interface EgressAuditRecord {
  kind: EgressKind;
  host: string;
  method: string;
  /** Path is coarsened: only the first two segments survive. */
  pathClass: string;
  requestBytes: number;
  /** Hash of the body, so two identical requests can be correlated. */
  bodyHash?: string;
  status?: number;
  durationMs?: number;
  outcome: 'sent' | 'blocked' | 'error';
  blockedReason?: string;
  redactions?: number;
}

/** How a `kind` behaves when a secret is found in its payload. */
export type SecretDisposition = 'block' | 'redact';

export interface EgressKindPolicy {
  /** Host globs. Empty means "no egress of this kind is permitted at all". */
  allowedHosts: readonly string[];
  /** Whether request bodies carrying content are legal for this kind. */
  allowContent: boolean;
  maxRequestBytes: number;
  onSecret: SecretDisposition;
  /** Require TLS. Only loopback is exempt, for local MCP servers and tests. */
  requireTls: boolean;
}

export type EgressPolicy = Record<EgressKind, EgressKindPolicy>;

const NO_HOSTS: readonly string[] = [];

/**
 * Defaults. Note that `telemetry` allows no content and blocks on any secret,
 * and that `web`/`plugin`/`mcp` start with an empty allowlist: a capability
 * nobody configured is a capability nobody has.
 */
export function defaultEgressPolicy(): EgressPolicy {
  return {
    model: {
      allowedHosts: ['api.anthropic.com', 'api.openai.com'],
      allowContent: true,
      maxRequestBytes: 32 * 1024 * 1024,
      onSecret: 'redact',
      requireTls: true,
    },
    telemetry: {
      allowedHosts: NO_HOSTS,
      allowContent: false,
      maxRequestBytes: 256 * 1024,
      onSecret: 'block',
      requireTls: true,
    },
    hook: {
      allowedHosts: NO_HOSTS,
      allowContent: true,
      maxRequestBytes: 1024 * 1024,
      onSecret: 'block',
      requireTls: true,
    },
    plugin: {
      allowedHosts: NO_HOSTS,
      allowContent: true,
      maxRequestBytes: 4 * 1024 * 1024,
      onSecret: 'block',
      requireTls: true,
    },
    mcp: {
      allowedHosts: NO_HOSTS,
      allowContent: true,
      maxRequestBytes: 4 * 1024 * 1024,
      onSecret: 'block',
      requireTls: false,
    },
    web: {
      allowedHosts: NO_HOSTS,
      allowContent: true,
      maxRequestBytes: 1024 * 1024,
      onSecret: 'block',
      requireTls: true,
    },
    update: {
      allowedHosts: NO_HOSTS,
      allowContent: false,
      maxRequestBytes: 4096,
      onSecret: 'block',
      requireTls: true,
    },
  };
}

/** Telemetry fields permitted by spec §14.4. Anything else is dropped. */
export const TELEMETRY_FIELD_ALLOWLIST: readonly string[] = [
  'durationMs',
  'provider',
  'model',
  'toolName',
  'errorCode',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'latencyMs',
  'approvalDecision',
  'sandboxBackend',
  'sandboxStrength',
  'version',
  'event',
  'count',
  'sessionHash',
  'permissionProfile',
  'finishReason',
];

export interface EgressTransport {
  send(req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    stream?: boolean;
  }): Promise<EgressResponse>;
}

/** The only place in the kernel that calls global `fetch`. */
export const fetchTransport: EgressTransport = {
  async send(req) {
    const init: RequestInit = { method: req.method, headers: req.headers };
    if (req.body !== undefined) init.body = req.body;
    if (req.signal) init.signal = req.signal;

    const res = await fetch(req.url, init);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });

    if (req.stream) {
      const out: EgressResponse = { status: res.status, headers };
      if (res.body) out.stream = res.body;
      return out;
    }
    return { status: res.status, headers, body: await res.text() };
  },
};

export interface EgressGate {
  send(request: EgressRequest, ctx: EgressContext): Promise<EgressResponse>;
}

export interface EgressGateOptions {
  policy?: EgressPolicy;
  transport?: EgressTransport;
  redactor: Redactor;
  onAudit?: (record: EgressAuditRecord) => void;
  now?: () => number;
}

export class EgressBlockedError extends Error {
  readonly kernelError: KernelError;

  constructor(err: KernelError) {
    super(err.message);
    this.name = 'EgressBlockedError';
    this.kernelError = err;
  }
}

export class DefaultEgressGate implements EgressGate {
  private readonly policy: EgressPolicy;
  private readonly transport: EgressTransport;
  private readonly redactor: Redactor;
  private readonly onAudit: (record: EgressAuditRecord) => void;
  private readonly now: () => number;

  constructor(opts: EgressGateOptions) {
    this.policy = opts.policy ?? defaultEgressPolicy();
    this.transport = opts.transport ?? fetchTransport;
    this.redactor = opts.redactor;
    this.onAudit = opts.onAudit ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** Widen a kind's host allowlist. Used by config; never by the model. */
  allowHosts(kind: EgressKind, hosts: readonly string[]): void {
    const current = this.policy[kind];
    this.policy[kind] = { ...current, allowedHosts: [...current.allowedHosts, ...hosts] };
  }

  getPolicy(kind: EgressKind): EgressKindPolicy {
    return this.policy[kind];
  }

  async send(request: EgressRequest, ctx: EgressContext): Promise<EgressResponse> {
    const started = this.now();
    const policy = this.policy[request.kind];

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw this.block(
        request,
        undefined,
        'malformed-url',
        'NETWORK_DENIED',
        'Egress URL is not a valid absolute URL.',
      );
    }

    const host = url.hostname;
    const audit: EgressAuditRecord = {
      kind: request.kind,
      host,
      method: request.method,
      pathClass: coarsePath(url.pathname),
      requestBytes: request.body ? Buffer.byteLength(request.body, 'utf8') : 0,
      outcome: 'sent',
    };
    if (ctx.purpose) audit.pathClass = `${audit.pathClass}#${ctx.purpose}`;

    // 1. Transport-level checks.
    if (policy.requireTls && url.protocol !== 'https:' && !isLoopback(host)) {
      throw this.block(
        request,
        audit,
        'tls-required',
        'NETWORK_DENIED',
        `Egress of kind "${request.kind}" requires https.`,
      );
    }
    if (!['https:', 'http:'].includes(url.protocol)) {
      throw this.block(
        request,
        audit,
        'bad-scheme',
        'NETWORK_DENIED',
        `Unsupported URL scheme "${url.protocol}".`,
      );
    }

    // 2. Host allowlist. An empty allowlist means the capability is off.
    if (!policy.allowedHosts.some((p) => globMatch(p, host))) {
      throw this.block(
        request,
        audit,
        'host-not-allowed',
        'NETWORK_DENIED',
        policy.allowedHosts.length === 0
          ? `Egress of kind "${request.kind}" is not enabled. No hosts are configured for it.`
          : `Host "${host}" is not in the allowlist for egress kind "${request.kind}".`,
      );
    }

    // 3. Size budget.
    if (audit.requestBytes > policy.maxRequestBytes) {
      throw this.block(
        request,
        audit,
        'payload-too-large',
        'NETWORK_DENIED',
        `Request body of ${audit.requestBytes} bytes exceeds the ${policy.maxRequestBytes} byte budget for "${request.kind}".`,
      );
    }

    // 4. Content policy and secret inspection.
    let body = request.body;
    let redactions = 0;

    if (body !== undefined && body !== '') {
      if (!policy.allowContent) {
        const violation = checkMetadataOnly(request.kind, body);
        if (violation) {
          throw this.block(request, audit, 'content-not-allowed', 'SECRET_EGRESS_BLOCKED', violation);
        }
      }

      // A value the kernel *knows* is secret is never negotiable.
      if (this.redactor.containsKnownLiteral(body)) {
        if (policy.onSecret === 'block') {
          throw this.block(
            request,
            audit,
            'known-secret-in-payload',
            'SECRET_EGRESS_BLOCKED',
            `A registered secret value was found in a "${request.kind}" payload. The request was not sent.`,
          );
        }
        const before = body;
        body = this.redactor.redact(body);
        if (before !== body) redactions += 1;
      }

      const findings = scanSecrets(body, { minConfidence: 'high' });
      if (findings.length > 0) {
        if (policy.onSecret === 'block') {
          throw this.block(
            request,
            audit,
            'secret-shape-in-payload',
            'SECRET_EGRESS_BLOCKED',
            `${findings.length} credential-shaped value(s) were found in a "${request.kind}" payload. The request was not sent.`,
            { ruleIds: [...new Set(findings.map((f) => f.ruleId))] },
          );
        }
        body = this.redactor.redact(body, { minConfidence: 'high' });
        redactions += findings.length;
      }

      // Belt and braces: if a known literal somehow survived redaction, refuse.
      if (this.redactor.containsKnownLiteral(body)) {
        throw this.block(
          request,
          audit,
          'redaction-failed',
          'SECRET_EGRESS_BLOCKED',
          'A registered secret survived redaction. Refusing to transmit.',
        );
      }

      audit.requestBytes = Buffer.byteLength(body, 'utf8');
      audit.bodyHash = sha256Hex(body).slice(0, 16);
      if (redactions > 0) audit.redactions = redactions;
    }

    // 5. Headers must not smuggle content past the body checks.
    const headers = { ...(request.headers ?? {}) };
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'authorization') continue; // set from a lease
      if (this.redactor.containsKnownLiteral(value)) {
        throw this.block(
          request,
          audit,
          'known-secret-in-header',
          'SECRET_EGRESS_BLOCKED',
          `A registered secret value was found in the "${name}" header.`,
        );
      }
    }

    // 6. Transmit.
    try {
      const sendReq: Parameters<EgressTransport['send']>[0] = {
        url: request.url,
        method: request.method,
        headers,
      };
      if (body !== undefined) sendReq.body = body;
      if (request.signal) sendReq.signal = request.signal;
      if (request.stream) sendReq.stream = true;

      const response = await this.transport.send(sendReq);
      audit.status = response.status;
      audit.durationMs = this.now() - started;
      this.onAudit(audit);
      return response;
    } catch (e) {
      audit.outcome = 'error';
      audit.durationMs = this.now() - started;
      this.onAudit(audit);
      if (e instanceof KernelErrorException || e instanceof EgressBlockedError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new KernelErrorException(kernelError('CANCELLED', 'Request was cancelled.'));
      }
      throw new KernelErrorException(
        kernelError('REMOTE_UNAVAILABLE', `Egress to ${host} failed.`, {
          blame: 'environment',
          safeDetails: { host, kind: request.kind },
        }),
      );
    }
  }

  private block(
    request: EgressRequest,
    audit: EgressAuditRecord | undefined,
    reason: string,
    code: KernelError['code'],
    message: string,
    extra?: Record<string, unknown>,
  ): EgressBlockedError {
    if (audit) {
      audit.outcome = 'blocked';
      audit.blockedReason = reason;
      this.onAudit(audit);
    }
    return new EgressBlockedError(
      kernelError(code, message, {
        blame: 'kernel',
        safeDetails: { kind: request.kind, reason, ...(extra ?? {}) },
      }),
    );
  }
}

/**
 * Enforce that a metadata-only channel really carries metadata.
 *
 * Rather than trust the caller, we re-parse the payload and reject any key that
 * is not on the telemetry allowlist. This is what keeps a well-meaning
 * `telemetry.record({ prompt })` from ever shipping.
 */
function checkMetadataOnly(kind: EgressKind, body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `Egress of kind "${kind}" must be a JSON metadata document.`;
  }

  const offending: string[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 6 || offending.length > 8) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (!TELEMETRY_FIELD_ALLOWLIST.includes(key)) {
        offending.push(path === '' ? key : `${path}.${key}`);
        continue;
      }
      visit(value, path === '' ? key : `${path}.${key}`, depth + 1);
    }
  };
  visit(parsed, '', 0);

  if (offending.length > 0) {
    return `Egress of kind "${kind}" carries non-metadata field(s): ${offending.slice(0, 8).join(', ')}.`;
  }
  return null;
}

function coarsePath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean).slice(0, 2);
  return '/' + segments.join('/');
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * A gate that refuses everything. Used by `--read-only`, by profiles with no
 * network, and as the default in unit tests so an unmocked call fails loudly.
 */
export class DeniedEgressGate implements EgressGate {
  private readonly reason: string;

  constructor(reason = 'Network egress is disabled for this session.') {
    this.reason = reason;
  }

  async send(request: EgressRequest): Promise<EgressResponse> {
    throw new EgressBlockedError(
      kernelError('NETWORK_DENIED', this.reason, {
        blame: 'kernel',
        safeDetails: { kind: request.kind },
      }),
    );
  }
}

/** Stable fingerprint of a payload, for audit correlation without content. */
export function payloadFingerprint(body: string): string {
  return fingerprint(body, 16);
}
