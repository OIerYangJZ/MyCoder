/**
 * Undo tool (ADR-0026).
 *
 * The kernel's first capability that makes a mistake **cheap** rather than
 * preventable. Five milestones answered "can the kernel stop something bad from
 * happening?"; this answers the other one.
 *
 * Three properties, and each is a decision rather than an implementation detail:
 *
 *   - **Undo is an edit.** It declares `file.write` per path and `file.delete`
 *     where a reversal removes a file, the policy engine rules on it, protected
 *     paths apply, and it is itself journalled — so undoing an undo works by the
 *     ordinary mechanism (§5).
 *   - **All or nothing.** Planning runs to completion before anything is
 *     written; one refusal cancels the set (§3).
 *   - **It always says what it did not cover.** Every result ends with an
 *     enumeration derived from the session's own state (§4). That is not a
 *     courtesy — a model told "undone" that then reasons about a workspace state
 *     which does not exist will produce a wrong plan confidently.
 *
 * The loop guard (§6): a reversal is journalled with `undoOf` set, and the
 * model-facing tool skips entries that have it. `Edit → Undo → Undo` reverses
 * one edit and then reports that there is nothing further to undo, instead of
 * oscillating a file forever at one tool call per step. The model is also capped
 * at the current turn: reversing work from three turns ago is a decision, and a
 * decision belongs to the person.
 */

import type { JsonSchema } from '../../util/jsonschema.ts';
import { newJournalEntryId } from '../../util/ids.ts';
import type { CanonicalPath } from '../../util/paths.ts';
import type { AccessRequest } from '../../policy/access.ts';
import type { ProtectedPaths } from '../../policy/protected-paths.ts';
import type { EditJournal, RollbackMetadata } from '../../edit/atomic-write.ts';
import type { UncoveredTracker } from '../../edit/uncovered.ts';
import { unifiedDiff } from '../../edit/diff.ts';
import { toLf } from '../../util/text.ts';
import { applyUndo, planUndo, reversalEntry, type UndoPlan, type UndoStep } from '../../edit/undo-engine.ts';
import {
  errorResult,
  okResult,
  refusedExecution,
  type ToolDefinition,
  type ToolExecution,
  type ToolResolveContext,
} from '../contract.ts';

export interface UndoArgs {
  /** How many of the most recent reversible edits to undo. Defaults to 1. */
  count?: number;
  /** Restrict to one file. */
  path?: string;
  /** Reverse everything the current turn did. */
  scope?: 'last' | 'turn' | 'path';
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['last', 'turn', 'path'],
      description:
        '"last" (default) undoes the most recent edits, "turn" undoes everything you changed in ' +
        'this turn, "path" undoes the edits to one file.',
    },
    count: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'How many recent edits to reverse. Only meaningful with scope "last".',
    },
    path: { type: 'string', description: 'The file to revert. Required with scope "path".' },
  },
  required: [],
  additionalProperties: false,
};

export interface UndoToolOptions {
  journal: EditJournal;
  protectedPaths: ProtectedPaths;
  uncovered: UncoveredTracker;
  /** Called after a reversal is applied, so the session can record the fact. */
  onApplied?: (reverted: string[]) => void;
}

/**
 * Which entries a request selects, newest first.
 *
 * Never returns an entry that is itself a reversal: that is the loop guard, and
 * it lives here rather than in the engine so `/undo` can choose differently for
 * a human who asked twice and meant it.
 */
export function selectEntries(
  journal: EditJournal,
  request: {
    scope: 'last' | 'turn' | 'path';
    count: number;
    path?: CanonicalPath;
    turnId?: string;
    /** A person, through the control plane, rather than the model. */
    operator?: boolean;
  },
): RollbackMetadata[] {
  const operator = request.operator === true;
  // `pending()` already excludes entries that have been reversed. For an
  // operator we widen it to include reversals themselves, which is what makes
  // `/undo` able to put back an undo the model performed.
  const candidates = operator
    ? journal
        .all()
        .filter((e) => !journal.isUndone(e.entryId))
        .reverse()
    : journal.pending().filter((e) => e.turnId === request.turnId);

  if (request.scope === 'turn') {
    return candidates.filter((e) => e.turnId === request.turnId);
  }
  if (request.scope === 'path') {
    return candidates.filter((e) => e.path === request.path);
  }
  return candidates.slice(0, request.count);
}

export function createUndoTool(opts: UndoToolOptions): ToolDefinition<UndoArgs> {
  return {
    name: 'Undo',
    description:
      'Reverse edits you made earlier in this turn, restoring the exact previous content. Use it when ' +
      'an edit went to the wrong file or lost something, not as a way out of an error message — read ' +
      'the error first. It refuses rather than guessing when a file has changed since, and it reverses ' +
      'either all of the selected edits or none of them. It cannot reverse shell commands or anything ' +
      'done by a tool MyCoder did not write.',
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: false,

    async resolve(args: UndoArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const scope = args.scope ?? (args.path !== undefined ? 'path' : 'last');
      let targetPath: CanonicalPath | undefined;
      if (scope === 'path') {
        if (args.path === undefined) {
          return refusedExecution(
            { key: 'Undo', title: 'Undo', details: [], risk: 'medium' },
            { title: 'Undo', summary: 'no path given' },
            errorResult('TOOL_INVALID_ARGS', 'scope "path" needs a path.'),
          );
        }
        targetPath = (await ctx.canonicalize(args.path)).path;
      }

      // §6, and the only place the two callers differ.
      //
      // The model may reverse only the current turn's work, and never a
      // reversal — that is the loop guard, and without it `Edit → Undo → Undo`
      // oscillates a file forever at one tool call per step. A person typing
      // `/undo` may do both: reaching past this turn is a decision, and a human
      // asking twice means what they said.
      const operator = ctx.operator === true;
      const selected = selectEntries(opts.journal, {
        scope,
        count: args.count ?? 1,
        ...(targetPath ? { path: targetPath } : {}),
        turnId: ctx.turnId,
        operator,
      });

      const subject = {
        key: 'Undo',
        title: `Undo ${selected.length} edit(s)`,
        details:
          selected.length === 0 ? ['nothing to undo'] : selected.map((e) => `${e.kind} ${e.displayPath}`),
        risk: 'medium' as const,
      };
      const display = {
        title: 'Undo edits',
        summary: selected.length === 0 ? 'nothing to undo' : selected.map((e) => e.displayPath).join(', '),
      };

      if (selected.length === 0) {
        return refusedExecution(
          subject,
          display,
          okResult(
            (operator
              ? 'There is nothing to undo: this session has no reversible edit left.'
              : 'There is nothing to undo: no edit made in this turn is still reversible.') +
              '\n\n' +
              opts.uncovered.render(opts.journal),
          ),
        );
      }

      // Declared for every *candidate*, not for what the plan ends up doing:
      // planning has to read each file to verify it, and the policy engine must
      // have ruled on the whole set before a single byte is written.
      const accesses: AccessRequest[] = [];
      for (const entry of selected) {
        accesses.push({
          kind: 'file.read',
          path: entry.path,
          toModel: false,
          display: entry.displayPath,
        });
        if (entry.kind === 'create') {
          accesses.push({ kind: 'file.delete', path: entry.path, display: entry.displayPath });
        } else {
          accesses.push({ kind: 'file.write', path: entry.path, create: true, display: entry.displayPath });
        }
        if (entry.kind === 'move' && entry.movedFromPath) {
          accesses.push({
            kind: 'file.write',
            path: entry.movedFromPath,
            create: true,
            display: entry.movedFrom ?? entry.movedFromPath,
          });
          accesses.push({
            kind: 'file.delete',
            path: entry.path,
            display: entry.displayPath,
            movedTo: entry.movedFrom ?? entry.movedFromPath,
          });
        }
      }

      return {
        accesses,
        approvalSubject: subject,
        display,

        async execute(executor, signal) {
          if (signal.aborted) return errorResult('CANCELLED', 'Undo was cancelled.');

          const undoCtx = {
            freshness: ctx.freshness,
            checkWritable: (p: CanonicalPath): string | undefined => {
              const verdict = opts.protectedPaths.checkWrite(p);
              if (!verdict.protected) return undefined;
              return (
                `${ctx.display(p)} is now a protected path (${verdict.reason ?? 'protected'}), so it ` +
                'cannot be written — even to put back what was there before.'
              );
            },
          };

          const plan = await planUndo(selected, undoCtx, executor, opts.journal);

          // §3. One refusal cancels the set. Reversing part of a set produces a
          // state that never existed; refusing produces one that did.
          if (plan.refusals.length > 0) {
            return errorResult('TOOL_FAILED', renderRefusal(plan, opts));
          }

          // Capture the pre-reversal content so the reversal's own journal entry
          // has a real diff — which is what makes undoing an undo ordinary.
          const priors = new Map<string, string>();
          for (const step of plan.steps) {
            if (step.action.kind === 'write') {
              const stat = await executor.fs.stat(step.action.path);
              priors.set(
                step.action.path,
                stat ? (await executor.fs.readFile(step.action.path)).toString('utf8') : '',
              );
            } else if (step.action.kind === 'remove') {
              priors.set(step.action.path, (await executor.fs.readFile(step.action.path)).toString('utf8'));
            }
          }

          const applied = await applyUndo(plan.steps, undoCtx, executor);

          const reversals: RollbackMetadata[] = [];
          for (const step of applied.written) {
            const prior = priors.get(step.action.path) ?? '';
            const restored = step.action.kind === 'write' ? step.action.content : '';
            reversals.push(
              reversalEntry(
                step,
                {
                  entryId: newJournalEntryId(ctx.now()),
                  toolCallId: ctx.toolCallId,
                  turnId: ctx.turnId,
                  stepId: ctx.stepId,
                  now: ctx.now(),
                },
                prior,
                restored,
                unifiedDiff(toLf(prior), toLf(restored), {
                  oldLabel: `a/${step.action.displayPath}`,
                  newLabel: `b/${step.action.displayPath}`,
                }).text,
              ),
            );
          }
          // Journalled *and* logged. An undo is an edit, so it reaches the audit
          // trail by the same route the four mutating tools do — which is also
          // what makes undoing an undo work by the ordinary mechanism (§5).
          for (const entry of reversals) opts.journal.record(entry);

          const reverted = applied.written.map((s) => s.action.displayPath);
          opts.onApplied?.(reverted);

          if (applied.partialFailure) {
            // Not preventable, only reportable — and reported, which is what the
            // Silent Partial Stop actually forbids.
            return errorResult(
              'TOOL_FAILED',
              `The undo failed part-way through, after writing ${applied.written.length} of ` +
                `${plan.steps.length} file(s). Written: ${reverted.join(', ') || 'none'}. ` +
                `Failed on ${applied.partialFailure.step.action.displayPath}: ` +
                `${applied.partialFailure.error}. The workspace is in a mixed state; check these ` +
                'files before continuing.\n\n' +
                opts.uncovered.render(opts.journal),
              // The reversals that *did* land are still mutations, and a
              // partial failure is precisely when the audit trail matters most.
              { metadata: { partial: true, written: reverted, journal: reversals } },
            );
          }

          const body = [
            `Reversed ${applied.written.length} edit(s):`,
            ...applied.written.map((s) => `  ${s.summary}`),
            '',
            'Read these files again before editing them: the receipts you had describe content that ' +
              'is no longer there.',
            '',
            opts.uncovered.render(opts.journal),
          ].join('\n');

          return okResult(body, {
            structured: { reverted, count: applied.written.length },
            metadata: { reverted, count: applied.written.length, undo: true, journal: reversals },
          });
        },
      };
    },
  };
}

/**
 * The refusal message.
 *
 * Names the path and the reason for every entry that could not be reversed, and
 * says plainly that nothing was written — a user who reads "refused" and assumes
 * a partial application has been given the uncertainty this milestone exists to
 * remove.
 */
export function renderRefusal(
  plan: UndoPlan,
  opts: { uncovered: UncoveredTracker; journal: EditJournal },
): string {
  const lines = [
    `Nothing was reversed. ${plan.refusals.length} of ${plan.refusals.length + plan.steps.length} ` +
      'selected edit(s) cannot be undone, and an undo never applies to part of a set:',
    ...plan.refusals.map((r) => `  ${r.displayPath} — ${r.reason} [${r.code}]`),
  ];
  if (plan.steps.length > 0) {
    lines.push(
      '',
      `The other ${plan.steps.length} edit(s) could have been reversed. Undo them individually if ` +
        'that is what you want:',
      ...plan.steps.map((s: UndoStep) => `  ${s.summary}`),
    );
  }
  lines.push('', opts.uncovered.render(opts.journal));
  return lines.join('\n');
}
