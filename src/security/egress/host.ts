/**
 * Host and address normalisation for scoped egress (alpha.6 §20, §21, §23, ADR-0015).
 *
 * There is exactly one normalisation function in the kernel, and this is it. That
 * is not tidiness — it is the whole mechanism. A scoped-egress decision is made
 * four times on four different strings:
 *
 *     the approval subject          "registry.npmjs.org"
 *     the frozen proxy policy       "registry.npmjs.org"
 *     the CONNECT authority         "REGISTRY.npmjs.org."
 *     the TLS SNI                   "registry.npmjs.org"
 *
 * and if any two of those are compared after being canonicalised by *different*
 * code, the difference between them is a bypass. `registry.npmjs.org.` with a
 * trailing dot is the same DNS name and a different JavaScript string; so is the
 * IDNA form of a Unicode homograph; so is `[::ffff:93.184.216.34]` versus
 * `93.184.216.34`. §20 therefore requires one function used everywhere, and
 * `normalizeHost` is called by the policy builder, the approval subject, the
 * proxy's HTTP path, its CONNECT path and its SNI check alike.
 *
 * The second half of the file answers a different question: not "what is this
 * name" but "is this address one the workload may be pointed at". §23's rule is
 * that scoped egress is for *global* destinations, so loopback, RFC1918,
 * link-local — and in particular `169.254.169.254`, the cloud metadata address —
 * are denied whatever hostname resolved to them. That is what makes a DNS
 * rebinding attack fail: `allowed.example` may legitimately be in the policy, and
 * it still cannot be used to reach `127.0.0.1`, because the check is on the
 * address the proxy is about to connect to rather than on the name it was given.
 *
 * Everything here is pure and fails closed: an input that cannot be understood
 * produces a rejection, never a "probably fine" pass-through.
 */

/** §60/§61: a host longer than DNS permits is invalid, not truncated. */
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

export interface NormalizedHost {
  /** The canonical form used for every comparison and every audit record. */
  host: string;
  /**
   * What kind of destination this names.
   *
   * The distinction is load-bearing at the TLS layer: §29 requires SNI to equal
   * the CONNECT authority for a *domain* claim, and an IP literal has no SNI to
   * check, so an `ip` target can never satisfy a domain-enforced HTTPS rule.
   */
  kind: 'domain' | 'ipv4' | 'ipv6';
}

export interface HostNormalizationFailure {
  ok: false;
  reason: string;
}

export type HostNormalization = ({ ok: true } & NormalizedHost) | HostNormalizationFailure;

const fail = (reason: string): HostNormalizationFailure => ({ ok: false, reason });

/**
 * Canonicalise one host string.
 *
 * The rejections matter more than the transformations. `user@evil.example`,
 * `https://allowed.example`, `allowed.example/path` and `allowed.example:443`
 * are all inputs that a permissive parser turns into *some* hostname — usually
 * the wrong one — and each of them is a documented way to make an allowlist
 * check and a connection disagree about the destination. None of them is a
 * hostname, so none of them is accepted here; the caller that legitimately has a
 * `host:port` pair splits it first, with `splitHostPort`, which knows the
 * difference between IPv6 colons and a port separator.
 */
export function normalizeHost(input: string): HostNormalization {
  if (typeof input !== 'string') return fail('host is not a string');
  const raw = input.trim();
  if (raw === '') return fail('host is empty');
  if (raw.length > MAX_HOST_LENGTH + 2) return fail(`host exceeds ${MAX_HOST_LENGTH} characters`);

  // Control characters, whitespace and NUL: request-smuggling material, never a
  // legitimate hostname.
  if (/[\0-\x20\x7f]/.test(raw)) return fail('host contains a control character or whitespace');
  if (raw.includes('@')) return fail('host contains userinfo syntax');
  if (raw.includes('/') || raw.includes('\\')) return fail('host contains a path separator');
  if (raw.includes('?') || raw.includes('#')) return fail('host contains a query or fragment');

  // IPv6 literal, with or without brackets.
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) return fail('bracketed IPv6 literal is not closed');
    const inner = raw.slice(1, -1);
    const v6 = normalizeIPv6(inner);
    return v6 === undefined ? fail('invalid IPv6 literal') : { ok: true, host: v6, kind: 'ipv6' };
  }
  if (raw.includes(':')) {
    const v6 = normalizeIPv6(raw);
    // A bare `host:port` reaching here is a caller bug, and guessing which half
    // was meant is exactly the ambiguity §34 says never to resolve by preference.
    return v6 === undefined
      ? fail('host contains a colon; pass host and port separately')
      : { ok: true, host: v6, kind: 'ipv6' };
  }

  let host = raw.toLowerCase();
  // A single terminal dot is the DNS root and is legal; two is not.
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return fail('host is only a dot');
  if (host.endsWith('.')) return fail('host has an empty terminal label');

  const v4 = normalizeIPv4(host);
  if (v4 !== undefined) return { ok: true, host: v4, kind: 'ipv4' };
  // Something that looks numeric but did not parse as strict dotted-quad —
  // `1.2.3.4.5`, `999.1.1.1`, `2130706433` — is refused rather than treated as a
  // domain, because a resolver would turn some of them back into an address the
  // policy never approved.
  if (/^[0-9.]+$/.test(host)) return fail('host looks like an IPv4 literal but is not a valid one');
  // The same refusal, for the spellings that are not all-decimal.
  //
  // Found by the unit test: `0x7f.0.0.1` has no character outside LDH, so it
  // passed the domain checks and was normalised as a *hostname* — and
  // `getaddrinfo` would then hand it to `inet_aton`, which reads it as
  // 127.0.0.1. The policy would have recorded a domain nobody can register and
  // the connection would have gone to loopback. `decideAddress` catches the
  // result on the way out, so this was defence in depth rather than a live hole,
  // but a name that means an address must not be spelled as a name here.
  if (looksLikeLegacyIPv4(host)) {
    return fail('host is an alternate (octal/hex/short) spelling of an IPv4 address');
  }

  // IDNA → ASCII via the URL parser, which is the platform's own UTS-46
  // implementation. Doing this by hand would be a second, disagreeing
  // punycode encoder, and §20 exists to prevent exactly that.
  let ascii = host;
  if (/[^\x00-\x7f]/.test(host)) {
    let url: URL;
    try {
      url = new URL(`http://${host}`);
    } catch {
      return fail('host is not encodable as an internationalised domain name');
    }
    ascii = url.hostname;
    // The parser is also the one component that can tell us the name was
    // *unencodable*: it emits a percent-escape or leaves the Unicode in place.
    if (ascii === '' || /[^a-z0-9.\-]/.test(ascii))
      return fail('host contains characters that are not a domain');
  }

  if (ascii.length > MAX_HOST_LENGTH) return fail(`host exceeds ${MAX_HOST_LENGTH} characters`);
  const labels = ascii.split('.');
  for (const label of labels) {
    if (label === '') return fail('host contains an empty label');
    if (label.length > MAX_LABEL_LENGTH) return fail(`host label exceeds ${MAX_LABEL_LENGTH} characters`);
    if (!/^[a-z0-9-]+$/.test(label)) return fail('host label contains a character that is not LDH');
    if (label.startsWith('-') || label.endsWith('-')) return fail('host label starts or ends with a hyphen');
  }
  // `*.example.com` would have been rejected by the LDH check above; saying so
  // explicitly is worth a line, because "the wildcard was silently treated as a
  // literal label" is the failure mode §21 is guarding against.
  if (ascii.includes('*')) return fail('wildcard hosts are not supported (alpha.6 §21)');

  return { ok: true, host: ascii, kind: 'domain' };
}

/**
 * True for the `inet_aton` spellings of an IPv4 address that are not dotted quad.
 *
 * `getaddrinfo` accepts one to four parts, each decimal, octal (`0177`) or hex
 * (`0x7f`), and folds the trailing part over the remaining octets — so
 * `0x7f.0.0.1`, `127.1` and `0177.0.0.1` are all loopback. None of them is a
 * registrable domain name (RFC 3696 forbids an all-numeric TLD, and no registry
 * issues `0x7f`), so refusing them costs nothing and removes a whole family of
 * "the policy string and the connected address are different things" bugs.
 */
function looksLikeLegacyIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((p) => /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(p));
}

/** Normalise, or throw the reason away and return undefined. For predicates. */
export function normalizeHostOrUndefined(input: string): string | undefined {
  const r = normalizeHost(input);
  return r.ok ? r.host : undefined;
}

/**
 * Split an authority into host and port.
 *
 * `[::1]:443` and `example.com:443` are both authorities and only one of them
 * can be split on the last colon, which is why this is a function rather than
 * three call sites doing it slightly differently.
 */
export function splitHostPort(
  authority: string,
  defaultPort?: number,
): { host: string; port: number } | undefined {
  const raw = authority.trim();
  if (raw === '') return undefined;

  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return undefined;
    const host = raw.slice(0, close + 1);
    const rest = raw.slice(close + 1);
    if (rest === '') return defaultPort === undefined ? undefined : { host, port: defaultPort };
    if (!rest.startsWith(':')) return undefined;
    const port = parsePort(rest.slice(1));
    return port === undefined ? undefined : { host, port };
  }

  const colon = raw.lastIndexOf(':');
  if (colon < 0) {
    return defaultPort === undefined ? undefined : { host: raw, port: defaultPort };
  }
  // More than one colon and no brackets: an unbracketed IPv6 literal, which is
  // not a valid authority. Refusing keeps `::1:443` from being read as host
  // `::1` port `443` by one parser and host `::1:443` by another.
  if (raw.indexOf(':') !== colon) return undefined;
  const port = parsePort(raw.slice(colon + 1));
  if (port === undefined) return undefined;
  return { host: raw.slice(0, colon), port };
}

export function parsePort(text: string): number | undefined {
  if (!/^[0-9]{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

// --- IP literals -----------------------------------------------------------

/**
 * Strict dotted-quad only.
 *
 * Deliberately *not* `inet_aton` semantics. `0177.0.0.1`, `0x7f.1`, `2130706433`
 * and `127.1` are all `127.0.0.1` to the C resolver and to curl, and all four
 * are ways to write an address that does not look like the one being written.
 * A policy is only checkable if there is one spelling of each address.
 */
export function normalizeIPv4(text: string): string | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return undefined;
    // A leading zero is the octal spelling; refuse rather than pick a reading.
    if (part.length > 1 && part.startsWith('0')) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return octets.join('.');
}

/**
 * Canonical (RFC 5952) IPv6, lower case, longest zero-run compressed.
 *
 * IPv4-mapped forms are folded to their IPv4 spelling: `::ffff:127.0.0.1` is
 * loopback, and a classifier that only looked at the v6 form would not say so.
 */
export function normalizeIPv6(text: string): string | undefined {
  const groups = parseIPv6Groups(text);
  if (groups === undefined) return undefined;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const a = groups[6]!;
    const b = groups[7]!;
    return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
  }

  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let i = 0; i <= groups.length; i += 1) {
    if (i < groups.length && groups[i] === 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const length = i - start;
      if (length > bestLength) {
        bestLength = length;
        bestStart = start;
      }
      start = -1;
    }
  }
  // A single zero group is written `0`, not `::` (RFC 5952 §4.2.2).
  if (bestLength < 2) {
    return groups.map((g) => g.toString(16)).join(':');
  }
  const head = groups
    .slice(0, bestStart)
    .map((g) => g.toString(16))
    .join(':');
  const tail = groups
    .slice(bestStart + bestLength)
    .map((g) => g.toString(16))
    .join(':');
  return `${head}::${tail}`;
}

function parseIPv6Groups(text: string): number[] | undefined {
  if (text === '' || /[^0-9a-fA-F:.]/.test(text)) return undefined;
  // A zone identifier (`fe80::1%eth0`) names an interface, which is meaningless
  // for a destination policy and is a private-scope address in every case.
  if (text.includes('%')) return undefined;

  let head = text;
  let trailingV4: number[] | undefined;
  const lastColon = head.lastIndexOf(':');
  if (head.includes('.')) {
    const v4 = normalizeIPv4(head.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    const octets = v4.split('.').map(Number);
    trailingV4 = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    head = head.slice(0, lastColon + 1);
    if (!head.endsWith(':')) return undefined;
    head = head.slice(0, -1);
  }

  const doubleColon = head.indexOf('::');
  let left: string[];
  let right: string[];
  if (doubleColon >= 0) {
    if (head.indexOf('::', doubleColon + 1) >= 0) return undefined;
    const leftText = head.slice(0, doubleColon);
    const rightText = head.slice(doubleColon + 2);
    left = leftText === '' ? [] : leftText.split(':');
    right = rightText === '' ? [] : rightText.split(':');
  } else {
    left = head === '' ? [] : head.split(':');
    right = [];
  }

  const parseGroup = (g: string): number | undefined => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    return parseInt(g, 16);
  };

  const leftGroups: number[] = [];
  for (const g of left) {
    const v = parseGroup(g);
    if (v === undefined) return undefined;
    leftGroups.push(v);
  }
  const rightGroups: number[] = [];
  for (const g of right) {
    const v = parseGroup(g);
    if (v === undefined) return undefined;
    rightGroups.push(v);
  }

  const total = leftGroups.length + rightGroups.length + (trailingV4 ? 2 : 0);
  if (doubleColon < 0) {
    if (total !== 8) return undefined;
    return [...leftGroups, ...(trailingV4 ?? [])];
  }
  if (total > 7) return undefined;
  const zeros = new Array<number>(8 - total).fill(0);
  return [...leftGroups, ...zeros, ...rightGroups, ...(trailingV4 ?? [])];
}

// --- address scope ---------------------------------------------------------

/**
 * Why an address is not a legitimate scoped-egress destination.
 *
 * A reason code rather than a boolean because §59 requires the *mechanism* to be
 * assertable: a test that proves "the connection failed" proves nothing, and one
 * that proves "the connection failed because the resolved address was classified
 * `metadata`" proves the rebinding defence ran.
 */
export type AddressScope =
  | 'global'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'metadata'
  | 'cgnat'
  | 'multicast'
  | 'unspecified'
  /**
   * RFC 2544 benchmarking space, `198.18.0.0/15`.
   *
   * Broken out of `reserved` because of something the alpha.6 dogfood found on a
   * real machine: some resolvers — DNS-interception VPNs, and Docker Desktop in
   * certain configurations — map *public* hostnames into this range and NAT them
   * to the real destination. On such a host every legitimate name resolves into
   * a block that §23 correctly refuses, and scoped egress denies the whole
   * internet.
   *
   * The strict default does not change: this is still non-global and still
   * denied. What the separate scope buys is an explicit, auditable opt-in
   * (`ProxyPolicy.allowBenchmarkRange`) for deployments that are actually behind
   * such a resolver, and an audit line that says `benchmarking` rather than a
   * generic `reserved` — so the operator can tell "my resolver is unusual" from
   * "something pointed a name at reserved space".
   */
  | 'benchmarking'
  | 'reserved';

export interface AddressClassification {
  scope: AddressScope;
  /** True for exactly `scope === 'global'`. */
  global: boolean;
  family: 'ipv4' | 'ipv6';
}

/**
 * Classify a literal address (§23).
 *
 * `metadata` is broken out of `link-local` on purpose. `169.254.169.254` and
 * `fd00:ec2::254` are the cloud instance-credential endpoints, and an audit line
 * saying "denied: link-local" would be a true statement about the single most
 * important thing this check prevents.
 */
export function classifyAddress(literal: string): AddressClassification | undefined {
  const v4 = normalizeIPv4(literal);
  if (v4 !== undefined) return { ...classifyIPv4(v4), family: 'ipv4' };
  const v6 = normalizeIPv6(literal);
  if (v6 === undefined) return undefined;
  // `normalizeIPv6` folds IPv4-mapped addresses down to dotted quad, so this
  // reaches the v4 classifier through the same door an ordinary v4 address does.
  if (normalizeIPv4(v6) !== undefined) return { ...classifyIPv4(v6), family: 'ipv4' };
  return { ...classifyIPv6(v6), family: 'ipv6' };
}

function scoped(scope: AddressScope): { scope: AddressScope; global: boolean } {
  return { scope, global: scope === 'global' };
}

function classifyIPv4(address: string): { scope: AddressScope; global: boolean } {
  const [a, b] = address.split('.').map(Number) as [number, number, number, number];

  if (a === 0) return scoped('unspecified');
  if (a === 127) return scoped('loopback');
  if (a === 10) return scoped('private');
  if (a === 172 && b >= 16 && b <= 31) return scoped('private');
  if (a === 192 && b === 168) return scoped('private');
  if (a === 169 && b === 254) {
    return scoped(address === '169.254.169.254' ? 'metadata' : 'link-local');
  }
  if (a === 100 && b >= 64 && b <= 127) return scoped('cgnat');
  if (a === 192 && b === 0) return scoped('reserved'); // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return scoped('benchmarking'); // RFC 2544
  if (a === 198 && b === 51) return scoped('reserved'); // TEST-NET-2
  if (a === 203 && b === 0) return scoped('reserved'); // TEST-NET-3
  if (a >= 224 && a <= 239) return scoped('multicast');
  if (a >= 240) return scoped('reserved'); // 240/4 and 255.255.255.255
  return scoped('global');
}

function classifyIPv6(address: string): { scope: AddressScope; global: boolean } {
  if (address === '::') return scoped('unspecified');
  if (address === '::1') return scoped('loopback');
  // The AWS/GCP IPv6 metadata endpoints sit inside ULA space; name them first.
  if (address === 'fd00:ec2::254' || address === 'fd00:ec2::253') return scoped('metadata');
  const head = parseInt(address.split(':')[0] || '0', 16);
  // `::/8` is IANA-reserved. Everything global in it that we care about — the
  // IPv4-mapped range — has already been folded to dotted quad by
  // `normalizeIPv6`, so anything still spelled `::something` here is reserved
  // space (the deprecated IPv4-compatible block, `::1:443`, and friends) rather
  // than a reachable destination.
  if ((head & 0xff00) === 0x0000) return scoped('reserved');
  if ((head & 0xfe00) === 0xfc00) return scoped('private'); // fc00::/7 ULA
  if ((head & 0xffc0) === 0xfe80) return scoped('link-local'); // fe80::/10
  if ((head & 0xff00) === 0xff00) return scoped('multicast'); // ff00::/8
  if (address.startsWith('2001:db8:') || address === '2001:db8::') return scoped('reserved');
  if (address.startsWith('64:ff9b:')) return scoped('reserved'); // NAT64
  if (address.startsWith('100::')) return scoped('reserved'); // discard-only
  return scoped('global');
}

/** True when the address may be connected to under the default §23 policy. */
export function isGlobalAddress(literal: string): boolean {
  return classifyAddress(literal)?.global === true;
}
