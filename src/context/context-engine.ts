/**
 * Context Engine (spec §8).
 *
 * The engine stores **facts**, not a prompt string. Four planes:
 *
 *   Repository Plane  — workspace, git, project instructions
 *   Conversation Plane— messages with provenance
 *   Freshness Ledger  — what the model has actually seen, and when
 *   Dynamic Plane     — goal, dirty files, active constraints, control results
 *
 * The projector turns those into a `ContextSnapshot` at the top of each step.
 * Keeping the planes separate is what lets compaction rewrite the conversation
 * without losing the goal, and what lets `/model use` re-project into a smaller
 * window without replaying the whole session.
 */

import { estimateTokens } from '../util/text.ts';
import type { MessageOrigin, MessagePart, ModelMessage, ToolCallPart, ToolResultPart } from '../model/ir.ts';
import { openToolCallIds } from '../model/ir.ts';
import type { FreshnessLedger } from './freshness.ts';
import type { RepositoryPlane } from './repository-plane.ts';

export interface GoalState {
  objective: string;
  criteria: string[];
  status: 'active' | 'paused' | 'completed' | 'cleared';
  createdAt: number;
}

/** A fact the projector should surface to the model on the next step. */
export interface DynamicFact {
  id: string;
  /** Higher survives compaction longer. */
  priority: 'critical' | 'normal' | 'transient';
  text: string;
  createdAt: number;
  /** Removed after being projected once. */
  oneShot?: boolean;
}

export interface ContextSnapshot {
  system: string;
  messages: readonly ModelMessage[];
  /** Estimated tokens for the whole projection. */
  estimatedTokens: number;
  /** Tool call ids with no result yet — must be zero before a new user turn. */
  openToolCalls: readonly string[];
  goal?: GoalState;
  /** Index of the first message after the last compaction boundary. */
  compactionBoundary: number;
}

export interface ContextEngineOptions {
  repository: RepositoryPlane;
  freshness: FreshnessLedger;
  now(): number;
}

export class ContextEngine {
  readonly repository: RepositoryPlane;
  readonly freshness: FreshnessLedger;

  private readonly messages: ModelMessage[] = [];
  private readonly facts = new Map<string, DynamicFact>();
  private readonly now: () => number;
  private goalState: GoalState | undefined;
  private boundary = 0;

  constructor(opts: ContextEngineOptions) {
    this.repository = opts.repository;
    this.freshness = opts.freshness;
    this.now = opts.now;
  }

  // --- conversation plane -------------------------------------------------

  appendUser(text: string): ModelMessage {
    return this.append({ role: 'user', parts: [{ type: 'text', text }], origin: { kind: 'user' } });
  }

  appendAssistant(parts: MessagePart[]): ModelMessage {
    return this.append({ role: 'assistant', parts, origin: { kind: 'assistant' } });
  }

  appendToolResults(results: readonly ToolResultPart[]): ModelMessage | undefined {
    if (results.length === 0) return undefined;
    return this.append({ role: 'tool', parts: [...results], origin: { kind: 'tool' } });
  }

  /**
   * Project a control-plane result into the conversation.
   *
   * Control commands change kernel state directly (spec §2.2); this is how the
   * model learns that it happened, without the command ever having been
   * interpreted by the model.
   */
  appendControlResult(text: string): ModelMessage {
    return this.append({
      role: 'user',
      parts: [{ type: 'text', text }],
      origin: { kind: 'control' },
    });
  }

  /** Content injected by a hook or a skill, tagged with its source. */
  appendInjection(source: string, text: string): ModelMessage {
    return this.append({
      role: 'user',
      parts: [{ type: 'text', text }],
      origin: { kind: 'injection', source },
    });
  }

  private append(message: ModelMessage): ModelMessage {
    this.messages.push(message);
    return message;
  }

  history(): readonly ModelMessage[] {
    return this.messages;
  }

  /** Replace the conversation. Only compaction and resume may call this. */
  replaceHistory(messages: readonly ModelMessage[], boundary: number): void {
    this.messages.length = 0;
    this.messages.push(...messages);
    this.boundary = Math.min(boundary, this.messages.length);
  }

  get compactionBoundary(): number {
    return this.boundary;
  }

  /**
   * Tool calls that were issued but never answered.
   *
   * Invariant 1 says every tool call gets a real or synthetic result; this is
   * how the turn coordinator and resume both check it.
   */
  openToolCalls(): string[] {
    return openToolCallIds(this.messages);
  }

  /** The tool calls in the most recent assistant message. */
  lastAssistantToolCalls(): ToolCallPart[] {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const message = this.messages[i]!;
      if (message.role !== 'assistant') continue;
      return message.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
    }
    return [];
  }

  // --- dynamic plane ------------------------------------------------------

  setGoal(goal: GoalState | undefined): void {
    this.goalState = goal;
  }

  get goal(): GoalState | undefined {
    return this.goalState;
  }

  addFact(fact: Omit<DynamicFact, 'createdAt'>): void {
    this.facts.set(fact.id, { ...fact, createdAt: this.now() });
  }

  removeFact(id: string): void {
    this.facts.delete(id);
  }

  listFacts(): DynamicFact[] {
    return [...this.facts.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Drop one-shot facts after they have been projected. */
  consumeOneShotFacts(): void {
    for (const [id, fact] of this.facts) {
      if (fact.oneShot) this.facts.delete(id);
    }
  }

  // --- projection helpers -------------------------------------------------

  estimatedTokens(system: string): number {
    let total = estimateTokens(system);
    for (const message of this.messages) {
      for (const part of message.parts) {
        total += estimateTokens(partText(part));
      }
      total += 4; // per-message framing
    }
    return total;
  }

  /** Number of complete user→assistant→tool exchanges in the tail. */
  countExchanges(): number {
    return this.messages.filter((m) => m.role === 'user' && m.origin.kind === 'user').length;
  }

  originOf(index: number): MessageOrigin | undefined {
    return this.messages[index]?.origin;
  }
}

export function partText(part: MessagePart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'reasoning':
      return part.text ?? part.opaque ?? '';
    case 'tool_call':
      return `${part.name}(${JSON.stringify(part.arguments ?? {})})`;
    case 'tool_result':
      return part.content;
    case 'media':
      return `[media:${part.mediaType}]`;
  }
}
