/**
 * Colour inside a fenced code block.
 *
 * **This is a colouring heuristic, not a parser.** It knows keywords, strings,
 * comments and numbers, and it is wrong about anything subtler — a here-doc, a
 * template literal with an embedded expression, a regex containing a quote. Nothing
 * may ever branch on its output; it decides how bytes look and never what they mean.
 *
 * The invariant that makes it safe to run over the model's own words: **stripping
 * the escape codes returns the input byte for byte.** Every branch below either
 * copies a slice through unchanged or wraps it in a palette call, and a palette call
 * only ever adds a prefix and a suffix. `tests/unit/highlight.test.ts` asserts it for
 * every language against fixtures chosen to break a hand-written lexer.
 *
 * The `Palette` is a parameter rather than an import, so `NO_COLOR`, `--json` and a
 * pipe turn highlighting off without a second switch: the palette is already a
 * no-op in all three, and a no-op palette makes this function the identity.
 */

import type { Palette } from './render.ts';

/**
 * Carried between lines, because a stream is not a file.
 *
 * A `/* … *​/` or a triple-quoted string spans deltas. Highlighting strictly per
 * line — what `reference/clio` does — renders every line after the opener as code.
 */
export interface BlockState {
  inBlockComment: boolean;
}

export function newBlockState(): BlockState {
  return { inBlockComment: false };
}

interface Language {
  keywords: ReadonlySet<string>;
  types: ReadonlySet<string>;
  /** Everything from here to end of line is a comment. */
  lineComment?: string;
  /** Opener and closer, for languages that have one. */
  block?: readonly [string, string];
  strings: readonly string[];
  /** Coloured by line prefix instead of lexed. */
  byPrefix?: boolean;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(' '));

/** An alias is a string naming the entry it shares. */
type Entry = Language | string;

/**
 * One enumeration, not one per language — and it has to be *literally* one binding.
 *
 * The first version of this file gave each language its own `const`, which is seven
 * enumerations to the audit's detector however the comment above them described it.
 * `pnpm lint` said so. Aliases are strings pointing at the canonical name rather than
 * shared references to named constants, so the whole vocabulary is one row in
 * `docs/alpha12-enumeration-audit.md`, and the tenth language costs nothing further.
 *
 * Its verdict there is `CLOSED`: a keyword set is a vocabulary, and there is no
 * second copy in this repository for it to drift from. A missing keyword renders a
 * word unstyled, which is self-evident on sight and is the whole of the cost.
 */
const LANGUAGES: Readonly<Record<string, Entry>> = {
  typescript: {
    keywords: words(
      'const let var function class extends implements interface type enum if else for while do return import export from as async await new this super throw try catch finally switch case break continue default void typeof instanceof in of yield delete readonly public private protected static get set satisfies keyof infer',
    ),
    types: words(
      'string number boolean void unknown never null undefined bigint symbol any object true false',
    ),
    lineComment: '//',
    block: ['/*', '*/'],
    strings: ['"', "'", '`'],
  },
  ts: 'typescript',
  tsx: 'typescript',
  javascript: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',

  python: {
    keywords: words(
      'def class lambda if elif else for while return yield import from as try except finally raise with pass break continue global nonlocal assert del and or not in is async await match case',
    ),
    types: words(
      'int float str bool bytes list dict set tuple frozenset object type range None True False self',
    ),
    lineComment: '#',
    strings: ['"', "'"],
  },
  py: 'python',

  rust: {
    keywords: words(
      'fn let mut const static struct enum union trait impl dyn pub use mod crate super self Self if else match loop while for in return break continue move ref where unsafe async await extern type as box',
    ),
    types: words(
      'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc Cow true false',
    ),
    lineComment: '//',
    block: ['/*', '*/'],
    strings: ['"'],
  },
  rs: 'rust',

  c: {
    keywords: words(
      'if else for while do switch case default break continue return goto sizeof typedef struct union enum static extern const volatile register inline restrict',
    ),
    types: words('void char short int long float double signed unsigned size_t ssize_t bool NULL true false'),
    lineComment: '//',
    block: ['/*', '*/'],
    strings: ['"', "'"],
  },
  h: 'c',

  bash: {
    keywords: words(
      'if then elif else fi for while until do done case esac function return local export readonly declare shift exit source trap set unset in',
    ),
    types: words('true false'),
    lineComment: '#',
    strings: ['"', "'"],
  },
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',

  json: {
    keywords: new Set<string>(),
    types: words('true false null'),
    strings: ['"'],
  },

  // Our own configuration format. `reference/clio` has no entry for it, and a block
  // of TOML is the single most likely thing to appear in a session about this program.
  toml: {
    keywords: new Set<string>(),
    types: words('true false'),
    lineComment: '#',
    strings: ['"', "'"],
  },

  diff: {
    keywords: new Set<string>(),
    types: new Set<string>(),
    strings: [],
    byPrefix: true,
  },
  patch: 'diff',
};

/** Follow one alias hop. Aliases never point at aliases; nothing here needs them to. */
function lookup(lang: string): Language | undefined {
  const entry = LANGUAGES[lang.trim().toLowerCase()];
  const resolved = typeof entry === 'string' ? LANGUAGES[entry] : entry;
  return typeof resolved === 'string' ? undefined : resolved;
}

/** Derived, so that adding a language does not create a second list to keep in step. */
export function languageNames(): readonly string[] {
  return Object.keys(LANGUAGES);
}

export function isKnownLanguage(lang: string): boolean {
  return lookup(lang) !== undefined;
}

const isWordChar = (ch: string): boolean => /[\w$]/.test(ch);
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/**
 * Colour one line.
 *
 * Returns the input unchanged for a language it does not know — an unknown fence is
 * common, and guessing with another language's keywords is worse than plain.
 */
export function highlightLine(line: string, lang: string, p: Palette, state: BlockState): string {
  const language = lookup(lang);
  if (!language) return line;
  if (language.byPrefix) return byPrefix(line, p);

  let out = '';
  let i = 0;

  // A block comment that opened on an earlier line runs until its closer.
  if (state.inBlockComment && language.block) {
    const close = line.indexOf(language.block[1]);
    if (close === -1) return p.dim(line);
    const end = close + language.block[1].length;
    out += p.dim(line.slice(0, end));
    state.inBlockComment = false;
    i = end;
  }

  while (i < line.length) {
    const ch = line[i] as string;
    const rest = line.slice(i);

    if (language.block && rest.startsWith(language.block[0])) {
      const close = rest.indexOf(language.block[1], language.block[0].length);
      if (close === -1) {
        state.inBlockComment = true;
        out += p.dim(rest);
        return out;
      }
      const end = close + language.block[1].length;
      out += p.dim(rest.slice(0, end));
      i += end;
      continue;
    }

    if (language.lineComment !== undefined && rest.startsWith(language.lineComment)) {
      out += p.dim(rest);
      return out;
    }

    if (language.strings.includes(ch)) {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      // An unterminated string runs to the end of the line; `slice` past the end is
      // the empty string, so nothing is lost either way.
      out += p.green(line.slice(i, Math.min(j, line.length)));
      i = Math.min(j, line.length);
      continue;
    }

    if (isDigit(ch)) {
      let j = i;
      while (j < line.length && /[\w.]/.test(line[j] as string)) j += 1;
      out += p.yellow(line.slice(i, j));
      i = j;
      continue;
    }

    if (isWordChar(ch)) {
      let j = i;
      while (j < line.length && isWordChar(line[j] as string)) j += 1;
      const word = line.slice(i, j);
      if (language.keywords.has(word)) out += p.blue(word);
      else if (language.types.has(word)) out += p.cyan(word);
      else out += word;
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** A diff is read by its first column, not lexed. */
function byPrefix(line: string, p: Palette): string {
  if (line.startsWith('+++') || line.startsWith('---')) return p.dim(line);
  if (line.startsWith('@@')) return p.cyan(line);
  if (line.startsWith('+')) return p.green(line);
  if (line.startsWith('-')) return p.red(line);
  return line;
}
