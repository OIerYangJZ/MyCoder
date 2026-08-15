/**
 * The egress decision (alpha.6 §21–§29, §59, §79).
 *
 * Every allow/deny in the proxy is made here, by a pure function over a frozen
 * policy. Nothing in this file opens a socket, resolves a name or reads a clock.
 *
 * That separation is not architectural taste. §59 requires the release evidence
 * to assert the *mechanism*, not just the outcome — "the connection failed"
 * proves nothing, and "the connection failed because the resolved address
 * classified as `metadata`" proves the rebinding defence ran. A decision function
 * that is pure can be unit-tested exhaustively over exactly the inputs the attack
 * matrix cares about, and the live test then only has to confirm that the wire
 * behaviour matches the decision the same function already made.
 *
 * Hence `EgressReason`: a closed set of codes that appear in the audit record, in
 * the ToolResult diagnostic and in the assertions of the adversarial suite.
 */

import { classifyAddress, normalizeHost, type AddressScope } from '../egress/host.ts';
import { findTarget, type EgressProtocol, type ProxyPolicy } from '../egress/network-mode.ts';

/**
 * Why a request was denied. Safe to log and safe to show the model (§45).
 *
 * None of these carry a path, a query, a header or a byte of payload — the
 * reason plus the normalised host is the whole vocabulary.
 */
export type EgressReason =
  | 'allowed'
  | 'host-not-normalizable'
  | 'host-not-allowed'
  | 'port-not-allowed'
  | 'protocol-not-allowed'
  | 'authority-mismatch'
  | 'sni-mismatch'
  | 'sni-missing'
  | 'sni-malformed'
  | 'sni-too-large'
  | 'sni-encrypted'
  | 'address-not-global'
  | 'resolution-failed'
  | 'request-malformed'
  | 'too-many-connections';

export interface EgressDecision {
  allowed: boolean;
  reason: EgressReason;
  /** Normalised destination, when it could be determined. For the audit line. */
  host?: string;
  port?: number;
  protocol?: EgressProtocol;
  /** Set when the denial was an address-scope refusal (§23). */
  addressScope?: AddressScope;
  /** One safe sentence, suitable for a proxy error body and the model. */
  detail: string;
}

const allow = (host: string, port: number, protocol: EgressProtocol): EgressDecision => ({
  allowed: true,
  reason: 'allowed',
  host,
  port,
  protocol,
  detail: `${protocol}://${host}:${port} is in the approved host set`,
});

/**
 * Stage one: is this destination in the policy at all?
 *
 * Runs before any DNS lookup, so a denied host is never even resolved — which
 * matters, because a DNS query for `attacker-controlled.example` is itself a
 * side channel out of the private network.
 */
export function decideDestination(
  policy: ProxyPolicy,
  rawHost: string,
  port: number,
  protocol: EgressProtocol,
): EgressDecision {
  const normalized = normalizeHost(rawHost);
  if (!normalized.ok) {
    return {
      allowed: false,
      reason: 'host-not-normalizable',
      detail: `the destination host could not be understood: ${normalized.reason}`,
    };
  }
  const host = normalized.host;

  if (!policy.protocols.includes(protocol)) {
    return {
      allowed: false,
      reason: 'protocol-not-allowed',
      host,
      port,
      detail: `${protocol} is outside the enforced protocol scope of this execution`,
    };
  }

  const target = findTarget(policy, host, port);
  if (target === undefined) {
    // Distinguishing "wrong host" from "right host, wrong port" is what makes
    // the §33 CONNECT-to-port-22 test assert a mechanism rather than a failure.
    const hostKnown = policy.targets.some((t) => t.host === host);
    return hostKnown
      ? {
          allowed: false,
          reason: 'port-not-allowed',
          host,
          port,
          detail: `${host} is approved, but port ${port} is outside the HTTP/HTTPS scope (80, 443)`,
        }
      : {
          allowed: false,
          reason: 'host-not-allowed',
          host,
          port,
          detail: `${host} is not in the approved host set for this execution`,
        };
  }
  if (!target.protocols.includes(protocol)) {
    return {
      allowed: false,
      reason: 'protocol-not-allowed',
      host,
      port,
      detail: `${protocol} is not approved for ${host}`,
    };
  }

  return allow(host, port, protocol);
}

/**
 * Stage two: may the proxy connect to *this address*?
 *
 * Called once per candidate address, after resolution and before `connect`, and
 * the address it approves is the address the caller must use — §24's rule that
 * the checked value and the connected value are the same value. A second
 * resolution between the two is the rebinding hole this exists to close.
 */
export function decideAddress(policy: ProxyPolicy, host: string, address: string): EgressDecision {
  const classification = classifyAddress(address);
  if (classification === undefined) {
    return {
      allowed: false,
      reason: 'resolution-failed',
      host,
      detail: `${host} resolved to something that is not a usable IP address`,
    };
  }
  // The one documented exception, and it is narrow: a single /15 that some
  // resolvers use as NAT space for public destinations. Everything else
  // non-global is still refused.
  const permittedByFlag =
    policy.allowPrivateAddresses || (classification.scope === 'benchmarking' && policy.allowBenchmarkRange);

  if (!classification.global && !permittedByFlag) {
    return {
      allowed: false,
      reason: 'address-not-global',
      host,
      addressScope: classification.scope,
      detail:
        `${host} resolved to a ${classification.scope} address, which scoped egress does not permit ` +
        '(alpha.6 §23)',
    };
  }
  return {
    allowed: true,
    reason: 'allowed',
    host,
    addressScope: classification.scope,
    detail: `${host} resolved to a ${classification.scope} address`,
  };
}

/**
 * Stage three, HTTP: do the absolute target and the `Host` header agree?
 *
 * §34's rule in one function: mismatch is a rejection, in both directions, and
 * the more permissive field is never preferred. Comparison is on normalised
 * hosts so that `Example.COM` and `example.com` are not treated as a mismatch —
 * that would be a false positive, and a check people route around is worse than
 * no check.
 */
export function decideAuthorityAgreement(
  targetHost: string,
  targetPort: number,
  hostHeader: string,
): EgressDecision {
  const target = normalizeHost(targetHost);
  if (!target.ok) {
    return {
      allowed: false,
      reason: 'host-not-normalizable',
      detail: `the request target host could not be understood: ${target.reason}`,
    };
  }

  // The Host header carries `host` or `host:port`; both forms are legal and both
  // have to mean the same destination as the target.
  const colon = hostHeader.lastIndexOf(':');
  const bracketed = hostHeader.startsWith('[');
  let headerHostText = hostHeader;
  let headerPort: number | undefined;
  if (bracketed) {
    const close = hostHeader.indexOf(']');
    if (close < 0) {
      return {
        allowed: false,
        reason: 'request-malformed',
        detail: 'the Host header has an unclosed IPv6 literal',
      };
    }
    headerHostText = hostHeader.slice(0, close + 1);
    const rest = hostHeader.slice(close + 1);
    if (rest.startsWith(':')) headerPort = Number(rest.slice(1));
    else if (rest !== '') {
      return {
        allowed: false,
        reason: 'request-malformed',
        detail: 'the Host header is not a valid authority',
      };
    }
  } else if (colon >= 0 && hostHeader.indexOf(':') === colon) {
    headerHostText = hostHeader.slice(0, colon);
    headerPort = Number(hostHeader.slice(colon + 1));
  } else if (colon >= 0) {
    return {
      allowed: false,
      reason: 'request-malformed',
      detail: 'the Host header is not a valid authority',
    };
  }

  const header = normalizeHost(headerHostText);
  if (!header.ok) {
    return {
      allowed: false,
      reason: 'request-malformed',
      detail: `the Host header could not be understood: ${header.reason}`,
    };
  }
  if (header.host !== target.host) {
    return {
      allowed: false,
      reason: 'authority-mismatch',
      host: target.host,
      detail:
        'the request target and the Host header name different destinations; the request is refused rather ' +
        'than resolved in favour of either (alpha.6 §34)',
    };
  }
  if (headerPort !== undefined && Number.isFinite(headerPort) && headerPort !== targetPort) {
    return {
      allowed: false,
      reason: 'authority-mismatch',
      host: target.host,
      detail: 'the request target and the Host header name different ports',
    };
  }

  return {
    allowed: true,
    reason: 'allowed',
    host: target.host,
    port: targetPort,
    protocol: 'http',
    detail: 'the request target and the Host header agree',
  };
}

/**
 * Stage three, HTTPS: does the ClientHello name the host the tunnel was for?
 *
 * `connectHost` has already been approved by `decideDestination`, so this is the
 * §28 check and nothing else — the tunnel is authorised for one name and the
 * bytes about to flow through it must be addressed to that name.
 *
 * `kind` is the target's address family from the policy. For an IP-literal
 * target there is no domain identity to check and no SNI is required; for a
 * domain target, *every* non-matching outcome is a denial, including the three
 * that are not mismatches at all — missing, malformed, oversized — because §29
 * and §31 both say the strict mode fails closed rather than degrading to a
 * weaker check.
 */
export function decideSni(
  connectHost: string,
  kind: 'domain' | 'ipv4' | 'ipv6',
  hello:
    | { kind: 'sni'; serverName: string; encryptedClientHello: boolean }
    | { kind: 'no-sni'; encryptedClientHello: boolean }
    | { kind: 'malformed'; reason: string }
    | { kind: 'not-tls'; reason: string }
    | { kind: 'not-client-hello'; reason: string }
    | { kind: 'too-large' }
    | { kind: 'incomplete' },
): EgressDecision {
  if (hello.kind === 'too-large') {
    return {
      allowed: false,
      reason: 'sni-too-large',
      host: connectHost,
      detail:
        'the TLS ClientHello exceeded the parser budget; the connection is denied rather than tunnelled unchecked',
    };
  }
  if (hello.kind === 'malformed' || hello.kind === 'not-client-hello') {
    return {
      allowed: false,
      reason: 'sni-malformed',
      host: connectHost,
      detail: `the TLS ClientHello could not be parsed (${hello.reason})`,
    };
  }
  if (hello.kind === 'not-tls') {
    return {
      allowed: false,
      reason: 'sni-malformed',
      host: connectHost,
      detail: `the CONNECT tunnel did not begin with a TLS ClientHello (${hello.reason})`,
    };
  }
  if (hello.kind === 'incomplete') {
    return {
      allowed: false,
      reason: 'sni-missing',
      host: connectHost,
      detail: 'the TLS ClientHello never arrived complete within the parser budget',
    };
  }

  if (hello.encryptedClientHello) {
    // §30: ECH is a real feature and a real problem for this check. Denying is
    // the honest answer; silently relaying while still reporting "host-enforced"
    // would be the overclaim the whole milestone is built to avoid.
    return {
      allowed: false,
      reason: 'sni-encrypted',
      host: connectHost,
      detail:
        'the ClientHello uses Encrypted Client Hello, so the destination identity cannot be verified; ' +
        'strict host-scoped HTTPS denies rather than downgrading (alpha.6 §30)',
    };
  }

  if (kind !== 'domain') {
    // An IP-literal target was approved as an address, and an address has no
    // domain identity. Requiring an SNI here would break a legitimate
    // `https://10.0.0.5` style target without adding a check that means anything.
    return {
      allowed: true,
      reason: 'allowed',
      host: connectHost,
      protocol: 'https',
      detail: 'the approved target is an IP literal, which carries no domain identity to verify',
    };
  }

  if (hello.kind === 'no-sni') {
    return {
      allowed: false,
      reason: 'sni-missing',
      host: connectHost,
      detail:
        'the ClientHello carries no server name, so the destination cannot be verified against the approved ' +
        'host (alpha.6 §29)',
    };
  }

  const sni = normalizeHost(hello.serverName);
  if (!sni.ok) {
    return {
      allowed: false,
      reason: 'sni-malformed',
      host: connectHost,
      detail: `the ClientHello server name is not a usable host: ${sni.reason}`,
    };
  }
  if (sni.host !== connectHost) {
    return {
      allowed: false,
      reason: 'sni-mismatch',
      host: connectHost,
      detail:
        `the CONNECT authority named ${connectHost} but the TLS ClientHello asked for ${sni.host}; a shared ` +
        'IP would otherwise serve the second name through a tunnel authorised for the first (alpha.6 §28)',
    };
  }

  return {
    allowed: true,
    reason: 'allowed',
    host: connectHost,
    protocol: 'https',
    detail: 'the CONNECT authority and the TLS server name agree',
  };
}

/** Map a decision onto the §79 error vocabulary, for ToolResult and audit. */
export function errorCodeFor(reason: EgressReason): string {
  switch (reason) {
    case 'allowed':
      return 'OK';
    case 'host-not-allowed':
    case 'port-not-allowed':
      return 'NETWORK_SCOPE_DENIED';
    case 'protocol-not-allowed':
      return 'NETWORK_PROTOCOL_UNSUPPORTED';
    case 'address-not-global':
      return 'NETWORK_TARGET_ADDRESS_DENIED';
    case 'resolution-failed':
      return 'NETWORK_TARGET_RESOLUTION_FAILED';
    case 'authority-mismatch':
    case 'sni-mismatch':
    case 'sni-missing':
    case 'sni-malformed':
    case 'sni-too-large':
    case 'sni-encrypted':
      return 'NETWORK_IDENTITY_MISMATCH';
    case 'host-not-normalizable':
    case 'request-malformed':
    case 'too-many-connections':
      return 'NETWORK_SCOPE_DENIED';
  }
}
