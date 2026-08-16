/**
 * JSON-RPC 2.0 framing for MCP, and the shapes alpha.9 actually speaks.
 *
 * Hand-written rather than taken from the official SDK, under ADR-0009. Taking a
 * dependency exception for *this* feature in particular would be hard to say out
 * loud: the whole premise of MCP is running code we did not write, and the first
 * thing it would do is add a supply chain to the component that bounds it. The
 * subset below is `initialize`, `tools/list` and `tools/call` — nothing else —
 * and it is about two hundred lines.
 *
 * Everything here treats the server's side of the wire as hostile input. A
 * response is parsed into a known shape or rejected; there is no `as` cast that
 * would let a server's JSON become a typed object by assertion.
 */

/** The version this client speaks. A server that cannot is refused (ADR-0022 §6). */
export const PROTOCOL_VERSION = '2025-06-18';

/** Older revisions this client is still willing to accept from a server. */
export const ACCEPTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === '2.0' && typeof v.id === 'number';
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === '2.0' && v.id === undefined && typeof v.method === 'string';
}

/**
 * One tool as the server described it.
 *
 * Deliberately loose: `description` is `unknown` because a server may send a
 * number, and `inputSchema` is `unknown` because validating it is a separate
 * decision from receiving it. Typing these as `string` and `JsonSchema` would be
 * asserting something about a stranger's JSON.
 */
export interface ListedTool {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
}

/**
 * Parse a `tools/list` result.
 *
 * A tool with a non-string `name` is dropped here rather than later, because
 * everything downstream keys on the name and a `{name: 42}` entry would become a
 * string somewhere by accident.
 */
export function parseToolsList(result: unknown): { tools: ListedTool[]; dropped: number } {
  if (typeof result !== 'object' || result === null) return { tools: [], dropped: 0 };
  const raw = (result as Record<string, unknown>).tools;
  if (!Array.isArray(raw)) return { tools: [], dropped: 0 };

  const tools: ListedTool[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      dropped += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string') {
      dropped += 1;
      continue;
    }
    tools.push({
      name: e.name,
      ...(e.description !== undefined ? { description: e.description } : {}),
      ...(e.inputSchema !== undefined ? { inputSchema: e.inputSchema } : {}),
    });
  }
  return { tools, dropped };
}

export interface CallResult {
  /** Flattened text. Non-text content parts are summarised, never inlined. */
  text: string;
  isError: boolean;
}

/**
 * Flatten a `tools/call` result into text the model can read.
 *
 * Non-text content — images, audio, embedded resources — is *described* rather
 * than inlined. Reading media is an alpha.10 candidate and an explicit non-goal
 * here (§6), and a base64 blob silently pasted into the context would be the
 * feature arriving by accident, with no policy decision and no size budget.
 */
export function parseCallResult(result: unknown): CallResult {
  if (typeof result !== 'object' || result === null) {
    return { text: '(the server returned no content)', isError: false };
  }
  const r = result as Record<string, unknown>;
  const isError = r.isError === true;

  const content = Array.isArray(r.content) ? r.content : [];
  const parts: string[] = [];

  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (c.type === 'text' && typeof c.text === 'string') {
      parts.push(c.text);
    } else if (typeof c.type === 'string') {
      parts.push(`[${c.type} content omitted by MyCoder: only text results are read in v0.1]`);
    }
  }

  return {
    text: parts.length > 0 ? parts.join('\n') : '(the server returned no text content)',
    isError,
  };
}

/**
 * Split a byte stream into newline-delimited JSON values.
 *
 * Stateful because a JSON-RPC message can be split across chunk boundaries —
 * the same hazard `src/util/sse.ts` exists for, and the same reason it has its
 * own test.
 */
export class LineFramer {
  private buffer = '';

  /** Feed a chunk; get back the complete lines it finished. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is whatever came after the final newline: either '' or a
    // partial line. Either way it stays buffered.
    this.buffer = lines.pop() ?? '';
    return lines.map((l) => l.trim()).filter((l) => l !== '');
  }

  /** How much is buffered but unterminated. Used to enforce a flood cap. */
  get pending(): number {
    return this.buffer.length;
  }
}
