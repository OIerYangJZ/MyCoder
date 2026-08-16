/**
 * Corpus-level evidence checks (alpha.11 §7).
 *
 * `evidence.ts` asks of one row: does this claim point at something that exists?
 * That question was green through four defects, because none of the four was
 * about a row. They were about the corpus:
 *
 *   - three rows were closed by a later milestone and left saying `NOT TESTED`;
 *   - one claim carried `NOT APPLICABLE` in three matrices and `NOT TESTED` in
 *     two, one hour after being downgraded.
 *
 * Both are legal states of a legal document, and both were found by a human
 * reading. So this module asks the three questions a reader was asking:
 *
 *   1. does one claim carry one status?
 *   2. is every open claim in the one index that lists them, and vice versa?
 *   3. does a closed claim still say it is open?
 *
 * What these deliberately do **not** do is decide whether a claim is *true*.
 * That is not checkable, and a gate that pretended otherwise would be the same
 * overclaim the milestone exists to prevent. They check that the corpus is
 * internally consistent, which is exactly the property that failed four times.
 *
 * ## The marker vocabulary
 *
 * Every non-PASS row declares which kind of non-claim it is, in its notes:
 *
 * ```text
 * [open:A3]        an open claim, indexed in docs/open-evidence.md §A or §B
 * [closed:C1]      closed by a later milestone, indexed in §C, and the notes
 *                  must also carry the prose form **Closed by alpha.N**
 * [scope]          not a claim about the world at all — deliberately out of
 *                  scope for this milestone, so it is not indexed
 * ```
 *
 * The marker is required rather than inferred. Inferring it from prose is the
 * habit that let the drift happen; and an unmarked row has to be a failure
 * rather than a default, because the row someone forgot to mark is precisely
 * the row that goes stale.
 */

import type { Problem, Row } from './evidence.ts';

/** A row, plus which document it came from and where that document sits in time. */
export interface CorpusRow extends Row {
  /** Repo-relative path of the matrix. */
  matrix: string;
  /** The milestone label the matrix speaks for, e.g. `alpha.5`. */
  milestone: string;
  /** Position in the corpus ordering; larger is later. */
  ordinal: number;
}

/** A problem that knows which document it is in. */
export interface CorpusProblem extends Problem {
  matrix: string;
}

/** One entry in `docs/open-evidence.md`. */
export interface IndexEntry {
  id: string;
  section: 'A' | 'B' | 'C';
  claim: string;
  /** For §C only: the milestone that closed it, e.g. `alpha.6`. */
  closedBy?: string;
  line: number;
}

export const OPEN_MARKER = /\[open:([AB]\d+)\]/;
export const CLOSED_MARKER = /\[closed:(C\d+)\]/;
export const SCOPE_MARKER = /\[scope\]/;

/**
 * The prose form §7.3 requires, so that a reader counting closed claims and the
 * gate counting them get the same number. The trailing `[^*]*` allows the
 * section reference the existing rows carry (`**Closed by alpha.7 §B**`).
 */
export const CLOSED_PROSE = /\*\*Closed by (alpha\.\d+(?:\.\d+)?)[^*]*\*\*/i;

/**
 * Reduce a requirement to the claim it makes.
 *
 * Two matrices phrase the same claim differently in ways that carry no meaning:
 * bold for emphasis, backticks around an identifier, a trailing section
 * reference naming where the requirement was written down. Those are the
 * differences this strips. Anything else is left alone — over-normalising would
 * merge two genuinely different claims and then complain that they disagree,
 * which is a false failure, and false failures are how a gate gets switched off.
 */
export function normaliseClaim(text: string): string {
  return text
    .replace(/\[(?:open:[AB]\d+|closed:C\d+|scope)\]/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s*\((?:§|see )[^)]*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .toLowerCase();
}

/** Every non-PASS row: the ones the three checks are about. */
export function isOpenStatus(status: string): boolean {
  return status === 'NOT TESTED' || status === 'NOT APPLICABLE';
}

/**
 * §7.1 — one claim, one status.
 *
 * Rows whose requirement text says the same thing must carry the same status,
 * unless the later one names the earlier milestone in its notes. That exception
 * is not a loophole: "alpha.5 said NOT TESTED, alpha.6 built the proxy" is a
 * true and useful statement about a corpus that spans time. What it forbids is
 * the same statement being made silently.
 */
export function checkOneClaimOneStatus(rows: readonly CorpusRow[]): CorpusProblem[] {
  const problems: CorpusProblem[] = [];
  const groups = new Map<string, CorpusRow[]>();
  const seen = new Set<string>();

  for (const row of rows) {
    // Two keys, because matching on text alone would not have caught the defect
    // this check exists for. The claim that carried two statuses was written
    // five different ways — "real-internet path under the strict address
    // policy", "strict public-address egress on a clean resolver", "strict
    // egress on a genuinely global resolved address" — and only two of the five
    // are the same string. What makes them one claim is that they point at one
    // index entry, so that is the second key, and it is the stronger one.
    const keys = [`text:${normaliseClaim(row.requirement)}`];
    const indexed = OPEN_MARKER.exec(row.notes) ?? CLOSED_MARKER.exec(row.notes);
    if (indexed?.[1]) keys.push(`index:${indexed[1]}`);

    for (const key of keys) {
      if (key === 'text:') continue;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
  }

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    if (new Set(group.map((r) => r.status)).size === 1) continue;

    const ordered = [...group].sort((a, b) => a.ordinal - b.ordinal);
    for (let i = 1; i < ordered.length; i += 1) {
      const later = ordered[i];
      if (!later) continue;
      for (let j = 0; j < i; j += 1) {
        const earlier = ordered[j];
        if (!earlier || earlier.status === later.status) continue;
        if (later.notes.includes(earlier.milestone)) continue;

        // A pair can be grouped by both keys; it is one disagreement either way.
        const pair = `${later.matrix}:${later.line}->${earlier.matrix}:${earlier.line}`;
        if (seen.has(pair)) continue;
        seen.add(pair);

        problems.push({
          matrix: later.matrix,
          line: later.line,
          requirement: later.requirement,
          message:
            `carries "${later.status}" while ${earlier.matrix}:${earlier.line} carries ` +
            `"${earlier.status}" for the same claim, and these notes do not name ` +
            `${earlier.milestone}. One claim, one status — or say which earlier row this supersedes.`,
        });
      }
    }
  }

  return problems;
}

/**
 * §7.2 — every open claim is in the index, and every index entry has a row.
 *
 * "Neither list may grow a member the other does not have." Both directions
 * matter and they fail differently: a row missing from the index is a claim
 * nobody is tracking, and an index entry with no row is a claim that was
 * quietly deleted from the corpus while the index kept advertising it.
 */
export function checkIndexReconciliation(
  rows: readonly CorpusRow[],
  entries: readonly IndexEntry[],
): CorpusProblem[] {
  const problems: CorpusProblem[] = [];
  const known = new Set(entries.map((e) => e.id));
  const referenced = new Set<string>();

  for (const row of rows) {
    if (!isOpenStatus(row.status)) continue;

    const open = OPEN_MARKER.exec(row.notes);
    const closed = CLOSED_MARKER.exec(row.notes);
    const scope = SCOPE_MARKER.test(row.notes);
    const markers = [open, closed, scope ? 'scope' : undefined].filter((m) => m !== null && m !== undefined);

    if (markers.length === 0) {
      problems.push({
        matrix: row.matrix,
        line: row.line,
        requirement: row.requirement,
        message:
          `is "${row.status}" with no index marker. Every non-PASS row declares which it is: ` +
          '`[open:A3]` (tracked in docs/open-evidence.md), `[closed:C1]` (closed by a later ' +
          'milestone), or `[scope]` (not a claim about the world — out of scope by decision).',
      });
      continue;
    }
    if (markers.length > 1) {
      problems.push({
        matrix: row.matrix,
        line: row.line,
        requirement: row.requirement,
        message: 'carries more than one index marker; a row is open, closed or out of scope, not two of them',
      });
      continue;
    }

    const id = open?.[1] ?? closed?.[1];
    if (id === undefined) continue;
    referenced.add(id);
    if (!known.has(id)) {
      problems.push({
        matrix: row.matrix,
        line: row.line,
        requirement: row.requirement,
        message: `names index entry ${id}, which docs/open-evidence.md does not define`,
      });
    }
  }

  for (const entry of entries) {
    if (referenced.has(entry.id)) continue;
    problems.push({
      matrix: 'docs/open-evidence.md',
      line: entry.line,
      requirement: `${entry.id} — ${entry.claim}`,
      message:
        'is listed in the index but no matrix row names it. Either the row that carried it was ' +
        'removed, or the claim was closed and this entry outlived it.',
    });
  }

  return problems;
}

/** What §7.3 counts, so that the gate's number and a reader's number are the same. */
export interface ClosedReport {
  problems: CorpusProblem[];
  /** Non-PASS rows marked `[closed:...]`. */
  closed: number;
  /** Non-PASS rows marked `[open:...]`. */
  open: number;
  /** Non-PASS rows marked `[scope]`. */
  scope: number;
}

/**
 * §7.3 — a closed claim cannot keep saying it is open.
 *
 * A row that a later milestone closed stays at its own milestone's status,
 * deliberately: alpha.4 did not establish OS-level isolation and rewriting its
 * row to PASS would be a lie about alpha.4. What it must not do is stay silent.
 * So the closure is required in a parseable form, checked against the index's
 * own account of which milestone closed it — the two can disagree, and when
 * they do, one of them is stale.
 */
export function checkClosedAnnotations(
  rows: readonly CorpusRow[],
  entries: readonly IndexEntry[],
): ClosedReport {
  const problems: CorpusProblem[] = [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  let closed = 0;
  let open = 0;
  let scope = 0;

  for (const row of rows) {
    if (!isOpenStatus(row.status)) continue;

    const marker = CLOSED_MARKER.exec(row.notes);
    if (!marker) {
      if (OPEN_MARKER.test(row.notes)) {
        open += 1;
        // The other direction of the same rule: prose that announces a closure
        // on a row still indexed as open is the exact drift §7.3 names.
        if (CLOSED_PROSE.test(row.notes)) {
          problems.push({
            matrix: row.matrix,
            line: row.line,
            requirement: row.requirement,
            message: 'says it was closed by a later milestone but is still indexed as open',
          });
        }
      } else if (SCOPE_MARKER.test(row.notes)) {
        scope += 1;
      }
      continue;
    }
    closed += 1;

    const prose = CLOSED_PROSE.exec(row.notes);
    if (!prose) {
      problems.push({
        matrix: row.matrix,
        line: row.line,
        requirement: row.requirement,
        message:
          'is marked closed but does not say so in a readable form. A reader of this row needs ' +
          '`**Closed by alpha.N**` in the notes; the marker alone is for the gate.',
      });
      continue;
    }

    const entry = byId.get(marker[1] ?? '');
    if (entry && entry.closedBy !== undefined && entry.closedBy !== prose[1]) {
      problems.push({
        matrix: row.matrix,
        line: row.line,
        requirement: row.requirement,
        message: `says "${prose[1]}" closed it; docs/open-evidence.md ${entry.id} says "${entry.closedBy}"`,
      });
    }
  }

  return { problems, closed, open, scope };
}

/**
 * Parse `docs/open-evidence.md` into entries.
 *
 * The index stops being a document that is maintained and becomes one that is
 * read: §A and §B are keyed by the id column they already had, and §C gains one
 * so that a closed row can name the entry that records its closure rather than
 * matching on prose.
 */
export function parseOpenEvidence(markdown: string): { entries: IndexEntry[]; problems: CorpusProblem[] } {
  const entries: IndexEntry[] = [];
  const problems: CorpusProblem[] = [];
  let section: 'A' | 'B' | 'C' | undefined;

  markdown.split('\n').forEach((raw, index) => {
    const line = raw.trim();

    const heading = /^##\s+([ABC])\./.exec(line);
    if (heading) {
      section = heading[1] as 'A' | 'B' | 'C';
      return;
    }
    if (/^##\s/.test(line)) {
      section = undefined;
      return;
    }
    if (section === undefined) return;
    if (!line.startsWith('|') || !line.endsWith('|')) return;

    const cells = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    const id = cells[0] ?? '';
    if (id === '#' || /^:?-+:?$/.test(id)) return;

    if (!new RegExp(`^${section}\\d+$`).test(id)) {
      problems.push({
        matrix: 'docs/open-evidence.md',
        line: index + 1,
        requirement: cells[1] ?? id,
        message: `row in section ${section} has id "${id}"; every entry needs an id of the form ${section}1`,
      });
      return;
    }

    const entry: IndexEntry = {
      id,
      section,
      claim: normaliseClaim(cells[1] ?? ''),
      line: index + 1,
    };

    if (section === 'C') {
      const closedBy = /alpha\.\d+(?:\.\d+)?/.exec(cells[2] ?? '');
      if (!closedBy) {
        problems.push({
          matrix: 'docs/open-evidence.md',
          line: index + 1,
          requirement: cells[1] ?? id,
          message: 'section C entry does not name the milestone that closed it',
        });
      } else entry.closedBy = closedBy[0];
    }

    entries.push(entry);
  });

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      problems.push({
        matrix: 'docs/open-evidence.md',
        line: entry.line,
        requirement: entry.claim,
        message: `duplicate index id ${entry.id}`,
      });
    }
    seen.add(entry.id);
  }

  return { entries, problems };
}
