/**
 * Path canonicalisation and containment.
 *
 * This module is a security boundary. Two rules govern everything here:
 *
 *   1. Every policy decision is made on a *canonical* path — symlinks resolved,
 *      `..` collapsed, `~` expanded, Unicode normalised. A check performed on a
 *      raw model-supplied string is not a check.
 *   2. When the target does not exist yet (a file about to be created), we
 *      canonicalise the deepest existing ancestor and append the remainder. That
 *      still defeats `dir-symlink/../../etc/passwd`, because the symlink lives in
 *      the existing part.
 */

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { Brand } from './ids.ts';

export type CanonicalPath = Brand<string, 'CanonicalPath'>;

/**
 * macOS stores filenames in NFD and (by default) compares case-insensitively.
 * A deny rule written as `.env` must still catch `.ENV` and a decomposed
 * `.énv`. We normalise to NFC everywhere and let the glob layer match
 * case-insensitively.
 */
export function normalizeUnicode(p: string): string {
  return p.normalize('NFC');
}

export function expandHome(p: string, home = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** Purely lexical canonicalisation. Does not touch the filesystem. */
export function lexicalCanonical(p: string, cwd: string, home = homedir()): CanonicalPath {
  const expanded = expandHome(normalizeUnicode(p), home);
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  return normalizeUnicode(path.normalize(abs)) as CanonicalPath;
}

export interface CanonicalizeOptions {
  cwd: string;
  home?: string;
  /**
   * When true (the default) the deepest existing ancestor is resolved through
   * `realpath` so symlinks cannot be used to escape a jail.
   */
  resolveSymlinks?: boolean;
}

/**
 * Canonicalise a possibly non-existent path.
 *
 * Returns both the canonical path and whether the final component actually
 * exists, because callers such as Edit need to distinguish create from replace.
 */
export async function canonicalize(
  input: string,
  opts: CanonicalizeOptions,
): Promise<{ path: CanonicalPath; existed: boolean; resolvedAncestor: CanonicalPath }> {
  const home = opts.home ?? homedir();
  const lexical = lexicalCanonical(input, opts.cwd, home);

  if (opts.resolveSymlinks === false) {
    return { path: lexical, existed: false, resolvedAncestor: lexical };
  }

  // Walk upwards until realpath() succeeds, then re-attach the missing tail.
  const missing: string[] = [];
  let probe: string = lexical;

  for (;;) {
    try {
      const real = normalizeUnicode(await realpath(probe)) as CanonicalPath;
      const full = (
        missing.length === 0 ? real : (path.join(real, ...missing.reverse()) as string)
      ) as CanonicalPath;
      return {
        path: normalizeUnicode(full) as CanonicalPath,
        existed: missing.length === 0,
        resolvedAncestor: real,
      };
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        // Reached the root without finding anything real; fall back to lexical.
        return { path: lexical, existed: false, resolvedAncestor: lexical };
      }
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * True when `child` is `root` itself or lives underneath it.
 *
 * Both arguments must already be canonical. The separator check is what stops
 * `/repo-evil` from being accepted as inside `/repo`.
 */
export function isWithin(root: CanonicalPath, child: CanonicalPath): boolean {
  const a = stripTrailingSep(root);
  const b = stripTrailingSep(child);
  if (a === b) return true;
  return b.startsWith(a + path.sep);
}

function stripTrailingSep(p: string): string {
  if (p.length > 1 && p.endsWith(path.sep)) return p.slice(0, -1);
  return p;
}

export function relativeTo(root: CanonicalPath, child: CanonicalPath): string {
  const rel = path.relative(root, child);
  return rel === '' ? '.' : rel;
}

/**
 * Path shown to the model and to the user. Inside the workspace we use the
 * workspace-relative form so that the absolute layout of the developer's machine
 * does not become part of the prompt.
 */
export function displayPath(root: CanonicalPath, child: CanonicalPath): string {
  return isWithin(root, child) ? relativeTo(root, child) : child;
}

/** Slash-normalised form used for glob matching, so rules are portable. */
export function toPosix(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

export function isSubpathTraversal(raw: string): boolean {
  const parts = normalizeUnicode(raw).split(/[\\/]+/);
  return parts.includes('..');
}
