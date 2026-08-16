/**
 * The MCP client: lifecycle, the frozen catalogue, and every way a server fails
 * (ADR-0022 §4-§6, alpha.9 §16).
 *
 * Sits above a `McpTransport`, which is where the boundary lives — stdio goes
 * through the `ExecutionBackend`, HTTP through the `EgressGate`, and this file
 * knows about neither. That split is deliberate: everything here is about what
 * the *protocol* is allowed to do, and it can be tested against a fake transport
 * without a subprocess or a socket, which is what makes the failure cases in §16
 * cheap enough to cover exhaustively.
 */

import { sha256Hex } from '../util/ids.ts';
import { kernelError, KernelErrorException } from '../util/errors.ts';
import {
  ACCEPTED_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  parseCallResult,
  parseToolsList,
  type CallResult,
  type ListedTool,
} from './protocol.ts';

/**
 * What the client needs from a transport, and nothing more.
 *
 * Request/response at the RPC level rather than at the byte level, so stdio's
 * duplex stream and HTTP's POST both fit without either leaking its shape into
 * the lifecycle logic.
 */
export interface McpTransport {
  readonly kind: 'stdio' | 'http';
  /** Send a request, await its matching response. Rejects on timeout or death. */
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  /** Fire and forget. Used for the `initialized` notification only. */
  notify(method: string, params: unknown): Promise<void>;
  /** Kill the process tree / close the connection. Idempotent. */
  close(): Promise<void>;
}

/**
 * The most tools a server may offer, and it is disclosed rather than silent
 * (§16).
 *
 * A server that lists five hundred tools would put five hundred descriptions in
 * every request. The cap is low enough to be a real bound and high enough that
 * no honest server hits it; a server that does is truncated *and* says so, in
 * the warning and in `/status`, because a catalogue quietly missing its tail is
 * a session whose behaviour changed for a reason the user cannot see.
 */
export const MAX_TOOLS_PER_SERVER = 64;

/** Default ceiling for one `tools/call`. Per-server override in config. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Ceiling for `initialize` and `tools/list`. Startup must not hang a session. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface McpCatalogue {
  tools: readonly ListedTool[];
  /** Hash over names, descriptions and schemas. The TOCTOU anchor. */
  hash: string;
  /** True when the server offered more than `MAX_TOOLS_PER_SERVER`. */
  truncated: boolean;
  /** Entries dropped for a non-string name. */
  dropped: number;
  /** The version the server negotiated. */
  protocolVersion: string;
}

/**
 * Hash a catalogue.
 *
 * Over names, descriptions **and** schemas, because ADR-0024 §4's question is
 * whether the thing the model was told about is the thing it calls — and a
 * server that kept every name and rewrote every description has changed exactly
 * that.
 */
export function catalogueHash(tools: readonly ListedTool[]): string {
  const canonical = tools
    .map((t) => JSON.stringify([t.name, t.description ?? null, t.inputSchema ?? null]))
    .sort()
    .join('\n');
  return sha256Hex(canonical).slice(0, 32);
}

export type McpClientState = 'new' | 'ready' | 'closed' | 'disabled';

export class McpClient {
  private state: McpClientState = 'new';
  private catalogue?: McpCatalogue;
  private disabledReason?: string;
  /** Collected during handshake and surfaced by `/status`. */
  readonly warnings: string[] = [];

  readonly serverName: string;
  private readonly transport: McpTransport;
  private readonly callTimeoutMs: number;

  constructor(serverName: string, transport: McpTransport, callTimeoutMs: number = DEFAULT_CALL_TIMEOUT_MS) {
    this.serverName = serverName;
    this.transport = transport;
    this.callTimeoutMs = callTimeoutMs;
  }

  get transportKind(): 'stdio' | 'http' {
    return this.transport.kind;
  }

  get isUsable(): boolean {
    return this.state === 'ready';
  }

  get reasonUnusable(): string | undefined {
    return this.disabledReason;
  }

  tools(): readonly ListedTool[] {
    return this.catalogue?.tools ?? [];
  }

  /**
   * `initialize`, then `tools/list`, then freeze.
   *
   * Throws on any failure. The caller decides whether that fails the session or
   * merely drops the server, because that is a configuration question
   * (`optional`) and not a protocol one.
   */
  async start(signal?: AbortSignal): Promise<McpCatalogue> {
    if (this.state !== 'new') {
      throw new Error(`MCP client for "${this.serverName}" was already started`);
    }

    const init = await this.transport.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mycoder', version: '0.1.0' },
      },
      HANDSHAKE_TIMEOUT_MS,
      signal,
    );

    const negotiated = readProtocolVersion(init);
    if (negotiated === undefined || !ACCEPTED_PROTOCOL_VERSIONS.includes(negotiated)) {
      // Speaking a version we have not implemented, against a process we cannot
      // inspect, is the wrong direction to guess in (ADR-0022 §6).
      throw new KernelErrorException(
        kernelError(
          'CONFIG_INVALID',
          `MCP server "${this.serverName}" negotiated protocol version ` +
            `${negotiated === undefined ? '(none)' : `"${negotiated}"`}, which this client does not ` +
            `speak. Supported: ${ACCEPTED_PROTOCOL_VERSIONS.join(', ')}.`,
          { blame: 'user' },
        ),
      );
    }

    await this.transport.notify('notifications/initialized', {});

    const listed = await this.transport.request('tools/list', {}, HANDSHAKE_TIMEOUT_MS, signal);
    const { tools: all, dropped } = parseToolsList(listed);

    if (dropped > 0) {
      this.warnings.push(
        `MCP server "${this.serverName}" listed ${dropped} entr${dropped === 1 ? 'y' : 'ies'} ` +
          'with no usable name; they were not registered.',
      );
    }

    const truncated = all.length > MAX_TOOLS_PER_SERVER;
    const tools = truncated ? all.slice(0, MAX_TOOLS_PER_SERVER) : all;
    if (truncated) {
      this.warnings.push(
        `MCP server "${this.serverName}" offered ${all.length} tools; MyCoder registered the first ` +
          `${MAX_TOOLS_PER_SERVER} and ignored the rest. A catalogue quietly missing its tail is a ` +
          'session whose behaviour changed invisibly, so this is said rather than logged.',
      );
    }

    this.catalogue = {
      tools,
      hash: catalogueHash(tools),
      truncated,
      dropped,
      protocolVersion: negotiated,
    };
    this.state = 'ready';
    return this.catalogue;
  }

  /**
   * Re-list after a restart and compare against the frozen catalogue.
   *
   * Any difference disables the server for the rest of the session. Not
   * "re-register the new one": a session that was told about one tool and called
   * another has been through the time-of-check/time-of-use gap, and the only
   * safe move after detecting it is to stop using that server (ADR-0024 §4).
   */
  async reconcileAfterRestart(signal?: AbortSignal): Promise<{ ok: boolean; reason?: string }> {
    if (this.catalogue === undefined) return { ok: false, reason: 'never started' };

    const listed = await this.transport.request('tools/list', {}, HANDSHAKE_TIMEOUT_MS, signal);
    const { tools: all } = parseToolsList(listed);
    const tools = all.length > MAX_TOOLS_PER_SERVER ? all.slice(0, MAX_TOOLS_PER_SERVER) : all;

    if (catalogueHash(tools) === this.catalogue.hash) {
      this.state = 'ready';
      return { ok: true };
    }

    const reason =
      `MCP server "${this.serverName}" presented a different tool catalogue after restarting. ` +
      'Its tools have been unregistered for the rest of this session. A catalogue that changes ' +
      'under a running session means the tool the model was told about is not necessarily the ' +
      'tool it would call.';
    this.disable(reason);
    return { ok: false, reason };
  }

  /** Stop using this server. Irreversible for the session, by design. */
  disable(reason: string): void {
    this.state = 'disabled';
    this.disabledReason = reason;
  }

  /**
   * Call a tool.
   *
   * Every failure mode in §16 lands here as a named error rather than an
   * exception the turn cannot attribute: the turn survives, and the model is
   * told which server failed and how.
   */
  async callTool(tool: string, args: unknown, signal?: AbortSignal): Promise<CallResult> {
    if (this.state !== 'ready') {
      throw new KernelErrorException(
        kernelError(
          'TOOL_FAILED',
          `MCP server "${this.serverName}" is not available: ${this.disabledReason ?? this.state}.`,
          { blame: 'kernel', safeDetails: { server: this.serverName } },
        ),
      );
    }

    const result = await this.transport.request(
      'tools/call',
      { name: tool, arguments: args ?? {} },
      this.callTimeoutMs,
      signal,
    );

    return parseCallResult(result);
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    await this.transport.close();
  }
}

function readProtocolVersion(init: unknown): string | undefined {
  if (typeof init !== 'object' || init === null) return undefined;
  const v = (init as Record<string, unknown>).protocolVersion;
  return typeof v === 'string' ? v : undefined;
}
