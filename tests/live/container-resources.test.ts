/**
 * Resource-limit evidence closure (alpha.6 §62–§64, §91).
 *
 * alpha.5 asserted that `--memory` and `--cpus` appeared in the docker argv, and
 * §62 is blunt about why that is not enough: *"Do not use argv alone as
 * evidence."* A flag in a command line proves the kernel asked for a limit. It
 * does not prove the limit exists, that the runtime honoured it, or that the
 * platform supports it — and on a runtime that silently ignored the flag, the
 * argv assertion would still be green.
 *
 * So this suite closes the three resource claims with runtime observations:
 *
 *   PID     already stress-tested in alpha.5 — a fork bomb is bounded (kept).
 *   memory  a process that allocates past the limit is *actually terminated*.
 *   CPU     the quota is read back out of the container's own cgroup and
 *           compared with the value the plan intended.
 *
 * The CPU case is a cgroup read rather than a timing measurement on purpose
 * (§63): "this loop took longer than it should have" is a flaky assertion on a
 * loaded CI machine, and `cpu.max` is a fact.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { canonicalize, type CanonicalPath } from '../../src/util/paths.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { createLogger } from '../../src/util/logger.ts';
import { ContainerExecutionBackend, defaultContainerConfig } from '../../src/execution/container.ts';
import type { CapabilityProfile } from '../../src/execution/backend.ts';
import { containerSkip, TEST_IMAGE } from './container-harness.ts';
import { createEgressWorkspace } from './egress-harness.ts';

const skip = await containerSkip();

/** Small enough that a modest allocation crosses it, large enough for Node. */
const MEMORY_LIMIT_BYTES = 96 * 1024 * 1024;
/** A fractional value, so a quota of "just the whole CPU" cannot pass by luck. */
const CPU_LIMIT = 1.5;
const PID_LIMIT = 96;

describe('container resource limits are observed at runtime', { concurrency: 1, ...skip }, () => {
  let backend: ContainerExecutionBackend;
  let root: CanonicalPath;
  let cleanup: () => Promise<void>;

  before(async () => {
    const workspace = await createEgressWorkspace();
    cleanup = workspace.cleanup;
    root = (await canonicalize(workspace.root, { cwd: workspace.root })).path;
    backend = await ContainerExecutionBackend.create({
      workspaceRoot: root,
      redactor: new Redactor(),
      config: {
        ...defaultContainerConfig(),
        image: TEST_IMAGE,
        limits: { memoryBytes: MEMORY_LIMIT_BYTES, cpus: CPU_LIMIT, pids: PID_LIMIT },
      },
      logger: createLogger({ level: 'silent', scope: 'test:resources' }),
    });
  });

  after(async () => {
    await backend?.close();
    await cleanup?.();
  });

  const profile = (): CapabilityProfile => ({
    readRoots: [root],
    writeRoots: [],
    allowExec: true,
    network: false,
    envAllow: [],
    secretInjections: [],
    timeoutMs: 120_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });

  const run = async (
    script: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> => {
    const executor = await backend.enforce(profile());
    try {
      const result = await executor.exec({ argv: ['sh', '-c', script], cwd: root, timeoutMs: 120_000 });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } finally {
      executor.dispose();
    }
  };

  it('terminates a process that allocates past the memory limit (§62)', async () => {
    // Buffers rather than a JS array of numbers: `Buffer.alloc` is off-heap and
    // touched immediately, so this is real resident memory rather than a
    // promise of memory the allocator may never commit. Touching it is the part
    // that matters — a cgroup limit is on resident pages, not on address space.
    const script =
      'node -e "const a=[];for(let i=0;i<64;i++){const b=Buffer.alloc(16*1024*1024);b.fill(i);a.push(b);' +
      "console.log('chunk'+i)}console.log('ALLOCATED-ALL')\" ; echo \"exit=$?\"";
    const result = await run(script);

    assert.ok(
      !result.stdout.includes('ALLOCATED-ALL'),
      'a process allocated 1 GiB under a 96 MiB limit; the memory limit is not being enforced',
    );
    // It got *somewhere* before dying — otherwise the test would pass on a
    // container where node failed to start at all, which proves nothing.
    assert.match(result.stdout, /chunk0/, 'the process never ran; this is not memory-limit evidence');
    assert.match(result.stdout, /exit=[1-9]/);
  });

  it('reports the CPU quota the plan asked for, in the container cgroup (§63)', async () => {
    const result = await run(
      'cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || echo NO-CGROUP',
    );
    assert.ok(!result.stdout.includes('NO-CGROUP'), 'the container exposes no CPU cgroup to read');

    // cgroup v2: "<quota> <period>". v1: a bare quota against a 100000 period.
    const parts = result.stdout.trim().split(/\s+/);
    const quota = Number(parts[0]);
    const period = parts.length > 1 ? Number(parts[1]) : 100_000;
    assert.ok(Number.isFinite(quota) && quota > 0, `unreadable CPU quota: ${result.stdout.trim()}`);
    assert.equal(
      quota / period,
      CPU_LIMIT,
      `the runtime quota is ${quota}/${period} CPUs but the plan asked for ${CPU_LIMIT}`,
    );
  });

  it('reports the memory limit in the container cgroup (§62)', async () => {
    const result = await run(
      'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo NO-CGROUP',
    );
    assert.ok(!result.stdout.includes('NO-CGROUP'));
    assert.equal(Number(result.stdout.trim()), MEMORY_LIMIT_BYTES);
  });

  it('bounds a fork bomb at the PID limit (§64 regression)', async () => {
    // Kept from alpha.5. The claim is "bounded", not "refused": the shell keeps
    // asking for processes and the kernel keeps saying no, until the shell
    // itself cannot continue.
    //
    // The obvious assertion — count the processes afterwards — cannot be made
    // from inside: counting needs `ls /proc | grep -c`, which is two forks and a
    // pipe, and there are no process slots left to run them in. The observable
    // fact is the refusal itself, so that is what is asserted.
    const result = await run(
      `i=0; while [ $i -lt 400 ]; do sleep 30 & i=$((i+1)); done; echo "loop-finished i=$i"`,
    );
    const combined = `${result.stdout}${result.stderr}`;
    assert.match(
      combined,
      /Cannot fork|cannot fork|Resource temporarily unavailable|fork: retry/,
      `expected the PID limit to refuse a fork; got stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.ok(
      !combined.includes('loop-finished'),
      `400 processes were created under a ${PID_LIMIT} PID limit`,
    );
  });

  it('classifies a resource kill as a resource error, not an infrastructure failure', async () => {
    // §62's other half: the *classification* has to be right, or a model sees
    // "container start failed" for a program that simply used too much memory.
    const { classifyDockerError } = await import('../../src/execution/container.ts');
    const classified = classifyDockerError({ stderr: '', exitCode: 137 });
    assert.equal(classified.code, 'CONTAINER_RESOURCE_LIMIT');
  });
});
