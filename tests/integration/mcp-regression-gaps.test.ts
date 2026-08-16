/**
 * The three rows of §22's regression matrix that nothing covered.
 *
 * Found by auditing the matrix against the suite rather than by a failure, which
 * is the only way this kind of gap surfaces: a row with no test looks exactly
 * like a row that passes.
 *
 *   a stdio server under `--backend container`   §22
 *   a tool call that would touch a protected path §22
 *   the exit code matches ADR-0021                §22's assertion list
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';

import { LocalExecutionBackend } from '../../src/execution/local.ts';
import { McpService } from '../../src/mcp/service.ts';
import { StdioTransport } from '../../src/mcp/transport-stdio.ts';
import { buildToolDefinitions } from '../../src/mcp/tool.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { KernelErrorException } from '../../src/util/errors.ts';
import { EXIT } from '../../src/cli/exit-codes.ts';
import { describeEnforcement, withForeignTools } from '../../src/execution/enforcement.ts';
import type { ProcessSpec } from '../../src/execution/backend.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

const ROOT = process.cwd() as CanonicalPath;
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs');

const backend = new LocalExecutionBackend({ workspaceRoot: ROOT, redactor: new Redactor() });
const services: McpService[] = [];

after(async () => {
  await Promise.all(services.map((s) => s.close()));
  await backend.close();
});

describe('a stdio server under a backend that cannot host one (§22)', () => {
  test('only the local backend implements session(), asserted from source', () => {
    // Structural, and read from the source rather than from an instance: a
    // container or ssh backend cannot be constructed here without Docker or an
    // sshd, and a test that skipped for that reason would be a row that looks
    // like it passes. `ProcessBackend.session` is optional precisely so a
    // backend that cannot host a long-lived process says so by its absence
    // (ADR-0022 §2), and if one of these ever grows one, this fails — which is
    // the point, because the refusal below would silently stop applying.
    const implementers: string[] = [];
    for (const file of ['local.ts', 'container.ts', 'ssh.ts', 'linux-native/backend.ts']) {
      const source = readFileSync(path.join(ROOT, 'src', 'execution', file), 'utf8');
      if (/\basync session\s*\(/.test(source)) implementers.push(file);
    }

    assert.deepEqual(
      implementers,
      ['local.ts'],
      'a backend grew or lost session(); the stdio-under-sandbox story changed',
    );

    // And the instance agrees with the source, so this is not a grep for a
    // comment that happens to look like code.
    assert.equal(typeof backend.process.session, 'function');
  });

  test('a backend without session() refuses, and the message says why', async () => {
    const spec: ProcessSpec = {
      argv: [process.execPath, FIXTURE, '--mode=normal'],
      cwd: ROOT,
      env: {},
      timeoutMs: 10_000,
    };
    // Exactly what a container/ssh backend presents: exec, no session.
    const noSession = { exec: backend.process.exec.bind(backend.process) };

    await assert.rejects(StdioTransport.start('wiki', noSession, spec), (e: unknown) => {
      assert.ok(e instanceof KernelErrorException);
      assert.match(e.kernelError.message, /cannot host a long-lived process/);
      // The §9 sentence, in the product rather than only in the ADR.
      assert.match(e.kernelError.message, /outside the boundary you selected/);
      return true;
    });
  });

  test('NEGATIVE CONTROL: the local backend is not refused', async () => {
    const transport = await StdioTransport.start('wiki', backend.process, {
      argv: [process.execPath, FIXTURE, '--mode=normal'],
      cwd: ROOT,
      env: {},
      timeoutMs: 10_000,
    });
    await transport.close();
  });
});

describe('a tool call that would touch a protected path (§22)', () => {
  test('the kernel does not claim to prevent it, and says so', async () => {
    // The uncomfortable row, and the one the third-party dogfood made concrete:
    // MyCoder's `Read` hard-denies `.env`; a filesystem MCP server reads it.
    //
    // There is no assertion here that the server is stopped, because it is not,
    // and a test asserting otherwise would be the overclaim ADR-0023 §6 exists
    // to prevent. What IS asserted is that the kernel's own account of itself
    // stays honest: the access is `mcp.invoke` and nothing else, the approval
    // says what is not enforced, and the descriptor reports `none`.
    const service = await McpService.start({
      servers: { fs: { transport: 'stdio', command: [process.execPath, FIXTURE, '--mode=normal'] } },
      backend: backend.process,
      workspaceRoot: ROOT,
    });
    services.push(service);

    const [definition] = buildToolDefinitions(service.client('fs')!).definitions;
    const exec = await definition!.resolve({ path: '/etc/passwd' } as never, {} as never);

    // No `file.read` was derived from a path-shaped argument, which is the
    // Derivation Stop; and no `PROTECTED_PATH` machinery was engaged, which is
    // the honest half.
    assert.deepEqual(
      exec.accesses.map((a) => a.kind),
      ['mcp.invoke'],
    );
    assert.match(
      exec.approvalSubject.details.join(' '),
      /does not and cannot enforce what the server then does/,
    );

    const described = describeEnforcement(
      withForeignTools(backend.environment.enforcement, service.serverNames()),
    );
    assert.ok(described.lines.includes('effects inside MCP servers: none'));
  });
});

describe("the exit code matches ADR-0021 (§22's assertion list)", () => {
  test('a bad MCP configuration is CONFIG, not a generic failure', async () => {
    // ADR-0021 made exit codes a contract. An MCP server that will not start is
    // a configuration problem the user can act on, so it must not arrive as the
    // catch-all — a script that retries on 1 and edits config on 3 needs the
    // difference.
    await assert.rejects(
      McpService.start({
        servers: { broken: { transport: 'stdio', command: [process.execPath, '/nonexistent.mjs'] } },
        backend: backend.process,
        workspaceRoot: ROOT,
      }),
      (e: unknown) => {
        assert.ok(e instanceof KernelErrorException);
        assert.equal(e.kernelError.code, 'CONFIG_INVALID');
        return true;
      },
    );

    // And `CONFIG_INVALID` is the code the CLI maps to the documented exit.
    assert.equal(EXIT.CONFIG, 3);
  });

  test('NEGATIVE CONTROL: the exit codes are distinct', () => {
    // Without this, an EXIT table where everything was 3 would pass above.
    assert.notEqual(EXIT.CONFIG, EXIT.OK);
  });
});

describe('a credential on a stdio server (§15)', () => {
  test('is refused, not silently ignored', async () => {
    // The config parses `credential_ref` for both transports, and only HTTP has
    // somewhere to put it. Ignoring it would start the server unauthenticated
    // with nothing said — the "silently loses" failure mode with a secret
    // attached.
    await assert.rejects(
      McpService.start({
        servers: {
          notes: {
            transport: 'stdio',
            command: [process.execPath, FIXTURE, '--mode=normal'],
            credentialRef: 'notes-token',
          },
        },
        backend: backend.process,
        workspaceRoot: ROOT,
      }),
      (e: unknown) => {
        assert.ok(e instanceof KernelErrorException);
        assert.match(e.kernelError.message, /notes-token/, 'the refusal must name the ref');
        assert.match(e.kernelError.message, /will not\s+guess where a secret lands/);
        return true;
      },
    );
  });

  test('NEGATIVE CONTROL: the same server without a credential_ref starts', async () => {
    // Without this, a refusal that fired on every stdio server would pass above.
    const service = await McpService.start({
      servers: {
        notes: { transport: 'stdio', command: [process.execPath, FIXTURE, '--mode=normal'] },
      },
      backend: backend.process,
      workspaceRoot: ROOT,
    });
    services.push(service);
    assert.deepEqual(service.serverNames(), ['notes']);
  });
});
