/**
 * HTTP transport: a server is a destination (ADR-0022 §1, alpha.9 §10).
 *
 * The counterpart to `transport-stdio.ts`, and the same one-line summary: this
 * file makes no network call of its own. Every byte goes through
 * `EgressGate.send({ kind: 'mcp' })`, which is why `EgressKind` has carried
 * `'mcp'` since the first commit with no consumer. AGENTS.md rule 9 has no
 * exception for protocols we like.
 *
 * Four things must agree before a request leaves, and they are the same four
 * ADR-0017 established for the web tool:
 *
 *   configuration   the host is in `[egress] mcp = [...]`
 *   the gate        the allowlist, the size budget and secret inspection —
 *                   `onSecret: 'block'` for this kind, so a credential-shaped
 *                   value in a request body stops the request rather than being
 *                   redacted out of the log afterwards
 *   the address     §23: every address the name resolves to must be global, so
 *                   an allowlisted name that resolves into private, loopback or
 *                   metadata space is refused
 *   TLS             required, except for loopback
 *
 * The address check is best-effort in exactly the way ADR-0017 says it is: the
 * HTTP client resolves again when it connects, and nothing in a zero-dependency
 * stack pins the socket to the address we validated. It closes the accidental
 * and the lazy case. It does not close a resolver that answers differently twice
 * on purpose.
 *
 * **Statelessness is a deliberate limitation.** This speaks the plain
 * request/response form: one POST per JSON-RPC message, no SSE stream, no
 * session id resumption. A server that requires the streaming half of Streamable
 * HTTP will fail at `initialize` and be refused by name, which is the honest
 * outcome — the alternative is a half-implemented transport that works until the
 * server does something ordinary.
 */

import { kernelError, KernelErrorException } from '../util/errors.ts';
import { resolveHostScope, type LookupFn } from '../security/egress/resolve.ts';
import type { EgressGate } from '../security/egress-gate.ts';
import type { SessionId, TurnId } from '../util/ids.ts';
import type { McpTransport } from './client.ts';
import { isJsonRpcResponse, type JsonRpcResponse } from './protocol.ts';

export interface HttpTransportOptions {
  serverName: string;
  url: string;
  egress: EgressGate;
  sessionId: SessionId;
  turnId: TurnId;
  /**
   * Write the credential into this request's headers, and nothing else.
   *
   * A callback rather than a string, and that is the point. A `string` here
   * would mean the value sat in this object for the life of the session, in
   * kernel memory, outside the broker's TTL and outside its release. Instead the
   * broker issues a fresh lease per request and `applyAuthorization` writes it —
   * so the value is never held by this file, and the redactor learns it each
   * time (alpha.9 §15).
   */
  authorize?: (headers: Record<string, string>) => Promise<void>;
  allowBenchmarkRange?: boolean;
  lookup?: LookupFn;
}

export class HttpTransport implements McpTransport {
  readonly kind = 'http' as const;

  private readonly opts: HttpTransportOptions;
  private readonly url: URL;
  private nextId = 1;
  private closed = false;

  private constructor(opts: HttpTransportOptions, url: URL) {
    this.opts = opts;
    this.url = url;
  }

  /**
   * Validate the destination, then build a transport.
   *
   * The §23 check runs **here**, once, at attach time, rather than before every
   * request. That is a real trade-off and worth naming: a name that resolves
   * benignly at startup and maliciously later is not caught. Per-request
   * resolution would narrow that window without closing it — the client resolves
   * again when it connects either way — and would put a DNS round trip in front
   * of every tool call. The window this leaves is the one ADR-0017 already
   * documented as open.
   */
  static async connect(opts: HttpTransportOptions): Promise<HttpTransport> {
    let url: URL;
    try {
      url = new URL(opts.url);
    } catch {
      throw new KernelErrorException(
        kernelError('CONFIG_INVALID', `MCP server "${opts.serverName}" has an unparseable url.`, {
          blame: 'user',
          safeDetails: { server: opts.serverName },
        }),
      );
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new KernelErrorException(
        kernelError(
          'CONFIG_INVALID',
          `MCP server "${opts.serverName}" declares ${url.protocol}//, which is not HTTP or HTTPS.`,
          { blame: 'user', safeDetails: { server: opts.serverName } },
        ),
      );
    }

    const scope = await resolveHostScope(url.hostname, {
      ...(opts.allowBenchmarkRange !== undefined ? { allowBenchmarkRange: opts.allowBenchmarkRange } : {}),
      ...(opts.lookup ? { lookup: opts.lookup } : {}),
    });
    if (!scope.ok) {
      throw new KernelErrorException(
        kernelError(
          'NETWORK_TARGET_ADDRESS_DENIED',
          `MCP server "${opts.serverName}" was not contacted: ${scope.reason}` +
            (scope.address ? ` (${scope.address})` : '') +
            '. An allowlisted name that resolves into private, loopback or metadata space is the ' +
            'one way an approved destination becomes an unapproved one.',
          {
            blame: 'user',
            safeDetails: {
              server: opts.serverName,
              host: url.hostname,
              ...(scope.scope ? { scope: scope.scope } : {}),
            },
          },
        ),
      );
    }

    return new HttpTransport(opts, url);
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) {
      throw new KernelErrorException(
        kernelError('TOOL_FAILED', `MCP server "${this.opts.serverName}" is closed.`, {
          blame: 'kernel',
        }),
      );
    }

    const id = this.nextId++;
    const parsed = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs, signal);

    if (parsed === undefined) {
      throw new KernelErrorException(
        kernelError(
          'TOOL_FAILED',
          `MCP server "${this.opts.serverName}" answered "${method}" with something that is not a ` +
            'JSON-RPC response.',
          { blame: 'provider', safeDetails: { server: this.opts.serverName, method } },
        ),
      );
    }

    if (parsed.error) {
      throw new KernelErrorException(
        kernelError(
          'TOOL_FAILED',
          `MCP server "${this.opts.serverName}" returned an error: ${parsed.error.message}`,
          {
            blame: 'provider',
            safeDetails: { server: this.opts.serverName, code: parsed.error.code },
          },
        ),
      );
    }
    return parsed.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return;
    // A notification has no id and expects no answer; a 202 with an empty body is
    // the ordinary response, so a missing JSON-RPC envelope is not an error here.
    await this.post({ jsonrpc: '2.0', method, params }, 10_000).catch(() => undefined);
  }

  async close(): Promise<void> {
    // Nothing to tear down: there is no connection to hold and no process to
    // kill. Said explicitly because "close is a no-op" is a claim a reader
    // should be able to check rather than infer from an empty method.
    this.closed = true;
  }

  private async post(
    message: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse | undefined> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Both, because a Streamable HTTP server may answer either way and
      // rejecting one of them at the Accept header would be a refusal we
      // could not explain to the user.
      accept: 'application/json, text/event-stream',
    };
    await this.opts.authorize?.(headers);

    let response;
    try {
      response = await this.opts.egress.send(
        {
          kind: 'mcp',
          url: this.url.href,
          method: 'POST',
          headers,
          body: JSON.stringify(message),
          signal: composed,
        },
        { sessionId: this.opts.sessionId, turnId: this.opts.turnId },
      );
    } catch (err) {
      if (timeout.aborted) {
        throw new KernelErrorException(
          kernelError(
            'TOOL_TIMEOUT',
            `MCP server "${this.opts.serverName}" did not answer within ${timeoutMs}ms.`,
            { blame: 'provider', safeDetails: { server: this.opts.serverName } },
          ),
        );
      }
      throw err;
    }

    if (response.status === 202) return undefined;
    if (response.status < 200 || response.status >= 300) {
      throw new KernelErrorException(
        kernelError('TOOL_FAILED', `MCP server "${this.opts.serverName}" answered HTTP ${response.status}.`, {
          blame: 'provider',
          safeDetails: { server: this.opts.serverName, status: response.status },
        }),
      );
    }

    const body = response.body ?? '';
    if (body.trim() === '') return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
    return isJsonRpcResponse(parsed) ? (parsed as JsonRpcResponse) : undefined;
  }
}
