/**
 * Delete tool (ADR-0016).
 *
 * Removes **one** file, or one empty directory. Not a tree: `Delete` refuses a
 * directory with anything in it and says so, because the kernel cannot render a
 * meaningful approval prompt for "remove 400 files" and a tool that walks a tree
 * unlinking things is a different risk class from one that unlinks a named path.
 * Removing a tree stays a `Shell` command, where the approval is for running a
 * program and the user sees which one.
 *
 * Deleting a file requires a receipt covering the whole file, for the reason
 * `Write` does: the model must have seen what it is destroying. The deletion is
 * planned through the edit engine, so it produces a real diff — which is both
 * what the approval prompt shows and what a future undo would replay.
 */

import type { JsonSchema } from '../../util/jsonschema.ts';
import { renderErrorForModel } from '../../util/errors.ts';
import { truncateForModel } from '../../util/text.ts';
import { toPosix } from '../../util/paths.ts';
import { ExactEditEngine, EditConflictError, type EditPlan } from '../../edit/edit-engine.ts';
import type { EditJournal, RollbackMetadata } from '../../edit/atomic-write.ts';
import { newJournalEntryId, sha256Hex } from '../../util/ids.ts';
import {
  errorResult,
  okResult,
  refusedExecution,
  type ToolDefinition,
  type ToolExecution,
  type ToolResolveContext,
} from '../contract.ts';

export interface DeleteArgs {
  path: string;
  receiptId?: string;
}

const EMPTY_HASH = sha256Hex('');

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'File or empty directory to remove.',
      minLength: 1,
    },
    receiptId: {
      type: 'string',
      description:
        'Required for a file: the receiptId from a Read that covered the whole file. ' +
        'Not needed for an empty directory, which has nothing to read.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

export interface DeleteToolOptions {
  journal: EditJournal;
  /** Called after a successful deletion so the session can append the event. */
  onApplied?: (plan: EditPlan) => void;
}

/**
 * Paths inside the git database.
 *
 * Refused at the tool rather than in `ProtectedPaths` because this is not a
 * secret-boundary rule: `.git` is readable, and a `Shell git` command may rewrite
 * it. What must not happen is a single tool call quietly unlinking part of the
 * object store, where the failure surfaces as an unrelated corruption later.
 */
function isGitInternal(canonical: string, workspaceRoot: string): boolean {
  const p = toPosix(canonical);
  const root = toPosix(workspaceRoot);
  return p === `${root}/.git` || p.startsWith(`${root}/.git/`) || p.includes('/.git/');
}

export function createDeleteTool(opts: DeleteToolOptions): ToolDefinition<DeleteArgs> {
  const engine = new ExactEditEngine();

  return {
    name: 'Delete',
    description:
      'Remove a single file, or an empty directory. For a file you must first Read it in full and pass ' +
      'that receiptId. Non-empty directories are not removed — delete their contents first, or run an ' +
      'explicit Shell command. Deletion always requires approval.',
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: false,

    async resolve(args: DeleteArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const { path: canonical, existed } = await ctx.canonicalize(args.path);
      const displayPath = ctx.display(canonical);

      const subject = {
        key: `Delete:${canonical}`,
        title: `Delete ${displayPath}`,
        details: [`file: ${displayPath}`, 'the file is removed; this is not undone automatically'],
        risk: 'high' as const,
      };
      const display = { title: 'Delete file', summary: displayPath };

      if (!existed) {
        return refusedExecution(
          subject,
          display,
          errorResult('TOOL_FAILED', `No such file or directory: ${displayPath}`),
        );
      }
      if (canonical === ctx.workspaceRoot) {
        return refusedExecution(
          subject,
          display,
          errorResult('TOOL_INVALID_ARGS', 'The workspace root cannot be deleted.'),
        );
      }
      if (isGitInternal(canonical, ctx.workspaceRoot)) {
        return refusedExecution(
          subject,
          display,
          errorResult(
            'TOOL_INVALID_ARGS',
            `${displayPath} is inside the git database. Use a git command instead of removing it by hand.`,
          ),
        );
      }

      return {
        accesses: [
          { kind: 'file.delete', path: canonical, display: displayPath },
          // Hashing and diffing the file before it goes: kernel-internal, so not
          // a to-model read.
          { kind: 'file.read', path: canonical, toModel: false, display: displayPath },
        ],
        approvalSubject: subject,
        display,

        async execute(executor, signal) {
          if (signal.aborted) return errorResult('CANCELLED', 'Delete was cancelled.');

          const stat = await executor.fs.stat(canonical);
          if (!stat) return errorResult('TOOL_FAILED', `No such file or directory: ${displayPath}`);

          if (stat.isDirectory) {
            const entries = await executor.fs.listDir(canonical);
            if (entries.length > 0) {
              return errorResult(
                'TOOL_INVALID_ARGS',
                `${displayPath} is a directory containing ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}. ` +
                  'Only empty directories are removed by this tool; delete the contents first, or run an ' +
                  'explicit Shell command.',
              );
            }
            await executor.fs.remove(canonical, { directory: true });

            // An empty-directory removal is still a mutation, and until alpha.10
            // it reached neither the journal nor the log — the one code path in
            // the four mutating tools that changed the workspace with no record
            // at all. There is no content to restore, so the entry exists to be
            // audited and re-created, and its diff is empty by construction.
            const dirEntry: RollbackMetadata = {
              entryId: newJournalEntryId(ctx.now()),
              path: canonical,
              displayPath,
              kind: 'delete',
              oldHash: sha256Hex(`dir:${canonical}`).slice(0, 32),
              newHash: EMPTY_HASH,
              diff: '',
              eol: 'lf',
              finalNewline: true,
              createdFile: false,
              deletedFile: true,
              directory: true,
              toolCallId: ctx.toolCallId,
              turnId: ctx.turnId,
              stepId: ctx.stepId,
              appliedAt: ctx.now(),
            };
            opts.journal.record(dirEntry);

            return okResult(`Removed empty directory ${displayPath}.`, {
              structured: { path: displayPath, kind: 'directory' },
              metadata: { path: displayPath, kind: 'directory', journal: dirEntry },
            });
          }

          if (typeof args.receiptId !== 'string' || args.receiptId === '') {
            return errorResult(
              'TOOL_INVALID_ARGS',
              `Deleting ${displayPath} requires the receiptId from a Read that covered the whole file.`,
            );
          }

          const editCtx = {
            freshness: ctx.freshness,
            toolCallId: ctx.toolCallId,
            turnId: ctx.turnId,
            stepId: ctx.stepId,
            // ADR-0025 §7: a child's edits enter the parent's journal, but
            // attributed. The registry is shared, so without this the parent
            // could not tell its own edits from a subagent's.
            ...(ctx.delegation.delegationId ? { delegationId: ctx.delegation.delegationId } : {}),
            now: ctx.now,
          };

          const planned = await engine.plan(
            { mode: 'delete', path: canonical, displayPath, receiptId: args.receiptId },
            editCtx,
            executor,
          );
          if (!planned.ok) {
            return {
              content: renderErrorForModel(planned.error),
              isError: true,
              errorCode: planned.error.code,
            };
          }

          const plan = planned.plan;

          try {
            const result = await engine.apply(plan, editCtx, executor);
            opts.journal.record(result.rollback);
            opts.onApplied?.(plan);

            const diffPreview = truncateForModel(plan.diff, { maxBytes: 4 * 1024, maxLines: 80 });

            return okResult(
              `Deleted ${plan.displayPath} (${plan.stats.linesRemoved} lines).\n\n${diffPreview.text}`,
              {
                structured: {
                  path: plan.displayPath,
                  kind: 'file',
                  linesRemoved: plan.stats.linesRemoved,
                },
                metadata: {
                  path: plan.displayPath,
                  kind: 'file',
                  oldHash: plan.oldHash,
                  diff: plan.diff,
                  linesRemoved: plan.stats.linesRemoved,
                  // CLOSURE B (ADR-0025 §1). The least recoverable of the four
                  // tools was the one with no durable record at all.
                  journal: result.rollback,
                },
              },
            );
          } catch (e) {
            if (e instanceof EditConflictError) {
              return {
                content: renderErrorForModel(e.kernelError),
                isError: true,
                errorCode: e.kernelError.code,
              };
            }
            throw e;
          }
        },
      };
    },
  };
}
