/**
 * Types for the plain-JavaScript runtime check (ADR-0019 §3).
 *
 * `bin/runtime-check.mjs` is deliberately not TypeScript — a version check that
 * cannot be parsed by the version it is checking for is not a version check — so
 * it carries no inline types. This file gives `tsc --noEmit` and the
 * runtime-version suite something to check against, without putting a single type
 * annotation into a file that has to parse on the versions being rejected.
 */

export type NodeVersion = readonly [number, number, number];

export interface RuntimeVerdict {
  ok: boolean;
  /** Present only when `ok` is false. */
  message?: string;
}

export const EXIT_UNAVAILABLE: number;

export function parseVersion(text: string): NodeVersion | null;
export function isOlder(a: NodeVersion, b: NodeVersion): boolean;
export function runtimeUnsupportedMessage(found: string, required: string): string;

/**
 * Fails **open** when either side is unparseable: this guards ergonomics, not a
 * boundary, and refusing to start over an unreadable version string would turn a
 * cosmetic problem into an outage.
 */
export function checkRuntime(foundText: string, floor: NodeVersion | null): RuntimeVerdict;
