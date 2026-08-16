/**
 * Self-tests for the corpus checks (alpha.11 §7, §11).
 *
 * > A gate that has never been run against a repository that violates it is not
 * > a gate. It is a description of the repository it was written in.
 *
 * That is the rule this file exists to satisfy, and it is why every check below
 * gets a fixture that must be refused *and* a near-miss that must be accepted.
 * The three checks were written against a corpus that is currently clean, so
 * without deliberately broken fixtures they would all be vacuously green — which
 * is indistinguishable from working, and is the §13 Gate Vacuity Stop.
 *
 * The last describe block is the one that would have caught alpha.6: the gate's
 * matrix list is hardcoded, and for five milestones it silently omitted a
 * document sitting next to the ones it read.
 *
 * lint-allow-file no-real-credentials-in-tests: the fixtures below are
 * deliberately-broken evidence documents, not credentials
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { MATRICES, parseMatrix } from '../../scripts/evidence.ts';
import {
  checkClosedAnnotations,
  checkIndexReconciliation,
  checkOneClaimOneStatus,
  normaliseClaim,
  parseOpenEvidence,
  type CorpusProblem,
  type CorpusRow,
} from '../../scripts/evidence-corpus.ts';

const DOCS = new URL('../../docs/', import.meta.url);

/** Build a corpus row without hand-writing a whole matrix for every case. */
function row(matrix: string, ordinal: number, requirement: string, status: string, notes: string): CorpusRow {
  return {
    matrix: `docs/${matrix}-evidence-matrix.md`,
    milestone: `alpha.${matrix.replace('alpha', '')}`,
    ordinal,
    requirement,
    status,
    evidence: [],
    notes,
    line: 10 + ordinal,
    evidenceStyle: 'named',
    supporting: [],
  };
}

const messages = (found: readonly CorpusProblem[]): string => found.map((p) => p.message).join(' | ');

/** A minimal index, so a case can name the entries it needs and no others. */
function index(body: string): ReturnType<typeof parseOpenEvidence> {
  return parseOpenEvidence(
    ['## A. Blocked on a person or a machine', '', '| # | Claim | Needs |', '| --- | --- | --- |', body].join(
      '\n',
    ),
  );
}

describe('§7.1 — one claim, one status', () => {
  test('NEGATIVE CONTROL: two matrices agreeing about one claim are accepted', () => {
    const found = checkOneClaimOneStatus([
      row('alpha7', 6, 'a live-model dogfood on the native backend', 'NOT TESTED', '[open:A3]'),
      row('alpha8', 7, 'a live-model dogfood on the native backend', 'NOT TESTED', '[open:A3]'),
    ]);
    assert.deepEqual(found, [], messages(found));
  });

  test('the same claim with two statuses is refused', () => {
    // The defect verbatim: one hour after CLOSURE C was downgraded, three
    // matrices said NOT APPLICABLE and two still said NOT TESTED, and the
    // corpus was green throughout.
    const found = checkOneClaimOneStatus([
      row('alpha8', 7, 'strict egress on a clean resolver', 'NOT TESTED', '[open:A7]'),
      row('alpha9', 8, 'strict egress on a clean resolver', 'NOT APPLICABLE', '[open:A7]'),
    ]);
    assert.equal(found.length, 1, messages(found));
    assert.match(messages(found), /carries "NOT APPLICABLE" while .*carries "NOT TESTED"/);
  });

  test('the later row naming the earlier milestone is accepted', () => {
    // "alpha.5 said NOT TESTED, alpha.6 built the proxy" is a true statement
    // about a corpus that spans time. What the check forbids is saying it
    // silently.
    const found = checkOneClaimOneStatus([
      row('alpha5', 4, 'host-scoped network allowlist enforcement', 'NOT TESTED', '[open:A7]'),
      row(
        'alpha6',
        5,
        'host-scoped network allowlist enforcement',
        'PASS',
        'Closed by alpha.5 having deferred it',
      ),
    ]);
    assert.deepEqual(found, [], messages(found));
  });

  test('claims worded differently but pointing at one index entry are compared', () => {
    // The reason the check does not key on text alone. The five rows that
    // carried CLOSURE C were worded five ways; only two of them matched as
    // strings, so a text-only check would have caught two of the five.
    const found = checkOneClaimOneStatus([
      row('alpha6', 5, 'real-internet path under the strict address policy', 'NOT TESTED', '[open:A7]'),
      row(
        'alpha10',
        9,
        'strict egress on a genuinely global resolved address',
        'NOT APPLICABLE',
        '[open:A7]',
      ),
    ]);
    assert.equal(found.length, 1, messages(found));
    assert.match(messages(found), /same claim/);
  });

  test('a disagreement is reported once, not once per key', () => {
    const found = checkOneClaimOneStatus([
      row('alpha8', 7, 'strict egress on a clean resolver', 'NOT TESTED', '[open:A7]'),
      row('alpha9', 8, 'strict egress on a clean resolver', 'NOT APPLICABLE', '[open:A7]'),
    ]);
    assert.equal(found.length, 1, messages(found));
  });

  test('normalisation ignores emphasis and a trailing section reference', () => {
    assert.equal(
      normaliseClaim('**Strict public-address egress on a clean resolver** (§39–41)'),
      normaliseClaim('strict public-address egress on a clean resolver'),
    );
  });

  test('normalisation does not merge two genuinely different claims', () => {
    // A false failure is worse than a missed one here: it is how a gate gets
    // switched off.
    assert.notEqual(
      normaliseClaim('a live-model dogfood on the native backend'),
      normaliseClaim('a live-model dogfood on the container backend'),
    );
  });
});

describe('§7.2 — every open claim is in the index, and every entry has a row', () => {
  const one = index('| A3 | a live-model dogfood | a credential |');

  test('NEGATIVE CONTROL: a marked row with a matching entry is accepted', () => {
    const found = checkIndexReconciliation(
      [row('alpha8', 7, 'a live-model dogfood', 'NOT TESTED', 'needs a credential [open:A3]')],
      one.entries,
    );
    assert.deepEqual(found, [], messages(found));
  });

  test('a non-PASS row with no marker is refused', () => {
    const found = checkIndexReconciliation(
      [row('alpha8', 7, 'something unproven', 'NOT TESTED', 'no idea')],
      one.entries,
    );
    assert.match(messages(found), /no index marker/);
  });

  test('a row naming an entry the index does not define is refused', () => {
    const found = checkIndexReconciliation(
      [row('alpha8', 7, 'something unproven', 'NOT TESTED', '[open:A9]')],
      one.entries,
    );
    assert.match(messages(found), /A9, which docs\/open-evidence\.md does not define/);
  });

  test('an index entry with no live row is refused', () => {
    // The other direction, and it fails differently: a claim quietly deleted
    // from the corpus while the index kept advertising it.
    const found = checkIndexReconciliation([], one.entries);
    assert.match(messages(found), /listed in the index but no matrix row names it/);
  });

  test('a row carrying two markers is refused', () => {
    const found = checkIndexReconciliation(
      [row('alpha8', 7, 'something unproven', 'NOT TESTED', '[open:A3] [scope]')],
      one.entries,
    );
    assert.match(messages(found), /more than one index marker/);
  });

  test('an out-of-scope row needs no index entry', () => {
    // A NON-GOAL is not a claim about the world, and putting 25 of them in the
    // index would drown the seven things that actually are.
    const found = checkIndexReconciliation(
      [
        row('alpha4', 3, 'agent teams / swarm', 'NOT APPLICABLE', '§5 NON-GOAL [scope]'),
        row('alpha8', 7, 'a live-model dogfood', 'NOT TESTED', '[open:A3]'),
      ],
      one.entries,
    );
    assert.deepEqual(found, [], messages(found));
  });

  test('a PASS row needs no marker', () => {
    const found = checkIndexReconciliation(
      [
        row('alpha8', 7, 'something proven', 'PASS', ''),
        row('alpha8', 7, 'a live-model dogfood', 'NOT TESTED', '[open:A3]'),
      ],
      one.entries,
    );
    assert.deepEqual(found, [], messages(found));
  });

  test('the index refuses an entry with no id', () => {
    const parsed = index('| | a claim with no id | something |');
    assert.match(messages(parsed.problems), /every entry needs an id of the form A1/);
  });

  test('the index refuses a duplicate id', () => {
    const parsed = index(['| A3 | one claim | a machine |', '| A3 | another claim | a machine |'].join('\n'));
    assert.match(messages(parsed.problems), /duplicate index id A3/);
  });
});

describe('§7.3 — a closed claim cannot keep saying it is open', () => {
  const closedIndex = parseOpenEvidence(
    [
      '## C. Closed elsewhere',
      '',
      '| # | Claim | Closed by |',
      '| --- | --- | --- |',
      '| C1 | OS-level isolation of a child | alpha.5 — Subagent + Container green |',
    ].join('\n'),
  );

  test('NEGATIVE CONTROL: a closed row that says so is accepted, and counted', () => {
    const result = checkClosedAnnotations(
      [
        row(
          'alpha4',
          3,
          'OS-level isolation of a child',
          'NOT TESTED',
          '**Closed by alpha.5** — see §169 [closed:C1]',
        ),
      ],
      closedIndex.entries,
    );
    assert.deepEqual(result.problems, [], messages(result.problems));
    assert.equal(result.closed, 1);
  });

  test('a closed row with no readable closure is refused', () => {
    const result = checkClosedAnnotations(
      [row('alpha4', 3, 'OS-level isolation of a child', 'NOT TESTED', 'sorted out later [closed:C1]')],
      closedIndex.entries,
    );
    assert.match(messages(result.problems), /does not say so in a readable form/);
  });

  test('a row whose closure milestone disagrees with the index is refused', () => {
    // Two accounts of when a thing was closed is the same defect as two
    // statuses for one claim, one document further out.
    const result = checkClosedAnnotations(
      [row('alpha4', 3, 'OS-level isolation of a child', 'NOT TESTED', '**Closed by alpha.7** [closed:C1]')],
      closedIndex.entries,
    );
    assert.match(messages(result.problems), /says "alpha\.7" closed it; .* says "alpha\.5"/);
  });

  test('a row indexed as open while claiming to be closed is refused', () => {
    const open = index('| A3 | a live-model dogfood | a credential |');
    const result = checkClosedAnnotations(
      [row('alpha8', 7, 'a live-model dogfood', 'NOT TESTED', '**Closed by alpha.9** [open:A3]')],
      open.entries,
    );
    assert.match(messages(result.problems), /says it was closed .* still indexed as open/);
  });

  test('open, closed and out-of-scope rows are counted separately', () => {
    // §7.3's actual requirement: a reader counting open items and the gate
    // counting them get the same number, which needs the gate to have a number.
    const result = checkClosedAnnotations(
      [
        row('alpha8', 7, 'one', 'NOT TESTED', '[open:A3]'),
        row('alpha8', 7, 'two', 'NOT TESTED', '**Closed by alpha.5** [closed:C1]'),
        row('alpha8', 7, 'three', 'NOT APPLICABLE', '[scope]'),
        row('alpha8', 7, 'four', 'NOT APPLICABLE', '[scope]'),
        row('alpha8', 7, 'five', 'PASS', ''),
      ],
      closedIndex.entries,
    );
    assert.deepEqual(
      { open: result.open, closed: result.closed, scope: result.scope },
      {
        open: 1,
        closed: 1,
        scope: 2,
      },
    );
  });

  test('a section C entry that names no milestone is refused', () => {
    const parsed = parseOpenEvidence(
      [
        '## C. Closed elsewhere',
        '',
        '| # | Claim | Closed by |',
        '| --- | --- | --- |',
        '| C1 | a claim | later |',
      ].join('\n'),
    );
    assert.match(messages(parsed.problems), /does not name the milestone that closed it/);
  });
});

describe('the checks run on every matrix, not a subset', () => {
  test('every evidence matrix in docs/ is registered in the gate', async () => {
    // alpha.6 was not, for five milestones, and nothing said so. The list is
    // hardcoded — that is a deliberate choice, so that adding a matrix is a
    // decision — but an unregistered one has to be a failure rather than a
    // silence, because a matrix outside the gate is a document that looks
    // exactly like evidence and is checked by nobody.
    const onDisk = (await readdir(DOCS)).filter((f) => /evidence-matrix\.md$/.test(f)).sort();
    const registered = MATRICES.map((m) => m.path.replace('docs/', '')).sort();

    assert.deepEqual(
      onDisk.filter((f) => !registered.includes(f)),
      [],
      'an evidence matrix exists that the gate does not read',
    );
  });

  test('every registered matrix parses into rows with a real status', async () => {
    // The gate's own failure mode: a parser that matches nothing reports no
    // problems, and no problems is what a healthy corpus looks like.
    for (const matrix of MATRICES) {
      const markdown = await readFile(new URL(`../../${matrix.path}`, import.meta.url), 'utf8');
      const rows = parseMatrix(markdown);
      assert.ok(rows.length > 10, `${matrix.path} parsed into ${rows.length} rows; it looks unread`);
    }
  });

  test('the status-last table shape is read, not skipped', async () => {
    // alpha.6 puts Status in the sixth column. Reading tables by position
    // rather than by header is why it was invisible.
    const markdown = await readFile(new URL('../../docs/alpha6-evidence-matrix.md', import.meta.url), 'utf8');
    const rows = parseMatrix(markdown);

    assert.ok(
      rows.some((r) => r.status === 'PASS' && r.evidenceStyle === 'inline'),
      'no inline-evidence PASS row was parsed out of the alpha.6 matrix',
    );
  });

  test('a table with no Status column is skipped rather than misread', () => {
    const rows = parseMatrix(
      ['| Column | Meaning |', '| --- | --- |', '| Primary evidence | the test that asserts it |'].join('\n'),
    );
    assert.deepEqual(rows, []);
  });

  test('one table layout does not leak into the next table', () => {
    const rows = parseMatrix(
      [
        '| Requirement | Status | Evidence | Notes |',
        '| --- | --- | --- | --- |',
        '| a claim | PASS | test:x | |',
        '',
        'Some prose between the tables.',
        '',
        '| Column | Meaning |',
        '| --- | --- |',
        '| Primary evidence | the test |',
      ].join('\n'),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.requirement, 'a claim');
  });
});

describe('the corpus as it actually stands', () => {
  test('the shipped index parses, and every entry is reachable', async () => {
    const markdown = await readFile(new URL('open-evidence.md', DOCS), 'utf8');
    const parsed = parseOpenEvidence(markdown);

    assert.deepEqual(parsed.problems, [], messages(parsed.problems));
    assert.ok(parsed.entries.length >= 9, `only ${parsed.entries.length} index entries parsed`);
    assert.ok(
      parsed.entries.some((e) => e.section === 'C' && e.closedBy !== undefined),
      'no closed entry names the milestone that closed it',
    );
  });
});
