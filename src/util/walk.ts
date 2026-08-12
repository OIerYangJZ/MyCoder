/**
 * Directory walking with ignore support.
 *
 * Used by Glob and by the in-kernel Grep fallback.
 *
 * `.gitignore` is honoured here **as a relevance filter only**. It keeps
 * `node_modules` out of search results; it is explicitly not a security
 * boundary (spec §13.1), and nothing in this module is permitted to be the
 * reason a protected path stays hidden. Path protection is enforced by
 * `ProtectedPaths` on canonical paths, independently of anything below.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { compileGlob } from './glob.ts';
import { normalizeUnicode, toPosix, type CanonicalPath } from './paths.ts';

/** Directories that are never worth walking for a code search. */
export const DEFAULT_IGNORES: readonly string[] = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.gradle',
  '.idea',
  '.DS_Store',
];

export interface IgnoreRule {
  /** Compiled matcher against a workspace-relative POSIX path. */
  test: (relPath: string, isDir: boolean) => boolean;
  negated: boolean;
}

/**
 * Parse a `.gitignore`-style file into rules.
 *
 * A deliberate subset: comments, negation, directory-only rules, anchored and
 * unanchored patterns. Exotic gitignore behaviour is not reproduced, and does
 * not need to be, because nothing security-relevant depends on it.
 */
export function parseIgnoreFile(content: string, baseRel: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    let pattern = line;
    let negated = false;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    }
    pattern = pattern.replace(/\\(.)/g, '$1');

    let dirOnly = false;
    if (pattern.endsWith('/')) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }

    const anchored = pattern.includes('/');
    const prefix = baseRel === '' ? '' : `${baseRel}/`;
    const full = anchored ? `${prefix}${pattern.replace(/^\//, '')}` : `${prefix}**/${pattern}`;

    const re = compileGlob(full, { caseInsensitive: false });
    const reDir = compileGlob(`${full}/**`, { caseInsensitive: false });
    const reBare = anchored ? undefined : compileGlob(`${prefix}${pattern}`, { caseInsensitive: false });

    rules.push({
      negated,
      test: (relPath, isDir) => {
        if (dirOnly && !isDir) return reDir.test(relPath);
        return re.test(relPath) || reDir.test(relPath) || (reBare?.test(relPath) ?? false);
      },
    });
  }

  return rules;
}

export interface WalkOptions {
  root: CanonicalPath;
  /** Stop after this many files are *yielded*. */
  maxResults?: number;
  /** Stop after visiting this many entries, to bound pathological trees. */
  maxVisits?: number;
  maxDepth?: number;
  /** Honour `.gitignore` files. Relevance only — never a security decision. */
  useGitignore?: boolean;
  /** Extra ignore directory names. */
  ignoreDirs?: readonly string[];
  /** Follow symlinked directories. Off by default: cycles and jail escapes. */
  followSymlinks?: boolean;
  signal?: AbortSignal;
}

export interface WalkEntry {
  absolute: CanonicalPath;
  /** POSIX, workspace-relative. */
  relative: string;
  size: number;
  mtimeMs: number;
}

/**
 * Breadth-first walk, yielding files only.
 *
 * Breadth-first matters for usefulness: when a search is truncated at
 * `maxResults`, shallow hits — the ones a developer usually means — survive.
 */
export async function* walkFiles(opts: WalkOptions): AsyncIterable<WalkEntry> {
  const ignoreDirs = new Set([...DEFAULT_IGNORES, ...(opts.ignoreDirs ?? [])]);
  const maxResults = opts.maxResults ?? 10_000;
  const maxVisits = opts.maxVisits ?? 200_000;
  const maxDepth = opts.maxDepth ?? 32;

  let yielded = 0;
  let visited = 0;
  const seenDirs = new Set<string>();

  let frontier: Array<{ dir: string; rel: string; depth: number; rules: IgnoreRule[] }> = [
    { dir: opts.root, rel: '', depth: 0, rules: [] },
  ];

  while (frontier.length > 0 && yielded < maxResults && visited < maxVisits) {
    const next: typeof frontier = [];

    for (const node of frontier) {
      if (opts.signal?.aborted) return;
      if (yielded >= maxResults || visited >= maxVisits) break;

      let rules = node.rules;
      if (opts.useGitignore) {
        const extra = await readIgnoreRules(node.dir, node.rel);
        if (extra.length > 0) rules = [...rules, ...extra];
      }

      let entries;
      try {
        entries = await readdir(node.dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: not our business to report here
      }

      for (const entry of entries) {
        visited += 1;
        if (visited >= maxVisits) break;

        const name = normalizeUnicode(entry.name);
        const rel = node.rel === '' ? name : `${node.rel}/${name}`;
        const absolute = path.join(node.dir, entry.name);

        let isDir = entry.isDirectory();
        let isSymlink = entry.isSymbolicLink();

        if (isSymlink) {
          if (!opts.followSymlinks) {
            // A symlink is reported as a file if it points at one, but never
            // descended into. Descending is how a walk escapes its root.
            try {
              const s = await stat(absolute);
              if (s.isDirectory()) continue;
              isDir = false;
            } catch {
              continue;
            }
          } else {
            try {
              const s = await stat(absolute);
              isDir = s.isDirectory();
            } catch {
              continue;
            }
          }
        }

        if (isDir && ignoreDirs.has(name)) continue;
        if (isIgnored(rules, rel, isDir)) continue;

        if (isDir) {
          if (node.depth + 1 > maxDepth) continue;
          const key = toPosix(absolute);
          if (seenDirs.has(key)) continue;
          seenDirs.add(key);
          next.push({ dir: absolute, rel, depth: node.depth + 1, rules });
          continue;
        }

        if (!entry.isFile() && !isSymlink) continue;

        let size = 0;
        let mtimeMs = 0;
        try {
          const s = await stat(absolute);
          size = s.size;
          mtimeMs = s.mtimeMs;
        } catch {
          continue;
        }

        yielded += 1;
        yield { absolute: absolute as CanonicalPath, relative: rel, size, mtimeMs };
        if (yielded >= maxResults) break;
      }
    }

    frontier = next;
  }
}

function isIgnored(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.test(rel, isDir)) ignored = !rule.negated;
  }
  return ignored;
}

async function readIgnoreRules(dir: string, rel: string): Promise<IgnoreRule[]> {
  try {
    const content = await readFile(path.join(dir, '.gitignore'), 'utf8');
    return parseIgnoreFile(content, rel);
  } catch {
    return [];
  }
}

/** Heuristic binary check: a NUL byte in the first 8 KiB. */
export function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
