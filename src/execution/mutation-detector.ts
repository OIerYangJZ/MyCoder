/**
 * Workspace mutation detection (spec §10.4).
 *
 * In v0.1 the Shell tool can still change the workspace, because policy is not
 * OS isolation. What the kernel *can* guarantee is that such a change is never
 * silent: a snapshot is taken before and after every shell execution, and any
 * source, test or config file that moved produces an
 * `UNDECLARED_WORKSPACE_MUTATION` audit event and is projected into the next
 * model step as a fact.
 *
 * Two strategies:
 *  - `git status --porcelain` when the workspace is a repository. Fast, exact,
 *    and it already knows what is generated.
 *  - an mtime/size scan otherwise, bounded so a huge tree cannot make every
 *    shell call slow.
 *
 * Declared generated paths (`[generated_paths]`) are classified as `generated`
 * and do not raise the undeclared-mutation flag.
 */

import { GlobSet } from '../util/glob.ts';
import { toPosix, type CanonicalPath } from '../util/paths.ts';
import { walkFiles } from '../util/walk.ts';
import type { CapabilityExecutor } from './backend.ts';

export type ChangeKind = 'added' | 'modified' | 'deleted';

export type PathClassification = 'source' | 'test' | 'config' | 'docs' | 'generated' | 'other';

export interface WorkspaceChange {
  path: string;
  kind: ChangeKind;
  classification: PathClassification;
}

export interface WorkspaceSnapshot {
  strategy: 'git' | 'scan' | 'unavailable';
  /** relative path → fingerprint (`git` status code, or `mtime:size`). */
  entries: Map<string, string>;
  takenAt: number;
  /** True when the scan hit its budget and may have missed changes. */
  partial: boolean;
}

const TEST_PATTERNS = [
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
];
const DOC_PATTERNS = ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.txt', '**/docs/**'];
const CONFIG_PATTERNS = [
  '**/package.json',
  '**/tsconfig*.json',
  '**/*.toml',
  '**/*.yaml',
  '**/*.yml',
  '**/*.ini',
  '**/Makefile',
  '**/justfile',
  '**/Dockerfile*',
  '**/.env.example',
  '**/*.lock',
  '**/*-lock.json',
  '**/*.cfg',
];

const MAX_SCAN_FILES = 20_000;

export class MutationDetector {
  private readonly workspaceRoot: CanonicalPath;
  private readonly generated: GlobSet;
  private readonly tests = new GlobSet(TEST_PATTERNS);
  private readonly docs = new GlobSet(DOC_PATTERNS);
  private readonly configs = new GlobSet(CONFIG_PATTERNS);
  private readonly hasGit: boolean;

  constructor(workspaceRoot: CanonicalPath, generatedPatterns: readonly string[], hasGit: boolean) {
    this.workspaceRoot = workspaceRoot;
    this.generated = new GlobSet(generatedPatterns.length > 0 ? generatedPatterns : ['__none__']);
    this.hasGit = hasGit;
  }

  async snapshot(
    executor: CapabilityExecutor,
    signal?: AbortSignal,
    now = Date.now(),
  ): Promise<WorkspaceSnapshot> {
    if (this.hasGit && executor.profile.allowExec) {
      const git = await this.gitSnapshot(executor, signal, now);
      if (git) return git;
    }
    return this.scanSnapshot(executor, signal, now);
  }

  private async gitSnapshot(
    executor: CapabilityExecutor,
    signal: AbortSignal | undefined,
    now: number,
  ): Promise<WorkspaceSnapshot | undefined> {
    try {
      const result = await executor.exec(
        {
          argv: ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
          cwd: this.workspaceRoot,
          timeoutMs: 15_000,
        },
        signal,
      );
      if (result.exitCode !== 0) return undefined;

      const entries = new Map<string, string>();
      for (const line of result.stdout.split('\n')) {
        if (line.length < 4) continue;
        const code = line.slice(0, 2);
        // Rename entries are `R  old -> new`; the new name is what matters.
        const rest = line.slice(3);
        const path = rest.includes(' -> ') ? rest.slice(rest.indexOf(' -> ') + 4) : rest;
        entries.set(unquoteGitPath(path.trim()), code);
      }
      return { strategy: 'git', entries, takenAt: now, partial: false };
    } catch {
      return undefined;
    }
  }

  private async scanSnapshot(
    executor: CapabilityExecutor,
    signal: AbortSignal | undefined,
    now: number,
  ): Promise<WorkspaceSnapshot> {
    const entries = new Map<string, string>();
    let count = 0;
    let partial = false;

    try {
      for await (const entry of walkFiles({
        root: this.workspaceRoot,
        maxResults: MAX_SCAN_FILES,
        useGitignore: true,
        ...(signal ? { signal } : {}),
      })) {
        entries.set(entry.relative, `${entry.mtimeMs}:${entry.size}`);
        count += 1;
        if (count >= MAX_SCAN_FILES) {
          partial = true;
          break;
        }
      }
    } catch {
      return { strategy: 'unavailable', entries, takenAt: now, partial: true };
    }

    void executor;
    return { strategy: 'scan', entries, takenAt: now, partial };
  }

  /** Diff two snapshots into a change list. */
  diff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChange[] {
    if (before.strategy === 'unavailable' || after.strategy === 'unavailable') return [];
    if (before.strategy !== after.strategy) return [];

    const changes: WorkspaceChange[] = [];

    for (const [path, fingerprint] of after.entries) {
      const previous = before.entries.get(path);
      if (previous === undefined) {
        changes.push({ path, kind: 'added', classification: this.classify(path) });
      } else if (previous !== fingerprint) {
        changes.push({ path, kind: 'modified', classification: this.classify(path) });
      }
    }
    for (const path of before.entries.keys()) {
      if (!after.entries.has(path)) {
        changes.push({ path, kind: 'deleted', classification: this.classify(path) });
      }
    }

    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  classify(relativePath: string): PathClassification {
    const p = toPosix(relativePath);
    if (this.generated.matches(p)) return 'generated';
    if (this.tests.matches(p)) return 'test';
    if (this.docs.matches(p)) return 'docs';
    if (this.configs.matches(p)) return 'config';
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|c|h|cc|cpp|hpp|cs|swift|php|scala|sh)$/i.test(p)) {
      return 'source';
    }
    return 'other';
  }

  /**
   * Changes that must be surfaced rather than absorbed.
   *
   * Generated output is expected; source, test and config changes made by a
   * shell command were not declared by an Edit and so are audited.
   */
  static undeclared(changes: readonly WorkspaceChange[]): WorkspaceChange[] {
    return changes.filter(
      (c) => c.classification === 'source' || c.classification === 'test' || c.classification === 'config',
    );
  }

  /** One-paragraph fact for the next model step (spec §10.4). */
  static describe(changes: readonly WorkspaceChange[], limit = 20): string {
    if (changes.length === 0) return '';
    const shown = changes.slice(0, limit);
    const more = changes.length - shown.length;
    const lines = shown.map((c) => `  ${c.kind.padEnd(8)} ${c.path} (${c.classification})`);
    return (
      `The command changed ${changes.length} file(s) in the workspace:\n` +
      lines.join('\n') +
      (more > 0 ? `\n  … and ${more} more` : '')
    );
  }
}

/** git quotes paths containing unusual bytes; undo that for display. */
function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  return p
    .slice(1, -1)
    .replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)))
    .replace(/\\(.)/g, '$1');
}
