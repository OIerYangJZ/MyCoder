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

export function typeStrippingUnsupportedMessage(found: string): string;

/**
 * Can this runtime load the entry point the shim is about to hand it?
 *
 * A separate question from the version floor, and the two came apart on a real
 * machine: a distro Node well above the floor, built without Amaro, so
 * `process.features.typescript` is `false` and a `.ts` entry point dies with
 * `ERR_UNKNOWN_FILE_EXTENSION`. `feature` is passed in rather than read, so the
 * decision stays a pure function; `undefined` — a Node too old to report the
 * field — is treated as "no", which is correct for those versions.
 */
export function checkTypeStripping(
  entryIsTypeScript: boolean,
  feature: string | boolean | undefined,
  foundText: string,
): RuntimeVerdict;
