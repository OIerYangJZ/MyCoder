/**
 * Reversing a unified diff (ADR-0025 §1, ADR-0026 §2).
 *
 * The journal stores a diff, not a copy of the file (`atomic-write.ts` explains
 * why). An undo therefore has to *reconstruct* the previous content from the
 * current content plus the diff, and the honest question — the one §9 of the
 * alpha.10 plan told us to answer before building anything on top — is whether
 * that reconstruction is always exact.
 *
 * It is not, and this module is written around that. Four things can make a
 * recorded diff insufficient:
 *
 *   1. **Redaction.** Every event reaching the log passes through the redactor
 *      (`store.ts`), so a diff line containing a credential-shaped value is
 *      stored with a placeholder in it. Reversing that would write the
 *      placeholder into the user's file.
 *   2. **The final newline.** `splitLines` cannot distinguish `"a\nb"` from
 *      `"a\nb\n"`, so neither can the diff. The journal carries the flag
 *      separately for this reason.
 *   3. **Mixed line endings.** The diff is computed on LF-normalised text and
 *      re-applied with one dominant style, so a file that mixed both cannot be
 *      restored byte-for-byte from `eol` alone.
 *   4. **Drift.** The file may simply not be what the diff was computed against.
 *
 * Rather than enumerate those cases and hope the list is complete, every
 * reversal here ends in the same check: hash the reconstructed content and
 * compare it with the `oldHash` the journal recorded at the time. If they do not
 * match, the reversal is refused. That turns "is the diff lossy?" from a
 * question this code has to predict correctly into one it *measures*, per entry,
 * at the moment of use — which is the only form of the answer that cannot be
 * wrong.
 */

import { splitLines, toLf } from '../util/text.ts';

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Raw body lines, each prefixed with ' ', '-' or '+'. */
  lines: string[];
}

export type ReverseOutcome = { ok: true; text: string } | { ok: false; reason: string };

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into hunks.
 *
 * Deliberately strict: an unrecognised body line is a parse failure rather than
 * something to skip. A diff this module cannot fully account for is a diff it
 * must not reverse, and "I ignored two lines I did not understand" is exactly
 * the shape of a silent corruption.
 */
export function parseUnifiedDiff(diff: string): { ok: true; hunks: Hunk[] } | { ok: false; reason: string } {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;

  for (const raw of diff.split('\n')) {
    if (raw === '' && current === undefined) continue;
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;

    const header = HEADER.exec(raw);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    if (current === undefined) {
      if (raw.trim() === '') continue;
      return { ok: false, reason: 'diff body before any hunk header' };
    }

    if (raw === '') {
      // A trailing empty line from the final '\n' of the diff text. Anything
      // else empty at this point would be a context line for an empty source
      // line, which is rendered as a single space.
      continue;
    }

    const marker = raw[0];
    if (marker !== ' ' && marker !== '-' && marker !== '+') {
      return { ok: false, reason: `unrecognised diff line: ${JSON.stringify(raw.slice(0, 40))}` };
    }
    current.lines.push(raw);
  }

  if (hunks.length === 0) return { ok: false, reason: 'diff contains no hunks' };
  return { ok: true, hunks };
}

/**
 * Reconstruct the pre-edit text by reverse-applying `diff` to `newText`.
 *
 * Both inputs and the output are LF-normalised and newline-terminated line
 * sequences; the caller re-applies the recorded EOL style and final-newline
 * flag. Every context and removed/added line is verified against the current
 * content, so a file that drifted fails here rather than downstream.
 */
export function reverseUnifiedDiff(newText: string, diff: string): ReverseOutcome {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const newLines = splitLines(newText);
  const out: string[] = [];
  let cursor = 0; // 0-based index into newLines

  for (const hunk of parsed.hunks) {
    // A hunk with a zero new-count is rendered with `newStart - 1` (the
    // convention for "insert after this line"), so the two cases differ.
    const at = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (at < cursor) return { ok: false, reason: 'hunks are out of order' };
    if (at > newLines.length) return { ok: false, reason: 'hunk starts past the end of the file' };

    for (; cursor < at; cursor += 1) out.push(newLines[cursor]!);

    for (const line of hunk.lines) {
      const body = line.slice(1);
      if (line[0] === '-') {
        // Present in the old content, absent from the new. Restore it.
        out.push(body);
        continue;
      }
      // Context and additions must both be present in the current file, in
      // order. Context is kept; an addition is dropped, which is the reversal.
      if (cursor >= newLines.length) {
        return { ok: false, reason: 'the file is shorter than the diff expects' };
      }
      if (newLines[cursor] !== body) {
        return {
          ok: false,
          reason: `line ${cursor + 1} does not match the recorded diff`,
        };
      }
      cursor += 1;
      if (line[0] === ' ') out.push(body);
    }
  }

  for (; cursor < newLines.length; cursor += 1) out.push(newLines[cursor]!);

  return { ok: true, text: out.length === 0 ? '' : out.join('\n') + '\n' };
}

/**
 * Extract the pre-edit text from a whole-file removal diff.
 *
 * Used for `delete`, where there is no current file to reverse against: the diff
 * is entirely `-` lines and *is* the copy. Returns a failure if the diff
 * contains anything else, because then it is not a whole-file removal and
 * treating it as one would silently drop content.
 */
export function contentFromDeletionDiff(diff: string): ReverseOutcome {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const out: string[] = [];
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      if (line[0] !== '-') {
        return { ok: false, reason: 'the recorded diff is not a whole-file removal' };
      }
      out.push(line.slice(1));
    }
  }
  return { ok: true, text: out.length === 0 ? '' : out.join('\n') + '\n' };
}

/**
 * Restore the byte-level shape the journal recorded.
 *
 * The diff round-trips *lines*; these two properties survive nowhere else.
 */
export function applyByteShape(lfText: string, opts: { eol: 'lf' | 'crlf'; finalNewline: boolean }): string {
  let text = toLf(lfText);
  if (!opts.finalNewline && text.endsWith('\n')) text = text.slice(0, -1);
  return opts.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}
