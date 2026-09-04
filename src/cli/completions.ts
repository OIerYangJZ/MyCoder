/**
 * What Tab offers, and what `@path` turns into.
 *
 * Two jobs that look like one. Completion is a lookup over the workspace; resolution
 * is what happens to `@src/app.ts` when the line is sent, and it is the half with
 * teeth: it reads files and puts their contents in front of the model.
 *
 * **Resolution goes through the tool layer's own path rules, not around them.**
 * `reference/clio` resolves `@path` by calling `fs.readFile` directly in its input
 * module — so an `@../../.ssh/id_rsa` is read and pasted into the conversation
 * whatever the policy says, because nothing in that path consults a policy. Here the
 * candidates come from a directory walk bounded by the workspace root, and a
 * reference that escapes it is left as literal text rather than resolved. A
 * reference the user meant will resolve; one that points outside will read as what
 * it is, an `@` and some characters.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { truncateForModel } from '../util/text.ts';

/** Directories never worth offering, and expensive to walk. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.mycoder']);

/** How much of a referenced file travels with the message. */
const REFERENCE_BUDGET = { maxBytes: 32 * 1024, maxLines: 800 };

export interface FileIndexOptions {
  root: string;
  /** Stop after this many, so a monorepo does not stall the first Tab. */
  limit?: number;
}

/**
 * Workspace-relative paths, walked once and cached.
 *
 * Cached because the first Tab should not pay for a full walk twice, and stale by
 * design: a file created during the session appears after `invalidate()`, which the
 * caller does when it has a reason to think the tree moved.
 */
export class FileIndex {
  private readonly root: string;
  private readonly limit: number;
  private cache: string[] | undefined;

  constructor(opts: FileIndexOptions) {
    this.root = opts.root;
    this.limit = opts.limit ?? 20_000;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  async paths(): Promise<readonly string[]> {
    if (this.cache) return this.cache;
    const found: string[] = [];
    await this.walk(this.root, '', found);
    this.cache = found.sort((a, b) => a.localeCompare(b));
    return this.cache;
  }

  private async walk(dir: string, prefix: string, found: string[]): Promise<void> {
    if (found.length >= this.limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A directory we cannot read is not an error worth failing completion over.
      return;
    }
    for (const entry of entries) {
      if (found.length >= this.limit) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (SKIP.has(entry.name)) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await this.walk(path.join(dir, entry.name), rel, found);
      else if (entry.isFile()) found.push(rel);
    }
  }

  /** Candidates for a partial `@` reference, as the text that replaces the token. */
  async complete(partial: string, max = 12): Promise<string[]> {
    const all = await this.paths();
    const needle = partial.toLowerCase();
    const starts: string[] = [];
    const contains: string[] = [];
    for (const candidate of all) {
      const lower = candidate.toLowerCase();
      if (lower.startsWith(needle)) starts.push(candidate);
      else if (needle !== '' && lower.includes(needle)) contains.push(candidate);
      if (starts.length >= max) break;
    }
    // Prefix matches first: typing `src/c` means `src/cli`, not every file with a
    // `src/c` somewhere inside it.
    return [...starts, ...contains].slice(0, max).map((p) => `@${p}`);
  }
}

/** An `@reference` found in a line, and where it sat. */
export interface FileReference {
  token: string;
  relative: string;
}

const REFERENCE = /@([\w./\\-]*[\w/])/g;

export function findReferences(text: string): FileReference[] {
  const out: FileReference[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    out.push({ token: match[0], relative: match[1] ?? '' });
  }
  return out;
}

/**
 * Whether a reference stays inside the workspace.
 *
 * The check is on the resolved path, not on the text: `a/../../b` contains no `..`
 * segment a naive scan would object to at the front, and resolves outside anyway.
 */
export function insideWorkspace(root: string, relative: string): boolean {
  const resolved = path.resolve(root, relative);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export interface ResolveResult {
  /** The message to send, with file contents appended. */
  text: string;
  /** What was attached, for telling the user. */
  attached: readonly string[];
  /** References left as literal text, and why. */
  skipped: ReadonlyArray<{ token: string; reason: string }>;
}

/**
 * Turn `@path` references into attached contents.
 *
 * Appended after the message rather than substituted into it, so what the user wrote
 * stays legible in the transcript and the attachment reads as an attachment.
 */
export async function resolveReferences(text: string, root: string): Promise<ResolveResult> {
  const references = findReferences(text);
  if (references.length === 0) return { text, attached: [], skipped: [] };

  const attached: string[] = [];
  const skipped: Array<{ token: string; reason: string }> = [];
  const blocks: string[] = [];
  const seen = new Set<string>();

  for (const reference of references) {
    if (seen.has(reference.relative)) continue;
    seen.add(reference.relative);

    if (!insideWorkspace(root, reference.relative)) {
      skipped.push({ token: reference.token, reason: 'outside the workspace' });
      continue;
    }
    const absolute = path.resolve(root, reference.relative);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) {
        skipped.push({ token: reference.token, reason: 'not a file' });
        continue;
      }
      const raw = await readFile(absolute, 'utf8');
      const clipped = truncateForModel(raw, REFERENCE_BUDGET);
      blocks.push(
        `Contents of ${reference.relative}${clipped.truncated ? ' (truncated)' : ''}:\n` +
          '```\n' +
          clipped.text +
          '\n```',
      );
      attached.push(reference.relative);
    } catch {
      // Not there, or not readable. Left as literal text: an `@` in prose is common
      // and turning every one of them into an error would be worse than useless.
      skipped.push({ token: reference.token, reason: 'not found' });
    }
  }

  return {
    text: blocks.length === 0 ? text : `${text}\n\n${blocks.join('\n\n')}`,
    attached,
    skipped,
  };
}

/**
 * Whether an event could have changed which paths exist.
 *
 * The `@` index is cached, so something has to say when it is stale. Not every
 * mutation qualifies: editing a file's contents leaves the path set exactly as it
 * was, and re-walking the tree for it would pay for a directory scan on every edit
 * in a session that mostly edits.
 *
 * So: creations, deletions and moves. Kept as a pure function of the event rather
 * than a subscription inside `FileIndex`, because the index has no business knowing
 * what a session event is.
 */
export function mutationChangesPaths(type: string, payload: unknown): boolean {
  const data = (payload ?? {}) as Record<string, unknown>;

  if (type === 'file.edited') {
    if (data.created === true) return true;
    const kind = data.kind;
    return kind === 'create' || kind === 'delete' || kind === 'move';
  }

  if (type === 'workspace.mutation') {
    const changed = data.changed;
    if (!Array.isArray(changed)) return false;
    return changed.some((entry) => {
      const kind = (entry as { kind?: unknown }).kind;
      return kind === 'added' || kind === 'deleted';
    });
  }

  return false;
}
