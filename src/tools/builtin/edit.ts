/**
 * Edit tool (spec §9.2, §10).
 *
 * Two modes in v0.1: `replace` (exact string, receipt-bound) and `create`.
 * Delete and rename are deliberately absent — they will arrive with ApplyPatch
 * or a dedicated tool, and inventing a half-version now would mean a second
 * migration later.
 *
 * The plan is computed during `resolve()` so the approval prompt can show the
 * real unified diff. The write happens in `execute()`, and re-verifies the hash
 * first, because an approval prompt takes human seconds during which a formatter
 * or a rebase can land.
 */

import type { JsonSchema } from '../../util/jsonschema.ts';
import { renderErrorForModel } from '../../util/errors.ts';
import { truncateForModel } from '../../util/text.ts';
import {
  ExactEditEngine,
  EditConflictError,
  type EditPlan,
  type EditProposal,
} from '../../edit/edit-engine.ts';
import { summarizeDiff } from '../../edit/diff.ts';
import type { EditJournal } from '../../edit/atomic-write.ts';
import {
  errorResult,
  okResult,
  refusedExecution,
  type ToolDefinition,
  type ToolExecution,
  type ToolResolveContext,
} from '../contract.ts';

export type EditArgs =
  | {
      mode: 'replace';
      path: string;
      oldString: string;
      newString: string;
      receiptId: string;
      replaceAll?: boolean;
    }
  | { mode: 'create'; path: string; content: string };

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['replace', 'create'],
      description: 'replace an exact string, or create a new file',
    },
    path: { type: 'string', description: 'File to edit or create.', minLength: 1 },
    oldString: {
      type: 'string',
      description:
        'replace mode: the exact text to replace, copied verbatim from a Read result WITHOUT the ' +
        'line-number prefixes. Must match exactly once unless replaceAll is true.',
    },
    newString: { type: 'string', description: 'replace mode: the replacement text.' },
    receiptId: {
      type: 'string',
      description: 'replace mode: the receiptId from the Read that showed you this region.',
    },
    replaceAll: {
      type: 'boolean',
      description: 'replace mode: replace every occurrence instead of requiring a unique match.',
    },
    content: { type: 'string', description: 'create mode: full contents of the new file.' },
  },
  required: ['mode', 'path'],
  additionalProperties: false,
};

export interface EditToolOptions {
  journal: EditJournal;
  /** Called after a successful write so the session can append the event. */
  onApplied?: (plan: EditPlan, bytesWritten: number) => void;
}

export function createEditTool(opts: EditToolOptions): ToolDefinition<EditArgs> {
  const engine = new ExactEditEngine();

  return {
    name: 'Edit',
    description:
      'Modify a file by exact string replacement, or create a new file. ' +
      'For mode "replace" you must first Read the file and pass the receiptId from that result: ' +
      'edits against stale or unread content are rejected. oldString must match the file byte for ' +
      'byte (excluding the line-number prefixes Read adds) and must be unique unless replaceAll is set. ' +
      "The file's existing line endings are preserved.",
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: false,

    async resolve(args: EditArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const { path: canonical, existed } = await ctx.canonicalize(args.path);
      const displayPath = ctx.display(canonical);

      const baseSubject = {
        key: `Edit:${canonical}`,
        title: `${args.mode === 'create' ? 'Create' : 'Modify'} ${displayPath}`,
        details: [`file: ${displayPath}`],
        risk: 'medium' as const,
      };
      const baseDisplay = { title: 'Edit file', summary: displayPath };

      // Argument shape is validated by the registry against SCHEMA, but the
      // per-mode requirements are conditional and checked here.
      if (args.mode === 'replace') {
        if (typeof args.oldString !== 'string' || args.oldString === '') {
          return refusedExecution(
            baseSubject,
            baseDisplay,
            errorResult('TOOL_INVALID_ARGS', 'mode "replace" requires a non-empty oldString.'),
          );
        }
        if (typeof args.newString !== 'string') {
          return refusedExecution(
            baseSubject,
            baseDisplay,
            errorResult('TOOL_INVALID_ARGS', 'mode "replace" requires newString.'),
          );
        }
        if (typeof args.receiptId !== 'string' || args.receiptId === '') {
          return refusedExecution(
            baseSubject,
            baseDisplay,
            errorResult(
              'TOOL_INVALID_ARGS',
              'mode "replace" requires the receiptId from the Read that showed you this file.',
            ),
          );
        }
        if (/^\s*\d+\t/m.test(args.oldString)) {
          return refusedExecution(
            baseSubject,
            baseDisplay,
            errorResult(
              'TOOL_INVALID_ARGS',
              "oldString contains Read's line-number prefixes. Strip them and pass only the file text.",
            ),
          );
        }
      } else if (typeof args.content !== 'string') {
        return refusedExecution(
          baseSubject,
          baseDisplay,
          errorResult('TOOL_INVALID_ARGS', 'mode "create" requires content.'),
        );
      }

      if (args.mode === 'create' && existed) {
        return refusedExecution(
          baseSubject,
          baseDisplay,
          errorResult(
            'TOOL_INVALID_ARGS',
            `${displayPath} already exists. Read it and use mode "replace" instead.`,
          ),
        );
      }

      const proposal: EditProposal =
        args.mode === 'create'
          ? { mode: 'create', path: canonical, displayPath, content: args.content }
          : {
              mode: 'replace',
              path: canonical,
              displayPath,
              oldString: args.oldString,
              newString: args.newString,
              receiptId: args.receiptId,
              replaceAll: args.replaceAll ?? false,
            };

      return {
        accesses: [
          {
            kind: 'file.write',
            path: canonical,
            create: args.mode === 'create',
            display: displayPath,
            estimatedBytes:
              args.mode === 'create'
                ? Buffer.byteLength(args.content, 'utf8')
                : Buffer.byteLength(args.newString, 'utf8'),
          },
          // Replacing requires reading the current bytes; that read stays inside
          // the kernel (hashing, diffing), so it is not a to-model read.
          ...(args.mode === 'replace'
            ? ([
                { kind: 'file.read' as const, path: canonical, toModel: false, display: displayPath },
              ] as const)
            : []),
        ],
        approvalSubject: baseSubject,
        display: baseDisplay,

        async execute(executor, signal) {
          if (signal.aborted) return errorResult('CANCELLED', 'Edit was cancelled.');

          const editCtx = {
            freshness: ctx.freshness,
            toolCallId: ctx.toolCallId,
            turnId: ctx.turnId,
            stepId: ctx.stepId,
            now: ctx.now,
          };

          const planned = await engine.plan(proposal, editCtx, executor);
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
            opts.onApplied?.(plan, result.bytesWritten);

            const diffPreview = truncateForModel(plan.diff, { maxBytes: 8 * 1024, maxLines: 160 });

            return okResult(
              `${plan.kind === 'create' ? 'Created' : 'Updated'} ${plan.displayPath} — ` +
                `${summarizeDiff(plan.stats)}.\n\n${diffPreview.text}`,
              {
                structured: {
                  path: plan.displayPath,
                  kind: plan.kind,
                  linesAdded: plan.stats.linesAdded,
                  linesRemoved: plan.stats.linesRemoved,
                  replacements: plan.replacements,
                  eol: plan.eol,
                },
                metadata: {
                  path: plan.displayPath,
                  oldHash: plan.oldHash,
                  newHash: plan.newHash,
                  diff: plan.diff,
                  linesAdded: plan.stats.linesAdded,
                  linesRemoved: plan.stats.linesRemoved,
                  eol: plan.eol,
                  created: plan.kind === 'create',
                  bytesWritten: result.bytesWritten,
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
