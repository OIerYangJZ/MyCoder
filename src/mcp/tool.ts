/**
 * A foreign tool, as the kernel's tool contract sees it (ADR-0023, ADR-0024).
 *
 * This file is short, and that is the design. Every builtin tool's `resolve()`
 * is mostly derivation work — canonicalising a path, parsing an argv, resolving
 * a host — because the kernel understands the arguments. Here it understands
 * none of them, so there is nothing to derive and nothing to be clever about:
 * one `mcp.invoke` access, built from the server name and the tool name, both of
 * which the kernel already knew before the model said anything.
 *
 * The shortness is the security property. There is no branch here that a tool
 * description could influence, because there is no code path from the
 * description to the access at all.
 */

import { errorResult, okResult, type ToolDefinition, type ToolExecution } from '../tools/contract.ts';
import type { McpInvokeAccess } from '../policy/access.ts';
import type { JsonSchema } from '../util/jsonschema.ts';
import { KernelErrorException } from '../util/errors.ts';
import type { McpClient } from './client.ts';
import { composeToolName, labelDescription } from './naming.ts';
import type { ListedTool } from './protocol.ts';

/** A tool that was listed but could not be registered, and why. */
export interface RejectedTool {
  tool: string;
  reason: string;
}

export interface BuildResult {
  definitions: ToolDefinition[];
  rejected: RejectedTool[];
}

/**
 * The access request for one call. Exported so the test that proves a
 * description cannot influence it can call it directly.
 */
export function accessFor(client: McpClient, tool: string): McpInvokeAccess {
  return {
    kind: 'mcp.invoke',
    server: client.serverName,
    tool,
    transport: client.transportKind,
    display: `${client.serverName}/${tool}`,
  };
}

/**
 * Turn a server's frozen catalogue into tool definitions.
 *
 * A tool whose name cannot be namespaced is **rejected**, not sanitised, and the
 * rejection is returned rather than thrown: one bad name must not cost the other
 * thirty tools, and the caller surfaces the list.
 */
export function buildToolDefinitions(client: McpClient): BuildResult {
  const definitions: ToolDefinition[] = [];
  const rejected: RejectedTool[] = [];

  for (const listed of client.tools()) {
    const named = composeToolName(client.serverName, listed.name);
    if (!named.ok) {
      rejected.push({ tool: listed.name, reason: named.reason });
      continue;
    }
    definitions.push(defineForeignTool(client, listed, named.name));
  }

  return { definitions, rejected };
}

function defineForeignTool(client: McpClient, listed: ListedTool, name: string): ToolDefinition {
  return {
    name,
    description: labelDescription(client.serverName, listed.description),
    inputSchema: coerceSchema(listed.inputSchema),
    // Deferred, like everything discovered rather than built in (spec §9.3): a
    // large foreign schema set must not be re-serialised into every request.
    disclosure: 'deferred',
    // NEVER true. `readOnly` here would be the server's claim about itself, and
    // ADR-0023 §2 is that those are worth nothing. It also gates parallel
    // execution, so a wrong answer would let two opaque calls race.
    readOnly: false,

    async resolve(args, ctx): Promise<ToolExecution> {
      const access = accessFor(client, listed.name);

      return {
        // Exactly one, and never a builtin capability. A `file.write` on this
        // path could only have come from the server's description of itself
        // (ADR-0023 §5).
        accesses: [access],
        approvalSubject: {
          key: `mcp.invoke:${client.serverName}/${listed.name}`,
          title: `Call "${listed.name}" on MCP server "${client.serverName}"`,
          details: [
            `transport: ${client.transportKind}`,
            'MyCoder decides whether this server may be asked to run this tool.',
            'It does not and cannot enforce what the server then does — files it touches, ' +
              'hosts it reaches and processes it starts are outside every boundary in /status.',
          ],
          // Not derived from anything the server said. There is no input under
          // which this is `low`.
          risk: 'high',
        },
        display: {
          title: `${client.serverName}/${listed.name}`,
          summary: `call a tool MyCoder did not write, on MCP server "${client.serverName}"`,
        },

        async execute(_executor, signal) {
          try {
            const result = await client.callTool(listed.name, args, signal);
            const labelled = `[output from MCP server "${client.serverName}" — untrusted]\n${result.text}`;
            return result.isError
              ? errorResult('TOOL_FAILED', labelled)
              : okResult(labelled, { metadata: { server: client.serverName, tool: listed.name } });
          } catch (err) {
            // Named, attributable, and the turn survives (§16). A model told
            // "the wiki server timed out" can try something else; one told
            // "an error occurred" retries the same call.
            if (err instanceof KernelErrorException) {
              return errorResult(
                err.kernelError.code,
                `MCP server "${client.serverName}", tool "${listed.name}": ${err.kernelError.message}`,
              );
            }
            throw err;
          }
        },
      };
    },
  } as ToolDefinition;
}

/**
 * Accept the server's schema if it is object-shaped, otherwise substitute an
 * empty one.
 *
 * Not validated beyond that on purpose. The schema is used to check the model's
 * arguments before they are sent and to render the tool; it authorises nothing
 * (ADR-0023 §2), so a weird-but-parseable schema is the server's problem to have
 * rather than a reason to refuse the tool.
 */
function coerceSchema(raw: unknown): JsonSchema {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as JsonSchema;
  }
  return { type: 'object', properties: {} } as JsonSchema;
}
