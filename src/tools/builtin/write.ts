/**
 * Write tool (ADR-0016).
 *
 * Whole-file content, for the two cases `Edit` cannot express well: a file that
 * does not exist yet, and a file whose new contents are easier to state than to
 * derive from a chain of exact replaces.
 *
 * The safety property is the receipt, and it is stricter here than for `Edit`.
 * An exact replace can only damage text the model quoted back; an overwrite
 * destroys the whole file, including the part it never read. So overwriting
 * requires a receipt with **full** coverage (`FreshnessLedger.checkWhole`), and
 * creating requires nothing — there is no content to lose.
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

export interface WriteArgs {
  path: string;
  content: string;
  receiptId?: string;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'File to write. Relative paths resolve against the workspace root.',
      minLength: 1,
    },
    content: { type: 'string', description: 'The complete new contents of the file.' },
    receiptId: {
      type: 'string',
      description:
        'Required when the file already exists: the receiptId from a Read that covered the WHOLE file. ' +
        'Omit it only when creating a new file.',
    },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

export interface WriteToolOptions {
  journal: EditJournal;
  /** Called after a successful write so the session can append the event. */
  onApplied?: (plan: EditPlan, bytesWritten: number) => void;
}

export function createWriteTool(opts: WriteToolOptions): ToolDefinition<WriteArgs> {
  const engine = new ExactEditEngine();

  return {
    name: 'Write',
    description:
      'Create a file, or replace an existing one with new contents in full. ' +
      'To overwrite, you must first Read the whole file and pass that receiptId: a partial read is not ' +
      'enough, because an overwrite also destroys the part you did not see. ' +
      'Prefer Edit for changing part of a file — it is cheaper and its failures are safer.',
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: false,

    async resolve(args: WriteArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const { path: canonical, existed } = await ctx.canonicalize(args.path);
      const displayPath = ctx.display(canonical);

      const subject = {
        key: `Write:${canonical}`,
        title: `${existed ? 'Overwrite' : 'Create'} ${displayPath}`,
        details: [
          `file: ${displayPath}`,
          existed ? 'the current contents are replaced in full' : 'a new file',
        ],
        risk: existed ? ('high' as const) : ('medium' as const),
      };
      const display = { title: existed ? 'Overwrite file' : 'Create file', summary: displayPath };

      if (existed && (typeof args.receiptId !== 'string' || args.receiptId === '')) {
        return refusedExecution(
          subject,
          display,
          errorResult(
            'TOOL_INVALID_ARGS',
            `${displayPath} already exists. Read it in full and pass that receiptId to overwrite it, ` +
              'or use Edit to change part of it.',
          ),
        );
      }

      const proposal: EditProposal = existed
        ? {
            mode: 'overwrite',
            path: canonical,
            displayPath,
            content: args.content,
            receiptId: args.receiptId!,
          }
        : { mode: 'create', path: canonical, displayPath, content: args.content };

      return {
        accesses: [
          {
            kind: 'file.write',
            path: canonical,
            create: !existed,
            display: displayPath,
            estimatedBytes: Buffer.byteLength(args.content, 'utf8'),
          },
          // Overwriting reads the current bytes to hash and diff them. That read
          // stays inside the kernel, so it is not a to-model read.
          ...(existed
            ? ([
                { kind: 'file.read' as const, path: canonical, toModel: false, display: displayPath },
              ] as const)
            : []),
        ],
        approvalSubject: subject,
        display,

        async execute(executor, signal) {
          if (signal.aborted) return errorResult('CANCELLED', 'Write was cancelled.');

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
              `${plan.kind === 'create' ? 'Created' : 'Rewrote'} ${plan.displayPath} — ` +
                `${summarizeDiff(plan.stats)}.\n\n${diffPreview.text}`,
              {
                structured: {
                  path: plan.displayPath,
                  kind: plan.kind,
                  linesAdded: plan.stats.linesAdded,
                  linesRemoved: plan.stats.linesRemoved,
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
                  // CLOSURE B (ADR-0025 §1). Until alpha.10 this tool's writes
                  // reached the workspace and never the event log.
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
