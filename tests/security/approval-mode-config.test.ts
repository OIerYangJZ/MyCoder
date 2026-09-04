/**
 * `[security] approval_mode` as a §12 weakening key.
 *
 * The mode is the only key in the configuration surface that removes the *user*
 * rather than redirecting something. Everything else in `WEAKENING_KEYS` moves
 * where bytes go or what code exists inside the boundary; this decides whether
 * anybody is asked before an action the policy engine flagged. So it gets the
 * treatment §12 specifies, and these are the assertions rather than the claim:
 *
 *   1. a checked-out repository cannot set it, in either direction;
 *   2. two layers merge to the stricter mode, never the weaker;
 *   3. it is disclosed at startup when it is weak, and silent when it is not;
 *   4. the disclosure says what remains denied.
 *
 * (1) is the one with teeth. A repository that could write
 * `approval_mode = "auto"` would be a repository deciding that nobody needs to
 * be asked before its own code runs — which is `git clone` as a privilege
 * escalation, and no amount of care elsewhere would compensate for it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { loadConfig } from '../../src/config/config.ts';
import { configFromToml, defaultConfig, mergeConfig } from '../../src/config/schema.ts';
import { disclosures, WEAKENING_KEYS } from '../../src/config/weakening.ts';
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE } from '../../src/policy/approval-mode.ts';
import { parseToml } from '../../src/util/toml.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

async function fixture(files: { user?: string; project?: string }) {
  const base = await mkdtemp(path.join(tmpdir(), 'approval-mode-'));
  const workspace = path.join(base, 'workspace');
  const userConfigDir = path.join(base, 'config');
  await mkdir(path.join(workspace, '.agent'), { recursive: true });
  await mkdir(userConfigDir, { recursive: true });
  if (files.user) await writeFile(path.join(userConfigDir, 'config.toml'), files.user, 'utf8');
  if (files.project) await writeFile(path.join(workspace, '.agent', 'config.toml'), files.project, 'utf8');
  return {
    workspace: workspace as CanonicalPath,
    userConfigDir,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

const withMode = (mode: string): string => `[security]\napproval_mode = "${mode}"\n`;

describe('only the user layer may set the mode', () => {
  test('a user config may set it, and it takes effect', async () => {
    const f = await fixture({ user: withMode('auto') });
    try {
      const loaded = await loadConfig({ workspaceRoot: f.workspace, userConfigDir: f.userConfigDir });
      assert.equal(loaded.config.security.approvalMode, 'auto');
    } finally {
      await f.cleanup();
    }
  });

  test('a project config setting it is dropped, loudly', async () => {
    const f = await fixture({ project: withMode('auto') });
    try {
      const loaded = await loadConfig({ workspaceRoot: f.workspace, userConfigDir: f.userConfigDir });
      assert.equal(loaded.config.security.approvalMode ?? DEFAULT_APPROVAL_MODE, DEFAULT_APPROVAL_MODE);

      const warnings = loaded.config.warnings.join('\n');
      assert.match(warnings, /project config set security\.approval_mode/);
      // The remedy names the way in, so the message is actionable rather than
      // only a refusal.
      assert.match(warnings, /Shift-Tab or \/mode/);
    } finally {
      await f.cleanup();
    }
  });

  /**
   * The asymmetry worth asserting: a project asking for *plan* is narrowing its
   * own session, which everywhere else in this config surface is permitted. It
   * is refused anyway, because "the mode comes from you, never from a checkout"
   * is a rule with no exception to remember.
   */
  test('a project config asking for plan mode is dropped too, even though it is stricter', async () => {
    const f = await fixture({ project: withMode('plan') });
    try {
      const loaded = await loadConfig({ workspaceRoot: f.workspace, userConfigDir: f.userConfigDir });
      assert.equal(loaded.config.security.approvalMode ?? DEFAULT_APPROVAL_MODE, DEFAULT_APPROVAL_MODE);
      assert.match(loaded.config.warnings.join('\n'), /security\.approval_mode/);
    } finally {
      await f.cleanup();
    }
  });

  test('a project cannot weaken a mode the user chose', async () => {
    const f = await fixture({ user: withMode('plan'), project: withMode('auto') });
    try {
      const loaded = await loadConfig({ workspaceRoot: f.workspace, userConfigDir: f.userConfigDir });
      assert.equal(loaded.config.security.approvalMode, 'plan');
    } finally {
      await f.cleanup();
    }
  });

  test('an unrecognised mode name warns and leaves the default, rather than falling anywhere', () => {
    const parsed = configFromToml(parseToml(withMode('bypassPermissions')), 'test');
    assert.equal(parsed.security?.approvalMode, undefined);
    assert.match(parsed.warnings?.join('\n') ?? '', /approval_mode is "bypassPermissions"/);
    assert.match(parsed.warnings?.join('\n') ?? '', /plan, manual, accept-edits, auto/);
  });
});

describe('the merge keeps the stricter mode', () => {
  test('every pair of modes merges to whichever asks more', () => {
    // Exhaustive rather than sampled: this is a 4×4 table and the whole point is
    // that no cell in it produces the weaker side.
    for (const lower of APPROVAL_MODES) {
      for (const higher of APPROVAL_MODES) {
        const merged = mergeConfig(
          { ...defaultConfig(), security: { ...defaultConfig().security, approvalMode: lower } },
          { security: { approvalMode: higher } },
        );
        const expected = APPROVAL_MODES.indexOf(lower) <= APPROVAL_MODES.indexOf(higher) ? lower : higher;
        assert.equal(
          merged.security.approvalMode,
          expected,
          `${lower} + ${higher} merged to ${merged.security.approvalMode}`,
        );
      }
    }
  });

  test('an absent mode on either side is not treated as permission to weaken', () => {
    const fromLower = mergeConfig(
      { ...defaultConfig(), security: { ...defaultConfig().security, approvalMode: 'plan' } },
      { security: {} },
    );
    assert.equal(fromLower.security.approvalMode, 'plan');
  });

  /**
   * The bug this suite found on its first run, kept as a regression test.
   *
   * `defaultConfig()` used to set `approvalMode: 'manual'`, and because the merge
   * keeps the stricter side, the default beat the user's own `auto` — the setting
   * parsed, merged, disclosed nothing and did nothing. The fix is that "nobody
   * chose" is a distinct state from "somebody chose manual", so the default is
   * applied where it is read rather than being one of the two sides.
   */
  test('the default is absent, so it cannot outvote the user', () => {
    assert.equal(
      defaultConfig().security.approvalMode,
      undefined,
      'a literal default here silently makes the setting unusable',
    );

    const userChose = mergeConfig(defaultConfig(), { security: { approvalMode: 'auto' } });
    assert.equal(userChose.security.approvalMode, 'auto');

    // And with nobody choosing, the read-time default is what runs.
    assert.equal(mergeConfig(defaultConfig(), {}).security.approvalMode ?? DEFAULT_APPROVAL_MODE, 'manual');
  });
});

describe('the disclosure §12 requires', () => {
  const configWith = (mode: (typeof APPROVAL_MODES)[number]) => ({
    ...defaultConfig(),
    security: { ...defaultConfig().security, approvalMode: mode },
  });

  test('the key is in the audit table at all', () => {
    const row = WEAKENING_KEYS.find((k) => k.key === '[security] approval_mode');
    assert.ok(row, 'a weakening key absent from the table is a key nobody audited');
    assert.equal(row.layer, 'user-only');
    assert.ok(row.stillDenied.length > 0, "§12's fourth requirement is a non-empty answer");
  });

  test('the two weak modes disclose at startup and the two strict ones stay quiet', () => {
    assert.equal(disclosures(configWith('manual')).length, 0);
    assert.equal(disclosures(configWith('plan')).length, 0);
    assert.equal(disclosures(configWith('accept-edits')).length, 1);
    assert.equal(disclosures(configWith('auto')).length, 1);
  });

  /**
   * The disclosure names what the mode *takes over*, and the ceiling.
   *
   * It deliberately does **not** enumerate what will still be asked. An earlier
   * version did, and that list was the complement of `AUTO_ANSWERED` — a claim
   * about the whole policy stack dressed up as a fact about the mode. Under a
   * project `permissions.toml` with its own deny rules it was already wrong, and
   * in plan mode it was flatly false. §12's fourth requirement is "say what
   * remains denied", which the ceiling sentence answers; it is not "predict every
   * approval the engine will raise".
   */
  test('the disclosure names what the mode takes over, and the ceiling', () => {
    const text = disclosures(configWith('auto')).join('\n');

    // What it takes over, by name — the three `auto` answers for.
    for (const capability of ['file.write', 'file.delete', 'process.exec']) {
      assert.match(text, new RegExp(capability.replace('.', '\\.')), `${capability} is not disclosed`);
    }

    // The ceiling, which is §12's fourth requirement.
    assert.match(text, /Nothing a policy layer denied becomes permitted/);

    // And the way back out, because a disclosure the reader cannot act on is a
    // notice rather than a disclosure.
    assert.match(text, /Shift-Tab|\/mode manual/);
  });

  test('the disclosure does not predict what will be asked', () => {
    for (const mode of ['accept-edits', 'auto'] as const) {
      const text = disclosures(configWith(mode)).join('\n');
      assert.ok(!/still ask/i.test(text), `the ${mode} disclosure predicts what will be asked`);
    }
  });

  test('accept-edits discloses that it covers writes only', () => {
    // The distinction people get wrong about this mode: an overwrite leaves a
    // diff and a journal entry, a deletion leaves neither, so they are not the
    // same act (ADR-0016) and the mode does not treat them as one. Asserted by
    // what the disclosure claims rather than by what it denies: it must name
    // `file.write` and must not claim `file.delete`.
    const text = disclosures(configWith('accept-edits')).join('\n');
    assert.match(text, /file\.write/);
    assert.ok(!/file\.delete/.test(text), 'accept-edits disclosed a capability it does not answer');
  });
});
