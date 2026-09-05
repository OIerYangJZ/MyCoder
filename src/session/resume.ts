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
  /**
   * Delegations that started and never reached a terminal event (alpha.4 §29).
   *
   * A child that was running when the process died is the worst case resume has
   * to handle: it may have edited files, and the parent's `Delegate` call has no
   * result. Both halves are repaired — the tool call gets a synthetic result that
   * says the outcome is unknown, and the child is *not* restarted, because
   * re-running a task that may have half-completed is how one interrupted edit
   * becomes two.
   */
  unfinishedDelegations: Array<{ delegationId: string; agent: string; toolCallId?: string }>;
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
  /** Delegations started and not yet finished, keyed by delegation id. */
  const openDelegations = new Map<string, { agent: string; toolCallId?: string }>();

  const flushResults = (): void => {
    if (pendingResults.length === 0) return;
    messages.push({ role: 'tool', parts: [...pendingResults], origin: { kind: 'tool' } });
    pendingResults = [];
  };

  for await (const event of store.readEvents(sessionId)) {
    eventCount += 1;
    lastSeq = event.seq;

    // Work performed inside a delegated child is recorded but never folded into
    // the parent's transcript: the parent never saw the child's steps, and
    // replaying them into its history would both misattribute them and leave the
    // child's tool calls looking unanswered to the parent. What the parent did see
    // — its own `Delegate` call and the result — is untagged and handled below.
    const inChild = typeof event.delegationId === 'string';

    switch (event.type) {
      case 'delegation.requested': {
        const payload = event.payload as { delegationId?: string; agent?: string; toolCallId?: string };
        if (typeof payload.delegationId === 'string') {
          openDelegations.set(payload.delegationId, {
            agent: payload.agent ?? 'unknown',
            ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
          });
        }
        break;
      }

      case 'delegation.completed':
      case 'delegation.failed':
      case 'delegation.cancelled':
      case 'delegation.denied': {
        const payload = event.payload as { delegationId?: string };
        if (typeof payload.delegationId === 'string') openDelegations.delete(payload.delegationId);
        break;
      }

      case 'turn.started': {
        if (inChild) break;
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
        if (inChild) break;
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
        if (inChild) break;
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
        if (inChild) break;
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
  const unfinishedDelegations = [...openDelegations].map(([delegationId, info]) => ({
    delegationId,
    agent: info.agent,
    ...(info.toolCallId ? { toolCallId: info.toolCallId } : {}),
  }));

  if (interrupted.length > 0) {
    // A delegating call gets a reason that names the child, because "verify before
    // assuming it took effect" means something more specific here: a subagent may
    // have edited several files and reported none of them.
    const delegated = new Map(
      unfinishedDelegations
        .filter((d) => d.toolCallId !== undefined)
        .map((d) => [d.toolCallId!, d.agent] as const),
    );
    const synthetic = interrupted.map((id) => {
      const agent = delegated.get(id);
      return syntheticInterruptedResult(
        id,
        agent === undefined
          ? 'The previous session ended while this tool call was running.'
          : `The previous session ended while the "${agent}" subagent was still running. It was not ` +
              'restarted: any files it had already changed are still changed, and re-dispatching the same ' +
              'task could repeat a partial edit.',
      );
    });
    messages.push({ role: 'tool', parts: synthetic, origin: { kind: 'tool' } });
  }

  if (unfinishedDelegations.length > 0) {
    warnings.push(
      `${unfinishedDelegations.length} delegation(s) were still running when the previous session ended ` +
        `(${unfinishedDelegations.map((d) => d.agent).join(', ')}). They were not resumed. Check the ` +
        'workspace before repeating that work.',
    );
  }

  return {
    metadata,
    messages,
    interrupted,
    unfinishedDelegations,
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

/**
 * The most recent session that can be resumed *here*, for `mycoder -c`.
 *
 * Scoped to the workspace, because a session from another directory cannot be
 * resumed into this one — `checkResumeIdentity` refuses it. Until alpha.12 this
 * returned the newest session on the machine, so `-c` in a project you had not
 * touched today picked up a session from somewhere else and died on the identity
 * check, in a directory where a perfectly good session of its own was waiting.
 */
/**
 * The session `-c` continues: the most recent one that has something to continue.
 *
 * "Most recent" alone was wrong, and it was wrong in a way that hid the answer
 * behind the act of looking for it. Every invocation persists a session — a
 * one-shot `mycoder "/status"` included — so a slash command created an empty
 * session that became the newest, and `-c` resumed *that*. On a live run the
 * sequence was exactly:
 *
 *     mycoder "…refactor…"     → 17 tool calls, 4 reversible edits
 *     mycoder "/undo list"     → new empty session, now the newest
 *     mycoder -c "/undo list"  → resumed the empty one: "No edit can be reversed"
 *
 * The journal rebuild was fine. The user was being handed a different session
 * and told, accurately, that it contained nothing.
 *
 * `modelRequests === 0` is the test because it is the one that means "this
 * session never held a conversation". A session with no model request has no
 * context to resume into and no journal to rebuild, so continuing it and
 * starting fresh are the same thing — except that one of them silently discards
 * the session the user meant. Tool calls are not the test: `/undo` runs a tool
 * without a model request, and a session that did only that is still worth
 * continuing.
 */
export async function findMostRecentSession(
  store: SessionStore,
  workspaceRoot?: string,
): Promise<SessionMetadata | undefined> {
  const sessions = await store.listSessions();
  const inWorkspace =
    workspaceRoot === undefined ? sessions : sessions.filter((s) => s.workspaceRoot === workspaceRoot);

  const started = inWorkspace.find((s) => s.usage.modelRequests > 0 || s.usage.toolCalls > 0);
  // Falling back to the newest empty one rather than to nothing: a session that
  // genuinely has not started yet is still the right thing to continue, and
  // refusing would turn "you have nothing to resume" into a lie.
  return started ?? inWorkspace[0];
}

/**
 * The sessions `-r` with no id offers (ADR-0029).
 *
 * Sorted newest first and limited, because the list is meant to be read in one
 * glance. Only this workspace's: offering a session the identity check would
 * refuse is offering a choice that cannot be taken.
 */
export async function listResumableSessions(
  store: SessionStore,
  workspaceRoot: string,
  limit = 9,
): Promise<{ sessions: SessionMetadata[]; elsewhere: number }> {
  const all = await store.listSessions();
  const here = all.filter((s) => s.workspaceRoot === workspaceRoot);
  return { sessions: here.slice(0, limit), elsewhere: all.length - here.length };
}

/**
 * A session's title: the first thing the user asked it, on one line.
 *
 * The id identifies the session to the machine and to nobody else. Written at
 * the first user turn and never rewritten — see `Session.firstUserInput`.
 */
export function sessionTitle(input: string, max = 64): string {
  const flat = input.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Human summary shown when a session is resumed. */
export function describeResume(
  replayed: ReplayedSession,
  /**
   * What the resumed session is actually running under.
   *
   * Passed in rather than read from the metadata, because the two can differ:
   * `-m` overrides the recorded alias, and the permission profile is never
   * restored from a log. Without this the summary described the *record* in the
   * present tense, three lines above a banner describing the session.
   */
  inForce?: { model: string; profile: string },
): string {
  const recordedModel = replayed.metadata.model;
  const recordedProfile = replayed.metadata.permissionProfile;
  const model = inForce?.model ?? recordedModel;
  const profile = inForce?.profile ?? recordedProfile;

  const lines = [
    `Resumed session ${replayed.metadata.sessionId}`,
    `  events replayed  : ${replayed.eventCount}`,
    `  messages         : ${replayed.messages.length}`,
    `  model            : ${model}${model === recordedModel ? '' : ` (was ${recordedModel})`}`,
    `  profile          : ${profile}${profile === recordedProfile ? '' : ` (was ${recordedProfile})`}`,
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
  if (replayed.unfinishedDelegations.length > 0) {
    lines.push(
      `  delegations      : ${replayed.unfinishedDelegations.length} unfinished ` +
        `(${replayed.unfinishedDelegations.map((d) => d.agent).join(', ')}); not resumed`,
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
