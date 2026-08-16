/**
 * missing / stale / mismatched, all refused (alpha.8 §16, §26; ADR-0020).
 *
 * These run everywhere, including macOS and Windows, because the *identity*
 * question has nothing to do with Landlock: it is two SHA-256s and a JSON file.
 * That matters — the native suites only run on Linux, so without this the
 * launcher-refusal rules would be untested on the machine most of this project's
 * development happens on.
 *
 * The stale case is the one worth reading. alpha.7 detected it by mtime and
 * alpha.8 detects it by content, and the test that distinguishes the two is
 * `a launcher rebuilt from changed source is stale even when its mtime is newer`
 * — which the mtime implementation fails and the content one passes.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  verifyLauncher,
  writeLauncherManifest,
  manifestPathFor,
  describeLauncher,
} from '../../src/execution/linux-native/identity.ts';

let dir: string;
let binary: string;
let source: string;

const META = { kernelVersion: '0.1.0', compiler: 'cc', flags: ['-O2'] };

/** A "launcher" that is just bytes: identity never runs the thing it verifies. */
async function build(sourceText: string, binaryText: string): Promise<void> {
  await writeFile(source, sourceText, 'utf8');
  await writeFile(binary, binaryText, 'utf8');
  await chmod(binary, 0o755);
  writeLauncherManifest(binary, source, META);
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'launcher-identity-'));
  binary = path.join(dir, 'mycoder-sandbox');
  source = path.join(dir, 'mycoder-sandbox.c');
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('launcher identity', () => {
  test('a freshly built launcher verifies', async () => {
    await build('int main(void){return 0;}', 'ELF-ish bytes v1');

    const verdict = verifyLauncher(binary, source);
    assert.equal(verdict.ok, true);
    assert.ok(verdict.ok && verdict.manifest.sourceSha256.length === 64);
  });

  test('a missing binary is refused, and the remedy is the build command', async () => {
    const verdict = verifyLauncher(path.join(dir, 'not-built'), source);
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok);
    assert.equal(verdict.problem, 'missing');
    assert.match(verdict.reason, /not built/);
    assert.match(verdict.remedy, /build-sandbox/);
  });

  test('a binary with no manifest is refused rather than assumed fine', async () => {
    await build('int main(void){return 0;}', 'bytes');
    await rm(manifestPathFor(binary));

    const verdict = verifyLauncher(binary, source);
    assert.ok(!verdict.ok);
    assert.equal(verdict.problem, 'manifest-missing');
    // A binary with no manifest has no provenance at all, sitting at the path the
    // kernel is about to hand its isolation guarantee to.
    assert.match(verdict.reason, /nothing records what it was built from/);
  });

  test('a replaced binary is mismatched, and the remedy says to find out what did it', async () => {
    await build('int main(void){return 0;}', 'the real launcher');
    await writeFile(binary, 'something else entirely', 'utf8');

    const verdict = verifyLauncher(binary, source);
    assert.ok(!verdict.ok);
    assert.equal(verdict.problem, 'mismatched');
    assert.match(verdict.reason, /Something replaced it/);
    assert.match(verdict.remedy, /find out what did/);
  });

  test('a launcher built from older source is stale, and says what it would enforce', async () => {
    await build('int main(void){ /* v1 rules */ return 0;}', 'binary-v1');
    // The kernel ships new source; the binary was not rebuilt.
    await writeFile(source, 'int main(void){ /* v2 rules, stricter */ return 0;}', 'utf8');

    const verdict = verifyLauncher(binary, source);
    assert.ok(!verdict.ok);
    assert.equal(verdict.problem, 'stale');
    assert.match(verdict.reason, /would enforce the rules that older source described/);
  });

  test('a launcher rebuilt from changed source is stale even when its mtime is newer', async () => {
    // The case that made alpha.7's mtime check wrong, and the reason this module
    // exists. mtime says "the binary is newer than the source, so it is fresh";
    // content says "this binary was not built from that source". Only one of them
    // is answering the question.
    await build('int main(void){ /* v1 */ return 0;}', 'binary-v1');
    await writeFile(source, 'int main(void){ /* v2 */ return 0;}', 'utf8');

    const old = new Date(Date.now() - 60_000);
    await utimes(source, old, old);
    const now = new Date();
    await utimes(binary, now, now);

    const verdict = verifyLauncher(binary, source);
    assert.ok(!verdict.ok, 'a newer mtime must not make a differently-built binary look fresh');
    assert.equal(verdict.problem, 'stale');
  });

  test('extraction order does not make a good launcher look stale', async () => {
    // The mirror image, and the one that would have broken every packaged
    // install: tar and npm set mtimes from the extraction, so a correctly built
    // launcher can easily end up older than its own source on disk.
    await build('int main(void){return 0;}', 'binary');

    const later = new Date(Date.now() + 60_000);
    await utimes(source, later, later);

    const verdict = verifyLauncher(binary, source);
    assert.equal(
      verdict.ok,
      true,
      'content is identical, so the launcher is current whatever the mtimes say',
    );
  });

  test('a corrupt manifest is refused, not treated as absent', async () => {
    await build('int main(void){return 0;}', 'bytes');
    await writeFile(manifestPathFor(binary), '{ not json', 'utf8');

    const verdict = verifyLauncher(binary, source);
    assert.ok(!verdict.ok);
    assert.equal(verdict.problem, 'manifest-invalid');
  });

  test('a manifest without real digests is refused', async () => {
    await build('int main(void){return 0;}', 'bytes');
    await writeFile(
      manifestPathFor(binary),
      JSON.stringify({ sourceSha256: 'short', binarySha256: 'also-short' }),
      'utf8',
    );

    const verdict = verifyLauncher(binary, source);
    assert.ok(!verdict.ok);
    assert.equal(verdict.problem, 'manifest-invalid');
  });

  test('a missing source means the binary cannot be verified, so it is refused', async () => {
    await build('int main(void){return 0;}', 'bytes');
    await rm(source);

    const verdict = verifyLauncher(binary, source);
    assert.ok(!verdict.ok);
    assert.match(verdict.reason, /cannot be verified/);
  });

  test('every refusal names a remedy, and none of them suggests a fallback', async () => {
    // alpha.8 §13 and alpha.7 §9: `--backend linux-native` never degrades to
    // `local`. A remedy that said "or use --backend local" would be the downgrade
    // written into the documentation instead of the code.
    const cases: Array<() => Promise<void>> = [
      async () => {
        await build('a', 'b');
        await rm(manifestPathFor(binary));
      },
      async () => {
        await build('a', 'b');
        await writeFile(binary, 'c', 'utf8');
      },
      async () => {
        await build('a', 'b');
        await writeFile(source, 'a2', 'utf8');
      },
    ];

    for (const setup of cases) {
      await setup();
      const verdict = verifyLauncher(binary, source);
      assert.ok(!verdict.ok);
      assert.ok(verdict.remedy.length > 0, 'every refusal must name a remedy');
      assert.doesNotMatch(
        `${verdict.reason} ${verdict.remedy}`,
        /--backend local|fall back|fallback/i,
        'a refusal must never offer a weaker backend as the fix',
      );
    }
  });

  test('the manifest records what a reader needs to reproduce the build', async () => {
    await build('int main(void){return 0;}', 'bytes');
    const manifest = JSON.parse(await readFile(manifestPathFor(binary), 'utf8')) as Record<string, unknown>;

    for (const field of ['sourceSha256', 'binarySha256', 'kernelVersion', 'compiler', 'flags', 'builtAt']) {
      assert.ok(field in manifest, `the manifest should record ${field}`);
    }
  });

  test('--sandbox-status renders both the ok and the refused case', async () => {
    await build('int main(void){return 0;}', 'bytes');
    const good = describeLauncher(verifyLauncher(binary, source), source);
    assert.match(good, /verdict\s*:\s*ok/);
    assert.match(good, /built from/);

    await writeFile(source, 'changed', 'utf8');
    const bad = describeLauncher(verifyLauncher(binary, source), source);
    assert.match(bad, /verdict\s*:\s*stale/);
    assert.match(bad, /build-sandbox/);
  });
});
