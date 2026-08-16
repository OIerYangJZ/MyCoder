/**
 * HTTP MCP is egress (ADR-0022 §1, alpha.9 §10, §22).
 *
 * The four things that must agree before a byte leaves, each asked separately,
 * and each with a reverse control. There is no real network here: the gate is
 * given a fake transport and a fake resolver, which is what makes it possible to
 * ask "what happens when an allowlisted name resolves to 169.254.169.254"
 * without arranging for a resolver that does.
 *
 * The absence of a real-network arm is deliberate and is the alpha.7 §39-§41 /
 * alpha.8 §24 / alpha.9 §21 non-claim, restated once more: both available hosts
 * NAT public names into RFC 2544 space, so the *positive* control — an
 * allowlisted host whose resolved address is genuinely global, reached under the
 * strict default — still cannot be produced here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultEgressGate, defaultEgressPolicy } from '../../src/security/egress-gate.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { HttpTransport } from '../../src/mcp/transport-http.ts';
import { McpClient } from '../../src/mcp/client.ts';
import { KernelErrorException } from '../../src/util/errors.ts';
import type { EgressResponse } from '../../src/security/egress-gate.ts';
import type { SessionId, TurnId } from '../../src/util/ids.ts';

const SESSION = 'sess-test' as SessionId;
const TURN = 'turn-test' as TurnId;

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A gate with a recording transport and an allowlist the test controls. */
function gateFor(hosts: string[], reply: (msg: { id?: number; method?: string }) => unknown) {
  const sent: Sent[] = [];
  const policy = defaultEgressPolicy();
  policy.mcp = { ...policy.mcp, allowedHosts: hosts };

  const gate = new DefaultEgressGate({
    policy,
    redactor: new Redactor(),
    transport: {
      async send(req): Promise<EgressResponse> {
        sent.push({ url: req.url, headers: req.headers ?? {}, body: req.body ?? '' });
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(reply(JSON.parse(req.body ?? '{}') as { id?: number; method?: string })),
        };
      },
    },
  });

  return { gate, sent };
}

/** A resolver the test controls, so an address scope can be chosen. */
function resolvesTo(address: string) {
  return async () => [{ address, family: address.includes(':') ? 6 : 4 }];
}

function serverReply(msg: { id?: number; method?: string }) {
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } };
  }
  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search' }] } };
  }
  return {
    jsonrpc: '2.0',
    id: msg.id,
    result: { content: [{ type: 'text', text: 'found it' }] },
  };
}

describe('an HTTP server goes through the EgressGate', () => {
  test('a full session works, and every byte went through the gate', async () => {
    const { gate, sent } = gateFor(['tickets.example.com'], serverReply);
    const transport = await HttpTransport.connect({
      serverName: 'tickets',
      url: 'https://tickets.example.com/mcp',
      egress: gate,
      sessionId: SESSION,
      turnId: TURN,
      lookup: resolvesTo('93.184.216.34'),
    });

    const client = new McpClient('tickets', transport);
    await client.start();
    assert.deepEqual(
      client.tools().map((t) => t.name),
      ['search'],
    );

    const result = await client.callTool('search', { q: 'x' });
    assert.match(result.text, /found it/);

    // initialize, initialized (notification), tools/list, tools/call.
    assert.equal(sent.length, 4);
    for (const s of sent) assert.equal(s.url, 'https://tickets.example.com/mcp');
  });

  test('a host that is not allowlisted is refused', async () => {
    const { gate, sent } = gateFor(['tickets.example.com'], serverReply);
    const transport = await HttpTransport.connect({
      serverName: 'evil',
      url: 'https://attacker.example.com/mcp',
      egress: gate,
      sessionId: SESSION,
      turnId: TURN,
      lookup: resolvesTo('93.184.216.34'),
    });

    await assert.rejects(new McpClient('evil', transport).start());
    assert.equal(sent.length, 0, 'the transport must never have been reached');
  });

  test('a host that resolves to a private address is refused before connecting', async () => {
    // §23. An allowlisted name that resolves into private, loopback or metadata
    // space is the one way an approved destination becomes an unapproved one.
    for (const [address, label] of [
      ['127.0.0.1', 'loopback'],
      ['10.0.0.5', 'private'],
      ['169.254.169.254', 'metadata'],
      ['198.18.0.1', 'benchmarking'],
    ] as const) {
      const { gate, sent } = gateFor(['tickets.example.com'], serverReply);
      await assert.rejects(
        HttpTransport.connect({
          serverName: 'tickets',
          url: 'https://tickets.example.com/mcp',
          egress: gate,
          sessionId: SESSION,
          turnId: TURN,
          lookup: resolvesTo(address),
        }),
        (e: unknown) => {
          assert.ok(e instanceof KernelErrorException, `${label} should be refused`);
          assert.equal(e.kernelError.code, 'NETWORK_TARGET_ADDRESS_DENIED');
          assert.match(e.kernelError.message, /tickets/, 'the refusal must name the server');
          return true;
        },
      );
      assert.equal(sent.length, 0, `${label}: nothing may be sent`);
    }
  });

  test('NEGATIVE CONTROL: a global address is NOT refused', async () => {
    // Without this, a check that refused every address would pass the row above
    // while making the HTTP transport unusable — which is exactly the shape of
    // the two unfalsifiable tests alpha.8 found.
    const { gate } = gateFor(['tickets.example.com'], serverReply);
    const transport = await HttpTransport.connect({
      serverName: 'tickets',
      url: 'https://tickets.example.com/mcp',
      egress: gate,
      sessionId: SESSION,
      turnId: TURN,
      lookup: resolvesTo('93.184.216.34'),
    });
    assert.equal(transport.kind, 'http');
  });

  test('a non-HTTP scheme is refused', async () => {
    const { gate } = gateFor(['tickets.example.com'], serverReply);
    await assert.rejects(
      HttpTransport.connect({
        serverName: 'tickets',
        url: 'file:///etc/passwd',
        egress: gate,
        sessionId: SESSION,
        turnId: TURN,
        lookup: resolvesTo('93.184.216.34'),
      }),
      /not HTTP or HTTPS/,
    );
  });
});

describe('the credential never becomes a value this code holds (§15)', () => {
  test('authorize writes the header, and it is the only place the value appears', async () => {
    const { gate, sent } = gateFor(['tickets.example.com'], serverReply);
    const transport = await HttpTransport.connect({
      serverName: 'tickets',
      url: 'https://tickets.example.com/mcp',
      egress: gate,
      sessionId: SESSION,
      turnId: TURN,
      lookup: resolvesTo('93.184.216.34'),
      authorize: async (headers) => {
        headers.authorization = 'Bearer tok-abc';
      },
    });

    const client = new McpClient('tickets', transport);
    await client.start();
    await client.callTool('search', { q: 'x' });

    for (const s of sent) {
      assert.equal(s.headers.authorization, 'Bearer tok-abc');
      // Never in the body. A credential in a tool argument is the route §15
      // forbids first, because the model would have had to see it.
      assert.equal(s.body.includes('tok-abc'), false, 'a credential must never be in the body');
    }
  });

  test('NEGATIVE CONTROL: with no authorize, no authorization header is sent', async () => {
    const { gate, sent } = gateFor(['tickets.example.com'], serverReply);
    const transport = await HttpTransport.connect({
      serverName: 'tickets',
      url: 'https://tickets.example.com/mcp',
      egress: gate,
      sessionId: SESSION,
      turnId: TURN,
      lookup: resolvesTo('93.184.216.34'),
    });
    await new McpClient('tickets', transport).start();

    for (const s of sent) assert.equal(s.headers.authorization, undefined);
  });
});
