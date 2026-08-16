/**
 * The journal's durable form (ADR-0025 §1, §6).
 *
 * One module holding both directions — entry → `file.edited` payload, and
 * payload → entry — because they are one decision and splitting them is how a
 * field gets written by the emitter and forgotten by the reader. A round-trip
 * test over this pair is what makes "the journal survives the process" a claim
 * with evidence rather than an intention.
 *
 * The reader is deliberately lenient in one direction only. A payload written by
 * a kernel older than alpha.10 has no `kind`, no `entryId` and no `finalNewline`;
 * it is reconstructed as a `legacy` entry that appears in the inventory and is
 * refused by `/undo` with the reason. Dropping it would be worse: a user asking
 * what happened to their workspace is owed the older edits too.
 */

import type { JournalEntryId, ModelRequestId, StepId, ToolCallId, TurnId } from '../util/ids.ts';
import type { CanonicalPath } from '../util/paths.ts';
import type { KernelEvent } from '../session/events.ts';
import type { SessionId } from '../util/ids.ts';
import type { SessionStore } from '../session/store.ts';
import type { EditKind, RollbackMetadata } from './atomic-write.ts';
import { EditJournal } from './atomic-write.ts';

const KINDS: ReadonlySet<string> = new Set(['replace', 'create', 'overwrite', 'delete', 'move']);

/**
 * The event payload for one journal entry.
 *
 * `stats` is passed separately because it is display information the differ
 * produced, not something a reversal needs — but it was in the pre-alpha.10
 * payload, and an audit trail that loses a field it used to carry is a
 * regression whatever else the change adds.
 */
export function journalEventPayload(
  entry: RollbackMetadata,
  toolCallId: string,
  stats?: { linesAdded?: unknown; linesRemoved?: unknown },
): Record<string, unknown> {
  return {
    // Kept from the pre-alpha.10 shape so an existing log reader is unaffected.
    path: entry.displayPath,
    toolCallId,
    oldHash: entry.oldHash,
    newHash: entry.newHash,
    diff: entry.diff,
    eol: entry.eol,
    created: entry.createdFile,
    ...(typeof stats?.linesAdded === 'number' ? { linesAdded: stats.linesAdded } : {}),
    ...(typeof stats?.linesRemoved === 'number' ? { linesRemoved: stats.linesRemoved } : {}),

    // ADR-0025 §1: everything a reversal needs, and the fields that distinguish
    // the four tools that now share this event.
    entryId: entry.entryId,
    canonicalPath: entry.path,
    kind: entry.kind,
    finalNewline: entry.finalNewline,
    appliedAt: entry.appliedAt,
    ...(entry.diffOmitted !== undefined ? { diffOmitted: entry.diffOmitted } : {}),
    ...(entry.mixedEol ? { mixedEol: true } : {}),
    ...(entry.deletedFile ? { deletedFile: true } : {}),
    ...(entry.directory ? { directory: true } : {}),
    ...(entry.movedFrom !== undefined ? { movedFrom: entry.movedFrom } : {}),
    ...(entry.movedFromPath !== undefined ? { movedFromPath: entry.movedFromPath } : {}),
    ...(entry.modelRequestId !== undefined ? { modelRequestId: entry.modelRequestId } : {}),
    ...(entry.delegationId !== undefined ? { delegationId: entry.delegationId } : {}),
    ...(entry.undoOf !== undefined ? { undoOf: entry.undoOf } : {}),
  };
}

/**
 * The journal entries a tool result carries, if any.
 *
 * One tool call may produce several: an `Undo` that reverses three files
 * journals three reversals, and each is a mutation the log has to carry
 * separately or the audit trail is back to summarising. Accepting both shapes
 * keeps the four single-entry tools from having to wrap.
 */
export function journalEntriesOf(meta: Record<string, unknown> | undefined): RollbackMetadata[] {
  const raw = meta?.journal;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(
    (e): e is RollbackMetadata =>
      typeof e === 'object' && e !== null && typeof (e as RollbackMetadata).entryId === 'string',
  );
}

/**
 * Reconstruct one entry from a logged payload.
 *
 * Returns `undefined` only when there is not even a path to attribute the edit
 * to, which means the payload is not a `file.edited` this reader can place.
 */
export function journalEntryFromPayload(
  payload: Record<string, unknown>,
  event: Pick<KernelEvent, 'turnId' | 'stepId' | 'delegationId' | 'ts'>,
): RollbackMetadata | undefined {
  const displayPath = str(payload.path);
  if (displayPath === undefined) return undefined;

  const rawKind = str(payload.kind);
  const kind: EditKind = rawKind !== undefined && KINDS.has(rawKind) ? (rawKind as EditKind) : 'replace';

  // A payload with no entryId predates alpha.10. It is reconstructed, marked,
  // and refused by `/undo` rather than dropped.
  const recordedId = str(payload.entryId);
  const legacy = recordedId === undefined || str(payload.kind) === undefined;

  const entry: RollbackMetadata = {
    entryId: (recordedId ?? `jrn_legacy_${event.ts}_${displayPath}`) as JournalEntryId,
    path: (str(payload.canonicalPath) ?? displayPath) as CanonicalPath,
    displayPath,
    kind: legacy && payload.created === true ? 'create' : kind,
    oldHash: str(payload.oldHash) ?? '',
    newHash: str(payload.newHash) ?? '',
    diff: str(payload.diff) ?? '',
    eol: payload.eol === 'crlf' ? 'crlf' : 'lf',
    // Absent from a pre-alpha.10 payload. `true` is the value that makes a
    // reversal *fail its hash check* for a file that had no final newline,
    // rather than one that silently writes the wrong bytes — but such an entry
    // is `legacy` and refused before reaching that point anyway.
    finalNewline: payload.finalNewline !== false,
    createdFile: payload.created === true,
    toolCallId: (str(payload.toolCallId) ?? '') as ToolCallId,
    turnId: (event.turnId ?? '') as TurnId,
    stepId: (event.stepId ?? '') as StepId,
    appliedAt: num(payload.appliedAt) ?? event.ts,
  };

  if (legacy) entry.legacy = true;
  if (num(payload.diffOmitted) !== undefined) entry.diffOmitted = num(payload.diffOmitted)!;
  if (payload.mixedEol === true) entry.mixedEol = true;
  if (payload.deletedFile === true) entry.deletedFile = true;
  if (payload.directory === true) entry.directory = true;
  if (str(payload.movedFrom) !== undefined) entry.movedFrom = str(payload.movedFrom)!;
  if (str(payload.movedFromPath) !== undefined) {
    entry.movedFromPath = str(payload.movedFromPath)! as CanonicalPath;
  }
  if (str(payload.modelRequestId) !== undefined) {
    entry.modelRequestId = str(payload.modelRequestId)! as ModelRequestId;
  }
  const delegationId = str(payload.delegationId) ?? event.delegationId;
  if (delegationId !== undefined) entry.delegationId = delegationId;
  if (str(payload.undoOf) !== undefined) entry.undoOf = str(payload.undoOf)! as JournalEntryId;

  return entry;
}

export interface RebuiltJournal {
  entries: RollbackMetadata[];
  /** Timestamp of the oldest entry recovered, for §12's boundary statement. */
  boundary?: number;
  /** Entries that were recorded by a kernel older than alpha.10. */
  legacyCount: number;
  warnings: string[];
}

/**
 * Replay `file.edited` from the log into journal entries (ADR-0025 §6).
 *
 * Reads the log once, in sequence order, which `readEvents` already guarantees.
 * A torn log stops the iteration there — the store's existing behaviour — and
 * the caller is told how many entries were recovered rather than being handed a
 * partial journal that looks complete.
 */
export async function rebuildJournal(store: SessionStore, sessionId: SessionId): Promise<RebuiltJournal> {
  const entries: RollbackMetadata[] = [];
  let legacyCount = 0;
  let skipped = 0;

  for await (const event of store.readEvents(sessionId)) {
    if (event.type !== 'file.edited') continue;
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null) {
      skipped += 1;
      continue;
    }
    const entry = journalEntryFromPayload(payload as Record<string, unknown>, event);
    if (!entry) {
      skipped += 1;
      continue;
    }
    if (entry.legacy) legacyCount += 1;
    entries.push(entry);
  }

  const warnings: string[] = [];
  if (skipped > 0) {
    warnings.push(`${skipped} edit event(s) in the log could not be read as journal entries.`);
  }
  if (legacyCount > 0) {
    warnings.push(
      `${legacyCount} edit(s) were recorded by a kernel older than alpha.10 and cannot be undone; ` +
        'they are listed for audit only.',
    );
  }

  const result: RebuiltJournal = { entries, legacyCount, warnings };
  const oldest = entries[0]?.appliedAt;
  if (oldest !== undefined) result.boundary = oldest;
  return result;
}

/** Convenience for resume: a journal already populated from the log. */
export async function journalFromLog(
  store: SessionStore,
  sessionId: SessionId,
  into: EditJournal = new EditJournal(),
): Promise<{ journal: EditJournal; rebuilt: RebuiltJournal }> {
  const rebuilt = await rebuildJournal(store, sessionId);
  into.restore(rebuilt.entries, rebuilt.boundary);
  return { journal: into, rebuilt };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
