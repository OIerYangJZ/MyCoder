/**
 * Unified diff generation.
 *
 * Every persistent edit must be able to produce a diff tied to its tool call
 * (invariant 4), so this runs on the write path, not just for display.
 *
 * Strategy, in order of cost:
 *   1. trim the common prefix and suffix — for a normal edit this leaves a
 *      handful of lines and everything below is trivial;
 *   2. LCS over the remaining window, when it is small enough to be cheap;
 *   3. otherwise emit a single replace hunk.
 *
 * Step 3 is a deliberate ceiling. A minimal diff of two 50k-line files is not
 * worth several seconds of an agent's turn, and a correct-but-coarse diff is
 * still a correct diff.
 */

import { splitLines } from '../util/text.ts';

export interface DiffOptions {
  /** Lines of context around each hunk. */
  context?: number;
  oldLabel?: string;
  newLabel?: string;
  /** Above this window size, fall back to a single replace hunk. */
  maxLcsWindow?: number;
}

export interface DiffStats {
  linesAdded: number;
  linesRemoved: number;
  hunks: number;
}

export interface DiffResult {
  /** Unified diff text. Empty when the inputs are identical. */
  text: string;
  stats: DiffStats;
  /** True when the LCS ceiling was hit and the diff is coarse. */
  coarse: boolean;
}

type Op = { kind: 'equal' | 'insert' | 'delete'; line: string };

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LCS_WINDOW = 1200;

export function unifiedDiff(oldText: string, newText: string, opts: DiffOptions = {}): DiffResult {
  const context = opts.context ?? DEFAULT_CONTEXT;
  const oldLabel = opts.oldLabel ?? 'a';
  const newLabel = opts.newLabel ?? 'b';

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldText === newText) {
    return { text: '', stats: { linesAdded: 0, linesRemoved: 0, hunks: 0 }, coarse: false };
  }

  const { ops, coarse } = computeOps(oldLines, newLines, opts.maxLcsWindow ?? DEFAULT_MAX_LCS_WINDOW);
  const { text, stats } = renderUnified(ops, context, oldLabel, newLabel);
  return { text, stats, coarse };
}

function computeOps(
  oldLines: readonly string[],
  newLines: readonly string[],
  maxWindow: number,
): { ops: Op[]; coarse: boolean } {
  // (1) Common prefix / suffix.
  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(oldLines.length - prefix, newLines.length - prefix);
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  const ops: Op[] = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ kind: 'equal', line: oldLines[i]! });

  let coarse = false;
  if (oldMid.length === 0) {
    for (const line of newMid) ops.push({ kind: 'insert', line });
  } else if (newMid.length === 0) {
    for (const line of oldMid) ops.push({ kind: 'delete', line });
  } else if (oldMid.length > maxWindow || newMid.length > maxWindow) {
    // (3) Ceiling: one replace hunk.
    coarse = true;
    for (const line of oldMid) ops.push({ kind: 'delete', line });
    for (const line of newMid) ops.push({ kind: 'insert', line });
  } else {
    // (2) LCS.
    ops.push(...lcsOps(oldMid, newMid));
  }

  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) {
    ops.push({ kind: 'equal', line: oldLines[i]! });
  }

  return { ops, coarse };
}

/** Classic LCS dynamic program, backtracked into an edit script. */
function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', line: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      ops.push({ kind: 'delete', line: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: 'insert', line: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'delete', line: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'insert', line: b[j]! });
    j += 1;
  }
  return ops;
}

function renderUnified(
  ops: readonly Op[],
  context: number,
  oldLabel: string,
  newLabel: string,
): { text: string; stats: DiffStats } {
  interface Hunk {
    oldStart: number;
    newStart: number;
    lines: string[];
    oldCount: number;
    newCount: number;
  }

  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldLine = 1;
  let newLine = 1;
  let pendingContext: Array<{ text: string; oldLine: number; newLine: number }> = [];
  let trailing = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  const openHunk = (): void => {
    if (current) return;
    const lead = pendingContext.slice(-context);
    const first = lead[0];
    current = {
      oldStart: first?.oldLine ?? oldLine,
      newStart: first?.newLine ?? newLine,
      lines: lead.map((c) => ` ${c.text}`),
      oldCount: lead.length,
      newCount: lead.length,
    };
    pendingContext = [];
  };

  const closeHunk = (): void => {
    if (!current) return;
    hunks.push(current);
    current = undefined;
    trailing = 0;
  };

  for (const op of ops) {
    if (op.kind === 'equal') {
      if (current) {
        if (trailing < context) {
          current.lines.push(` ${op.line}`);
          current.oldCount += 1;
          current.newCount += 1;
          trailing += 1;
        } else {
          closeHunk();
          pendingContext = [{ text: op.line, oldLine, newLine }];
        }
      } else {
        pendingContext.push({ text: op.line, oldLine, newLine });
        if (pendingContext.length > context) pendingContext.shift();
      }
      oldLine += 1;
      newLine += 1;
      continue;
    }

    openHunk();
    trailing = 0;

    if (op.kind === 'delete') {
      current!.lines.push(`-${op.line}`);
      current!.oldCount += 1;
      linesRemoved += 1;
      oldLine += 1;
    } else {
      current!.lines.push(`+${op.line}`);
      current!.newCount += 1;
      linesAdded += 1;
      newLine += 1;
    }
  }
  closeHunk();

  if (hunks.length === 0) {
    return { text: '', stats: { linesAdded: 0, linesRemoved: 0, hunks: 0 } };
  }

  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const hunk of hunks) {
    out.push(
      `@@ -${hunk.oldCount === 0 ? hunk.oldStart - 1 : hunk.oldStart},${hunk.oldCount} ` +
        `+${hunk.newCount === 0 ? hunk.newStart - 1 : hunk.newStart},${hunk.newCount} @@`,
    );
    out.push(...hunk.lines);
  }

  return {
    text: out.join('\n') + '\n',
    stats: { linesAdded, linesRemoved, hunks: hunks.length },
  };
}

/** Compact one-line summary, for approval prompts and status output. */
export function summarizeDiff(stats: DiffStats): string {
  if (stats.hunks === 0) return 'no changes';
  return `+${stats.linesAdded} -${stats.linesRemoved} across ${stats.hunks} hunk(s)`;
}
