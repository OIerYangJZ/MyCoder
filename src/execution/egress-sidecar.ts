/**
 * Scoped-egress topology: private network + proxy sidecar (alpha.6 §12–§19, §46–§48, ADR-0015 §3).
 *
 * This module builds the thing that makes an approved host list mean something.
 * The shape, in the order it is created:
 *
 *     docker network create --internal mycoder-egress-<id>     no route to anywhere
 *     docker run -d --network bridge   <proxy>                 the egress-capable leg
 *     docker network connect <private> <proxy>                 the private leg
 *     wait for the readiness line on the proxy's stdout
 *     docker inspect → the proxy's address *on the private network*
 *     …workload runs on the private network, HTTP_PROXY → that address…
 *     docker rm -f <proxy>; docker network rm <private>        always, in finally
 *
 * Three properties are worth stating because each of them is a decision rather
 * than an implementation detail.
 *
 * **The workload is never attached to an internet-capable network.** Not for a
 * moment, not during setup. That is what makes `curl --noproxy '*'`, a raw
 * socket and a hand-rolled DNS query fail: there is no route, so there is nothing
 * to opt out of. `HTTP_PROXY` is a convenience for well-behaved clients, not the
 * boundary.
 *
 * **The proxy is an application proxy, not a router.** No `NET_ADMIN`, no
 * privileged flag, no host network, no IP forwarding. It also carries no
 * workspace mount, no secret environment, no home directory and no container
 * socket (§18): it is the one component with a route to the internet, so it is
 * the one component that must have nothing worth stealing.
 *
 * **Setup failure is execution failure (§39).** Every path out of `start()` that
 * is not a working topology throws. There is no branch in this file that
 * produces "warn and use bridge networking", because a security decision that
 * degrades into a log line is not a security decision.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { kernelError, KernelErrorException } from '../util/errors.ts';
import type { Logger } from '../util/logger.ts';
import {
  buildProxyPolicy,
  type ProcessNetworkMode,
  type ProxyPolicy,
} from '../security/egress/network-mode.ts';
import { classifyAddress } from '../security/egress/host.ts';
import { READY_LINE, SIDECAR_PORT } from '../security/egress-proxy/main.ts';
import type { EgressAuditRecord } from '../security/egress-proxy/proxy.ts';
import { runDocker } from './docker-cli.ts';

/** Every resource this module creates carries these, so orphans are findable (§47). */
export const EGRESS_LABEL = 'mycoder.egress';
export const EGRESS_EXECUTION_LABEL = 'mycoder.egress.execution';
/** Epoch milliseconds at creation, so the collector can tell live from stale. */
export const EGRESS_CREATED_LABEL = 'mycoder.egress.created';

/**
 * How old an egress resource must be before the collector treats it as an orphan.
 *
 * Found by running the container suites concurrently, and it is a real defect
 * rather than a test artefact. The first version of `collectOrphanedEgressResources`
 * removed *every* resource carrying the egress label, and it runs at backend
 * construction — so a second session starting while the first was mid-execution
 * deleted the first session's live network out from under it. The observed
 * symptom was `network mycoder-egress-… not found` during `network connect`,
 * i.e. one kernel garbage-collecting another kernel's working topology.
 *
 * "Owned by this Kernel namespace" (§47) cannot mean "carries our label", because
 * every concurrent kernel uses the same label. Age is the discriminator that
 * works without a cross-process registry: an execution's default timeout is two
 * minutes and its ceiling is well under this, so anything older than fifteen
 * minutes belongs to a kernel that is no longer running.
 */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * How long to wait for the proxy's readiness line.
 *
 * Was 30 s, which measured as *zero headroom* on the native-Linux release tier.
 * The sidecar itself is fast there — 20 consecutive executions set the topology
 * up in 266–315 ms — but the aarch64 CI VM produced a one-off ~31 s stall in the
 * first scoped execution after a fresh `docker.io` install, while containerd was
 * still doing first-run work under a load average of 2.5 on 4 CPUs.
 *
 * Nothing failed in the egress path, and the stall did not recur across six
 * subsequent full-suite runs. But a security gate whose timeout sits exactly at
 * the observed worst case is a gate that goes red for reasons unrelated to what
 * it guards, and a red gate that people learn to re-run is a gate nobody reads.
 * The cost of waiting longer is bounded — this path only runs when the proxy is
 * genuinely not coming up, and `waitForReady` still exits immediately if the
 * container has died.
 */
const READY_TIMEOUT_MS = 90_000;

/**
 * Where the proxy source is mounted inside the sidecar.
 *
 * Two directories rather than one because `egress-proxy/*` imports `egress/*`,
 * and preserving the relative shape is what makes those imports resolve without
 * a build step. Mounting `src/security` wholesale would work and would also put
 * the secret broker and the credential reader inside the one container that can
 * reach the internet, for no reason.
 */
const SIDECAR_ROOT = '/opt/mycoder-egress';
const SIDECAR_SRC = `${SIDECAR_ROOT}/src/security`;
const SIDECAR_ENTRY = `${SIDECAR_SRC}/egress-proxy/main.ts`;
const SIDECAR_POLICY = `${SIDECAR_ROOT}/policy.json`;

/** Bounded because a compromised proxy must not be able to exhaust the host. */
const PROXY_MEMORY_BYTES = 256 * 1024 * 1024;
const PROXY_PIDS = 64;

export interface EgressSidecarOptions {
  binary: string;
  image: string;
  executionId: string;
  mode: Extract<ProcessNetworkMode, { kind: 'allowlist' }>;
  /** Host directory holding this kernel's `src/security`. Mounted read-only. */
  securitySourceDir: string;
  /** Kernel-owned scratch directory for the policy document. */
  scratchDir: string;
  logger: Logger;
  /** `uid:gid` for the proxy process, matching the container backend's choice. */
  user?: string;
  /**
   * Test-only: permit private/loopback destinations so the controlled topology
   * of §56 can point at a fixture container. Never reachable from configuration
   * or from a tool argument — only from the kernel-side harness.
   */
  allowPrivateAddresses?: boolean;
  /**
   * Treat RFC 2544 benchmarking space as reachable (dogfood finding D-A6-2).
   *
   * For deployments behind a resolver that maps public names into
   * `198.18.0.0/15`. Off by default; see `ProxyPolicy.allowBenchmarkRange`.
   */
  allowBenchmarkRange?: boolean;
  /**
   * Test-only: `name:address` entries added to the *proxy's* `/etc/hosts`.
   *
   * §56 wants a controlled topology rather than public websites, and a
   * controlled topology needs the proxy to resolve `allowed.test` and
   * `denied.test` to fixture containers. Without this the suite would have to
   * put IP literals in the policy, which would skip the domain matching, the
   * SNI check and the normalisation — i.e. exactly the mechanisms under test.
   *
   * It affects only what the proxy can *resolve*; it grants nothing. A name
   * pointed at a fixture is still checked against the allowlist and its address
   * is still classified, which is why the private-address tests still work with
   * this set. Like `allowPrivateAddresses`, it is a constructor parameter used
   * by the kernel-side harness and is not reachable from configuration.
   */
  testHostAliases?: readonly string[];
  readyTimeoutMs?: number;
}

export interface EgressSidecarTiming {
  networkCreateMs: number;
  proxyStartMs: number;
  proxyReadyMs: number;
  totalSetupMs: number;
}

export class EgressSidecar {
  readonly networkName: string;
  readonly proxyContainer: string;
  /** The proxy's address on the private network. The workload's only exit. */
  readonly proxyAddress: string;
  readonly policy: ProxyPolicy;
  readonly timing: EgressSidecarTiming;

  private readonly binary: string;
  private readonly logger: Logger;
  private readonly policyFile: string;
  private stopped = false;

  private constructor(init: {
    binary: string;
    networkName: string;
    proxyContainer: string;
    proxyAddress: string;
    policy: ProxyPolicy;
    policyFile: string;
    logger: Logger;
    timing: EgressSidecarTiming;
  }) {
    this.binary = init.binary;
    this.networkName = init.networkName;
    this.proxyContainer = init.proxyContainer;
    this.proxyAddress = init.proxyAddress;
    this.policy = init.policy;
    this.policyFile = init.policyFile;
    this.logger = init.logger;
    this.timing = init.timing;
  }

  /**
   * The environment the workload receives.
   *
   * Both cases of each name, because clients disagree about which they read, and
   * `NO_PROXY` empty so that no client decides some destination is exempt. None
   * of this is load-bearing for security — the topology is — but a client that
   * bypasses the proxy simply fails, and failing for a *confusing* reason wastes
   * the user's time.
   */
  get proxyEnv(): Record<string, string> {
    const url = `http://${this.proxyAddress}:${SIDECAR_PORT}`;
    return {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      NO_PROXY: '',
      no_proxy: '',
    };
  }

  static async start(opts: EgressSidecarOptions): Promise<EgressSidecar> {
    const startedAt = Date.now();
    const id = sanitizeId(opts.executionId);
    const networkName = `mycoder-egress-${id}`;
    const proxyContainer = `mycoder-egress-proxy-${id}`;
    const policy = buildProxyPolicy({
      executionId: opts.executionId,
      mode: opts.mode,
      ...(opts.allowPrivateAddresses !== undefined
        ? { allowPrivateAddresses: opts.allowPrivateAddresses }
        : {}),
      ...(opts.allowBenchmarkRange !== undefined ? { allowBenchmarkRange: opts.allowBenchmarkRange } : {}),
    });

    await mkdir(opts.scratchDir, { recursive: true });
    const policyFile = path.join(opts.scratchDir, `egress-policy-${id}.json`);
    // Mode 0444: the sidecar reads it and nothing writes it, including the
    // sidecar. §19's "the workload cannot rewrite it" starts here.
    await writeFile(policyFile, JSON.stringify(policy), { mode: 0o444 });

    const fail = async (code: string, detail: string, safe: Record<string, unknown> = {}): Promise<never> => {
      // Partial topology is torn down before the error propagates: a failed
      // setup must not leave a network or a container behind (§47).
      await removeContainer(opts.binary, proxyContainer);
      await removeNetwork(opts.binary, networkName);
      await rm(policyFile, { force: true }).catch(() => {});
      throw new KernelErrorException(
        kernelError('NETWORK_ENFORCEMENT_SETUP_FAILED', detail, {
          blame: 'environment',
          retryable: false,
          safeDetails: { ...safe, reason: code },
        }),
      );
    };

    // 1. The private network. `--internal` is the whole boundary: Docker gives
    //    it no gateway, so nothing attached to it can route anywhere else.
    const networkStart = Date.now();
    const created = await runDocker(
      opts.binary,
      [
        'network',
        'create',
        '--internal',
        '--label',
        `${EGRESS_LABEL}=1`,
        '--label',
        `${EGRESS_EXECUTION_LABEL}=${opts.executionId}`,
        '--label',
        `${EGRESS_CREATED_LABEL}=${startedAt}`,
        networkName,
      ],
      { timeoutMs: 30_000 },
    );
    if (created.exitCode !== 0) {
      await fail(
        'network-create-failed',
        `The private egress network could not be created: ${short(created.stderr)}`,
      );
    }
    const networkCreateMs = Date.now() - networkStart;

    // 2. The proxy, on an internet-capable network. It is started with the
    //    hardening of §18 and nothing from the workspace.
    const proxyStart = Date.now();
    const run = await runDocker(
      opts.binary,
      [
        'run',
        '--detach',
        '--name',
        proxyContainer,
        '--network',
        'bridge',
        '--label',
        `${EGRESS_LABEL}=1`,
        '--label',
        `${EGRESS_EXECUTION_LABEL}=${opts.executionId}`,
        '--label',
        `${EGRESS_CREATED_LABEL}=${startedAt}`,
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--memory',
        String(PROXY_MEMORY_BYTES),
        '--pids-limit',
        String(PROXY_PIDS),
        '--tmpfs',
        '/tmp:rw,size=16777216,mode=1777,noexec',
        ...(opts.user ? ['--user', opts.user] : []),
        ...(opts.testHostAliases ?? []).flatMap((entry) => ['--add-host', entry]),
        // The proxy source, read-only. No workspace, no home, no credential
        // directory, no socket (§18) — and the lint rules assert their absence.
        '--mount',
        `type=bind,source=${path.join(opts.securitySourceDir, 'egress')},target=${SIDECAR_SRC}/egress,readonly`,
        '--mount',
        `type=bind,source=${path.join(opts.securitySourceDir, 'egress-proxy')},target=${SIDECAR_SRC}/egress-proxy,readonly`,
        '--mount',
        `type=bind,source=${policyFile},target=${SIDECAR_POLICY},readonly`,
        '--entrypoint',
        'node',
        opts.image,
        '--experimental-strip-types',
        '--no-warnings',
        SIDECAR_ENTRY,
        SIDECAR_POLICY,
      ],
      { timeoutMs: 60_000 },
    );
    if (run.exitCode !== 0) {
      await fail('proxy-start-failed', `The egress proxy could not be started: ${short(run.stderr)}`);
    }

    // 3. The private leg. Now the proxy is dual-homed and it is the only thing
    //    that is.
    const connected = await runDocker(opts.binary, ['network', 'connect', networkName, proxyContainer], {
      timeoutMs: 30_000,
    });
    if (connected.exitCode !== 0) {
      await fail(
        'network-connect-failed',
        `The egress proxy could not be attached to the private network: ${short(connected.stderr)}`,
      );
    }
    const proxyStartMs = Date.now() - proxyStart;

    // 4. Readiness. The workload does not start until the proxy has said it is
    //    listening, so there is no window in which a command runs with a
    //    half-built topology (§46).
    const readyStart = Date.now();
    const ready = await waitForReady(opts.binary, proxyContainer, opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
    if (!ready.ok) {
      await fail('proxy-not-ready', `The egress proxy did not become ready: ${ready.detail}`, {
        waitedMs: Date.now() - readyStart,
      });
    }
    const proxyReadyMs = Date.now() - readyStart;

    // 5. The address the workload will be pointed at, read from the daemon
    //    rather than guessed. The model never chooses this value (§16).
    const inspect = await runDocker(
      opts.binary,
      ['inspect', '-f', `{{index .NetworkSettings.Networks "${networkName}" "IPAddress"}}`, proxyContainer],
      { timeoutMs: 15_000 },
    );
    const proxyAddress = inspect.stdout.trim();
    const classification = classifyAddress(proxyAddress);
    if (inspect.exitCode !== 0 || classification === undefined) {
      await fail('proxy-address-unknown', 'The egress proxy has no address on the private network.');
    }
    // A proxy that somehow landed on a *global* address would mean the network
    // is not the private one this module thinks it created.
    if (classification!.scope !== 'private') {
      await fail(
        'proxy-address-not-private',
        `The egress proxy's address on the private network classified as ${classification!.scope}, not private.`,
        { scope: classification!.scope },
      );
    }

    const sidecar = new EgressSidecar({
      binary: opts.binary,
      networkName,
      proxyContainer,
      proxyAddress,
      policy,
      policyFile,
      logger: opts.logger,
      timing: {
        networkCreateMs,
        proxyStartMs,
        proxyReadyMs,
        totalSetupMs: Date.now() - startedAt,
      },
    });
    opts.logger.debug('egress sidecar ready', {
      network: networkName,
      targets: policy.targets.length,
      setupMs: sidecar.timing.totalSetupMs,
    });
    return sidecar;
  }

  /**
   * The proxy's decisions for this execution (§45, §80).
   *
   * Read from the sidecar's stdout, which carries one JSON record per line and
   * nothing else. Parsed defensively: a line that is not a record is skipped
   * rather than throwing, because a diagnostic must never be able to fail an
   * execution that already succeeded.
   */
  async collectAudit(): Promise<EgressAuditRecord[]> {
    const logs = await runDocker(this.binary, ['logs', this.proxyContainer], { timeoutMs: 15_000 });
    const records: EgressAuditRecord[] = [];
    for (const line of `${logs.stdout}\n${logs.stderr}`.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed) as EgressAuditRecord;
        if (parsed.t === 'egress') records.push(parsed);
      } catch {
        continue;
      }
    }
    return records;
  }

  /**
   * Tear the topology down.
   *
   * Idempotent and never throws: it runs in a `finally`, and an execution that
   * succeeded must not be turned into a failure by a cleanup hiccup. What it
   * must not do is *silently* leave something running, so a failure to remove is
   * logged and the orphan collector will find it by label on the next start.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const removedContainer = await removeContainer(this.binary, this.proxyContainer);
    const removedNetwork = await removeNetwork(this.binary, this.networkName);
    await rm(this.policyFile, { force: true }).catch(() => {});
    if (!removedContainer || !removedNetwork) {
      this.logger.debug('egress sidecar teardown incomplete', {
        container: removedContainer,
        network: removedNetwork,
        name: this.networkName,
      });
    }
  }
}

/**
 * Wait for the proxy's readiness line.
 *
 * Polls `docker logs` rather than probing the port, for a reason that matters:
 * the kernel is on the host and the private network is internal, so there is no
 * address at which the host could reach the proxy. Its stdout is the only
 * channel — which is also why that channel is one-directional and carries
 * nothing but audit records.
 */
async function waitForReady(
  binary: string,
  container: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastError = '';
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    const logs = await runDocker(binary, ['logs', container], { timeoutMs: 10_000 });
    if (logs.stdout.includes(READY_LINE)) return { ok: true, detail: 'ready' };
    if (logs.stderr.trim() !== '') lastError = short(logs.stderr);

    // A proxy that has already exited will never print the line; noticing that
    // here turns a 30-second timeout into an immediate, accurate failure.
    const state = await runDocker(binary, ['inspect', '-f', '{{.State.Running}}', container], {
      timeoutMs: 10_000,
    });
    if (state.stdout.trim() === 'false') {
      return {
        ok: false,
        detail: lastError === '' ? 'the proxy container exited during startup' : lastError,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // A timeout that says only "timed out" makes the next occurrence as expensive
  // to diagnose as the first. Elapsed time, poll count and whatever the proxy
  // said on stderr are all safe to report — none of them is request content.
  const elapsed = Date.now() - started;
  return {
    ok: false,
    detail:
      `no readiness line after ${elapsed}ms (${polls} polls)` +
      (lastError === '' ? '; the proxy printed nothing on stderr' : `; last stderr: ${lastError}`),
  };
}

async function removeContainer(binary: string, name: string): Promise<boolean> {
  const result = await runDocker(binary, ['rm', '-f', name], { timeoutMs: 30_000 }).catch(() => undefined);
  return result?.exitCode === 0;
}

async function removeNetwork(binary: string, name: string): Promise<boolean> {
  const result = await runDocker(binary, ['network', 'rm', name], { timeoutMs: 30_000 }).catch(
    () => undefined,
  );
  return result?.exitCode === 0;
}

/**
 * Remove egress resources this kernel owns and nothing else (§47).
 *
 * A kernel crash leaves a proxy container and a private network behind. They are
 * found by *label*, which is the difference between garbage collection and
 * damage: `docker system prune` would remove resources belonging to other tools,
 * other kernels and the user's own work, and §47 forbids it in as many words.
 */
export async function collectOrphanedEgressResources(
  binary: string,
  opts: { logger?: Logger; staleAfterMs?: number; now?: number } = {},
): Promise<{ containers: number; networks: number; skippedLive: number }> {
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  const now = opts.now ?? Date.now();
  let containers = 0;
  let networks = 0;
  let skippedLive = 0;

  /**
   * True when this resource is old enough to be nobody's.
   *
   * A resource with no creation label predates this scheme and is stale by
   * definition. A resource with an unparseable one is treated as *live* — the
   * cautious reading, since deleting a working topology is a much worse outcome
   * than leaving a stray network for a human to notice.
   */
  const isStale = (createdLabel: string | undefined): boolean => {
    if (createdLabel === undefined || createdLabel === '') return true;
    const created = Number(createdLabel);
    if (!Number.isFinite(created)) return false;
    return now - created > staleAfterMs;
  };

  const listed = await runDocker(
    binary,
    [
      'ps',
      '-a',
      '--filter',
      `label=${EGRESS_LABEL}=1`,
      '--format',
      `{{.ID}}\t{{.Label "${EGRESS_CREATED_LABEL}"}}`,
    ],
    { timeoutMs: 15_000 },
  );
  for (const line of listed.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')) {
    const [id, created] = line.split('\t');
    if (id === undefined || id === '') continue;
    if (!isStale(created)) {
      skippedLive += 1;
      continue;
    }
    if (await removeContainer(binary, id)) containers += 1;
  }

  const nets = await runDocker(
    binary,
    ['network', 'ls', '--filter', `label=${EGRESS_LABEL}=1`, '--format', `{{.ID}}\t{{.Labels}}`],
    { timeoutMs: 15_000 },
  );
  for (const line of nets.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')) {
    const [id, labels] = line.split('\t');
    if (id === undefined || id === '') continue;
    // `network ls` has no `{{.Label "x"}}` accessor, so the comma-separated
    // label blob is parsed here rather than by the daemon.
    const created = /(?:^|,)mycoder\.egress\.created=([^,]*)/.exec(labels ?? '')?.[1];
    if (!isStale(created)) {
      skippedLive += 1;
      continue;
    }
    if (await removeNetwork(binary, id)) networks += 1;
  }

  if (containers > 0 || networks > 0 || skippedLive > 0) {
    opts.logger?.debug('collected orphaned egress resources', { containers, networks, skippedLive });
  }
  return { containers, networks, skippedLive };
}

/** Docker names are constrained; an execution id is not. */
function sanitizeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40);
  return /^[A-Za-z0-9]/.test(safe) ? safe : `x${safe.slice(1)}`;
}

function short(text: string): string {
  return text.trim().split('\n').slice(0, 2).join(' ').slice(0, 200);
}
