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
import { McpClient, DEFAULT_CALL_TIMEOUT_MS } from './client.ts';
import { StdioTransport } from './transport-stdio.ts';
import { buildToolDefinitions } from './tool.ts';

export interface McpServiceOptions {
  servers: Record<string, McpServerConfig>;
  backend: ProcessBackend;
  workspaceRoot: CanonicalPath;
  logger?: Logger;
  signal?: AbortSignal;
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
    if (declared.transport === 'http') {
      // Not built. Refused explicitly rather than silently skipped, because a
      // server the user declared and that quietly does not exist is the failure
      // mode ADR-0022 §5 is about — and `optional` still applies above, so a
      // user who wants the session anyway has a documented way to say so.
      throw new KernelErrorException(
        kernelError(
          'CONFIG_INVALID',
          `MCP server "${name}" uses the HTTP transport, which this build does not implement. ` +
            'Only stdio servers can be attached.',
          { blame: 'user', safeDetails: { server: name } },
        ),
      );
    }

    const command = declared.command ?? [];
    const transport = await StdioTransport.start(
      name,
      opts.backend,
      {
        argv: command,
        cwd: opts.workspaceRoot,
        // AGENTS.md rule 8. A server the kernel starts on the user's behalf is a
        // subprocess, and gets no ambient environment for being one.
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

  /** The tool definitions to register. Namespaced already; never a bare name. */
  toolDefinitions(): readonly ToolDefinition[] {
    return this.definitions;
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
