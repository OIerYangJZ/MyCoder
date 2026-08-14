/**
 * Regressions for defects the alpha.5 dogfood found (§54).
 *
 * Every entry in `docs/alpha5-dogfood.md` that was fixed has a test here, named
 * for its ledger id. The ledger is the narrative; this file is the part that
 * keeps the fix from quietly coming back.
 *
 * They live in `tests/integration/` rather than beside the dogfood harness on
 * purpose: the harness needs a real provider and a container runtime, and a
 * regression that can only run under those conditions is a regression that will
 * not run. Each one reproduces the *defect*, not the session that exposed it.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { createKernel } from '../../src/kernel.ts';
import { FakeModel } from '../../src/model/adapters/fake.ts';
import { FileSessionStore } from '../../src/session/store.ts';
import { Redactor } from '../../src/security/redactor.ts';

describe('D-003 — the cost breakdown survives a restart', () => {
  test('a resumed session reports the same total in usage and in the breakdown', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dogfood-d003-'));
    const root = path.join(base, 'workspace');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');

    const store = new FileSessionStore({
      rootDir: path.join(base, 'sessions'),
      redactor: new Redactor(),
    });

    const boot = async (resumeSessionId?: string) =>
      createKernel({
        workspaceDir: root,
        dirsRoot: path.join(base, 'kernel-dirs'),
        store,
        fakeModel: new FakeModel({ script: [{ kind: 'final', text: 'ok' }] }),
        logLevel: 'silent',
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });

    let kernel = await boot();
    const sessionId = kernel.sessionId;

    try {
      await kernel.session.runTurn('first');

      // The fake model reports no cost, so the spend is injected the way a real
      // provider's would arrive: through the metadata the next process reads.
      // This is the exact state a restart resumes from — and it is patched
      // *after* shutdown, because shutdown persists the live session's own usage
      // over whatever is on disk.
      await kernel.shutdown();
      const metadata = await store.loadMetadata(sessionId);
      assert.ok(metadata);
      await store.saveMetadata({
        ...metadata,
        usage: { ...metadata.usage, costUsd: 0.0033, delegatedCostUsd: 0.0011 },
      });

      kernel = await boot(sessionId);

      const usage = kernel.session.usageSnapshot;
      const breakdown = kernel.session.costBreakdown;

      // The defect: `usage.costUsd` was restored and the breakdown was not, so
      // `/status` printed $0.0033 on one line and $0.0000 "total" on the next.
      assert.equal(usage.costUsd, 0.0033);
      assert.ok(
        Math.abs(breakdown.totalUsd - usage.costUsd) < 1e-9,
        `breakdown total ${breakdown.totalUsd} should equal usage ${usage.costUsd}`,
      );
      // And the split is restored, not collapsed into "direct".
      assert.ok(Math.abs(breakdown.delegatedUsd - 0.0011) < 1e-9);
      assert.ok(Math.abs(breakdown.directUsd - 0.0022) < 1e-9);
    } finally {
      await kernel.shutdown().catch(() => {});
      await rm(base, { recursive: true, force: true });
    }
  });

  test('a pre-alpha.5 log with no split attributes the resumed cost to direct', async () => {
    // Backward compatibility, stated as a test because it is a *choice*: an older
    // log cannot say how much was a child's, and inventing a split would be
    // worse than attributing it to the session that owns the total.
    const base = await mkdtemp(path.join(tmpdir(), 'dogfood-d003-old-'));
    const root = path.join(base, 'workspace');
    await mkdir(root, { recursive: true });

    const store = new FileSessionStore({
      rootDir: path.join(base, 'sessions'),
      redactor: new Redactor(),
    });

    const boot = async (resumeSessionId?: string) =>
      createKernel({
        workspaceDir: root,
        dirsRoot: path.join(base, 'kernel-dirs'),
        store,
        fakeModel: new FakeModel({ script: [{ kind: 'final', text: 'ok' }] }),
        logLevel: 'silent',
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });

    let kernel = await boot();
    const sessionId = kernel.sessionId;
    try {
      await kernel.session.runTurn('first');
      await kernel.shutdown();
      const metadata = await store.loadMetadata(sessionId);
      assert.ok(metadata);
      const legacy = { ...metadata.usage, costUsd: 0.005 };
      delete (legacy as { delegatedCostUsd?: number }).delegatedCostUsd;
      await store.saveMetadata({ ...metadata, usage: legacy });

      kernel = await boot(sessionId);
      const breakdown = kernel.session.costBreakdown;
      assert.ok(Math.abs(breakdown.totalUsd - 0.005) < 1e-9);
      assert.equal(breakdown.delegatedUsd, 0);
    } finally {
      await kernel.shutdown().catch(() => {});
      await rm(base, { recursive: true, force: true });
    }
  });
});
