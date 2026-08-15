/**
 * The egress proxy (alpha.6 §17, §24–§34, §44, §61, ADR-0015 §3).
 *
 * A forward proxy in about six hundred lines, built on `node:net` and
 * `node:dns` and nothing else. It is the only component on the internet-facing
 * side of the scoped-egress boundary, which drives every decision in it:
 *
 *  - **No dependencies.** ADR-0009 applies with extra force here. A supply-chain
 *    compromise in the one process that can reach the network is the worst
 *    possible place for one, and every off-the-shelf proxy would also have to be
 *    taught the SNI/authority agreement rule anyway.
 *
 *  - **No TLS termination.** No certificate, no CA, no decryption. The proxy
 *    reads the ClientHello — plaintext by construction — and then relays bytes it
 *    cannot read. §42: this enforces *where* bytes go, not what they contain.
 *
 *  - **No content anywhere.** Not in a log line, not in an error body, not in a
 *    metric. §44's safe field list is the whole vocabulary: execution id,
 *    decision, normalised host, port, protocol, reason code, byte counts,
 *    duration. A proxy that logged URLs would be a credential collector, because
 *    query strings carry tokens.
 *
 *  - **Resolve once, connect to what was checked.** §24. `dns.lookup` gives an
 *    address, the address is classified, and *that address* is the connect
 *    target. There is no second resolution between the check and the connection,
 *    which is the hole DNS rebinding drives through.
 *
 * The ordering in `handleConnect` is worth reading closely: the proxy answers
 * `200 Connection Established` before it has seen the ClientHello, because that
 * is what the protocol requires — but it does not *resolve or connect to
 * anything* until the SNI has been checked. So a tunnel whose SNI names a denied
 * host is torn down having sent zero bytes to zero servers, which is what §57
 * means by "fails before application payload".
 */

import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

import { normalizeHost } from '../egress/host.ts';
import { HTTPS_PORT, HTTP_PORT, type EgressProtocol, type ProxyPolicy } from '../egress/network-mode.ts';
import {
  decideAddress,
  decideAuthorityAgreement,
  decideDestination,
  decideSni,
  type EgressDecision,
  type EgressReason,
} from './decide.ts';
import {
  buildOriginRequest,
  checkFraming,
  parseAbsoluteTarget,
  parseConnectTarget,
  parseRequestHead,
  singleHostHeader,
  MAX_HEAD_BYTES,
} from './http.ts';
import { MAX_CLIENT_HELLO_BYTES, parseClientHello } from './tls.ts';

/** §61 bounds. Every one of them fails closed when exceeded (§60). */
export interface ProxyLimits {
  maxConnections: number;
  /** Time to receive a complete request head or ClientHello. */
  headTimeoutMs: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  /** §25: more answers than this is a refusal, not a "use the first few". */
  maxDnsAnswers: number;
}

export const DEFAULT_PROXY_LIMITS: ProxyLimits = {
  maxConnections: 64,
  headTimeoutMs: 15_000,
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 120_000,
  maxDnsAnswers: 16,
};

/**
 * One audit record per connection. §44's safe field list, and nothing else.
 *
 * Serialised as one JSON object per line on stdout, which is how the kernel
 * collects it: `docker logs` on the sidecar. That channel is deliberately
 * one-directional — the sidecar has no way to be asked a question.
 */
export interface EgressAuditRecord {
  t: 'egress';
  executionId: string;
  decision: 'allowed' | 'denied';
  reason: EgressReason;
  protocol?: EgressProtocol;
  host?: string;
  port?: number;
  addressScope?: string;
  bytesUp?: number;
  bytesDown?: number;
  durationMs: number;
}

export interface ProxyOptions {
  policy: ProxyPolicy;
  limits?: Partial<ProxyLimits>;
  /** Where audit records go. Defaults to a line on stdout. */
  audit?: (record: EgressAuditRecord) => void;
  /**
   * Resolver seam.
   *
   * Injected so the rebinding tests can make a name resolve to `127.0.0.1`
   * without owning a domain — §58's "private IP" row needs an attack that is
   * real, and standing up a public DNS zone that points at loopback is not a
   * thing a test suite can do.
   */
  resolve?: (host: string) => Promise<string[]>;
  /** Dial seam, for the same reason. */
  dial?: (address: string, port: number) => Socket;
}

export interface RunningProxy {
  server: Server;
  port: number;
  close(): Promise<void>;
  /** Counters for the per-execution summary (§45). */
  readonly stats: { allowed: number; denied: number; deniedHosts: string[] };
}

/** Bytes are counted, never inspected. */
interface Tally {
  up: number;
  down: number;
}

export class EgressProxy {
  private readonly policy: ProxyPolicy;
  private readonly limits: ProxyLimits;
  private readonly audit: (record: EgressAuditRecord) => void;
  private readonly resolveHost: (host: string) => Promise<string[]>;
  private readonly dial: (address: string, port: number) => Socket;
  private readonly open = new Set<Socket>();

  readonly stats = { allowed: 0, denied: 0, deniedHosts: [] as string[] };

  constructor(opts: ProxyOptions) {
    this.policy = opts.policy;
    this.limits = { ...DEFAULT_PROXY_LIMITS, ...(opts.limits ?? {}) };
    this.audit = opts.audit ?? defaultAudit;
    this.resolveHost = opts.resolve ?? defaultResolve(this.limits.maxDnsAnswers);
    this.dial = opts.dial ?? ((address, port) => netConnect({ host: address, port }));
  }

  listen(port: number, host = '0.0.0.0'): Promise<RunningProxy> {
    const server = createServer({ noDelay: true });
    server.on('connection', (socket) => {
      void this.handle(socket);
    });
    // A listener that throws on a client error would take the whole sidecar down
    // and turn a malformed request into a denial of service against the
    // execution. Client errors are per-connection events.
    server.on('clientError', () => {});

    return new Promise<RunningProxy>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const address = server.address();
        const boundPort = typeof address === 'object' && address !== null ? address.port : port;
        resolve({
          server,
          port: boundPort,
          stats: this.stats,
          close: async () => {
            for (const socket of this.open) socket.destroy();
            this.open.clear();
            await new Promise<void>((done) => server.close(() => done()));
          },
        });
      });
    });
  }

  private record(decision: EgressDecision, started: number, tally?: Tally): void {
    if (decision.allowed) {
      this.stats.allowed += 1;
    } else {
      this.stats.denied += 1;
      if (decision.host && !this.stats.deniedHosts.includes(decision.host)) {
        // Bounded: a workload that tries a thousand hosts must not turn the
        // summary into an unbounded buffer.
        if (this.stats.deniedHosts.length < 32) this.stats.deniedHosts.push(decision.host);
      }
    }
    this.audit({
      t: 'egress',
      executionId: this.policy.executionId,
      decision: decision.allowed ? 'allowed' : 'denied',
      reason: decision.reason,
      ...(decision.protocol ? { protocol: decision.protocol } : {}),
      ...(decision.host ? { host: decision.host } : {}),
      ...(decision.port !== undefined ? { port: decision.port } : {}),
      ...(decision.addressScope ? { addressScope: decision.addressScope } : {}),
      ...(tally ? { bytesUp: tally.up, bytesDown: tally.down } : {}),
      durationMs: Date.now() - started,
    });
  }

  private async handle(client: Socket): Promise<void> {
    const started = Date.now();

    if (this.open.size >= this.limits.maxConnections) {
      // §60: refuse, rather than stop tracking connections and keep serving.
      this.record(
        {
          allowed: false,
          reason: 'too-many-connections',
          detail: 'the proxy is at its concurrent connection limit for this execution',
        },
        started,
      );
      respond(client, 503, 'too-many-connections', 'the proxy is at its concurrent connection limit');
      return;
    }
    this.open.add(client);
    client.on('error', () => client.destroy());
    client.on('close', () => this.open.delete(client));

    const head = await readHead(client, this.limits.headTimeoutMs);
    if (head.kind !== 'ok') {
      this.record({ allowed: false, reason: 'request-malformed', detail: head.reason }, started);
      respond(client, head.status, 'request-malformed', head.reason);
      return;
    }

    const framing = checkFraming(head.head);
    if (!framing.ok) {
      this.record({ allowed: false, reason: 'request-malformed', detail: framing.reason }, started);
      respond(client, framing.status, 'request-malformed', framing.reason);
      return;
    }

    if (head.head.method.toUpperCase() === 'CONNECT') {
      await this.handleConnect(client, head.head.target, head.rest, started);
      return;
    }
    await this.handleHttp(client, head.head, head.rest, started);
  }

  // --- HTTP (§26) ----------------------------------------------------------

  private async handleHttp(
    client: Socket,
    head: import('./http.ts').HttpRequestHead,
    rest: Buffer,
    started: number,
  ): Promise<void> {
    const absolute = parseAbsoluteTarget(head.target);
    if (!absolute.ok) {
      this.record({ allowed: false, reason: 'request-malformed', detail: absolute.reason }, started);
      respond(client, 400, 'request-malformed', absolute.reason);
      return;
    }
    const hostHeader = singleHostHeader(head);
    if (!hostHeader.ok) {
      this.record({ allowed: false, reason: 'request-malformed', detail: hostHeader.reason }, started);
      respond(client, 400, 'request-malformed', hostHeader.reason);
      return;
    }

    // §34 before §21: an ambiguous request is refused before anything asks
    // whether either of its two candidate destinations was approved.
    const agreement = decideAuthorityAgreement(absolute.target.host, absolute.target.port, hostHeader.value);
    if (!agreement.allowed) {
      this.record(agreement, started);
      respond(client, 400, agreement.reason, agreement.detail);
      return;
    }

    const destination = decideDestination(this.policy, absolute.target.host, absolute.target.port, 'http');
    if (!destination.allowed) {
      this.record(destination, started);
      respond(client, 403, destination.reason, destination.detail);
      return;
    }

    const address = await this.resolveAndCheck(destination.host!, started);
    if (!address.ok) {
      respond(client, address.status, address.decision.reason, address.decision.detail);
      return;
    }

    const upstream = this.dial(address.address, absolute.target.port);
    const tally: Tally = { up: 0, down: 0 };
    const connected = await waitConnected(upstream, this.limits.connectTimeoutMs);
    if (!connected) {
      this.record(
        {
          ...destination,
          allowed: false,
          reason: 'resolution-failed',
          detail: 'the upstream connection failed',
        },
        started,
        tally,
      );
      respond(client, 502, 'resolution-failed', 'the approved destination could not be reached');
      upstream.destroy();
      return;
    }

    // The head is rebuilt in origin form; the path, query and body are relayed
    // untouched and unread.
    const rewritten = buildOriginRequest(head, absolute.target, hostHeader.value);
    upstream.write(rewritten);
    tally.up += rewritten.length;
    if (rest.length > 0) {
      upstream.write(rest);
      tally.up += rest.length;
    }

    this.record(destination, started, tally);
    this.pipe(client, upstream, tally, destination, started);
  }

  // --- HTTPS CONNECT (§27–§29) ---------------------------------------------

  private async handleConnect(client: Socket, target: string, rest: Buffer, started: number): Promise<void> {
    const parsed = parseConnectTarget(target);
    if (!parsed.ok) {
      this.record({ allowed: false, reason: 'request-malformed', detail: parsed.reason }, started);
      respond(client, 400, 'request-malformed', parsed.reason);
      return;
    }

    // §33: `CONNECT allowed.example:22` is denied even though the host is
    // approved, because 22 is outside the protocol scope the proxy can validate.
    const protocol: EgressProtocol = parsed.port === HTTP_PORT ? 'http' : 'https';
    const destination = decideDestination(this.policy, parsed.host, parsed.port, protocol);
    if (!destination.allowed) {
      this.record(destination, started);
      respond(client, 403, destination.reason, destination.detail);
      return;
    }
    const host = destination.host!;
    const targetKind = this.policy.targets.find((t) => t.host === host)?.kind ?? 'domain';

    // Resolve and classify *before* acknowledging the tunnel.
    //
    // The first version did this after the 200, which was correct and
    // unhelpful: once the tunnel is open there is no way to send an HTTP error,
    // so an address denial reached the user as `SSL_ERROR_SYSCALL` — a TLS
    // failure for something that was never a TLS problem. The dogfood run hit
    // this on every request and the transcript said nothing about why.
    //
    // Nothing is weakened by moving it: the address is only *used* after the SNI
    // check below, so no packet reaches the destination until its identity has
    // been verified (§57). What changes is that a denial now carries its reason.
    const address = await this.resolveAndCheck(host, started);
    if (!address.ok) {
      respond(client, address.status, address.decision.reason, address.decision.detail);
      return;
    }

    // The 200 has to come after: the client will not send its ClientHello until
    // the tunnel is acknowledged, and the ClientHello is what carries the name.
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    let identity: EgressDecision;
    let hello: Buffer;
    if (parsed.port === HTTPS_PORT) {
      const captured = await readClientHello(client, rest, this.limits.headTimeoutMs);
      hello = captured.buffer;
      identity = decideSni(host, targetKind, captured.result);
    } else {
      // Plain HTTP through a CONNECT tunnel carries no TLS identity, so the
      // authority check is all there is. It is still bounded by the allowlist
      // and the address policy.
      hello = rest;
      identity = {
        allowed: true,
        reason: 'allowed',
        host,
        port: parsed.port,
        protocol,
        detail: 'plaintext tunnel',
      };
    }

    if (!identity.allowed) {
      // Torn down having dialled nothing. The denied virtual host never saw a
      // packet, which is the §57 property.
      this.record(identity, started);
      client.destroy();
      return;
    }

    const upstream = this.dial(address.address, parsed.port);
    const tally: Tally = { up: 0, down: 0 };
    const connected = await waitConnected(upstream, this.limits.connectTimeoutMs);
    if (!connected) {
      this.record(
        {
          ...destination,
          allowed: false,
          reason: 'resolution-failed',
          detail: 'the upstream connection failed',
        },
        started,
        tally,
      );
      upstream.destroy();
      client.destroy();
      return;
    }

    if (hello.length > 0) {
      upstream.write(hello);
      tally.up += hello.length;
    }
    this.record({ ...destination, protocol }, started, tally);
    this.pipe(client, upstream, tally, destination, started);
  }

  // --- shared --------------------------------------------------------------

  /**
   * Resolve, classify and pick an address (§24, §25).
   *
   * Returns the *literal* the caller must dial. Every answer is classified and
   * the first global one wins; if none is global the request is denied with the
   * scope of the first answer, so the audit line says `metadata` or `loopback`
   * rather than a generic failure.
   */
  private async resolveAndCheck(
    host: string,
    started: number,
  ): Promise<{ ok: true; address: string } | { ok: false; status: number; decision: EgressDecision }> {
    // An IP-literal target needs no resolution — and must not get one, since a
    // resolver would happily treat it as a name in some configurations.
    const asLiteral = normalizeHost(host);
    if (asLiteral.ok && asLiteral.kind !== 'domain') {
      const decision = decideAddress(this.policy, host, asLiteral.host);
      if (!decision.allowed) {
        this.record(decision, started);
        return { ok: false, status: 403, decision };
      }
      return { ok: true, address: asLiteral.host };
    }

    let addresses: string[];
    try {
      addresses = await this.resolveHost(host);
    } catch (e) {
      const decision: EgressDecision = {
        allowed: false,
        reason: 'resolution-failed',
        host,
        detail: `${host} could not be resolved${e instanceof Error && e.message.includes('too many') ? ': too many answers' : ''}`,
      };
      this.record(decision, started);
      return { ok: false, status: 502, decision };
    }
    if (addresses.length === 0) {
      const decision: EgressDecision = {
        allowed: false,
        reason: 'resolution-failed',
        host,
        detail: `${host} resolved to no addresses`,
      };
      this.record(decision, started);
      return { ok: false, status: 502, decision };
    }

    let firstDenial: EgressDecision | undefined;
    for (const candidate of addresses) {
      const decision = decideAddress(this.policy, host, candidate);
      if (decision.allowed) return { ok: true, address: candidate };
      firstDenial ??= decision;
    }
    // Every answer was non-global: the rebinding case. Denied with the scope.
    const decision = firstDenial!;
    this.record(decision, started);
    return { ok: false, status: 403, decision };
  }

  /**
   * Relay bytes in both directions, counting them.
   *
   * `pipe` rather than manual pumping would be shorter; it is written out
   * because the byte tally is part of the audit record and because a half-open
   * socket must not leave the other side hanging until the idle timeout.
   */
  private pipe(
    client: Socket,
    upstream: Socket,
    tally: Tally,
    decision: EgressDecision,
    started: number,
  ): void {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      client.destroy();
      upstream.destroy();
      this.audit({
        t: 'egress',
        executionId: this.policy.executionId,
        decision: 'allowed',
        reason: 'allowed',
        ...(decision.protocol ? { protocol: decision.protocol } : {}),
        ...(decision.host ? { host: decision.host } : {}),
        ...(decision.port !== undefined ? { port: decision.port } : {}),
        bytesUp: tally.up,
        bytesDown: tally.down,
        durationMs: Date.now() - started,
      });
    };

    client.setTimeout(this.limits.idleTimeoutMs, finish);
    upstream.setTimeout(this.limits.idleTimeoutMs, finish);

    client.on('data', (chunk: Buffer) => {
      tally.up += chunk.length;
      if (!upstream.write(chunk)) client.pause();
    });
    upstream.on('drain', () => client.resume());
    upstream.on('data', (chunk: Buffer) => {
      tally.down += chunk.length;
      if (!client.write(chunk)) upstream.pause();
    });
    client.on('drain', () => upstream.resume());

    client.on('end', () => upstream.end());
    upstream.on('end', () => client.end());
    client.on('close', finish);
    upstream.on('close', finish);
    client.on('error', finish);
    upstream.on('error', finish);
  }
}

// --- socket helpers --------------------------------------------------------

interface HeadRead {
  kind: 'ok';
  head: import('./http.ts').HttpRequestHead;
  /** Bytes that arrived after the head. Relayed, never parsed. */
  rest: Buffer;
}

async function readHead(
  socket: Socket,
  timeoutMs: number,
): Promise<HeadRead | { kind: 'error'; status: number; reason: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const done = (result: HeadRead | { kind: 'error'; status: number; reason: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      resolve(result);
    };

    const timer = setTimeout(
      () => done({ kind: 'error', status: 408, reason: 'the request head did not arrive in time' }),
      timeoutMs,
    );

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      // §60: the budget is a refusal, not a truncation.
      if (size > MAX_HEAD_BYTES) {
        done({ kind: 'error', status: 431, reason: 'the request head exceeded the proxy byte budget' });
        return;
      }
      const buffer = Buffer.concat(chunks);
      const parsed = parseRequestHead(buffer);
      if (parsed.kind === 'incomplete') return;
      if (parsed.kind === 'error') {
        done({ kind: 'error', status: parsed.status, reason: parsed.reason });
        return;
      }
      done({ kind: 'ok', head: parsed.head, rest: buffer.subarray(parsed.head.headBytes) });
    };

    const onError = (): void => done({ kind: 'error', status: 400, reason: 'the client connection failed' });
    const onEnd = (): void =>
      done({ kind: 'error', status: 400, reason: 'the client closed before sending a complete request' });

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

/**
 * Buffer the client's first bytes until the ClientHello can be judged.
 *
 * The buffer is capped at `MAX_CLIENT_HELLO_BYTES` and the cap produces a
 * `too-large` verdict, which `decideSni` turns into a denial (§31). Note what is
 * *not* here: any path where running out of budget results in forwarding the
 * bytes anyway.
 */
async function readClientHello(
  socket: Socket,
  seed: Buffer,
  timeoutMs: number,
): Promise<{ buffer: Buffer; result: ReturnType<typeof parseClientHello> }> {
  const initial = parseClientHello(seed);
  if (initial.kind !== 'incomplete') return { buffer: seed, result: initial };

  return new Promise((resolve) => {
    const chunks: Buffer[] = seed.length > 0 ? [seed] : [];
    let size = seed.length;
    let settled = false;

    const done = (buffer: Buffer, result: ReturnType<typeof parseClientHello>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      resolve({ buffer, result });
    };

    const timer = setTimeout(() => done(Buffer.concat(chunks), { kind: 'incomplete' }), timeoutMs);

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      const buffer = Buffer.concat(chunks);
      if (size > MAX_CLIENT_HELLO_BYTES) {
        done(buffer, { kind: 'too-large' });
        return;
      }
      const result = parseClientHello(buffer);
      if (result.kind === 'incomplete') return;
      done(buffer, result);
    };

    const onError = (): void => done(Buffer.concat(chunks), { kind: 'incomplete' });
    const onEnd = (): void => done(Buffer.concat(chunks), { kind: 'incomplete' });

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

function waitConnected(socket: Socket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const onConnect = (): void => done(true);
    const onError = (): void => done(false);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

/**
 * Write a refusal.
 *
 * The body carries the reason code and the safe sentence — and nothing from the
 * request. This is what lets `curl` print something the model can act on ("cdn.example
 * is not in the approved host set") without the proxy ever having echoed a URL.
 */
function respond(socket: Socket, status: number, reason: string, detail: string): void {
  const body = `${reason}: ${detail}\n`;
  const head =
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `X-Mycoder-Egress-Reason: ${reason}\r\n` +
    'Connection: close\r\n\r\n';
  try {
    socket.end(head + body);
  } catch {
    socket.destroy();
  }
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 403:
      return 'Forbidden';
    case 408:
      return 'Request Timeout';
    case 414:
      return 'URI Too Long';
    case 431:
      return 'Request Header Fields Too Large';
    case 502:
      return 'Bad Gateway';
    case 503:
      return 'Service Unavailable';
    case 505:
      return 'HTTP Version Not Supported';
    default:
      return 'Error';
  }
}

function defaultResolve(maxAnswers: number): (host: string) => Promise<string[]> {
  return async (host) => {
    const answers = await dnsLookup(host, { all: true, verbatim: true });
    // §25: a resolver answer larger than the budget is refused outright. Using
    // "the first few" would leave unchecked addresses in play, which is exactly
    // the unchecked-fallback case the rule forbids.
    if (answers.length > maxAnswers) {
      throw new Error(`resolver returned too many answers for ${host}`);
    }
    return answers.map((a) => a.address);
  };
}

function defaultAudit(record: EgressAuditRecord): void {
  // The sidecar's stdout is the audit channel; the kernel reads it with
  // `docker logs`. `process.stdout.write` rather than the kernel logger because
  // this module also runs *inside* the sidecar, where there is no kernel.
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
