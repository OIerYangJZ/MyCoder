/**
 * Self-tests for the release evidence gate (alpha.3 §33–§35).
 *
 * The gate's whole job is to refuse a claim that points at nothing. That makes
 * its own failure mode the same one it exists to catch: a parser that silently
 * matches no rows reports zero problems, and zero problems is what a healthy
 * matrix looks like. So the coverage assertion at the bottom checks the real
 * document actually parses into rows, and every rejection rule gets a fixture
 * that must be rejected *and* a near-miss that must be accepted.
 *
 * lint-allow-file no-real-credentials-in-tests: none present, but the fixtures
 * below deliberately contain malformed evidence references
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { checkRows, parseMatrix, STATUSES, type Problem } from '../../scripts/evidence.ts';

const HEADER = ['| Requirement | Status | Evidence | Notes |', '| --- | --- | --- | --- |'].join('\n');

/** Lint one table body against a permissive world, so only the rule under test can fire. */
async function problems(
  body: string,
  world: { tests?: string; artifacts?: string[] } = {},
): Promise<Problem[]> {
  const rows = parseMatrix(`${HEADER}\n${body}`);
  assert.ok(rows.length > 0, 'the fixture produced no rows, so this case proves nothing');

  return checkRows(rows, {
    testCorpus: world.tests ?? 'a known test name\nanother known test',
    artifactExists: async (p) => (world.artifacts ?? ['docs/exists.md']).includes(p),
  });
}

const messages = (found: readonly Problem[]): string => found.map((p) => p.message).join(' | ');

describe('the evidence gate rejects unsupported claims (§33)', () => {
  test('NEGATIVE CONTROL: a well-formed PASS row is accepted', async () => {
    // Everything below asserts a rejection, which is only meaningful if the
    // gate accepts something.
    const found = await problems('| credential mode checked | PASS | test:a known test name | |');
    assert.deepEqual(found, [], messages(found));
  });

  test('a PASS row with no evidence is rejected', async () => {
    // The rule §32.1 exists for, and the one alpha.2 violated twice.
    const found = await problems('| overflow retry bounded | PASS | | |');
    assert.equal(found.length, 1);
    assert.match(messages(found), /marked PASS with no named evidence/);
  });

  test('a FAIL row with no evidence is rejected too', async () => {
    // A known failure that names nothing is as unactionable as an unsupported
    // pass, and it is how a FAIL quietly becomes folklore.
    const found = await problems('| something broken | FAIL | | |');
    assert.match(messages(found), /nothing pointing at the failure/);
  });

  test('a status outside the vocabulary is rejected', async () => {
    // §34 allows exactly four. "PARTIAL", "MOSTLY" and "N/A" are how a matrix
    // starts meaning whatever the reader wants.
    for (const bad of ['PARTIAL', 'N/A', 'DONE', 'pass']) {
      const found = await problems(`| a requirement | ${bad} | test:a known test name | |`);
      assert.match(messages(found), /is not one of/, `status "${bad}" was accepted`);
    }
  });

  test('every allowed status is actually allowed', async () => {
    for (const status of STATUSES) {
      const evidence = status === 'PASS' || status === 'FAIL' ? 'test:a known test name' : '';
      const notes = status === 'NOT TESTED' ? 'needs a real VPS' : '';
      const found = await problems(`| a requirement | ${status} | ${evidence} | ${notes} |`);
      assert.deepEqual(found, [], `status "${status}" was rejected: ${messages(found)}`);
    }
  });

  test('evidence with no recognised prefix is rejected', async () => {
    // §33's "Not acceptable" list, verbatim: "implemented", "seems covered",
    // "tested before".
    for (const bad of ['implemented', 'seems covered', 'tested before']) {
      const found = await problems(`| a requirement | PASS | ${bad} | |`);
      assert.match(messages(found), /no recognised prefix/, `evidence "${bad}" was accepted`);
    }
  });

  test('evidence naming a test that does not exist is rejected', async () => {
    const found = await problems('| a requirement | PASS | test:a test nobody wrote | |');
    assert.match(messages(found), /appears nowhere under tests\//);
  });

  test('evidence naming a missing artifact is rejected', async () => {
    const found = await problems('| a requirement | PASS | artifact:docs/not-written-yet.md | |');
    assert.match(messages(found), /points at a file that does not exist/);
  });

  test('evidence naming an artifact that exists is accepted', async () => {
    const found = await problems('| a requirement | PASS | artifact:docs/exists.md | |');
    assert.deepEqual(found, [], messages(found));
  });

  test('a bare manual reference is rejected', async () => {
    // "manual:" is the weakest evidence there is, so it has to carry a
    // procedure rather than a gesture at one.
    const found = await problems('| a requirement | PASS | manual:checked | |');
    assert.match(messages(found), /too vague for a manual procedure/);
  });

  test('a described manual procedure is accepted', async () => {
    const found = await problems(
      '| a requirement | PASS | manual:ran the tag checklist against the release commit and captured the output | |',
    );
    assert.deepEqual(found, [], messages(found));
  });

  test('NOT TESTED without a reason is rejected', async () => {
    // An unexplained NOT TESTED is indistinguishable from an oversight, which
    // defeats the point of allowing the status at all.
    const found = await problems('| a requirement | NOT TESTED | | |');
    assert.match(messages(found), /without saying why/);
  });

  test('multiple evidence references are each checked', async () => {
    const found = await problems(
      '| a requirement | PASS | test:a known test name, test:a test nobody wrote | |',
    );
    assert.equal(found.length, 1, messages(found));
    assert.match(messages(found), /a test nobody wrote/);
  });

  test('a reference whose target starts with a prefix word is not split', async () => {
    // `suite:test:live:model` is a real pnpm script name. Splitting before the
    // nested `test:` produced a bare `suite:` that "names nothing" plus a stray
    // second reference — a confusing failure for a correct row.
    const rows = parseMatrix(`${HEADER}\n| a requirement | PASS | suite:test:live:model | |`);
    assert.deepEqual(rows[0]?.evidence, ['suite:test:live:model']);
  });

  test('an empty evidence reference is rejected', async () => {
    const found = await problems('| a requirement | PASS | test: | |');
    assert.match(messages(found), /names nothing/);
  });
});

describe('the parser sees the real document', () => {
  test('the shipped matrix parses into rows', async () => {
    // Without this, every gate run could be passing on an empty table.
    const markdown = await readFile(new URL('../../docs/alpha3-evidence-matrix.md', import.meta.url), 'utf8');
    const rows = parseMatrix(markdown);

    assert.ok(rows.length > 40, `only ${rows.length} requirement rows parsed; the matrix looks unread`);
  });

  test('header and separator rows are not mistaken for requirements', async () => {
    const markdown = await readFile(new URL('../../docs/alpha3-evidence-matrix.md', import.meta.url), 'utf8');
    const rows = parseMatrix(markdown);

    for (const row of rows) {
      assert.notEqual(row.requirement, 'Requirement', 'a header row was parsed as a requirement');
      assert.ok(!/^:?-+:?$/.test(row.status), `a separator row was parsed as a requirement: ${row.status}`);
    }
  });

  test('every row in the shipped matrix uses an allowed status', async () => {
    const markdown = await readFile(new URL('../../docs/alpha3-evidence-matrix.md', import.meta.url), 'utf8');

    for (const row of parseMatrix(markdown)) {
      assert.ok(
        (STATUSES as readonly string[]).includes(row.status),
        `"${row.requirement}" has status "${row.status}"`,
      );
    }
  });
});
