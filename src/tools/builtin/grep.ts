/**
 * Grep tool (spec §9.2).
 *
 * Prefers `rg` when it is present and process execution was granted, and falls
 * back to an in-kernel scanner otherwise. The fallback is not a nicety: a
 * read-only session, an SSH host without ripgrep, or a denied exec must still be
 * able to search, and a tool that silently stops working under a stricter
 * profile trains people to loosen the profile.
 *
 * Results are token-budgeted by construction — capped matches, capped line
 * length, capped context — because search output is the single easiest way to
 * fill a context window with noise.
 */

import type { JsonSchema } from '../../util/jsonschema.ts';
import { compileGlob } from '../../util/glob.ts';
import { truncateForModel } from '../../util/text.ts';
import { looksBinary, walkFiles } from '../../util/walk.ts';
import type { CanonicalPath } from '../../util/paths.ts';
import { scanSecrets } from '../../security/secret-scanner.ts';
import {
  errorResult,
  okResult,
  refusedExecution,
  type ToolDefinition,
  type ToolExecution,
  type ToolResolveContext,
  type ToolResult,
} from '../contract.ts';

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  contextLines?: number;
  maxResults?: number;
  caseInsensitive?: boolean;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Regular expression to search for.',
      minLength: 1,
      maxLength: 1000,
    },
    path: { type: 'string', description: 'Directory to search. Defaults to the workspace root.' },
    glob: {
      type: 'string',
      description: 'Restrict the search to files matching this glob, e.g. "**/*.ts".',
    },
    contextLines: {
      type: 'integer',
      description: 'Lines of context around each match. Defaults to 0.',
      minimum: 0,
      maximum: 10,
    },
    maxResults: {
      type: 'integer',
      description: 'Maximum matches to return. Defaults to 100.',
      minimum: 1,
      maximum: 1000,
    },
    caseInsensitive: { type: 'boolean', description: 'Case-insensitive search.' },
  },
  required: ['pattern'],
  additionalProperties: false,
};

const DEFAULT_MAX_RESULTS = 100;
const MAX_LINE_LENGTH = 400;
/** Total bytes the in-kernel scanner will read before giving up. */
const SCAN_BYTE_BUDGET = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

interface Match {
  file: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export function createGrepTool(): ToolDefinition<GrepArgs> {
  return {
    name: 'Grep',
    description:
      'Search file contents with a regular expression. Returns matching lines with file and line ' +
      'number. Use `glob` to restrict the file set and `contextLines` for surrounding lines. ' +
      'Search results are capped; narrow the pattern rather than raising the cap.',
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: true,

    async resolve(args: GrepArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const searchRoot = args.path ? (await ctx.canonicalize(args.path)).path : ctx.workspaceRoot;
      const display = ctx.display(searchRoot);

      const subject = {
        key: `Grep:${searchRoot}`,
        title: `Search ${display}`,
        details: [
          `pattern: ${args.pattern}`,
          `root: ${display}`,
          ...(args.glob ? [`files: ${args.glob}`] : []),
        ],
        risk: 'low' as const,
      };
      const reviewDisplay = { title: 'Search files', summary: `/${args.pattern}/ in ${display}` };

      let regex: RegExp;
      try {
        regex = new RegExp(args.pattern, args.caseInsensitive ? 'i' : '');
      } catch (e) {
        return refusedExecution(
          subject,
          reviewDisplay,
          errorResult(
            'TOOL_INVALID_ARGS',
            `"${args.pattern}" is not a valid regular expression: ${e instanceof Error ? e.message : 'parse error'}`,
          ),
        );
      }

      const maxResults = args.maxResults ?? DEFAULT_MAX_RESULTS;
      const contextLines = args.contextLines ?? 0;
      const useRipgrep = ctx.environment.hasRipgrep;

      return {
        accesses: [
          {
            kind: 'file.read',
            path: searchRoot,
            // Matched lines are shown to the model, so this is a to-model read.
            toModel: true,
            display,
          },
          ...(useRipgrep
            ? ([
                {
                  kind: 'process.exec' as const,
                  executable: 'rg',
                  argv: ['rg', '--json', args.pattern],
                  cwd: searchRoot,
                  display: `rg ${args.pattern}`,
                },
              ] as const)
            : []),
        ],
        approvalSubject: subject,
        display: reviewDisplay,

        async execute(executor, signal): Promise<ToolResult> {
          const stat = await executor.fs.stat(searchRoot);
          if (!stat?.isDirectory) {
            return errorResult('TOOL_INVALID_ARGS', `${display} is not a directory.`);
          }

          let matches: Match[];
          let engine: 'ripgrep' | 'kernel';
          let truncatedByEngine = false;

          if (useRipgrep && executor.profile.allowExec) {
            const rg = await runRipgrep(executor, searchRoot, args, maxResults, contextLines, signal);
            if (rg) {
              matches = rg.matches;
              truncatedByEngine = rg.truncated;
              engine = 'ripgrep';
            } else {
              // rg was unavailable at runtime after all; degrade rather than fail.
              const scan = await scanInKernel(
                executor,
                searchRoot,
                regex,
                args,
                maxResults,
                contextLines,
                signal,
              );
              matches = scan.matches;
              truncatedByEngine = scan.truncated;
              engine = 'kernel';
            }
          } else {
            const scan = await scanInKernel(
              executor,
              searchRoot,
              regex,
              args,
              maxResults,
              contextLines,
              signal,
            );
            matches = scan.matches;
            truncatedByEngine = scan.truncated;
            engine = 'kernel';
          }

          if (matches.length === 0) {
            return okResult(`No matches for /${args.pattern}/ under ${display}.`, {
              structured: { matches: [], engine },
            });
          }

          const rendered = renderMatches(matches, contextLines);
          const redacted = ctx.redactor.redact(rendered, { minConfidence: 'high' });
          const secretCount = scanSecrets(rendered, { minConfidence: 'high' }).length;
          const budgeted = truncateForModel(redacted, { maxBytes: 48 * 1024, maxLines: 1200 });

          const header =
            `${matches.length} match(es) for /${args.pattern}/ under ${display}` +
            (truncatedByEngine ? ` (capped at ${maxResults}; narrow the pattern to see the rest)` : '') +
            (secretCount > 0 ? `\nnote: ${secretCount} credential-shaped value(s) were redacted` : '') +
            '\n\n';

          return okResult(header + budgeted.text, {
            structured: {
              matches: matches.slice(0, maxResults).map((m) => ({ file: m.file, line: m.line })),
              truncated: truncatedByEngine || budgeted.truncated,
              engine,
            },
            metadata: { matchCount: matches.length, engine, redactions: secretCount },
          });
        },
      };
    },
  };
}

/**
 * Run `rg --json`.
 *
 * Returns undefined when ripgrep could not be used, so the caller can fall back
 * rather than surface an error the model cannot act on.
 */
async function runRipgrep(
  executor: Parameters<ToolExecution['execute']>[0],
  root: CanonicalPath,
  args: GrepArgs,
  maxResults: number,
  contextLines: number,
  signal: AbortSignal,
): Promise<{ matches: Match[]; truncated: boolean } | undefined> {
  const argv = ['rg', '--json', '--no-config', '--max-filesize', '4M'];
  if (args.caseInsensitive) argv.push('-i');
  if (contextLines > 0) argv.push('-C', String(contextLines));
  if (args.glob) argv.push('--glob', args.glob);
  argv.push('--max-count', String(Math.min(maxResults, 200)));
  argv.push('-e', args.pattern, '.');

  let result;
  try {
    result = await executor.exec(
      { argv, cwd: root, timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 },
      signal,
    );
  } catch {
    return undefined;
  }
  // rg exits 1 when there are simply no matches; only >1 is a real failure.
  if (result.exitCode !== 0 && result.exitCode !== 1) return undefined;

  const matches: Match[] = [];
  const contextBuffer = new Map<string, string[]>();

  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event: { type?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === 'context') {
      const data = event.data ?? {};
      const file = textOf(data.path);
      const buf = contextBuffer.get(file) ?? [];
      buf.push(clamp(textOf(data.lines)));
      contextBuffer.set(file, buf.slice(-contextLines));
      continue;
    }
    if (event.type !== 'match') continue;

    const data = event.data ?? {};
    const file = textOf(data.path);
    matches.push({
      file,
      line: typeof data.line_number === 'number' ? data.line_number : 0,
      text: clamp(textOf(data.lines).replace(/\n$/, '')),
      before: contextBuffer.get(file) ?? [],
      after: [],
    });
    contextBuffer.set(file, []);
    if (matches.length >= maxResults) return { matches, truncated: true };
  }

  return { matches, truncated: false };
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'text' in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/** In-kernel scanner: no subprocess, no dependency, works on every backend. */
async function scanInKernel(
  executor: Parameters<ToolExecution['execute']>[0],
  root: CanonicalPath,
  regex: RegExp,
  args: GrepArgs,
  maxResults: number,
  contextLines: number,
  signal: AbortSignal,
): Promise<{ matches: Match[]; truncated: boolean }> {
  const fileMatcher = args.glob
    ? compileGlob(args.glob.includes('/') ? args.glob : `**/${args.glob}`)
    : undefined;
  const matches: Match[] = [];
  let bytesScanned = 0;

  for await (const entry of walkFiles({ root, maxResults: 100_000, useGitignore: true, signal })) {
    if (signal.aborted) break;
    if (matches.length >= maxResults) return { matches, truncated: true };
    if (fileMatcher && !fileMatcher.test(entry.relative)) continue;
    if (entry.size > MAX_FILE_BYTES) continue;
    if (bytesScanned > SCAN_BYTE_BUDGET) return { matches, truncated: true };

    let buffer: Buffer;
    try {
      buffer = await executor.fs.readFile(entry.absolute);
    } catch {
      continue; // unreadable or protected: not a search failure
    }
    bytesScanned += buffer.length;
    if (looksBinary(buffer)) continue;

    const lines = buffer.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      // Reset lastIndex defensively in case a global flag ever slips in.
      regex.lastIndex = 0;
      if (!regex.test(line)) continue;

      matches.push({
        file: entry.relative,
        line: i + 1,
        text: clamp(line),
        before: contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i).map(clamp) : [],
        after: contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines).map(clamp) : [],
      });

      if (matches.length >= maxResults) return { matches, truncated: true };
    }
  }

  return { matches, truncated: false };
}

function clamp(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated]` : line;
}

function renderMatches(matches: readonly Match[], contextLines: number): string {
  const byFile = new Map<string, Match[]>();
  for (const m of matches) {
    const list = byFile.get(m.file) ?? [];
    list.push(m);
    byFile.set(m.file, list);
  }

  const out: string[] = [];
  for (const [file, list] of byFile) {
    out.push(`${file}`);
    for (const m of list) {
      if (contextLines > 0) {
        m.before.forEach((line, i) =>
          out.push(`  ${String(m.line - m.before.length + i).padStart(5)}- ${line}`),
        );
      }
      out.push(`  ${String(m.line).padStart(5)}: ${m.text}`);
      if (contextLines > 0) {
        m.after.forEach((line, i) => out.push(`  ${String(m.line + i + 1).padStart(5)}- ${line}`));
        out.push('');
      }
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
