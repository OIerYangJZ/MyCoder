/**
 * TLS ClientHello / SNI parser (alpha.6 §27–§31, ADR-0015 §6).
 *
 * ## Why the proxy reads TLS at all
 *
 * A CONNECT authority is a claim made by the client, and the client is the
 * untrusted workload. It is also, on its own, not enough — not because the
 * client might lie about it (the proxy checks it), but because a shared IP hosts
 * many virtual hosts:
 *
 *     CONNECT allowed.example:443        ← authorised, resolves to 1.2.3.4
 *     TLS ClientHello SNI: denied.example ← same IP, different virtual host
 *
 * A proxy that authorises the tunnel and then relays bytes blindly has just
 * delivered the workload to `denied.example`. So a domain-based HTTPS approval
 * requires the CONNECT host and the SNI to agree, and this file is the part that
 * can read the second one.
 *
 * ## What it deliberately does not do
 *
 * It does not terminate TLS. There is no certificate, no custom CA and no
 * decryption anywhere in this kernel. The ClientHello is plaintext by
 * construction — it is the message that *negotiates* encryption — so the name can
 * be read without touching the payload, and everything after it stays opaque.
 * That is the difference between "destination enforcement" and the payload DLP
 * §42 explicitly does not claim.
 *
 * ## Fail closed, and why the budget is not a shortcut
 *
 * This parser sits on a guarantee-bearing path, so §3.1's rule applies with full
 * force: **every** limit here produces a denial, never a skipped check. The
 * tempting version of "the ClientHello is bigger than my buffer" is to give up on
 * SNI and let the connection through, which converts a resource bound into a
 * bypass — send a 40 KB ClientHello and the identity check evaporates. So
 * `too-large`, `malformed`, `not-tls` and `no-sni` are four distinct outcomes and
 * all four of them are refusals at the caller.
 *
 * Every field is length-prefixed and every length is checked against the
 * remaining buffer before it is used. A truncated record returns `incomplete`,
 * which is a request for more bytes rather than a verdict — the caller keeps
 * reading until the budget is spent, and then denies.
 */

/** §31/§61: a ClientHello larger than this is denied, not truncated. */
export const MAX_CLIENT_HELLO_BYTES = 16 * 1024;

/** The record header alone is 5 bytes; nothing can be decided before that. */
const TLS_RECORD_HEADER = 5;
const HANDSHAKE_HEADER = 4;

const CONTENT_TYPE_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXTENSION_SERVER_NAME = 0x0000;
const EXTENSION_ENCRYPTED_CLIENT_HELLO = 0xfe0d;
const SNI_NAME_TYPE_HOST = 0x00;

export type ClientHelloResult =
  /** A server name was found. Not yet normalised — the caller does that (§20). */
  | { kind: 'sni'; serverName: string; encryptedClientHello: boolean }
  /** Well-formed ClientHello with no SNI extension. Strict mode denies (§29). */
  | { kind: 'no-sni'; encryptedClientHello: boolean }
  /** Not enough bytes yet. Keep reading, subject to the caller's budget. */
  | { kind: 'incomplete' }
  /** Structurally invalid. Denied (§31). */
  | { kind: 'malformed'; reason: string }
  /** Valid TLS framing, but the first message is not a ClientHello. */
  | { kind: 'not-client-hello'; reason: string }
  /** Not a TLS record at all — an HTTP request sent to a CONNECT tunnel, say. */
  | { kind: 'not-tls'; reason: string }
  /** Exceeded `MAX_CLIENT_HELLO_BYTES`. Denied — never "skip the check" (§31). */
  | { kind: 'too-large' };

/**
 * A bounds-checked cursor over the buffer.
 *
 * Written out rather than using `readUInt16BE` directly because the interesting
 * bug in a TLS parser is never the arithmetic — it is the read that ran past the
 * end of a nested length and silently returned whatever was next. Here every
 * read goes through `need()`, and running out of bytes is a *typed* condition
 * (`incomplete`) rather than an exception or a zero.
 */
class Reader {
  private readonly buf: Buffer;
  private pos: number;
  /** Set when a read was refused. Distinguishes "need more" from "bad input". */
  overrun = false;

  constructor(buf: Buffer, start = 0) {
    this.buf = buf;
    this.pos = start;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return Math.max(0, this.buf.length - this.pos);
  }

  private need(n: number): boolean {
    if (this.remaining < n) {
      this.overrun = true;
      return false;
    }
    return true;
  }

  u8(): number | undefined {
    if (!this.need(1)) return undefined;
    const v = this.buf[this.pos]!;
    this.pos += 1;
    return v;
  }

  u16(): number | undefined {
    if (!this.need(2)) return undefined;
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  u24(): number | undefined {
    if (!this.need(3)) return undefined;
    const v = (this.buf[this.pos]! << 16) | (this.buf[this.pos + 1]! << 8) | this.buf[this.pos + 2]!;
    this.pos += 3;
    return v;
  }

  bytes(n: number): Buffer | undefined {
    if (!this.need(n)) return undefined;
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  skip(n: number): boolean {
    if (!this.need(n)) return false;
    this.pos += n;
    return true;
  }
}

/**
 * Parse the SNI out of a buffer that should begin with a TLS ClientHello.
 *
 * Handles the multi-record case: a ClientHello large enough to be fragmented
 * across TLS records (which a client with many extensions or a post-quantum key
 * share genuinely produces) has its handshake bytes reassembled before parsing,
 * because the handshake message boundaries and the record boundaries are not the
 * same thing and assuming they are is how a parser gets fooled by deliberate
 * fragmentation.
 */
export function parseClientHello(data: Buffer): ClientHelloResult {
  if (data.length > MAX_CLIENT_HELLO_BYTES) return { kind: 'too-large' };
  if (data.length < 1) return { kind: 'incomplete' };

  if (data[0] !== CONTENT_TYPE_HANDSHAKE) {
    // 0x47 is 'G', i.e. someone speaking HTTP into a CONNECT tunnel. Naming it
    // makes the audit line intelligible without logging any content.
    return {
      kind: 'not-tls',
      reason: `first byte 0x${data[0]!.toString(16).padStart(2, '0')} is not a TLS handshake record`,
    };
  }

  // Reassemble handshake bytes across records.
  const fragments: Buffer[] = [];
  let offset = 0;
  let total = 0;
  while (offset < data.length) {
    if (data.length - offset < TLS_RECORD_HEADER) return { kind: 'incomplete' };
    const type = data[offset]!;
    if (type !== CONTENT_TYPE_HANDSHAKE) {
      return {
        kind: 'malformed',
        reason: 'a non-handshake record appeared before the ClientHello completed',
      };
    }
    const major = data[offset + 1]!;
    // The record-layer version is 3.x for every TLS version in existence; TLS
    // 1.3 pins it to 3,1 and negotiates upward inside the handshake.
    if (major !== 0x03) return { kind: 'not-tls', reason: `record layer version ${major}.x is not TLS` };
    const length = data.readUInt16BE(offset + 3);
    // RFC 8446: a plaintext record fragment may not exceed 2^14 bytes.
    if (length === 0 || length > 16384) {
      return { kind: 'malformed', reason: 'TLS record length is zero or above the 2^14 maximum' };
    }
    total += length;
    if (total > MAX_CLIENT_HELLO_BYTES) return { kind: 'too-large' };
    const end = offset + TLS_RECORD_HEADER + length;
    if (end > data.length) {
      fragments.push(data.subarray(offset + TLS_RECORD_HEADER));
      // Partial record: we may still have enough handshake bytes to find the
      // SNI, so try, and fall back to asking for more.
      const partial = parseHandshake(Buffer.concat(fragments));
      return partial.kind === 'incomplete' ? { kind: 'incomplete' } : partial;
    }
    fragments.push(data.subarray(offset + TLS_RECORD_HEADER, end));
    offset = end;

    const attempt = parseHandshake(Buffer.concat(fragments));
    if (attempt.kind !== 'incomplete') return attempt;
  }

  return { kind: 'incomplete' };
}

function parseHandshake(body: Buffer): ClientHelloResult {
  const r = new Reader(body);

  const messageType = r.u8();
  if (messageType === undefined) return { kind: 'incomplete' };
  if (messageType !== HANDSHAKE_CLIENT_HELLO) {
    return { kind: 'not-client-hello', reason: `handshake type ${messageType} is not a ClientHello` };
  }
  const messageLength = r.u24();
  if (messageLength === undefined) return { kind: 'incomplete' };
  if (messageLength > MAX_CLIENT_HELLO_BYTES) return { kind: 'too-large' };
  if (body.length < HANDSHAKE_HEADER + messageLength) return { kind: 'incomplete' };

  // legacy_version(2) + random(32)
  if (!r.skip(2) || !r.skip(32)) return { kind: 'incomplete' };

  const sessionIdLength = r.u8();
  if (sessionIdLength === undefined) return { kind: 'incomplete' };
  if (sessionIdLength > 32) return { kind: 'malformed', reason: 'session id longer than 32 bytes' };
  if (!r.skip(sessionIdLength)) return { kind: 'incomplete' };

  const cipherSuitesLength = r.u16();
  if (cipherSuitesLength === undefined) return { kind: 'incomplete' };
  if (cipherSuitesLength % 2 !== 0) {
    return { kind: 'malformed', reason: 'cipher suite list length is not a multiple of two' };
  }
  if (!r.skip(cipherSuitesLength)) return { kind: 'incomplete' };

  const compressionLength = r.u8();
  if (compressionLength === undefined) return { kind: 'incomplete' };
  if (!r.skip(compressionLength)) return { kind: 'incomplete' };

  // A ClientHello with no extension block is legal TLS 1.2 and has no SNI.
  if (r.remaining === 0) return { kind: 'no-sni', encryptedClientHello: false };

  const extensionsLength = r.u16();
  if (extensionsLength === undefined) return { kind: 'incomplete' };
  const extensions = r.bytes(extensionsLength);
  if (extensions === undefined) return { kind: 'incomplete' };

  return parseExtensions(extensions);
}

function parseExtensions(block: Buffer): ClientHelloResult {
  const r = new Reader(block);
  let serverName: string | undefined;
  let encryptedClientHello = false;
  // A malformed *inner* structure is not something to shrug off and keep
  // scanning: it is the shape a deliberately confusing ClientHello has.
  let seen = 0;

  while (r.remaining > 0) {
    seen += 1;
    // TLS has ~60 registered extensions; a hello claiming hundreds is either
    // broken or probing for a parser that will keep walking (§60).
    if (seen > 128) return { kind: 'malformed', reason: 'more than 128 extensions' };

    const type = r.u16();
    if (type === undefined) return { kind: 'malformed', reason: 'truncated extension type' };
    const length = r.u16();
    if (length === undefined) return { kind: 'malformed', reason: 'truncated extension length' };
    const body = r.bytes(length);
    if (body === undefined)
      return { kind: 'malformed', reason: 'extension length exceeds the extension block' };

    if (type === EXTENSION_ENCRYPTED_CLIENT_HELLO) {
      // §30: ECH hides the real destination name. We do not silently downgrade
      // — we record it so the caller can deny with an accurate reason.
      encryptedClientHello = true;
      continue;
    }
    if (type !== EXTENSION_SERVER_NAME) continue;
    // A second server_name extension is a contradiction, and picking one is
    // exactly the "never choose the more permissive field" mistake of §34.
    if (serverName !== undefined) {
      return { kind: 'malformed', reason: 'more than one server_name extension' };
    }

    const parsed = parseServerNameList(body);
    if (parsed.kind === 'malformed') return parsed;
    if (parsed.kind === 'sni') serverName = parsed.serverName;
  }

  if (serverName !== undefined) return { kind: 'sni', serverName, encryptedClientHello };
  return { kind: 'no-sni', encryptedClientHello };
}

function parseServerNameList(
  body: Buffer,
): { kind: 'sni'; serverName: string } | { kind: 'none' } | { kind: 'malformed'; reason: string } {
  const r = new Reader(body);
  const listLength = r.u16();
  if (listLength === undefined) return { kind: 'malformed', reason: 'truncated server_name list' };
  const list = r.bytes(listLength);
  if (list === undefined)
    return { kind: 'malformed', reason: 'server_name list length exceeds the extension' };
  // An empty server_name extension is what a TLS 1.3 *server* sends back; from a
  // client it carries no name, which strict mode treats as no-sni.
  if (list.length === 0) return { kind: 'none' };

  const lr = new Reader(list);
  let found: string | undefined;
  while (lr.remaining > 0) {
    const nameType = lr.u8();
    if (nameType === undefined) return { kind: 'malformed', reason: 'truncated server_name entry' };
    const nameLength = lr.u16();
    if (nameLength === undefined) return { kind: 'malformed', reason: 'truncated server_name length' };
    const name = lr.bytes(nameLength);
    if (name === undefined) return { kind: 'malformed', reason: 'server_name length exceeds the list' };
    if (nameType !== SNI_NAME_TYPE_HOST) continue;
    if (found !== undefined) return { kind: 'malformed', reason: 'more than one host_name in server_name' };
    // Latin-1 rather than UTF-8: SNI host_name is an A-label by RFC 6066, so any
    // byte above 0x7f is already invalid. Decoding as UTF-8 could fold two
    // different byte sequences onto one string, and the normaliser would then be
    // comparing something the wire never carried.
    found = name.toString('latin1');
  }

  return found === undefined ? { kind: 'none' } : { kind: 'sni', serverName: found };
}
