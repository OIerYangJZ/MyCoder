#!/usr/bin/env node
/**
 * Architecture linter.
 *
 * This is `pnpm lint`, and it is deliberately **not** ESLint.
 *
 * A generic style linter would mostly duplicate what `tsc --strict` and Prettier
 * already do, at the cost of a large dependency tree in a package whose whole
 * point is a small auditable surface (ADR-0009). What ESLint would *not* do is
 * enforce the rules that actually matter here — the ones AGENTS.md states and
 * the next-phase plan lists under "Architecture Stop":
 *
 *   - no raw network client outside the egress gate;
 *   - no subprocess inheriting the ambient environment;
 *   - no provider-specific code in the session / context / tool layers;
 *   - no reading the host environment outside the components allowed to.
 *
 * Those are project invariants, not style preferences, and each maps to a
 * release-blocking invariant in spec §25. Encoding them here makes the gate
 * mechanical instead of a review convention someone eventually forgets.
 *
 * Usage:  node scripts/lint.ts [--json]
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

export interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
}

interface Rule {
  name: string;
  /** Why this rule exists, printed with the first violation. */
  rationale: string;
  /** Files this rule applies to, relative to the repo root and POSIX-slashed. */
  applies(file: string): boolean;
  check(file: string, lines: readonly string[], source: string): Violation[];
}

// --- helpers ---------------------------------------------------------------

/**
 * Blank out comments, string literals and regex literals so a rule matches real
 * code.
 *
 * Positions are preserved (characters are replaced, not removed) so line
 * numbers still line up with the original file.
 *
 * Regex literals have to be understood, not just skipped: a pattern like
 * `/\/\*[\s\S]*?\*\//` contains what looks like a comment delimiter, and a
 * scanner that misses it desynchronises for the rest of the file. It is also
 * semantically right to blank them — a rule that *describes* `process.env` in a
 * pattern is not *reading* it.
 */
function blankNonCode(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' = 'code';
  /** Last significant code character, used to tell a regex from a division. */
  let lastCode = '';
  let inCharClass = false;

  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      // A `/` starts a regex when the previous significant character cannot end
      // an expression. This is the standard heuristic and is sufficient here.
      if (c === '/' && (lastCode === '' || '(,=:[!&|?{};+-*%~^<>'.includes(lastCode))) {
        state = 'regex';
        inCharClass = false;
        out += ' ';
        i += 1;
        continue;
      }
      if (c === "'") {
        state = 'single';
        out += ' ';
        i += 1;
        continue;
      }
      if (c === '"') {
        state = 'double';
        out += ' ';
        i += 1;
        continue;
      }
      if (c === '`') {
        state = 'template';
        out += ' ';
        i += 1;
        continue;
      }
      out += c;
      if (!/\s/.test(c)) lastCode = c;
      i += 1;
      continue;
    }

    if (state === 'regex') {
      if (c === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '[') inCharClass = true;
      else if (c === ']') inCharClass = false;
      else if (c === '/' && !inCharClass) {
        state = 'code';
        lastCode = '/';
        out += ' ';
        i += 1;
        continue;
      } else if (c === '\n') {
        // An unterminated regex means the heuristic misfired; recover.
        state = 'code';
        out += '\n';
        i += 1;
        continue;
      }
      out += ' ';
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    // inside a string literal
    if (c === '\\') {
      out += '  ';
      i += 2;
      continue;
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
      out += ' ';
      i += 1;
      continue;
    }
    out += c === '\n' ? '\n' : ' ';
    i += 1;
  }

  return out;
}

function scan(file: string, code: string, pattern: RegExp, rule: string, message: string): Violation[] {
  const out: Violation[] = [];
  const lines = code.split('\n');
  lines.forEach((line, index) => {
    const re = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
    if (re.test(line)) out.push({ file, line: index + 1, rule, message });
  });
  return out;
}

const under = (file: string, ...dirs: string[]): boolean => dirs.some((d) => file.startsWith(d));

// --- rules -----------------------------------------------------------------

const RULES: Rule[] = [
  {
    name: 'no-raw-network',
    rationale:
      'AGENTS.md #9 / spec §14.1: every outbound byte must go through EgressGate.send(), which is where ' +
      'host allowlists, secret scanning and audit live. A second network client is a second, unaudited egress path.',
    applies: (f) => f !== 'src/security/egress-gate.ts',
    check: (f, _l, code) => [
      ...scan(f, code, /(^|[^.\w])fetch\s*\(/, 'no-raw-network', 'calls fetch() directly'),
      ...scan(
        f,
        code,
        /from\s+['"]node:https?['"]|require\(['"]https?['"]\)/,
        'no-raw-network',
        'imports node:http(s)',
      ),
      ...scan(f, code, /new\s+WebSocket\s*\(/, 'no-raw-network', 'opens a WebSocket directly'),
    ],
  },

  {
    name: 'no-ambient-env-spawn',
    rationale:
      'AGENTS.md #8 / spec §13.4 / invariant 13: a child process must never inherit the host environment. ' +
      'Build it with scrubEnv() and inject credentials as an explicit SecretLease.',
    applies: () => true,
    check: (f, _l, code) =>
      scan(
        f,
        code,
        /env\s*:\s*process\.env/,
        'no-ambient-env-spawn',
        'passes process.env to a child process',
      ),
  },

  {
    name: 'no-host-env-read',
    rationale:
      'Spec §13.4: reading the host environment is confined to the components that build a scrubbed one, ' +
      'resolve a credential, or locate platform directories. Everywhere else it is a leak waiting to happen.',
    applies: (f) =>
      under(f, 'src/') &&
      ![
        'src/security/env-scrub.ts', // builds the allowlisted environment
        'src/security/secret-broker.ts', // the one component allowed to read a credential
        'src/util/platform.ts', // XDG / Application Support resolution
        'src/execution/local.ts', // PATH lookup for optional tooling
        'src/kernel.ts', // registers provider credentials by reference at boot
      ].includes(f),
    check: (f, _l, code) => scan(f, code, /\bprocess\.env\b/, 'no-host-env-read', 'reads process.env'),
  },

  {
    name: 'no-child-process-outside-execution',
    rationale:
      "Spec §12: spawning is the executor's job. A tool that spawns directly bypasses the capability profile, " +
      'the environment scrub and the output redactor.',
    applies: (f) => under(f, 'src/') && !under(f, 'src/execution/'),
    check: (f, _l, code) =>
      scan(
        f,
        code,
        /from\s+['"]node:child_process['"]/,
        'no-child-process-outside-execution',
        'imports node:child_process',
      ),
  },

  {
    name: 'no-provider-names-in-core',
    rationale:
      'AGENTS.md #7 / spec §2.5 / invariant 6 — and the plan\'s "Architecture Stop". Provider quirks belong in ' +
      'model/adapters/. A provider name in the loop means the loop has learned to branch on one.',
    applies: (f) => under(f, 'src/session/', 'src/context/', 'src/tools/', 'src/policy/', 'src/edit/'),
    check: (f, _l, code) =>
      scan(
        f,
        code,
        /\b(anthropic|openai|claude|gpt-\d|gemini|deepseek)\b/i,
        'no-provider-names-in-core',
        'names a specific model provider outside the adapter layer',
      ),
  },

  {
    name: 'explicit-ts-extension',
    rationale:
      'Node runs this source directly with no bundler, so a relative import without a .ts extension fails at ' +
      'runtime — and only on the code path that imports it.',
    applies: (f) => f.endsWith('.ts'),
    check: (f, _l, code) =>
      scan(
        f,
        code,
        /(?:from|import)\s*\(?\s*['"]\.\.?\/[^'"]*(?<!\.ts)(?<!\.js)(?<!\.json)['"]/,
        'explicit-ts-extension',
        'relative import is missing its .ts extension',
      ),
  },

  {
    name: 'no-any',
    rationale:
      'Tool arguments and provider payloads are untrusted input. `unknown` forces a check at the boundary; ' +
      '`any` silently removes it.',
    applies: (f) => under(f, 'src/'),
    check: (f, _l, code) => [
      ...scan(f, code, /:\s*any\b/, 'no-any', 'uses the `any` type'),
      ...scan(f, code, /\bas\s+any\b/, 'no-any', 'casts to `any`'),
    ],
  },

  // Note: there is deliberately no `no-parameter-properties` rule here.
  // `tsconfig.json` sets `erasableSyntaxOnly`, so `pnpm typecheck` already
  // rejects them precisely and with a better message. A regex approximation
  // could not tell a parameter property from a `readonly string[]` *type*
  // annotation, and a linter that cries wolf gets switched off.

  {
    name: 'no-console-in-kernel',
    rationale:
      'Spec §26.1 counts the user-visible debug log as a leak surface. The logger routes through the secret ' +
      'redactor; console.log does not.',
    applies: (f) => under(f, 'src/') && !under(f, 'src/cli/'),
    check: (f, _l, code) =>
      scan(
        f,
        code,
        /\bconsole\.(log|error|warn|info|debug)\s*\(/,
        'no-console-in-kernel',
        'writes to console instead of the logger',
      ),
  },

  {
    name: 'no-real-credentials-in-tests',
    rationale:
      'Plan §3.3: CI must never depend on a real credential. Fixtures use obviously-fake values so a leak in ' +
      'the fixture itself is not a leak of anything.',
    applies: (f) => under(f, 'tests/', 'evals/'),
    check: (f, _l, code) => [
      // Real key shapes, minus the documented fake prefixes.
      ...scan(
        f,
        code,
        /\bsk-ant-api03-(?!abcdef)[A-Za-z0-9_-]{20,}/,
        'no-real-credentials-in-tests',
        'contains something shaped like a real Anthropic key',
      ),
      ...scan(
        f,
        code,
        /\bghp_(?!fake|abcdef)[A-Za-z0-9]{30,}/,
        'no-real-credentials-in-tests',
        'contains something shaped like a real GitHub token',
      ),
      ...scan(
        f,
        code,
        /\bAKIA(?!FAKEVALUE)[A-Z0-9]{16}\b/,
        'no-real-credentials-in-tests',
        'contains something shaped like a real AWS key id',
      ),
    ],
  },
];

// --- driver ----------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.agent']);

async function collect(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) await collect(rel, acc);
    else if (entry.name.endsWith('.ts')) acc.push(rel);
  }
  return acc;
}

export async function lint(): Promise<Violation[]> {
  const files = [
    ...(await collect('src')),
    ...(await collect('tests')),
    ...(await collect('evals')),
    ...(await collect('scripts')),
  ].sort();

  const violations: Violation[] = [];

  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    const code = blankNonCode(source);
    const lines = source.split('\n');

    for (const rule of RULES) {
      if (!rule.applies(file)) continue;
      violations.push(...rule.check(file, lines, code));
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

async function main(argv: readonly string[]): Promise<number> {
  const violations = await lint();

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ violations, count: violations.length }, null, 2)}\n`);
    return violations.length === 0 ? 0 : 1;
  }

  if (violations.length === 0) {
    process.stdout.write(`architecture lint: ${RULES.length} rules, no violations\n`);
    return 0;
  }

  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
  }

  for (const [rule, found] of byRule) {
    const rationale = RULES.find((r) => r.name === rule)?.rationale ?? '';
    process.stdout.write(`\n${rule} (${found.length})\n  ${rationale}\n\n`);
    for (const v of found) {
      process.stdout.write(`  ${v.file}:${v.line}  ${v.message}\n`);
    }
  }

  process.stdout.write(`\narchitecture lint: ${violations.length} violation(s)\n`);
  return 1;
}

/** True when this module is the process entry point, on every platform. */
function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

// Run when invoked directly rather than imported. `pathToFileURL` is required
// rather than string concatenation: on Windows `process.argv[1]` is a
// backslash path, so `file://${argv[1]}` never equals `import.meta.url` and the
// entry point silently does nothing — exit 0, no output, no error.
if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`lint failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 2;
    });
}
