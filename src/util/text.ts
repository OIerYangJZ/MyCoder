/**
 * Text handling shared by the tools, the edit engine and the context projector.
 *
 * The two jobs here are (a) not destroying a file's line-ending style during an
 * edit, and (b) keeping tool output inside a token budget with an honest,
 * machine-readable truncation notice.
 */

export type EolStyle = 'lf' | 'crlf';

export interface EolInfo {
  /** The dominant style, used when writing new content. */
  style: EolStyle;
  mixed: boolean;
  /** True when the file's last line has no terminator. */
  finalNewline: boolean;
}

export function detectEol(content: string): EolInfo {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const total = (content.match(/\n/g) ?? []).length;
  const lf = total - crlf;
  return {
    style: crlf > lf ? 'crlf' : 'lf',
    mixed: crlf > 0 && lf > 0,
    finalNewline: content.length === 0 || content.endsWith('\n'),
  };
}

/** Convert every terminator to `\n` so matching and diffing are style-agnostic. */
export function toLf(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/** Re-apply a line-ending style to LF-normalised content. */
export function applyEol(content: string, style: EolStyle): string {
  const lf = toLf(content);
  return style === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

export function splitLines(content: string): string[] {
  const lf = toLf(content);
  if (lf === '') return [];
  const lines = lf.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export interface LineSlice {
  text: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  totalLines: number;
  truncated: boolean;
}

/** 1-based, inclusive line window. `offsetLine` defaults to the first line. */
export function sliceLines(content: string, offsetLine?: number, limitLines?: number): LineSlice {
  const lines = splitLines(content);
  const total = lines.length;
  const start = Math.max(1, offsetLine ?? 1);
  const limit = limitLines ?? total;
  const end = Math.min(total, start + Math.max(0, limit) - 1);

  if (start > total) {
    return { text: '', startLine: start, endLine: start - 1, totalLines: total, truncated: total > 0 };
  }

  return {
    text: lines.slice(start - 1, end).join('\n'),
    startLine: start,
    endLine: end,
    totalLines: total,
    truncated: start > 1 || end < total,
  };
}

export interface TruncationBudget {
  maxBytes: number;
  maxLines: number;
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalBytes: number;
  originalLines: number;
  /** Set when content was dropped and stored as an artifact instead. */
  droppedBytes: number;
}

export const DEFAULT_TOOL_OUTPUT_BUDGET: TruncationBudget = {
  maxBytes: 64 * 1024,
  maxLines: 2000,
};

/**
 * Truncate from the middle: the head explains what ran, the tail carries the
 * error. Dropping only the tail is the classic way to hide a stack trace from
 * the model.
 */
export function truncateForModel(
  text: string,
  budget: TruncationBudget = DEFAULT_TOOL_OUTPUT_BUDGET,
): TruncationResult {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  const lines = text.split('\n');
  const originalLines = lines.length;

  if (originalBytes <= budget.maxBytes && originalLines <= budget.maxLines) {
    return { text, truncated: false, originalBytes, originalLines, droppedBytes: 0 };
  }

  const headLines = Math.max(1, Math.floor(budget.maxLines * 0.6));
  const tailLines = Math.max(1, budget.maxLines - headLines);

  let head = lines.slice(0, headLines).join('\n');
  let tail = lines.slice(Math.max(headLines, originalLines - tailLines)).join('\n');

  const headBudget = Math.floor(budget.maxBytes * 0.6);
  const tailBudget = budget.maxBytes - headBudget;
  head = clampBytes(head, headBudget);
  tail = clampBytes(tail, tailBudget, /* fromEnd */ true);

  const kept = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  const dropped = Math.max(0, originalBytes - kept);

  const notice =
    `\n\n[... truncated ${dropped} bytes / ` +
    `${Math.max(0, originalLines - headLines - tailLines)} lines. ` +
    `Original: ${originalBytes} bytes, ${originalLines} lines. ` +
    `Narrow the command or use Read with offsetLine/limitLines. ...]\n\n`;

  return {
    text: head + notice + tail,
    truncated: true,
    originalBytes,
    originalLines,
    droppedBytes: dropped,
  };
}

function clampBytes(s: string, maxBytes: number, fromEnd = false): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8');
  const slice = fromEnd ? buf.subarray(buf.length - maxBytes) : buf.subarray(0, maxBytes);
  // Drop a partial code point at the cut edge.
  return new TextDecoder('utf8', { fatal: false }).decode(slice).replace(/�/g, '');
}

/** Rough token estimate. Deliberately conservative; used only for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.6);
}

export function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => (l === '' ? l : prefix + l))
    .join('\n');
}

/**
 * Normalise an error message for failure fingerprinting: strip absolute paths,
 * digits and hex blobs so that "same failure, different pid" collapses.
 */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}
