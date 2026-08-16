/**
 * Freshness Ledger (spec §8.4, invariant 3).
 *
 * When the model is shown file content, the kernel records a `SourceReceipt`.
 * An `Edit` must cite a receipt, and the ledger checks four things before the
 * edit is allowed to plan:
 *
 *   1. the file's current hash matches the receipt's;
 *   2. `oldString` lies inside the byte range the model actually saw;
 *   3. `oldString` matches exactly once (unless `replaceAll`);
 *   4. no other tool call modified the file in between.
 *
 * Point 2 is the one that is easy to skip and expensive to omit. A model that
 * read lines 1–50 and then "remembers" a function at line 300 is hallucinating,
 * and without coverage checking that hallucination becomes a silent, confident
 * corruption of code nobody looked at.
 *
 * The ledger hashes the *whole* file even when the model saw only a slice, so
 * external edits are always detected — but it never sends the unseen part
 * anywhere.
 */

import { newReceiptId, sha256Hex, type ReceiptId, type StepId } from '../util/ids.ts';
import { kernelError, type KernelError } from '../util/errors.ts';
import type { CanonicalPath } from '../util/paths.ts';
import { splitLines, toLf } from '../util/text.ts';

export type Coverage = { kind: 'full' } | { kind: 'lines'; start: number; end: number };

export interface SourceReceipt {
  receiptId: ReceiptId;
  path: CanonicalPath;
  /** Hash of the entire file, regardless of how much the model saw. */
  contentHash: string;
  mtimeMs: number;
  size: number;
  coverage: Coverage;
  producedAtStep: StepId;
  /** Wall clock, for `/status` and stale-receipt diagnostics. */
  producedAt: number;
}

export interface RecordReadInput {
  path: CanonicalPath;
  /** Full file content as read from disk, pre-redaction. */
  content: string;
  mtimeMs: number;
  size: number;
  coverage: Coverage;
  stepId: StepId;
  now: number;
}

export type FreshnessFailure =
  | { code: 'STALE_FILE'; message: string; currentHash: string; receiptHash: string }
  | { code: 'INSUFFICIENT_READ_COVERAGE'; message: string; sawLines: string; neededLines: string }
  | { code: 'NON_UNIQUE_MATCH'; message: string; matches: number }
  | { code: 'CONCURRENT_MODIFICATION'; message: string }
  | { code: 'TOOL_INVALID_ARGS'; message: string };

export interface FreshnessCheckInput {
  receiptId: string;
  path: CanonicalPath;
  /** Current on-disk content. */
  currentContent: string;
  currentMtimeMs: number;
  oldString: string;
  replaceAll: boolean;
}

export interface FreshnessCheckOk {
  ok: true;
  receipt: SourceReceipt;
  matchCount: number;
  /** Byte offsets of every match in the LF-normalised content. */
  matchOffsets: number[];
}

export type FreshnessCheckResult = FreshnessCheckOk | { ok: false; failure: FreshnessFailure };

export class FreshnessLedger {
  private readonly byId = new Map<string, SourceReceipt>();
  /** Most recent receipt per path, so Edit can suggest which read to redo. */
  private readonly latestByPath = new Map<string, ReceiptId>();
  /**
   * Paths written during the current step, keyed by the tool call that wrote
   * them. Two edits to one file inside a single batch is a concurrent
   * modification, and this is how we see it.
   */
  private readonly writesInFlight = new Map<string, string>();

  recordRead(input: RecordReadInput): SourceReceipt {
    const receipt: SourceReceipt = {
      receiptId: newReceiptId(input.now),
      path: input.path,
      contentHash: sha256Hex(input.content),
      mtimeMs: input.mtimeMs,
      size: input.size,
      coverage: input.coverage,
      producedAtStep: input.stepId,
      producedAt: input.now,
    };
    this.byId.set(receipt.receiptId, receipt);
    this.latestByPath.set(input.path, receipt.receiptId);
    return receipt;
  }

  get(receiptId: string): SourceReceipt | undefined {
    return this.byId.get(receiptId);
  }

  latestFor(path: CanonicalPath): SourceReceipt | undefined {
    const id = this.latestByPath.get(path);
    return id ? this.byId.get(id) : undefined;
  }

  /** Refresh the ledger after a successful write, so a follow-up edit works. */
  recordWrite(
    path: CanonicalPath,
    newContent: string,
    mtimeMs: number,
    stepId: StepId,
    now: number,
  ): SourceReceipt {
    return this.recordRead({
      path,
      content: newContent,
      mtimeMs,
      size: Buffer.byteLength(newContent, 'utf8'),
      coverage: { kind: 'full' },
      stepId,
      now,
    });
  }

  /** Mark a file as being written by a tool call, for concurrency detection. */
  beginWrite(path: CanonicalPath, toolCallId: string): boolean {
    const holder = this.writesInFlight.get(path);
    if (holder !== undefined && holder !== toolCallId) return false;
    this.writesInFlight.set(path, toolCallId);
    return true;
  }

  endWrite(path: CanonicalPath, toolCallId: string): void {
    if (this.writesInFlight.get(path) === toolCallId) this.writesInFlight.delete(path);
  }

  isBeingWritten(path: CanonicalPath, byOther: string): boolean {
    const holder = this.writesInFlight.get(path);
    return holder !== undefined && holder !== byOther;
  }

  /** Invalidate every receipt for a path — used after an external change. */
  invalidatePath(path: CanonicalPath): void {
    for (const [id, receipt] of this.byId) {
      if (receipt.path === path) this.byId.delete(id);
    }
    this.latestByPath.delete(path);
  }

  get size(): number {
    return this.byId.size;
  }

  /** All receipts, newest first. Used by `/status` and by compaction. */
  list(): SourceReceipt[] {
    return [...this.byId.values()].sort((a, b) => b.producedAt - a.producedAt);
  }

  /**
   * The whole-file variant of `check`, for operations with no `oldString`.
   *
   * `Write` (overwrite) and `Delete` destroy content rather than transform it,
   * so uniqueness and match offsets are meaningless — but the other three
   * questions are sharper, not softer. In particular **coverage must be `full`**:
   * an exact replace against a partially-read file can only damage the region the
   * model actually saw, whereas replacing or removing the whole file destroys the
   * part it never looked at. That is the ADR-0006 hallucination case with the
   * safety rail removed, so it is refused here (ADR-0016).
   */
  checkWhole(input: {
    receiptId: string;
    path: CanonicalPath;
    currentContent: string;
    operation: 'overwrite' | 'delete';
  }): { ok: true; receipt: SourceReceipt } | { ok: false; failure: FreshnessFailure } {
    const receipt = this.byId.get(input.receiptId);
    if (!receipt) {
      const latest = this.latestFor(input.path);
      return {
        ok: false,
        failure: {
          code: 'TOOL_INVALID_ARGS',
          message:
            `No read receipt "${input.receiptId}" is on file. Read the file first and pass the ` +
            'receiptId from that result.' +
            (latest ? ` The most recent receipt for this path is "${latest.receiptId}".` : ''),
        },
      };
    }

    if (receipt.path !== input.path) {
      return {
        ok: false,
        failure: {
          code: 'TOOL_INVALID_ARGS',
          message: `Receipt "${input.receiptId}" is for a different file. Read the target file and use its receipt.`,
        },
      };
    }

    const currentHash = sha256Hex(input.currentContent);
    if (currentHash !== receipt.contentHash) {
      return {
        ok: false,
        failure: {
          code: 'STALE_FILE',
          message:
            `The file changed after it was read, so this ${input.operation} would act on content that no ` +
            'longer exists. Read the file again and reissue the call.',
          currentHash: currentHash.slice(0, 12),
          receiptHash: receipt.contentHash.slice(0, 12),
        },
      };
    }

    if (this.writesInFlight.has(input.path)) {
      return {
        ok: false,
        failure: {
          code: 'CONCURRENT_MODIFICATION',
          message:
            'Another tool call in this step is already modifying this file. Finish that one, then re-read ' +
            'before this call.',
        },
      };
    }

    if (receipt.coverage.kind !== 'full') {
      const { start, end } = receipt.coverage;
      return {
        ok: false,
        failure: {
          code: 'INSUFFICIENT_READ_COVERAGE',
          message:
            `This would ${input.operation} the whole file, but only lines ${start}-${end} were read. ` +
            'Read the file in full first, or use Edit to change the region you have seen.',
          sawLines: `${start}-${end}`,
          neededLines: 'the whole file',
        },
      };
    }

    return { ok: true, receipt };
  }

  /**
   * The full pre-edit check.
   *
   * Returns match offsets on success so the edit engine does not have to search
   * the file a second time and risk disagreeing with the check.
   */
  check(input: FreshnessCheckInput): FreshnessCheckResult {
    const receipt = this.byId.get(input.receiptId);
    if (!receipt) {
      const latest = this.latestFor(input.path);
      return {
        ok: false,
        failure: {
          code: 'TOOL_INVALID_ARGS',
          message:
            `No read receipt "${input.receiptId}" is on file. Read the file first and pass the ` +
            `receiptId from that result.` +
            (latest ? ` The most recent receipt for this path is "${latest.receiptId}".` : ''),
        },
      };
    }

    if (receipt.path !== input.path) {
      return {
        ok: false,
        failure: {
          code: 'TOOL_INVALID_ARGS',
          message: `Receipt "${input.receiptId}" is for a different file. Read the target file and use its receipt.`,
        },
      };
    }

    // (1) Has the file changed since the model saw it?
    const currentHash = sha256Hex(input.currentContent);
    if (currentHash !== receipt.contentHash) {
      return {
        ok: false,
        failure: {
          code: 'STALE_FILE',
          message:
            'The file changed after it was read, so this edit was computed against content that no longer exists. ' +
            'Read the file again and reissue the edit against the current contents.',
          currentHash: currentHash.slice(0, 12),
          receiptHash: receipt.contentHash.slice(0, 12),
        },
      };
    }

    // (4) Is another in-flight tool call writing this file?
    if (this.writesInFlight.has(input.path)) {
      return {
        ok: false,
        failure: {
          code: 'CONCURRENT_MODIFICATION',
          message:
            'Another tool call in this step is already modifying this file. Apply one edit at a time, ' +
            'then re-read before the next.',
        },
      };
    }

    if (input.oldString === '') {
      return {
        ok: false,
        failure: { code: 'TOOL_INVALID_ARGS', message: 'oldString must not be empty.' },
      };
    }

    const content = toLf(input.currentContent);
    const needle = toLf(input.oldString);

    // (3) Uniqueness.
    const matchOffsets = findAll(content, needle);
    if (matchOffsets.length === 0) {
      return {
        ok: false,
        failure: {
          code: 'TOOL_INVALID_ARGS',
          message:
            'oldString was not found in the file. It must match the file exactly, including indentation. ' +
            'Re-read the region and copy the text verbatim.',
        },
      };
    }
    if (matchOffsets.length > 1 && !input.replaceAll) {
      return {
        ok: false,
        failure: {
          code: 'NON_UNIQUE_MATCH',
          message:
            `oldString matches ${matchOffsets.length} times. Include enough surrounding context to make it ` +
            'unique, or set replaceAll to true if every occurrence should change.',
          matches: matchOffsets.length,
        },
      };
    }

    // (2) Coverage: every match must lie in the region the model actually read.
    if (receipt.coverage.kind === 'lines') {
      const { start, end } = receipt.coverage;
      const outside = matchOffsets.filter(
        (offset) => !withinLines(content, offset, needle.length, start, end),
      );
      if (outside.length > 0) {
        return {
          ok: false,
          failure: {
            code: 'INSUFFICIENT_READ_COVERAGE',
            message:
              'This edit targets part of the file that was never read. Read the region you intend to change ' +
              'before editing it.',
            sawLines: `${start}-${end}`,
            neededLines: describeLines(content, outside, needle.length),
          },
        };
      }
    }

    return { ok: true, receipt, matchCount: matchOffsets.length, matchOffsets };
  }
}

function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    out.push(at);
    from = at + needle.length;
  }
  return out;
}

/** 1-based line number of a byte offset in LF-normalised content. */
function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function withinLines(content: string, offset: number, length: number, start: number, end: number): boolean {
  const first = lineOf(content, offset);
  const last = lineOf(content, offset + length - 1);
  return first >= start && last <= end;
}

function describeLines(content: string, offsets: readonly number[], length: number): string {
  return offsets
    .slice(0, 3)
    .map((o) => `${lineOf(content, o)}-${lineOf(content, o + length - 1)}`)
    .join(', ');
}

/** Turn a freshness failure into the structured error the model receives. */
export function freshnessError(failure: FreshnessFailure): KernelError {
  const details: Record<string, unknown> = {};
  if ('currentHash' in failure) {
    details.currentHash = failure.currentHash;
    details.receiptHash = failure.receiptHash;
  }
  if ('matches' in failure) details.matches = failure.matches;
  if ('sawLines' in failure) {
    details.linesRead = failure.sawLines;
    details.linesNeeded = failure.neededLines;
  }
  return kernelError(failure.code, failure.message, {
    blame: 'model',
    retryable: false,
    safeDetails: details,
  });
}

/** Convenience: the line span a slice of content occupies. */
export function coverageForSlice(content: string, startLine: number, endLine: number): Coverage {
  const total = splitLines(content).length;
  if (startLine <= 1 && endLine >= total) return { kind: 'full' };
  return { kind: 'lines', start: startLine, end: endLine };
}
