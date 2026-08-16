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
 * this is not a YAML linter, it is four specific traps that have already been
 * fallen into once each.
 *
 * Each check is also fed a planted bad sample, because a workflow checker that
 * silently stopped matching would report a clean repository — which is what a
 * clean repository looks like. Same reason `tests/lint/lint-selftest.test.ts`
 * exists.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const WORKFLOW_DIR = path.join(process.cwd(), '.github', 'workflows');

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
      if (r.status === 0) continue;
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

describe('workflow hazards (alpha.8 defects 13-16)', () => {
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
