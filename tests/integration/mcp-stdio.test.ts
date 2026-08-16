/**
 * A stdio MCP server, spawned for real, through the ExecutionBackend
 * (ADR-0022 §1-§2, alpha.9 §9, §16).
 *
 * The fake-transport suite in `tests/security/mcp-trust.test.ts` covers what the
 * protocol layer does with a hostile answer. This one covers the thing a fake
 * transport cannot: that the bytes actually move, over a real pipe, to a real
 * process the backend started — and that a server which hangs, dies or floods
 * fails the way §16 says rather than the way an unframed pipe would.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { LocalExecutionBackend } from '../../src/execution/local.ts';
import { StdioTransport } from '../../src/mcp/transport-stdio.ts';
import { McpClient } from '../../src/mcp/client.ts';
import { buildToolDefinitions } from '../../src/mcp/tool.ts';
import { scrubEnv } from '../../src/security/env-scrub.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { KernelErrorException } from '../../src/util/errors.ts';
import type { ProcessBackend, ProcessSpec } from '../../src/execution/backend.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

const ROOT = process.cwd() as CanonicalPath;
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs');

const backend = new LocalExecutionBackend({ workspaceRoot: ROOT, redactor: new Redactor() });
const started: StdioTransport[] = [];

after(async () => {
  await Promise.all(started.map((t) => t.close()));
  await backend.close();
});

function spec(mode: string, extraEnv: Record<string, string> = {}): ProcessSpec {
  return {
    argv: [process.execPath, FIXTURE],
    cwd: ROOT,
    // Through `scrubEnv`, like every other subprocess. AGENTS.md rule 8 has no
    // exception for a server the kernel started on the user's behalf.
    env: scrubEnv({ extra: { MYCODER_FIXTURE_MODE: mode, ...extraEnv } }).env,
    timeoutMs: 30_000,
  };
}

async function connect(mode: string, callTimeoutMs = 5_000): Promise<McpClient> {
  const transport = await StdioTransport.start(mode, backend.process, spec(mode));
  started.push(transport);
  const client = new McpClient(mode.replace(/[^a-z-]/g, '') || 'srv', transport, callTimeoutMs);
  await client.start();
  return client;
}

describe('a stdio server is a real subprocess, through the backend', () => {
  test('initialize, tools/list and tools/call all round-trip', async () => {
    const client = await connect('normal');
    assert.deepEqual(
      client.tools().map((t) => t.name),
      ['echo'],
    );

    const result = await client.callTool('echo', { text: 'hello' });
    assert.equal(result.isError, false);
    assert.match(result.text, /echo: hello/);
  });

  test('the tool the model sees is namespaced and labelled', async () => {
    const client = await connect('normal');
    const { definitions } = buildToolDefinitions(client);

    assert.equal(definitions[0]!.name, 'mcp__normal__echo');
    assert.match(definitions[0]!.description, /is not verified by MyCoder/);
    assert.match(definitions[0]!.description, /Echo the text back\./);
  });

  test('a server offering Read, Shell and Delegate shadows none of them', async () => {
    const client = await connect('shadow');
    const names = buildToolDefinitions(client).definitions.map((d) => d.name);
    assert.deepEqual(names, ['mcp__shadow__Read', 'mcp__shadow__Shell', 'mcp__shadow__Delegate']);
  });

  test('a backend with no session() is refused, not worked around', async () => {
    // The §9 property, and the one that is easiest to quietly get wrong: a
    // backend that cannot host a long-lived process must not cause the server to
    // be spawned somewhere else.
    const noSession: ProcessBackend = { exec: backend.process.exec.bind(backend.process) };

    await assert.rejects(StdioTransport.start('wiki', noSession, spec('normal')), (e: unknown) => {
      assert.ok(e instanceof KernelErrorException);
      assert.equal(e.kernelError.code, 'CONFIG_INVALID');
      assert.match(e.kernelError.message, /refuses rather than spawning it outside the backend/);
      return true;
    });
  });

  test('NEGATIVE CONTROL: the same spec on a backend WITH session() starts', async () => {
    // Without this, a `start` that always threw would pass the test above.
    const transport = await StdioTransport.start('wiki', backend.process, spec('normal'));
    started.push(transport);
    const client = new McpClient('wiki', transport);
    assert.equal((await client.start()).tools.length, 1);
  });
});

describe('a stdio server that misbehaves (§16)', () => {
  test('one that never answers times out, and the turn survives', async () => {
    const client = await connect('hang', 1_000);
    await assert.rejects(client.callTool('echo', { text: 'x' }), (e: unknown) => {
      assert.ok(e instanceof KernelErrorException);
      assert.equal(e.kernelError.code, 'TOOL_TIMEOUT');
      assert.match(e.kernelError.message, /did not answer/);
      return true;
    });

    // The turn survives: the client is still usable and a later call is not
    // poisoned by the abandoned one.
    assert.equal(client.isUsable, true);
  });

  test('one that dies mid-call fails that call, naming the server', async () => {
    const client = await connect('die');
    await assert.rejects(client.callTool('echo', { text: 'x' }), (e: unknown) => {
      assert.ok(e instanceof KernelErrorException);
      assert.equal(e.kernelError.code, 'TOOL_FAILED');
      assert.match(e.kernelError.message, /is not running/);
      return true;
    });
  });

  test('one that floods without framing is cut off rather than buffered', async () => {
    const client = await connect('flood', 5_000);
    await assert.rejects(client.callTool('echo', { text: 'x' }));
  });

  test('a cancelled turn aborts the call in flight', async () => {
    const client = await connect('hang', 30_000);
    const controller = new AbortController();
    const inFlight = client.callTool('echo', { text: 'x' }, controller.signal);
    controller.abort();

    await assert.rejects(inFlight, (e: unknown) => {
      assert.ok(e instanceof KernelErrorException);
      assert.match(e.kernelError.message, /cancelled/);
      return true;
    });
  });
});

describe('the environment a server is given (§15)', () => {
  test('a credential-shaped variable in the ambient environment does not reach it', async () => {
    // The property AGENTS.md rule 8 exists for, asked of the server rather than
    // of `scrubEnv`: the server itself reports what it received.
    process.env.MCP_FIXTURE_CANARY_TOKEN = 'sk-live-canary-must-not-appear';
    try {
      const client = await connect('echo-env');
      const result = await client.callTool('dump_env', {});

      assert.equal(
        result.text.includes('sk-live-canary-must-not-appear'),
        false,
        'a credential in the ambient environment reached an MCP server',
      );
      assert.equal(result.text.includes('MCP_FIXTURE_CANARY_TOKEN'), false);
    } finally {
      delete process.env.MCP_FIXTURE_CANARY_TOKEN;
    }
  });

  test('NEGATIVE CONTROL: the echo-env fixture can see what it IS given', async () => {
    // Without this, a fixture that returned '{}' would prove the assertion above
    // no matter what the kernel did.
    const client = await connect('echo-env');
    const result = await client.callTool('dump_env', {});
    assert.match(result.text, /MYCODER_FIXTURE_MODE/);
  });
});
