/**
 * What a profile says about a foreign tool, and what `/status` says about the
 * region inside one (ADR-0023 §4, §6; alpha.9 §14, §23 Descriptor Stop).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_CAPABILITIES } from '../../src/policy/access.ts';
import { readOnlyProfile, workspaceDevProfile, BUILTIN_PROFILES } from '../../src/policy/profiles.ts';
import {
  describeEnforcement,
  localEnforcement,
  linuxNativeEnforcement,
  summarizeEnforcement,
  withForeignTools,
} from '../../src/execution/enforcement.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

const ctx = { workspaceRoot: '/w' as CanonicalPath, referenceRoots: [] as CanonicalPath[] };

function actionFor(profileName: string, capability: string): string | undefined {
  const profile = BUILTIN_PROFILES[profileName]!(ctx as never);
  // Last matching rule wins in this table's ordering, same as the engine.
  const match = [...profile.rules].reverse().find((r) => r.capability === capability);
  return match?.action;
}

describe('mcp.invoke is a first-class capability', () => {
  test('it is in ALL_CAPABILITIES, so no exhaustive switch can ignore it', () => {
    assert.ok(ALL_CAPABILITIES.includes('mcp.invoke'));
  });

  test('read-only and review deny it outright', () => {
    // A foreign tool cannot be classified read-only: `readOnly` would be the
    // server's claim about itself. A profile promising "this session changes
    // nothing" cannot keep that promise while calling code it cannot see.
    assert.equal(actionFor('read-only', 'mcp.invoke'), 'deny');
    assert.equal(actionFor('review', 'mcp.invoke'), 'deny');
  });

  test('workspace-dev asks', () => {
    assert.equal(actionFor('workspace-dev', 'mcp.invoke'), 'ask');
  });

  test('NEGATIVE CONTROL: the profiles differ, so the rule is not uniform', () => {
    // Without this, a table that denied *everything* in every profile would pass
    // both assertions above.
    assert.notEqual(actionFor('read-only', 'mcp.invoke'), actionFor('workspace-dev', 'mcp.invoke'));
    assert.equal(readOnlyProfile(ctx as never).name, 'read-only');
    assert.equal(workspaceDevProfile(ctx as never).name, 'workspace-dev');
  });
});

describe('the descriptor is honest about what is inside a server (§14)', () => {
  test('with no servers attached, the dimension is absent', () => {
    const d = withForeignTools(localEnforcement(), []);
    assert.equal(d.foreignToolEffects, undefined);
    assert.equal(
      describeEnforcement(d).lines.some((l) => /MCP/.test(l)),
      false,
      'a session with no foreign tools must not be told about foreign tools',
    );
  });

  test('with a server attached, it is `none`, and /status says so', () => {
    const d = withForeignTools(localEnforcement(), ['wiki']);
    assert.equal(d.foreignToolEffects, 'none');

    const described = describeEnforcement(d);
    assert.ok(described.lines.includes('effects inside MCP servers: none'));
    assert.match(described.caveat, /none of it extends inside an MCP server/);
    assert.match(described.caveat, /wiki/);
  });

  test('the strongest backend still reports the weakest thing about it', () => {
    // The pair the plan asks for, and the reason this is a seventh dimension
    // rather than a downgrade of the other six: both facts are true at once.
    const d = withForeignTools(linuxNativeEnforcement({ networkTcp: true, abi: 4, notes: [] }), ['wiki']);
    const lines = describeEnforcement(d).lines;

    assert.ok(lines.includes('process filesystem: os-enforced'));
    assert.ok(lines.includes('effects inside MCP servers: none'));
  });

  test('the summary is NOT downgraded by an attached server', () => {
    // Rounding the label down would be as dishonest as rounding the MCP region
    // up: the subprocess confinement really is os-enforced.
    const bare = linuxNativeEnforcement({ networkTcp: true, abi: 4, notes: [] });
    assert.equal(summarizeEnforcement(withForeignTools(bare, ['wiki'])), summarizeEnforcement(bare));
  });

  test('DESCRIPTOR STOP: no input produces a level above `none`', () => {
    // `withForeignTools` takes server names, not a level, precisely so there is
    // no argument a future caller could pass to claim enforcement here.
    for (const servers of [['a'], ['a', 'b'], Array.from({ length: 50 }, (_, i) => `s${i}`)]) {
      assert.equal(withForeignTools(localEnforcement(), servers).foreignToolEffects, 'none');
    }
  });
});
