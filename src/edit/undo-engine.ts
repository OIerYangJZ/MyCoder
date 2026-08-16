/**
 * Undo (ADR-0026).
 *
 * Two phases, and the split is the whole safety property:
 *
 *   plan()  — for every selected entry: check the precondition, reconstruct the
 *             prior content, hash it against what the journal recorded. Reads
 *             the filesystem; changes nothing.
 *   apply() — write the reconstructions that phase one already verified.
 *
 * A three-file undo where the second file drifted must reverse **nothing**. The
 * alternative — reverse what you can, report the rest — produces a workspace in
 * a state that never existed at any point in the session, which is worse than
 * either endpoint. *Reversing part of a set produces a state that never existed.
 * Refusing produces one that did.*
 *
 * The other property worth naming: no reversal is applied on the strength of the
 * diff being *believed* reversible. Every reconstruction is hashed against the
 * `oldHash` the journal recorded at the time, so redaction, mixed line endings,
 * an empty diff and any loss mechanism nobody has thought of yet all produce a
 * refusal rather than a corrupted file (ADR-0025 §4).
 */

import { sha256Hex, type JournalEntryId } from '../util/ids.ts';
import type { CanonicalPath } from '../util/paths.ts';
import { detectEol, toLf } from '../util/text.ts';
import type { CapabilityExecutor } from '../execution/backend.ts';
import type { FreshnessLedger } from '../context/freshness.ts';
import type { EditJournal, RollbackMetadata } from './atomic-write.ts';
import { applyByteShape, contentFromDeletionDiff, reverseUnifiedDiff } from './reverse-diff.ts';

/** What a reversal will do to one path, once it is known to be possible. */
export type UndoAction =
  | { kind: 'write'; path: CanonicalPath; displayPath: string; content: string }
  | { kind: 'remove'; path: CanonicalPath; displayPath: string }
  | { kind: 'mkdir'; path: CanonicalPath; displayPath: string }
  | { kind: 'rename'; path: CanonicalPath; displayPath: string; to: CanonicalPath; toDisplay: string };

export interface UndoStep {
  entry: RollbackMetadata;
  action: UndoAction;
  /** One line, for the result and the approval prompt. */
  summary: string;
}

export interface UndoRefusal {
  entry: RollbackMetadata;
  displayPath: string;
  /** Machine-readable cause, so the matrix can assert on it. */
  code: UndoRefusalCode;
  reason: string;
}

export type UndoRefusalCode =
  | 'drifted'
  | 'missing'
  | 'protected'
  | 'occupied'
  | 'not-reconstructible'
  | 'diff-omitted'
  | 'legacy'
  | 'already-undone';

export interface UndoPlan {
  steps: UndoStep[];
  refusals: UndoRefusal[];
}

export interface UndoContext {
  freshness: FreshnessLedger;
  /** Returns a refusal reason when the path may not be written, else undefined. */
  checkWritable(path: CanonicalPath): string | undefined;
}

/**
 * Phase one: decide, for each entry, whether it can be reversed.
 *
 * Never throws for an ordinary refusal — a refusal is information, not an
 * exception. The caller decides whether one refusal cancels the set; §3 of
 * ADR-0026 says it does, and `applyUndo` enforces that by construction (it takes
 * only a fully-verified list).
 */
export async function planUndo(
  entries: readonly RollbackMetadata[],
  ctx: UndoContext,
  executor: CapabilityExecutor,
  journal: EditJournal,
): Promise<UndoPlan> {
  const steps: UndoStep[] = [];
  const refusals: UndoRefusal[] = [];

  // Paths this plan will have changed by the time a later step runs. A two-entry
  // undo on one path must reason about the state the first reversal leaves, not
  // the state on disk right now.
  const projected = new Map<string, { exists: boolean; hash: string; content: string }>();

  for (const entry of entries) {
    const refuse = (code: UndoRefusalCode, reason: string): void => {
      refusals.push({ entry, displayPath: entry.displayPath, code, reason });
    };

    if (journal.isUndone(entry.entryId)) {
      refuse('already-undone', 'this edit has already been reversed');
      continue;
    }
    if (entry.legacy) {
      refuse(
        'legacy',
        'this edit was recorded by a kernel older than alpha.10, which did not store what a ' +
          'reversal needs',
      );
      continue;
    }
    if (entry.diffOmitted !== undefined) {
      refuse(
        'diff-omitted',
        `the recorded diff was ${entry.diffOmitted} bytes and exceeded the journal ceiling, so the ` +
          'previous content was not kept',
      );
      continue;
    }

    const protectedReason = ctx.checkWritable(entry.path);
    if (protectedReason !== undefined) {
      refuse('protected', protectedReason);
      continue;
    }

    if (entry.kind === 'move') {
      const outcome = await planMoveBack(entry, ctx, executor, projected);
      if (outcome.ok) {
        steps.push(outcome.step);
        project(projected, outcome.step.action);
      } else refuse(outcome.code, outcome.reason);
      continue;
    }

    if (entry.kind === 'create') {
      const outcome = await planUncreate(entry, executor, projected);
      if (outcome.ok) {
        steps.push(outcome.step);
        project(projected, outcome.step.action);
      } else refuse(outcome.code, outcome.reason);
      continue;
    }

    if (entry.kind === 'delete') {
      const outcome = await planUndelete(entry, executor, projected);
      if (outcome.ok) {
        steps.push(outcome.step);
        project(projected, outcome.step.action);
      } else refuse(outcome.code, outcome.reason);
      continue;
    }

    const outcome = await planRestore(entry, executor, projected);
    if (outcome.ok) {
      steps.push(outcome.step);
      project(projected, outcome.step.action);
    } else refuse(outcome.code, outcome.reason);
  }

  return { steps, refusals };
}

type StepOutcome = { ok: true; step: UndoStep } | { ok: false; code: UndoRefusalCode; reason: string };

type Projection = Map<string, { exists: boolean; hash: string; content: string }>;

/**
 * Record what a planned step will have done, so a later step in the same plan
 * checks its precondition against the right state.
 *
 * Undoing two edits to one file is the ordinary case — the second entry's
 * `newHash` is what the *first* reversal produces, not what is on disk now — and
 * without this the second would always be reported as drifted.
 */
function project(projected: Projection, action: UndoAction): void {
  switch (action.kind) {
    case 'write':
      projected.set(action.path, {
        exists: true,
        hash: sha256Hex(action.content),
        content: action.content,
      });
      break;
    case 'remove':
      projected.set(action.path, { exists: false, hash: '', content: '' });
      break;
    case 'mkdir':
      projected.set(action.path, { exists: true, hash: '', content: '' });
      break;
    case 'rename': {
      const moved = projected.get(action.path) ?? { exists: true, hash: '', content: '' };
      projected.set(action.path, { exists: false, hash: '', content: '' });
      projected.set(action.to, { ...moved, exists: true });
      break;
    }
  }
}

/** Current state of a path, honouring what earlier steps in this plan will do. */
async function currentState(
  path: CanonicalPath,
  executor: CapabilityExecutor,
  projected: Projection,
): Promise<{ exists: boolean; hash: string; content: string } | undefined> {
  const pending = projected.get(path);
  if (pending) return pending;
  const stat = await executor.fs.stat(path);
  if (!stat) return { exists: false, hash: '', content: '' };
  if (stat.isDirectory) return undefined;
  const content = (await executor.fs.readFile(path)).toString('utf8');
  return { exists: true, hash: sha256Hex(content), content };
}

/** `replace` and `overwrite`: reverse the diff and prove the result. */
async function planRestore(
  entry: RollbackMetadata,
  executor: CapabilityExecutor,
  projected: Projection,
): Promise<StepOutcome> {
  const state = await currentState(entry.path, executor, projected);
  if (!state) {
    return { ok: false, code: 'missing', reason: `${entry.displayPath} is now a directory` };
  }
  if (!state.exists) {
    return {
      ok: false,
      code: 'missing',
      reason: `${entry.displayPath} no longer exists, so there is nothing to put back`,
    };
  }
  if (state.hash !== entry.newHash) {
    return {
      ok: false,
      code: 'drifted',
      reason:
        `${entry.displayPath} changed after that edit — by you, by a shell command, or by a tool ` +
        'the kernel cannot see. Reversing it now would discard that change.',
    };
  }

  const restored = reconstruct(entry, state.content);
  if (!restored.ok) return restored;

  return {
    ok: true,
    step: {
      entry,
      action: {
        kind: 'write',
        path: entry.path,
        displayPath: entry.displayPath,
        content: restored.content,
      },
      summary: `restore ${entry.displayPath} to its content before the ${entry.kind}`,
    },
  };
}

/** `create`: the reversal is a deletion, and only if the file is untouched. */
async function planUncreate(
  entry: RollbackMetadata,
  executor: CapabilityExecutor,
  projected: Projection,
): Promise<StepOutcome> {
  const state = await currentState(entry.path, executor, projected);
  if (!state) {
    return { ok: false, code: 'missing', reason: `${entry.displayPath} is now a directory` };
  }
  if (!state.exists) {
    return { ok: false, code: 'missing', reason: `${entry.displayPath} has already been removed` };
  }
  if (state.hash !== entry.newHash) {
    return {
      ok: false,
      code: 'drifted',
      reason:
        `${entry.displayPath} was created by this session and has changed since. Removing it now ` +
        'would discard work that is not in the journal.',
    };
  }
  return {
    ok: true,
    step: {
      entry,
      action: { kind: 'remove', path: entry.path, displayPath: entry.displayPath },
      summary: `remove ${entry.displayPath}, which this session created`,
    },
  };
}

/** `delete`: re-create from the diff, which for a deletion *is* the copy. */
async function planUndelete(
  entry: RollbackMetadata,
  executor: CapabilityExecutor,
  projected: Projection,
): Promise<StepOutcome> {
  const state = await currentState(entry.path, executor, projected);
  if (state?.exists) {
    return {
      ok: false,
      code: 'occupied',
      reason: `${entry.displayPath} exists again; restoring the deleted file would overwrite it`,
    };
  }

  if (entry.directory === true) {
    return {
      ok: true,
      step: {
        entry,
        action: { kind: 'mkdir', path: entry.path, displayPath: entry.displayPath },
        summary: `re-create the empty directory ${entry.displayPath}`,
      },
    };
  }

  const extracted = contentFromDeletionDiff(entry.diff);
  if (!extracted.ok) {
    return {
      ok: false,
      code: 'not-reconstructible',
      reason: `the recorded content of ${entry.displayPath} cannot be read back: ${extracted.reason}`,
    };
  }
  const content = applyByteShape(extracted.text, {
    eol: entry.eol,
    finalNewline: entry.finalNewline,
  });
  if (sha256Hex(content) !== entry.oldHash) {
    return { ok: false, code: 'not-reconstructible', reason: mismatchReason(entry) };
  }

  return {
    ok: true,
    step: {
      entry,
      action: { kind: 'write', path: entry.path, displayPath: entry.displayPath, content },
      summary: `restore the deleted ${entry.displayPath}`,
    },
  };
}

/** `move`: rename back, if the destination is still there and the source is free. */
async function planMoveBack(
  entry: RollbackMetadata,
  ctx: UndoContext,
  executor: CapabilityExecutor,
  projected: Projection,
): Promise<StepOutcome> {
  const source = entry.movedFromPath;
  if (source === undefined) {
    return {
      ok: false,
      code: 'not-reconstructible',
      reason: `the journal did not record where ${entry.displayPath} was moved from`,
    };
  }

  const protectedReason = ctx.checkWritable(source);
  if (protectedReason !== undefined) return { ok: false, code: 'protected', reason: protectedReason };

  const dest = projected.get(entry.path);
  const destStat = dest ? { exists: dest.exists } : { exists: !!(await executor.fs.stat(entry.path)) };
  if (!destStat.exists) {
    return {
      ok: false,
      code: 'missing',
      reason: `${entry.displayPath} is gone, so it cannot be moved back`,
    };
  }

  const sourcePending = projected.get(source);
  const sourceOccupied = sourcePending ? sourcePending.exists : !!(await executor.fs.stat(source));
  if (sourceOccupied) {
    return {
      ok: false,
      code: 'occupied',
      reason: `${entry.movedFrom ?? source} exists again; moving ${entry.displayPath} back would overwrite it`,
    };
  }

  return {
    ok: true,
    step: {
      entry,
      action: {
        kind: 'rename',
        path: entry.path,
        displayPath: entry.displayPath,
        to: source,
        toDisplay: entry.movedFrom ?? source,
      },
      summary: `move ${entry.displayPath} back to ${entry.movedFrom ?? source}`,
    },
  };
}

/**
 * Reverse the diff and prove the result is what was recorded.
 *
 * An empty diff is not a failure: a `Write` that only added a final newline
 * produces one, because `splitLines` cannot see that change. The byte shape
 * carries it instead, and the hash check below decides whether that was enough.
 */
function reconstruct(
  entry: RollbackMetadata,
  currentContent: string,
): { ok: true; content: string } | { ok: false; code: UndoRefusalCode; reason: string } {
  const currentLf = toLf(currentContent);
  let priorLf: string;

  if (entry.diff === '') {
    priorLf = currentLf;
  } else {
    const reversed = reverseUnifiedDiff(currentLf, entry.diff);
    if (!reversed.ok) {
      return {
        ok: false,
        code: 'not-reconstructible',
        reason: `the recorded diff for ${entry.displayPath} could not be reversed: ${reversed.reason}`,
      };
    }
    priorLf = reversed.text;
  }

  const content = applyByteShape(priorLf, { eol: entry.eol, finalNewline: entry.finalNewline });
  if (sha256Hex(content) !== entry.oldHash) {
    return { ok: false, code: 'not-reconstructible', reason: mismatchReason(entry) };
  }
  return { ok: true, content };
}

/**
 * Why a reconstruction did not match, in the most specific terms available.
 *
 * The generic message is honest but useless — "it did not match" leaves the user
 * with no idea whether this is a bug or a boundary. The two causes the audit
 * found are both detectable from the entry itself.
 */
function mismatchReason(entry: RollbackMetadata): string {
  if (/\[REDACTED:secret\//.test(entry.diff)) {
    return (
      `the recorded diff for ${entry.displayPath} contains a redacted credential. The event log never ` +
      'stores secret values, so the original line cannot be restored — reversing this would write the ' +
      'placeholder into your file.'
    );
  }
  if (entry.mixedEol === true) {
    return (
      `${entry.displayPath} mixed CRLF and LF line endings, and the journal records only the dominant ` +
      'style, so the exact original bytes cannot be reproduced.'
    );
  }
  return (
    `the content reconstructed for ${entry.displayPath} does not hash to what the journal recorded, ` +
    'so it is not the original. Nothing was written.'
  );
}

export interface UndoApplication {
  written: UndoStep[];
  /**
   * Set when the *write* phase failed after some files had been changed.
   *
   * Phase one makes this vanishingly unlikely — every precondition is checked
   * first — but a disk error mid-set is not preventable, only reportable. It is
   * reported, which is what the Silent Partial Stop actually forbids.
   */
  partialFailure?: { step: UndoStep; error: string };
}

/**
 * Phase two: write. Takes only steps `planUndo` verified.
 *
 * Ordering is the caller's (newest first). Each write is atomic on its own
 * through the backend; this adds the set, in the only sense a filesystem allows:
 * nothing is attempted until everything has been checked.
 */
export async function applyUndo(
  steps: readonly UndoStep[],
  ctx: UndoContext,
  executor: CapabilityExecutor,
): Promise<UndoApplication> {
  const written: UndoStep[] = [];

  for (const step of steps) {
    try {
      switch (step.action.kind) {
        case 'write': {
          await executor.fs.writeFileAtomic(step.action.path, Buffer.from(step.action.content, 'utf8'), {
            createParents: true,
          });
          break;
        }
        case 'remove':
          await executor.fs.remove(step.action.path);
          break;
        case 'mkdir':
          await executor.fs.mkdirp(step.action.path);
          break;
        case 'rename':
          await executor.fs.rename(step.action.path, step.action.to);
          break;
      }
    } catch (e) {
      return {
        written,
        partialFailure: { step, error: e instanceof Error ? e.message : String(e) },
      };
    }

    // ADR-0026 §7: the model's picture of every reverted path is now wrong, and
    // it did not cause that. Dropping the receipts makes the next Edit fail with
    // "read it again" rather than applying to content nobody has seen.
    ctx.freshness.invalidatePath(step.action.path);
    if (step.action.kind === 'rename') ctx.freshness.invalidatePath(step.action.to);
    written.push(step);
  }

  return { written };
}

/**
 * The journal entry an undo itself produces (ADR-0026 §5).
 *
 * Undo is an edit, so it is journalled — which is what makes undoing an undo
 * work by the ordinary mechanism rather than by a second code path.
 */
export function reversalEntry(
  step: UndoStep,
  ids: {
    entryId: JournalEntryId;
    toolCallId: RollbackMetadata['toolCallId'];
    turnId: RollbackMetadata['turnId'];
    stepId: RollbackMetadata['stepId'];
    now: number;
  },
  priorContent: string,
  restoredContent: string,
  diff: string,
): RollbackMetadata {
  const shape = detectEol(restoredContent);
  const entry: RollbackMetadata = {
    entryId: ids.entryId,
    path: step.action.kind === 'rename' ? step.action.to : step.action.path,
    displayPath: step.action.kind === 'rename' ? step.action.toDisplay : step.action.displayPath,
    kind: reversalKind(step),
    oldHash: sha256Hex(priorContent),
    newHash: sha256Hex(restoredContent),
    diff,
    eol: shape.style,
    finalNewline: shape.finalNewline,
    createdFile: step.entry.kind === 'delete',
    ...(step.entry.kind === 'create' ? { deletedFile: true } : {}),
    ...(step.entry.directory ? { directory: true } : {}),
    ...(step.action.kind === 'rename'
      ? { movedFrom: step.action.displayPath, movedFromPath: step.action.path }
      : {}),
    toolCallId: ids.toolCallId,
    turnId: ids.turnId,
    stepId: ids.stepId,
    undoOf: step.entry.entryId,
    appliedAt: ids.now,
  };
  return entry;
}

function reversalKind(step: UndoStep): RollbackMetadata['kind'] {
  switch (step.action.kind) {
    case 'remove':
      return 'delete';
    case 'mkdir':
      return 'create';
    case 'rename':
      return 'move';
    default:
      return step.entry.kind === 'delete' ? 'create' : 'replace';
  }
}
