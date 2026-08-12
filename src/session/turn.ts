/**
 * Turn state machine (spec §5.2).
 *
 *   queued → preparing → sampling ─┬─ final ──────────→ verifying → completed
 *                                  ├─ tool_calls ─────→ executing_tools → preparing
 *                                  ├─ context_pressure→ compacting → preparing
 *                                  ├─ fatal_error ────→ failed
 *                                  └─ cancel ─────────→ cancelled
 *
 * The transitions are enforced, not documented. Three moves the spec forbids —
 * re-entering `sampling` after `completed`, starting a tool after `cancelled`,
 * and leaving a tool call unanswered — are impossible here rather than merely
 * discouraged, because each of them is a bug that only shows up under load and
 * only in the event log.
 */

import type { TurnId } from '../util/ids.ts';
import type { KernelError } from '../util/errors.ts';

export type TurnState =
  | 'queued'
  | 'preparing'
  | 'sampling'
  | 'executing_tools'
  | 'compacting'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TERMINAL_STATES: ReadonlySet<TurnState> = new Set<TurnState>([
  'completed',
  'failed',
  'cancelled',
]);

/** Legal successors for each state. */
const TRANSITIONS: Record<TurnState, readonly TurnState[]> = {
  queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['sampling', 'compacting', 'cancelled', 'failed'],
  sampling: ['executing_tools', 'verifying', 'compacting', 'cancelled', 'failed'],
  executing_tools: ['preparing', 'verifying', 'cancelled', 'failed'],
  compacting: ['preparing', 'cancelled', 'failed'],
  verifying: ['completed', 'preparing', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: TurnState, to: TurnState) {
    super(`illegal turn transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export interface TurnTransition {
  from: TurnState;
  to: TurnState;
  at: number;
  reason?: string;
}

export interface TurnOptions {
  turnId: TurnId;
  input: string;
  origin: 'user' | 'control' | 'loop';
  startedAt: number;
}

export class Turn {
  readonly turnId: TurnId;
  readonly input: string;
  readonly origin: 'user' | 'control' | 'loop';
  readonly startedAt: number;
  readonly transitions: TurnTransition[] = [];

  private currentState: TurnState = 'queued';
  private finalTextValue: string | undefined;
  private errorValue: KernelError | undefined;
  private stepCount = 0;

  constructor(opts: TurnOptions) {
    this.turnId = opts.turnId;
    this.input = opts.input;
    this.origin = opts.origin;
    this.startedAt = opts.startedAt;
  }

  get state(): TurnState {
    return this.currentState;
  }

  get steps(): number {
    return this.stepCount;
  }

  get finalText(): string | undefined {
    return this.finalTextValue;
  }

  get error(): KernelError | undefined {
    return this.errorValue;
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.has(this.currentState);
  }

  canTransitionTo(next: TurnState): boolean {
    return TRANSITIONS[this.currentState].includes(next);
  }

  transition(next: TurnState, at: number, reason?: string): void {
    if (!this.canTransitionTo(next)) {
      throw new IllegalTransitionError(this.currentState, next);
    }
    const record: TurnTransition = { from: this.currentState, to: next, at };
    if (reason) record.reason = reason;
    this.transitions.push(record);
    this.currentState = next;
    if (next === 'sampling') this.stepCount += 1;
  }

  complete(finalText: string, at: number): void {
    if (this.currentState !== 'verifying') this.transition('verifying', at, 'model produced a final answer');
    this.finalTextValue = finalText;
    this.transition('completed', at);
  }

  fail(error: KernelError, at: number): void {
    if (this.isTerminal()) return;
    this.errorValue = error;
    this.transition('failed', at, error.code);
  }

  cancel(at: number, reason = 'cancelled by the user'): void {
    if (this.isTerminal()) return;
    this.transition('cancelled', at, reason);
  }

  /** Compact history of the turn, for `/status` and the event log. */
  describe(): string {
    return this.transitions.map((t) => `${t.from}→${t.to}`).join(' ');
  }
}
