/**
 * GitDiff tool (spec §9.2).
 *
 * Strictly read-only. It runs `git status` and `git diff` and nothing else — no
 * `add`, no `commit`, no `push`, and no flag that could reach one. The argv is
 * constructed here from a small typed argument set rather than accepted from the
 * model, so there is no string for a `--upload-pack=...`-style trick to hide in.
 *
 * Committing is a separate capability (`vcs.mutate`) that this tool never
 * requests.
 */

import type { JsonSchema } from '../../util/jsonschema.ts';
import { truncateForModel } from '../../util/text.ts';
import type { CanonicalPath } from '../../util/paths.ts';
import {
  errorResult,
  okResult,
  refusedExecution,
  type ToolDefinition,
  type ToolExecution,
  type ToolResolveContext,
} from '../contract.ts';

export interface GitDiffArgs {
  staged?: boolean;
  path?: string;
  statOnly?: boolean;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    staged: {
      type: 'boolean',
      description: 'Show staged changes (git diff --cached) instead of unstaged ones.',
    },
    path: { type: 'string', description: 'Limit the diff to this path.' },
    statOnly: { type: 'boolean', description: 'Return a summary (--stat) rather than full hunks.' },
  },
  additionalProperties: false,
};

export function createGitDiffTool(): ToolDefinition<GitDiffArgs> {
  return {
    name: 'GitDiff',
    description:
      'Show the current uncommitted changes in the workspace, with a short status summary. ' +
      'Read-only: it never stages, commits or pushes anything.',
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: true,

    async resolve(args: GitDiffArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const subject = {
        key: 'GitDiff:workspace',
        title: 'Inspect uncommitted changes',
        details: [
          `workspace: ${ctx.display(ctx.workspaceRoot)}`,
          args.staged ? 'staged changes' : 'working tree',
        ],
        risk: 'low' as const,
      };
      const display = { title: 'Git diff', summary: args.staged ? 'staged changes' : 'working tree changes' };

      if (!ctx.environment.hasGit) {
        return refusedExecution(
          subject,
          display,
          errorResult('TOOL_FAILED', 'git is not available on this execution backend.'),
        );
      }

      // Build argv from typed fields only. Nothing here is model-controlled
      // except a path, which is canonicalised and confined below.
      const diffArgv = ['git', 'diff', '--no-color', '--no-ext-diff'];
      if (args.staged) diffArgv.push('--cached');
      if (args.statOnly) diffArgv.push('--stat');

      let limitPath: CanonicalPath | undefined;
      if (args.path) {
        const resolved = await ctx.canonicalize(args.path);
        limitPath = resolved.path;
        diffArgv.push('--', resolved.path);
      }

      return {
        accesses: [
          {
            kind: 'process.exec',
            executable: 'git',
            argv: diffArgv,
            cwd: ctx.workspaceRoot,
            display: diffArgv.slice(0, 3).join(' '),
          },
          {
            kind: 'file.read',
            path: limitPath ?? ctx.workspaceRoot,
            toModel: true,
            display: ctx.display(limitPath ?? ctx.workspaceRoot),
          },
        ],
        approvalSubject: subject,
        display,

        async execute(executor, signal) {
          const status = await executor.exec(
            {
              argv: ['git', 'status', '--porcelain=v1', '--untracked-files=normal'],
              cwd: ctx.workspaceRoot,
              timeoutMs: 20_000,
            },
            signal,
          );

          if (status.exitCode !== 0) {
            const detail = status.stderr.trim() || 'git status failed';
            return errorResult(
              'TOOL_FAILED',
              /not a git repository/i.test(detail)
                ? 'This workspace is not a git repository, so there is no diff to show.'
                : detail,
            );
          }

          const diff = await executor.exec(
            { argv: diffArgv, cwd: ctx.workspaceRoot, timeoutMs: 30_000 },
            signal,
          );

          if (diff.exitCode !== 0 && diff.exitCode !== 1) {
            return errorResult('TOOL_FAILED', diff.stderr.trim() || 'git diff failed');
          }

          const statusLines = status.stdout.split('\n').filter((l) => l.trim() !== '');
          const summary =
            statusLines.length === 0
              ? 'Working tree is clean.'
              : `${statusLines.length} changed path(s):\n${statusLines.map((l) => `  ${l}`).join('\n')}`;

          const body = diff.stdout.trim();
          if (body === '') {
            return okResult(`${summary}\n\n(no ${args.staged ? 'staged' : 'unstaged'} textual changes)`, {
              structured: { changedPaths: statusLines.length, diff: '' },
            });
          }

          const budgeted = truncateForModel(body, { maxBytes: 64 * 1024, maxLines: 1500 });

          return okResult(`${summary}\n\n${budgeted.text}`, {
            structured: { changedPaths: statusLines.length, truncated: budgeted.truncated },
            metadata: { changedPaths: statusLines.length, diffBytes: budgeted.originalBytes },
            ...(budgeted.truncated ? { fullOutput: body } : {}),
          });
        },
      };
    },
  };
}
