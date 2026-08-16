/**
 * Move tool (ADR-0016).
 *
 * A rename, and only a rename: one `rename(2)`-shaped operation that either
 * happens or does not. No copy-then-delete fallback, because a copy that fails
 * halfway leaves two files and the model cannot tell which one is authoritative.
 *
 * The destination is checked twice — once in `resolve()`, so the approval prompt
 * is truthful, and once in the backend, which refuses to clobber. Between those
 * two checks sits a human deciding, and the whole reason the backend does not use
 * bare `rename(2)` is that the file could appear during exactly that window
 * (`FileSystemBackend.rename`).
 *
 * No receipt is required. A move changes no content, so there is nothing the
 * model could be destroying unseen; what it *does* invalidate is every receipt
 * naming either path, and both are dropped here.
 */

import type { JsonSchema } from '../../util/jsonschema.ts';
import { toPosix } from '../../util/paths.ts';
import type { AccessRequest } from '../../policy/access.ts';
import type { EditJournal } from '../../edit/atomic-write.ts';
import { sha256Hex } from '../../util/ids.ts';
import {
  errorResult,
  okResult,
  refusedExecution,
  type ToolDefinition,
  type ToolExecution,
  type ToolResolveContext,
} from '../contract.ts';

export interface MoveArgs {
  from: string;
  to: string;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'Existing file or directory to move.', minLength: 1 },
    to: {
      type: 'string',
      description: 'New path. Must not already exist; parent directories must exist.',
      minLength: 1,
    },
  },
  required: ['from', 'to'],
  additionalProperties: false,
};

export interface MoveToolOptions {
  journal: EditJournal;
  onApplied?: (record: { from: string; to: string }) => void;
}

function isGitInternal(canonical: string, workspaceRoot: string): boolean {
  const p = toPosix(canonical);
  const root = toPosix(workspaceRoot);
  return p === `${root}/.git` || p.startsWith(`${root}/.git/`) || p.includes('/.git/');
}

export function createMoveTool(opts: MoveToolOptions): ToolDefinition<MoveArgs> {
  return {
    name: 'Move',
    description:
      'Rename or move a file or directory. The destination must not already exist — this tool never ' +
      'overwrites. Content is unchanged, but any receiptId for either path stops being valid, so re-read ' +
      'before editing the moved file.',
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: false,

    async resolve(args: MoveArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const from = await ctx.canonicalize(args.from);
      const to = await ctx.canonicalize(args.to);
      const fromDisplay = ctx.display(from.path);
      const toDisplay = ctx.display(to.path);

      const subject = {
        key: `Move:${from.path}->${to.path}`,
        title: `Move ${fromDisplay} to ${toDisplay}`,
        details: [`from: ${fromDisplay}`, `to: ${toDisplay}`],
        risk: 'medium' as const,
      };
      const display = { title: 'Move file', summary: `${fromDisplay} → ${toDisplay}` };

      if (!from.existed) {
        return refusedExecution(
          subject,
          display,
          errorResult('TOOL_FAILED', `No such file or directory: ${fromDisplay}`),
        );
      }
      if (to.existed) {
        return refusedExecution(
          subject,
          display,
          errorResult(
            'TOOL_INVALID_ARGS',
            `${toDisplay} already exists. Move never overwrites: choose another destination, or delete ` +
              'the existing file first.',
          ),
        );
      }
      if (from.path === to.path) {
        return refusedExecution(
          subject,
          display,
          errorResult('TOOL_INVALID_ARGS', 'The source and destination are the same path.'),
        );
      }
      if (from.path === ctx.workspaceRoot || to.path === ctx.workspaceRoot) {
        return refusedExecution(
          subject,
          display,
          errorResult('TOOL_INVALID_ARGS', 'The workspace root cannot be moved.'),
        );
      }
      if (isGitInternal(from.path, ctx.workspaceRoot) || isGitInternal(to.path, ctx.workspaceRoot)) {
        return refusedExecution(
          subject,
          display,
          errorResult(
            'TOOL_INVALID_ARGS',
            'Paths inside the git database are not moved by hand. Use a git command.',
          ),
        );
      }
      // Moving a directory into itself would relocate the tree under a path that
      // is about to stop existing. `rename(2)` returns EINVAL; saying so here is
      // clearer than surfacing an errno.
      if (toPosix(to.path).startsWith(`${toPosix(from.path)}/`)) {
        return refusedExecution(
          subject,
          display,
          errorResult('TOOL_INVALID_ARGS', 'The destination is inside the source directory.'),
        );
      }

      const accesses: AccessRequest[] = [
        { kind: 'file.delete', path: from.path, display: fromDisplay, movedTo: toDisplay },
        { kind: 'file.write', path: to.path, create: true, display: toDisplay },
      ];

      return {
        accesses,
        approvalSubject: subject,
        display,

        async execute(executor, signal) {
          if (signal.aborted) return errorResult('CANCELLED', 'Move was cancelled.');

          const sourceStat = await executor.fs.stat(from.path);
          if (!sourceStat) return errorResult('TOOL_FAILED', `No such file or directory: ${fromDisplay}`);
          if (await executor.fs.stat(to.path)) {
            return errorResult(
              'TOOL_INVALID_ARGS',
              `${toDisplay} appeared while this move was being approved. Nothing was moved.`,
            );
          }

          await executor.fs.rename(from.path, to.path);

          // A receipt names a path. After a move the old path is gone and the new
          // one describes content nobody has read *at that path*, so both go.
          ctx.freshness.invalidatePath(from.path);
          ctx.freshness.invalidatePath(to.path);

          const kind = sourceStat.isDirectory ? 'directory' : 'file';
          opts.journal.record({
            path: to.path,
            displayPath: toDisplay,
            kind: 'move',
            // A move changes no bytes, so the two hashes are equal by
            // construction: the hash of the *path pair*, which is enough to
            // correlate the journal entry with the event log without reading a
            // file that may be very large.
            oldHash: sha256Hex(`${from.path}\n${to.path}`).slice(0, 32),
            newHash: sha256Hex(`${from.path}\n${to.path}`).slice(0, 32),
            diff: `rename from ${fromDisplay}\nrename to ${toDisplay}\n`,
            eol: 'lf',
            createdFile: false,
            movedFrom: fromDisplay,
            toolCallId: ctx.toolCallId,
            turnId: ctx.turnId,
            stepId: ctx.stepId,
            appliedAt: ctx.now(),
          });
          opts.onApplied?.({ from: fromDisplay, to: toDisplay });

          return okResult(`Moved ${kind} ${fromDisplay} to ${toDisplay}.`, {
            structured: { from: fromDisplay, to: toDisplay, kind },
            metadata: { from: fromDisplay, to: toDisplay, kind },
          });
        },
      };
    },
  };
}
