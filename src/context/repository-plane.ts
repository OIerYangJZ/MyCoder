/**
 * Repository Plane (spec §8.2).
 *
 * Facts about the workspace that are cheap to gather and stable across a turn:
 * roots, git identity, project instruction files, a shallow tree sketch.
 *
 * v0.1 has no embeddings and no PageRank RepoMap, by design (§1.3). The
 * interface below is what a future RepoMap must fit behind — `describe()` and
 * `instructions()` are what the projector consumes, so a smarter implementation
 * can arrive without touching the context engine's public surface (§8.2).
 */

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { PROJECT_DIR } from '../app.ts';
import { sha256Hex } from '../util/ids.ts';
import { toPosix, type CanonicalPath } from '../util/paths.ts';
import { truncateForModel } from '../util/text.ts';
import { walkFiles } from '../util/walk.ts';

/** Files that carry project-level instructions for an agent. */
export const INSTRUCTION_FILES: readonly string[] = [
  'AGENTS.md',
  `${PROJECT_DIR}/AGENTS.md`,
  `${PROJECT_DIR}/instructions.md`,
  '.agent/AGENTS.md',
  '.agent/instructions.md',
  // lint-allow no-provider-names-in-core: a well-known instruction filename other tools
  // already write, not a branch on a provider. Reading it couples us to nothing.
  'CLAUDE.md',
  '.cursorrules',
  'CONVENTIONS.md',
];

export interface GitIdentity {
  isRepository: boolean;
  root?: string;
  head?: string;
  branch?: string;
  dirty?: boolean;
}

export interface ProjectInstruction {
  path: string;
  content: string;
  bytes: number;
}

export interface RepositoryFacts {
  workspaceRoot: CanonicalPath;
  git: GitIdentity;
  instructions: readonly ProjectInstruction[];
  /** Shallow directory sketch, for orientation only. */
  treeSketch: string;
  fileCount: number;
  /** Stable id of the workspace, checked on resume (spec §21.3). */
  identity: string;
}

export interface RepositoryPlaneOptions {
  workspaceRoot: CanonicalPath;
  /** Reference repositories, listed to the model as read-only. */
  referenceRoots?: readonly CanonicalPath[];
  maxInstructionBytes?: number;
  maxTreeEntries?: number;
}

export class RepositoryPlane {
  private readonly workspaceRoot: CanonicalPath;
  private readonly referenceRoots: readonly CanonicalPath[];
  private readonly maxInstructionBytes: number;
  private readonly maxTreeEntries: number;
  private cached: RepositoryFacts | undefined;

  constructor(opts: RepositoryPlaneOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.referenceRoots = opts.referenceRoots ?? [];
    this.maxInstructionBytes = opts.maxInstructionBytes ?? 32 * 1024;
    this.maxTreeEntries = opts.maxTreeEntries ?? 160;
  }

  /** Gather facts once per session; `/status` and resume reuse the result. */
  async load(
    runGit?: (argv: string[]) => Promise<{ stdout: string; exitCode: number | null }>,
  ): Promise<RepositoryFacts> {
    if (this.cached) return this.cached;

    const [git, instructions, tree] = await Promise.all([
      this.readGitIdentity(runGit),
      this.readInstructions(),
      this.sketchTree(),
    ]);

    this.cached = {
      workspaceRoot: this.workspaceRoot,
      git,
      instructions,
      treeSketch: tree.sketch,
      fileCount: tree.count,
      identity: sha256Hex(`${this.workspaceRoot}\n${git.root ?? ''}`).slice(0, 16),
    };
    return this.cached;
  }

  get facts(): RepositoryFacts | undefined {
    return this.cached;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async readGitIdentity(
    runGit?: (argv: string[]) => Promise<{ stdout: string; exitCode: number | null }>,
  ): Promise<GitIdentity> {
    if (!runGit) {
      // Without an executor we can still tell whether this is a repository.
      try {
        const s = await stat(path.join(this.workspaceRoot, '.git'));
        return { isRepository: s.isDirectory() || s.isFile() };
      } catch {
        return { isRepository: false };
      }
    }

    try {
      const root = await runGit(['git', 'rev-parse', '--show-toplevel']);
      if (root.exitCode !== 0) return { isRepository: false };

      const [head, branch, status] = await Promise.all([
        runGit(['git', 'rev-parse', 'HEAD']),
        runGit(['git', 'rev-parse', '--abbrev-ref', 'HEAD']),
        runGit(['git', 'status', '--porcelain=v1']),
      ]);

      return {
        isRepository: true,
        root: root.stdout.trim(),
        head: head.exitCode === 0 ? head.stdout.trim().slice(0, 12) : undefined,
        branch: branch.exitCode === 0 ? branch.stdout.trim() : undefined,
        dirty: status.exitCode === 0 ? status.stdout.trim() !== '' : undefined,
      };
    } catch {
      return { isRepository: false };
    }
  }

  private async readInstructions(): Promise<ProjectInstruction[]> {
    const out: ProjectInstruction[] = [];
    let budget = this.maxInstructionBytes;

    for (const rel of INSTRUCTION_FILES) {
      if (budget <= 0) break;
      const full = path.join(this.workspaceRoot, rel);
      try {
        const content = await readFile(full, 'utf8');
        const clipped = truncateForModel(content, { maxBytes: budget, maxLines: 800 });
        out.push({ path: rel, content: clipped.text, bytes: clipped.originalBytes });
        budget -= Buffer.byteLength(clipped.text, 'utf8');
      } catch {
        // Absent instruction files are the normal case.
      }
    }
    return out;
  }

  /**
   * A shallow sketch: top-level entries plus the busiest second-level
   * directories. Enough to orient a model without spending a thousand tokens on
   * a tree the model will search anyway.
   */
  private async sketchTree(): Promise<{ sketch: string; count: number }> {
    const topLevel = new Map<string, number>();
    let count = 0;

    try {
      for await (const entry of walkFiles({
        root: this.workspaceRoot,
        maxResults: 20_000,
        maxDepth: 4,
        useGitignore: true,
      })) {
        count += 1;
        const first = entry.relative.split('/')[0] ?? '';
        const key = entry.relative.includes('/') ? `${first}/` : first;
        topLevel.set(key, (topLevel.get(key) ?? 0) + 1);
      }
    } catch {
      return { sketch: '(workspace listing unavailable)', count: 0 };
    }

    const entries = [...topLevel.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, this.maxTreeEntries);

    const lines = entries.map(([name, n]) => (name.endsWith('/') ? `  ${name} (${n} files)` : `  ${name}`));

    const referenceNote =
      this.referenceRoots.length > 0
        ? `\nReference repositories (READ ONLY — never edit, never write):\n` +
          this.referenceRoots.map((r) => `  ${toPosix(r)}`).join('\n')
        : '';

    return { sketch: lines.join('\n') + referenceNote, count };
  }
}
