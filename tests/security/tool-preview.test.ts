/**
 * The tool-output preview, against the canary (ADR-0031, spec §26.1).
 *
 * `--verbose` puts a bounded look at what each tool returned into the record, the
 * event log and the terminal. Tool output is the most secret-dense thing in the
 * system — a `Read` of a `.env`, a `Shell` running `env`, a `WebFetch` of a response
 * carrying a bearer token — so this feature is exactly the shape of a leak.
 *
 * Two properties, and the second is the one that is easy to get wrong:
 *
 *   **The canary never appears in a preview.** Not in the record, not in the event
 *   log, not in what the renderer writes.
 *
 *   **Redaction happens before truncation.** Truncating first can cut a secret in
 *   half, and half a token matches no literal and no shape — so it survives
 *   redaction and gets printed. A test that only checks a short output would not
 *   see this; the fixture below is deliberately longer than the preview budget with
 *   the secret sitting across the cut.
 *
 * Per AGENTS.md rule 10, a failure here stops other work.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createTestWorkspace, CANARY, type TestWorkspace } from '../helpers/workspace.ts';
import { PREVIEW_BUDGET } from '../../src/tools/runtime.ts';
import { truncateForModel } from '../../src/util/text.ts';
import { Redactor } from '../../src/security/redactor.ts';

describe('a preview never carries the canary', () => {
  let ws: TestWorkspace;
  const seen: Array<{ type: string; payload: unknown }> = [];

  before(async () => {
    ws = await createTestWorkspace({
      files: {
        '.env': `TEST_CANARY_SECRET=${CANARY}\nOTHER=value\n`,
        'notes.txt': `harmless\n`,
      },
      verbose: true,
      captureEvents: seen,
      script: [
        { kind: 'tools', calls: [{ name: 'Shell', arguments: { argv: ['cat', '.env'] } }] },
        { kind: 'final', text: 'read it' },
      ],
    });
    await ws.kernel.session.runTurn('show me the env file');
  });

  after(async () => {
    await ws.cleanup();
  });

  test('the event log holds no canary, preview or otherwise', async () => {
    const log = await ws.eventLogText();
    assert.equal(log.includes(CANARY), false, 'the canary reached the event log through a preview');
  });

  test('a preview reached the host, so the test above is not vacuous', () => {
    const previews = seen
      .map((e) => (e.payload as { preview?: unknown }).preview)
      .filter((p): p is string => typeof p === 'string');
    assert.ok(previews.length > 0, 'no preview was produced at all — this suite would pass trivially');
    for (const preview of previews) {
      assert.equal(preview.includes(CANARY), false, 'the canary reached the terminal');
    }
  });

  test('and it never reached the log, because a preview is not for the record', async () => {
    // Emitted in-process, stripped before `store.append`. The terminal gets the
    // bytes; the file on disk is exactly what it was before the feature existed.
    const log = await ws.eventLogText();
    assert.equal(log.includes('\"preview\"'), false, 'tool output was persisted');
  });
});

describe('redaction happens before truncation', () => {
  // The ordering property, isolated from the kernel so it can be stated exactly.
  // A secret placed past the byte budget is dropped either way; a secret placed
  // *across* the cut is the one that distinguishes the two orders.

  const redactor = new Redactor();
  redactor.addLiteral(CANARY);

  /** Text with the secret at a chosen byte offset, longer than the budget. */
  const at = (offset: number): string =>
    `${'x'.repeat(offset)}${CANARY}${'y'.repeat(PREVIEW_BUDGET.maxBytes * 2)}`;

  /**
   * An offset where the truncation lands *inside* the secret.
   *
   * Found by scanning rather than computed from the head/tail split, so this test
   * does not encode `truncateForModel`'s internals and cannot quietly stop straddling
   * when they change.
   */
  function straddlingOffset(): number | undefined {
    const half = CANARY.slice(0, Math.floor(CANARY.length / 2));
    for (let offset = 0; offset < PREVIEW_BUDGET.maxBytes; offset += 1) {
      const cut = truncateForModel(at(offset), PREVIEW_BUDGET).text;
      if (!cut.includes(CANARY) && cut.includes(half)) return offset;
    }
    return undefined;
  }

  test('the cut can land inside a secret at all — the premise of the next test', () => {
    assert.notEqual(
      straddlingOffset(),
      undefined,
      'no offset splits the secret; this suite is asleep and needs a new fixture',
    );
  });

  test('truncate-then-redact leaks the fragment, which is why the order is fixed', () => {
    // Asserting that the *other* order is unsafe, so anybody who reverses it later
    // sees what this is guarding.
    const offset = straddlingOffset() ?? 0;
    const half = CANARY.slice(0, Math.floor(CANARY.length / 2));
    const wrong = redactor.redact(truncateForModel(at(offset), PREVIEW_BUDGET).text);
    assert.ok(wrong.includes(half), 'the wrong order was expected to leak a fragment');
  });

  test('redact-then-truncate leaves no fragment, at that same offset', () => {
    const offset = straddlingOffset() ?? 0;
    const half = CANARY.slice(0, Math.floor(CANARY.length / 2));
    const right = truncateForModel(redactor.redact(at(offset)), PREVIEW_BUDGET).text;
    assert.equal(right.includes(CANARY), false, 'the whole secret survived');
    assert.equal(right.includes(half), false, `a fragment survived: ${half}`);
  });
});

describe('off by default', () => {
  let ws: TestWorkspace;

  before(async () => {
    ws = await createTestWorkspace({
      files: { 'notes.txt': 'harmless content\n' },
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: 'notes.txt' } }] },
        { kind: 'final', text: 'read it' },
      ],
    });
    await ws.kernel.session.runTurn('read the notes');
  });

  after(async () => {
    await ws.cleanup();
  });

  test('a session that did not ask carries no tool content in its log at all', async () => {
    // The honest version of "off" is that the bytes were never put in the record,
    // not that something declined to print them (ADR-0031 §3).
    const log = await ws.eventLogText();
    assert.equal(log.includes('\"preview\"'), false, 'a preview was recorded without being asked');
    assert.equal(log.includes('harmless content'), false);
  });
});
