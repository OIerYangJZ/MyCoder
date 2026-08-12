/**
 * Glob tool (spec §9.2).
 *
 * File discovery by pattern. Results are workspace-relative, sorted by
 * modification time (most recently touched first), and budgeted — an
 * unbudgeted `**\/*` on a monorepo is one of the classic ways to burn a context
 * window on nothing.
 *
 * Discovery declares a `file.read` access with `toModel: false`: the *names*
 * reach the model, not the contents. Filenames inside protected directories are
 * filtered out anyway, so a listing cannot be used to enumerate `~/.ssh`.
 */

import * as path from 'node:path';

import type { JsonSchema } from '../../util/jsonschema.ts';
import { compileGlob } from '../../util/glob.ts';
import { isWithin, toPosix } from '../../util/paths.ts';
import { walkFiles } from '../../util/walk.ts';
import {
  errorResult,
  okResult,
  refusedExecution,
  type ToolDefinition,
  type ToolExecution,
  type ToolResolveContext,
} from '../contract.ts';

export interface GlobArgs {
  pattern: string;
  path?: string;
  maxResults?: number;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'Glob pattern, e.g. "src/**/*.ts" or "**/*.test.ts". Matched against workspace-relative paths.',
      minLength: 1,
    },
    path: {
      type: 'string',
      description: 'Directory to search under. Defaults to the workspace root.',
    },
    maxResults: {
      type: 'integer',
      description: 'Maximum number of paths to return. Defaults to 200.',
      minimum: 1,
      maximum: 2000,
    },
  },
  required: ['pattern'],
  additionalProperties: false,
};

const DEFAULT_MAX_RESULTS = 200;

export function createGlobTool(): ToolDefinition<GlobArgs> {
  return {
    name: 'Glob',
    description:
      'Find files by glob pattern. Returns workspace-relative paths, most recently modified first. ' +
      'Use this to locate files before reading them.',
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: true,

    async resolve(args: GlobArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const searchRoot = args.path ? (await ctx.canonicalize(args.path)).path : ctx.workspaceRoot;
      const display = ctx.display(searchRoot);

      const subject = {
        key: `Glob:${searchRoot}`,
        title: `List files under ${display}`,
        details: [`pattern: ${args.pattern}`, `root: ${display}`],
        risk: 'low' as const,
      };
      const reviewDisplay = { title: 'Find files', summary: `${args.pattern} under ${display}` };

      if (!isWithin(ctx.workspaceRoot, searchRoot)) {
        // Searching outside the workspace is a separate, asked-for capability;
        // the access below carries it to the policy engine rather than being
        // silently allowed here.
        ctx.logger.debug('glob outside workspace', { root: display });
      }

      let matcher: RegExp;
      try {
        matcher = compileGlob(normalisePattern(args.pattern), {
          caseInsensitive: process.platform !== 'linux',
        });
      } catch {
        return refusedExecution(
          subject,
          reviewDisplay,
          errorResult('TOOL_INVALID_ARGS', `"${args.pattern}" is not a valid glob pattern.`),
        );
      }

      const maxResults = args.maxResults ?? DEFAULT_MAX_RESULTS;

      return {
        accesses: [
          {
            kind: 'file.read',
            path: searchRoot,
            // Only names cross the boundary here, not file contents.
            toModel: false,
            display,
          },
        ],
        approvalSubject: subject,
        display: reviewDisplay,

        async execute(executor, signal) {
          const stat = await executor.fs.stat(searchRoot);
          if (!stat?.isDirectory) {
            return errorResult('TOOL_INVALID_ARGS', `${display} is not a directory.`);
          }

          const matches: Array<{ rel: string; mtimeMs: number }> = [];
          let visited = 0;

          for await (const entry of walkFiles({
            root: searchRoot,
            maxResults: 50_000,
            useGitignore: true,
            ...(signal ? { signal } : {}),
          })) {
            visited += 1;
            if (!matcher.test(entry.relative)) continue;
            matches.push({ rel: entry.relative, mtimeMs: entry.mtimeMs });
            if (matches.length >= maxResults * 4) break;
          }

          matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
          const shown = matches.slice(0, maxResults);

          if (shown.length === 0) {
            return okResult(
              `No files matched "${args.pattern}" under ${display} (${visited} files scanned).`,
              { structured: { matches: [], scanned: visited } },
            );
          }

          const prefix = searchRoot === ctx.workspaceRoot ? '' : `${ctx.display(searchRoot)}/`;
          const lines = shown.map((m) => prefix + m.rel);
          const footer =
            matches.length > shown.length
              ? `\n\n[${matches.length - shown.length} more matches were not shown. Narrow the pattern or raise maxResults.]`
              : '';

          return okResult(
            `${shown.length} file(s) matching "${args.pattern}":\n\n${lines.join('\n')}${footer}`,
            {
              structured: { matches: lines, truncated: matches.length > shown.length, scanned: visited },
              metadata: { matched: matches.length, returned: shown.length, scanned: visited },
            },
          );
        },
      };
    },
  };
}

/**
 * Accept the shapes people actually type.
 *
 * `*.ts` means "anywhere" to most users, so it is expanded to `**\/*.ts`; a
 * pattern that already anchors itself is left alone.
 */
function normalisePattern(pattern: string): string {
  const p = toPosix(pattern).replace(/^\.\//, '');
  if (path.isAbsolute(p)) return p;
  if (p.includes('/')) return p;
  return `**/${p}`;
}

/** Exposed for the repository plane, which needs the same matching semantics. */
export function matchWorkspacePattern(pattern: string, relativePath: string): boolean {
  return compileGlob(normalisePattern(pattern)).test(relativePath);
}
