#!/usr/bin/env node
/**
 * What is actually in the artifact (alpha.8 §9, ADR-0019 §5).
 *
 *   pnpm package:check
 *
 * §9 is specific about the shape of this check: it is a **content assertion**,
 * not an `.npmignore` review. The difference matters. Reading the ignore rules
 * tells you what somebody intended to exclude; packing the tarball and listing
 * what came out tells you what a consumer will find on their disk. Those two
 * answers diverge exactly when a rule is subtly wrong, which is the only case
 * worth testing for.
 *
 * A packaging bug that ships `reference/**` violates spec §23 on somebody else's
 * machine — a read-only tree we were given, redistributed by us, without anyone
 * deciding to. A packaging bug that ships `tests/**` puts our canary secrets,
 * which are deliberately credential-shaped, into every consumer's checkout and
 * every secret scanner's index.
 *
 * The rules below are therefore expressed as *what must never appear*, and the
 * check runs against the real `npm pack` file list.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

export interface Forbidden {
  /** Human name for the rule, used in the failure message. */
  rule: string;
  /** Why this must never ship. Printed on failure — the reason is the point. */
  why: string;
  match: (p: string) => boolean;
}

/**
 * Everything the package must never contain.
 *
 * Deliberately expressed as predicates over the packed path rather than as globs
 * mirroring `files`: a rule that is just the inverse of the allowlist would pass
 * whenever the allowlist is wrong, which is the one thing it needs to catch.
 */
export const FORBIDDEN: Forbidden[] = [
  {
    rule: 'reference tree',
    why: 'spec §23: reference trees are read-only and not ours to redistribute',
    match: (p) => p === 'reference' || p.startsWith('reference/'),
  },
  {
    rule: 'research tree',
    why: 'milestone plans are process, not product',
    match: (p) => p === 'research' || p.startsWith('research/'),
  },
  {
    rule: 'eval results',
    why: 'they name models, cost money to produce, and are evidence for the repo, not payload',
    match: (p) => p.startsWith('evals/'),
  },
  {
    rule: 'tests',
    why:
      'the security suites embed canary secrets — deliberately credential-shaped strings. ' +
      'Shipping them puts a file that looks exactly like a leaked credential on every consumer disk',
    match: (p) => p === 'tests' || p.startsWith('tests/'),
  },
  {
    rule: 'milestone documents',
    why: 'alpha-N status and evidence matrices describe this repository, not the installed tool',
    match: (p) => /^docs\/(alpha|m2-|release-checklist)/.test(p),
  },
  {
    rule: 'credential or key material',
    why: 'a package that can contain a key will eventually contain one',
    match: (p) => /(^|\/)\.env($|\.)|\.(key|pem|p12|pfx|jks)$|(^|\/)secrets?\//i.test(p),
  },
  {
    rule: 'local state',
    why: 'session stores and project-local kernel state belong to a machine, not to a package',
    match: (p) => p.startsWith('.mycoder/') || p.startsWith('.agent/') || p.includes('/sessions/'),
  },
  {
    rule: 'CI and repository plumbing',
    why: 'a consumer installing a CLI has no use for our workflows, and they name our infrastructure',
    match: (p) => p.startsWith('.github/') || p === '.gitignore' || p.startsWith('.claude/'),
  },
  {
    rule: 'build output',
    why:
      'the native launcher is built by an explicit step on the target machine (ADR-0020); ' +
      'a shipped binary would be an unsigned prebuilt we have no provenance story for',
    // `dist/` is deliberately *not* here: it is the code the package runs. The
    // native launcher is a different question — a compiled binary with no
    // provenance story, which ADR-0020 says is built on the target machine.
    match: (p) => p === 'build/mycoder-sandbox' || p.endsWith('.manifest.json'),
  },
];

/**
 * Files that must be present, because their absence is silent.
 *
 * A missing forbidden file is caught by the rules above. A missing *required*
 * file produces an install that fails at first use with a module-resolution
 * error, which is exactly the class of first-run failure §10 forbids.
 */
export const REQUIRED = [
  'package.json',
  'bin/mycoder.mjs',
  'bin/runtime-check.mjs',
  // What actually runs on an installed package. Node refuses to strip types for
  // anything under `node_modules`, which is where a global install lives — the
  // install dogfood found that in its first command (ADR-0019 §1, revised).
  'dist/cli/main.js',
  'dist/index.js',
  'dist/kernel.js',
  // And the sources it was derived from, so a reader can audit what they ran.
  'src/cli/main.ts',
  'src/index.ts',
  'src/kernel.ts',
  'native/mycoder-sandbox.c',
  'scripts/build-sandbox.ts',
  'README.md',
];

/**
 * A packaged file may not point at anything under `research/` (ADR-0019 §8).
 *
 * The path rules above keep `research/` *out* of the package. This keeps the
 * package from *depending* on it, which is a different property and the one that
 * actually bites: `research/` is a sibling of this repository, is in no version
 * control, and is expected to be deleted when development finishes. A shipped
 * file naming a file in there hands a consumer an address that resolved on
 * nobody's disk but the author's, and will soon resolve on theirs either.
 *
 * `research/**` is deliberately allowed. Naming the tree in order to say it is
 * excluded — which ADR-0019's own contents table does — is the opposite of
 * depending on it. Naming a *file* in it is the dependency. That is the whole
 * distinction the lookahead encodes.
 */
const RESEARCH_REFERENCE = /research\/(?!\*)[^\s`'")\]]+/;

export function checkPackedContents(
  files: readonly string[],
  read: (path: string) => string,
): Array<{ path: string; match: string }> {
  const offenders: Array<{ path: string; match: string }> = [];
  for (const file of files) {
    // Only text the reader would follow. A `.js` in dist/ is generated from
    // sources whose comments are checked in the repo, and scanning binaries is
    // not the point.
    if (!/\.(md|json|ts|mjs|c)$/.test(file)) continue;
    let content: string;
    try {
      content = read(file);
    } catch {
      continue;
    }
    const m = RESEARCH_REFERENCE.exec(content);
    if (m) offenders.push({ path: file, match: m[0] });
  }
  return offenders;
}

export interface CheckResult {
  files: string[];
  violations: Array<{ path: string; rule: string; why: string }>;
  missing: string[];
}

export function checkPackedFiles(files: readonly string[]): CheckResult {
  const violations: CheckResult['violations'] = [];
  for (const file of files) {
    for (const rule of FORBIDDEN) {
      if (rule.match(file)) violations.push({ path: file, rule: rule.rule, why: rule.why });
    }
  }
  const present = new Set(files);
  const missing = REQUIRED.filter((r) => !present.has(r));
  return { files: [...files], violations, missing };
}

/**
 * Ask npm what it would pack.
 *
 * `--dry-run` so this is safe to run anywhere, including in CI on a pull
 * request, and so it leaves no tarball behind for the next step to trip over.
 */
export function packedFileList(cwd = ROOT): string[] {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd, encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.trim() === '') {
    throw new Error(`npm pack --dry-run failed (status ${r.status}):\n${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
  return (parsed[0]?.files ?? []).map((f) => f.path);
}

async function main(argv: readonly string[]): Promise<number> {
  const result = checkPackedFiles(packedFileList());
  const dangling = checkPackedContents(result.files, (p) => readFileSync(p, 'utf8'));

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...result, dangling }, null, 2)}\n`);
    return result.violations.length === 0 && result.missing.length === 0 && dangling.length === 0 ? 0 : 1;
  }

  process.stdout.write(`package contents: ${result.files.length} file(s)\n`);

  if (result.missing.length > 0) {
    process.stdout.write('\nmissing files the package cannot work without:\n');
    for (const m of result.missing) process.stdout.write(`  ${m}\n`);
  }

  if (result.violations.length > 0) {
    process.stdout.write(`\n${result.violations.length} forbidden path(s):\n`);
    for (const v of result.violations) {
      process.stdout.write(`  ${v.path}\n      ${v.rule} — ${v.why}\n`);
    }
  }

  if (dangling.length > 0) {
    process.stdout.write(`\n${dangling.length} packaged file(s) referencing research/:\n`);
    for (const d of dangling) {
      process.stdout.write(
        `  ${d.path}\n      points at "${d.match}", which is not in the package and will not ` +
          'exist once development finishes\n',
      );
    }
  }

  if (result.violations.length === 0 && result.missing.length === 0 && dangling.length === 0) {
    process.stdout.write('nothing forbidden, nothing missing, nothing dangling\n');
    return 0;
  }
  return 1;
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
      process.stderr.write(`package check failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
    });
}

export { main };
