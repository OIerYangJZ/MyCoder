/**
 * Egress proxy sidecar entrypoint (alpha.6 §16, §18, §19, §46).
 *
 * This is the process that runs *inside* the proxy container. It is the only
 * file in the kernel that is executed by a container rather than by the kernel,
 * which shapes everything about it:
 *
 *   - it reads its policy from a **file mounted read-only**, never from an
 *     argument or a socket, so there is no channel by which the workload could
 *     rewrite what it enforces (§19);
 *   - it re-validates that policy with `parseProxyPolicy` even though the kernel
 *     wrote it, because "we wrote it, so it is well-formed" is the assumption
 *     that makes a file mount an injection point;
 *   - it prints exactly one readiness line and then only audit records, because
 *     its stdout *is* the kernel's audit channel (`docker logs`), and it has no
 *     other way to talk to anything.
 *
 * The sidecar has no workspace mount, no credential environment, no home
 * directory and no container socket (§18). If it were compromised it would have
 * the one thing it cannot avoid having — a route to the internet — and nothing
 * else worth taking.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseProxyPolicy } from '../egress/network-mode.ts';
import { EgressProxy } from './proxy.ts';

/** Fixed, because the kernel puts it in the workload's `HTTP_PROXY` (§16). */
export const SIDECAR_PORT = 3128;
export const SIDECAR_POLICY_PATH = '/opt/mycoder-egress/policy.json';
/** The kernel waits for this exact line before starting the workload (§46). */
export const READY_LINE = 'mycoder-egress-proxy ready';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const policyPath = argv[0] ?? SIDECAR_POLICY_PATH;

  let text: string;
  try {
    text = await readFile(policyPath, 'utf8');
  } catch {
    process.stderr.write(`egress proxy: policy file ${policyPath} could not be read\n`);
    return 2;
  }

  const parsed = parseProxyPolicy(text);
  if (!parsed.ok) {
    // Fail closed and loudly. The kernel's health check times out, the execution
    // fails with NETWORK_ENFORCEMENT_SETUP_FAILED, and no workload starts (§39).
    process.stderr.write(`egress proxy: policy rejected: ${parsed.reason}\n`);
    return 2;
  }

  const proxy = new EgressProxy({ policy: parsed.policy });
  const running = await proxy.listen(SIDECAR_PORT);

  // The readiness contract. The workload does not start until the kernel has
  // seen this line, so a proxy that never becomes ready blocks the execution
  // rather than letting it run unprotected.
  process.stdout.write(
    `${READY_LINE} port=${running.port} execution=${parsed.policy.executionId} targets=${parsed.policy.targets.length}\n`,
  );

  const shutdown = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Resolves only on shutdown; the container's lifetime is this promise.
  await new Promise<void>(() => {});
  return 0;
}

// `import.meta.main` is Node 24+, and the image runs Node 22, so this is the
// portable form. It compares *module identity*, not filenames.
//
// The filename version — `argv[1].endsWith('main.ts')` — was written first and
// was wrong in a way the smoke suite caught immediately: the CLI's entrypoint is
// also called `main.ts`, so importing anything from this module made the agent
// start an egress proxy, fail to read `--print-config` as a policy file, and
// exit 2. Every kernel invocation, not just container ones.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      process.stderr.write(`egress proxy: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
