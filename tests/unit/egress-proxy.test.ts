/**
 * Egress proxy: HTTP parsing, policy decisions and the wire behaviour
 * (alpha.6 §21–§34, §58, §60, §76).
 *
 * The proxy's decisions are pure functions, so the interesting properties can be
 * asserted directly rather than inferred from a socket that closed. §59 is
 * explicit that a failure for the wrong reason is not evidence, and a decision
 * function that returns a *reason code* is what makes "denied because the
 * resolved address classified as metadata" an assertable fact.
 *
 * The last suite runs a real proxy over loopback with an injected resolver and
 * dialler, so the end-to-end path — parse, decide, resolve, connect, relay — is
 * exercised without the test needing a container, a public name or the network.
 * Every security assertion in it is paired with a positive control, per §3.2:
 * a denial only proves something if the same setup lets the allowed case through.
 */

import { strict as assert } from 'node:assert';
import { describe, it, after } from 'node:test';
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';

import {
  buildProxyPolicy,
  normalizeNetworkMode,
  parseProxyPolicy,
  MAX_POLICY_HOSTS,
  type ProxyPolicy,
} from '../../src/security/egress/network-mode.ts';
import {
  decideAddress,
  decideAuthorityAgreement,
  decideDestination,
  decideSni,
  errorCodeFor,
} from '../../src/security/egress-proxy/decide.ts';
import {
  buildOriginRequest,
  checkFraming,
  parseAbsoluteTarget,
  parseConnectTarget,
  parseRequestHead,
  singleHostHeader,
  MAX_HEADERS,
} from '../../src/security/egress-proxy/http.ts';
import { EgressProxy, type EgressAuditRecord } from '../../src/security/egress-proxy/proxy.ts';

// --- network mode semantics (§9) -------------------------------------------

describe('network mode normalisation (§9)', () => {
  it('maps the three profile shapes onto the three modes', () => {
    assert.equal(normalizeNetworkMode(false).mode.kind, 'deny-all');
    assert.equal(normalizeNetworkMode({ hosts: ['a.example'] }).mode.kind, 'allowlist');
    assert.equal(normalizeNetworkMode({ unrestricted: true }).mode.kind, 'unrestricted');
  });

  it('refuses an empty host list instead of reading it as "the internet"', () => {
    // The alpha.5 bug this exists to prevent: `network !== false` treated
    // `{ hosts: [] }` as a grant, so an allowlist that narrowed to nothing
    // widened to everything.
    const result = normalizeNetworkMode({ hosts: [] });
    assert.equal(result.ok, false);
    assert.equal(result.mode.kind, 'deny-all');
    assert.match(result.problems[0]!, /not a valid network grant/);
  });

  it('refuses an over-long host list rather than keeping the first N (§60)', () => {
    const hosts = Array.from({ length: MAX_POLICY_HOSTS + 1 }, (_, i) => `h${i}.example`);
    const result = normalizeNetworkMode({ hosts });
    assert.equal(result.ok, false);
    assert.equal(result.mode.kind, 'deny-all');
  });

  it('refuses the whole grant when one host is unusable, rather than narrowing silently', () => {
    const result = normalizeNetworkMode({ hosts: ['good.example', 'bad host'] });
    assert.equal(result.ok, false);
    assert.equal(result.mode.kind, 'deny-all');
  });

  it('normalises, de-duplicates and sorts the host set so the subject is a value', () => {
    const result = normalizeNetworkMode({ hosts: ['B.example.', 'a.example', 'b.example'] });
    assert.equal(result.ok, true);
    assert.equal(result.mode.kind, 'allowlist');
    const hosts = (result.mode as Extract<typeof result.mode, { kind: 'allowlist' }>).targets.map(
      (t) => t.host,
    );
    assert.deepEqual(hosts, ['a.example', 'b.example']);
  });

  it('round-trips through the serialised policy the sidecar reads', () => {
    const mode = normalizeNetworkMode({ hosts: ['registry.npmjs.org'] }).mode;
    const policy = buildProxyPolicy({ executionId: 'exec-1', mode });
    const parsed = parseProxyPolicy(JSON.stringify(policy));
    assert.equal(parsed.ok, true);
    assert.deepEqual((parsed as { policy: ProxyPolicy }).policy.targets[0]!.ports, [80, 443]);
  });

  it('rejects a policy document naming a port outside the enforced scope', () => {
    // The sidecar re-validates rather than trusting the file it was handed.
    const doc = JSON.stringify({
      version: 1,
      executionId: 'e',
      targets: [{ host: 'a.example', ports: [22], protocols: ['https'] }],
    });
    const parsed = parseProxyPolicy(doc);
    assert.equal(parsed.ok, false);
    assert.match((parsed as { reason: string }).reason, /outside the enforced HTTP\/HTTPS scope/);
  });
});

// --- HTTP parsing (§26, §34, §60) ------------------------------------------

const head = (text: string) => parseRequestHead(Buffer.from(text, 'latin1'));

describe('HTTP request head parsing (§26)', () => {
  it('parses an absolute-form proxy request', () => {
    const r = head('GET http://a.example/p?q=1 HTTP/1.1\r\nHost: a.example\r\n\r\n');
    assert.equal(r.kind, 'ok');
    const target = parseAbsoluteTarget((r as { head: { target: string } }).head.target);
    assert.equal(target.ok, true);
    assert.equal((target as { target: { host: string } }).target.host, 'a.example');
    assert.equal((target as { target: { pathAndQuery: string } }).target.pathAndQuery, '/p?q=1');
  });

  it('refuses origin-form, where the destination would come from a header', () => {
    const r = head('GET /p HTTP/1.1\r\nHost: a.example\r\n\r\n');
    assert.equal(r.kind, 'ok');
    const target = parseAbsoluteTarget((r as { head: { target: string } }).head.target);
    assert.equal(target.ok, false);
  });

  it('refuses userinfo and backslashes in the authority', () => {
    assert.equal(parseAbsoluteTarget('http://user@evil.example/').ok, false);
    assert.equal(parseAbsoluteTarget('http://a.example\\@evil.example/').ok, false);
  });

  it('sends https absolute-form to CONNECT rather than terminating TLS', () => {
    const r = parseAbsoluteTarget('https://a.example/');
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /CONNECT/);
  });

  it('rejects header smuggling primitives', () => {
    assert.equal(head('GET http://a.example/ HTTP/1.1\r\nHost : a.example\r\n\r\n').kind, 'error');
    assert.equal(head('GET http://a.example/ HTTP/1.1\r\nHost: a.example\r\n\tfolded\r\n\r\n').kind, 'error');
    assert.equal(head('GET http://a.example/ HTTP/1.1\r\n\r\n').kind, 'ok');
    assert.equal(head('GET http://a.example/ HTTP/2.0\r\nHost: a\r\n\r\n').kind, 'error');
    assert.equal(head('GET  http://a.example/  HTTP/1.1\r\nHost: a\r\n\r\n').kind, 'error');
  });

  it('refuses more headers than the budget rather than dropping the excess (§60)', () => {
    const many = Array.from({ length: MAX_HEADERS + 5 }, (_, i) => `X-H${i}: v`).join('\r\n');
    const r = head(`GET http://a.example/ HTTP/1.1\r\nHost: a.example\r\n${many}\r\n\r\n`);
    assert.equal(r.kind, 'error');
    assert.equal((r as { status: number }).status, 431);
  });

  it('waits for a complete head rather than deciding on a prefix', () => {
    assert.equal(head('GET http://a.example/ HTTP/1.1\r\nHost: a.exa').kind, 'incomplete');
  });

  it('rejects conflicting framing headers', () => {
    const withBoth = head(
      'POST http://a.example/ HTTP/1.1\r\nHost: a.example\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n',
    );
    assert.equal(withBoth.kind, 'ok');
    const framing = checkFraming((withBoth as { head: Parameters<typeof checkFraming>[0] }).head);
    assert.equal(framing.ok, false);
  });

  it('requires exactly one Host header', () => {
    const two = head('GET http://a.example/ HTTP/1.1\r\nHost: a.example\r\nHost: b.example\r\n\r\n');
    const result = singleHostHeader((two as { head: Parameters<typeof singleHostHeader>[0] }).head);
    assert.equal(result.ok, false);
  });

  it('parses CONNECT authority-form and refuses a defaulted port', () => {
    assert.deepEqual(parseConnectTarget('a.example:443'), { ok: true, host: 'a.example', port: 443 });
    assert.equal(parseConnectTarget('a.example').ok, false);
    assert.equal(parseConnectTarget('http://a.example:443').ok, false);
    assert.deepEqual(parseConnectTarget('[2001:db8::1]:443'), { ok: true, host: '[2001:db8::1]', port: 443 });
  });

  it('strips hop-by-hop headers and the proxy credential when forwarding', () => {
    const parsed = head(
      'GET http://a.example/p HTTP/1.1\r\nHost: a.example\r\nProxy-Authorization: Basic xx\r\n' +
        'Connection: X-Secret\r\nX-Secret: leak\r\nAccept: */*\r\n\r\n',
    );
    const h = (parsed as { head: Parameters<typeof buildOriginRequest>[0] }).head;
    const target = (parseAbsoluteTarget(h.target) as { target: Parameters<typeof buildOriginRequest>[1] })
      .target;
    const out = buildOriginRequest(h, target, 'a.example').toString('latin1');
    assert.match(out, /^GET \/p HTTP\/1\.1/);
    assert.ok(!out.toLowerCase().includes('proxy-authorization'));
    assert.ok(!out.includes('X-Secret: leak'));
    assert.match(out, /Accept: \*\/\*/);
    assert.match(out, /Connection: close/);
  });
});

// --- decisions (§21–§34) ---------------------------------------------------

const policyFor = (hosts: string[], allowPrivate = false): ProxyPolicy =>
  buildProxyPolicy({
    executionId: 'exec-test',
    mode: normalizeNetworkMode({ hosts }).mode,
    allowPrivateAddresses: allowPrivate,
  });

describe('destination decisions (§21, §22, §33)', () => {
  const policy = policyFor(['registry.npmjs.org']);

  it('allows the exact approved host on 80 and 443', () => {
    assert.equal(decideDestination(policy, 'registry.npmjs.org', 443, 'https').allowed, true);
    assert.equal(decideDestination(policy, 'registry.npmjs.org', 80, 'http').allowed, true);
  });

  it('treats a trailing dot and a case difference as the same approved host', () => {
    assert.equal(decideDestination(policy, 'Registry.NPMJS.org.', 443, 'https').allowed, true);
  });

  it('denies every near-miss of the approved host (§21)', () => {
    for (const host of [
      'foo.registry.npmjs.org',
      'npmjs.org',
      'evilregistry.npmjs.org',
      'registry.npmjs.org.evil.com',
    ]) {
      const d = decideDestination(policy, host, 443, 'https');
      assert.equal(d.allowed, false, host);
      assert.equal(d.reason, 'host-not-allowed', host);
    }
  });

  it('distinguishes a denied host from an approved host on a denied port (§33)', () => {
    // The distinction is what makes the CONNECT-to-22 test assert a mechanism.
    const wrongPort = decideDestination(policy, 'registry.npmjs.org', 22, 'https');
    assert.equal(wrongPort.allowed, false);
    assert.equal(wrongPort.reason, 'port-not-allowed');
    assert.equal(errorCodeFor(wrongPort.reason), 'NETWORK_SCOPE_DENIED');
  });

  it('denies a host that cannot be normalised at all', () => {
    const d = decideDestination(policy, 'reg istry.npmjs.org', 443, 'https');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'host-not-normalizable');
  });
});

describe('address decisions (§23, §24)', () => {
  const policy = policyFor(['rebind.example']);

  it('allows a global address', () => {
    assert.equal(decideAddress(policy, 'rebind.example', '93.184.216.34').allowed, true);
  });

  it('denies an approved host that resolves into private space, naming the scope', () => {
    // This is the DNS rebinding defence. The *host* is approved; the address is
    // not, and the reason code proves which check fired.
    for (const [address, scope] of [
      ['127.0.0.1', 'loopback'],
      ['169.254.169.254', 'metadata'],
      ['10.0.0.5', 'private'],
      ['::1', 'loopback'],
    ] as Array<[string, string]>) {
      const d = decideAddress(policy, 'rebind.example', address);
      assert.equal(d.allowed, false, address);
      assert.equal(d.reason, 'address-not-global', address);
      assert.equal(d.addressScope, scope, address);
      assert.equal(errorCodeFor(d.reason), 'NETWORK_TARGET_ADDRESS_DENIED');
    }
  });

  it('permits private addresses only when the test-only flag is set (§56)', () => {
    // The contrast control for the private-IP row of §58: the same address, the
    // same host, and a policy that explicitly opted in.
    const testPolicy = policyFor(['rebind.example'], true);
    assert.equal(decideAddress(testPolicy, 'rebind.example', '10.0.0.5').allowed, true);
    assert.equal(decideAddress(policy, 'rebind.example', '10.0.0.5').allowed, false);
  });
});

describe('HTTP authority agreement (§34)', () => {
  it('agrees when the target and the Host header name the same destination', () => {
    assert.equal(decideAuthorityAgreement('a.example', 80, 'a.example').allowed, true);
    assert.equal(decideAuthorityAgreement('a.example', 80, 'A.Example.').allowed, true);
    assert.equal(decideAuthorityAgreement('a.example', 8080, 'a.example:8080').allowed, true);
  });

  it('refuses a mismatch in both directions rather than preferring a field', () => {
    const forward = decideAuthorityAgreement('a.example', 80, 'denied.example');
    assert.equal(forward.allowed, false);
    assert.equal(forward.reason, 'authority-mismatch');
    const reverse = decideAuthorityAgreement('denied.example', 80, 'a.example');
    assert.equal(reverse.allowed, false);
    assert.equal(reverse.reason, 'authority-mismatch');
  });

  it('refuses a port disagreement', () => {
    assert.equal(decideAuthorityAgreement('a.example', 80, 'a.example:8080').allowed, false);
  });
});

describe('SNI decisions (§28–§31)', () => {
  const domain = 'allowed.example';

  it('allows a ClientHello whose server name matches the CONNECT authority', () => {
    const d = decideSni(domain, 'domain', {
      kind: 'sni',
      serverName: 'allowed.example',
      encryptedClientHello: false,
    });
    assert.equal(d.allowed, true);
  });

  it('normalises before comparing, so a trailing dot is not a false mismatch', () => {
    const d = decideSni(domain, 'domain', {
      kind: 'sni',
      serverName: 'Allowed.Example.',
      encryptedClientHello: false,
    });
    assert.equal(d.allowed, true);
  });

  it('denies the shared-IP virtual host attack (§28)', () => {
    const d = decideSni(domain, 'domain', {
      kind: 'sni',
      serverName: 'denied.example',
      encryptedClientHello: false,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'sni-mismatch');
    assert.equal(errorCodeFor(d.reason), 'NETWORK_IDENTITY_MISMATCH');
  });

  it('fails closed on every unverifiable ClientHello (§29, §30, §31)', () => {
    const cases: Array<[Parameters<typeof decideSni>[2], string]> = [
      [{ kind: 'no-sni', encryptedClientHello: false }, 'sni-missing'],
      [{ kind: 'malformed', reason: 'x' }, 'sni-malformed'],
      [{ kind: 'not-tls', reason: 'x' }, 'sni-malformed'],
      [{ kind: 'not-client-hello', reason: 'x' }, 'sni-malformed'],
      [{ kind: 'too-large' }, 'sni-too-large'],
      [{ kind: 'incomplete' }, 'sni-missing'],
      [{ kind: 'sni', serverName: 'allowed.example', encryptedClientHello: true }, 'sni-encrypted'],
    ];
    for (const [hello, reason] of cases) {
      const d = decideSni(domain, 'domain', hello);
      assert.equal(d.allowed, false, reason);
      assert.equal(d.reason, reason);
    }
  });

  it('does not require an SNI for an approved IP-literal target', () => {
    // An address has no domain identity; demanding one would break a legitimate
    // target without adding a check that means anything.
    const d = decideSni('93.184.216.34', 'ipv4', { kind: 'no-sni', encryptedClientHello: false });
    assert.equal(d.allowed, true);
  });

  it('still denies ECH on an IP target, because the name is hidden either way', () => {
    const d = decideSni('93.184.216.34', 'ipv4', {
      kind: 'sni',
      serverName: 'x.example',
      encryptedClientHello: true,
    });
    assert.equal(d.allowed, false);
  });
});

// --- end to end over loopback (§58 reverse controls) -----------------------

describe('proxy wire behaviour with paired controls (§3.2, §58)', () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  after(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });

  /** An origin server that answers everything with its own name. */
  async function origin(name: string): Promise<{ port: number; hits: number }> {
    const state = { port: 0, hits: 0 };
    const server: Server = createServer((socket) => {
      socket.on('data', () => {
        state.hits += 1;
        const body = `served-by:${name}`;
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    state.port = typeof address === 'object' && address !== null ? address.port : 0;
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return state;
  }

  /**
   * A proxy whose resolver and dialler are pinned to loopback fixtures.
   *
   * The seams exist because §58's controls need an attack that is *real*: to
   * prove the rebinding defence fires, a name has to actually resolve to
   * 127.0.0.1, and no test suite can own a public zone that does that.
   */
  async function proxyFor(opts: {
    hosts: string[];
    resolve: Record<string, string[]>;
    dialPort?: number;
    allowPrivate?: boolean;
  }): Promise<{ port: number; audit: EgressAuditRecord[] }> {
    const audit: EgressAuditRecord[] = [];
    const proxy = new EgressProxy({
      policy: policyFor(opts.hosts, opts.allowPrivate ?? false),
      audit: (record) => audit.push(record),
      resolve: async (host) => opts.resolve[host] ?? [],
      // Everything that is allowed to connect lands on the loopback fixture, so
      // an "allowed" decision is observable as a real HTTP exchange.
      dial: (_address, _port) => netConnect({ host: '127.0.0.1', port: opts.dialPort ?? 1 }),
    });
    const running = await proxy.listen(0, '127.0.0.1');
    cleanup.push(() => running.close());
    return { port: running.port, audit };
  }

  /** Speak to the proxy directly: no client library, so nothing is normalised. */
  function speak(port: number, request: string, extra?: Buffer): Promise<string> {
    return new Promise((resolve) => {
      const socket: Socket = netConnect({ host: '127.0.0.1', port });
      let out = '';
      socket.setTimeout(5_000, () => socket.destroy());
      socket.on('connect', () => {
        socket.write(request);
        if (extra) setTimeout(() => socket.write(extra), 50);
      });
      socket.on('data', (chunk: Buffer) => {
        out += chunk.toString('latin1');
      });
      socket.on('close', () => resolve(out));
      socket.on('error', () => resolve(out));
      socket.on('timeout', () => resolve(out));
    });
  }

  it('allowed host succeeds and denied host fails, with the sink proven live', async () => {
    const allowed = await origin('allowed');
    const proxy = await proxyFor({
      hosts: ['allowed.test'],
      resolve: { 'allowed.test': ['93.184.216.34'], 'denied.test': ['93.184.216.35'] },
      dialPort: allowed.port,
    });

    // Positive control: the path works.
    const good = await speak(proxy.port, 'GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n');
    assert.match(good, /200 OK/);
    assert.match(good, /served-by:allowed/);

    // Attack: same proxy, same sink, different host.
    const bad = await speak(proxy.port, 'GET http://denied.test/ HTTP/1.1\r\nHost: denied.test\r\n\r\n');
    assert.match(bad, /403 Forbidden/);
    assert.match(bad, /X-Mycoder-Egress-Reason: host-not-allowed/);

    // Contrast: the sink served exactly one request, so the denial was a denial
    // and not a broken fixture.
    assert.equal(allowed.hits, 1);

    const denials = proxy.audit.filter((r) => r.decision === 'denied');
    assert.equal(denials.length, 1);
    assert.equal(denials[0]!.reason, 'host-not-allowed');
    assert.equal(denials[0]!.host, 'denied.test');
  });

  it('refuses a Host header that disagrees with the approved absolute target', async () => {
    const allowed = await origin('allowed');
    const proxy = await proxyFor({
      hosts: ['allowed.test'],
      resolve: { 'allowed.test': ['93.184.216.34'] },
      dialPort: allowed.port,
    });

    const mismatch = await speak(
      proxy.port,
      'GET http://allowed.test/ HTTP/1.1\r\nHost: denied.test\r\n\r\n',
    );
    assert.match(mismatch, /400 Bad Request/);
    assert.match(mismatch, /authority-mismatch/);
    assert.equal(allowed.hits, 0, 'a mismatched request must not reach any origin');
  });

  it('denies an approved host that rebinds to loopback, and names the scope', async () => {
    const allowed = await origin('allowed');
    const proxy = await proxyFor({
      hosts: ['rebind.test'],
      // The host is approved. The address is the attack.
      resolve: { 'rebind.test': ['127.0.0.1'] },
      dialPort: allowed.port,
    });

    const response = await speak(proxy.port, 'GET http://rebind.test/ HTTP/1.1\r\nHost: rebind.test\r\n\r\n');
    assert.match(response, /403 Forbidden/);
    assert.match(response, /address-not-global/);
    assert.equal(allowed.hits, 0);
    assert.equal(proxy.audit.at(-1)!.addressScope, 'loopback');
  });

  it('denies the metadata endpoint even when every answer points at it', async () => {
    const proxy = await proxyFor({
      hosts: ['metadata.test'],
      resolve: { 'metadata.test': ['169.254.169.254', '169.254.169.254'] },
    });
    const response = await speak(
      proxy.port,
      'GET http://metadata.test/ HTTP/1.1\r\nHost: metadata.test\r\n\r\n',
    );
    assert.match(response, /address-not-global/);
    assert.equal(proxy.audit.at(-1)!.addressScope, 'metadata');
  });

  it('picks the first global answer when a name has mixed addresses', async () => {
    // The complement of the rebinding test: a real CDN answer with a private
    // address in it must not take the whole name down.
    const allowed = await origin('allowed');
    const proxy = await proxyFor({
      hosts: ['mixed.test'],
      resolve: { 'mixed.test': ['10.0.0.1', '93.184.216.34'] },
      dialPort: allowed.port,
    });
    const response = await speak(proxy.port, 'GET http://mixed.test/ HTTP/1.1\r\nHost: mixed.test\r\n\r\n');
    assert.match(response, /200 OK/);
    assert.equal(allowed.hits, 1);
  });

  it('denies CONNECT to an approved host on an unsupported port (§33)', async () => {
    const proxy = await proxyFor({ hosts: ['allowed.test'], resolve: { 'allowed.test': ['93.184.216.34'] } });
    const response = await speak(
      proxy.port,
      'CONNECT allowed.test:22 HTTP/1.1\r\nHost: allowed.test:22\r\n\r\n',
    );
    assert.match(response, /403 Forbidden/);
    assert.match(response, /port-not-allowed/);
  });

  it('tears down a CONNECT tunnel whose SNI names another host, before any payload', async () => {
    const allowed = await origin('allowed');
    const proxy = await proxyFor({
      hosts: ['allowed.test'],
      resolve: { 'allowed.test': ['93.184.216.34'] },
      dialPort: allowed.port,
    });

    const response = await speak(
      proxy.port,
      'CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n',
      clientHelloFor('denied.test'),
    );
    // The 200 is sent first — that is the protocol — but nothing was dialled.
    assert.match(response, /200 Connection Established/);
    assert.equal(allowed.hits, 0, 'the SNI mismatch must be caught before any upstream connection');
    const denial = proxy.audit.find((r) => r.reason === 'sni-mismatch');
    assert.ok(denial, 'expected an sni-mismatch audit record');
  });

  it('completes a CONNECT tunnel whose SNI matches — the control for the test above', async () => {
    const allowed = await origin('allowed');
    const proxy = await proxyFor({
      hosts: ['allowed.test'],
      resolve: { 'allowed.test': ['93.184.216.34'] },
      dialPort: allowed.port,
    });

    await speak(
      proxy.port,
      'CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n',
      clientHelloFor('allowed.test'),
    );
    // The fixture is not a TLS server, so the handshake goes nowhere — but the
    // bytes were relayed, which is the property under test and the proof that
    // the mismatch case above failed for the SNI reason rather than by accident.
    assert.equal(allowed.hits, 1);
    assert.ok(proxy.audit.some((r) => r.decision === 'allowed' && r.host === 'allowed.test'));
  });

  it('never records a path, a query or a header in the audit trail (§44)', async () => {
    const allowed = await origin('allowed');
    const proxy = await proxyFor({
      hosts: ['allowed.test'],
      resolve: { 'allowed.test': ['93.184.216.34'] },
      dialPort: allowed.port,
    });
    await speak(
      proxy.port,
      'GET http://allowed.test/secret-path?token=SHOULD_NOT_APPEAR HTTP/1.1\r\n' +
        'Host: allowed.test\r\nAuthorization: Bearer ALSO_SHOULD_NOT_APPEAR\r\n\r\n',
    );
    const serialised = JSON.stringify(proxy.audit);
    assert.ok(!serialised.includes('SHOULD_NOT_APPEAR'), 'the audit trail leaked a query parameter');
    assert.ok(!serialised.includes('ALSO_SHOULD_NOT_APPEAR'), 'the audit trail leaked a credential');
    assert.ok(!serialised.includes('secret-path'), 'the audit trail leaked a path');
  });
});

/** A minimal but structurally valid ClientHello carrying one server name. */
function clientHelloFor(name: string): Buffer {
  const host = Buffer.from(name, 'latin1');
  const entry = Buffer.alloc(3 + host.length);
  entry[0] = 0x00;
  entry.writeUInt16BE(host.length, 1);
  host.copy(entry, 3);
  const list = Buffer.alloc(2 + entry.length);
  list.writeUInt16BE(entry.length, 0);
  entry.copy(list, 2);
  const extension = Buffer.alloc(4 + list.length);
  extension.writeUInt16BE(0x0000, 0);
  extension.writeUInt16BE(list.length, 2);
  list.copy(extension, 4);

  const extensionsLength = Buffer.alloc(2);
  extensionsLength.writeUInt16BE(extension.length, 0);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32),
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x02, 0x13, 0x01]),
    Buffer.from([0x01, 0x00]),
    extensionsLength,
    extension,
  ]);
  const message = Buffer.alloc(4 + body.length);
  message[0] = 0x01;
  message.writeUIntBE(body.length, 1, 3);
  body.copy(message, 4);
  const header = Buffer.alloc(5);
  header[0] = 0x16;
  header[1] = 0x03;
  header[2] = 0x01;
  header.writeUInt16BE(message.length, 3);
  return Buffer.concat([header, message]);
}
