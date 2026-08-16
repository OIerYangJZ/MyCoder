/**
 * The thing that joins configuration to a running client (ADR-0022 §3-§5).
 *
 * Until this existed, `[mcp.servers.*]` parsed and `McpClient` worked and
 * nothing connected them, so a user could not attach a server at all. This is
 * that connection, and it owns the three decisions that only make sense once
 * both halves are present:
 *
 *   which transport a declared server gets, and who refuses if it cannot be had
 *   what happens when a declared server will not start
 *   which tools reach the registry, and what is said about the ones that do not
 *
 * It deliberately does **not** own the boundary. A stdio server's subprocess
 * goes through the `ProcessBackend` it is handed; an HTTP server's request will
 * go through the `EgressGate`. This file chooses between them and gets out of
 * the way.
 */

import { kernelError, KernelErrorException } from '../util/errors.ts';
import { scrubEnv } from '../security/env-scrub.ts';
import type { Logger } from '../util/logger.ts';
import type { CanonicalPath } from '../util/paths.ts';
import type { ProcessBackend } from '../execution/backend.ts';
import type { McpServerConfig } from '../config/schema.ts';
import type { ToolDefinition } from '../tools/contract.ts';
import type { EgressGate } from '../security/egress-gate.ts';
import type { SecretBroker } from '../security/secret-broker.ts';
import type { LookupFn } from '../security/egress/resolve.ts';
import type { SessionId, TurnId } from '../util/ids.ts';
import { McpClient, DEFAULT_CALL_TIMEOUT_MS, type McpTransport } from './client.ts';
import { StdioTransport } from './transport-stdio.ts';
import { HttpTransport } from './transport-http.ts';
import { buildToolDefinitions } from './tool.ts';

export interface McpServiceOptions {
  servers: Record<string, McpServerConfig>;
  backend: ProcessBackend;
  workspaceRoot: CanonicalPath;
  logger?: Logger;
  signal?: AbortSignal;
  /** Required before an HTTP server can be attached. */
  egress?: EgressGate;
  /** Resolves `credential_ref`. Without it, a server needing one is refused. */
  secrets?: SecretBroker;
  sessionId?: SessionId;
  turnId?: TurnId;
  allowBenchmarkRange?: boolean;
  lookup?: LookupFn;
}

export interface AttachedServer {
  name: string;
  transport: 'stdio' | 'http';
  toolNames: readonly string[];
}

export class McpService {
  private readonly clients = new Map<string, McpClient>();
  private readonly definitions: ToolDefinition[] = [];
  /** Everything a user needs to be told at startup. Surfaced by `/status`. */
  readonly warnings: string[] = [];
  readonly attached: AttachedServer[] = [];

  private constructor() {}

  /**
   * Start every declared server, or refuse the session saying which one failed.
   *
   * alpha.8 §10's rule — a first run refuses rather than degrades — applied to a
   * catalogue. A model told a tool exists and then finding it missing produces
   * the worst failure mode this project has measured: a wasted call, a retry and
   * a wrong conclusion about why. `optional = true` is the per-server, explicit,
   * had-to-be-typed way to choose otherwise.
   */
  static async start(opts: McpServiceOptions): Promise<McpService> {
    const service = new McpService();
    const names = Object.keys(opts.servers).sort();

    for (const name of names) {
      const declared = opts.servers[name]!;
      try {
        await service.attach(name, declared, opts);
      } catch (err) {
        const why = err instanceof KernelErrorException ? err.kernelError.message : String(err);

        if (declared.optional === true) {
          service.warnings.push(
            `MCP server "${name}" did not start and is declared optional, so this session is ` +
              `running without it and without its tools. Reason: ${why}`,
          );
          opts.logger?.warn?.('mcp.server.unavailable', { server: name, reason: why });
          continue;
        }

        // Everything started so far is torn down: a half-attached session is
        // worse than none, and leaving stdio servers running after refusing to
        // start would leak the processes this refusal exists to avoid.
        await service.close();
        throw new KernelErrorException(
          kernelError(
            'CONFIG_INVALID',
            `MCP server "${name}" could not be started, so this session refused to begin. ` +
              `${why}\n\nFix the server, remove it from your config, or declare ` +
              `\`optional = true\` under [mcp.servers.${name}] if a session without it is ` +
              'acceptable — a model told a tool exists and then finding it missing wastes a ' +
              'call and reaches the wrong conclusion about why.',
            { blame: 'user', safeDetails: { server: name } },
          ),
        );
      }
    }

    return service;
  }

  private async attach(name: string, declared: McpServerConfig, opts: McpServiceOptions): Promise<void> {
    const transport =
      declared.transport === 'http'
        ? await this.connectHttp(name, declared, opts)
        : await StdioTransport.start(
            name,
            opts.backend,
            {
              argv: declared.command ?? [],
              cwd: opts.workspaceRoot,
              // AGENTS.md rule 8. A server the kernel starts on the user's
              // behalf is a subprocess, and gets no ambient environment for
              // being one.
              env: scrubEnv({ cwd: opts.workspaceRoot }).env,
              timeoutMs: declared.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
            },
            opts.signal,
          );

    const client = new McpClient(name, transport, declared.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    this.clients.set(name, client);

    await client.start(opts.signal);
    this.warnings.push(...client.warnings);

    const { definitions, rejected } = buildToolDefinitions(client);
    for (const r of rejected) this.warnings.push(r.reason);
    this.definitions.push(...definitions);

    this.attached.push({
      name,
      transport: client.transportKind,
      toolNames: definitions.map((d) => d.name),
    });
  }

  /**
   * Build an HTTP transport, resolving the credential through `SecretBroker`.
   *
   * The credential is fetched **here** and handed to the transport as a header
   * value, and that is the whole of the credential's journey (alpha.9 §15): it
   * never becomes a tool argument, never enters a description, never reaches the
   * model's context, and the gate's redactor owns the log. A server that
   * declared a `credential_ref` the broker cannot resolve is refused rather than
   * contacted without it — sending an unauthenticated request to a server the
   * user configured with a credential would be a silent downgrade.
   */
  private async connectHttp(
    name: string,
    declared: McpServerConfig,
    opts: McpServiceOptions,
  ): Promise<McpTransport> {
    if (opts.egress === undefined || opts.sessionId === undefined || opts.turnId === undefined) {
      throw new KernelErrorException(
        kernelError(
          'CONFIG_INVALID',
          `MCP server "${name}" is an HTTP server, and this session has no egress gate to send ` +
            'through. There is no path to the network that goes around it.',
          { blame: 'kernel', safeDetails: { server: name } },
        ),
      );
    }

    // A fresh lease per request, written straight into the headers by the
    // broker. The value is never a variable in this file, never in the tool
    // arguments, never in a description, and the redactor learns it each time.
    const ref = declared.credentialRef;
    const secrets = opts.secrets;
    let authorize: ((headers: Record<string, string>) => Promise<void>) | undefined;

    if (ref !== undefined) {
      if (secrets === undefined) {
        throw new KernelErrorException(
          kernelError(
            'SECRET_ACCESS_DENIED',
            `MCP server "${name}" declares credential_ref = "${ref}", and this session has no ` +
              'secret broker to resolve it. The server was not contacted: sending an ' +
              'unauthenticated request to a server you configured with a credential would be a ' +
              'silent downgrade.',
            { blame: 'kernel', safeDetails: { server: name, ref } },
          ),
        );
      }
      // Resolved once here so a missing or unreadable credential refuses at
      // attach time rather than on the first tool call, when the model is
      // already mid-task and the failure reads as the server's fault.
      const probe = await secrets.resolve(ref as never, 'egress.header');
      probe.release();

      authorize = async (headers) => {
        const lease = await secrets.resolve(ref as never, 'egress.header');
        try {
          lease.applyAuthorization(headers, 'Bearer');
        } finally {
          lease.release();
        }
      };
    }

    return HttpTransport.connect({
      serverName: name,
      url: declared.url ?? '',
      egress: opts.egress,
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      ...(authorize !== undefined ? { authorize } : {}),
      ...(opts.allowBenchmarkRange !== undefined ? { allowBenchmarkRange: opts.allowBenchmarkRange } : {}),
      ...(opts.lookup ? { lookup: opts.lookup } : {}),
    });
  }

  /** The tool definitions to register. Namespaced already; never a bare name. */
  toolDefinitions(): readonly ToolDefinition[] {
    return this.definitions;
  }

  /** The client for one attached server. Exported for the canary suite. */
  client(name: string): McpClient | undefined {
    return this.clients.get(name);
  }

  /** Server names, for `withForeignTools` and the `/status` line. */
  serverNames(): string[] {
    return this.attached.map((a) => a.name);
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
  }
}
