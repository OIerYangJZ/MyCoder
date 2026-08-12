/**
 * Minimal glob matcher.
 *
 * Implemented in-tree rather than pulled from npm because glob matching is on the
 * security path (protected paths, permission rules) and we do not want that
 * semantics to change under us on a transitive dependency bump.
 *
 * Supported syntax:
 *   *          any run of characters, not crossing `/`
 *   ?          one character, not `/`
 *   **         any run of characters, crossing `/`
 *   a/ ** /b   `**` as a whole segment matches zero or more segments
 *   [abc]      character class; [!abc] / [^abc] negated
 *   {a,b,c}    alternation (may nest)
 *   \x         escape
 *
 * Dotfiles are matched by `*` and `**` — unlike shell globbing. This is
 * deliberate: a protected-path rule of `**\/*.key` must match `.hidden/id.key`.
 */

export interface GlobOptions {
  /** Match without regard to case. Default true — deny-lists must over-match. */
  caseInsensitive?: boolean;
}

function escapeLiteral(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Translate one glob pattern into a regular expression source string.
 * `i` is advanced through the pattern; `stopAt` lets brace groups recurse.
 */
function translate(pattern: string, start: number, stopAt: string | null): { src: string; end: number } {
  let src = '';
  let i = start;

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (stopAt && stopAt.includes(ch)) break;

    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next !== undefined) {
        src += escapeLiteral(next);
        i += 2;
        continue;
      }
      src += '\\\\';
      i += 1;
      continue;
    }

    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        let j = i + 2;
        while (pattern[j] === '*') j += 1;
        const atSegmentStart = i === 0 || pattern[i - 1] === '/';
        const followedBySlash = pattern[j] === '/';
        if (atSegmentStart && followedBySlash) {
          // `**/` matches zero or more whole segments.
          src += '(?:[^/]*/)*';
          i = j + 1;
        } else {
          src += '.*';
          i = j;
        }
        continue;
      }
      src += '[^/]*';
      i += 1;
      continue;
    }

    if (ch === '?') {
      src += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '[') {
      const close = findClassEnd(pattern, i);
      if (close > 0) {
        let body = pattern.slice(i + 1, close);
        let negate = false;
        if (body.startsWith('!') || body.startsWith('^')) {
          negate = true;
          body = body.slice(1);
        }
        // Forbid `/` from ever being matched by a class.
        src += `[${negate ? '^/' : ''}${body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
        i = close + 1;
        continue;
      }
      src += '\\[';
      i += 1;
      continue;
    }

    if (ch === '{') {
      const alts: string[] = [];
      let j = i + 1;
      for (;;) {
        const part = translate(pattern, j, ',}');
        alts.push(part.src);
        j = part.end;
        const delim = pattern[j];
        if (delim === ',') {
          j += 1;
          continue;
        }
        if (delim === '}') {
          j += 1;
          break;
        }
        // Unbalanced brace: treat the `{` literally.
        alts.length = 0;
        break;
      }
      if (alts.length > 0) {
        src += `(?:${alts.join('|')})`;
        i = j;
        continue;
      }
      src += '\\{';
      i += 1;
      continue;
    }

    src += escapeLiteral(ch);
    i += 1;
  }

  return { src, end: i };
}

function findClassEnd(pattern: string, open: number): number {
  let i = open + 1;
  if (pattern[i] === '!' || pattern[i] === '^') i += 1;
  if (pattern[i] === ']') i += 1; // a leading `]` is literal
  while (i < pattern.length) {
    if (pattern[i] === '\\') {
      i += 2;
      continue;
    }
    if (pattern[i] === ']') return i;
    i += 1;
  }
  return -1;
}

const cache = new Map<string, RegExp>();

export function compileGlob(pattern: string, opts: GlobOptions = {}): RegExp {
  const caseInsensitive = opts.caseInsensitive ?? true;
  const key = `${caseInsensitive ? 'i' : 's'}:${pattern}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const { src } = translate(pattern, 0, null);
  const re = new RegExp(`^${src}$`, caseInsensitive ? 'i' : '');
  if (cache.size < 4096) cache.set(key, re);
  return re;
}

export function globMatch(pattern: string, value: string, opts: GlobOptions = {}): boolean {
  return compileGlob(pattern, opts).test(value);
}

/** A compiled set of patterns, evaluated as a disjunction. */
export class GlobSet {
  readonly patterns: readonly string[];
  private readonly regexes: RegExp[];

  constructor(patterns: readonly string[], opts: GlobOptions = {}) {
    this.patterns = patterns;
    this.regexes = patterns.map((p) => compileGlob(p, opts));
  }

  matches(value: string): boolean {
    return this.regexes.some((re) => re.test(value));
  }

  /** Returns the first matching pattern, useful for explaining a denial. */
  firstMatch(value: string): string | undefined {
    for (let i = 0; i < this.regexes.length; i += 1) {
      if (this.regexes[i]!.test(value)) return this.patterns[i];
    }
    return undefined;
  }

  get size(): number {
    return this.patterns.length;
  }
}
