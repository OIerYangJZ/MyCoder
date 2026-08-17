/**
 * Self-tests for the acceptance-suite checks (alpha.12 §7, §12).
 *
 * > A gate that has never been run against a repository that violates it is not
 * > a gate. It is a description of the repository it was written in.
 *
 * `docs/acceptance-suite.md` is clean the day it is written — it was written to
 * be — so every check below gets a fixture that must be refused **and** a
 * near-miss that must be accepted. Without the first, a green run means nothing;
 * without the second, the check could be refusing everything.
 *
 * The last block is the one that matters most in a year: it runs the checks
 * against the shipped document, including the part that cannot always run. The
 * normative specification lives outside this repository and will be deleted, so
 * the clause-coverage check has an "unavailable" state — and an unavailable check
 * must report itself, never pass. That distinction has its own test.
 *
 * lint-allow-file no-real-credentials-in-tests: the fixtures below are
 * deliberately-broken acceptance documents, not credentials
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  checkCounts,
  checkItemEvidence,
  checkSpecCoverage,
  checkSuite,
  checkTiers,
  countItems,
  extractSpecClauses,
  normaliseClause,
  parseDeclaredCounts,
  parseSuite,
  SOURCES,
  TIERS,
  type AcceptanceItem,
  type SuiteProblem,
} from '../../scripts/acceptance.ts';
import type { CheckOptions } from '../../scripts/evidence.ts';

const messages = (found: readonly SuiteProblem[]): string =>
  found.map((p) => `${p.requirement}: ${p.message}`).join(' | ');

/** An item table, so a case can state the rows it needs and nothing else. */
function table(rows: readonly string[], header = 'Clause (spec §1.1, verbatim)'): string {
  return [
    `| Id | ${header} | Tier | Status | Evidence | Notes |`,
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

const row = (id: string, clause: string, tier: string, status: string, evidence = '', notes = ''): string =>
  `| ${id} | ${clause} | ${tier} | ${status} | ${evidence} | ${notes} |`;

function item(overrides: Partial<AcceptanceItem> = {}): AcceptanceItem {
  return {
    id: 'M01',
    clause: 'Session / Turn / Step 三层生命周期。',
    tier: 'T0',
    status: 'PASS',
    evidence: ['test:a real test name'],
    notes: '',
    line: 3,
    ...overrides,
  };
}

/** A corpus that contains exactly one test name, so a miss is unambiguous. */
const options: CheckOptions = {
  testCorpus: "test('a real test name', () => {})",
  artifactExists: async (p) => p === 'docs/second-operator-invitation.md',
};

/** A specification fragment with the four list shapes the real one uses. */
const SPEC_FIXTURE = [
  '## 1.1 v0.1 MUST',
  '',
  '- Session / Turn / Step 三层生命周期。',
  '- 流式 Model Runtime 接口。',
  '',
  '## 1.2 v0.1 SHOULD',
  '',
  '- 支持 Session resume。',
  '',
  '## 1.3 v0.1 NON-GOALS',
  '',
  '- 完整 TUI。',
  '',
  '# 25. Security Invariants',
  '',
  '1. Edit 必须通过 Freshness Ledger。',
  '',
  '# 26. Security Test Suite',
  '',
  '# 28. v0.1 Acceptance Criteria',
  '',
  '- [ ] stale file edit 被拒绝。',
  '',
  '# 29. Work Packages',
  '',
].join('\n');

describe('parsing the suite', () => {
  test('NEGATIVE CONTROL: a well-formed item table parses into items', () => {
    const { items, problems } = parseSuite(
      table([row('M01', 'a clause。', 'T0', 'PASS', 'test:x', 'a note')]),
    );
    assert.deepEqual(problems, [], messages(problems));
    assert.equal(items.length, 1);
    assert.deepEqual(
      { id: items[0]?.id, tier: items[0]?.tier, status: items[0]?.status, evidence: items[0]?.evidence },
      { id: 'M01', tier: 'T0', status: 'PASS', evidence: ['test:x'] },
    );
  });

  test('a table with no Id, Tier and Status triple is not read as items', () => {
    // The suite's own tier price list is exactly this shape. Reading it as items
    // would invent five rows with no clause and no evidence, and the counts
    // would then be wrong in a way that looks like a documentation error.
    const priceList = [
      '| Tier | What it needs | Items | Who can run it |',
      '| --- | --- | --- | --- |',
      '| T0 | nothing | 53 | anyone |',
    ].join('\n');
    const { items } = parseSuite(priceList);
    assert.deepEqual(items, []);
  });

  test('a duplicate item id is refused', () => {
    const { problems } = parseSuite(
      table([
        row('M01', 'one clause。', 'T0', 'PASS', 'test:x'),
        row('M01', 'another clause。', 'T0', 'PASS', 'test:x'),
      ]),
    );
    assert.equal(problems.length, 1, messages(problems));
    assert.match(problems[0]?.message ?? '', /duplicate item id/);
  });

  test('a row whose id is not an item id is refused rather than skipped', () => {
    // Skipping would be the dangerous choice: a mistyped id silently removes an
    // item from the suite, and the counts check would then be comparing two
    // numbers that agree with each other and not with the specification.
    const { items, problems } = parseSuite(table([row('M1', 'a clause。', 'T0', 'PASS', 'test:x')]));
    assert.deepEqual(items, []);
    assert.match(problems[0]?.message ?? '', /is not an item id/);
  });

  test('an em dash in the evidence cell means no evidence, not a reference', () => {
    const { items } = parseSuite(
      table([row('V02', 'a clause。', 'T0', 'NOT TESTED', '—', 'covered by nothing')]),
    );
    assert.deepEqual(items[0]?.evidence, []);
  });
});

describe('tiers', () => {
  test('NEGATIVE CONTROL: every tier the ADR defines is accepted', () => {
    const found = checkTiers(TIERS.map((tier, i) => item({ id: `M0${i + 1}`, tier })));
    assert.deepEqual(found, [], messages(found));
  });

  test('an item with no tier is refused', () => {
    const found = checkTiers([item({ tier: '' })]);
    assert.equal(found.length, 1, messages(found));
    assert.match(found[0]?.message ?? '', /declares no tier/);
  });

  test('an unknown tier is refused', () => {
    const found = checkTiers([item({ tier: 'T9' })]);
    assert.match(found[0]?.message ?? '', /not one of T0/);
  });

  test('an id prefix with no source is refused', () => {
    // Every item has to say where it came from, and an id is how it says it.
    // `X01` would otherwise count towards the total and towards no source.
    const found = checkTiers([item({ id: 'X01' })]);
    assert.match(found[0]?.message ?? '', /no source in SOURCES/);
    assert.ok(Object.keys(SOURCES).length >= 5);
  });
});

describe('evidence', () => {
  test('NEGATIVE CONTROL: a covered item naming a real test is accepted', async () => {
    const found = await checkItemEvidence([item()], options);
    assert.deepEqual(found, [], messages(found));
  });

  test('a covered item with no evidence is refused', async () => {
    const found = await checkItemEvidence([item({ evidence: [] })], options);
    assert.match(found[0]?.message ?? '', /marked PASS with no named evidence/);
  });

  test('an uncovered item that does not say why is refused', async () => {
    // NOT TESTED is a legal, useful answer — the suite has eight of them — but a
    // bare one is indistinguishable from a row somebody abandoned.
    const found = await checkItemEvidence([item({ status: 'NOT TESTED', evidence: [], notes: '' })], options);
    assert.match(found[0]?.message ?? '', /without saying why/);
  });

  test('an item naming a test that exists nowhere is refused', async () => {
    const found = await checkItemEvidence([item({ evidence: ['test:a test nobody wrote'] })], options);
    assert.match(found[0]?.message ?? '', /appears nowhere under tests/);
  });

  test('an item naming an artifact that does not exist is refused', async () => {
    const found = await checkItemEvidence([item({ evidence: ['artifact:docs/not-a-file.md'] })], options);
    assert.match(found[0]?.message ?? '', /points at a file that does not exist/);
  });
});

describe('counts', () => {
  const items = [
    item({ id: 'M01', tier: 'T0', status: 'PASS' }),
    item({ id: 'S01', tier: 'T1', status: 'NOT TESTED' }),
    item({ id: 'R01', tier: 'T4', status: 'NOT TESTED' }),
  ];

  const block = (body: string): string => ['```text', body, '```'].join('\n');

  const declared = (over: Partial<Record<string, string>> = {}): string =>
    block(
      [
        `items                 ${over.items ?? '3'}`,
        `  covered (PASS)      ${over.covered ?? '1'}`,
        `  uncovered           ${over.uncovered ?? '2'}`,
        '  FAIL                0',
        '  NOT APPLICABLE      0',
        '',
        `by tier               ${over.byTier ?? 'T0 1 · T1 1 · T2 0 · T3 0 · T4 1'}`,
        `by source             ${over.bySource ?? '§1.1 1 · §1.2 1 · §25 0 · §28 0 · ADR-0027 1'}`,
      ].join('\n'),
    );

  test('NEGATIVE CONTROL: counts that match the rows are accepted', () => {
    const parsed = parseDeclaredCounts(declared());
    assert.deepEqual(parsed.problems, [], messages(parsed.problems));
    const found = checkCounts(countItems(items), parsed.counts!, 1);
    assert.deepEqual(found, [], messages(found));
  });

  test('a covered count that disagrees with the rows is refused', () => {
    const parsed = parseDeclaredCounts(declared({ covered: '2', uncovered: '1' }));
    const found = checkCounts(countItems(items), parsed.counts!, 1);
    assert.equal(found.length, 2, messages(found));
    assert.match(messages(found), /says the covered count is 2; the rows give 1/);
  });

  test('a per-tier breakdown that disagrees is refused', () => {
    const parsed = parseDeclaredCounts(declared({ byTier: 'T0 2 · T1 0 · T2 0 · T3 0 · T4 1' }));
    const found = checkCounts(countItems(items), parsed.counts!, 1);
    assert.match(messages(found), /tier T0 is 2; the rows give 1/);
  });

  test('a per-source breakdown that disagrees is refused', () => {
    const parsed = parseDeclaredCounts(
      declared({ bySource: '§1.1 1 · §1.2 1 · §25 0 · §28 0 · ADR-0027 0' }),
    );
    const found = checkCounts(countItems(items), parsed.counts!, 1);
    assert.match(messages(found), /source ADR-0027 is 0; the rows give 1/);
  });

  test('a missing counts block is refused rather than treated as zero', () => {
    const parsed = parseDeclaredCounts('## 8. Counts\n\nnothing here yet\n');
    assert.ok(parsed.counts === undefined);
    assert.match(messages(parsed.problems), /does not state a total item count/);
  });

  test('a status outside the vocabulary is counted, and reported as uncountable', () => {
    // The subtotals would all agree while a row said "PASS — mostly", which is
    // the invented status alpha.11 found twice in the alpha.6 matrix.
    const odd = [...items, item({ id: 'A01', status: 'PASS — mostly' })];
    const parsed = parseDeclaredCounts(declared({ items: '4' }));
    const found = checkCounts(countItems(odd), parsed.counts!, 1);
    assert.match(messages(found), /carry a status outside PASS/);
  });
});

describe('clause coverage against the specification', () => {
  const spec = extractSpecClauses(SPEC_FIXTURE);
  const derived = [
    item({ id: 'M01', clause: 'Session / Turn / Step 三层生命周期。' }),
    item({ id: 'M02', clause: '流式 Model Runtime 接口。' }),
    item({ id: 'S01', clause: '支持 Session resume。' }),
    item({ id: 'V01', clause: 'Edit 必须通过 Freshness Ledger。' }),
    item({ id: 'A01', clause: 'stale file edit 被拒绝。' }),
    item({ id: 'R01', clause: 'Somebody who did not write this ran it.' }),
  ];

  test('the four list shapes are all read, and NON-GOALS are not', () => {
    assert.equal(spec.clauses.size, 5);
    assert.equal(spec.clauses.get(normaliseClause('流式 Model Runtime 接口。')), '§1.1');
    assert.equal(spec.clauses.get(normaliseClause('stale file edit 被拒绝。')), '§28');
    assert.equal(spec.clauses.has(normaliseClause('完整 TUI。')), false, 'a NON-GOAL became a requirement');
  });

  test('NEGATIVE CONTROL: a suite that covers every clause once is accepted', () => {
    const found = checkSpecCoverage(derived, spec, spec.sha256, 1);
    assert.deepEqual(found.problems, [], messages(found.problems));
    assert.equal(found.checked, true);
  });

  test('a clause with no item is refused', () => {
    const found = checkSpecCoverage(
      derived.filter((i) => i.id !== 'A01'),
      spec,
      spec.sha256,
      1,
    );
    assert.match(messages(found.problems), /is in the specification and in no item/);
  });

  test('two items quoting one clause is refused', () => {
    const found = checkSpecCoverage(
      [...derived, item({ id: 'M03', clause: '流式 Model Runtime 接口。' })],
      spec,
      spec.sha256,
      1,
    );
    assert.match(messages(found.problems), /already claimed by M02/);
  });

  test('an item quoting a clause the specification does not contain is refused', () => {
    // Either the quote drifted — a word changed while copying — or somebody
    // invented a requirement. Both are the same failure of derivation.
    const found = checkSpecCoverage(
      [...derived, item({ id: 'M04', clause: '一个不存在的要求。' })],
      spec,
      spec.sha256,
      1,
    );
    assert.match(messages(found.problems), /appears in no derived section/);
  });

  test('a specification that has changed since the derivation is refused', () => {
    const found = checkSpecCoverage(derived, spec, 'a'.repeat(64), 1);
    assert.match(messages(found.problems), /re-derive rather than re-hash/);
  });

  test('a missing hash is refused, so the derivation cannot be pinned to nothing', () => {
    const found = checkSpecCoverage(derived, spec, undefined, 1);
    assert.match(messages(found.problems), /pinned to nothing/);
  });

  test('an absent specification reports that it did not check, and does not pass', () => {
    // The distinction this whole file exists for. `checked: false` is what the
    // gate prints; a caller that ignored it would turn the strongest check in
    // the suite into a silence, which is what KERNEL_CONTAINER_REQUIRED exists
    // to prevent one layer down.
    const found = checkSpecCoverage(derived, undefined, spec.sha256, 1);
    assert.deepEqual(found.problems, []);
    assert.equal(found.checked, false, 'an unavailable check must not report itself as done');
  });
});

describe('the shipped suite', () => {
  const read = async (): Promise<string> =>
    readFile(new URL('../../docs/acceptance-suite.md', import.meta.url), 'utf8');

  test('parses, and every item carries a tier and a legal status', async () => {
    const { items, problems } = parseSuite(await read());
    assert.deepEqual(problems, [], messages(problems));
    assert.ok(items.length > 50, `parsed ${items.length} items; the document looks unread`);
    assert.deepEqual(checkTiers(items), []);
  });

  test('every §1.1 MUST and §1.2 SHOULD has exactly one item, without reading the specification', async () => {
    // The §12 requirement, in the form that still works after `research/` is
    // deleted: 17 MUST ids and 6 SHOULD ids, each exactly once. The stronger
    // clause-text version runs above and in the gate, when the spec is present.
    const { items } = parseSuite(await read());
    const ids = items.map((i) => i.id);
    for (const [prefix, count] of [
      ['M', 17],
      ['S', 6],
      ['V', 15],
      ['A', 21],
      ['R', 3],
    ] as const) {
      const found = ids.filter((id) => id.startsWith(prefix));
      assert.equal(found.length, count, `${prefix}: expected ${count} items, found ${found.length}`);
      assert.equal(new Set(found).size, found.length, `${prefix}: duplicate ids`);
      for (let n = 1; n <= count; n += 1) {
        assert.ok(found.includes(`${prefix}${String(n).padStart(2, '0')}`), `${prefix}${n} is missing`);
      }
    }
  });

  test('its own counts match its own rows', async () => {
    const markdown = await read();
    const parsed = parseDeclaredCounts(markdown);
    assert.deepEqual(parsed.problems, [], messages(parsed.problems));
    const found = checkCounts(countItems(parseSuite(markdown).items), parsed.counts!, 1);
    assert.deepEqual(found, [], messages(found));
  });

  test('the uncovered count is not zero, or the suite was written from the answers', async () => {
    // alpha.12's Green First Run Stop, as a test. A suite that covers every
    // clause on the day it is written was derived from the test tree; this
    // assertion is what makes that claim falsifiable rather than a promise in a
    // document. It is expected to fail one day — when the last uncovered item is
    // closed — and the person who sees it fail should read §9 and delete it,
    // deliberately, rather than adjust it.
    const { items } = parseSuite(await read());
    const uncovered = items.filter((i) => i.status === 'NOT TESTED');
    assert.ok(uncovered.length > 0, 'every clause is covered; audit the derivation before believing it');
  });

  test('the whole check runs against the shipped document with no problems', async () => {
    let spec;
    try {
      spec = extractSpecClauses(
        await readFile(new URL('../../../research/kernel_v0.1_technical_spec.md', import.meta.url), 'utf8'),
      );
    } catch {
      spec = undefined;
    }

    const report = await checkSuite(await read(), spec, {
      testCorpus: await corpus(),
      artifactExists: async (p) => {
        try {
          await readFile(new URL(`../../${p}`, import.meta.url));
          return true;
        } catch {
          return false;
        }
      },
    });

    assert.deepEqual(report.problems, [], messages(report.problems));
    // And the state of the world is reported either way, so a run in CI — where
    // `research/` does not exist — cannot be mistaken for a run that re-derived.
    assert.equal(report.specChecked, spec !== undefined);
  });
});

/** Every test name and file name under tests/, as the gate builds it. */
async function corpus(): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const parts: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith('.ts')) parts.push(entry.name, await readFile(child, 'utf8'));
    }
  };
  await walk(new URL('../../tests/', import.meta.url));
  parts.push(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  return parts.join('\n');
}
