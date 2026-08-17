#!/usr/bin/env node
/**
 * Mirror-list checks (alpha.12 CLOSURE B).
 *
 * alpha.6 shipped an evidence matrix that the gate's hardcoded `MATRICES` list
 * did not include. It stayed invisible for five milestones, in the mechanism
 * whose entire purpose is catching drift, while another document cited it as the
 * home of two open claims. alpha.11 fixed that one list and added the check that
 * would have caught it. This module asks the obvious next question:
 *
 * > A hand-maintained list that mirrors something else will stop mirroring it.
 * > The question is never whether, only whether anything will say so.
 *
 * There are 96 hardcoded enumerations across `src/` and `scripts/` — counted by
 * `findEnumerations` rather than by hand, and the audit's own stated totals are
 * checked against it, because a number in a document is a mirror too. Most are
 * *supposed* to be closed — a list of allowed statuses, a set of forbidden mount
 * destinations, a JSON schema. Those cannot drift, because there is nothing for
 * them to drift from. The dangerous ones are exactly those that **mirror
 * something else in the repository**, and every one of them is either checked
 * here or written down as unguarded in `docs/alpha12-enumeration-audit.md`.
 *
 * Two rules the audit follows, and this module enforces:
 *
 *   1. every enumeration is in the audit exactly once, and every audit row names
 *      one that exists — both directions, because a row for a deleted constant
 *      is a claim that something is guarded when nothing is;
 *   2. a mirror whose other side is outside this repository — the normative
 *      specification, which lives in `research/` and will be deleted — reports
 *      that it could not check, rather than passing.
 *
 * **Where the gate is.** `tests/lint/mirrors.test.ts`, which runs under
 * `pnpm test` and `pnpm lint:selftest`, i.e. in CI and in the release gate.
 * Every check there has a fixture that makes it fail. This file's `main()` is for
 * reading the report by hand (`node scripts/mirrors.ts`); it is not the gate, and
 * saying so here is cheaper than someone assuming it is.
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SKIP_DIRS } from './lint.ts';

const ROOT = process.cwd();

export interface MirrorProblem {
  /** The mirror this belongs to, as the audit names it. */
  mirror: string;
  message: string;
}

export interface MirrorResult {
  id: string;
  /** What the two sides are, for the report. */
  sides: string;
  problems: MirrorProblem[];
  /**
   * False when one side was unavailable, so nothing was compared. A skipped
   * check that reported success would be worse than no check: it would be a
   * green line in a log saying a thing had been verified.
   */
  checked: boolean;
}

const problem = (mirror: string, message: string): MirrorProblem => ({ mirror, message });

/**
 * Compare two sides of a mirror, and say which side each difference is on.
 *
 * "The lists disagree" is not an actionable message. Which side has the extra
 * member decides what the fix is: a flag in the code and not the document is an
 * undocumented flag, and a flag in the document and not the code is a promise to
 * a script that nothing implements. Those are different bugs.
 */
export function compareSets(
  mirror: string,
  code: Iterable<string>,
  doc: Iterable<string>,
  codeSide: string,
  docSide: string,
): MirrorProblem[] {
  const inCode = new Set(code);
  const inDoc = new Set(doc);
  const problems: MirrorProblem[] = [];

  for (const member of inCode) {
    if (!inDoc.has(member)) {
      problems.push(problem(mirror, `${codeSide} has "${member}" and ${docSide} does not`));
    }
  }
  for (const member of inDoc) {
    if (!inCode.has(member)) {
      problems.push(problem(mirror, `${docSide} has "${member}" and ${codeSide} does not`));
    }
  }
  return problems;
}

// --- extractors: the document side of each mirror ---------------------------

/** The fenced block that follows a heading, which is how these documents list things. */
export function blockAfter(markdown: string, heading: RegExp): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return undefined;

  const open = lines.findIndex((l, i) => i > start && l.trimStart().startsWith('```'));
  if (open < 0) return undefined;
  const close = lines.findIndex((l, i) => i > open && l.trimStart().startsWith('```'));
  if (close < 0) return undefined;

  return lines.slice(open + 1, close).join('\n');
}

/**
 * Flag tokens out of a block of the CLI contract.
 *
 * `-c/--continue` is two tokens, `<id>` is not a token, and a bare `--` is one —
 * it is in `CONTRACT_FLAGS` because "everything after this is not a flag" is a
 * promise a wrapper script depends on.
 */
export function flagTokens(block: string): string[] {
  return [...block.matchAll(/(?<![\w-])(--?[a-z][a-z-]*|--)(?![\w-])/g)].map((m) => m[1]!);
}

export interface ContractDoc {
  contractFlags: string[];
  experimentalFlags: string[];
  contractBackends: string[];
  experimentalBackends: string[];
  subcommands: string[];
  exitCodes: Map<string, number>;
}

/** Everything `docs/cli-contract.md` promises, in the shape `src/cli/args.ts` holds it. */
export function parseCliContract(markdown: string): ContractDoc {
  const sectionOf = (heading: RegExp, next: RegExp): string => {
    const lines = markdown.split('\n');
    const start = lines.findIndex((l) => heading.test(l));
    if (start < 0) return '';
    const end = lines.findIndex((l, i) => i > start && next.test(l));
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
  };

  const contract = sectionOf(/^### Contract/, /^#{2,3} /);
  const experimental = sectionOf(/^### Experimental/, /^#{2,3} /);
  // The contract section writes the value in backticks (`--backend local`) and the
  // experimental block writes it bare, in a column of prose. Requiring the
  // backticks read the first and silently missed the second, which is how this
  // check first reported that EXPERIMENTAL_BACKENDS had a member the document did
  // not — when the document had it, and the parser could not see it. The value
  // must start with a letter so `--backend        -h/--help`, two entries apart in
  // the flag block, cannot be read as a backend called `-h`.
  const backends = (section: string): string[] => [
    ...new Set([...section.matchAll(/--backend[ =]`?([a-z][a-z-]*)/g)].map((m) => m[1]!)),
  ];

  const experimentalFlags = flagTokens(blockAfter(markdown, /^### Experimental/) ?? '').filter(
    // `--backend` appears in the experimental block because one of its *values*
    // is experimental. The flag itself is contract, and that asymmetry is the
    // whole reason CONTRACT_BACKENDS and EXPERIMENTAL_BACKENDS exist.
    (flag) => flag !== '--backend',
  );

  const subcommands = [
    ...new Set(
      [...(blockAfter(markdown, /^## Subcommands/) ?? '').matchAll(/^mycoder\s+([a-z-]+)/gm)].map(
        (m) => m[1]!,
      ),
    ),
  ];

  const exitCodes = new Map<string, number>();
  for (const m of markdown.matchAll(/^\|\s*`(\d+)`\s*\|\s*`([A-Z_]+)`/gm)) {
    exitCodes.set(m[2]!, Number(m[1]));
  }

  return {
    contractFlags: [...new Set(flagTokens(blockAfter(markdown, /^### Contract/) ?? ''))],
    experimentalFlags: [...new Set(experimentalFlags)],
    contractBackends: backends(contract),
    experimentalBackends: backends(experimental),
    subcommands,
    exitCodes,
  };
}

/**
 * The configuration audit's two lists.
 *
 * Only the key is compared, not the prose after the em dash: the explanation is
 * meant to be edited, and a check that failed when somebody improved a sentence
 * would be switched off within a week.
 */
export function parseConfigurationAudit(markdown: string): { keys: string[]; pinned: string[] } {
  const keys = [...markdown.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]!.trim());

  const section = markdown.split(/^## Keys the system ceiling pins/m)[1] ?? '';
  // The backslash strip is not cosmetic: the pinned list is prose, not code, so
  // `[mcp.servers.*]` is written `[mcp.servers.\*]` — Prettier escapes the
  // asterisk to keep it from becoming emphasis, and the escape is invisible to a
  // reader and fatal to a string comparison.
  const pinned = [...section.matchAll(/^-\s+(.+)$/gm)].map((m) =>
    m[1]!.split(' — ')[0]!.replace(/\\/g, '').trim(),
  );

  return { keys, pinned };
}

/** The tier ids ADR-0027 defines. */
export function parseTierList(markdown: string): string[] {
  const block = blockAfter(markdown, /^### 2\. Every item declares a tier/) ?? '';
  return [...block.matchAll(/^(T\d)\s+\S/gm)].map((m) => m[1]!);
}

/** The lifecycle points spec §18.1 says v0.1 supports — the first block, not the "later" one. */
export function parseSpecHookEvents(spec: string): string[] {
  const block = blockAfter(spec, /^## 18\.1/) ?? '';
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Z][A-Za-z]+$/.test(l));
}

// --- the enumeration inventory and the audit that has to cover it -----------

export interface Enumeration {
  file: string;
  line: number;
  name: string;
}

/**
 * Every SCREAMING_SNAKE constant bound to a list, a set or a map, at top level.
 *
 * Deliberately syntactic and deliberately broad. A cleverer detector would need
 * to decide what "an enumeration" is, and the audit's value comes from being
 * unable to make that decision quietly: 93 rows, each with a verdict somebody
 * wrote down. Anything this misses is invisible to the audit too, so the
 * detector's blind spots are the honest limit of CLOSURE B and are named in the
 * audit's own "what this does not cover".
 */
export function findEnumerations(files: ReadonlyArray<{ file: string; source: string }>): Enumeration[] {
  const declaration = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*(?:\[|new Set|\{)/;
  const found: Enumeration[] = [];

  for (const { file, source } of files) {
    source.split('\n').forEach((line, index) => {
      const m = declaration.exec(line);
      if (m?.[1]) found.push({ file, line: index + 1, name: m[1] });
    });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export type Verdict = 'guarded' | 'unguarded' | 'closed';

export interface AuditEntry {
  file: string;
  name: string;
  verdict: Verdict;
  /** For `guarded`, what checks it. For `unguarded`, why not. */
  by: string;
  line: number;
}

const VERDICTS: Record<string, Verdict> = {
  GUARDED: 'guarded',
  UNGUARDED: 'unguarded',
  CLOSED: 'closed',
};

export interface AuditTotals {
  enumerations: number;
  guarded: number;
  unguarded: number;
  closed: number;
}

/**
 * The totals the audit states in its own opening paragraph.
 *
 * A number in a document is a mirror of whatever it counts, and this one had
 * every opportunity to be wrong: the detector found 96 where the milestone plan
 * expected "roughly thirty". Left unchecked it would be the "MUST 18 of 18"
 * sentence again, one document further on.
 */
export function parseAuditTotals(markdown: string): AuditTotals | undefined {
  const total = /\*\*(\d+) enumerations\*\*/.exec(markdown);
  const split = /\*\*(\d+) guarded, (\d+) declared unguarded,\s*\n?(\d+) closed by design\.?\*\*/.exec(
    markdown,
  );
  if (!total?.[1] || !split) return undefined;

  return {
    enumerations: Number(total[1]),
    guarded: Number(split[1]),
    unguarded: Number(split[2]),
    closed: Number(split[3]),
  };
}

/** Parse `docs/alpha12-enumeration-audit.md`'s tables. */
export function parseAudit(markdown: string): { entries: AuditEntry[]; problems: MirrorProblem[] } {
  const entries: AuditEntry[] = [];
  const problems: MirrorProblem[] = [];

  markdown.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) return;

    const cells = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    // `| `NAME` | `path/to/file.ts` | VERDICT | why |`
    const name = /^`([A-Z][A-Z0-9_]{2,})`$/.exec(cells[0] ?? '')?.[1];
    const file = /^`([^`]+\.ts)`$/.exec(cells[1] ?? '')?.[1];
    if (name === undefined || file === undefined) return;

    const verdict = VERDICTS[(cells[2] ?? '').replace(/[*`]/g, '').trim()];
    if (verdict === undefined) {
      problems.push(
        problem(
          'the audit',
          `${file} ${name} has verdict "${cells[2]}"; every row is GUARDED, UNGUARDED or CLOSED`,
        ),
      );
      return;
    }

    entries.push({ file, name, verdict, by: cells[3] ?? '', line: index + 1 });
  });

  return { entries, problems };
}

/**
 * The check that would have caught alpha.6, one level up.
 *
 * Both directions. An enumeration with no row is one nobody classified — the
 * MATRICES failure exactly. A row naming nothing is worse in a quieter way: it
 * asserts that something is guarded, or knowingly unguarded, when the thing does
 * not exist, and it is what a rename leaves behind.
 */
export function checkAuditCoverage(
  enumerations: readonly Enumeration[],
  entries: readonly AuditEntry[],
  totals?: AuditTotals,
): MirrorProblem[] {
  const problems: MirrorProblem[] = [];

  if (totals === undefined) {
    problems.push(
      problem(
        'the audit',
        'states no totals in the form "**96 enumerations**" and "**22 guarded, 13 declared unguarded, ' +
          '61 closed by design.**", so its own summary is not checkable',
      ),
    );
  } else {
    const counted = {
      enumerations: enumerations.length,
      guarded: entries.filter((e) => e.verdict === 'guarded').length,
      unguarded: entries.filter((e) => e.verdict === 'unguarded').length,
      closed: entries.filter((e) => e.verdict === 'closed').length,
    };
    for (const [what, stated] of Object.entries(totals)) {
      const actual = counted[what as keyof AuditTotals];
      if (actual !== stated) {
        problems.push(problem('the audit', `says ${what} is ${stated}; the rows give ${actual}`));
      }
    }
  }
  const key = (e: { file: string; name: string }): string => `${e.file}:${e.name}`;

  const rows = new Map<string, AuditEntry[]>();
  for (const entry of entries) rows.set(key(entry), [...(rows.get(key(entry)) ?? []), entry]);

  for (const found of enumerations) {
    const matched = rows.get(key(found));
    if (!matched) {
      problems.push(
        problem(
          'the audit',
          `${found.file}:${found.line} declares ${found.name} and docs/alpha12-enumeration-audit.md ` +
            'does not classify it. Every enumeration gets a verdict, including the boring ones.',
        ),
      );
      continue;
    }
    if (matched.length > 1) {
      problems.push(problem('the audit', `${key(found)} is classified ${matched.length} times`));
    }
  }

  const declaredKeys = new Set(enumerations.map(key));
  for (const entry of entries) {
    if (!declaredKeys.has(key(entry))) {
      problems.push(
        problem(
          'the audit',
          `docs/alpha12-enumeration-audit.md:${entry.line} classifies ${entry.name} in ${entry.file}, ` +
            'which declares no such enumeration. A row for something that no longer exists is a claim ' +
            'that it is covered.',
        ),
      );
    }
  }

  return problems;
}

/** Every mirror check that names a `MIRRORS` id has to be documented, and vice versa. */
export const MIRRORS = [
  'cli-contract',
  'exit-codes',
  'packaged-files',
  'configuration-audit',
  'acceptance-tiers',
  'hook-events',
  'readme-tools',
] as const;

export type MirrorId = (typeof MIRRORS)[number];

// --- the checks -------------------------------------------------------------

export interface CliCode {
  contractFlags: readonly string[];
  experimentalFlags: readonly string[];
  contractBackends: readonly string[];
  experimentalBackends: readonly string[];
  subcommands: readonly string[];
}

/**
 * `docs/cli-contract.md` against `src/cli/args.ts`.
 *
 * The one that mattered most before it existed. ADR-0021 promises that contract
 * semantics do not change within `0.1.x`, and the document making that promise
 * was read by nothing: `tests/integration/cli-contract.test.ts` asserts against
 * `args.ts` itself, so the *code* was consistent with the code. A flag could be
 * added, or moved from experimental to contract, and the one document a script
 * author reads would never have said so.
 */
export function checkCliContract(code: CliCode, doc: ContractDoc): MirrorProblem[] {
  return [
    ...compareSets(
      'cli-contract',
      code.contractFlags,
      doc.contractFlags,
      'CONTRACT_FLAGS',
      'the contract block',
    ),
    ...compareSets(
      'cli-contract',
      code.experimentalFlags,
      doc.experimentalFlags,
      'EXPERIMENTAL_FLAGS',
      'the experimental block',
    ),
    ...compareSets(
      'cli-contract',
      code.contractBackends,
      doc.contractBackends,
      'CONTRACT_BACKENDS',
      'the contract section',
    ),
    ...compareSets(
      'cli-contract',
      code.experimentalBackends,
      doc.experimentalBackends,
      'EXPERIMENTAL_BACKENDS',
      'the experimental section',
    ),
    ...compareSets('cli-contract', code.subcommands, doc.subcommands, 'SUBCOMMANDS', 'the subcommand block'),
  ];
}

/** The exit-code table against `EXIT`. A wrapper script branches on these numbers. */
export function checkExitCodes(
  code: Readonly<Record<string, number>>,
  doc: ReadonlyMap<string, number>,
): MirrorProblem[] {
  const problems = compareSets('exit-codes', Object.keys(code), doc.keys(), 'EXIT', 'the exit-code table');

  for (const [name, value] of Object.entries(code)) {
    const documented = doc.get(name);
    if (documented !== undefined && documented !== value) {
      problems.push(
        problem('exit-codes', `EXIT.${name} is ${value} and the exit-code table says ${documented}`),
      );
    }
  }
  return problems;
}

/**
 * `scripts/package-check.ts` REQUIRED against `package.json` `files`.
 *
 * Not an equality: `files` names directories (`dist/`, `src/`) and REQUIRED names
 * individual files inside them. What must hold is that every required file is
 * *reachable* from some `files` entry — a required file outside the packaged set
 * can never be present, so the check that asserts it is unfalsifiable.
 */
export function checkPackagedFiles(required: readonly string[], files: readonly string[]): MirrorProblem[] {
  const problems: MirrorProblem[] = [];
  // npm packs these whether `files` names them or not, so requiring one is not a
  // contradiction. Getting this wrong made the check's first run report that
  // `package.json` could never be packaged, which is both false and the kind of
  // false failure that gets a gate switched off.
  const always = new Set(['package.json']);

  for (const target of required) {
    if (always.has(target)) continue;
    const covered = files.some((entry) =>
      entry.endsWith('/') ? target.startsWith(entry) : entry === target,
    );
    if (!covered) {
      problems.push(
        problem(
          'packaged-files',
          `package-check requires "${target}" and package.json "files" cannot include it, so the ` +
            'requirement could never be satisfied',
        ),
      );
    }
  }
  return problems;
}

/** `docs/configuration-audit.md` against `WEAKENING_KEYS` and `CEILING_PINNED`. */
export function checkConfigurationAudit(
  code: { keys: readonly string[]; pinned: readonly string[] },
  doc: { keys: readonly string[]; pinned: readonly string[] },
): MirrorProblem[] {
  return [
    ...compareSets('configuration-audit', code.keys, doc.keys, 'WEAKENING_KEYS', 'the relaxation table'),
    ...compareSets(
      'configuration-audit',
      code.pinned.map((p) => p.split(' — ')[0]!.trim()),
      doc.pinned,
      'CEILING_PINNED',
      'the pinned-keys list',
    ),
  ];
}

/** `scripts/acceptance.ts` TIERS against ADR-0027 §2, which is where the tiers are decided. */
export function checkAcceptanceTiers(code: readonly string[], doc: readonly string[]): MirrorProblem[] {
  return compareSets('acceptance-tiers', code, doc, 'TIERS', 'ADR-0027 §2');
}

/**
 * `USER_HOOK_EVENTS` against spec §18.1.
 *
 * The one mirror whose other side is not in this repository. §18.1 also lists
 * four events under 后续 — later — and the check compares against the first
 * block only: implementing one of those would be a capability, and it would show
 * up here as an event the specification does not yet list for v0.1, which is the
 * right place for that argument to happen.
 */
export function checkHookEvents(
  code: readonly string[],
  spec: string | undefined,
): { problems: MirrorProblem[]; checked: boolean } {
  if (spec === undefined) return { problems: [], checked: false };
  return {
    problems: compareSets('hook-events', code, parseSpecHookEvents(spec), 'USER_HOOK_EVENTS', 'spec §18.1'),
    checked: true,
  };
}

/** Number words, because README counts its own list and the count is part of the claim. */
const NUMBERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** The tool names README claims are core, and the number it says there are. */
export function parseReadmeTools(markdown: string): { names: string[]; count?: number } {
  const m = /([a-z]+) core tools:([\s\S]*?)all behind/.exec(markdown);
  if (!m) return { names: [] };

  const names = [...(m[2] ?? '').matchAll(/`([A-Z][A-Za-z]+)`/g)].map((x) => x[1]!);
  const stated = NUMBERS.indexOf((m[1] ?? '').toLowerCase());
  return stated >= 0 ? { names, count: stated } : { names };
}

/** Every tool name a builtin declares, from the `name:` field of its definition. */
export function builtinToolNames(files: ReadonlyArray<{ file: string; source: string }>): string[] {
  const names = new Set<string>();
  for (const { file, source } of files) {
    if (!file.startsWith('src/tools/builtin/')) continue;
    for (const m of source.matchAll(/^\s{4}name:\s*'([A-Z][A-Za-z]+)'/gm)) names.add(m[1]!);
  }
  return [...names];
}

/**
 * README's tool list against the tools that exist.
 *
 * **One direction only, and the asymmetry is deliberate.** Every tool README
 * calls core must exist, and the number it states must match the list it prints.
 * The reverse — every builtin appearing in README — is false by design:
 * `WebFetch` is registered only when a host is configured, `Delegate` only when
 * something can be delegated, and `Undo` and `Skill` are conditional too. README
 * says so in prose immediately below the list.
 *
 * So a *new* core tool missing from README would not be caught here. Closing that
 * would need a second hardcoded list saying which builtins are conditional —
 * another mirror, of the kind this closure exists to reduce. The gap is recorded
 * in `docs/alpha12-enumeration-audit.md` rather than papered over.
 */
export function checkReadmeTools(
  readme: { names: readonly string[]; count?: number },
  builtins: readonly string[],
): MirrorProblem[] {
  const problems: MirrorProblem[] = [];
  const existing = new Set(builtins);

  for (const name of readme.names) {
    if (!existing.has(name)) {
      problems.push(
        problem('readme-tools', `README calls "${name}" a core tool and no builtin declares that name`),
      );
    }
  }
  if (readme.names.length === 0) {
    problems.push(
      problem('readme-tools', 'README no longer lists its core tools where this check looks for them'),
    );
  }
  if (readme.count !== undefined && readme.count !== readme.names.length) {
    problems.push(
      problem(
        'readme-tools',
        `README says there are ${readme.count} core tools and lists ${readme.names.length}`,
      ),
    );
  }
  return problems;
}

// --- driver -----------------------------------------------------------------

/** Every `.ts` file under the trees the audit covers. */
export async function sources(
  dirs: readonly string[] = ['src', 'scripts'],
): Promise<Array<{ file: string; source: string }>> {
  const out: Array<{ file: string; source: string }> = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.name.endsWith('.ts'))
        out.push({ file: rel, source: await readFile(path.join(ROOT, rel), 'utf8') });
    }
  };

  for (const dir of dirs) await walk(dir);
  return out;
}

async function main(): Promise<number> {
  const read = (rel: string): Promise<string> => readFile(path.join(ROOT, rel), 'utf8');

  const [args, exitCodes, weakening, hooks, acceptance] = await Promise.all([
    import('../src/cli/args.ts'),
    import('../src/cli/exit-codes.ts'),
    import('../src/config/weakening.ts'),
    import('../src/extensions/hooks.ts'),
    import('./acceptance.ts'),
  ]);
  const { REQUIRED } = await import('./package-check.ts');

  const contract = parseCliContract(await read('docs/cli-contract.md'));
  const configAudit = parseConfigurationAudit(await read('docs/configuration-audit.md'));
  const tiers = parseTierList(await read('docs/adr/ADR-0027-acceptance-tiers-and-the-rc1-gate.md'));
  const pkg = JSON.parse(await read('package.json')) as { files?: string[] };

  let spec: string | undefined;
  try {
    spec = await read('../research/kernel_v0.1_technical_spec.md');
  } catch {
    spec = undefined;
  }
  const hookEvents = checkHookEvents([...hooks.USER_HOOK_EVENTS], spec);

  const results: MirrorResult[] = [
    {
      id: 'cli-contract',
      sides: 'src/cli/args.ts ↔ docs/cli-contract.md',
      problems: checkCliContract(
        {
          contractFlags: args.CONTRACT_FLAGS,
          experimentalFlags: args.EXPERIMENTAL_FLAGS,
          contractBackends: args.CONTRACT_BACKENDS,
          experimentalBackends: args.EXPERIMENTAL_BACKENDS,
          subcommands: args.SUBCOMMANDS,
        },
        contract,
      ),
      checked: true,
    },
    {
      id: 'exit-codes',
      sides: 'src/cli/exit-codes.ts ↔ docs/cli-contract.md',
      problems: checkExitCodes(exitCodes.EXIT, contract.exitCodes),
      checked: true,
    },
    {
      id: 'packaged-files',
      sides: 'scripts/package-check.ts ↔ package.json files',
      problems: checkPackagedFiles(REQUIRED, pkg.files ?? []),
      checked: true,
    },
    {
      id: 'configuration-audit',
      sides: 'src/config/weakening.ts ↔ docs/configuration-audit.md',
      problems: checkConfigurationAudit(
        { keys: weakening.WEAKENING_KEYS.map((k) => k.key), pinned: weakening.CEILING_PINNED },
        configAudit,
      ),
      checked: true,
    },
    {
      id: 'acceptance-tiers',
      sides: 'scripts/acceptance.ts ↔ ADR-0027 §2',
      problems: checkAcceptanceTiers([...acceptance.TIERS], tiers),
      checked: true,
    },
    {
      id: 'hook-events',
      sides: 'src/extensions/hooks.ts ↔ spec §18.1',
      problems: hookEvents.problems,
      checked: hookEvents.checked,
    },
  ];

  const tree = await sources();
  results.push({
    id: 'readme-tools',
    sides: 'src/tools/builtin/ ↔ README.md',
    problems: checkReadmeTools(parseReadmeTools(await read('README.md')), builtinToolNames(tree)),
    checked: true,
  });

  const enumerations = findEnumerations(tree);
  const auditMarkdown = await read('docs/alpha12-enumeration-audit.md');
  const audit = parseAudit(auditMarkdown);
  const coverage = [
    ...audit.problems,
    ...checkAuditCoverage(enumerations, audit.entries, parseAuditTotals(auditMarkdown)),
  ];

  for (const result of results) {
    const state = result.checked
      ? `${result.problems.length} problem(s)`
      : 'NOT CHECKED — one side unavailable';
    process.stdout.write(`${result.id.padEnd(20)} ${result.sides}\n  ${state}\n`);
  }
  process.stdout.write(
    `\n${enumerations.length} enumeration(s) in src/ and scripts/; ` +
      `${audit.entries.length} classified in docs/alpha12-enumeration-audit.md ` +
      `(${audit.entries.filter((e) => e.verdict === 'unguarded').length} declared unguarded)\n`,
  );

  const all = [...results.flatMap((r) => r.problems), ...coverage];
  if (all.length === 0) {
    process.stdout.write('every mirror agrees with the thing it mirrors\n');
    return 0;
  }

  process.stdout.write(`\n${all.length} problem(s):\n\n`);
  for (const p of all) process.stdout.write(`  [${p.mirror}] ${p.message}\n`);
  return 1;
}

/** True when this module is the process entry point, on every platform. */
function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`mirrors failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 2;
    });
}

export { main };
