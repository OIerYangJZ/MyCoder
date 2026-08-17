/**
 * Self-tests for the mirror checks (alpha.12 CLOSURE B).
 *
 * **This file is the gate.** `scripts/mirrors.ts` holds the comparisons and has a
 * `main()` for reading the report by hand; what runs in CI and in the release gate
 * is this suite, through `pnpm test` and `pnpm lint:selftest`.
 *
 * Every check gets a fixture where the two sides disagree, and a control where
 * they do not. Two of these checks found real drift on their first run — five
 * configuration keys missing from an audit document that claims in its own words
 * that it cannot go stale — so the repository they were written against was *not*
 * clean, which is the one thing that cannot be arranged later.
 *
 * The `readme-tools` block contains a test that asserts a **gap**: a builtin tool
 * absent from README is accepted on purpose. Recording that as a passing test with
 * its reason is the difference between a known limit and an oversight.
 *
 * lint-allow-file no-real-credentials-in-tests: the fixtures below are
 * deliberately-broken contract documents, not credentials
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  builtinToolNames,
  checkAcceptanceTiers,
  checkAuditCoverage,
  checkCliContract,
  checkConfigurationAudit,
  checkExitCodes,
  checkHookEvents,
  checkPackagedFiles,
  checkReadmeTools,
  compareSets,
  findEnumerations,
  MIRRORS,
  parseAudit,
  parseAuditTotals,
  parseCliContract,
  parseConfigurationAudit,
  parseReadmeTools,
  parseSpecHookEvents,
  parseTierList,
  sources,
  type MirrorProblem,
} from '../../scripts/mirrors.ts';
import {
  CONTRACT_BACKENDS,
  CONTRACT_FLAGS,
  EXPERIMENTAL_BACKENDS,
  EXPERIMENTAL_FLAGS,
  SUBCOMMANDS,
} from '../../src/cli/args.ts';
import { EXIT } from '../../src/cli/exit-codes.ts';
import { CEILING_PINNED, WEAKENING_KEYS } from '../../src/config/weakening.ts';
import { USER_HOOK_EVENTS } from '../../src/extensions/hooks.ts';
import { TIERS } from '../../scripts/acceptance.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (rel: string): Promise<string> => readFile(new URL(rel, ROOT), 'utf8');
const messages = (found: readonly MirrorProblem[]): string =>
  found.map((p) => `[${p.mirror}] ${p.message}`).join(' | ');

/** The repository's own files, so the checks are exercised against reality too. */
const files = {
  contract: await read('docs/cli-contract.md'),
  configAudit: await read('docs/configuration-audit.md'),
  adr: await read('docs/adr/ADR-0027-acceptance-tiers-and-the-rc1-gate.md'),
  audit: await read('docs/alpha12-enumeration-audit.md'),
  readme: await read('README.md'),
  pkg: JSON.parse(await read('package.json')) as { files: string[] },
};

/**
 * Read once, at module scope.
 *
 * Not inside the `describe` callbacks: `node --test` strips types rather than
 * compiling, and a top-level `await` in a synchronous callback is a syntax error
 * rather than a runtime one — the whole file fails to parse.
 */
const spec = await read('../research/kernel_v0.1_technical_spec.md').catch(() => undefined);
const tree = await sources();
const builtins = builtinToolNames(await sources(['src']));
const enumerations = findEnumerations(tree);

const cliCode = {
  contractFlags: CONTRACT_FLAGS,
  experimentalFlags: EXPERIMENTAL_FLAGS,
  contractBackends: CONTRACT_BACKENDS,
  experimentalBackends: EXPERIMENTAL_BACKENDS,
  subcommands: SUBCOMMANDS,
};

describe('compareSets — which side the difference is on', () => {
  test('NEGATIVE CONTROL: two identical sides produce nothing', () => {
    assert.deepEqual(compareSets('m', ['a', 'b'], ['b', 'a'], 'code', 'doc'), []);
  });

  test('a member only the code has, and a member only the document has, are different messages', () => {
    // "The lists disagree" is not actionable. An undocumented flag and a
    // documented flag that does not exist are different bugs with different fixes.
    const found = compareSets('m', ['a', 'c'], ['a', 'b'], 'the code', 'the document');
    assert.equal(found.length, 2, messages(found));
    assert.match(messages(found), /the code has "c" and the document does not/);
    assert.match(messages(found), /the document has "b" and the code does not/);
  });
});

describe('cli-contract — the document ADR-0021 exists to make trustworthy', () => {
  test('NEGATIVE CONTROL: the shipped document and args.ts agree', () => {
    const found = checkCliContract(cliCode, parseCliContract(files.contract));
    assert.deepEqual(found, [], messages(found));
  });

  test('the parser reads flags, backends and subcommands out of the real document', () => {
    // A parser that found nothing would make the check vacuously green, which is
    // the failure mode of every gate in this repository.
    const doc = parseCliContract(files.contract);
    assert.ok(doc.contractFlags.length >= 15, `found ${doc.contractFlags.length} contract flags`);
    assert.deepEqual([...doc.contractBackends].sort(), ['container', 'local']);
    assert.deepEqual(doc.experimentalBackends, ['linux-native']);
    assert.deepEqual([...doc.subcommands].sort(), ['build-sandbox', 'doctor', 'setup-credential']);
    assert.equal(doc.exitCodes.get('DENIED'), 4);
  });

  test('a flag added to the code and not to the document is refused', () => {
    const found = checkCliContract(
      { ...cliCode, contractFlags: [...CONTRACT_FLAGS, '--new-flag'] },
      parseCliContract(files.contract),
    );
    assert.match(messages(found), /CONTRACT_FLAGS has "--new-flag" and the contract block does not/);
  });

  test('a flag promised by the document and absent from the code is refused', () => {
    // Injected next to `--print-config`, which occurs only inside the contract
    // block. `--json` was the obvious choice and is wrong: its first occurrence is
    // in an example shell snippet, so the fixture edited a part of the document
    // the check does not read and produced no failure — a fixture that proves
    // nothing looks exactly like a check that works.
    const doc = parseCliContract(files.contract.replace('--print-config', '--print-config --imaginary'));
    const found = checkCliContract(cliCode, doc);
    assert.match(messages(found), /the contract block has "--imaginary"/);
  });

  test('a flag moved from experimental to contract is refused until the document moves too', () => {
    // The change ADR-0021 most needs noticed: promoting a flag is a promise that
    // its semantics will not change within 0.1.x.
    const found = checkCliContract(
      { ...cliCode, contractFlags: [...CONTRACT_FLAGS, '--force'], experimentalFlags: ['--sandbox-status'] },
      parseCliContract(files.contract),
    );
    assert.match(messages(found), /CONTRACT_FLAGS has "--force"/);
    assert.match(messages(found), /the experimental block has "--force"/);
  });
});

describe('exit-codes — the numbers a wrapper script branches on', () => {
  test('NEGATIVE CONTROL: the shipped table and EXIT agree, names and numbers', () => {
    const found = checkExitCodes(EXIT, parseCliContract(files.contract).exitCodes);
    assert.deepEqual(found, [], messages(found));
  });

  test('a renumbered exit code is refused even though both sides have the name', () => {
    // The subtlest form: no name is missing, so a set comparison alone would pass
    // while every `case 4)` in every wrapper became wrong.
    const found = checkExitCodes({ ...EXIT, DENIED: 9 }, parseCliContract(files.contract).exitCodes);
    assert.equal(found.length, 1, messages(found));
    assert.match(found[0]?.message ?? '', /EXIT.DENIED is 9 and the exit-code table says 4/);
  });

  test('a code in the table that the code does not define is refused', () => {
    const doc = new Map(parseCliContract(files.contract).exitCodes);
    doc.set('IMAGINARY', 7);
    assert.match(messages(checkExitCodes(EXIT, doc)), /the exit-code table has "IMAGINARY"/);
  });
});

describe('packaged-files', () => {
  test('NEGATIVE CONTROL: every required file is reachable from package.json files', async () => {
    const { REQUIRED } = await import('../../scripts/package-check.ts');
    const found = checkPackagedFiles(REQUIRED, files.pkg.files);
    assert.deepEqual(found, [], messages(found));
  });

  test('a required file outside the packaged set is refused', () => {
    const found = checkPackagedFiles(['docs/cli-contract.md'], ['dist/', 'src/']);
    assert.match(found[0]?.message ?? '', /could never be satisfied/);
  });

  test('package.json is covered without being listed, because npm always packs it', () => {
    assert.deepEqual(checkPackagedFiles(['package.json'], ['dist/']), []);
  });
});

describe('configuration-audit — the table that said it could not go stale', () => {
  test('NEGATIVE CONTROL: the shipped document and weakening.ts agree', () => {
    const found = checkConfigurationAudit(
      { keys: WEAKENING_KEYS.map((k) => k.key), pinned: CEILING_PINNED },
      parseConfigurationAudit(files.configAudit),
    );
    assert.deepEqual(found, [], messages(found));
  });

  test('the parser reads both lists, including the escaped asterisk', () => {
    // `[mcp.servers.\*]` in prose. Prettier adds the backslash, a reader does not
    // see it, and a string comparison dies on it — which is exactly how the
    // repaired row would have looked repaired and still failed.
    const doc = parseConfigurationAudit(files.configAudit);
    assert.ok(doc.keys.includes('[mcp.servers.*] command / url'));
    assert.ok(doc.pinned.includes('[mcp.servers.*] credential / api_key'));
  });

  test('a key in the code and not in the document is refused', () => {
    // The drift this check found on its first run: alpha.9 added four MCP keys to
    // WEAKENING_KEYS and one to CEILING_PINNED, and the audit document had none
    // of the five.
    const found = checkConfigurationAudit(
      { keys: [...WEAKENING_KEYS.map((k) => k.key), '[new] key'], pinned: CEILING_PINNED },
      parseConfigurationAudit(files.configAudit),
    );
    assert.match(messages(found), /WEAKENING_KEYS has "\[new\] key" and the relaxation table does not/);
  });

  test('a pinned key missing from the document is refused', () => {
    const found = checkConfigurationAudit(
      { keys: WEAKENING_KEYS.map((k) => k.key), pinned: [...CEILING_PINNED, '[new] pinned — forced false'] },
      parseConfigurationAudit(files.configAudit),
    );
    assert.match(messages(found), /CEILING_PINNED has "\[new\] pinned"/);
  });

  test('the prose after the em dash may be edited freely', () => {
    // A check that failed when somebody improved a sentence would be switched off
    // within a week, so only the key is compared.
    const reworded = CEILING_PINNED.map((p) => `${p.split(' — ')[0]} — a completely different explanation`);
    const found = checkConfigurationAudit(
      { keys: WEAKENING_KEYS.map((k) => k.key), pinned: reworded },
      parseConfigurationAudit(files.configAudit),
    );
    assert.deepEqual(found, [], messages(found));
  });
});

describe('acceptance-tiers', () => {
  test('NEGATIVE CONTROL: TIERS and ADR-0027 §2 agree', () => {
    const found = checkAcceptanceTiers([...TIERS], parseTierList(files.adr));
    assert.deepEqual(found, [], messages(found));
  });

  test('the ADR block is actually found and parsed', () => {
    assert.deepEqual(parseTierList(files.adr), ['T0', 'T1', 'T2', 'T3', 'T4']);
  });

  test('a tier the code invented is refused', () => {
    const found = checkAcceptanceTiers([...TIERS, 'T5'], parseTierList(files.adr));
    assert.match(messages(found), /TIERS has "T5" and ADR-0027 §2 does not/);
  });
});

describe('hook-events — the one mirror whose other side may be absent', () => {
  test('an absent specification reports NOT CHECKED rather than passing', () => {
    const found = checkHookEvents([...USER_HOOK_EVENTS], undefined);
    assert.deepEqual(found.problems, []);
    assert.equal(found.checked, false, 'a check that could not run must not report success');
  });

  test('the v0.1 list is read and the 后续 list is not', { skip: spec === undefined }, () => {
    // §18.1 lists four more events under "later". Reading them as current would
    // make the check demand four hooks v0.1 deliberately does not have.
    const events = parseSpecHookEvents(spec!);
    // The 后续 assertion comes first, deliberately: `assert.deepEqual` from
    // `node:assert/strict` is a type guard (`asserts actual is T`), so after it
    // `events` is narrowed to the eight literal event names and asking whether it
    // contains a ninth stops typechecking.
    assert.equal(events.includes('PreCompact'), false, 'a future event was read as a v0.1 requirement');
    assert.deepEqual(events, [...USER_HOOK_EVENTS]);
  });

  test('NEGATIVE CONTROL: the shipped list matches the specification', { skip: spec === undefined }, () => {
    const found = checkHookEvents([...USER_HOOK_EVENTS], spec);
    assert.deepEqual(found.problems, [], messages(found.problems));
    assert.equal(found.checked, true);
  });

  test('an event the specification does not list for v0.1 is refused', { skip: spec === undefined }, () => {
    const found = checkHookEvents([...(USER_HOOK_EVENTS as readonly string[]), 'PreCompact'], spec);
    assert.match(messages(found.problems), /USER_HOOK_EVENTS has "PreCompact" and spec §18\.1 does not/);
  });
});

describe('readme-tools — one direction, deliberately', () => {
  test('NEGATIVE CONTROL: every core tool README names exists, and the count matches', () => {
    const found = checkReadmeTools(parseReadmeTools(files.readme), builtins);
    assert.deepEqual(found, [], messages(found));
  });

  test('the builtin scan finds the tool whose name grep could not see', () => {
    // `Shell` declares its name at src/tools/builtin/shell.ts:129 and a grep over
    // that file returned nothing at all on this machine. The scan is done in
    // process for that reason, and this asserts the result rather than trusting it.
    assert.ok(builtins.includes('Shell'), 'Shell was not found among the builtins');
    assert.ok(builtins.length >= 12, `found only ${builtins.length} builtin tools`);
  });

  test('a tool README calls core that does not exist is refused', () => {
    const found = checkReadmeTools({ names: ['Read', 'Imaginary'], count: 2 }, builtins);
    assert.match(messages(found), /README calls "Imaginary" a core tool/);
  });

  test('a count that disagrees with the list README prints is refused', () => {
    const found = checkReadmeTools({ names: ['Read', 'Edit'], count: 9 }, builtins);
    assert.match(messages(found), /says there are 9 core tools and lists 2/);
  });

  test('a list this check can no longer find is refused, not silently empty', () => {
    const found = checkReadmeTools(parseReadmeTools('# README\n\nno tool list here\n'), builtins);
    assert.match(messages(found), /no longer lists its core tools where this check looks/);
  });

  test('DELIBERATE GAP: a builtin missing from README is accepted', () => {
    // WebFetch, Delegate, Undo and Skill are conditionally registered and README
    // says so in prose. Asserting the reverse direction would need a second
    // hardcoded list of which builtins are conditional — another mirror, of the
    // kind this closure exists to reduce. The gap is in the audit's §4.
    assert.deepEqual(checkReadmeTools({ names: ['Read'], count: 1 }, builtins), []);
  });
});

describe('the audit has to cover every enumeration, both directions', () => {
  const audit = parseAudit(files.audit);

  test('the detector finds lists, sets and maps, and ignores what is not one', () => {
    const found = findEnumerations([
      {
        file: 'x.ts',
        source: [
          'export const A_LIST = [',
          'const A_SET = new Set([',
          'const A_MAP: Record<string, number> = {',
          'const lowercase = [',
          '  const NOT_TOP_LEVEL = [',
          'export const AB = [',
        ].join('\n'),
      },
    ]);
    assert.deepEqual(
      found.map((e) => e.name),
      ['A_LIST', 'A_SET', 'A_MAP'],
      'the detector changed shape; the audit is only as complete as this function',
    );
  });

  test('NEGATIVE CONTROL: the shipped audit classifies every enumeration exactly once', () => {
    const found = checkAuditCoverage(enumerations, audit.entries, parseAuditTotals(files.audit));
    assert.deepEqual([...audit.problems, ...found], [], messages([...audit.problems, ...found]));
    assert.ok(enumerations.length > 90, `found ${enumerations.length} enumerations`);
  });

  test('an enumeration with no row is refused — the alpha.6 defect, one level up', () => {
    const found = checkAuditCoverage(
      [...enumerations, { file: 'src/new.ts', line: 1, name: 'UNCLASSIFIED' }],
      audit.entries,
      parseAuditTotals(files.audit),
    );
    assert.match(
      messages(found),
      /declares UNCLASSIFIED and docs\/alpha12-enumeration-audit\.md does not classify it/,
    );
  });

  test('a row naming an enumeration that no longer exists is refused', () => {
    // What a rename leaves behind: a row asserting that something is guarded,
    // for a constant that is gone.
    const found = checkAuditCoverage(
      enumerations,
      [
        ...audit.entries,
        { file: 'src/gone.ts', name: 'DELETED', verdict: 'guarded', by: 'nothing', line: 9 },
      ],
      parseAuditTotals(files.audit),
    );
    assert.match(messages(found), /classifies DELETED in src\/gone\.ts, which declares no such enumeration/);
  });

  test('a row with a verdict outside the three is refused', () => {
    const { problems } = parseAudit('| `NAME` | `src/x.ts` | PROBABLY FINE | a reason |');
    assert.match(messages(problems), /every row is GUARDED, UNGUARDED or CLOSED/);
  });

  test('totals that disagree with the rows are refused', () => {
    const found = checkAuditCoverage(enumerations, audit.entries, {
      enumerations: 12,
      guarded: 1,
      unguarded: 2,
      closed: 3,
    });
    assert.match(messages(found), /says enumerations is 12; the rows give/);
    assert.match(messages(found), /says guarded is 1; the rows give/);
  });

  test('an audit that states no totals is refused', () => {
    const found = checkAuditCoverage(enumerations, audit.entries, undefined);
    assert.match(messages(found), /its own summary is not checkable/);
  });

  test('every mirror id has a check and a row in the audit, both ways', () => {
    // MIRRORS is itself a hardcoded list that mirrors a document, so it gets the
    // same treatment as everything it checks.
    for (const id of MIRRORS) {
      assert.ok(files.audit.includes(`\`${id}\``), `${id} has a check and no row in the audit`);
    }
    const documented = [...files.audit.matchAll(/^\| `([a-z-]+)`\s+\| `[^`]+` ↔/gm)].map((m) => m[1]!);
    for (const id of documented) {
      assert.ok(
        (MIRRORS as readonly string[]).includes(id),
        `the audit documents "${id}" and no check has that id`,
      );
    }
    assert.ok(
      documented.length >= MIRRORS.length,
      `the audit's mirror table lists ${documented.length} of ${MIRRORS.length}`,
    );
  });
});
