#!/usr/bin/env node
/**
 * Release evidence gate (alpha.3 §33–§35).
 *
 * One rule, mechanised:
 *
 *   > A checklist item without named evidence is not PASS.
 *
 * alpha.2 is why. Its release checklist said context-overflow retry was covered
 * and model requests had a timeout; both lines were prose, both were wrong, and
 * the bugs survived a release because "PASS — implemented" reads exactly like
 * "PASS — test:overflow-retry-bounded" to a human skimming a table.
 *
 * So this reads `docs/alpha3-evidence-matrix.md`, parses the table, and fails on
 * anything that cannot be checked mechanically:
 *
 *   - `PASS` with an empty evidence cell;
 *   - an evidence reference with no recognised `kind:` prefix;
 *   - `test:` / `suite:` naming something no test file mentions;
 *   - `artifact:` naming a file that does not exist;
 *   - a status outside PASS / FAIL / NOT TESTED / NOT APPLICABLE.
 *
 * Deliberately small (§35: "Do not build a large framework for this"). It does
 * not run the tests — CI does that — it checks that the claims point at
 * something real. The two together are what make the matrix evidence rather
 * than a second, prettier checklist.
 *
 * Usage:  node scripts/evidence.ts [--json]
 */

import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkSuite, extractSpecClauses, SUITE, type SpecClauses } from './acceptance.ts';
import {
  checkClosedAnnotations,
  checkIndexReconciliation,
  checkOneClaimOneStatus,
  parseOpenEvidence,
  type CorpusProblem,
  type CorpusRow,
} from './evidence-corpus.ts';

const ROOT = process.cwd();

/**
 * Every shipped matrix, checked on every run.
 *
 * A milestone's matrix is not superseded by the next one: alpha.3's rows are the
 * evidence for alpha.3's claims, and a rename or a deleted test that invalidates
 * one of them is a regression in the record even after alpha.4 ships. Checking
 * only the newest would let the older claims rot quietly, which is the failure the
 * gate exists to prevent — one milestone later than before.
 */
export const MATRICES = [
  { path: 'docs/alpha3-evidence-matrix.md', milestone: 'alpha.3' },
  { path: 'docs/alpha4-evidence-matrix.md', milestone: 'alpha.4' },
  { path: 'docs/alpha5-evidence-matrix.md', milestone: 'alpha.5' },
  // alpha.6 shipped two matrices and neither was registered here until alpha.11
  // found it: the egress matrix records its status in the *last* column, so the
  // parser — which read the second — could not see it and it was left out. 92
  // rows of claims, ungated for five milestones, while `docs/open-evidence.md`
  // cited them as the home of two open items. Exactly the drift §7 is about,
  // sitting inside the mechanism meant to catch it.
  { path: 'docs/alpha6-evidence-matrix.md', milestone: 'alpha.6' },
  { path: 'docs/tool-surface-evidence-matrix.md', milestone: 'alpha.6' },
  { path: 'docs/alpha7-evidence-matrix.md', milestone: 'alpha.7' },
  { path: 'docs/alpha8-evidence-matrix.md', milestone: 'alpha.8' },
  { path: 'docs/alpha9-evidence-matrix.md', milestone: 'alpha.9' },
  { path: 'docs/alpha10-evidence-matrix.md', milestone: 'alpha.10' },
  { path: 'docs/alpha11-evidence-matrix.md', milestone: 'alpha.11' },
  { path: 'docs/alpha12-evidence-matrix.md', milestone: 'alpha.12' },
];

/** The index every open claim has to appear in (alpha.11 §7.2). */
const OPEN_EVIDENCE = 'docs/open-evidence.md';

/**
 * The normative specification the acceptance suite is derived from (alpha.12 §7).
 *
 * A sibling of this repository, in no version control, and expected to be deleted
 * once development finishes (ADR-0019 §8, `docs/kernel-v0.1-spec.md`). Absent in
 * CI and absent for every consumer of the package, which is why the suite quotes
 * its clauses — and why a run that could not read it says so rather than passing
 * quietly.
 */
const SPEC = '../research/kernel_v0.1_technical_spec.md';

/**
 * The header alpha.8 §19 requires every matrix to carry.
 *
 * "12/12 solved" without a model name is the same category of unfalsifiable
 * statement as "zero tool defects" was before the friction metric existed. §19
 * asks that each behavioural claim gain the model it was measured on, and a rule
 * that lives only in a review checklist is a rule that holds until the first busy
 * week — so it is checked here instead.
 *
 * A matrix satisfies it by carrying a `Model provenance` section that names the
 * model, or by stating explicitly that it makes no behavioural claims. Both are
 * acceptable answers; "the reader can probably infer it" is not.
 */
const PROVENANCE_HEADING = /^#{1,4}\s*Model provenance/im;

export const STATUSES = ['PASS', 'FAIL', 'NOT TESTED', 'NOT APPLICABLE'] as const;
export type Status = (typeof STATUSES)[number];

/**
 * The evidence vocabulary from §33.
 *
 * `manual:` is included because some things genuinely cannot be automated — but
 * it is the weakest form, so the gate requires it to carry a description rather
 * than standing alone as a bare word.
 */
export const EVIDENCE_KINDS = ['test', 'suite', 'ci', 'eval', 'artifact', 'live', 'manual'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Row {
  requirement: string;
  status: string;
  evidence: string[];
  notes: string;
  line: number;
  /**
   * How the table records its evidence.
   *
   * `named` is the common shape: a column headed `Evidence`, holding `kind:`
   * references this gate can resolve. `inline` is alpha.6's: the evidence is
   * spread across `Primary evidence`, `Positive control`, `Contrast` and
   * `Mechanism`, which is *more* information rather than less, but not in a
   * vocabulary the gate can follow. An inline row is checked for having
   * support at all; its references are not resolved, and the alpha.11 matrix
   * says so rather than letting a green run imply otherwise.
   */
  evidenceStyle: 'named' | 'inline';
  /** Every cell that is neither the requirement nor the status. */
  supporting: string[];
}

/** Which column holds what, read from the table's own header row. */
interface Columns {
  status: number;
  evidence?: number;
  notes?: number;
}

const isSeparator = (line: string): boolean => /^\|(?:\s*:?-{2,}:?\s*\|)+$/.test(line.replace(/\s+/g, ' '));

const splitRow = (line: string): string[] =>
  line
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());

/**
 * Read the column layout out of a header row, or refuse the table.
 *
 * Keying on the header rather than on position is what lets the gate read
 * alpha.6, whose `Status` is the sixth column. It also means a table with no
 * `Status` column — a legend, a two-column list of things deliberately absent —
 * is skipped rather than parsed into rows of nonsense, which is what the old
 * `cells.length < 3` guard was approximating.
 */
function readColumns(header: readonly string[]): Columns | undefined {
  const find = (name: string): number =>
    header.findIndex((c) => c.replace(/[*`]/g, '').toLowerCase() === name);

  const status = find('status');
  if (status < 1) return undefined;

  const columns: Columns = { status };

  const named = find('evidence');
  // `| Defect | Status | Regression |` is the one table that names its evidence
  // column something else. The column after the status is the evidence column
  // in every table of that shape, so position carries it where the name does not.
  const evidence = named >= 0 ? named : status === 1 && header.length >= 3 ? 2 : -1;
  if (evidence >= 0) columns.evidence = evidence;

  const notes = find('notes');
  const notesIndex = notes >= 0 ? notes : evidence >= 0 && header.length > evidence + 1 ? evidence + 1 : -1;
  if (notesIndex >= 0) columns.notes = notesIndex;

  return columns;
}

export interface Problem {
  line: number;
  requirement: string;
  message: string;
}

/**
 * Split an evidence cell into references.
 *
 * Splitting on commas is wrong, and wrong in a way that produces false
 * failures rather than false passes: a good test name is a sentence, and
 * sentences contain commas — `test:0400 is accepted: the rule is "0600 or
 * stricter", not "exactly 0600"` is one reference, not two. The delimiter is
 * therefore the *start of the next reference*, recognised by its `kind:`
 * prefix, which is the one token a name cannot begin with by accident.
 */
export function splitEvidence(cell: string): string[] {
  // `(?<!:)` guards the one shape the lookahead otherwise mangles: a reference
  // whose *target* itself begins with a prefix word, as in the pnpm script name
  // `suite:test:live:model`. Without it that splits into `suite:` — naming
  // nothing — plus a stray `test:live:model`.
  const prefix = new RegExp(`(?<!:)(?=\\b(?:${EVIDENCE_KINDS.join('|')}):)`);
  return cell
    .split(prefix)
    .map((e) =>
      e
        .trim()
        .replace(/^`|`$/g, '')
        .replace(/[,;]\s*$/, ''),
    )
    .filter((e) => e !== '');
}

/** Parse the GitHub-flavoured tables out of a matrix document. */
export function parseMatrix(markdown: string): Row[] {
  const rows: Row[] = [];
  const lines = markdown.split('\n').map((l) => l.trim());
  let columns: Columns | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('|') || !line.endsWith('|')) {
      // Any non-table line ends the table, so one table's layout can never be
      // applied to the next one's rows.
      columns = undefined;
      continue;
    }
    if (isSeparator(line)) continue;

    const cells = splitRow(line);

    // A row followed by a separator is the header, and it decides how every
    // row beneath it is read.
    if (isSeparator(lines[i + 1] ?? '')) {
      columns = readColumns(cells);
      continue;
    }
    if (!columns) continue;

    const requirement = cells[0] ?? '';
    if (requirement === '') continue;

    const evidenceCell = columns.evidence === undefined ? undefined : cells[columns.evidence];
    rows.push({
      requirement,
      status: (cells[columns.status] ?? '').replace(/\*\*/g, '').trim(),
      evidence: splitEvidence(evidenceCell ?? ''),
      notes: (columns.notes === undefined ? '' : (cells[columns.notes] ?? '')).trim(),
      line: i + 1,
      evidenceStyle: columns.evidence === undefined ? 'inline' : 'named',
      supporting: cells.filter((_, index) => index !== 0 && index !== columns?.status),
    });
  }

  return rows;
}

export interface CheckOptions {
  /** Names mentioned anywhere in the test suite, for `test:` / `suite:` refs. */
  testCorpus: string;
  /** Resolves an `artifact:` path. Returns false when it does not exist. */
  artifactExists(relativePath: string): Promise<boolean>;
  /** Whether the path is committed. Omitted outside a git checkout. */
  isTracked?(relativePath: string): boolean;
}

export async function checkRows(rows: readonly Row[], opts: CheckOptions): Promise<Problem[]> {
  const problems: Problem[] = [];
  const add = (row: Row, message: string): void => {
    problems.push({ line: row.line, requirement: row.requirement, message });
  };

  for (const row of rows) {
    if (!STATUSES.includes(row.status as Status)) {
      add(row, `status "${row.status}" is not one of ${STATUSES.join(' / ')}`);
      continue;
    }

    // An inline-evidence table records its support in columns of its own, so
    // the `kind:` vocabulary cannot be applied to it. What still can be, and is
    // the rule that matters, is that a PASS is not bare: alpha.6's shape holds
    // more evidence per row than the named one, and a row with every support
    // column empty is a claim in a document that looks like evidence.
    if (row.evidenceStyle === 'inline') {
      if (row.status === 'PASS' && row.supporting.every((c) => c === '' || c === '—')) {
        add(row, 'marked PASS with every supporting column empty');
      }
      continue;
    }

    // The core rule. NOT TESTED and NOT APPLICABLE are *allowed* to be bare —
    // being explicit about an untested requirement is the honest outcome the
    // matrix exists to make visible, and demanding evidence for it would push
    // people to write PASS instead.
    if (row.status === 'PASS' && row.evidence.length === 0) {
      add(row, 'marked PASS with no named evidence');
      continue;
    }
    if (row.status === 'FAIL' && row.evidence.length === 0) {
      add(row, 'marked FAIL with nothing pointing at the failure');
      continue;
    }
    if (row.status === 'NOT TESTED' && row.notes.trim() === '') {
      add(row, 'marked NOT TESTED without saying why');
    }

    for (const ref of row.evidence) {
      const [kind, ...rest] = ref.split(':');
      const target = rest.join(':').trim();

      if (!EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
        add(row, `evidence "${ref}" has no recognised prefix (${EVIDENCE_KINDS.join('/')})`);
        continue;
      }
      if (target === '') {
        add(row, `evidence "${ref}" names nothing`);
        continue;
      }

      if (kind === 'test' || kind === 'suite') {
        // A substring match against the whole suite corpus. Loose on purpose:
        // the aim is to catch a reference to a test that was renamed or never
        // written, not to re-implement test discovery.
        if (!opts.testCorpus.includes(target)) {
          add(row, `evidence "${ref}" names a test/suite that appears nowhere under tests/`);
        }
      }

      if (kind === 'artifact') {
        if (!(await opts.artifactExists(target))) {
          add(row, `evidence "${ref}" points at a file that does not exist`);
        } else if (opts.isTracked && !opts.isTracked(target)) {
          // Present on this machine but not in the repository — which is not
          // evidence, it is a local file. `artifact:` exists so a reader can go
          // and look; a gitignored path defeats that, and the failure would
          // otherwise appear only in CI, where the file is genuinely absent.
          // That is how a broken reference gets committed: green locally, red
          // for everyone else.
          add(row, `evidence "${ref}" exists locally but is not tracked by git`);
        }
      }

      if (kind === 'manual' && target.split(/\s+/).length < 3) {
        // §33 rejects "PASS — tested before". A manual reference has to describe
        // a procedure and a captured result, not gesture at one.
        add(
          row,
          `evidence "${ref}" is too vague for a manual procedure; describe it and its captured result`,
        );
      }
    }
  }

  return problems;
}

/**
 * Every file git knows about, or undefined outside a checkout.
 *
 * Read once rather than shelling out per reference. Absent when this is not a
 * git working tree, in which case the tracked-ness check is simply skipped —
 * the gate should still be usable from a tarball.
 */
function trackedFiles(): Set<string> | undefined {
  const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
  return new Set(r.stdout.split('\n').filter((l) => l !== ''));
}

/** Every test name and file name under tests/, as one searchable string. */
async function buildTestCorpus(): Promise<string> {
  const parts: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.name.endsWith('.ts')) {
        parts.push(rel);
        parts.push(await readFile(path.join(ROOT, rel), 'utf8'));
      }
    }
  };

  await walk('tests');
  // Package scripts are what `suite:` names refer to (`suite:replay-gate` →
  // `pnpm test:replay`), so they belong in the corpus too.
  parts.push(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  return parts.join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const tracked = trackedFiles();
  const corpus = await buildTestCorpus();

  const options: CheckOptions = {
    testCorpus: corpus,
    ...(tracked ? { isTracked: (p: string) => tracked.has(p) } : {}),
    artifactExists: async (rel) => {
      try {
        await stat(path.join(ROOT, rel));
        return true;
      } catch {
        return false;
      }
    },
  };

  const reports: Array<{ matrix: string; rows: Row[]; problems: Problem[] }> = [];
  const corpusRows: CorpusRow[] = [];

  for (const [ordinal, matrix] of MATRICES.entries()) {
    let markdown: string;
    try {
      markdown = await readFile(path.join(ROOT, matrix.path), 'utf8');
    } catch {
      // A matrix that does not exist yet is not a failure; one that exists and is
      // unreadable is caught above. The "no matrix at all" case is checked below.
      continue;
    }

    const rows = parseMatrix(markdown);
    if (rows.length === 0) {
      process.stderr.write(`evidence gate: no table rows found in ${matrix.path}\n`);
      return 2;
    }

    const problems = await checkRows(rows, options);
    if (!PROVENANCE_HEADING.test(markdown)) {
      problems.push({
        line: 1,
        requirement: '(whole document)',
        message:
          'no "Model provenance" section (alpha.8 §19). Every behavioural number has to name the model ' +
          'it was measured on; a matrix that makes no behavioural claims should say so under that heading.',
      });
    }

    corpusRows.push(
      ...rows.map((row) => ({ ...row, matrix: matrix.path, milestone: matrix.milestone, ordinal })),
    );
    reports.push({ matrix: matrix.path, rows, problems });
  }

  if (reports.length === 0) {
    process.stderr.write(`evidence gate: none of ${MATRICES.map((m) => m.path).join(', ')} could be read\n`);
    return 2;
  }

  // The corpus checks (alpha.11 §7). These are about the relationship between
  // documents, so they run once, over everything, after the per-row pass.
  const index = parseOpenEvidence(await readFile(path.join(ROOT, OPEN_EVIDENCE), 'utf8'));
  const closed = checkClosedAnnotations(corpusRows, index.entries);
  const corpusProblems: CorpusProblem[] = [
    ...index.problems,
    ...checkOneClaimOneStatus(corpusRows),
    ...checkIndexReconciliation(corpusRows, index.entries),
    ...closed.problems,
  ];
  for (const problem of corpusProblems) {
    const report = reports.find((r) => r.matrix === problem.matrix);
    if (report) report.problems.push(problem);
  }
  const orphaned = corpusProblems.filter((p) => !reports.some((r) => r.matrix === p.matrix));

  // The acceptance suite (alpha.12 §7). Checked from inside this gate rather than
  // as a second one: it maps onto the same matrices, resolves evidence with the
  // same vocabulary, and a separate command would be a separate thing to forget.
  const suiteMarkdown = await readFile(path.join(ROOT, SUITE), 'utf8');
  let spec: SpecClauses | undefined;
  try {
    spec = extractSpecClauses(await readFile(path.join(ROOT, SPEC), 'utf8'));
  } catch {
    spec = undefined;
  }
  const suite = await checkSuite(
    suiteMarkdown,
    spec,
    options,
    await readFile(path.join(ROOT, OPEN_EVIDENCE), 'utf8'),
  );

  const allProblems = [...reports.flatMap((r) => r.problems), ...orphaned, ...suite.problems];
  const allRows = reports.flatMap((r) => r.rows);
  const counts = STATUSES.map((s) => [s, allRows.filter((r) => r.status === s).length] as const);
  const openIndexed = index.entries.filter((e) => e.section !== 'C').length;

  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          matrices: reports.map((r) => ({
            matrix: r.matrix,
            rows: r.rows.length,
            counts: Object.fromEntries(STATUSES.map((s) => [s, r.rows.filter((x) => x.status === s).length])),
            problems: r.problems,
          })),
          rows: allRows.length,
          counts: Object.fromEntries(counts),
          openEvidence: {
            indexed: openIndexed,
            closedEntries: index.entries.length - openIndexed,
            rowsOpen: closed.open,
            rowsClosed: closed.closed,
            rowsOutOfScope: closed.scope,
          },
          acceptanceSuite: {
            items: suite.counts.items,
            covered: suite.counts.covered,
            uncovered: suite.counts.uncovered,
            byTier: suite.counts.byTier,
            bySource: suite.counts.bySource,
            specChecked: suite.specChecked,
          },
          problems: allProblems,
        },
        null,
        2,
      )}\n`,
    );
    return allProblems.length === 0 ? 0 : 1;
  }

  for (const report of reports) {
    const perFile = STATUSES.map(
      (status) => [status, report.rows.filter((r) => r.status === status).length] as const,
    );
    process.stdout.write(
      `${report.matrix}: ${report.rows.length} requirement(s) — ` +
        perFile.map(([s, n]) => `${n} ${s}`).join(', ') +
        '\n',
    );
  }

  // The count a reader of `docs/open-evidence.md` gets, and the count the gate
  // gets, printed side by side. §7.3 asks for exactly this: the two numbers
  // came apart once and nothing said so.
  process.stdout.write(
    `${OPEN_EVIDENCE}: ${openIndexed} open item(s) indexed — ` +
      `${closed.open} row(s) point at them, ${closed.closed} closed elsewhere, ` +
      `${closed.scope} out of scope by decision\n`,
  );

  // The suite's own numbers, and — the part that matters — whether the clause
  // coverage was re-derived or merely assumed. "62 items, 54 covered" reads the
  // same either way, so the line says which.
  const tiers = Object.entries(suite.counts.byTier)
    .map(([tier, n]) => `${tier} ${n}`)
    .join(' · ');
  process.stdout.write(
    `${SUITE}: ${suite.counts.items} item(s) — ${suite.counts.covered} covered, ` +
      `${suite.counts.uncovered} not; ${tiers}\n` +
      `  clause coverage ${
        suite.specChecked
          ? 're-derived against the specification'
          : `NOT re-derived: ${SPEC} is absent, so only the suite's internal consistency was checked`
      }\n`,
  );

  if (allProblems.length === 0) {
    process.stdout.write('every claim points at something that exists, and the corpus agrees with itself\n');
    return 0;
  }

  process.stdout.write(`\n${allProblems.length} problem(s):\n\n`);
  for (const report of reports) {
    for (const p of report.problems) {
      process.stdout.write(`  ${report.matrix}:${p.line}  ${p.requirement}\n      ${p.message}\n`);
    }
  }
  for (const p of [...orphaned, ...suite.problems]) {
    process.stdout.write(`  ${p.matrix}:${p.line}  ${p.requirement}\n      ${p.message}\n`);
  }
  return 1;
}

/** True when this module is the process entry point, on every platform. */
function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(
        `evidence gate failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
      );
      process.exitCode = 2;
    });
}

export { main };
