/**
 * stdio transport: a server is a subprocess (ADR-0022 §1, alpha.9 §9).
 *
 * The whole of this file's security content is one line — it takes a
 * `ProcessSession` from a `ProcessBackend` and never spawns anything itself. A
 * stdio MCP server is subject to every rule alpha.4 through alpha.7 established
 * for subprocesses, with no exception made because it is "infrastructure":
 * `scrubEnv`, a capability profile, the ExecutionBackend, the sandbox when one
 * is selected, and death with the turn.
 *
 * A backend with no `session()` is **refused here**, not worked around. That is
 * the alpha.5 rule applied where it is least convenient: a session on
 * `--backend container` that spawned its server on the host would have moved the
 * most capable component in the workload outside the boundary the user asked
 * for, which is not a caveat but a different product.
 */

import type { ProcessBackend, ProcessSession, ProcessSpec } from '../execution/backend.ts';
import { kernelError, KernelErrorException } from '../util/errors.ts';
import type { McpTransport } from './client.ts';
import { LineFramer, isJsonRpcResponse, type JsonRpcResponse } from './protocol.ts';

/**
 * Most bytes a server may send without completing a frame.
 *
 * A server that streams megabytes with no newline would otherwise grow the
 * framer's buffer without bound — the flood case in §16, at the transport layer
 * where it can actually be stopped rather than at the tool layer where the
 * memory has already been spent.
 */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

interface Pending {
  resolve(value: unknown): void;
  reject(err: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export class StdioTransport implements McpTransport {
  readonly kind = 'stdio' as const;

  private readonly session: ProcessSession;
  private readonly serverName: string;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private deathReason?: string;

  private constructor(serverName: string, session: ProcessSession) {
    this.serverName = serverName;
    this.session = session;
    void this.pump();
    void this.watchForDeath();
  }

  /**
   * Start a server through a backend.
   *
   * `spec.env` must already be scrubbed — this does not build one, because a
   * transport that assembled its own environment would be the place a credential
   * quietly got in.
   */
  static async start(
    serverName: string,
    backend: ProcessBackend,
    spec: ProcessSpec,
    signal?: AbortSignal,
  ): Promise<StdioTransport> {
    if (backend.session === undefined) {
      throw new KernelErrorException(
        kernelError(
          'CONFIG_INVALID',
          `MCP server "${serverName}" is a stdio server, and this execution backend cannot host a ` +
            'long-lived process. MyCoder refuses rather than spawning it outside the backend: a ' +
            'server started around the sandbox would be the most capable tool in the session ' +
            'running outside the boundary you selected. Use an HTTP server, or a backend that ' +
            'supports long-lived processes.',
          { blame: 'user', safeDetails: { server: serverName } },
        ),
      );
    }
    return new StdioTransport(serverName, await backend.session(spec, signal));
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || !this.session.alive) {
      throw this.dead(`before "${method}" was sent`);
    }

    const id = this.nextId++;
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new KernelErrorException(
            kernelError(
              'TOOL_TIMEOUT',
              `MCP server "${this.serverName}" did not answer "${method}" within ${timeoutMs}ms.`,
              { blame: 'provider', safeDetails: { server: this.serverName, method } },
            ),
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });

    const onAbort = (): void => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(
        new KernelErrorException(
          kernelError('TOOL_FAILED', `the turn was cancelled during "${method}"`, {
            blame: 'user',
            safeDetails: { server: this.serverName },
          }),
        ),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await this.session.write(frame);
      return await answer;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed || !this.session.alive) return;
    await this.session.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending('the server was closed');
    await this.session.kill();
  }

  /** Read frames until the stream ends. One iterator, owned here. */
  private async pump(): Promise<void> {
    const framer = new LineFramer();
    try {
      for await (const chunk of this.session.stdout()) {
        for (const line of framer.push(chunk)) this.deliver(line);

        if (framer.pending > MAX_PENDING_BYTES) {
          this.deathReason = `it sent more than ${MAX_PENDING_BYTES} bytes without completing a message`;
          await this.close();
          return;
        }
      }
    } catch {
      // The stream ended abnormally; `watchForDeath` produces the message.
    }
  }

  private deliver(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not our problem to repair. A server that emits a non-JSON line on stdout
      // is usually one that logged there by mistake, and dropping it is kinder
      // than failing every in-flight call.
      return;
    }

    if (!isJsonRpcResponse(parsed)) return;
    const response = parsed as JsonRpcResponse;

    const waiting = this.pending.get(response.id);
    if (!waiting) return;
    this.pending.delete(response.id);
    clearTimeout(waiting.timer);

    if (response.error) {
      waiting.reject(
        new KernelErrorException(
          kernelError(
            'TOOL_FAILED',
            `MCP server "${this.serverName}" returned an error: ${response.error.message}`,
            { blame: 'provider', safeDetails: { server: this.serverName, code: response.error.code } },
          ),
        ),
      );
      return;
    }
    waiting.resolve(response.result);
  }

  /** A process that dies mid-call must fail that call, not hang it (§16). */
  private async watchForDeath(): Promise<void> {
    const { exitCode, signal } = await this.session.exited;
    if (this.closed) return;
    const how = signal !== null ? `was killed by ${signal}` : `exited with code ${exitCode ?? 'unknown'}`;
    this.failAllPending(`${this.deathReason ?? `it ${how}`}`);
  }

  private failAllPending(reason: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(this.dead(reason));
    }
  }

  private dead(reason: string): KernelErrorException {
    const stderr = this.session.stderrSoFar().trim();
    return new KernelErrorException(
      kernelError(
        'TOOL_FAILED',
        `MCP server "${this.serverName}" is not running: ${reason}.` +
          (stderr === '' ? '' : ` Its last output was: ${stderr.slice(-500)}`),
        { blame: 'provider', safeDetails: { server: this.serverName } },
      ),
    );
  }
}
