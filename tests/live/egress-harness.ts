/**
 * Controlled egress topology for the alpha.6 attack matrix (§55–§57).
 *
 * §56 says to prefer local test targets over public websites, and the reason is
 * not flakiness alone. A suite pointed at `example.com` cannot prove the third
 * column of §58's matrix: to show that a denial was a *denial* and not a broken
 * fixture, the test has to be able to reach the denied target under a contrast
 * configuration — and reaching a real third-party host from CI to prove a
 * negative is both unreliable and rude.
 *
 * So the topology is entirely local:
 *
 *     target-allowed   a container serving its own name over HTTP and HTTPS
 *     target-denied    an identical container, different name
 *     proxy            resolves both by name via /etc/hosts entries
 *     workload         on the private network, reaching only the proxy
 *
 * Both targets are real servers on real addresses. `allowed.test` and
 * `denied.test` are real names as far as the proxy is concerned. What makes the
 * allowed one reachable and the denied one not is the policy, which is the thing
 * under test.
 *
 * The TLS target matters especially: §57 needs a server that will complete a
 * handshake for `allowed.test` so that "CONNECT allowed.test with SNI
 * denied.test" fails *at the proxy* rather than at a certificate check the proxy
 * had nothing to do with.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runDocker } from '../../src/execution/docker-cli.ts';
import { TEST_IMAGE } from './container-harness.ts';

/** Served by the allowed target, and by nothing else. */
export const ALLOWED_MARKER = 'served-by-allowed-target-4f2a91';
/** Served by the denied target. Its appearance anywhere is a bypass. */
export const DENIED_MARKER = 'served-by-denied-target-8c31de';

/**
 * A canary the workload will try to exfiltrate (§69).
 *
 * Deliberately *not* registered with SecretBroker and not recognisable to the
 * redactor: §69's point is that destination enforcement has to work on a secret
 * the kernel has never heard of, because content-based defences by definition
 * cannot.
 */
export const EGRESS_CANARY = 'EGRESS_CANARY_UNKNOWN_e91b73c5';

export interface EgressTarget {
  name: string;
  container: string;
  /** Address on the docker bridge, which is what the proxy will connect to. */
  address: string;
}

export interface EgressTopology {
  allowed: EgressTarget;
  denied: EgressTarget;
  /** `name:address` pairs for the proxy's /etc/hosts. */
  hostAliases: string[];
  /** Certificate authority-free: the targets use self-signed certificates. */
  cleanup(): Promise<void>;
}

/**
 * The target server, as a single Node script.
 *
 * Serves the same body on HTTP/80 and HTTPS/443 with a self-signed certificate
 * whose subject alternative names cover both target names — so a TLS handshake
 * succeeds for either name, and the *only* thing that can distinguish them is
 * the proxy's SNI check. A certificate that only covered one name would let a
 * mismatch fail at the TLS layer, and the test would pass without the proxy
 * having done anything.
 */
const TARGET_SCRIPT = `
const http = require('node:http');
const https = require('node:https');
const { generateKeyPairSync, X509Certificate, createPrivateKey } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const marker = process.env.TARGET_MARKER;
const body = (req) => marker + ' host=' + (req.headers.host || '') + ' url=' + (req.url || '');
const handler = (req, res) => {
  let payload = '';
  req.on('data', (c) => { if (payload.length < 65536) payload += c; });
  req.on('end', () => {
    // Echo what arrived so an exfiltration attempt is *observable* when it
    // succeeds: the denied target records what it received, which is how the
    // canary test proves the difference between "denied" and "quietly worked".
    fs.appendFileSync('/tmp/received.log', (req.url || '') + ' ' + payload + '\\n');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body(req));
  });
};

http.createServer(handler).listen(80, '0.0.0.0');

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', '/tmp/k.pem', '-out', '/tmp/c.pem', '-days', '1',
  '-subj', '/CN=allowed.test',
  '-addext', 'subjectAltName=DNS:allowed.test,DNS:denied.test']);
https.createServer(
  { key: fs.readFileSync('/tmp/k.pem'), cert: fs.readFileSync('/tmp/c.pem') },
  handler,
).listen(443, '0.0.0.0');

console.log('target ready');
`;

async function startTarget(binary: string, name: string, marker: string, id: string): Promise<EgressTarget> {
  const container = `mycoder-egress-target-${name}-${id}`;
  const run = await runDocker(
    binary,
    [
      'run',
      '--detach',
      '--name',
      container,
      '--network',
      'bridge',
      '--label',
      'mycoder.egress.test=1',
      '--env',
      `TARGET_MARKER=${marker}`,
      '--tmpfs',
      '/tmp:rw,size=16777216,mode=1777',
      '--entrypoint',
      'node',
      TEST_IMAGE,
      '-e',
      TARGET_SCRIPT,
    ],
    { timeoutMs: 60_000 },
  );
  if (run.exitCode !== 0) {
    throw new Error(`could not start the ${name} target: ${run.stderr.trim()}`);
  }

  // Wait for both listeners. A target that is not yet up would make an "allowed"
  // case fail and look like an enforcement result.
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const logs = await runDocker(binary, ['logs', container], { timeoutMs: 10_000 });
    if (logs.stdout.includes('target ready')) {
      ready = true;
      break;
    }
    const state = await runDocker(binary, ['inspect', '-f', '{{.State.Running}}', container], {
      timeoutMs: 10_000,
    });
    if (state.stdout.trim() === 'false') {
      throw new Error(`the ${name} target exited during startup: ${logs.stderr.trim().slice(0, 300)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error(`the ${name} target never became ready`);

  const inspect = await runDocker(
    binary,
    ['inspect', '-f', '{{index .NetworkSettings.Networks "bridge" "IPAddress"}}', container],
    { timeoutMs: 15_000 },
  );
  const address = inspect.stdout.trim();
  if (address === '') throw new Error(`the ${name} target has no bridge address`);

  return { name: `${name}.test`, container, address };
}

export async function createEgressTopology(binary = 'docker'): Promise<EgressTopology> {
  const id = Math.random().toString(36).slice(2, 10);
  const allowed = await startTarget(binary, 'allowed', ALLOWED_MARKER, id);
  let denied: EgressTarget;
  try {
    denied = await startTarget(binary, 'denied', DENIED_MARKER, id);
  } catch (e) {
    await runDocker(binary, ['rm', '-f', allowed.container], { timeoutMs: 30_000 }).catch(() => undefined);
    throw e;
  }

  return {
    allowed,
    denied,
    hostAliases: [`allowed.test:${allowed.address}`, `denied.test:${denied.address}`],
    async cleanup() {
      for (const container of [allowed.container, denied.container]) {
        await runDocker(binary, ['rm', '-f', container], { timeoutMs: 30_000 }).catch(() => undefined);
      }
    },
  };
}

/** What a target actually received, for proving an exfiltration did not land. */
export async function targetReceivedLog(binary: string, target: EgressTarget): Promise<string> {
  const result = await runDocker(binary, ['exec', target.container, 'cat', '/tmp/received.log'], {
    timeoutMs: 15_000,
  });
  return result.stdout;
}

/** A throwaway workspace for the egress suites; no protected files needed. */
export async function createEgressWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(path.join(tmpdir(), 'mycoder-egress-test-'));
  const workspace = path.join(base, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# egress fixture\n', 'utf8');
  return {
    root: workspace,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
}
