/**
 * Host normalisation and address classification (alpha.6 §20, §21, §23, §76).
 *
 * These are the tests that make §20's "one normalisation function used
 * everywhere" worth anything. The function is only useful if it agrees with
 * itself across spellings, and the interesting cases are all spellings that a
 * *different* piece of software would accept as something else: the trailing
 * dot, the IDNA form, the octal IPv4 literal, the IPv4-mapped IPv6 address.
 *
 * Each rejection below is a real bypass primitive, not a tidiness rule.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  classifyAddress,
  isGlobalAddress,
  normalizeHost,
  normalizeIPv4,
  normalizeIPv6,
  parsePort,
  splitHostPort,
} from '../../src/security/egress/host.ts';

const ok = (input: string): string => {
  const r = normalizeHost(input);
  assert.equal(r.ok, true, `expected ${JSON.stringify(input)} to normalise, got ${r.ok ? '' : r.reason}`);
  return (r as { host: string }).host;
};

const rejected = (input: string): string => {
  const r = normalizeHost(input);
  assert.equal(r.ok, false, `expected ${JSON.stringify(input)} to be rejected, got ${r.ok ? r.host : ''}`);
  return (r as { reason: string }).reason;
};

describe('host normalisation', () => {
  it('lower-cases and strips a single terminal dot', () => {
    // The three spellings a policy, a CONNECT authority and an SNI might each
    // use for one name. If these produced three strings, they would produce
    // three different answers from the same allowlist.
    assert.equal(ok('registry.npmjs.org'), 'registry.npmjs.org');
    assert.equal(ok('REGISTRY.NPMJS.ORG'), 'registry.npmjs.org');
    assert.equal(ok('Registry.NpmJS.org.'), 'registry.npmjs.org');
  });

  it('converts an internationalised name to its ASCII form', () => {
    // A homograph attack works by having two names that look alike; IDNA makes
    // them two *different* ASCII strings, which is what the allowlist compares.
    assert.equal(ok('münchen.example'), 'xn--mnchen-3ya.example');
    assert.notEqual(ok('münchen.example'), 'munchen.example');
  });

  it('rejects the syntax that hides a second destination', () => {
    for (const input of [
      'user@evil.example',
      'https://allowed.example',
      'allowed.example/path',
      'allowed.example?x=1',
      'allowed.example#frag',
      'allowed.example\\evil.example',
      'allowed.example:443',
      'allowed .example',
      'allowed\r\n.example',
      'allowed\0.example',
    ]) {
      rejected(input);
    }
  });

  it('rejects empty, over-long and structurally invalid labels', () => {
    rejected('');
    rejected('.');
    rejected('a..b');
    rejected('a.b..');
    rejected(`${'a'.repeat(64)}.example`);
    rejected(`${'a.'.repeat(200)}example`);
    rejected('-lead.example');
    rejected('trail-.example');
    rejected('under_score.example');
  });

  it('rejects wildcards rather than treating them as a literal label', () => {
    // §21: wildcard policy is a later feature, and the failure mode to avoid is
    // a `*` that silently becomes part of a hostname nobody can register.
    const reason = rejected('*.example.com');
    assert.match(reason, /LDH|wildcard/);
  });

  it('accepts a dotted-quad IPv4 literal and reports it as one', () => {
    const r = normalizeHost('93.184.216.34');
    assert.equal(r.ok, true);
    assert.equal((r as { kind: string }).kind, 'ipv4');
  });

  it('refuses the alternate IPv4 spellings that a resolver would accept', () => {
    // Every one of these is 127.0.0.1 to `inet_aton`, curl and the C resolver.
    // Accepting any of them would mean a policy string and a connect target
    // could differ while naming the same address.
    for (const input of [
      '0177.0.0.1',
      '2130706433',
      '127.1',
      '127.0.1',
      '0x7f.0.0.1',
      '1.2.3.4.5',
      '999.1.1.1',
    ]) {
      rejected(input);
    }
  });

  it('canonicalises IPv6 and folds the IPv4-mapped form', () => {
    assert.equal(ok('[2001:DB8:0:0:0:0:0:1]'), '2001:db8::1');
    assert.equal(ok('[0:0:0:0:0:0:0:1]'), '::1');
    // The fold matters: a classifier that only saw the v6 spelling would call
    // ::ffff:127.0.0.1 a global address.
    assert.equal(ok('[::ffff:127.0.0.1]'), '127.0.0.1');
    assert.equal(normalizeIPv6('::ffff:7f00:1'), '127.0.0.1');
  });

  it('does not let an unbracketed IPv6-looking authority collapse into loopback', () => {
    // `::1:443` reads as "loopback, port 443" to a naive last-colon split. It is
    // also a perfectly valid IPv6 address in its own right, so the safe answer
    // is not to reject it but to make sure it never becomes `::1`: it keeps its
    // own identity, and it classifies as reserved rather than as a destination.
    assert.equal(ok('::1:443'), '::1:443');
    assert.notEqual(ok('::1:443'), '::1');
    assert.equal(isGlobalAddress('::1:443'), false);
    // A domain authority with a port, by contrast, is rejected outright: it is
    // not an IPv6 literal, so there is no reading in which the colon belongs.
    rejected('example.com:443');
  });

  it('rejects an IPv6 zone identifier', () => {
    rejected('[fe80::1%eth0]');
  });
});

describe('authority splitting', () => {
  it('splits IPv4 and domain authorities on the last colon', () => {
    assert.deepEqual(splitHostPort('example.com:443'), { host: 'example.com', port: 443 });
    assert.deepEqual(splitHostPort('example.com', 80), { host: 'example.com', port: 80 });
  });

  it('splits a bracketed IPv6 authority without eating the address colons', () => {
    assert.deepEqual(splitHostPort('[2001:db8::1]:443'), { host: '[2001:db8::1]', port: 443 });
    assert.deepEqual(splitHostPort('[::1]', 443), { host: '[::1]', port: 443 });
  });

  it('refuses an unbracketed multi-colon authority', () => {
    assert.equal(splitHostPort('2001:db8::1:443'), undefined);
  });

  it('refuses ports that are not plain in-range decimals', () => {
    assert.equal(parsePort('0'), undefined);
    assert.equal(parsePort('65536'), undefined);
    assert.equal(parsePort('+443'), undefined);
    assert.equal(parsePort('443 '), undefined);
    assert.equal(parsePort('0x1bb'), undefined);
    assert.equal(parsePort('443'), 443);
  });
});

describe('address scope classification (§23)', () => {
  it('names the cloud metadata endpoint specifically', () => {
    // Broken out of link-local so that an audit line for the single most
    // important denial says what it actually stopped.
    assert.equal(classifyAddress('169.254.169.254')?.scope, 'metadata');
    assert.equal(classifyAddress('169.254.1.1')?.scope, 'link-local');
    assert.equal(classifyAddress('fd00:ec2::254')?.scope, 'metadata');
  });

  it('denies every non-global IPv4 range the rebinding attack needs', () => {
    const cases: Array<[string, string]> = [
      ['127.0.0.1', 'loopback'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.168.1.1', 'private'],
      ['100.64.0.1', 'cgnat'],
      ['0.0.0.0', 'unspecified'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'reserved'],
    ];
    for (const [address, scope] of cases) {
      assert.equal(classifyAddress(address)?.scope, scope, address);
      assert.equal(isGlobalAddress(address), false, address);
    }
  });

  it('denies the non-global IPv6 ranges', () => {
    for (const [address, scope] of [
      ['::1', 'loopback'],
      ['::', 'unspecified'],
      ['fd12:3456::1', 'private'],
      ['fe80::1', 'link-local'],
      ['ff02::1', 'multicast'],
    ] as Array<[string, string]>) {
      assert.equal(classifyAddress(address)?.scope, scope, address);
    }
  });

  it('lets ordinary public addresses through', () => {
    assert.equal(isGlobalAddress('93.184.216.34'), true);
    assert.equal(isGlobalAddress('8.8.8.8'), true);
    assert.equal(isGlobalAddress('2606:4700::1111'), true);
  });

  it('classifies the IPv4-mapped form as its IPv4 scope', () => {
    // The whole reason `normalizeIPv6` folds: without it, this is "global".
    assert.equal(classifyAddress('::ffff:169.254.169.254')?.scope, 'metadata');
    assert.equal(classifyAddress('::ffff:127.0.0.1')?.scope, 'loopback');
    assert.equal(classifyAddress('::ffff:10.0.0.1')?.family, 'ipv4');
  });

  it('returns undefined for something that is not an address at all', () => {
    assert.equal(classifyAddress('example.com'), undefined);
    assert.equal(normalizeIPv4('1.2.3'), undefined);
  });
});
