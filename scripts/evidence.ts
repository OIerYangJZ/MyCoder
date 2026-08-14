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
const MATRICES = [
  'docs/alpha3-evidence-matrix.md',
  'docs/alpha4-evidence-matrix.md',
  'docs/alpha5-evidence-matrix.md',
];

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

/** Parse the GitHub-flavoured table out of the matrix document. */
export function parseMatrix(markdown: string): Row[] {
  const rows: Row[] = [];

  markdown.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) return;

    const cells = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 3) return;

    const [requirement, status, evidence, notes] = cells;
    // Header and separator rows.
    if (requirement === undefined || requirement === '' || /^-+$/.test(requirement)) return;
    if (status === 'Status' || /^:?-+:?$/.test(status ?? '')) return;

    rows.push({
      requirement,
      status: status ?? '',
      evidence: splitEvidence(evidence ?? ''),
      notes: notes ?? '',
      line: index + 1,
    });
  });

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

  for (const matrix of MATRICES) {
    let markdown: string;
    try {
      markdown = await readFile(path.join(ROOT, matrix), 'utf8');
    } catch {
      // A matrix that does not exist yet is not a failure; one that exists and is
      // unreadable is caught above. The "no matrix at all" case is checked below.
      continue;
    }

    const rows = parseMatrix(markdown);
    if (rows.length === 0) {
      process.stderr.write(`evidence gate: no table rows found in ${matrix}\n`);
      return 2;
    }
    reports.push({ matrix, rows, problems: await checkRows(rows, options) });
  }

  if (reports.length === 0) {
    process.stderr.write(`evidence gate: none of ${MATRICES.join(', ')} could be read\n`);
    return 2;
  }

  const allProblems = reports.flatMap((r) => r.problems);
  const allRows = reports.flatMap((r) => r.rows);
  const counts = STATUSES.map((s) => [s, allRows.filter((r) => r.status === s).length] as const);

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

  if (allProblems.length === 0) {
    process.stdout.write('every claim points at something that exists\n');
    return 0;
  }

  process.stdout.write(`\n${allProblems.length} problem(s):\n\n`);
  for (const report of reports) {
    for (const p of report.problems) {
      process.stdout.write(`  ${report.matrix}:${p.line}  ${p.requirement}\n      ${p.message}\n`);
    }
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
