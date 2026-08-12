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

/**
 * The projections a rule may inspect.
 *
 * Two are needed, and conflating them is how five rules in this file were
 * silently dead until the self-test suite was written (alpha.3 §39).
 *
 * `code` blanks string *contents*, which is right for a rule about identifiers:
 * `fetch(` inside a string is a mention, not a call, and `// never read
 * process.env` is advice, not a read.
 *
 * `text` keeps string contents, which is required for anything whose subject
 * *is* a string: a module specifier (`'./step'`), a credential literal, a
 * provider name in a comparison. Matching those against `code` can never
 * succeed, and a rule that can never succeed reports zero violations — which is
 * indistinguishable from a clean repository.
 */
export interface RuleContext {
  file: string;
  lines: readonly string[];
  /** Comments, regex literals and string contents blanked. */
  code: string;
  /** Comments and regex literals blanked; string contents preserved. */
  text: string;
}

export interface Rule {
  name: string;
  /** Why this rule exists, printed with the first violation. */
  rationale: string;
  /** Files this rule applies to, relative to the repo root and POSIX-slashed. */
  applies(file: string): boolean;
  check(ctx: RuleContext): Violation[];
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
export interface BlankOptions {
  /**
   * Keep the characters inside string literals, blanking only the quotes.
   *
   * Comments and regex literals are still blanked either way: a rule that
   * *describes* `process.env` in a pattern is not *reading* it, and a comment
   * saying "do not call fetch() here" is the opposite of a violation.
   */
  keepStringContents?: boolean;
}

export function blankNonCode(source: string, opts: BlankOptions = {}): string {
  const keepStrings = opts.keepStringContents ?? false;
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
      // The quote characters themselves are kept when contents are: a rule
      // matching `from 'node:http'` needs the delimiters to anchor on.
      if (c === "'") {
        state = 'single';
        out += keepStrings ? c : ' ';
        i += 1;
        continue;
      }
      if (c === '"') {
        state = 'double';
        out += keepStrings ? c : ' ';
        i += 1;
        continue;
      }
      if (c === '`') {
        state = 'template';
        out += keepStrings ? c : ' ';
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
      // Escapes are preserved verbatim when contents are kept, so a specifier
      // or a credential literal survives intact rather than gaining two spaces.
      out += keepStrings ? source.slice(i, i + 2) : '  ';
      i += 2;
      continue;
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
      out += keepStrings ? c : ' ';
      i += 1;
      continue;
    }
    out += c === '\n' ? '\n' : keepStrings ? c : ' ';
    i += 1;
  }

  return out;
}

/**
 * Suppression pragmas.
 *
 * Reviving the five dead rules (see `RuleContext`) surfaced eight sites in
 * `src/` where a vendor name is *data*, not coupling: the secret scanner has to
 * know what an `sk-ant-` key looks like, `scrubEnv` has to name the variables it
 * denies, and the default egress allowlist has to name the hosts it allows. The
 * rule is right that a provider name in `src/security/` deserves a second look;
 * it is wrong that these particular ones are defects.
 *
 * The alternative — carving whole files out of the rule — would also stop
 * covering the next line added to those files, which is the line that would
 * actually be a defect. A per-line pragma with a mandatory reason keeps the rule
 * live everywhere and puts the justification where the reader is:
 *
 *   // lint-allow no-provider-names-in-core: a secret scanner must know key shapes
 *
 * on the offending line or the line immediately above it. The reason is not
 * decorative — a pragma without one does not suppress anything, so a bare
 * `// lint-allow` cannot be used to silence a rule without saying why.
 *
 * `lint-allow-file` exists for one case: a file whose *content is fixtures*, of
 * which there is currently exactly one (the linter's own self-test).
 */
const PRAGMA = /(?:^|\W)lint-allow\s+([a-z-]+)\s*:\s*(\S.*)$/;
const FILE_PRAGMA = /(?:^|\W)lint-allow-file\s+([a-z-]+)\s*:\s*(\S.*)$/;

/** Rules suppressed for a whole file by a header pragma. */
function fileSuppressions(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  // Header only: a `lint-allow-file` buried at line 400 would be invisible to
  // anyone reading the top of the file to find out what it is exempt from.
  for (const line of lines.slice(0, 40)) {
    const m = FILE_PRAGMA.exec(line);
    if (m) out.add(m[1]!);
  }
  return out;
}

const IS_COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * True when this rule is pragma-suppressed at this 1-based line.
 *
 * The search covers the offending line and the *whole* contiguous comment block
 * above it, not just the single line above. A justification worth writing is
 * often two sentences long, and a suppression that silently stopped working
 * because someone wrapped the comment would put the rule back to firing on a
 * site that was already reviewed — which is how a gate gets switched off.
 */
function suppressedAt(lines: readonly string[], line: number, rule: string): boolean {
  const matches = (candidate: string | undefined): boolean => {
    if (candidate === undefined) return false;
    const m = PRAGMA.exec(candidate);
    return m !== null && m[1] === rule;
  };

  if (matches(lines[line - 1])) return true;

  for (let i = line - 2; i >= 0; i -= 1) {
    const candidate = lines[i];
    if (candidate === undefined || !IS_COMMENT.test(candidate)) break;
    if (matches(candidate)) return true;
  }
  return false;
}

export function applySuppressions(violations: readonly Violation[], lines: readonly string[]): Violation[] {
  const forFile = fileSuppressions(lines);
  return violations.filter((v) => !forFile.has(v.rule) && !suppressedAt(lines, v.line, v.rule));
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

export const RULES: Rule[] = [
  {
    name: 'no-raw-network',
    rationale:
      'AGENTS.md #9 / spec §14.1: every outbound byte must go through EgressGate.send(), which is where ' +
      'host allowlists, secret scanning and audit live. A second network client is a second, unaudited egress path.',
    applies: (f) => f !== 'src/security/egress-gate.ts',
    check: ({ file, code, text }) => [
      ...scan(file, code, /(^|[^.\w])fetch\s*\(/, 'no-raw-network', 'calls fetch() directly'),
      // The module specifier is a string, so this one reads `text`.
      ...scan(
        file,
        text,
        /from\s+['"]node:https?['"]|require\(['"]https?['"]\)/,
        'no-raw-network',
        'imports node:http(s)',
      ),
      ...scan(file, code, /new\s+WebSocket\s*\(/, 'no-raw-network', 'opens a WebSocket directly'),
    ],
  },

  {
    name: 'no-ambient-env-spawn',
    rationale:
      'AGENTS.md #8 / spec §13.4 / invariant 13: a child process must never inherit the host environment. ' +
      'Build it with scrubEnv() and inject credentials as an explicit SecretLease.',
    applies: () => true,
    check: ({ file, code }) =>
      scan(
        file,
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
    check: ({ file, code }) => scan(file, code, /\bprocess\.env\b/, 'no-host-env-read', 'reads process.env'),
  },

  {
    name: 'no-child-process-outside-execution',
    rationale:
      "Spec §12: spawning is the executor's job. A tool that spawns directly bypasses the capability profile, " +
      'the environment scrub and the output redactor.',
    applies: (f) => under(f, 'src/') && !under(f, 'src/execution/'),
    check: ({ file, text }) =>
      scan(
        file,
        text,
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
    // alpha.2 §4 and §35 name the full set of directories that must stay
    // provider-neutral. `security/` and `execution/` were missing: a credential
    // path or an executor that learned a vendor name would be exactly the
    // coupling this rule exists to stop.
    applies: (f) =>
      under(
        f,
        'src/session/',
        'src/context/',
        'src/tools/',
        'src/policy/',
        'src/security/',
        'src/execution/',
        'src/edit/',
        'src/control/',
      ),
    check: ({ file, text }) => [
      // The vendor name standing alone: a string comparison, a config key, a
      // bare identifier. Case-insensitive, since `DeepSeek` and `deepseek` are
      // the same coupling.
      ...scan(
        file,
        text,
        /\b(anthropic|openai|claude|gpt-\d|gemini|deepseek)\b/i,
        'no-provider-names-in-core',
        'names a specific model provider outside the adapter layer',
      ),
      // The vendor name buried in an identifier — `openaiQuirk`,
      // `useAnthropic`, `deepseek_mode` — which `\b` cannot see, because the
      // boundary is a case change or an underscore rather than a non-word
      // character. This one is deliberately case-*sensitive*: a lookahead
      // cannot distinguish `Q` from `q` under the `i` flag, so the two spellings
      // have to be written out. The cost is a longer pattern; the alternative is
      // a rule that misses the most idiomatic way to write the coupling.
      ...scan(
        file,
        text,
        /(?:anthropic|openai|claude|gemini|deepseek)(?=[A-Z0-9_])|[a-z0-9_](?:Anthropic|OpenAI|OpenAi|Claude|Gemini|DeepSeek)/,
        'no-provider-names-in-core',
        'names a specific model provider inside an identifier, outside the adapter layer',
      ),
    ],
  },

  {
    name: 'explicit-ts-extension',
    rationale:
      'Node runs this source directly with no bundler, so a relative import without a .ts extension fails at ' +
      'runtime — and only on the code path that imports it.',
    applies: (f) => f.endsWith('.ts'),
    check: ({ file, text }) =>
      scan(
        file,
        text,
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
    check: ({ file, code }) => [
      ...scan(file, code, /:\s*any\b/, 'no-any', 'uses the `any` type'),
      ...scan(file, code, /\bas\s+any\b/, 'no-any', 'casts to `any`'),
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
    check: ({ file, code }) =>
      scan(
        file,
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
    // Reads `text`: a credential in a fixture *is* a string literal, so the
    // code projection could never have matched one.
    check: ({ file, text }) => [
      // Real key shapes, minus the documented fake prefixes.
      ...scan(
        file,
        text,
        /\bsk-ant-api03-(?!abcdef)[A-Za-z0-9_-]{20,}/,
        'no-real-credentials-in-tests',
        'contains something shaped like a real Anthropic key',
      ),
      ...scan(
        file,
        text,
        /\bghp_(?!fake|abcdef)[A-Za-z0-9]{30,}/,
        'no-real-credentials-in-tests',
        'contains something shaped like a real GitHub token',
      ),
      ...scan(
        file,
        text,
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
    const ctx: RuleContext = {
      file,
      lines: source.split('\n'),
      code: blankNonCode(source),
      text: blankNonCode(source, { keepStringContents: true }),
    };

    const found: Violation[] = [];
    for (const rule of RULES) {
      if (!rule.applies(file)) continue;
      found.push(...rule.check(ctx));
    }
    violations.push(...applySuppressions(found, ctx.lines));
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
