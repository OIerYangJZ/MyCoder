/**
 * HTML → text, for `WebFetch` (ADR-0017).
 *
 * Not a parser and not trying to be one. It strips the elements whose *contents*
 * are not prose — script, style, and the rest — drops the remaining tags, decodes
 * the handful of entities that actually appear in text, and collapses the
 * whitespace HTML leaves behind.
 *
 * Two things it deliberately does not do. It does not execute anything, which is
 * why a regex is an adequate tool here: the output is text destined for a context
 * window, not a DOM anyone will act on. And it does not try to reconstruct
 * layout, because a model reads `# Heading` and a blank line perfectly well and
 * every heuristic beyond that costs more in wrong guesses than it returns.
 *
 * The output is untrusted content either way; `WebFetch` is what labels it.
 */

/** Elements whose text content is markup or code rather than prose. */
const DROPPED_ELEMENTS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'head'];

/** Elements that end a line of prose. */
const BLOCK_ELEMENTS =
  /<\/?(?:p|div|section|article|header|footer|nav|aside|main|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tr|td|th|pre|blockquote|form|figure|figcaption|hr|br)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Surrogates and out-of-range code points come back as themselves rather
      // than as a replacement character, so a malformed entity is visible.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** The contents of `<title>`, if there is one. */
export function htmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html);
  if (!match) return undefined;
  const title = collapse(decodeEntities(match[1]!.replace(/<[^>]*>/g, ' ')));
  return title === '' ? undefined : title;
}

/**
 * One block element, one line.
 *
 * Whitespace inside a block is collapsed whatever it was in the source, because
 * a newline in the markup is not a line in the rendered page and treating it as
 * one produces text whose shape says something the page did not. Blocks are
 * separated by a `\0` sentinel first, so the collapse cannot erase a boundary
 * that a tag established.
 */
const BREAK = '\u0000';

export function htmlToText(html: string): string {
  let text = html;

  // Comments first: a tag inside a comment is not a tag.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  for (const element of DROPPED_ELEMENTS) {
    // Unterminated elements are dropped to the end of the document rather than
    // left behind: a truncated response cut mid-`<script>` must not spill its
    // contents into the model's context.
    text = text.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?</${element}\\s*>`, 'gi'), ' ');
    text = text.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ');
  }

  // Headings and list items keep a marker; the model reads structure from it.
  text = text.replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `${BREAK}${'#'.repeat(Number(level))} `);
  text = text.replace(/<li\b[^>]*>/gi, `${BREAK}- `);
  text = text.replace(BLOCK_ELEMENTS, BREAK);
  text = text.replace(/<[^>]*>/g, '');

  text = decodeEntities(text);

  return text
    .split(BREAK)
    .map((block) => collapse(block))
    .filter((block) => block !== '' && block !== '-' && block !== '#')
    .join('\n');
}

function collapse(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}
