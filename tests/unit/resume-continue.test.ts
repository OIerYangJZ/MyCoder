/**
 * What `-c` continues (alpha.12).
 *
 * "The most recent session" was the rule, and it was wrong in a way that hid the
 * answer behind the act of looking for it. Every invocation persists a session,
 * a one-shot `mycoder "/status"` included, so a slash command created an empty
 * session that became the newest — and `-c` resumed that one. Seen live:
 *
 *     mycoder "…refactor…"     → 17 tool calls, 4 reversible edits
 *     mycoder "/undo list"     → new empty session, now the newest
 *     mycoder -c "/undo list"  → "No edit in this session can be reversed."
 *
 * Nothing was broken except the choice of session. The journal rebuild worked
 * perfectly on the right one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { findMostRecentSession } from '../../src/session/resume.ts';
import type { SessionMetadata, SessionStore } from '../../src/session/store.ts';
import type { SessionId } from '../../src/util/ids.ts';

/** Newest first, which is the order `listSessions` promises. */
function store(sessions: readonly Partial<SessionMetadata>[]): SessionStore {
  const full = sessions.map(
    (s, i) =>
      ({
        sessionId: (s.sessionId ?? `ses_${i}`) as SessionId,
        createdAt: 0,
        updatedAt: 0,
        kernelVersion: '0.1.0',
        workspaceRoot: s.workspaceRoot ?? '/repo',
        workspaceIdentity: 'x',
        model: 'fake',
        permissionProfile: 'workspace-dev',
        backendKind: 'local',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          costUsd: 0,
          delegatedCostUsd: 0,
          modelRequests: 0,
          toolCalls: 0,
          ...(s.usage ?? {}),
        },
        ...s,
      }) as SessionMetadata,
  );
  return { listSessions: async () => full } as unknown as SessionStore;
}

describe('-c continues the session that has something to continue', () => {
  test('an empty session does not bury the one that did the work', async () => {
    const found = await findMostRecentSession(
      store([
        { sessionId: 'ses_slash' as SessionId },
        { sessionId: 'ses_work' as SessionId, usage: { modelRequests: 5, toolCalls: 17 } as never },
      ]),
      '/repo',
    );
    assert.equal(found?.sessionId, 'ses_work');
  });

  test('several empty sessions in a row are all skipped', async () => {
    const found = await findMostRecentSession(
      store([
        { sessionId: 'ses_a' as SessionId },
        { sessionId: 'ses_b' as SessionId },
        { sessionId: 'ses_c' as SessionId },
        { sessionId: 'ses_work' as SessionId, usage: { modelRequests: 1, toolCalls: 0 } as never },
      ]),
      '/repo',
    );
    assert.equal(found?.sessionId, 'ses_work');
  });

  /**
   * `/undo` runs a tool without a model request, and a session that did only
   * that is still worth continuing — so tool calls count too.
   */
  test('a session that only ran a tool still counts as started', async () => {
    const found = await findMostRecentSession(
      store([
        { sessionId: 'ses_empty' as SessionId },
        { sessionId: 'ses_undo' as SessionId, usage: { modelRequests: 0, toolCalls: 1 } as never },
      ]),
      '/repo',
    );
    assert.equal(found?.sessionId, 'ses_undo');
  });

  test('the newest started session wins, not the oldest', async () => {
    const found = await findMostRecentSession(
      store([
        { sessionId: 'ses_new' as SessionId, usage: { modelRequests: 2, toolCalls: 0 } as never },
        { sessionId: 'ses_old' as SessionId, usage: { modelRequests: 9, toolCalls: 9 } as never },
      ]),
      '/repo',
    );
    assert.equal(found?.sessionId, 'ses_new');
  });

  test('another workspace is never continued into', async () => {
    const found = await findMostRecentSession(
      store([
        {
          sessionId: 'ses_other' as SessionId,
          workspaceRoot: '/elsewhere',
          usage: { modelRequests: 9 } as never,
        },
        { sessionId: 'ses_here' as SessionId, usage: { modelRequests: 1 } as never },
      ]),
      '/repo',
    );
    assert.equal(found?.sessionId, 'ses_here');
  });

  /**
   * Falling back rather than refusing: a workspace whose only session genuinely
   * has not started is still the right thing to continue, and returning nothing
   * would turn that into "you have nothing to resume", which is not true.
   */
  test('when every session is empty, the newest is still offered', async () => {
    const found = await findMostRecentSession(
      store([{ sessionId: 'ses_a' as SessionId }, { sessionId: 'ses_b' as SessionId }]),
      '/repo',
    );
    assert.equal(found?.sessionId, 'ses_a');
  });

  test('a workspace with no sessions at all still resolves to nothing', async () => {
    assert.equal(await findMostRecentSession(store([]), '/repo'), undefined);
    assert.equal(await findMostRecentSession(store([{ workspaceRoot: '/elsewhere' }]), '/repo'), undefined);
  });
});
