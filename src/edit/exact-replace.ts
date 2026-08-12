/**
 * ExactReplaceStrategy (spec §10.1, ADR-0006).
 *
 * v0.1 ships exactly one edit strategy, and it is the boring one: find a literal
 * string, verify it is unique, replace it. No fuzzy matching, no whitespace
 * tolerance, no "closest match" recovery.
 *
 * That restraint is the point. A fuzzy strategy that silently edits the
 * almost-right location produces a diff that looks plausible and is wrong, and
 * the model has no way to notice. Failing with `NON_UNIQUE_MATCH` and making the
 * model add context costs one extra step and cannot corrupt the file.
 *
 * Line endings are preserved: matching happens on LF-normalised text, and the
 * file's dominant style is re-applied on write (spec §10.3).
 */

import { applyEol, detectEol, toLf, type EolStyle } from '../util/text.ts';

export interface ExactReplaceInput {
  /** Current file content, exactly as read from disk. */
  currentContent: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
  /** Offsets from the freshness check, in LF-normalised coordinates. */
  matchOffsets: readonly number[];
}

export interface ExactReplaceOutput {
  /** New content with the original line-ending style restored. */
  newContent: string;
  /** LF-normalised form, used for hashing and diffing. */
  newContentLf: string;
  oldContentLf: string;
  replacements: number;
  eol: EolStyle;
  /** True when the source file mixed CRLF and LF. */
  mixedEol: boolean;
  finalNewlineChanged: boolean;
}

export function applyExactReplace(input: ExactReplaceInput): ExactReplaceOutput {
  const eolInfo = detectEol(input.currentContent);
  const oldLf = toLf(input.currentContent);
  const needle = toLf(input.oldString);
  const replacement = toLf(input.newString);

  const offsets = input.replaceAll ? [...input.matchOffsets] : input.matchOffsets.slice(0, 1);

  // Build the result right-to-left so earlier offsets stay valid.
  let newLf = oldLf;
  for (let i = offsets.length - 1; i >= 0; i -= 1) {
    const at = offsets[i]!;
    newLf = newLf.slice(0, at) + replacement + newLf.slice(at + needle.length);
  }

  // Preserve whether the file ended with a newline. Adding or removing a
  // trailing newline is a real change to some tools (and to git), so it is only
  // done when the replacement genuinely did it.
  const hadFinalNewline = oldLf.endsWith('\n');
  const hasFinalNewline = newLf.endsWith('\n');

  return {
    newContent: applyEol(newLf, eolInfo.style),
    newContentLf: newLf,
    oldContentLf: oldLf,
    replacements: offsets.length,
    eol: eolInfo.style,
    mixedEol: eolInfo.mixed,
    finalNewlineChanged: hadFinalNewline !== hasFinalNewline,
  };
}

/**
 * Content for a newly created file.
 *
 * A new file gets LF unless the caller knows better — there is no existing style
 * to preserve, and LF is what every toolchain in the target set writes.
 */
export function prepareCreate(content: string, eol: EolStyle = 'lf'): { content: string; contentLf: string } {
  const lf = toLf(content);
  // A source file that does not end in a newline is a persistent small
  // annoyance (diff noise, POSIX tools). Normalise it once, at creation.
  const withNewline = lf === '' || lf.endsWith('\n') ? lf : `${lf}\n`;
  return { content: applyEol(withNewline, eol), contentLf: withNewline };
}
