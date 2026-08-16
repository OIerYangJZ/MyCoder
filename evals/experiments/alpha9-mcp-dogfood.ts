#!/usr/bin/env node
/**
 * Attach a third-party MCP server nobody here wrote (alpha.9 §5).
 *
 *   node evals/experiments/alpha9-mcp-dogfood.ts
 *
 * Every other MCP test in this repository talks to `tests/fixtures/mcp-server.mjs`,
 * which was written to be tested. That is the right way to produce the hostile
 * cases — five hundred tools, a name that is a number, a catalogue that mutates —
 * and it is exactly the wrong way to find out whether the client works.
 *
 * A server written by someone who never read this kernel will differ in the
 * places nobody thought to parameterise: which protocol revision it negotiates,
 * whether it writes anything to stdout that is not a frame, how it names its
 * tools, what shape its `inputSchema` takes, whether it answers a notification.
 * Those are the defects §25's install dogfood found for packaging, one layer up.
 *
 * `@modelcontextprotocol/server-filesystem` is the reference implementation from
 * the protocol's own authors, fetched from npm at run time. It is deliberately
 * *not* vendored: a copy in this repository would be a copy this repository
 * controls, which defeats the point.
 */

import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LocalExecutionBackend } from '../../src/execution/local.ts';
import { McpService } from '../../src/mcp/service.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { createReadTool } from '../../src/tools/builtin/read.ts';
import { withForeignTools, describeEnforcement } from '../../src/execution/enforcement.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

const SERVER_PACKAGE = '@modelcontextprotocol/server-filesystem';

async function main(): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'mcp-dogfood-'));
  const workspace = path.join(base, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'hello.txt'), 'a file the server can see\n', 'utf8');
  // The canary: a file the *server* can reach and MyCoder's own tools cannot.
  // Its presence in the output is the honest part of this dogfood.
  await writeFile(path.join(workspace, '.env'), 'DOGFOOD_SECRET=must-not-be-claimed-safe\n', 'utf8');

  const backend = new LocalExecutionBackend({
    workspaceRoot: workspace as CanonicalPath,
    redactor: new Redactor(),
  });

  const findings: string[] = [];
  let service: McpService | undefined;

  try {
    service = await McpService.start({
      servers: {
        fs: {
          transport: 'stdio',
          // `npx -y` fetches it. Not vendored, on purpose.
          command: ['npx', '-y', SERVER_PACKAGE, workspace],
          timeoutMs: 60_000,
        },
      },
      backend: backend.process,
      workspaceRoot: workspace as CanonicalPath,
    });

    const client = service.client('fs');
    if (!client) throw new Error('the server attached but no client was recorded');

    findings.push(`protocol: negotiated, ${client.tools().length} tool(s) listed`);
    findings.push(
      `tools: ${client
        .tools()
        .map((t) => t.name)
        .join(', ')}`,
    );
    for (const w of service.warnings) findings.push(`warning: ${w}`);

    // 1. Every name is namespaced, and none can be a builtin.
    const registry = new ToolRegistry();
    registry.register(createReadTool());
    for (const d of service.toolDefinitions()) registry.register(d);

    const foreign = registry.names().filter((n) => n.startsWith('mcp__'));
    findings.push(`registered: ${foreign.length} foreign name(s), Read intact: ${registry.has('Read')}`);
    if (foreign.length === 0) throw new Error('no foreign tool registered; nothing was exercised');

    // 2. Every description is labelled, and none is unbounded.
    const unlabelled = service
      .toolDefinitions()
      .filter((d) => !d.description.startsWith('[foreign tool from MCP server "fs"'));
    findings.push(`unlabelled descriptions: ${unlabelled.length} (must be 0)`);

    const longest = Math.max(...service.toolDefinitions().map((d) => d.description.length));
    findings.push(`longest description: ${longest} chars`);

    // 3. A real call, through the real client.
    const listTool = client.tools().find((t) => /list.*director/i.test(t.name));
    if (listTool) {
      const result = await client.callTool(listTool.name, { path: workspace });
      findings.push(`called ${listTool.name}: ${result.isError ? 'error' : 'ok'}`);
      findings.push(`  saw hello.txt: ${result.text.includes('hello.txt')}`);
      // The uncomfortable line, and the reason this dogfood is worth running.
      findings.push(`  saw .env: ${result.text.includes('.env')}`);
    } else {
      findings.push('no directory-listing tool found; the call step was skipped');
    }

    // 4. What /status is obliged to say now.
    const described = describeEnforcement(
      withForeignTools(backend.environment.enforcement, service.serverNames()),
    );
    findings.push(`descriptor: ${described.lines.find((l) => l.includes('MCP')) ?? 'MISSING'}`);
  } finally {
    await service?.close();
    await backend.close();
    await rm(base, { recursive: true, force: true });
  }

  process.stdout.write(`${findings.join('\n')}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
