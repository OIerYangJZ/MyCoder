/**
 * Redactor — the single place where a secret becomes `[REDACTED:secret/<fp>]`.
 *
 * Two mechanisms, both needed:
 *
 *  1. **Literal set.** Values the kernel *knows* are secret: leases handed to a
 *     subprocess, user-registered values, canary fixtures. These are matched
 *     exactly, and also in the encodings a process is likely to emit them in
 *     (base64, hex, URL-encoded, JSON-escaped). A subprocess that base64s its
 *     environment must not defeat redaction.
 *
 *  2. **Pattern scan.** Credentials the kernel has never seen, found by shape.
 *
 * The mapping fingerprint → value lives only here, in memory. It is never
 * persisted: the event log stores the placeholder (spec §13.2).
 */

import { fingerprint } from '../util/ids.ts';
import { scanSecrets, type SecretConfidence } from './secret-scanner.ts';

export function redactionPlaceholder(fp: string): string {
  return `[REDACTED:secret/${fp}]`;
}

interface LiteralEntry {
  value: string;
  fingerprint: string;
  /** Alternate encodings of the same value that must also be caught. */
  variants: string[];
  refCount: number;
}

export interface RedactOptions {
  minConfidence?: SecretConfidence;
  /** When false, only registered literals are redacted (no shape matching). */
  patterns?: boolean;
}

export class Redactor {
  private readonly literals = new Map<string, LiteralEntry>();

  /**
   * Register a known secret value. Returns its placeholder so callers can show
   * the model a stable reference.
   */
  addLiteral(value: string): string {
    if (value.length < 4) return value;
    const existing = this.literals.get(value);
    if (existing) {
      existing.refCount += 1;
      return redactionPlaceholder(existing.fingerprint);
    }
    const fp = fingerprint(value);
    this.literals.set(value, {
      value,
      fingerprint: fp,
      variants: encodingVariants(value),
      refCount: 1,
    });
    return redactionPlaceholder(fp);
  }

  /**
   * Drop a lease's value from the active set. Reference-counted, because the
   * same credential may back two concurrent leases.
   */
  removeLiteral(value: string): void {
    const entry = this.literals.get(value);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) this.literals.delete(value);
  }

  get activeLiteralCount(): number {
    return this.literals.size;
  }

  literalValues(): string[] {
    return [...this.literals.keys()];
  }

  /**
   * Replace every known or shape-detected secret in `text`.
   *
   * Literals are replaced first: they are exact and cheap, and doing them first
   * means a pattern rule cannot mangle a literal's boundaries.
   */
  redact(text: string, opts: RedactOptions = {}): string {
    if (text === '') return text;
    let out = text;

    for (const entry of this.literals.values()) {
      const placeholder = redactionPlaceholder(entry.fingerprint);
      out = replaceAllLiteral(out, entry.value, placeholder);
      for (const variant of entry.variants) {
        if (variant === entry.value) continue;
        out = replaceAllLiteral(out, variant, placeholder);
      }
    }

    if (opts.patterns === false) return out;

    const findings = scanSecrets(out, { minConfidence: opts.minConfidence ?? 'medium' });
    if (findings.length === 0) return out;

    // Replace right-to-left so earlier offsets stay valid.
    let result = out;
    for (let i = findings.length - 1; i >= 0; i -= 1) {
      const f = findings[i]!;
      result = result.slice(0, f.start) + redactionPlaceholder(f.fingerprint) + result.slice(f.end);
    }
    return result;
  }

  /** True when redaction would change the text. Used by egress hard-blocks. */
  wouldRedact(text: string, opts: RedactOptions = {}): boolean {
    return this.redact(text, opts) !== text;
  }

  /**
   * Assert that no *registered* literal survives in `text`.
   *
   * Distinct from `wouldRedact`: this ignores shape-based findings, so it answers
   * the narrow question the security tests ask — "did a known credential escape?"
   */
  containsKnownLiteral(text: string): boolean {
    for (const entry of this.literals.values()) {
      if (text.includes(entry.value)) return true;
      for (const variant of entry.variants) {
        if (variant.length >= 8 && text.includes(variant)) return true;
      }
    }
    return false;
  }
}

function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  if (needle === '' || !haystack.includes(needle)) return haystack;
  return haystack.split(needle).join(replacement);
}

/**
 * Encodings a leaking process realistically produces. Kept small on purpose —
 * this is defence in depth, not a promise of completeness, and the honest
 * statement of that limit is in docs/threat-model.md.
 */
function encodingVariants(value: string): string[] {
  const variants = new Set<string>();
  try {
    variants.add(Buffer.from(value, 'utf8').toString('base64'));
    variants.add(Buffer.from(value, 'utf8').toString('base64url'));
    variants.add(Buffer.from(value, 'utf8').toString('hex'));
    variants.add(encodeURIComponent(value));
    variants.add(JSON.stringify(value).slice(1, -1));
  } catch {
    // Encoding failures are not fatal; the exact literal is still covered.
  }
  variants.delete(value);
  return [...variants].filter((v) => v.length >= 8);
}

/** Process-wide redactor used by the logger sanitiser hook. */
export const globalRedactor = new Redactor();
