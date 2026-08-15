/**
 * Bounded HTTP request parser for the egress proxy (alpha.6 §26, §33, §34, §60).
 *
 * This parses exactly one thing: the request head a client sends to a *forward
 * proxy*. That is a narrower grammar than HTTP in general, and the narrowness is
 * the point — the proxy needs to answer one question ("which host is this
 * going to?") with no ambiguity, and every general-purpose HTTP parser answers it
 * with a preference order between conflicting fields.
 *
 * Two shapes arrive here:
 *
 *     GET http://example.com/path HTTP/1.1     absolute-form (RFC 7230 §5.3.2)
 *     CONNECT example.com:443 HTTP/1.1         authority-form (§5.3.3)
 *
 * and origin-form (`GET /path`) is rejected outright, because a request with no
 * authority in the target has only the `Host` header to go on, and a proxy that
 * accepts that is a proxy whose destination can be changed by a header.
 *
 * ## The mismatch rule
 *
 * §34: when the absolute target says one host and `Host:` says another, **reject**.
 * Do not prefer the target, do not prefer the header, do not pick the stricter
 * one. Two disagreeing authorities in one request is a request-smuggling
 * primitive, and the only safe reading is that the request is malformed. The same
 * goes for duplicate `Host` headers, `Content-Length` alongside
 * `Transfer-Encoding`, and duplicate `Content-Length` values that disagree.
 *
 * ## Bounds
 *
 * §60: exceeding a limit is a refusal, never a truncation. A head larger than
 * `MAX_HEAD_BYTES`, more than `MAX_HEADERS` fields, or a single line longer than
 * `MAX_LINE_BYTES` closes the connection with a 4xx. Truncating instead would
 * mean the proxy validated a prefix of a request and forwarded all of it.
 */

/** §61: total request-head budget. Exceeded → deny. */
export const MAX_HEAD_BYTES = 32 * 1024;
export const MAX_LINE_BYTES = 8 * 1024;
export const MAX_HEADERS = 100;

export interface HttpHeader {
  /** Lower-cased, for every comparison this module makes. */
  name: string;
  /**
   * The field name exactly as it arrived, used when the head is rebuilt.
   *
   * Comparing case-insensitively and forwarding verbatim are both required: HTTP
   * says field names are case-insensitive, but a proxy that rewrites `Accept` to
   * `accept` has changed bytes it had no reason to change, and some servers and
   * signature schemes do notice.
   */
  rawName: string;
  value: string;
}

export interface HttpRequestHead {
  method: string;
  /** The raw request target, exactly as it arrived. */
  target: string;
  /** `HTTP/1.1`. */
  version: string;
  headers: readonly HttpHeader[];
  /** Byte length of the head including the terminating CRLFCRLF. */
  headBytes: number;
}

export type HeadParseResult =
  | { kind: 'ok'; head: HttpRequestHead }
  /** The terminator has not arrived yet. Keep reading within the budget. */
  | { kind: 'incomplete' }
  | { kind: 'error'; status: number; reason: string };

/**
 * Find and parse the request head.
 *
 * Returns `incomplete` until CRLFCRLF is present, so the caller accumulates —
 * but the caller also enforces `MAX_HEAD_BYTES` on the accumulated buffer, so
 * "keep reading" is bounded by construction.
 */
export function parseRequestHead(buffer: Buffer): HeadParseResult {
  if (buffer.length > MAX_HEAD_BYTES) {
    return { kind: 'error', status: 431, reason: 'request head exceeds the proxy byte budget' };
  }
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) {
    // A bare-LF terminator is legal to *tolerate* per RFC 7230 and is also the
    // classic smuggling primitive; this proxy requires CRLF, which costs nothing
    // because every real client sends it.
    return { kind: 'incomplete' };
  }

  const headBytes = end + 4;
  const text = buffer.subarray(0, end).toString('latin1');
  const lines = text.split('\r\n');
  const requestLine = lines[0] ?? '';

  if (requestLine.length > MAX_LINE_BYTES) {
    return { kind: 'error', status: 414, reason: 'request line exceeds the proxy byte budget' };
  }
  // A leading empty line is permitted by RFC 7230 for robustness. It is also
  // free desynchronisation surface, so it is refused.
  if (requestLine === '') return { kind: 'error', status: 400, reason: 'empty request line' };

  const parts = requestLine.split(' ');
  if (parts.length !== 3) {
    return { kind: 'error', status: 400, reason: 'request line does not have exactly three fields' };
  }
  const [method, target, version] = parts as [string, string, string];

  if (!/^[A-Za-z]{1,20}$/.test(method)) {
    return { kind: 'error', status: 400, reason: 'method is not a plain token' };
  }
  if (!/^HTTP\/1\.[01]$/.test(version)) {
    // HTTP/2 and /3 to a forward proxy would need a different framing layer
    // entirely; refusing is honest, and §7 lists them as non-goals.
    return { kind: 'error', status: 505, reason: `unsupported protocol version ${version}` };
  }
  if (target === '' || /[\0-\x20\x7f]/.test(target)) {
    return { kind: 'error', status: 400, reason: 'request target is empty or contains control characters' };
  }

  const headers: HttpHeader[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === '') return { kind: 'error', status: 400, reason: 'empty header line inside the head' };
    if (line.length > MAX_LINE_BYTES) {
      return { kind: 'error', status: 431, reason: 'header line exceeds the proxy byte budget' };
    }
    if (headers.length >= MAX_HEADERS) {
      return { kind: 'error', status: 431, reason: `more than ${MAX_HEADERS} header fields` };
    }
    // Obsolete line folding: a continuation can hide a second authority from a
    // parser that splits on CRLF. RFC 7230 lets a proxy reject it; this one does.
    if (line.startsWith(' ') || line.startsWith('\t')) {
      return { kind: 'error', status: 400, reason: 'obsolete header line folding is not accepted' };
    }
    const colon = line.indexOf(':');
    if (colon <= 0) return { kind: 'error', status: 400, reason: 'header line has no field name' };
    const name = line.slice(0, colon);
    // Whitespace between the field name and the colon is the other classic
    // smuggling trick, and RFC 7230 §3.2.4 requires rejecting it.
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      return { kind: 'error', status: 400, reason: 'header field name is not a token' };
    }
    headers.push({ name: name.toLowerCase(), rawName: name, value: line.slice(colon + 1).trim() });
  }

  return { kind: 'ok', head: { method, target, version, headers, headBytes } };
}

export function headerValues(head: HttpRequestHead, name: string): string[] {
  return head.headers.filter((h) => h.name === name).map((h) => h.value);
}

/**
 * Reject the framing ambiguities that let one request be read as two.
 *
 * The proxy forwards the head verbatim once it approves the destination, so a
 * request that two parsers would frame differently is a request that could reach
 * a different host than the one that was checked.
 */
export function checkFraming(
  head: HttpRequestHead,
): { ok: true } | { ok: false; status: number; reason: string } {
  const contentLengths = headerValues(head, 'content-length');
  const transferEncodings = headerValues(head, 'transfer-encoding');

  if (contentLengths.length > 0 && transferEncodings.length > 0) {
    return { ok: false, status: 400, reason: 'both Content-Length and Transfer-Encoding are present' };
  }
  if (contentLengths.length > 1 && new Set(contentLengths).size > 1) {
    return { ok: false, status: 400, reason: 'conflicting Content-Length headers' };
  }
  for (const value of contentLengths) {
    if (!/^[0-9]{1,15}$/.test(value)) {
      return { ok: false, status: 400, reason: 'Content-Length is not a plain decimal length' };
    }
  }
  for (const value of transferEncodings) {
    // Only the identity `chunked` coding is understood; anything else — a list,
    // a casing trick, an unknown coding — is a framing disagreement waiting to
    // happen.
    if (value.toLowerCase() !== 'chunked') {
      return { ok: false, status: 400, reason: 'unsupported Transfer-Encoding' };
    }
  }
  return { ok: true };
}

export interface AbsoluteTarget {
  scheme: 'http';
  /** Raw host as it appeared in the target. Normalised by the caller (§20). */
  host: string;
  port: number;
  /** Path and query, forwarded to the origin unchanged and never logged (§44). */
  pathAndQuery: string;
}

/**
 * Parse an absolute-form request target.
 *
 * Hand-rolled rather than `new URL()`, for one specific reason: `URL` is
 * permissive by design. It strips leading control characters, tolerates
 * backslashes as separators, accepts userinfo and normalises away things the
 * origin server will interpret differently. A destination check has to be made on
 * exactly what the wire carried, so the parsing here refuses instead of repairs.
 */
export function parseAbsoluteTarget(
  target: string,
): { ok: true; target: AbsoluteTarget } | { ok: false; reason: string } {
  const lower = target.toLowerCase();
  if (lower.startsWith('https://')) {
    // Plain HTTPS through the absolute-form path would mean the proxy
    // originating TLS on the workload's behalf — i.e. terminating it, which
    // ADR-0015 §6 rules out. HTTPS goes through CONNECT.
    return { ok: false, reason: 'https absolute-form targets must use CONNECT' };
  }
  if (!lower.startsWith('http://')) {
    return { ok: false, reason: 'request target is not an absolute http:// URL (origin-form is refused)' };
  }

  const rest = target.slice('http://'.length);
  if (rest === '') return { ok: false, reason: 'absolute target has no authority' };

  // The authority ends at the first `/`, `?` or `#`. A backslash is not a
  // separator in RFC 3986, but several clients and servers treat it as one, so
  // its presence in an authority is a disagreement and therefore a refusal.
  let authorityEnd = rest.length;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i]!;
    if (c === '/' || c === '?' || c === '#') {
      authorityEnd = i;
      break;
    }
    if (c === '\\') return { ok: false, reason: 'authority contains a backslash' };
  }

  const authority = rest.slice(0, authorityEnd);
  const pathAndQuery = rest.slice(authorityEnd) || '/';
  if (authority === '') return { ok: false, reason: 'absolute target has an empty authority' };
  if (authority.includes('@')) return { ok: false, reason: 'authority contains userinfo' };

  const split = splitAuthority(authority, 80);
  if (split === undefined) return { ok: false, reason: 'authority is not a valid host[:port]' };

  return {
    ok: true,
    target: { scheme: 'http', host: split.host, port: split.port, pathAndQuery },
  };
}

/**
 * Split `host[:port]`, IPv6-aware.
 *
 * Duplicated in spirit by `egress/host.ts#splitHostPort`, and kept here as a
 * private helper for one reason: this one is parsing *wire* input where the
 * default port depends on the caller's context, and the other is parsing a
 * policy authority. They agree on the IPv6 bracket rule, which is the part that
 * would be a bug if they disagreed, and both are unit-tested on the same cases.
 */
function splitAuthority(authority: string, defaultPort: number): { host: string; port: number } | undefined {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return undefined;
    const host = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest === '') return { host, port: defaultPort };
    if (!rest.startsWith(':')) return undefined;
    const port = parsePortText(rest.slice(1));
    return port === undefined ? undefined : { host, port };
  }
  const colon = authority.lastIndexOf(':');
  if (colon < 0) return { host: authority, port: defaultPort };
  if (authority.indexOf(':') !== colon) return undefined;
  const port = parsePortText(authority.slice(colon + 1));
  if (port === undefined) return undefined;
  return { host: authority.slice(0, colon), port };
}

function parsePortText(text: string): number | undefined {
  if (!/^[0-9]{1,5}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * Parse an authority-form CONNECT target.
 *
 * A CONNECT with no port is refused rather than defaulted to 443: the port is
 * part of what is being authorised (§22), and inferring it would mean the proxy
 * approved a port the client never named.
 */
export function parseConnectTarget(
  target: string,
): { ok: true; host: string; port: number } | { ok: false; reason: string } {
  if (target.includes('@')) return { ok: false, reason: 'CONNECT authority contains userinfo' };
  if (target.includes('/')) return { ok: false, reason: 'CONNECT target is not authority-form' };
  const split = splitAuthority(target, -1);
  if (split === undefined || split.port < 0) {
    return { ok: false, reason: 'CONNECT target is not a valid host:port' };
  }
  return { ok: true, host: split.host, port: split.port };
}

/**
 * The `Host` header, if there is exactly one.
 *
 * "Exactly one" is the check. Zero is invalid in HTTP/1.1; two is the
 * disagreement §34 refuses to resolve.
 */
export function singleHostHeader(
  head: HttpRequestHead,
): { ok: true; value: string } | { ok: false; reason: string } {
  const values = headerValues(head, 'host');
  if (values.length === 0) return { ok: false, reason: 'request has no Host header' };
  if (values.length > 1) return { ok: false, reason: 'request has more than one Host header' };
  return { ok: true, value: values[0]! };
}

/**
 * Headers the proxy strips before forwarding.
 *
 * Hop-by-hop by RFC 7230 §6.1, plus `proxy-authorization`, which is a credential
 * addressed to this proxy and has no business reaching an origin server.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Rebuild the request head in origin-form for the upstream server.
 *
 * The path, query and every remaining header are copied through verbatim and are
 * never inspected or logged (§26, §44). The proxy's business is the destination.
 */
export function buildOriginRequest(
  head: HttpRequestHead,
  target: AbsoluteTarget,
  hostHeader: string,
): Buffer {
  const lines: string[] = [`${head.method} ${target.pathAndQuery} ${head.version}`];
  const dropped = new Set(HOP_BY_HOP);
  // `Connection: X` nominates further hop-by-hop headers by name.
  for (const value of headerValues(head, 'connection')) {
    for (const token of value.split(',')) {
      const t = token.trim().toLowerCase();
      if (t !== '') dropped.add(t);
    }
  }
  lines.push(`Host: ${hostHeader}`);
  for (const header of head.headers) {
    if (header.name === 'host') continue;
    if (dropped.has(header.name)) continue;
    lines.push(`${header.rawName}: ${header.value}`);
  }
  // One request per upstream connection: no pooling, no reuse across
  // destinations, and therefore no way for a second request on a kept-alive
  // socket to reach a host that was never checked.
  lines.push('Connection: close');
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}
