/**
 * The docker client transport (ADR-0009, ADR-0014 §8, alpha.6 §46).
 *
 * Extracted from `container.ts` in alpha.6 because there are now two components
 * that have to talk to the daemon — the container backend and the egress sidecar
 * manager — and the alternative was either a circular import or a second
 * `spawn('docker', …)` with its own idea of what environment the client gets.
 * Both are worse than one module that owns the transport.
 *
 * ADR-0009 still holds: the transport is the `docker` CLI over `spawn`, with no
 * SDK and no runtime dependency. The kernel owns argument construction, error
 * classification and result normalisation.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import { scrubEnv } from '../security/env-scrub.ts';

export interface DockerRunOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

export interface DockerRunOptions {
  timeoutMs: number;
  stdin?: string;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  /**
   * Called the moment this run is torn down, before the client is signalled.
   *
   * `docker run` does not exit on SIGTERM: it forwards the signal to the
   * container and keeps waiting, and the container ignores it too, because the
   * workload is PID 1 in its own namespace and PID 1 ignores SIGTERM unless it
   * installs a handler — which `sh -c 'sleep 120'` does not. Measured before this
   * hook existed: cancelling a command returned control after **120 seconds**,
   * i.e. when the command finished on its own.
   *
   * So the teardown path removes the *container*, which makes `docker run` exit.
   * Killing the client is the fallback, not the mechanism.
   */
  onTerminate?: (reason: 'timeout' | 'abort') => void;
}

/**
 * The docker client's own environment.
 *
 * The client is *kernel-side* infrastructure, not the untrusted workload, so it
 * gets what it needs to find the daemon: `HOME` (for `~/.docker/config.json` and
 * the current context) plus the `DOCKER_*` variables a user may legitimately have
 * set. That is a deliberate, narrow exception to the scrub — and it is **not**
 * the environment any container receives, which is built separately and asserted
 * credential-free before it is used.
 */
export function dockerClientEnv(): Record<string, string> {
  return scrubEnv({
    allow: ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'],
    home: homedir(),
  }).env;
}

export async function runDocker(
  binary: string,
  args: readonly string[],
  opts: DockerRunOptions,
  signal?: AbortSignal,
): Promise<DockerRunOutput> {
  const env = opts.env ?? dockerClientEnv();
  const maxBytes = opts.maxOutputBytes ?? 8 * 1024 * 1024;

  return new Promise<DockerRunOutput>((resolve) => {
    const child = spawn(binary, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, spawnError?: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode, timedOut, ...(spawnError ? { spawnError } : {}) });
    };

    const teardown = (reason: 'timeout' | 'abort'): void => {
      opts.onTerminate?.(reason);
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 5_000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      teardown('timeout');
    }, opts.timeoutMs);

    const onAbort = (): void => teardown('abort');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      if (Buffer.byteLength(stdout) < maxBytes) stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      if (Buffer.byteLength(stderr) < maxBytes) stderr += c;
    });

    child.stdin.on('error', () => {
      // A container that exits before reading stdin closes the pipe; EPIPE here
      // is the workload's business, not a transport failure.
    });
    child.stdin.end(opts.stdin ?? '');

    child.on('error', (err: NodeJS.ErrnoException) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}
