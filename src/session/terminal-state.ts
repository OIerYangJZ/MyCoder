/**
 * Replay Gate (next-phase plan §4.2).
 *
 * The contract:
 *
 *     live execution terminal state  ==  event-log replay terminal state
 *
 * Two independent computations of the same facts. The live one reads the objects
 * the kernel has in memory; the replayed one reads nothing but `events.jsonl`.
 * If they diverge, the event log is not a faithful record — which means resume
 * is unsound and the audit trail is describing a session that did not happen.
 *
 * `SessionTerminalState` is deliberately restricted to facts the log is *meant*
 * to carry. Assistant prose is excluded because §21.2 says it is never written;
 * asserting on it would just be asserting that we lose it. What is included is
 * what a resumed session has to get right: how each turn ended, why, what the
 * goal is, which tool calls were made and answered, which files changed, and
 * what the budget was spent on.
 */

import type { SessionId } from '../util/ids.ts';
import type { SessionStore } from './store.ts';

export interface TurnOutcomeRecord {
  /** Terminal state: completed | failed | cancelled. */
  state: string;
  /** Error code, for a failed turn. */
  errorCode?: string;
  /** Length of the final assistant text; the text itself is never logged. */
  finalTextLength: number;
}

/**
 * One finished delegation, as both halves of the gate must see it (alpha.4 §28).
 *
 * Deliberately shallow: statuses and counts, no summaries. The child's report is
 * prose, and §21.2 keeps prose out of the log — asserting on it would be asserting
 * that we lose it. What is here is what a resumed session has to get right about a
 * child: which agent ran, at what depth, how it ended, what it spent, and which of
 * its tool calls were answered.
 */
export interface DelegationOutcomeRecord {
  delegationId: string;
  agent: string;
  depth: number;
  status: string;
  /** Terminal state of each turn the child ran. */
  childTurns: string[];
  childToolCalls: string[];
  childModelRequests: number;
  childCompactions: number;
}

export interface SessionTerminalState {
  /** One entry per *root* turn, in order. A child's turns live in `delegations`. */
  turns: TurnOutcomeRecord[];
  goal?: { objective: string; status: string; criteria: string[] };
  /** Every tool call id issued, root and delegated, sorted. */
  toolCalls: string[];
  /** Every tool call id that received a real or synthetic result, sorted. */
  answeredToolCalls: string[];
  /** Workspace-relative paths modified through the Edit engine, sorted. */
  dirtyFiles: string[];
  /** Model requests, root and delegated (§13: root usage includes child usage). */
  modelRequests: number;
  toolCallCount: number;
  /** Compaction boundaries crossed, root and delegated. */
  compactions: number;
  /** Delegations in the order they finished. */
  delegations: DelegationOutcomeRecord[];
}

/**
 * Rebuild the terminal state from the event log alone.
 *
 * This function must never read the live session objects — that would defeat the
 * whole comparison.
 */
export async function replayTerminalState(
  store: SessionStore,
  sessionId: SessionId,
): Promise<SessionTerminalState> {
  const turns: TurnOutcomeRecord[] = [];
  const toolCalls = new Set<string>();
  const answered = new Set<string>();
  const dirtyFiles = new Set<string>();
  let goal: SessionTerminalState['goal'];
  let modelRequests = 0;
  let compactions = 0;

  // Per-delegation accumulators. A child's turns, tool calls, requests and
  // compactions are attributed to it by the `delegationId` its events carry, and
  // to the root only through the unions above — which is exactly how the live
  // side computes them.
  const scopes = new Map<
    string,
    { record: DelegationOutcomeRecord; calls: Set<string>; requests: number; compactions: number }
  >();
  const finishedOrder: string[] = [];

  const scopeOf = (id: string): NonNullable<ReturnType<typeof scopes.get>> => {
    const existing = scopes.get(id);
    if (existing) return existing;
    const created = {
      record: {
        delegationId: id,
        agent: '',
        depth: 0,
        status: 'unknown',
        childTurns: [] as string[],
        childToolCalls: [] as string[],
        childModelRequests: 0,
        childCompactions: 0,
      },
      calls: new Set<string>(),
      requests: 0,
      compactions: 0,
    };
    scopes.set(id, created);
    return created;
  };

  for await (const event of store.readEvents(sessionId)) {
    const payload = event.payload as Record<string, unknown>;
    // Events written *inside* a child scope. The delegation lifecycle events
    // themselves are the parent's and deliberately untagged.
    const inChild = typeof event.delegationId === 'string' ? event.delegationId : undefined;

    switch (event.type) {
      case 'delegation.started': {
        const id = String(payload.delegationId ?? '');
        if (id === '') break;
        const scope = scopeOf(id);
        scope.record.agent = String(payload.agent ?? '');
        scope.record.depth = typeof payload.depth === 'number' ? payload.depth : 0;
        break;
      }

      case 'delegation.completed':
      case 'delegation.failed':
      case 'delegation.cancelled':
      case 'delegation.denied': {
        const id = String(payload.delegationId ?? '');
        if (id === '') break;
        const scope = scopeOf(id);
        scope.record.agent = scope.record.agent || String(payload.agent ?? '');
        if (typeof payload.depth === 'number') scope.record.depth = payload.depth;
        scope.record.status = String(payload.status ?? 'unknown');
        if (!finishedOrder.includes(id)) finishedOrder.push(id);
        break;
      }

      case 'model.request.started':
        modelRequests += 1;
        if (inChild) scopeOf(inChild).requests += 1;
        break;

      case 'tool.call':
        if (typeof payload.toolCallId === 'string') {
          toolCalls.add(payload.toolCallId);
          if (inChild) scopeOf(inChild).calls.add(payload.toolCallId);
        }
        break;

      case 'tool.result':
      case 'tool.synthetic_result':
        if (typeof payload.toolCallId === 'string') answered.add(payload.toolCallId);
        break;

      case 'file.edited':
        if (typeof payload.path === 'string') dirtyFiles.add(payload.path);
        break;

      case 'goal.changed': {
        // A cleared goal is recorded as an event too, so replay must be able to
        // arrive at "no goal" rather than at the last goal that was ever set.
        if (payload.cleared === true) {
          goal = undefined;
          break;
        }
        goal = {
          objective: String(payload.objective ?? ''),
          status: String(payload.status ?? 'active'),
          criteria: Array.isArray(payload.criteria) ? payload.criteria.map(String) : [],
        };
        break;
      }

      case 'compaction.boundary':
        compactions += 1;
        if (inChild) scopeOf(inChild).compactions += 1;
        break;

      case 'turn.completed':
        if (inChild) {
          scopeOf(inChild).record.childTurns.push('completed');
          break;
        }
        turns.push({
          state: 'completed',
          finalTextLength: typeof payload.textLength === 'number' ? payload.textLength : 0,
        });
        break;

      case 'turn.failed':
        if (inChild) {
          scopeOf(inChild).record.childTurns.push('failed');
          break;
        }
        turns.push({
          state: 'failed',
          ...(typeof payload.code === 'string' ? { errorCode: payload.code } : {}),
          finalTextLength: 0,
        });
        break;

      case 'turn.cancelled':
        if (inChild) {
          scopeOf(inChild).record.childTurns.push('cancelled');
          break;
        }
        turns.push({ state: 'cancelled', finalTextLength: 0 });
        break;

      default:
        break;
    }
  }

  const delegations = finishedOrder.map((id) => {
    const scope = scopeOf(id);
    return {
      ...scope.record,
      childToolCalls: [...scope.calls].sort(),
      childModelRequests: scope.requests,
      childCompactions: scope.compactions,
    };
  });

  return {
    turns,
    ...(goal ? { goal } : {}),
    toolCalls: [...toolCalls].sort(),
    answeredToolCalls: [...answered].sort(),
    dirtyFiles: [...dirtyFiles].sort(),
    modelRequests,
    toolCallCount: toolCalls.size,
    compactions,
    delegations,
  };
}

export interface TerminalStateComparison {
  equal: boolean;
  differences: string[];
}

/**
 * Compare two terminal states field by field.
 *
 * Returns a list of differences rather than a boolean so a failing gate says
 * *what* diverged. "replay != live" is not an actionable CI failure.
 */
export function compareTerminalState(
  live: SessionTerminalState,
  replayed: SessionTerminalState,
): TerminalStateComparison {
  const differences: string[] = [];

  const scalar = (name: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      differences.push(`${name}: live=${JSON.stringify(a)} replay=${JSON.stringify(b)}`);
    }
  };

  scalar('turns', live.turns, replayed.turns);
  scalar('goal', live.goal ?? null, replayed.goal ?? null);
  scalar('toolCalls', live.toolCalls, replayed.toolCalls);
  scalar('answeredToolCalls', live.answeredToolCalls, replayed.answeredToolCalls);
  scalar('dirtyFiles', live.dirtyFiles, replayed.dirtyFiles);
  scalar('modelRequests', live.modelRequests, replayed.modelRequests);
  scalar('toolCallCount', live.toolCallCount, replayed.toolCallCount);
  scalar('compactions', live.compactions, replayed.compactions);
  scalar('delegations', live.delegations, replayed.delegations);

  return { equal: differences.length === 0, differences };
}

/**
 * Invariant 1, checked against the log rather than against memory.
 *
 * A tool call with no result is the failure mode the whole event schema exists
 * to make visible, so it gets its own check with its own message.
 */
export function unansweredToolCalls(state: SessionTerminalState): string[] {
  const answered = new Set(state.answeredToolCalls);
  return state.toolCalls.filter((id) => !answered.has(id));
}
