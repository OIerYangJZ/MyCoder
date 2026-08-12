/**
 * Session resume (spec §21.3).
 *
 * The event log is the source of truth, so resume replays it:
 *
 *   1. load session.json
 *   2. replay events
 *   3. check workspace identity
 *   4. check remote identity
 *   5. find unclosed tool exchanges
 *   6. synthesise results for interrupted tool calls
 *   7. recompute freshness
 *   8. wait for the user (or continue, with `-c`)
 *
 * Step 6 is the one that matters most. A process killed mid-tool-call leaves a
 * `tool_call` with no `tool_result`; replaying that verbatim produces a
 * conversation no provider will accept and, worse, a model that believes an
 * action succeeded. The synthetic result says plainly that the outcome is
 * unknown and must be verified.
 */

import { sha256Hex, type SessionId } from '../util/ids.ts';
import type { ModelMessage, ToolCallPart, ToolResultPart } from '../model/ir.ts';
import { syntheticInterruptedResult } from '../tools/runtime.ts';
import type { SessionMetadata, SessionStore } from './store.ts';

export interface ReplayedSession {
  metadata: SessionMetadata;
  messages: ModelMessage[];
  /** Tool calls that never got a result; synthetic ones were appended. */
  interrupted: string[];
  /** Files the session edited, for the dirty-file summary. */
  editedPaths: string[];
  /** Receipts are deliberately NOT restored; see `freshnessNote`. */
  freshnessNote: string;
  eventCount: number;
  lastSeq: number;
  warnings: string[];
}

export interface ResumeCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/**
 * Rebuild conversation state from the log.
 *
 * Only the event types in `REPLAY_EVENT_TYPES` matter; everything else is audit
 * detail. Unknown types are skipped rather than treated as corruption, so a log
 * written by a newer kernel still resumes.
 */
export async function replaySession(
  store: SessionStore,
  sessionId: SessionId,
): Promise<ReplayedSession | undefined> {
  const metadata = await store.loadMetadata(sessionId);
  if (!metadata) return undefined;

  const messages: ModelMessage[] = [];
  const editedPaths = new Set<string>();
  const warnings: string[] = [];
  let eventCount = 0;
  let lastSeq = 0;

  // Tool calls seen, in order, so an interrupted one can be identified.
  const pendingCalls = new Map<string, ToolCallPart>();
  let pendingResults: ToolResultPart[] = [];

  const flushResults = (): void => {
    if (pendingResults.length === 0) return;
    messages.push({ role: 'tool', parts: [...pendingResults], origin: { kind: 'tool' } });
    pendingResults = [];
  };

  for await (const event of store.readEvents(sessionId)) {
    eventCount += 1;
    lastSeq = event.seq;

    switch (event.type) {
      case 'turn.started': {
        flushResults();
        const payload = event.payload as { input?: string; origin?: string };
        if (typeof payload.input === 'string' && payload.input !== '') {
          messages.push({
            role: 'user',
            parts: [{ type: 'text', text: payload.input }],
            origin: payload.origin === 'control' ? { kind: 'control' } : { kind: 'user' },
          });
        }
        break;
      }

      case 'model.request.completed': {
        flushResults();
        const payload = event.payload as { textLength?: number };
        // The log deliberately does not store assistant text (spec §21.2), so
        // replay reconstructs a placeholder rather than inventing content.
        if ((payload.textLength ?? 0) > 0) {
          messages.push({
            role: 'assistant',
            parts: [
              {
                type: 'text',
                text: `[assistant message from the previous session, ${payload.textLength} characters, not retained in the event log]`,
              },
            ],
            origin: { kind: 'assistant' },
          });
        }
        break;
      }

      case 'tool.call': {
        const payload = event.payload as { toolCallId?: string; name?: string; argsSummary?: string };
        if (!payload.toolCallId || !payload.name) break;
        const call: ToolCallPart = {
          type: 'tool_call',
          id: payload.toolCallId as ToolCallPart['id'],
          name: payload.name,
          arguments: safeParse(payload.argsSummary),
        };
        pendingCalls.set(payload.toolCallId, call);
        const last = messages.at(-1);
        if (last?.role === 'assistant') last.parts.push(call);
        else messages.push({ role: 'assistant', parts: [call], origin: { kind: 'assistant' } });
        break;
      }

      case 'tool.result':
      case 'tool.synthetic_result': {
        const payload = event.payload as { toolCallId?: string; isError?: boolean; contentBytes?: number };
        if (!payload.toolCallId) break;
        pendingCalls.delete(payload.toolCallId);
        pendingResults.push({
          type: 'tool_result',
          toolCallId: payload.toolCallId as ToolResultPart['toolCallId'],
          content:
            event.type === 'tool.synthetic_result'
              ? '[interrupted in a previous session; outcome unknown]'
              : `[tool result from the previous session, ${payload.contentBytes ?? 0} bytes, not retained in the event log]`,
          isError: payload.isError === true,
        });
        break;
      }

      case 'file.edited': {
        const payload = event.payload as { path?: string };
        if (payload.path) editedPaths.add(payload.path);
        break;
      }

      case 'compaction.boundary': {
        // A boundary in the log means the live conversation was replaced. Replay
        // keeps the full record for audit and notes the divergence.
        warnings.push(
          'This session was compacted; the replayed history is longer than what the model last saw.',
        );
        break;
      }

      default:
        break;
    }
  }

  flushResults();

  // Step 5 + 6: close anything left open.
  const interrupted = [...pendingCalls.keys()];
  if (interrupted.length > 0) {
    const synthetic = interrupted.map((id) =>
      syntheticInterruptedResult(id, 'The previous session ended while this tool call was running.'),
    );
    messages.push({ role: 'tool', parts: synthetic, origin: { kind: 'tool' } });
  }

  return {
    metadata,
    messages,
    interrupted,
    editedPaths: [...editedPaths],
    // Step 7: receipts are not restored. A receipt asserts "the model has seen
    // these exact bytes"; after a restart that is no longer true of the process
    // holding the ledger, and re-reading costs one step against silently
    // authorising an edit to unverified content.
    freshnessNote:
      'Read receipts do not survive a restart. Re-read a file before editing it; the first Edit ' +
      'without a fresh receipt will be rejected.',
    eventCount,
    lastSeq,
    warnings,
  };
}

/**
 * Steps 3 and 4: confirm we are resuming into the same world.
 *
 * A workspace mismatch is fatal — resuming a session whose edits targeted a
 * different tree is how you corrupt two projects at once. A remote mismatch is
 * also fatal for the same reason.
 */
export function checkResumeIdentity(
  metadata: SessionMetadata,
  current: { workspaceRoot: string; workspaceIdentity: string; remote?: string; remoteIdentity?: string },
): ResumeCheck {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (metadata.workspaceRoot !== current.workspaceRoot) {
    problems.push(
      `This session was created in ${metadata.workspaceRoot}, but the current workspace is ${current.workspaceRoot}.`,
    );
  } else if (metadata.workspaceIdentity !== current.workspaceIdentity) {
    warnings.push(
      'The workspace identity changed since this session was created (the git root may have moved). ' +
        'Verify the state of your files before continuing.',
    );
  }

  if ((metadata.remote ?? '') !== (current.remote ?? '')) {
    problems.push(
      `This session was running on remote "${metadata.remote ?? 'local'}", but the current backend is ` +
        `"${current.remote ?? 'local'}". Reconnect with /remote connect before resuming.`,
    );
  } else if (metadata.remoteIdentity && metadata.remoteIdentity !== current.remoteIdentity) {
    warnings.push('The remote host identity changed since this session was created.');
  }

  return { ok: problems.length === 0, problems, warnings };
}

/** Identity used for the check above. */
export function workspaceIdentity(workspaceRoot: string, gitRoot?: string): string {
  return sha256Hex(`${workspaceRoot}\n${gitRoot ?? ''}`).slice(0, 16);
}

/** The most recent resumable session, for `agent -c`. */
export async function findMostRecentSession(store: SessionStore): Promise<SessionMetadata | undefined> {
  const sessions = await store.listSessions();
  return sessions[0];
}

/** Human summary shown when a session is resumed. */
export function describeResume(replayed: ReplayedSession): string {
  const lines = [
    `Resumed session ${replayed.metadata.sessionId}`,
    `  events replayed : ${replayed.eventCount}`,
    `  messages         : ${replayed.messages.length}`,
    `  model            : ${replayed.metadata.model}`,
    `  profile          : ${replayed.metadata.permissionProfile}`,
  ];
  if (replayed.editedPaths.length > 0) {
    lines.push(
      `  files edited     : ${replayed.editedPaths.length} (${replayed.editedPaths.slice(0, 5).join(', ')})`,
    );
  }
  if (replayed.interrupted.length > 0) {
    lines.push(
      `  interrupted      : ${replayed.interrupted.length} tool call(s) were cut off and marked as unknown outcome`,
    );
  }
  for (const warning of replayed.warnings) lines.push(`  warning          : ${warning}`);
  lines.push(`  ${replayed.freshnessNote}`);
  return lines.join('\n');
}

function safeParse(text: string | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __summary: text };
  }
}
