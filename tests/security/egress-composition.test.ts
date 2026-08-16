/**
 * Scoped egress under composition (alpha.6 §36, §50–§52, §92).
 *
 * Two different guarantees are checked here, and they are checked in two
 * different ways on purpose.
 *
 * The **algebra** — "a child can only narrow" — is asserted against
 * `narrowNetworkMode`, which is a pure function and can therefore be checked
 * over every interesting combination rather than the two or three a scenario
 * test would reach.
 *
 * The **mechanism** — "and the kernel actually composes them that way" — is
 * asserted against the real policy engine with real narrowing layers, because
 * that is where a subagent's or a skill's network grant is decided. A test that
 * only exercised the algebra would prove that a function nobody calls is
 * correct.
 *
 * The last suite covers §36: an approval cached for one host must not be
 * spendable on another, on a different scope, or on a host that merely
 * normalises to something similar.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  narrowNetworkMode,
  normalizeNetworkMode,
  type ProcessNetworkMode,
} from '../../src/security/egress/network-mode.ts';
import { describeAccess, subjectKeyOf, type NetworkAccess } from '../../src/policy/access.ts';
import { PolicyEngine } from '../../src/policy/policy-engine.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

const allowlist = (...hosts: string[]): ProcessNetworkMode => normalizeNetworkMode({ hosts }).mode;
const DENY: ProcessNetworkMode = { kind: 'deny-all' };
const OPEN: ProcessNetworkMode = { kind: 'unrestricted' };

const hostsOf = (mode: ProcessNetworkMode): string[] =>
  mode.kind === 'allowlist' ? mode.targets.map((t) => t.host) : [];

describe('network mode narrowing algebra (§50, §51)', () => {
  it('keeps deny-all whatever the child asks for', () => {
    assert.equal(narrowNetworkMode(DENY, OPEN).kind, 'deny-all');
    assert.equal(narrowNetworkMode(DENY, allowlist('a.example')).kind, 'deny-all');
    assert.equal(narrowNetworkMode(DENY, DENY).kind, 'deny-all');
  });

  it('refuses to let a child upgrade a scoped session to unrestricted (§50)', () => {
    // The row that matters. A subagent or skill asking for broad network inside
    // a scoped session gets the session's allowlist, not the internet.
    const result = narrowNetworkMode(allowlist('a.example'), OPEN);
    assert.equal(result.kind, 'allowlist');
    assert.deepEqual(hostsOf(result), ['a.example']);
  });

  it('intersects two allowlists (§51)', () => {
    const parent = allowlist('registry.npmjs.org', 'api.github.com');
    const child = allowlist('api.github.com');
    assert.deepEqual(hostsOf(narrowNetworkMode(parent, child)), ['api.github.com']);
  });

  it('drops a host the child named but the parent never had', () => {
    const parent = allowlist('api.github.com');
    const child = allowlist('api.github.com', 'evil.example');
    assert.deepEqual(hostsOf(narrowNetworkMode(parent, child)), ['api.github.com']);
  });

  it('collapses an empty intersection to deny-all, not to "no constraint"', () => {
    // The same trap as `hosts: []`: an allowlist that narrows to nothing means
    // nothing is allowed, and a reading of "unconstrained" would be a bypass.
    assert.equal(narrowNetworkMode(allowlist('a.example'), allowlist('b.example')).kind, 'deny-all');
  });

  it('lets a child scope an unrestricted parent', () => {
    assert.deepEqual(hostsOf(narrowNetworkMode(OPEN, allowlist('a.example'))), ['a.example']);
    assert.equal(narrowNetworkMode(OPEN, OPEN).kind, 'unrestricted');
  });

  it('is idempotent and order-independent for its own result', () => {
    const parent = allowlist('a.example', 'b.example');
    const once = narrowNetworkMode(parent, allowlist('b.example'));
    assert.deepEqual(narrowNetworkMode(parent, once), once);
    assert.deepEqual(narrowNetworkMode(once, once), once);
  });
});

describe('the policy engine composes network grants by narrowing (§50, §52)', () => {
  const workspaceRoot = '/tmp/ws' as CanonicalPath;
  const protectedPaths = new ProtectedPaths({ home: '/tmp/home' });

  const access = (host: string, over: Partial<NetworkAccess> = {}): NetworkAccess => ({
    kind: 'network.connect',
    host,
    port: 443,
    display: `${host}:443`,
    via: 'shell',
    ...over,
  });

  /** A session that approved exactly one host. */
  const parentLayers = [
    {
      name: 'session',
      source: 'user' as const,
      profile: {
        name: 'session',
        description: 'one approved host',
        fallback: 'deny' as const,
        rules: [
          { action: 'allow' as const, capability: 'network.connect' as const, pattern: 'api.github.com' },
          { action: 'deny' as const, capability: 'network.connect' as const },
        ],
      },
    },
  ];

  it('grants the parent its own approved host', () => {
    const engine = new PolicyEngine({ layers: parentLayers, workspaceRoot, protectedPaths });
    assert.equal(engine.decide(access('api.github.com')).action, 'allow');
  });

  it('denies the parent a host it never approved', () => {
    const engine = new PolicyEngine({ layers: parentLayers, workspaceRoot, protectedPaths });
    assert.notEqual(engine.decide(access('evil.example')).action, 'allow');
  });

  it('a child layer cannot add a host the parent lacks (§50)', () => {
    // The child's layer says `allow evil.example` as loudly as it can. It is an
    // *additional* layer, so the parent's deny still applies — a child asking for
    // more gets no more, and it does not matter what the child's own file says.
    const engine = new PolicyEngine({
      layers: [
        ...parentLayers,
        {
          name: 'agent:greedy',
          source: 'agent' as const,
          profile: {
            name: 'greedy',
            description: 'asks for more than its parent has',
            fallback: 'deny' as const,
            rules: [{ action: 'allow' as const, capability: 'network.connect' as const, pattern: '*' }],
          },
        },
      ],
      workspaceRoot,
      protectedPaths,
    });
    assert.notEqual(engine.decide(access('evil.example')).action, 'allow');
  });

  it('a child layer can remove a host the parent had (§51)', () => {
    const engine = new PolicyEngine({
      layers: [
        ...parentLayers,
        {
          name: 'skill:narrow',
          source: 'skill' as const,
          profile: {
            name: 'narrow',
            description: 'no network at all',
            fallback: 'deny' as const,
            rules: [{ action: 'deny' as const, capability: 'network.connect' as const }],
          },
        },
      ],
      workspaceRoot,
      protectedPaths,
    });
    assert.notEqual(engine.decide(access('api.github.com')).action, 'allow');
  });
});

describe('approval subjects are host-scoped (§36)', () => {
  const base: NetworkAccess = {
    kind: 'network.connect',
    host: 'registry.npmjs.org',
    port: 443,
    display: 'registry.npmjs.org:443',
    via: 'shell',
  };

  it('gives every distinct destination a distinct subject', () => {
    const subjects = [
      subjectKeyOf(base),
      subjectKeyOf({ ...base, host: 'api.github.com' }),
      subjectKeyOf({ ...base, port: 80 }),
      subjectKeyOf({ ...base, via: 'hook' }),
      subjectKeyOf({ ...base, scope: 'unrestricted' }),
      subjectKeyOf({ ...base, privateAddress: true }),
    ];
    assert.equal(new Set(subjects).size, subjects.length, 'two different destinations share one subject');
  });

  it('treats spellings of one host as one subject (§20)', () => {
    // Otherwise a user would be asked twice for the same permission, and the
    // string the cache holds would differ from the one the proxy enforces.
    assert.equal(subjectKeyOf(base), subjectKeyOf({ ...base, host: 'Registry.NPMJS.org.' }));
  });

  it('never lets an unnormalisable host share a subject with a real one', () => {
    const weird = subjectKeyOf({ ...base, host: 'registry.npmjs.org/../evil' });
    assert.notEqual(weird, subjectKeyOf(base));
    assert.match(weird, /unnormalizable/);
  });

  it('describes unrestricted network in words that cannot be mistaken for a host grant (§37)', () => {
    const scoped = describeAccess(base);
    const open = describeAccess({ ...base, scope: 'unrestricted' });
    assert.match(scoped, /registry\.npmjs\.org:443/);
    assert.match(open, /entire internet/);
    assert.notEqual(scoped, open);
  });
});
