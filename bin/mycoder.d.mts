/**
 * Types for the plain-JavaScript entry shim (ADR-0019 §3).
 *
 * `bin/mycoder.mjs` is deliberately not TypeScript — a version check that cannot
 * be parsed by the version it is checking for is not a version check — so it
 * carries no inline types. This file gives `tsc --noEmit` and the
 * runtime-version suite something to check against, without putting a single
 * type annotation into the file that has to parse on an unsupported Node.
 */

export type NodeVersion = readonly [number, number, number];

export interface RuntimeVerdict {
  ok: boolean;
  /** Present only when `ok` is false. */
  message?: string;
}

/** The §8 message: what was found, what is required, and what to do about it. */
export function runtimeUnsupportedMessage(found: string, required: string): string;

/**
 * Is `foundText` at or above `floor`?
 *
 * Fails **open** when either is unparseable: this guards ergonomics, not a
 * boundary, and refusing to start over an unreadable version string would turn a
 * cosmetic problem into an outage.
 */
export function checkRuntime(foundText: string, floor: NodeVersion | null): RuntimeVerdict;
