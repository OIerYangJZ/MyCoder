/**
 * Compaction (spec §20).
 *
 * v0.1 implements the minimum that is honest and replayable:
 *
 *   L0  truncate old oversized tool outputs, leaving a reference
 *   L1  preserve the recent tail intact
 *   L2  summarise the older head
 *   L3  re-inject goal, project instructions and active facts
 *
 * The constraints that make it safe (spec §20.3) are enforced structurally:
 *
 *  - **No unclosed tool calls.** Compaction never splits a `tool_call` from its
 *    `tool_result`; the cut point is snapped to an exchange boundary. Dropping
 *    one half would silently violate invariant 1.
 *  - **No background rewriting.** `compact()` is a pure function over a message
 *    list. The turn coordinator applies the result between steps, never while a
 *    request is in flight.
 *  - **Redacted input only.** The summariser receives the conversation as it
 *    already exists — which is post-redaction, because redaction happens at read
 *    and at tool-result time, before anything is appended.
 *  - **The event log is untouched.** Compaction appends a boundary event; it
 *    does not rewrite history.
 */

import { estimateTokens, truncateForModel } from '../util/text.ts';
import type { MessagePart, ModelMessage, ToolCallPart } from '../model/ir.ts';
import type { GoalState } from './context-engine.ts';
import { renderGoal } from './projector.ts';

export interface CompactionOptions {
  /** Projection budget in tokens. Compaction runs when the estimate exceeds it. */
  budgetTokens: number;
  /** Complete user/assistant/tool exchanges to keep verbatim. */
  preserveExchanges?: number;
  /** Tool results longer than this are candidates for L0 truncation. */
  largeToolResultTokens?: number;
  goal?: GoalState;
  /** Dirty-file summary and other facts to re-inject at L3. */
  reinject?: readonly string[];
  /**
   * Summariser for L2. Defaults to a deterministic structural summary, so
   * compaction works offline and in replay tests without a model call.
   */
  summarize?: (messages: readonly ModelMessage[]) => string;
}

export interface CompactionResult {
  messages: ModelMessage[];
  /** New boundary index: messages before this were summarised or dropped. */
  boundary: number;
  levelsApplied: Array<'L0' | 'L1' | 'L2' | 'L3'>;
  droppedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  summaryLength: number;
  preservedExchanges: number;
}

const DEFAULT_PRESERVE_EXCHANGES = 3;
const DEFAULT_LARGE_RESULT_TOKENS = 2_000;

export function needsCompaction(estimatedTokens: number, budgetTokens: number): boolean {
  return estimatedTokens > budgetTokens;
}

export function compact(
  messages: readonly ModelMessage[],
  system: string,
  opts: CompactionOptions,
): CompactionResult {
  const preserveExchanges = opts.preserveExchanges ?? DEFAULT_PRESERVE_EXCHANGES;
  const largeResultTokens = opts.largeToolResultTokens ?? DEFAULT_LARGE_RESULT_TOKENS;
  const tokensBefore = estimateAll(system, messages);
  const levels: Array<'L0' | 'L1' | 'L2' | 'L3'> = [];

  // Where the recent tail begins. Everything from here down is untouchable.
  const tailStart = findTailStart(messages, preserveExchanges);

  // ---- L0: shrink oversized tool results in the head --------------------
  let working = messages.map((message, index) => {
    if (index >= tailStart) return message;
    if (message.role !== 'tool') return message;

    let changed = false;
    const parts = message.parts.map((part): MessagePart => {
      if (part.type !== 'tool_result') return part;
      if (estimateTokens(part.content) < largeResultTokens) return part;
      changed = true;
      const clipped = truncateForModel(part.content, { maxBytes: 2_000, maxLines: 40 });
      return { ...part, content: clipped.text };
    });
    return changed ? { ...message, parts } : message;
  });

  if (working.some((m, i) => m !== messages[i])) levels.push('L0');

  if (!needsCompaction(estimateAll(system, working), opts.budgetTokens)) {
    levels.push('L1');
    return finish(working, tailStart, levels, 0, tokensBefore, system, 0, preserveExchanges);
  }

  // ---- L1 + L2: keep the tail, summarise the head -----------------------
  const head = working.slice(0, tailStart);
  const tail = working.slice(tailStart);
  levels.push('L1');

  if (head.length === 0) {
    // Nothing older to summarise: the tail alone is over budget. Report it
    // rather than silently discarding recent, load-bearing context.
    return finish(tail, 0, levels, 0, tokensBefore, system, 0, preserveExchanges);
  }

  const summarize = opts.summarize ?? structuralSummary;
  const summaryText = summarize(head);
  levels.push('L2');

  const summaryMessage: ModelMessage = {
    role: 'user',
    parts: [{ type: 'text', text: summaryText }],
    origin: { kind: 'compaction_summary' },
  };

  // ---- L3: re-inject the things that must survive -----------------------
  const reinjected: string[] = [];
  if (opts.goal && opts.goal.status !== 'cleared') reinjected.push(renderGoal(opts.goal));
  for (const item of opts.reinject ?? []) {
    if (item.trim() !== '') reinjected.push(item);
  }

  const parts: ModelMessage[] = [summaryMessage];
  if (reinjected.length > 0) {
    parts.push({
      role: 'user',
      parts: [{ type: 'text', text: `Still in force after compaction:\n\n${reinjected.join('\n\n')}` }],
      origin: { kind: 'compaction_summary' },
    });
    levels.push('L3');
  }

  working = [...parts, ...tail];

  return finish(
    working,
    parts.length,
    levels,
    head.length,
    tokensBefore,
    system,
    summaryText.length,
    preserveExchanges,
  );
}

function finish(
  messages: ModelMessage[],
  boundary: number,
  levels: Array<'L0' | 'L1' | 'L2' | 'L3'>,
  droppedMessages: number,
  tokensBefore: number,
  system: string,
  summaryLength: number,
  preservedExchanges: number,
): CompactionResult {
  return {
    messages,
    boundary,
    levelsApplied: levels,
    droppedMessages,
    tokensBefore,
    tokensAfter: estimateAll(system, messages),
    summaryLength,
    preservedExchanges,
  };
}

/**
 * Find where the preserved tail starts.
 *
 * Walks back over `preserveExchanges` user turns, then advances forward past any
 * assistant message whose tool calls are answered later — the cut must never
 * land between a `tool_call` and its `tool_result`.
 */
function findTailStart(messages: readonly ModelMessage[], preserveExchanges: number): number {
  if (messages.length === 0) return 0;

  let seen = 0;
  let index = messages.length;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'user' && message.origin.kind === 'user') {
      seen += 1;
      index = i;
      if (seen >= preserveExchanges) break;
    }
  }

  if (seen === 0) return 0;
  return snapToClosure(messages, index);
}

/**
 * Move the boundary earlier until no tool call before it is answered after it.
 *
 * Cutting a tool call away from its result is the one thing compaction is
 * absolutely forbidden to do (spec §20.3), so this loop is the safety net rather
 * than an optimisation.
 */
function snapToClosure(messages: readonly ModelMessage[], start: number): number {
  let boundary = start;

  for (;;) {
    const answeredAfter = new Set<string>();
    for (let i = boundary; i < messages.length; i += 1) {
      for (const part of messages[i]!.parts) {
        if (part.type === 'tool_result') answeredAfter.add(part.toolCallId);
      }
    }

    let earliest = boundary;
    for (let i = 0; i < boundary; i += 1) {
      const calls = messages[i]!.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
      if (calls.some((c) => answeredAfter.has(c.id))) {
        earliest = Math.min(earliest, i);
      }
    }

    if (earliest === boundary) return boundary;
    boundary = earliest;
    if (boundary <= 0) return 0;
  }
}

/**
 * Deterministic fallback summary.
 *
 * Not a language-model summary — a structural one: what was asked, which files
 * were read and edited, which commands ran and how they exited. It is worse than
 * a good model summary at capturing intent, and much better at being correct,
 * cheap and replayable. A model summariser can be supplied via `opts.summarize`.
 */
export function structuralSummary(messages: readonly ModelMessage[]): string {
  const userAsks: string[] = [];
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const commands: string[] = [];
  const toolErrors: string[] = [];

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'text' && message.role === 'user' && message.origin.kind === 'user') {
        userAsks.push(part.text.trim().slice(0, 300));
      }
      if (part.type === 'tool_call') {
        const args = (part.arguments ?? {}) as Record<string, unknown>;
        if (part.name === 'Read' && typeof args.path === 'string') filesRead.add(args.path);
        if (part.name === 'Edit' && typeof args.path === 'string') filesEdited.add(args.path);
        if (part.name === 'Shell' && Array.isArray(args.argv)) {
          commands.push((args.argv as string[]).join(' ').slice(0, 120));
        }
      }
      if (part.type === 'tool_result' && part.isError) {
        toolErrors.push(part.content.split('\n').slice(0, 2).join(' ').slice(0, 200));
      }
    }
  }

  const lines = ['[Earlier conversation, compacted]'];

  if (userAsks.length > 0) {
    lines.push('', 'What was asked:');
    for (const ask of userAsks.slice(-5)) lines.push(`  - ${ask}`);
  }
  if (filesEdited.size > 0) {
    lines.push('', `Files edited (${filesEdited.size}):`);
    for (const f of [...filesEdited].slice(0, 20)) lines.push(`  - ${f}`);
  }
  if (filesRead.size > 0) {
    lines.push('', `Files read (${filesRead.size}): ${[...filesRead].slice(0, 20).join(', ')}`);
    lines.push('  Note: read receipts from before compaction are gone. Re-read a file before editing it.');
  }
  if (commands.length > 0) {
    lines.push('', 'Commands run:');
    for (const c of commands.slice(-8)) lines.push(`  - ${c}`);
  }
  if (toolErrors.length > 0) {
    lines.push('', 'Recent failures:');
    for (const e of toolErrors.slice(-5)) lines.push(`  - ${e}`);
  }

  return lines.join('\n');
}

function estimateAll(system: string, messages: readonly ModelMessage[]): number {
  let total = estimateTokens(system);
  for (const message of messages) {
    for (const part of message.parts) {
      switch (part.type) {
        case 'text':
          total += estimateTokens(part.text);
          break;
        case 'tool_result':
          total += estimateTokens(part.content);
          break;
        case 'tool_call':
          total += estimateTokens(JSON.stringify(part.arguments ?? {}));
          break;
        case 'reasoning':
          total += estimateTokens(part.text ?? part.opaque ?? '');
          break;
        case 'media':
          total += 800;
          break;
      }
    }
    total += 4;
  }
  return total;
}
