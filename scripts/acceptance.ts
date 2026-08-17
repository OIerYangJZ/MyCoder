/**
 * The acceptance-suite checks (alpha.12 §7, §12).
 *
 * `docs/acceptance-suite.md` is the definition of what this software must do to
 * be called v0.1. It is a document plus a mapping, deliberately — not a test
 * framework, and not a second evidence gate. So this module is the part of it a
 * machine can hold:
 *
 *   1. does every item declare a tier the suite knows about?
 *   2. does every item carry a legal status, and does a covered item name
 *      evidence that resolves?
 *   3. do the counts the document prints match the counts of its own rows?
 *   4. does every clause of the specification appear exactly once — and does
 *      every clause-sourced item correspond to a clause that exists?
 *
 * Check 4 is the one that keeps the suite honest over time, and it is also the
 * one that cannot always run: the normative specification lives in `research/`,
 * which is in no version control and will be deleted. The suite quotes its
 * clauses precisely so it survives that. When the specification *is* present the
 * check re-derives against it, hash included; when it is absent the caller is
 * told the derivation was **not** re-checked, rather than being handed a pass. A
 * check that silently skips is the failure mode this repository has now hit
 * twice (KERNEL_CONTAINER_REQUIRED exists for the same reason).
 *
 * What none of this does is decide whether a clause is *satisfied*. An item can
 * name a test that exists, passes, and does not establish the clause. That
 * judgement is made by reading, it is recorded in the suite's notes, and
 * pretending a gate could make it would be the overclaim the suite exists to
 * prevent.
 */

import { createHash } from 'node:crypto';

import { checkRows, splitEvidence, STATUSES, type CheckOptions, type Problem, type Row } from './evidence.ts';

/** The tiers from ADR-0027 §2. A tier outside this list is a typo, not a new tier. */
export const TIERS = ['T0', 'T1', 'T2', 'T3', 'T4'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Which specification section each id prefix comes from.
 *
 * `R` is the odd one out and is meant to be: those three items are what a
 * release *candidate* asserts, and no specification contains them (ADR-0027 §3).
 * Keeping them in the same table as the clause-derived items, with a prefix that
 * says where they came from, is what stops them being quietly treated as
 * requirements — or quietly dropped.
 */
export const SOURCES: Record<string, string> = {
  M: '§1.1',
  S: '§1.2',
  V: '§25',
  A: '§28',
  R: 'ADR-0027',
};

export interface AcceptanceItem {
  id: string;
  clause: string;
  tier: string;
  status: string;
  evidence: string[];
  notes: string;
  line: number;
}

export interface SuiteProblem extends Problem {
  /** Always the suite; the shape matches the evidence gate's so they can be printed together. */
  matrix: string;
}

const SUITE = 'docs/acceptance-suite.md';

const problem = (line: number, requirement: string, message: string): SuiteProblem => ({
  matrix: SUITE,
  line,
  requirement,
  message,
});

/**
 * Reduce a clause to its content, so that the suite's copy and the
 * specification's original compare equal.
 *
 * Whitespace is removed entirely rather than collapsed. The clauses are mostly
 * Chinese, where a space is not a word boundary, and the two documents disagree
 * about spacing for reasons that carry no meaning: Prettier pads table cells,
 * and `Read / Grep / Glob` in a table is `Read / Grep / Glob` in a bullet with
 * different runs of spaces around the slashes. Emphasis and backticks go for the
 * same reason. Nothing else is touched — over-normalising would merge two
 * clauses that differ, and then report that the suite is missing one.
 */
export function normaliseClause(text: string): string {
  return text
    .replace(/[*`_]/g, '')
    .replace(/\s+/g, '')
    .replace(/[。.;；]+$/, '')
    .toLowerCase();
}

const isSeparator = (line: string): boolean => /^\|(?:\s*:?-{2,}:?\s*\|)+$/.test(line.replace(/\s+/g, ' '));

const cellsOf = (line: string): string[] =>
  line
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());

/**
 * Parse the item tables out of the suite.
 *
 * An item table is one with `Id`, `Tier` and `Status` columns. That triple is
 * the discriminator rather than a heading position, for the reason alpha.11
 * found the hard way: reading tables by position made an 83-row matrix
 * invisible for five milestones. It also means the document can carry tables
 * that are *not* item tables — the tier price list, the uncovered summary, the
 * counts — without them being parsed into rows of nonsense.
 */
export function parseSuite(markdown: string): { items: AcceptanceItem[]; problems: SuiteProblem[] } {
  const items: AcceptanceItem[] = [];
  const problems: SuiteProblem[] = [];
  const lines = markdown.split('\n').map((l) => l.trim());

  let columns:
    { id: number; clause: number; tier: number; status: number; evidence: number; notes: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('|') || !line.endsWith('|')) {
      columns = undefined;
      continue;
    }
    if (isSeparator(line)) continue;

    const cells = cellsOf(line);

    if (isSeparator(lines[i + 1] ?? '')) {
      const find = (name: string): number =>
        cells.findIndex((c) => c.replace(/[*`]/g, '').toLowerCase().startsWith(name));
      const id = find('id');
      const tier = find('tier');
      const status = find('status');
      // The clause column is headed "Clause (spec §1.1, verbatim)" in the
      // clause-derived sections and "Item (source: ADR-0027 §3)" in §7.
      const clause = Math.max(find('clause'), find('item'));
      columns =
        id >= 0 && tier >= 0 && status >= 0 && clause >= 0
          ? { id, clause, tier, status, evidence: find('evidence'), notes: find('notes') }
          : undefined;
      continue;
    }
    if (!columns) continue;

    const id = (cells[columns.id] ?? '').replace(/[*`]/g, '').trim();
    if (id === '') continue;

    if (!/^[A-Z]\d{2}$/.test(id)) {
      problems.push(
        problem(i + 1, id, `is not an item id of the form M01; every row of an item table needs one`),
      );
      continue;
    }

    // An em dash is how every table in this repository writes "deliberately
    // nothing", and an uncovered item's evidence cell is the one place that has
    // to be legible as empty rather than as a reference to a file called `—`.
    const rawEvidence = columns.evidence >= 0 ? (cells[columns.evidence] ?? '') : '';
    const evidenceCell = /^[—–-]$/.test(rawEvidence.trim()) ? '' : rawEvidence;
    items.push({
      id,
      clause: cells[columns.clause] ?? '',
      tier: (cells[columns.tier] ?? '').replace(/[*`]/g, '').trim(),
      status: (cells[columns.status] ?? '').replace(/\*\*/g, '').trim(),
      evidence: splitEvidence(evidenceCell),
      notes: columns.notes >= 0 ? (cells[columns.notes] ?? '').trim() : '',
      line: i + 1,
    });
  }

  const seen = new Map<string, number>();
  for (const item of items) {
    const first = seen.get(item.id);
    if (first !== undefined) {
      problems.push(problem(item.line, item.id, `duplicate item id; it is already used at line ${first}`));
    }
    seen.set(item.id, item.line);
  }

  return { items, problems };
}

/** §12: every item names a tier, and it is one of the five. */
export function checkTiers(items: readonly AcceptanceItem[]): SuiteProblem[] {
  const problems: SuiteProblem[] = [];
  for (const item of items) {
    if (item.tier === '') {
      problems.push(
        problem(item.line, item.id, 'declares no tier; an item whose price is unstated cannot be scheduled'),
      );
      continue;
    }
    if (!TIERS.includes(item.tier as Tier)) {
      problems.push(
        problem(item.line, item.id, `declares tier "${item.tier}", which is not one of ${TIERS.join(' / ')}`),
      );
    }
    if (!(item.id[0]! in SOURCES)) {
      problems.push(
        problem(item.line, item.id, `has an id prefix "${item.id[0]}" with no source in SOURCES`),
      );
    }
  }
  return problems;
}

/**
 * The evidence rules, borrowed whole from the release evidence gate.
 *
 * Deliberately borrowed rather than reimplemented: a second copy of "what counts
 * as evidence" is a second vocabulary, which §7.5 forbids, and it would drift.
 * The items are handed over as `Row`s so the same code answers the same question
 * — does this claim point at something that exists?
 */
export async function checkItemEvidence(
  items: readonly AcceptanceItem[],
  opts: CheckOptions,
): Promise<SuiteProblem[]> {
  const rows: Row[] = items.map((item) => ({
    requirement: item.id,
    status: item.status,
    evidence: item.evidence,
    notes: item.notes,
    line: item.line,
    evidenceStyle: 'named',
    supporting: [item.clause, item.notes],
  }));

  return (await checkRows(rows, opts)).map((p) => ({ ...p, matrix: SUITE }));
}

export interface Counts {
  items: number;
  covered: number;
  uncovered: number;
  fail: number;
  notApplicable: number;
  byTier: Record<string, number>;
  bySource: Record<string, number>;
}

/** Count the items, the way the document's §8 block claims to. */
export function countItems(items: readonly AcceptanceItem[]): Counts {
  const byTier: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const tier of TIERS) byTier[tier] = 0;
  for (const source of Object.values(SOURCES)) bySource[source] = 0;

  let covered = 0;
  let uncovered = 0;
  let fail = 0;
  let notApplicable = 0;

  for (const item of items) {
    if (item.status === 'PASS') covered += 1;
    else if (item.status === 'NOT TESTED') uncovered += 1;
    else if (item.status === 'FAIL') fail += 1;
    else if (item.status === 'NOT APPLICABLE') notApplicable += 1;

    if (item.tier in byTier) byTier[item.tier] = (byTier[item.tier] ?? 0) + 1;
    const source = SOURCES[item.id[0] ?? ''];
    if (source !== undefined) bySource[source] = (bySource[source] ?? 0) + 1;
  }

  return { items: items.length, covered, uncovered, fail, notApplicable, byTier, bySource };
}

/**
 * Read the counts the document states, so they can be compared with the counts
 * its own rows produce.
 *
 * This is the check that makes the summary at the top of the suite load-bearing
 * instead of decorative. "54 of 62 covered" in prose, with 55 PASS rows
 * underneath, is precisely the kind of statement a reader believes and nobody
 * verifies.
 */
export function parseDeclaredCounts(markdown: string): { counts?: Counts; problems: SuiteProblem[] } {
  const problems: SuiteProblem[] = [];
  const lineOf = (needle: string): number => markdown.split('\n').findIndex((l) => l.includes(needle)) + 1;

  const num = (re: RegExp, what: string): number | undefined => {
    const m = re.exec(markdown);
    if (!m?.[1]) {
      problems.push(problem(lineOf('## 8. Counts'), '§8 counts', `does not state ${what}`));
      return undefined;
    }
    return Number(m[1]);
  };

  const items = num(/^items\s+(\d+)/m, 'a total item count');
  const covered = num(/^\s*covered \(PASS\)\s+(\d+)/m, 'a covered count');
  const uncovered = num(/^\s*uncovered\s+(\d+)/m, 'an uncovered count');
  const fail = num(/^\s*FAIL\s+(\d+)/m, 'a FAIL count');
  const notApplicable = num(/^\s*NOT APPLICABLE\s+(\d+)/m, 'a NOT APPLICABLE count');

  const byTier: Record<string, number> = {};
  const tierLine = /^by tier\s+(.+)$/m.exec(markdown);
  if (tierLine?.[1]) {
    for (const m of tierLine[1].matchAll(/T(\d)\s+(\d+)/g)) byTier[`T${m[1]}`] = Number(m[2]);
  } else {
    problems.push(problem(lineOf('## 8. Counts'), '§8 counts', 'does not state a per-tier breakdown'));
  }

  const bySource: Record<string, number> = {};
  const sourceLine = /^by source\s+(.+)$/m.exec(markdown);
  if (sourceLine?.[1]) {
    for (const m of sourceLine[1].matchAll(/(§[\d.]+|ADR-\d+)\s+(\d+)/g)) bySource[m[1]!] = Number(m[2]);
  } else {
    problems.push(problem(lineOf('## 8. Counts'), '§8 counts', 'does not state a per-source breakdown'));
  }

  if (
    items === undefined ||
    covered === undefined ||
    uncovered === undefined ||
    fail === undefined ||
    notApplicable === undefined
  ) {
    return { problems };
  }

  return { counts: { items, covered, uncovered, fail, notApplicable, byTier, bySource }, problems };
}

/** §12: the counts in the document match the counts the gate computes. */
export function checkCounts(actual: Counts, declared: Counts, line: number): SuiteProblem[] {
  const problems: SuiteProblem[] = [];
  const compare = (what: string, a: number, d: number): void => {
    if (a !== d) problems.push(problem(line, '§8 counts', `says ${what} is ${d}; the rows give ${a}`));
  };

  compare('the item count', actual.items, declared.items);
  compare('the covered count', actual.covered, declared.covered);
  compare('the uncovered count', actual.uncovered, declared.uncovered);
  compare('the FAIL count', actual.fail, declared.fail);
  compare('the NOT APPLICABLE count', actual.notApplicable, declared.notApplicable);

  for (const tier of TIERS) {
    compare(`tier ${tier}`, actual.byTier[tier] ?? 0, declared.byTier[tier] ?? 0);
  }
  for (const [source, count] of Object.entries(actual.bySource)) {
    compare(`source ${source}`, count, declared.bySource[source] ?? 0);
  }

  // The one arithmetic identity worth asserting separately: a status that is
  // none of the four would otherwise vanish from every subtotal while the total
  // still matched.
  const summed = actual.covered + actual.uncovered + actual.fail + actual.notApplicable;
  if (summed !== actual.items) {
    problems.push(
      problem(
        line,
        '§8 counts',
        `${actual.items - summed} row(s) carry a status outside ${STATUSES.join(' / ')}`,
      ),
    );
  }

  return problems;
}

/** The clause list the suite claims to have been derived from. */
export interface SpecClauses {
  /** Normalised clause text → the section it came from. */
  clauses: Map<string, string>;
  sha256: string;
}

/**
 * Extract §1.1, §1.2, §25 and §28 from the normative specification.
 *
 * Four different list shapes, because the document was written by a person: two
 * bullet lists, a numbered list, and a checkbox list. Each is read only inside
 * its own section, so a bullet elsewhere in a 2330-line document cannot become a
 * clause.
 */
export function extractSpecClauses(spec: string): SpecClauses {
  const clauses = new Map<string, string>();
  const lines = spec.split('\n');

  const collect = (start: RegExp, end: RegExp, item: RegExp, source: string): void => {
    let on = false;
    for (const raw of lines) {
      if (start.test(raw)) {
        on = true;
        continue;
      }
      if (on && end.test(raw)) break;
      if (!on) continue;
      const m = item.exec(raw);
      if (m?.[1]) clauses.set(normaliseClause(m[1]), source);
    }
  };

  collect(/^## 1\.1/, /^## 1\.2/, /^-\s+(?!\[)(.+)$/, '§1.1');
  collect(/^## 1\.2/, /^## 1\.3/, /^-\s+(?!\[)(.+)$/, '§1.2');
  collect(/^# 25\./, /^# 26\./, /^\d+\.\s+(.+)$/, '§25');
  collect(/^# 28\./, /^# 29\./, /^-\s+\[[ x]\]\s+(.+)$/, '§28');

  return { clauses, sha256: createHash('sha256').update(spec).digest('hex') };
}

export interface SpecCheck {
  problems: SuiteProblem[];
  /** False when the specification was not available, so nothing was re-derived. */
  checked: boolean;
}

/**
 * §12: every clause appears exactly once, and every clause-sourced item is a clause.
 *
 * Both directions, and they fail differently. A clause with no item is a
 * requirement the suite forgot — the whole point of deriving from the document
 * rather than from the tests. An item whose clause is in no specification
 * section is an invented requirement, which is how a suite starts describing
 * something other than what was promised.
 */
export function checkSpecCoverage(
  items: readonly AcceptanceItem[],
  spec: SpecClauses | undefined,
  declaredSha: string | undefined,
  shaLine: number,
): SpecCheck {
  if (!spec) return { problems: [], checked: false };

  const problems: SuiteProblem[] = [];

  if (declaredSha === undefined) {
    problems.push(
      problem(shaLine, '§1 derivation', 'states no spec sha256, so the derivation is pinned to nothing'),
    );
  } else if (declaredSha !== spec.sha256) {
    problems.push(
      problem(
        shaLine,
        '§1 derivation',
        `pins spec sha256 ${declaredSha.slice(0, 12)}…, and the specification on disk is ` +
          `${spec.sha256.slice(0, 12)}…. The clauses were derived from a document that has since changed: ` +
          're-derive rather than re-hash.',
      ),
    );
  }

  const byClause = new Map<string, AcceptanceItem[]>();
  for (const item of items) {
    if (SOURCES[item.id[0] ?? ''] === 'ADR-0027') continue;
    const key = normaliseClause(item.clause);
    byClause.set(key, [...(byClause.get(key) ?? []), item]);
  }

  for (const [clause, source] of spec.clauses) {
    const matched = byClause.get(clause);
    if (!matched) {
      problems.push(
        problem(
          shaLine,
          `${source} clause`,
          `is in the specification and in no item of the suite: "${clause.slice(0, 40)}…"`,
        ),
      );
      continue;
    }
    if (matched.length > 1) {
      problems.push(
        problem(
          matched[1]!.line,
          matched[1]!.id,
          `quotes a clause already claimed by ${matched[0]!.id}; every clause appears exactly once`,
        ),
      );
    }
  }

  for (const [clause, matched] of byClause) {
    if (spec.clauses.has(clause)) continue;
    for (const item of matched) {
      problems.push(
        problem(
          item.line,
          item.id,
          'quotes a clause that appears in no derived section of the specification. Either the quote drifted ' +
            'from the original, or the item is an invented requirement.',
        ),
      );
    }
  }

  return { problems, checked: true };
}

export interface SuiteReport {
  items: AcceptanceItem[];
  counts: Counts;
  problems: SuiteProblem[];
  /** Whether the clause coverage was re-derived against the specification. */
  specChecked: boolean;
}

/** Everything above, in the order a reader would apply it. */
export async function checkSuite(
  markdown: string,
  spec: SpecClauses | undefined,
  opts: CheckOptions,
): Promise<SuiteReport> {
  const { items, problems: parseProblems } = parseSuite(markdown);
  const counts = countItems(items);
  const problems: SuiteProblem[] = [
    ...parseProblems,
    ...checkTiers(items),
    ...(await checkItemEvidence(items, opts)),
  ];

  const declared = parseDeclaredCounts(markdown);
  problems.push(...declared.problems);
  const countsLine = markdown.split('\n').findIndex((l) => l.startsWith('items ')) + 1;
  if (declared.counts) problems.push(...checkCounts(counts, declared.counts, countsLine));

  const shaMatch = /^spec sha256\s+([0-9a-f]{64})$/m.exec(markdown);
  const shaLine = markdown.split('\n').findIndex((l) => l.startsWith('spec sha256')) + 1;
  const spec_ = checkSpecCoverage(items, spec, shaMatch?.[1], shaLine);
  problems.push(...spec_.problems);

  if (items.length === 0) {
    problems.push(problem(1, '(whole document)', 'parsed into no items at all; the suite looks unread'));
  }

  return { items, counts, problems, specChecked: spec_.checked };
}

export { SUITE };
