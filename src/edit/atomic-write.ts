/**
 * Rollback metadata for applied edits (spec §10.2).
 *
 * Every persistent edit records enough to be reviewed and undone: both hashes,
 * the unified diff, and the identifiers that tie it to a specific tool call,
 * step and model request. Without the last part an audit can tell you a file
 * changed but not which decision caused it.
 *
 * The *content* is not stored here — the diff plus the old hash is enough to
 * reverse a replace, and keeping full copies of every version of every file in
 * the session directory is not a trade worth making.
 */

import type { ModelRequestId, StepId, ToolCallId, TurnId } from '../util/ids.ts';
import type { CanonicalPath } from '../util/paths.ts';
import type { EolStyle } from '../util/text.ts';

export interface RollbackMetadata {
  path: CanonicalPath;
  displayPath: string;
  kind: 'replace' | 'create';
  oldHash: string;
  newHash: string;
  /** Unified diff, redacted. Reversing it restores the previous content. */
  diff: string;
  eol: EolStyle;
  /** Present for creates, so an undo knows to delete rather than restore. */
  createdFile: boolean;
  toolCallId: ToolCallId;
  turnId: TurnId;
  stepId: StepId;
  modelRequestId?: ModelRequestId;
  appliedAt: number;
}

/** Ordered record of every edit in a session; the basis for `/status` dirty files. */
export class EditJournal {
  private readonly entries: RollbackMetadata[] = [];

  record(entry: RollbackMetadata): void {
    this.entries.push(entry);
  }

  all(): readonly RollbackMetadata[] {
    return this.entries;
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
