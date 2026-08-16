/**
 * Configuration to a running server, end to end (ADR-0022 §3-§5).
 *
 * The piece that was missing when the trust layer was first written: every part
 * worked and nothing joined them, so a user could not attach a server at all.
 * These tests go through `McpService`, which is the join — declared servers in,
 * namespaced tool definitions and an honest descriptor out.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { LocalExecutionBackend } from '../../src/execution/local.ts';
import { McpService } from '../../src/mcp/service.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { KernelErrorException } from '../../src/util/errors.ts';
import { createReadTool } from '../../src/tools/builtin/read.ts';
import { describeEnforcement, withForeignTools } from '../../src/execution/enforcement.ts';
import type { McpServerConfig } from '../../src/config/schema.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

const ROOT = process.cwd() as CanonicalPath;
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs');

const backend = new LocalExecutionBackend({ workspaceRoot: ROOT, redactor: new Redactor() });
const services: McpService[] = [];

after(async () => {
  await Promise.all(services.map((s) => s.close()));
  await backend.close();
});

function stdio(mode: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    transport: 'stdio',
    // The fixture reads its behaviour from argv, not the environment, because the
    // environment reaching it is scrubbed — which is the point of the scrubbing.
    command: [process.execPath, FIXTURE, `--mode=${mode}`],
    ...extra,
  };
}

async function start(servers: Record<string, McpServerConfig>): Promise<McpService> {
  const service = await McpService.start({ servers, backend: backend.process, workspaceRoot: ROOT });
  services.push(service);
  return service;
}

describe('a declared server becomes registered tools', () => {
  test('the tools reach a real ToolRegistry under namespaced names', async () => {
    const service = await start({ wiki: stdio('normal') });

    const registry = new ToolRegistry();
    registry.register(createReadTool());
    for (const d of service.toolDefinitions()) registry.register(d);

    assert.deepEqual(registry.names(), ['Read', 'mcp__wiki__echo']);
    assert.deepEqual(service.serverNames(), ['wiki']);
  });

  test('a server offering Read does not collide with the builtin', async () => {
    // The end-to-end form of the Shadow Stop: not "the composer produces a safe
    // name" but "the registry ends up with both, distinguishable".
    const service = await start({ hostile: stdio('shadow') });

    const registry = new ToolRegistry();
    registry.register(createReadTool());
    for (const d of service.toolDefinitions()) registry.register(d);

    assert.ok(registry.has('Read'));
    assert.ok(registry.has('mcp__hostile__Read'));
    assert.notEqual(registry.get('Read'), registry.get('mcp__hostile__Read'));
  });

  test('the reserved namespace cannot be overwritten', async () => {
    const service = await start({ wiki: stdio('normal') });
    const registry = new ToolRegistry();
    for (const d of service.toolDefinitions()) registry.register(d);

    // `register` refuses a duplicate; `override` is the method that overwrites,
    // and it is the one that could have been the way a builtin got replaced.
    assert.throws(
      () => registry.override({ ...createReadTool(), name: 'mcp__wiki__echo' }),
      /refusing to override/,
    );
  });

  test('NEGATIVE CONTROL: override still works outside the namespace', async () => {
    // Without this, an `override` that threw unconditionally would pass the row
    // above while breaking profile narrowing.
    const registry = new ToolRegistry();
    registry.register(createReadTool());
    registry.override({ ...createReadTool(), description: 'narrowed' });
    assert.match(registry.get('Read')!.description, /narrowed/);
  });
});

describe('a server that will not start (ADR-0022 §5)', () => {
  test('refuses the session by default, naming the server and the remedy', async () => {
    await assert.rejects(
      McpService.start({
        servers: { broken: { transport: 'stdio', command: [process.execPath, '/nonexistent.mjs'] } },
        backend: backend.process,
        workspaceRoot: ROOT,
      }),
      (e: unknown) => {
        assert.ok(e instanceof KernelErrorException);
        assert.equal(e.kernelError.code, 'CONFIG_INVALID');
        assert.match(e.kernelError.message, /broken/, 'the refusal must name the server');
        assert.match(e.kernelError.message, /optional = true/, 'and say what to do about it');
        return true;
      },
    );
  });

  test('`optional = true` starts the session without it, loudly', async () => {
    const service = await start({
      broken: { transport: 'stdio', command: [process.execPath, '/nonexistent.mjs'], optional: true },
    });

    assert.deepEqual(service.serverNames(), []);
    assert.deepEqual(service.toolDefinitions(), []);
    assert.ok(
      service.warnings.some((w) => /broken/.test(w) && /without it/.test(w)),
      'a session that silently lost half its catalogue is the failure mode this avoids',
    );
  });

  test('one failing server does not leave the others half-attached', async () => {
    // The teardown that matters: refusing after starting a stdio server would
    // leak the process the refusal exists to avoid.
    await assert.rejects(
      McpService.start({
        servers: {
          aaa: stdio('normal'),
          zzz: { transport: 'stdio', command: [process.execPath, '/nonexistent.mjs'] },
        },
        backend: backend.process,
        workspaceRoot: ROOT,
      }),
      /zzz/,
    );
  });

  test('an HTTP server with no egress gate is refused, not routed around', async () => {
    // There is not supposed to be another way to the network (AGENTS.md rule 9),
    // so a session that cannot offer the gate does not offer the server.
    await assert.rejects(
      McpService.start({
        servers: { tickets: { transport: 'http', url: 'https://tickets.example.com/mcp' } },
        backend: backend.process,
        workspaceRoot: ROOT,
      }),
      (e: unknown) => {
        assert.ok(e instanceof KernelErrorException);
        assert.match(e.kernelError.message, /no path to the network that goes around it/);
        return true;
      },
    );
  });
});

describe('the descriptor a session actually reports', () => {
  test('attaching a server changes what /status is allowed to say', async () => {
    const service = await start({ wiki: stdio('normal') });
    const described = describeEnforcement(
      withForeignTools(backend.environment.enforcement, service.serverNames()),
    );

    assert.ok(described.lines.includes('effects inside MCP servers: none'));
    assert.match(described.caveat, /wiki/);
  });

  test('NEGATIVE CONTROL: with no servers, /status says nothing about them', async () => {
    const service = await start({});
    const described = describeEnforcement(
      withForeignTools(backend.environment.enforcement, service.serverNames()),
    );

    assert.equal(
      described.lines.some((l) => /MCP/.test(l)),
      false,
    );
  });
});
