/**
 * Does this launcher belong to this kernel? (ADR-0020, alpha.8 §16.)
 *
 * alpha.7 answered "is it stale?" with **mtime**: the binary had to be newer
 * than `native/mycoder-sandbox.c`. That worked in a git checkout and stops
 * working the moment the tree is packed and unpacked, because npm, tar and git
 * all set mtimes from the extraction rather than from the original. On a
 * packaged install the mtime test answers a question about when files were
 * unpacked — which can report a correctly-built launcher as stale, and, worse,
 * can report a launcher built from *different* source as fresh.
 *
 * So identity is by content. `build-sandbox` records the SHA-256 of the source
 * it compiled and of the binary it produced; startup recomputes both from what
 * is on disk and compares. That answers all three of §16's cases with one
 * mechanism, and keeps answering them after the tree has been shipped:
 *
 *     missing      no binary, or no manifest beside it
 *     mismatched   the binary is not the one the manifest describes
 *     stale        the source has moved on since the binary was built
 *
 * Every one of them is a **refusal**. None of them is a downgrade to `local`:
 * alpha.7 §9 survives packaging, and packaging is precisely the pressure that
 * produces "just fall back so it works".
 *
 * Why hash on every start rather than cache: a cached verdict is a verdict about
 * a file that may since have changed, and two SHA-256s of a small C file and a
 * ~50 KB binary cost well under a millisecond on a path that already spends
 * 0.5–0.8 ms per exec.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

export interface LauncherManifest {
  /** SHA-256 of `native/mycoder-sandbox.c` as it was when the binary was built. */
  sourceSha256: string;
  /** SHA-256 of the binary this manifest was written beside. */
  binarySha256: string;
  kernelVersion: string;
  compiler: string;
  flags: string[];
  builtAt: string;
}

/**
 * Why a launcher was refused.
 *
 * A vocabulary rather than a sentence, because ADR-0021 asks that a wrapper
 * script be able to tell these apart without parsing English — "you never built
 * it" and "somebody replaced it" have very different responses.
 */
export type LauncherProblem = 'missing' | 'manifest-missing' | 'manifest-invalid' | 'stale' | 'mismatched';

export type LauncherVerdict =
  | { ok: true; manifest: LauncherManifest; binary: string }
  | { ok: false; problem: LauncherProblem; reason: string; remedy: string; binary: string };

export function manifestPathFor(binary: string): string {
  return `${binary}.manifest.json`;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Record what was just built, beside the binary.
 *
 * Here rather than in `build.ts` so that anything producing a launcher writes
 * the *same* manifest — including the live suites, which compile variants into a
 * temp directory (one of them deliberately with descriptor hygiene disabled, as
 * §21's paired control). A test-built launcher that skipped the manifest would
 * be refused by the very check it is meant to exercise, and the tempting fix —
 * letting the backend accept an unverified binary "just for tests" — is a hole
 * in the check itself.
 */
export function writeLauncherManifest(
  binary: string,
  source: string,
  meta: { kernelVersion: string; compiler: string; flags: readonly string[] },
): LauncherManifest {
  const manifest: LauncherManifest = {
    sourceSha256: sha256File(source),
    binarySha256: sha256File(binary),
    kernelVersion: meta.kernelVersion,
    compiler: meta.compiler,
    flags: [...meta.flags],
    builtAt: new Date().toISOString(),
  };
  writeFileSync(manifestPathFor(binary), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Verify a built launcher against its manifest and the source that ships now.
 *
 * `sourcePath` is the `native/mycoder-sandbox.c` in *this* installation, not the
 * one recorded at build time — that is the entire point. Comparing the manifest
 * against itself would always pass.
 */
export function verifyLauncher(binary: string, sourcePath: string): LauncherVerdict {
  const buildRemedy =
    'Build it on this machine with `mycoder build-sandbox` ' +
    '(or `pnpm build:sandbox` in a checkout). It needs a C compiler and takes about a second.';

  try {
    const st = statSync(binary);
    if (!st.isFile()) {
      return {
        ok: false,
        problem: 'missing',
        binary,
        reason: `${binary} is not a regular file.`,
        remedy: buildRemedy,
      };
    }
  } catch {
    return {
      ok: false,
      problem: 'missing',
      binary,
      reason: `The native launcher is not built: ${binary} does not exist.`,
      remedy: buildRemedy,
    };
  }

  const manifestPath = manifestPathFor(binary);
  let manifest: LauncherManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LauncherManifest;
  } catch (e) {
    // A binary with no manifest is not "probably fine". It is a binary with no
    // provenance at all, sitting at the path the kernel is about to hand its
    // isolation guarantee to.
    const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT';
    return {
      ok: false,
      problem: missing ? 'manifest-missing' : 'manifest-invalid',
      binary,
      reason: missing
        ? `${binary} exists but ${manifestPath} does not, so nothing records what it was built from.`
        : `${manifestPath} could not be read as a manifest.`,
      remedy: buildRemedy,
    };
  }

  if (
    typeof manifest.sourceSha256 !== 'string' ||
    typeof manifest.binarySha256 !== 'string' ||
    manifest.sourceSha256.length !== 64 ||
    manifest.binarySha256.length !== 64
  ) {
    return {
      ok: false,
      problem: 'manifest-invalid',
      binary,
      reason: `${manifestPath} does not carry two SHA-256 digests.`,
      remedy: buildRemedy,
    };
  }

  const actualBinary = sha256File(binary);
  if (actualBinary !== manifest.binarySha256) {
    return {
      ok: false,
      problem: 'mismatched',
      binary,
      reason:
        `${binary} is not the binary its manifest describes ` +
        `(manifest ${short(manifest.binarySha256)}, on disk ${short(actualBinary)}). ` +
        'Something replaced it after it was built.',
      remedy: `Rebuild it: ${buildRemedy} If you did not replace it yourself, find out what did before running anything under it.`,
    };
  }

  let actualSource: string;
  try {
    actualSource = sha256File(sourcePath);
  } catch {
    return {
      ok: false,
      problem: 'manifest-invalid',
      binary,
      reason: `The launcher source ${sourcePath} is missing, so the built binary cannot be verified against it.`,
      remedy: 'Reinstall the package; `native/mycoder-sandbox.c` ships with it.',
    };
  }

  if (actualSource !== manifest.sourceSha256) {
    return {
      ok: false,
      problem: 'stale',
      binary,
      reason:
        `${binary} was built from a different ${sourcePath} ` +
        `(built from ${short(manifest.sourceSha256)}, shipped is ${short(actualSource)}). ` +
        'It would enforce the rules that older source described while this kernel claims the rules the current one does.',
      remedy: buildRemedy,
    };
  }

  return { ok: true, manifest, binary };
}

/** The `--sandbox-status` report (ADR-0020 §4). */
export function describeLauncher(verdict: LauncherVerdict, sourcePath: string): string {
  const lines = [`launcher   : ${verdict.binary}`, `source     : ${sourcePath}`];
  if (verdict.ok) {
    lines.push(
      `verdict    : ok`,
      `built from : ${short(verdict.manifest.sourceSha256)} (source sha256)`,
      `binary     : ${short(verdict.manifest.binarySha256)} (sha256)`,
      `built at   : ${verdict.manifest.builtAt}`,
      `kernel     : ${verdict.manifest.kernelVersion}`,
      `compiler   : ${verdict.manifest.compiler} ${verdict.manifest.flags.join(' ')}`,
    );
  } else {
    lines.push(`verdict    : ${verdict.problem}`, '', verdict.reason, '', verdict.remedy);
  }
  return lines.join('\n');
}

function short(digest: string): string {
  return digest.slice(0, 12);
}
