/**
 * Edit Engine (spec §10).
 *
 * Two phases, mirroring the tool contract:
 *
 *   plan()  — verify the receipt, compute the new bytes, produce the diff.
 *             Reads the filesystem; changes nothing.
 *   apply() — write atomically through the executor, then refresh the ledger.
 *
 * Splitting them is what makes an approval prompt able to show the real diff
 * before anything is written, and what lets a denied edit cost nothing.
 *
 * The write sequence is the one the spec fixes (§10.2): verify receipt → read
 * current bytes → compute new bytes → diff → approval → temp file on the same
 * filesystem → fsync → atomic rename → record new hash → append event.
 */

import { sha256Hex, type ModelRequestId, type StepId, type ToolCallId, type TurnId } from '../util/ids.ts';
import { kernelError, type KernelError } from '../util/errors.ts';
import type { CanonicalPath } from '../util/paths.ts';
import type { EolStyle } from '../util/text.ts';
import type { CapabilityExecutor } from '../execution/backend.ts';
import { FreshnessLedger, freshnessError } from '../context/freshness.ts';
import type { RollbackMetadata } from './atomic-write.ts';
import { summarizeDiff, unifiedDiff, type DiffStats } from './diff.ts';
import { applyExactReplace, prepareCreate } from './exact-replace.ts';

export type EditProposal =
  | {
      mode: 'replace';
      path: CanonicalPath;
      displayPath: string;
      oldString: string;
      newString: string;
      receiptId: string;
      replaceAll: boolean;
    }
  | {
      mode: 'create';
      path: CanonicalPath;
      displayPath: string;
      content: string;
    };

export interface EditContext {
  freshness: FreshnessLedger;
  toolCallId: ToolCallId;
  turnId: TurnId;
  stepId: StepId;
  modelRequestId?: ModelRequestId;
  now(): number;
}

export interface EditPlan {
  proposal: EditProposal;
  path: CanonicalPath;
  displayPath: string;
  kind: 'replace' | 'create';
  /** Bytes to write, with the file's line-ending style applied. */
  newContent: string;
  oldHash: string;
  newHash: string;
  diff: string;
  stats: DiffStats;
  eol: EolStyle;
  mixedEol: boolean;
  replacements: number;
  /** Human summary for the approval prompt. */
  summary: string;
}

export interface EditResult {
  plan: EditPlan;
  rollback: RollbackMetadata;
  bytesWritten: number;
}

export type EditPlanOutcome = { ok: true; plan: EditPlan } | { ok: false; error: KernelError };

export interface EditEngine {
  plan(proposal: EditProposal, ctx: EditContext, executor: CapabilityExecutor): Promise<EditPlanOutcome>;
  apply(plan: EditPlan, ctx: EditContext, executor: CapabilityExecutor): Promise<EditResult>;
}

const EMPTY_HASH = sha256Hex('');

export class ExactEditEngine implements EditEngine {
  async plan(
    proposal: EditProposal,
    ctx: EditContext,
    executor: CapabilityExecutor,
  ): Promise<EditPlanOutcome> {
    if (proposal.mode === 'create') return this.planCreate(proposal, executor);
    return this.planReplace(proposal, ctx, executor);
  }

  private async planCreate(
    proposal: Extract<EditProposal, { mode: 'create' }>,
    executor: CapabilityExecutor,
  ): Promise<EditPlanOutcome> {
    const existing = await executor.fs.stat(proposal.path);
    if (existing) {
      return {
        ok: false,
        error: kernelError(
          'TOOL_INVALID_ARGS',
          `${proposal.displayPath} already exists. Read it and use mode "replace" to change it.`,
          { blame: 'model' },
        ),
      };
    }

    const prepared = prepareCreate(proposal.content);
    const diff = unifiedDiff('', prepared.contentLf, {
      oldLabel: '/dev/null',
      newLabel: proposal.displayPath,
    });

    return {
      ok: true,
      plan: {
        proposal,
        path: proposal.path,
        displayPath: proposal.displayPath,
        kind: 'create',
        newContent: prepared.content,
        oldHash: EMPTY_HASH,
        newHash: sha256Hex(prepared.contentLf),
        diff: diff.text,
        stats: diff.stats,
        eol: 'lf',
        mixedEol: false,
        replacements: 0,
        summary: `create ${proposal.displayPath} (${diff.stats.linesAdded} lines)`,
      },
    };
  }

  private async planReplace(
    proposal: Extract<EditProposal, { mode: 'replace' }>,
    ctx: EditContext,
    executor: CapabilityExecutor,
  ): Promise<EditPlanOutcome> {
    const stat = await executor.fs.stat(proposal.path);
    if (!stat) {
      return {
        ok: false,
        error: kernelError('TOOL_FAILED', `${proposal.displayPath} does not exist.`, { blame: 'model' }),
      };
    }
    if (stat.isDirectory) {
      return {
        ok: false,
        error: kernelError('TOOL_INVALID_ARGS', `${proposal.displayPath} is a directory.`, {
          blame: 'model',
        }),
      };
    }

    const currentContent = (await executor.fs.readFile(proposal.path)).toString('utf8');

    // The full freshness gate: hash match, coverage, uniqueness, concurrency.
    const check = ctx.freshness.check({
      receiptId: proposal.receiptId,
      path: proposal.path,
      currentContent,
      currentMtimeMs: stat.mtimeMs,
      oldString: proposal.oldString,
      replaceAll: proposal.replaceAll,
    });

    if (!check.ok) return { ok: false, error: freshnessError(check.failure) };

    const applied = applyExactReplace({
      currentContent,
      oldString: proposal.oldString,
      newString: proposal.newString,
      replaceAll: proposal.replaceAll,
      matchOffsets: check.matchOffsets,
    });

    if (applied.newContentLf === applied.oldContentLf) {
      return {
        ok: false,
        error: kernelError(
          'TOOL_INVALID_ARGS',
          'oldString and newString are identical, so this edit would change nothing.',
          { blame: 'model' },
        ),
      };
    }

    const diff = unifiedDiff(applied.oldContentLf, applied.newContentLf, {
      oldLabel: `a/${proposal.displayPath}`,
      newLabel: `b/${proposal.displayPath}`,
    });

    return {
      ok: true,
      plan: {
        proposal,
        path: proposal.path,
        displayPath: proposal.displayPath,
        kind: 'replace',
        newContent: applied.newContent,
        oldHash: sha256Hex(currentContent),
        newHash: sha256Hex(applied.newContent),
        diff: diff.text,
        stats: diff.stats,
        eol: applied.eol,
        mixedEol: applied.mixedEol,
        replacements: applied.replacements,
        summary:
          `edit ${proposal.displayPath} (${summarizeDiff(diff.stats)}` +
          `${applied.replacements > 1 ? `, ${applied.replacements} occurrences` : ''}` +
          `${applied.eol === 'crlf' ? ', CRLF preserved' : ''})`,
      },
    };
  }

  async apply(plan: EditPlan, ctx: EditContext, executor: CapabilityExecutor): Promise<EditResult> {
    // Claim the file for the duration of the write so a sibling tool call in the
    // same batch is reported as a concurrent modification rather than racing.
    if (!ctx.freshness.beginWrite(plan.path, ctx.toolCallId)) {
      throw new EditConflictError(
        kernelError(
          'CONCURRENT_MODIFICATION',
          `${plan.displayPath} is being modified by another tool call in this step.`,
          { blame: 'model' },
        ),
      );
    }

    try {
      const buffer = Buffer.from(plan.newContent, 'utf8');

      if (plan.kind === 'replace') {
        // Re-verify immediately before the write. Between plan and apply there
        // may have been an approval prompt, and a human takes seconds — long
        // enough for a formatter or a rebase to land.
        const current = (await executor.fs.readFile(plan.path)).toString('utf8');
        if (sha256Hex(current) !== plan.oldHash) {
          throw new EditConflictError(
            kernelError(
              'CONCURRENT_MODIFICATION',
              `${plan.displayPath} changed between planning and applying this edit. Read it again and retry.`,
              { blame: 'environment', retryable: true },
            ),
          );
        }
      }

      await executor.fs.writeFileAtomic(plan.path, buffer, {
        createParents: plan.kind === 'create',
      });

      const stat = await executor.fs.stat(plan.path);
      ctx.freshness.recordWrite(
        plan.path,
        plan.newContent,
        stat?.mtimeMs ?? ctx.now(),
        ctx.stepId,
        ctx.now(),
      );

      const rollback: RollbackMetadata = {
        path: plan.path,
        displayPath: plan.displayPath,
        kind: plan.kind,
        oldHash: plan.oldHash,
        newHash: plan.newHash,
        diff: plan.diff,
        eol: plan.eol,
        createdFile: plan.kind === 'create',
        toolCallId: ctx.toolCallId,
        turnId: ctx.turnId,
        stepId: ctx.stepId,
        appliedAt: ctx.now(),
      };
      if (ctx.modelRequestId) rollback.modelRequestId = ctx.modelRequestId;

      return { plan, rollback, bytesWritten: buffer.length };
    } finally {
      ctx.freshness.endWrite(plan.path, ctx.toolCallId);
    }
  }
}

export class EditConflictError extends Error {
  readonly kernelError: KernelError;

  constructor(err: KernelError) {
    super(err.message);
    this.name = 'EditConflictError';
    this.kernelError = err;
  }
}
