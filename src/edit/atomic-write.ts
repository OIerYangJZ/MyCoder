/**
 * Rollback metadata for applied edits (spec §10.2, ADR-0025).
 *
 * Every persistent edit records enough to be reviewed and undone: both hashes,
 * the unified diff, and the identifiers that tie it to a specific tool call,
 * step and model request. Without the last part an audit can tell you a file
 * changed but not which decision caused it.
 *
 * The *content* is not stored under that name — the diff plus the old hash is
 * enough to reverse a replace, and keeping full copies of every version of every
 * file in the session directory is not a trade worth making.
 *
 * That said, ADR-0025 §2 stops pretending the rule holds everywhere. For a
 * `delete` the diff *is* the copy, and for an `overwrite` past the differ's LCS
 * ceiling it is the copy twice over — measured at 2.1× the file. §5's ceiling is
 * what keeps that bounded, and it is a ceiling rather than a euphemism.
 *
 * Until alpha.10 this journal was a private array that died with the process.
 * It is now rebuilt from the event log on resume (`rebuildJournal`), which is
 * what lets an undo survive a crash.
 */

import type { JournalEntryId, ModelRequestId, StepId, ToolCallId, TurnId } from '../util/ids.ts';
import type { CanonicalPath } from '../util/paths.ts';
import type { EolStyle } from '../util/text.ts';

/**
 * Ceiling on the diff carried by one journal entry (ADR-0025 §5).
 *
 * Above it the event is still written — the audit trail is not optional — but
 * the diff is dropped and `diffOmitted` records how many bytes went. The entry
 * keeps its hashes, kind, path and identifiers, so the log still answers "what
 * changed, when, and because of which tool call". Only the reversal is lost, and
 * `/undo` says so rather than discovering it later.
 */
export const MAX_JOURNAL_DIFF_BYTES = 1024 * 1024;

export type EditKind = 'replace' | 'create' | 'overwrite' | 'delete' | 'move';

export interface RollbackMetadata {
  /** Stable identity, so an undo can name exactly what it reversed. */
  entryId: JournalEntryId;
  path: CanonicalPath;
  displayPath: string;
  kind: EditKind;
  oldHash: string;
  newHash: string;
  /**
   * Unified diff, redacted. Reverse-applying it restores the previous content —
   * *when it can*. `reverse-diff.ts` documents the four cases where it cannot,
   * and ADR-0025 §4 is why none of them can corrupt a file: the reconstruction
   * is hashed against `oldHash` before anything is written.
   */
  diff: string;
  /** Bytes dropped by the §5 ceiling. Present only when the diff was omitted. */
  diffOmitted?: number;
  eol: EolStyle;
  /**
   * Whether the *pre-edit* content ended with a newline.
   *
   * One bit, and nothing else preserves it: `splitLines` cannot distinguish
   * `"a\nb"` from `"a\nb\n"`, so neither can the diff.
   */
  finalNewline: boolean;
  /** Pre-edit content mixed CRLF and LF; a reversal cannot restore that exactly. */
  mixedEol?: boolean;
  /** Present for creates, so an undo knows to delete rather than restore. */
  createdFile: boolean;
  /** Present for deletes, so an undo knows to restore rather than reverse. */
  deletedFile?: boolean;
  /** Set when the target was a directory, not a file. */
  directory?: boolean;
  /** Present for moves: the display path the file came from. */
  movedFrom?: string;
  /** Present for moves: the canonical path the file came from. */
  movedFromPath?: CanonicalPath;
  toolCallId: ToolCallId;
  turnId: TurnId;
  stepId: StepId;
  modelRequestId?: ModelRequestId;
  /** Set when a delegated child performed this edit (ADR-0025 §7). */
  delegationId?: string;
  /** Set when this edit was itself a reversal, naming what it reversed. */
  undoOf?: JournalEntryId;
  /**
   * Reconstructed from a log written before alpha.10, so it lacks the fields a
   * reversal needs. Kept in the inventory — a user asking what happened to their
   * workspace is owed the older edits too — and refused by `/undo` with a reason.
   */
  legacy?: boolean;
  appliedAt: number;
}

/** Ordered record of every edit in a session; the basis for `/status` dirty files. */
export class EditJournal {
  private readonly entries: RollbackMetadata[] = [];
  /** Entry ids that have been reversed, so the inventory stays accurate. */
  private readonly undone = new Set<string>();
  /**
   * Where this journal's knowledge begins.
   *
   * `undefined` means "this process, from the start". A rebuilt journal sets it
   * to the timestamp of the oldest entry it recovered, so §12's "edits from
   * before this process" can be stated as a boundary rather than a guess.
   */
  private rebuiltFrom?: number;

  record(entry: RollbackMetadata): void {
    this.entries.push(entry);
    if (entry.undoOf) this.undone.add(entry.undoOf);
  }

  /**
   * Reinstate entries recovered from the event log (ADR-0025 §6).
   *
   * Separate from `record` because rebuild is not an edit: nothing was written
   * to the workspace, and the entries arrive in log order rather than as they
   * happen.
   */
  restore(entries: readonly RollbackMetadata[], boundary?: number): void {
    for (const entry of entries) {
      this.entries.push(entry);
      if (entry.undoOf) this.undone.add(entry.undoOf);
    }
    if (boundary !== undefined) this.rebuiltFrom = boundary;
  }

  /** The oldest point this journal knows about, or undefined for "this process". */
  get boundary(): number | undefined {
    return this.rebuiltFrom;
  }

  all(): readonly RollbackMetadata[] {
    return this.entries;
  }

  isUndone(entryId: JournalEntryId): boolean {
    return this.undone.has(entryId);
  }

  /** Entries not yet reversed, newest first. The candidates for an undo. */
  pending(): RollbackMetadata[] {
    return this.entries.filter((e) => e.undoOf === undefined && !this.undone.has(e.entryId)).reverse();
  }

  get undoneCount(): number {
    return this.undone.size;
  }

  find(entryId: string): RollbackMetadata | undefined {
    return this.entries.find((e) => e.entryId === entryId);
  }

  /** Distinct paths touched, newest first. */
  dirtyPaths(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i]!;
      if (seen.has(entry.displayPath)) continue;
      seen.add(entry.displayPath);
      out.push(entry.displayPath);
    }
    return out;
  }

  forPath(path: CanonicalPath): RollbackMetadata[] {
    return this.entries.filter((e) => e.path === path);
  }

  get size(): number {
    return this.entries.length;
  }

  /** Summary suitable for re-injection after compaction (spec §20.2). */
  summary(limit = 20): string {
    const paths = this.dirtyPaths();
    if (paths.length === 0) return 'No files have been modified in this session.';
    const shown = paths.slice(0, limit);
    const more = paths.length - shown.length;
    return (
      `Modified in this session (${paths.length} file(s)):\n` +
      shown.map((p) => `  ${p}`).join('\n') +
      (more > 0 ? `\n  … and ${more} more` : '')
    );
  }
}

/**
 * Apply the §5 ceiling to a diff about to be journalled.
 *
 * Returns the fields to spread into a `RollbackMetadata`, so the decision lives
 * in one place rather than at each of the four call sites that could forget it.
 */
export function capJournalDiff(diff: string): { diff: string; diffOmitted?: number } {
  const bytes = Buffer.byteLength(diff, 'utf8');
  if (bytes <= MAX_JOURNAL_DIFF_BYTES) return { diff };
  return { diff: '', diffOmitted: bytes };
}
