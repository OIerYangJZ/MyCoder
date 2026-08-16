/**
 * The workflows, checked (alpha.8 defects 13–16).
 *
 * This file exists because of one sentence the milestone earned the hard way:
 * **a workflow is code that nothing tests.** `release.yml` was reviewed, read
 * correctly, and was wrong in four independent ways the first time each of its
 * paths executed — and each wrong path cost a push, a queue and several minutes
 * to discover.
 *
 * Every check below is one of those four, expressed as a property of the YAML
 * text rather than as a memory of what went wrong. They are deliberately narrow:
 * this is not a YAML linter, it is a set of specific traps that have already
 * been fallen into once each.
 *
 * alpha.9 added a fifth (defect 17, §19 CLOSURE A), and its provenance is worth
 * keeping: this file was written to close alpha.8, and the very next thing that
 * ran the suite on a tree without `node_modules` found `ci.yml` had been red on
 * two jobs for the whole milestone. The four checks here did not catch it
 * because they were four memories rather than a property. Defect 17 is the
 * property: a step whose precondition nothing established.
 *
 * Each check is also fed a planted bad sample, because a workflow checker that
 * silently stopped matching would report a clean repository — which is what a
 * clean repository looks like. Same reason `tests/lint/lint-selftest.test.ts`
 * exists.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { globMatch } from '../../src/util/glob.ts';

const WORKFLOW_DIR = path.join(process.cwd(), '.github', 'workflows');
const ROOT = process.cwd();

function workflows(): Array<{ name: string; text: string }> {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ name: f, text: readFileSync(path.join(WORKFLOW_DIR, f), 'utf8') }));
}

/** The `run:` blocks of a workflow, one entry per step, in file order. */
export function runBlocks(yaml: string): string[] {
  const lines = yaml.split('\n');
  const blocks: string[] = [];
  let current: string[] | undefined;
  let indent = 0;

  for (const line of lines) {
    if (current) {
      const blank = line.trim() === '';
      const deeper = line.search(/\S/) > indent;
      if (blank || deeper) {
        current.push(line);
        continue;
      }
      blocks.push(current.join('\n'));
      current = undefined;
    }
    const m = /^(\s*)-?\s*run:\s*(.*)$/.exec(line);
    if (m) {
      indent = m[1]!.length;
      // `run: cmd` on one line is its own block; `run: |` opens a folded one.
      if (m[2]!.trim() !== '' && m[2]!.trim() !== '|' && m[2]!.trim() !== '>') {
        blocks.push(m[2]!);
      } else {
        current = [];
      }
    }
  }
  if (current) blocks.push(current.join('\n'));
  return blocks;
}

// --- defect 13 ---------------------------------------------------------------

/**
 * `package:check` asserts `dist/` exists, so something must have built it first.
 *
 * The release gate ran the check without the build and blocked its own release
 * on an artifact it had never produced.
 */
export function packageCheckWithoutBuild(yaml: string): boolean {
  const blocks = runBlocks(yaml);
  const checkAt = blocks.findIndex((b) => /pnpm\s+package:check/.test(b));
  if (checkAt === -1) return false;
  const buildAt = blocks.findIndex((b) => /pnpm\s+build\b/.test(b));
  return buildAt === -1 || buildAt > checkAt;
}

// --- defect 15 ---------------------------------------------------------------

/**
 * `| tee <relative path>` writes into the repository.
 *
 * The shell creates a redirection target when it *builds* the pipeline, before
 * the command on the left runs — so the file is already there when anything
 * downstream asks `git status --porcelain` whether the tree is clean. The pack
 * step refused its own release for a tree it had dirtied one step earlier with
 * its own log.
 */
export function teeIntoRepository(yaml: string): string[] {
  const bad: string[] = [];
  for (const raw of runBlocks(yaml)) {
    // `${{ matrix.node }}` contains spaces, which would truncate the filename
    // capture below and leave `test-node-${{` — a target that matches no ignore
    // rule and looks like a violation. Collapse expressions to one token first.
    const block = raw.replace(/\$\{\{[^}]*\}\}/g, 'X');
    for (const m of block.matchAll(/\|\s*tee\s+(?:-a\s+)?"?([^\s"|]+)"?/g)) {
      const target = m[1]!;
      if (target.startsWith('/') || /RUNNER_TEMP|runner\.temp/.test(target)) continue;
      // Gitignored targets are safe, and this is not a technicality: the hazard
      // is specifically a file `git status --porcelain` will report. `ci.yml`
      // has tee'd `*.log` into the root since alpha.5 and never caused this,
      // because `.gitignore` covers it. Asking git rather than pattern-matching
      // ourselves keeps the two answers from drifting.
      const r = spawnSync('git', ['check-ignore', '-q', target], { cwd: process.cwd() });
      // 0 = ignored, 1 = not ignored, 128 = git could not answer (not a work
      // tree, no git on PATH). alpha.9 defect 2: 128 was folded into "not
      // ignored", so staging the tree with `git archive` — no `.git` — turned
      // every correctly-ignored log into a reported hazard. That is the safe
      // direction, but it is not a diagnosable one: the message named four
      // filenames and no cause. Say which question could not be answered.
      if (r.status === 0) continue;
      if (r.status !== 1) {
        throw new Error(
          `git check-ignore could not answer for ${target} (status ${r.status}). ` +
            'This check needs a git work tree to distinguish an ignored log from a ' +
            'tracked one; it cannot run against an exported or unpacked source tree.',
        );
      }
      bad.push(target);
    }
  }
  return bad;
}

// --- defect 16 ---------------------------------------------------------------

/**
 * `cmd | grep -q …` as an assertion, in a block that sets `pipefail`.
 *
 * Under `pipefail` a pipeline takes the last non-zero status in it. The install
 * step asserted that `mycoder doctor` names the config file — and `doctor` exits
 * 3 there *by design*, because that is the thing under test — so the pipeline
 * returned 3 whether or not grep matched. The assertion could only ever fail.
 */
export function pipefailGrepAssertion(yaml: string): string[] {
  const bad: string[] = [];
  for (const block of runBlocks(yaml)) {
    if (!/set\s+-\S*o\S*\s+pipefail|set\s+-euo\s+pipefail|set\s+-o\s+pipefail/.test(block)) continue;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      // A comment describing the hazard is not the hazard. This check flagged
      // its own explanation the first time it ran.
      if (line.startsWith('#')) continue;
      const m = /^(?:.*?\b)?([\w./$-]+)[^|]*\|\s*grep\s+-[a-zA-Z]*q/.exec(line);
      if (!m) continue;
      // `echo "$var" | grep -q` is the *fix*, not the bug: echo cannot fail, so
      // the pipeline status is grep's. The hazard is only a left-hand command
      // that is expected to exit non-zero.
      const lhs = /(^|\s)(echo|printf|cat)\s/.test(line.split('|')[0]!);
      if (lhs) continue;
      bad.push(line);
    }
  }
  return bad;
}

// --- defect 14 ---------------------------------------------------------------

/**
 * pnpm builtins that **shadow** a script of the same name.
 *
 * `pnpm pack --release` was parsed by pnpm, which rejected `--release` before
 * `scripts/pack.ts` ever saw it. `test` and `start` are deliberately absent:
 * those builtins exist precisely to run the script of that name, so they are
 * shortcuts rather than collisions.
 */
export const SHADOWING_BUILTINS = [
  'add',
  'audit',
  'bin',
  'config',
  'dedupe',
  'deploy',
  'dlx',
  'env',
  'exec',
  'fetch',
  'import',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'ls',
  'outdated',
  'pack',
  'patch',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'root',
  'run',
  'server',
  'setup',
  'store',
  'unlink',
  'update',
  'why',
];

export function shadowedScripts(scripts: Record<string, string>): string[] {
  return Object.keys(scripts).filter((name) => SHADOWING_BUILTINS.includes(name));
}

// --- defect 17 (alpha.9) -----------------------------------------------------

/**
 * A job that runs a script needing devDependencies, without installing them.
 *
 * The generalisation of defect 13. That one was "`package:check` asserts `dist/`
 * exists, so something must build it first"; this one is "some scripts cannot
 * run at all without `node_modules`, so something must install it first". Both
 * are a step whose precondition nothing established, and both were invisible
 * locally — where `dist/` and `node_modules` are simply always there.
 *
 * The check is deliberately **not** "every job must install". Most jobs in
 * `ci.yml` run with no `node_modules` whatsoever, and that is not an oversight:
 * it is the standing demonstration of ADR-0009's zero-runtime-dependency claim.
 * A rule that installed everywhere would erase that evidence to prevent a bug
 * those jobs do not have. So the set of scripts that need an install is
 * *derived* below rather than declared, and only those are required to have one.
 */

/** Every repository source file, relative and POSIX, excluding build outputs. */
function repoFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', '.mycoder']);

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
    }
  };

  visit(ROOT);
  return out;
}

/** Source with `//` and block comments removed, so prose cannot look like code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Does this source spawn a program out of `node_modules`?
 *
 * Two signals, and both are required, because either alone is wrong here. A
 * spawn is far too common to mean anything on its own, and the bare name
 * `node_modules` appears all over the tree as a *directory to skip* —
 * `scripts/lint.ts` and `src/util/walk.ts` both list it and execute nothing.
 * The conjunction is "builds a path into node_modules, and runs things", which
 * is exactly the property that fails on a tree where nobody installed one.
 *
 * The path half asks specifically whether the name appears **inside a
 * `join`/`resolve` call**, which is what separates building a path from naming
 * a directory. The nested-parens alternative is load-bearing: the real case is
 * `path.join(process.cwd(), 'node_modules', …)`, so a `[^)]*` gap would stop at
 * the `)` of `cwd()` and miss the only hit that matters.
 *
 * This scans the whole source rather than line by line, and strips comments
 * first, and both choices are alpha.9 defect 3. The first version tested each
 * line and relied on a multi-line array literal to avoid flagging this file's
 * own skip-list. Prettier reflowed that array back onto one line on the next
 * `pnpm format`, and the check broke — a checker whose correctness depends on
 * source layout is a checker the formatter is authoritative over. Structure, not
 * whitespace.
 */
export function spawnsFromNodeModules(source: string): boolean {
  if (!/\b(spawnSync|spawn|execFileSync|execFile|execSync)\s*\(/.test(source)) return false;

  return /\b(?:path\.)?(?:join|resolve)\s*\((?:[^()]|\([^()]*\))*?['"]node_modules['"]/.test(
    stripComments(source),
  );
}

/** The repository files a script's command line loads, glob patterns expanded. */
export function filesReachedBy(command: string, files: string[]): string[] {
  const reached: string[] = [];

  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^["']|["']$/g, '');
    if (token.startsWith('-')) continue;
    if (!token.endsWith('.ts') && !token.includes('*')) continue;
    if (token.includes('*')) reached.push(...files.filter((f) => globMatch(token, f)));
    else if (files.includes(token)) reached.push(token);
  }

  return [...new Set(reached)];
}

/** `entry` plus everything it imports, transitively, within the repository. */
function withLocalImports(entry: string[], files: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entry];

  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);

    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, 'utf8');

    for (const m of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path
        .relative(ROOT, path.resolve(path.dirname(abs), m[1]!))
        .split(path.sep)
        .join('/');
      if (files.includes(target)) queue.push(target);
    }
  }

  return [...seen];
}

/**
 * The package.json scripts that cannot run without `pnpm install`.
 *
 * Direct: the command invokes a devDependency binary by name. Indirect: the
 * command loads a repository file which — transitively — spawns something out of
 * `node_modules`. The indirect arm is the one that matters: nothing about
 * `pnpm test` looks like it needs a compiler, and the file that makes it need
 * one is four glob expansions and an import away.
 */
export function scriptsNeedingDevDependencies(scripts: Record<string, string>, files: string[]): string[] {
  const needing: string[] = [];

  for (const [name, command] of Object.entries(scripts)) {
    if (/(^|\s|\/)(tsc|prettier)(\s|$)/.test(command)) {
      needing.push(name);
      continue;
    }
    const reached = withLocalImports(filesReachedBy(command, files), files);
    if (reached.some((rel) => spawnsFromNodeModules(readFileSync(path.join(ROOT, rel), 'utf8')))) {
      needing.push(name);
    }
  }

  return needing.sort();
}

/** Each workflow job's body, keyed by job id, in file order. */
export function jobBodies(yaml: string): Array<{ id: string; text: string }> {
  const lines = yaml.split('\n');
  const jobs: Array<{ id: string; text: string }> = [];
  let current: { id: string; text: string[] } | undefined;
  let inJobs = false;

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    // A non-indented, non-blank line ends the `jobs:` mapping entirely.
    if (line.trim() !== '' && !/^\s/.test(line)) break;

    const start = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (start) {
      if (current) jobs.push({ id: current.id, text: current.text.join('\n') });
      current = { id: start[1]!, text: [] };
      continue;
    }
    current?.text.push(line);
  }

  if (current) jobs.push({ id: current.id, text: current.text.join('\n') });
  return jobs;
}

/** `job:script` for every script run before its devDependencies were installed. */
export function jobsMissingInstall(yaml: string, needing: string[]): string[] {
  const bad: string[] = [];

  for (const job of jobBodies(yaml)) {
    const blocks = runBlocks(job.text);
    const installAt = blocks.findIndex((b) => /pnpm\s+install\b/.test(b));

    for (const [index, block] of blocks.entries()) {
      for (const script of needing) {
        // `pnpm test` must not match `pnpm test:packaging`, and vice versa.
        const invoked = new RegExp(`pnpm\\s+${script.replace(/[:.]/g, '\\$&')}(?![\\w:.-])`);
        if (!invoked.test(block)) continue;
        if (installAt === -1 || installAt > index) bad.push(`${job.id}:${script}`);
      }
    }
  }

  return [...new Set(bad)];
}

describe('workflow hazards (alpha.8 defects 13-16, alpha.9 defect 1)', () => {
  test('defect 13: nothing runs package:check without building dist first', () => {
    for (const wf of workflows()) {
      assert.equal(
        packageCheckWithoutBuild(wf.text),
        false,
        `${wf.name} runs \`pnpm package:check\` with no \`pnpm build\` before it. ` +
          '`package:check` asserts dist/ exists (ADR-0019 §1).',
      );
    }
  });

  test('defect 13: NEGATIVE CONTROL — the check catches the original mistake', () => {
    const broken = ['jobs:', '  x:', '    steps:', '      - run: pnpm package:check'].join('\n');
    assert.equal(packageCheckWithoutBuild(broken), true);

    const fixed = [
      'jobs:',
      '  x:',
      '    steps:',
      '      - run: pnpm build',
      '      - run: pnpm package:check',
    ].join('\n');
    assert.equal(packageCheckWithoutBuild(fixed), false);
  });

  test('defect 14: no package.json script is shadowed by a pnpm builtin', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.deepEqual(
      shadowedScripts(pkg.scripts),
      [],
      'a script with this name cannot receive its own flags: pnpm parses them first',
    );
  });

  test('defect 14: NEGATIVE CONTROL — `pack` is detected, `test` is not', () => {
    assert.deepEqual(shadowedScripts({ pack: 'node scripts/pack.ts' }), ['pack']);
    // `pnpm test` runs the `test` script by design, so it is a shortcut and not
    // a collision. A check that flagged it would be unusable.
    assert.deepEqual(shadowedScripts({ test: 'node --test', build: 'tsc' }), []);
  });

  test('defect 15: no workflow tees a log into the repository', () => {
    for (const wf of workflows()) {
      const bad = teeIntoRepository(wf.text);
      assert.deepEqual(
        bad,
        [],
        `${wf.name} writes ${bad.join(', ')} into the working tree. A redirection target is created ` +
          'when the shell builds the pipeline, so anything downstream that checks `git status` sees it.',
      );
    }
  });

  test('defect 15: NEGATIVE CONTROL — a tracked tee is caught; ignored and absolute ones are not', () => {
    const rel = ['      - run: |', '          pnpm release:pack --release | tee pack.txt'].join('\n');
    assert.deepEqual(teeIntoRepository(rel), ['pack.txt'], 'the exact original mistake');

    const abs = [
      '      - run: |',
      '          pnpm release:pack --release | tee "$RUNNER_TEMP/pack.txt"',
    ].join('\n');
    assert.deepEqual(teeIntoRepository(abs), [], '$RUNNER_TEMP is outside the tree');

    const ignored = ['      - run: |', '          pnpm test | tee test.log'].join('\n');
    assert.deepEqual(teeIntoRepository(ignored), [], '*.log is gitignored, so git never reports it');
  });

  test('defect 16: no pipefail block asserts with `| grep -q`', () => {
    for (const wf of workflows()) {
      const bad = pipefailGrepAssertion(wf.text);
      assert.deepEqual(
        bad,
        [],
        `${wf.name} asserts through a pipe under pipefail: ${bad.join(' / ')}. ` +
          'The pipeline takes the left-hand exit code, so the assertion cannot pass ' +
          'when the command under test is expected to exit non-zero.',
      );
    }
  });

  test('defect 16: NEGATIVE CONTROL — the exact original line is caught', () => {
    const broken = [
      '      - run: |',
      '          set -euo pipefail',
      "          mycoder doctor 2>&1 | grep -q 'config.toml' || exit 1",
    ].join('\n');
    assert.equal(pipefailGrepAssertion(broken).length, 1);

    const fixed = [
      '      - run: |',
      '          set -euo pipefail',
      '          out=$(mycoder doctor 2>&1 || true)',
      '          echo "$out" | grep -q \'config.toml\' || exit 1',
    ].join('\n');
    // `echo "$out" | grep -q` is the fix, not the bug: echo cannot fail, so the
    // pipeline status is grep's. A check that flagged the corrected form too
    // would be a check people delete.
    assert.deepEqual(pipefailGrepAssertion(fixed), []);
  });

  test('defect 17: no job runs a script whose devDependencies it never installed', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const needing = scriptsNeedingDevDependencies(pkg.scripts, repoFiles());

    // The derivation is asserted, not just used. If `packaging.test.ts` stopped
    // building `dist/`, this set would shrink, the rule below would go vacuous,
    // and a green run would mean nothing — the alpha.6 failure mode exactly.
    assert.ok(
      needing.includes('test'),
      '`pnpm test` reaches tests/integration/packaging.test.ts, which spawns tsc out of ' +
        `node_modules. Derived set was: ${needing.join(', ')}`,
    );

    for (const wf of workflows()) {
      const bad = jobsMissingInstall(wf.text, needing);
      assert.deepEqual(
        bad,
        [],
        `${wf.name}: ${bad.join(', ')} run(s) before any \`pnpm install\`. ` +
          'These scripts need devDependencies; the job cannot run what it claims to run.',
      );
    }
  });

  test('defect 17: NEGATIVE CONTROL — the derivation and the ordering both bite', () => {
    const files = ['a/spawner.ts', 'a/entry.test.ts', 'b/quiet.test.ts'];

    // The planted samples are *assembled* rather than written out, and that is
    // not fastidiousness. This file shells out to git in `teeIntoRepository`, so
    // it satisfies the spawn half of the conjunction; a sample written literally
    // inside a `path.join(...)` would satisfy the path half, and the checker
    // would report its own test fixtures as a finding. It did, on the first run —
    // the same false positive defect 16's comment produced, one layer up.
    // Assembling keeps the source clean without teaching the checker to ignore a
    // filename, which is the kind of exemption that later hides a real hit.
    const seg = (s: string): string => `'${s}'`;
    const nm = seg(['node', 'modules'].join('_'));

    // The conjunction, both halves. A skip-list of directory names is not a
    // spawn target, and a spawn that never touches node_modules is not a
    // dependency on one.
    assert.equal(spawnsFromNodeModules(`spawnSync(n, [path.join(r, ${nm}, 'tsc')])`), true);

    // The shape that actually occurs, and the reason the matcher tolerates one
    // level of nested parentheses: a `[^)]*` gap would end at the `)` of `cwd()`
    // and miss the only hit in the repository that matters.
    assert.equal(
      spawnsFromNodeModules(`spawnSync(n, [path.join(process.cwd(), ${nm}, 'tsc')])`),
      true,
      'the nested call in the real hit must not hide it',
    );

    assert.equal(spawnsFromNodeModules(`const skip = new Set([${nm}, '.git']);`), false);
    assert.equal(spawnsFromNodeModules("spawnSync('git', ['status']);"), false);
    assert.equal(
      spawnsFromNodeModules(`// path.join(r, ${nm}, 'x')\nspawnSync(a);`),
      false,
      'a comment describing the shape is not the shape',
    );

    // Formatting-independence, which is defect 3 itself. The first version of
    // this check tested line by line and relied on an ignore list being spread
    // across several lines; `pnpm format` reflowed it onto one and the check
    // broke. The formatter decides which of these two is in the file, so the
    // answer must not depend on which one it picked.
    const oneLine = `spawn(x);\nconst i = [${nm}, '.venv', 'dist'];`;
    const reflowed = `spawn(x);\nconst i = [\n  ${nm},\n  '.venv',\n  'dist',\n];`;
    assert.equal(spawnsFromNodeModules(oneLine), spawnsFromNodeModules(reflowed));
    assert.equal(spawnsFromNodeModules(oneLine), false, 'an ignore list builds no path');

    // Glob expansion reaches the file, so the script inherits its need.
    assert.deepEqual(filesReachedBy('node --test "a/**/*.test.ts"', files), ['a/entry.test.ts']);
    assert.deepEqual(filesReachedBy('node --test b/quiet.test.ts', files), ['b/quiet.test.ts']);

    // Ordering: install after the script is not an install.
    const before = [
      'jobs:',
      '  x:',
      '    steps:',
      '      - run: pnpm install --frozen-lockfile',
      '      - run: pnpm test',
    ].join('\n');
    assert.deepEqual(jobsMissingInstall(before, ['test']), []);

    const after = [
      'jobs:',
      '  x:',
      '    steps:',
      '      - run: pnpm test',
      '      - run: pnpm install --frozen-lockfile',
    ].join('\n');
    assert.deepEqual(jobsMissingInstall(after, ['test']), ['x:test']);

    // The exact original mistake, and the fact that it is per-job: another job
    // installing does not help this one.
    const missing = [
      'jobs:',
      '  other:',
      '    steps:',
      '      - run: pnpm install --frozen-lockfile',
      '  x:',
      '    steps:',
      '      - run: pnpm test',
    ].join('\n');
    assert.deepEqual(jobsMissingInstall(missing, ['test']), ['x:test']);

    // `pnpm test:smoke` is not `pnpm test`.
    const smoke = ['jobs:', '  x:', '    steps:', '      - run: pnpm test:smoke'].join('\n');
    assert.deepEqual(jobsMissingInstall(smoke, ['test']), []);
  });

  test('the release workflow still requires both enforcement tiers', () => {
    // Not one of the four, but the property they were all discovered while
    // protecting: §18's rule that a release cannot pass by skipping a tier.
    const release = workflows().find((w) => w.name === 'release.yml');
    assert.ok(release, 'release.yml should exist');
    assert.match(release!.text, /KERNEL_CONTAINER_REQUIRED: '1'/);
    assert.match(release!.text, /KERNEL_NATIVE_REQUIRED: '1'/);
    assert.match(release!.text, /RELEASE BLOCKED/);
  });
});
