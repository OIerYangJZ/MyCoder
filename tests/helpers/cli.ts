/**
 * Run the CLI as a real subprocess, with an isolated config and data directory.
 *
 * Shared by the alpha.8 regression matrix (§26), which is almost entirely about
 * process-shaped behaviour: an exit code a script branches on, a message that has
 * to name a remedy, output that has to land on the right stream. An in-process
 * call to `main()` cannot observe any of those honestly.
 *
 * Every run gets its own `MYCODER_CONFIG_DIR` and `MYCODER_DATA_DIR`. Without
 * that, a test asserting "a fresh install refuses" would pass or fail depending
 * on whether the developer running it happens to have a provider configured —
 * which is exactly the reader who is least likely to notice.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** The packaged entry point, not `src/cli/main.ts`: the shim is under test too. */
export const BIN = path.join(process.cwd(), 'bin', 'mycoder.mjs');
export const CLI = path.join(process.cwd(), 'src', 'cli', 'main.ts');

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** The temp root, so a test can inspect or seed it. */
  root: string;
}

export interface RunOptions {
  args: string[];
  stdin?: string;
  cwd?: string;
  /** Reuse a root from a previous run, to test a sequence. */
  root?: string;
  env?: Record<string, string>;
  /** Run `src/cli/main.ts` directly instead of the bin shim. */
  entry?: string;
  keepRoot?: boolean;
}

export async function runCli(opts: RunOptions): Promise<RunResult> {
  const root = opts.root ?? (await mkdtemp(path.join(tmpdir(), 'mycoder-cli-')));

  // An empty workspace inside the root, and *not* `process.cwd()`.
  //
  // Running these in the repository was a real defect in the first version of
  // this helper: the kernel's own `.mycoder/config.toml` sets
  // `[model] default = "fake"`, so every "a fresh install refuses" test started a
  // working fake session and exited 0. The tests passed for a reason that had
  // nothing to do with the code under test, and would have kept passing after the
  // refusal was deleted.
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });

  return new Promise<RunResult>((resolve) => {
    const child = spawn(process.execPath, [opts.entry ?? BIN, ...opts.args], {
      cwd: opts.cwd ?? workspace,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        MYCODER_DATA_DIR: path.join(root, 'data'),
        MYCODER_CONFIG_DIR: path.join(root, 'config'),
        MYCODER_CACHE_DIR: path.join(root, 'cache'),
        ...opts.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.stdin.end(opts.stdin ?? '');

    child.on('close', (code) => {
      if (!opts.keepRoot && !opts.root) void rm(root, { recursive: true, force: true });
      resolve({ stdout, stderr, code, root });
    });
  });
}

/** A scratch root that survives across several `runCli` calls. */
export async function cliRoot(): Promise<{
  root: string;
  workspace: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'mycoder-cli-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { root, workspace, cleanup: () => rm(root, { recursive: true, force: true }) };
}
