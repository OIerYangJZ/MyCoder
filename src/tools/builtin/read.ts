/**
 * Read tool (spec §9.2).
 *
 * Order of operations matters and is fixed:
 *
 *   canonicalise → protected-path deny → read bytes → hash the WHOLE file
 *   → slice the requested window → redact → emit receipt → return
 *
 * The hash covers the entire file even when the model asked for 40 lines,
 * because that is what makes an external edit detectable. The *content* handed
 * back is only the requested window: hashing more than we show is fine, showing
 * more than was asked for is not (spec §8.4).
 */

import type { JsonSchema } from '../../util/jsonschema.ts';
import { detectEol, sliceLines, splitLines, truncateForModel } from '../../util/text.ts';
import { looksBinary } from '../../util/walk.ts';
import { coverageForSlice } from '../../context/freshness.ts';
import { scanSecrets } from '../../security/secret-scanner.ts';
import {
  errorResult,
  okResult,
  refusedExecution,
  type ToolDefinition,
  type ToolExecution,
  type ToolResolveContext,
} from '../contract.ts';

export interface ReadArgs {
  path: string;
  offsetLine?: number;
  limitLines?: number;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'File to read. Relative paths resolve against the workspace root.',
      minLength: 1,
    },
    offsetLine: {
      type: 'integer',
      description: 'First line to return, 1-based. Defaults to the start of the file.',
      minimum: 1,
    },
    limitLines: {
      type: 'integer',
      description: 'How many lines to return. Defaults to the whole file, subject to a size budget.',
      minimum: 1,
      maximum: 5000,
    },
  },
  required: ['path'],
  additionalProperties: false,
};

/** Files larger than this must be read with an explicit window. */
const LARGE_FILE_BYTES = 512 * 1024;
const DEFAULT_LINE_LIMIT = 2_000;

export function createReadTool(): ToolDefinition<ReadArgs> {
  return {
    name: 'Read',
    description:
      'Read a file from the workspace. Returns the requested lines prefixed with line numbers ' +
      'and a receiptId. Pass that receiptId to Edit — an edit without a fresh receipt is rejected. ' +
      'Line-number prefixes are display only: never include them in an Edit oldString. ' +
      'Secret files (.env, private keys, credential directories) are never readable.',
    inputSchema: SCHEMA,
    disclosure: 'eager',
    readOnly: true,

    async resolve(args: ReadArgs, ctx: ToolResolveContext): Promise<ToolExecution> {
      const { path: canonical, existed } = await ctx.canonicalize(args.path);
      const display = ctx.display(canonical);

      const subject = {
        key: `Read:${canonical}`,
        title: `Read ${display}`,
        details: [`file: ${display}`],
        risk: 'low' as const,
      };
      const reviewDisplay = { title: 'Read file', summary: display };

      if (!existed) {
        return refusedExecution(
          subject,
          reviewDisplay,
          errorResult('TOOL_FAILED', `No such file: ${display}`),
        );
      }

      const offsetLine = args.offsetLine ?? 1;
      const limitLines = args.limitLines ?? DEFAULT_LINE_LIMIT;

      return {
        accesses: [
          {
            kind: 'file.read',
            path: canonical,
            // The bytes are going into the model's context, so this is the
            // capability the secret boundary is attached to.
            toModel: true,
            display,
          },
        ],
        approvalSubject: subject,
        display: reviewDisplay,

        async execute(executor, signal) {
          if (signal.aborted) return errorResult('CANCELLED', 'Read was cancelled.');

          const stat = await executor.fs.stat(canonical);
          if (!stat) return errorResult('TOOL_FAILED', `No such file: ${display}`);
          if (stat.isDirectory) {
            return errorResult(
              'TOOL_INVALID_ARGS',
              `${display} is a directory. Use Glob to list its contents.`,
            );
          }

          const buffer = await executor.fs.readFile(canonical);

          if (looksBinary(buffer)) {
            return errorResult(
              'TOOL_INVALID_ARGS',
              `${display} looks like a binary file (${stat.size} bytes) and was not read.`,
            );
          }

          if (
            stat.size > LARGE_FILE_BYTES &&
            args.offsetLine === undefined &&
            args.limitLines === undefined
          ) {
            return errorResult(
              'TOOL_INVALID_ARGS',
              `${display} is ${Math.round(stat.size / 1024)} KiB. Read it in windows using ` +
                'offsetLine and limitLines, or narrow the search with Grep first.',
            );
          }

          const content = buffer.toString('utf8');
          const totalLines = splitLines(content).length;
          const slice = sliceLines(content, offsetLine, limitLines);

          if (slice.text === '' && totalLines > 0 && offsetLine > totalLines) {
            return errorResult(
              'TOOL_INVALID_ARGS',
              `offsetLine ${offsetLine} is past the end of ${display}, which has ${totalLines} lines.`,
            );
          }

          // (a) Receipt over the whole file — external changes stay detectable.
          const receipt = ctx.freshness.recordRead({
            path: canonical,
            content,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            coverage: coverageForSlice(content, slice.startLine, slice.endLine),
            stepId: ctx.stepId,
            now: ctx.now(),
          });

          // (b) Second-layer secret scan on content that is allowed through.
          const findings = scanSecrets(slice.text, { minConfidence: 'high' });
          const redacted =
            findings.length > 0 ? ctx.redactor.redact(slice.text, { minConfidence: 'high' }) : slice.text;

          const numbered = numberLines(redacted, slice.startLine);
          const truncated = truncateForModel(numbered, { maxBytes: 96 * 1024, maxLines: 3000 });

          const eol = detectEol(content);
          const header =
            `${display} (lines ${slice.startLine}-${slice.endLine} of ${totalLines}` +
            `${eol.style === 'crlf' ? ', CRLF' : ''})\n` +
            `receiptId: ${receipt.receiptId}\n` +
            (findings.length > 0
              ? `note: ${findings.length} credential-shaped value(s) were redacted\n`
              : '') +
            (slice.endLine < totalLines
              ? `note: ${totalLines - slice.endLine} more lines follow; read them with offsetLine ${slice.endLine + 1}\n`
              : '') +
            '\n';

          return okResult(header + truncated.text, {
            structured: {
              receiptId: receipt.receiptId,
              path: display,
              startLine: slice.startLine,
              endLine: slice.endLine,
              totalLines,
              redactions: findings.length,
            },
            metadata: {
              receiptId: receipt.receiptId,
              path: display,
              contentHash: receipt.contentHash,
              bytes: stat.size,
              redactions: findings.length,
              coverage: receipt.coverage,
            },
          });
        },
      };
    },
  };
}

/**
 * Prefix each line with its number.
 *
 * The separator is a tab after a right-aligned number, which is easy for a model
 * to strip and hard to confuse with content — and the tool description says
 * explicitly that these prefixes must not appear in an Edit `oldString`.
 */
function numberLines(text: string, startLine: number): string {
  if (text === '') return '';
  return text
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(6, ' ')}\t${line}`)
    .join('\n');
}
