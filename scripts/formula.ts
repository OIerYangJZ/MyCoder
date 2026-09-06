#!/usr/bin/env node
/**
 * Point the Homebrew formula at the artifact that was actually packed.
 *
 *   pnpm release:pack        # writes the tarball and prints its sha256
 *   pnpm release:formula     # rewrites Formula/mycoder.rb from that tarball
 *
 * The formula's `url` is the npm registry tarball, and its `sha256` has to be the
 * hash of the bytes at that url. Those bytes are the ones `release:pack` produced,
 * because the release workflow publishes the packed tarball rather than letting
 * `npm publish` re-pack one — so the hash is knowable before the upload, and this
 * is where it is transcribed rather than copied by hand.
 *
 * Two failure modes this exists to make impossible, both of which are silent:
 *
 *   A formula whose `sha256` belongs to a previous version. `brew install` fails
 *   with a checksum mismatch, which reads like a compromised download rather than
 *   like a stale file in this repository.
 *
 *   A formula whose `version` has drifted from `package.json`. Homebrew derives
 *   the version from the url, so a stale url installs an old release under a new
 *   tag. `pnpm mirrors` refuses on that, and this is what keeps it true.
 *
 * Reads the tarball from disk rather than trusting `build-info.json`: the point is
 * the hash of the file that will be uploaded, and a hash read from a sidecar is a
 * hash of whatever the sidecar last described.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
export const FORMULA = path.join('Formula', 'mycoder.rb');

/** The npm registry url for a version of the published package. */
export function registryUrl(name: string, version: string): string {
  // Scoped names put the scope in the path but not in the filename, which is the
  // one part of this that is easy to get wrong and is not currently exercised.
  const file = `${name.replace(/^@[^/]+\//, '')}-${version}.tgz`;
  return `https://registry.npmjs.org/${name}/-/${file}`;
}

/** Rewrite the `url`, `version` and `sha256` lines, and nothing else. */
export function applyToFormula(formula: string, url: string, version: string, sha256: string): string {
  const withUrl = formula.replace(/^(\s*)url\s+".*"$/m, `$1url "${url}"`);
  const withVersion = withUrl.replace(/^(\s*)version\s+".*"$/m, `$1version "${version}"`);
  const withSha = withVersion.replace(/^(\s*)sha256\s+"[0-9a-f]*"$/m, `$1sha256 "${sha256}"`);
  if (withSha === formula) {
    throw new Error(`${FORMULA}: nothing to rewrite — has the formula changed shape?`);
  }
  return withSha;
}

/** The tarball `npm pack` left in the tree. Exactly one, or this is ambiguous. */
function findTarball(root: string): string {
  const found = readdirSync(root).filter((f) => f.endsWith('.tgz'));
  if (found.length === 0) {
    throw new Error('No .tgz in the tree. Run `pnpm release:pack` first.');
  }
  if (found.length > 1) {
    throw new Error(`More than one .tgz in the tree (${found.join(', ')}); remove the stale ones.`);
  }
  return found[0]!;
}

function main(): void {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const tarball = findTarball(ROOT);
  const sha256 = createHash('sha256')
    .update(readFileSync(path.join(ROOT, tarball)))
    .digest('hex');
  const url = registryUrl(pkg.name, pkg.version);

  const formulaPath = path.join(ROOT, FORMULA);
  const updated = applyToFormula(readFileSync(formulaPath, 'utf8'), url, pkg.version, sha256);
  writeFileSync(formulaPath, updated);

  process.stdout.write(
    `${FORMULA} updated\n` +
      `  url     : ${url}\n` +
      `  version : ${pkg.version}\n` +
      `  sha256  : ${sha256}\n` +
      `  from    : ${tarball}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
