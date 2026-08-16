#!/usr/bin/env node
/**
 * Build the distribution artifact (ADR-0019 §6).
 *
 *   pnpm pack              build a tarball from the current tree
 *   pnpm pack --release    the same, but refuse if the tree is dirty
 *
 * The interesting part is not the tarball — `npm pack` makes that. It is
 * `build-info.json`, which is what binds evidence to code.
 *
 * alpha.8 §3 asks for "a build whose evidence was produced by exactly that
 * commit". A tarball hash proves it was not altered in transit and says nothing
 * about where it came from, so the package carries the commit it was built from.
 * Someone holding only the artifact can read the commit and re-run every matrix
 * row at it — which is the whole difference between evidence and a claim.
 *
 * A dirty tree records `<sha>-dirty` and `--release` refuses outright, for the
 * same reason alpha.8 §17 will not tag a working tree: an artifact whose commit
 * does not describe its contents is worse than one with no commit at all,
 * because it looks checkable.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

export interface BuildInfo {
  version: string;
  /** 40-hex, or `<sha>-dirty`, or `unknown` outside a checkout. */
  commit: string;
  /** The tag pointing at this exact commit, when there is one. */
  tag: string | null;
  builtAt: string;
}

function git(args: readonly string[]): string | undefined {
  const r = spawnSync('git', args as string[], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
  return r.stdout.trim();
}

export function collectBuildInfo(now = new Date()): BuildInfo {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const head = git(['rev-parse', 'HEAD']);
  // `--porcelain` over `diff --quiet`: it also reports untracked files, and an
  // untracked file that `files` happens to include would ship without appearing
  // in any commit.
  const dirty = head ? (git(['status', '--porcelain']) ?? '') !== '' : false;
  const tag = head ? (git(['describe', '--exact-match', '--tags', 'HEAD']) ?? null) : null;

  return {
    version: pkg.version,
    commit: head ? (dirty ? `${head}-dirty` : head) : 'unknown',
    tag,
    builtAt: now.toISOString(),
  };
}

export function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main(argv: readonly string[]): Promise<number> {
  const release = argv.includes('--release');
  const info = collectBuildInfo();

  if (release && !/^[0-9a-f]{40}$/.test(info.commit)) {
    process.stderr.write(
      `pack --release refuses this tree: commit is "${info.commit}".\n` +
        'A release artifact must describe an exact commit. Commit or stash first.\n',
    );
    return 3;
  }

  // Emit the JavaScript the package actually runs (ADR-0019 §1, revised).
  //
  // Not optional and not cached: `dist/` is derived from `src/` at *this* commit,
  // and packing a stale `dist/` would ship code that no gate in this repository
  // has ever seen. Rebuilt every time for the same reason the launcher manifest
  // hashes its source rather than trusting an mtime.
  process.stdout.write('building dist/…\n');
  rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
  // The compiler's own JS entry point, not the `.bin` shim: that shim is a shell
  // script on POSIX, and `node` cannot run it.
  const build = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (build.status !== 0) {
    process.stderr.write(`build failed:\n${build.stdout}${build.stderr}\n`);
    return 6;
  }

  const infoPath = path.join(ROOT, 'build-info.json');
  writeFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`);

  try {
    // `npm pack` rather than `pnpm pack`: identical tarball, and it is the tool
    // that will actually be used by whoever installs this.
    const r = spawnSync('npm', ['pack', '--json'], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      process.stderr.write(`npm pack failed:\n${r.stderr}\n`);
      return 6;
    }
    const parsed = JSON.parse(r.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const entry = parsed[0];
    if (!entry) {
      process.stderr.write('npm pack produced no artifact\n');
      return 6;
    }

    const tarball = path.join(ROOT, entry.filename);
    const digest = sha256(tarball);
    const size = statSync(tarball).size;

    process.stdout.write(
      [
        `artifact : ${entry.filename}`,
        `sha256   : ${digest}`,
        `size     : ${size} bytes`,
        `commit   : ${info.commit}`,
        `tag      : ${info.tag ?? '(none)'}`,
        `files    : ${entry.files.length}`,
        '',
        'Install it with:  npm install -g ' + entry.filename,
        'Verify contents:  pnpm package:check',
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    // `build-info.json` is a *pack* output, not a source file. Leaving it behind
    // would make the next `git status` dirty and therefore the next
    // `pack --release` refuse — a build step that breaks the next build step.
    try {
      unlinkSync(infoPath);
    } catch {
      // already gone
    }
  }
}

/** Every file the packer would include, from `npm pack --dry-run`. */
export function packedFiles(): string[] {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') {
    throw new Error(`npm pack --dry-run failed: ${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
  return (parsed[0]?.files ?? []).map((f) => f.path);
}

/** Unused here, exported for the packaging test's directory walk. */
export function listTree(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTree(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`pack failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 6;
    });
}

export { main };
