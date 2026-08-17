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

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, readdir } from 'node:fs/promises';
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

/**
 * True when `dist/` is older than the sources it was emitted from.
 *
 * `bin/mycoder.mjs` loads `dist/cli/main.js` **when it exists** and falls back to
 * `src/` only when it does not (ADR-0019 §1). So a `dist/` left over from an
 * earlier build makes every test that runs through the shim exercise code that is
 * no longer in the tree — and it fails or passes for reasons that have nothing to
 * do with the change under test.
 *
 * alpha.12 hit this: three new CLI tests were red against a refusal that had been
 * written, and the refusal was in `src/`. A stale build is worse than a missing one,
 * because a missing one is loudly missing.
 */
export function isDistStale(newestSrcMs: number, distMs: number | undefined): boolean {
  if (distMs === undefined) return true;
  return newestSrcMs > distMs;
}

/** Newest mtime under a directory, in ms. */
async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) newest = Math.max(newest, (await stat(full)).mtimeMs);
    }
  };
  await walk(dir);
  return newest;
}

/** Rebuild `dist/` when it is missing or stale. Once per process. */
let distChecked: Promise<void> | undefined;
async function ensureFreshDist(): Promise<void> {
  distChecked ??= (async () => {
    const dist = path.join(process.cwd(), 'dist', 'cli', 'main.js');
    const distMs = await stat(dist)
      .then((s) => s.mtimeMs)
      .catch(() => undefined);
    if (!isDistStale(await newestMtime(path.join(process.cwd(), 'src')), distMs)) return;

    process.stderr.write('tests/helpers/cli: dist/ is missing or stale — rebuilding\n');
    const tsc = path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
    const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    if (build.status !== 0) {
      throw new Error(`could not rebuild dist/: ${build.stdout ?? ''}${build.stderr ?? ''}`);
    }
  })();
  return distChecked;
}

export async function runCli(opts: RunOptions): Promise<RunResult> {
  // Only the shim reads `dist/`; a test that names `CLI` is running the sources
  // and needs no build at all.
  if ((opts.entry ?? BIN) === BIN) await ensureFreshDist();

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
