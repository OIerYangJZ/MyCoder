/**
 * Branded identifier types.
 *
 * Brands are compile-time only; at runtime every id is a string. The point is to
 * make it impossible to pass a StepId where a TurnId is expected, which matters
 * because the event log correlates everything by these ids.
 */

import { randomUUID, createHash } from 'node:crypto';

declare const __brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type SessionId = Brand<string, 'SessionId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type StepId = Brand<string, 'StepId'>;
export type ToolCallId = Brand<string, 'ToolCallId'>;
export type EventId = Brand<string, 'EventId'>;
export type ReceiptId = Brand<string, 'ReceiptId'>;
export type ModelRequestId = Brand<string, 'ModelRequestId'>;
/** Identifies a delegation *request* (ADR-0013). */
export type DelegationId = Brand<string, 'DelegationId'>;
/** Identifies the child *execution scope* a delegation produced. */
export type ChildRunId = Brand<string, 'ChildRunId'>;
/** Identity of one edit-journal entry, so an undo can name what it reversed. */
export type JournalEntryId = Brand<string, 'JournalEntryId'>;

/** Monotonic-ish, sortable, human-scannable id: <prefix>_<base36 time>_<rand>. */
function makeId(prefix: string, nowMs: number): string {
  const t = nowMs.toString(36).padStart(9, '0');
  const r = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${t}_${r}`;
}

export function newSessionId(nowMs: number): SessionId {
  return makeId('ses', nowMs) as SessionId;
}
export function newTurnId(nowMs: number): TurnId {
  return makeId('trn', nowMs) as TurnId;
}
export function newStepId(nowMs: number): StepId {
  return makeId('stp', nowMs) as StepId;
}
export function newEventId(nowMs: number): EventId {
  return makeId('evt', nowMs) as EventId;
}
export function newReceiptId(nowMs: number): ReceiptId {
  return makeId('rcp', nowMs) as ReceiptId;
}
export function newModelRequestId(nowMs: number): ModelRequestId {
  return makeId('mrq', nowMs) as ModelRequestId;
}
export function newDelegationId(nowMs: number): DelegationId {
  return makeId('dlg', nowMs) as DelegationId;
}
export function newChildRunId(nowMs: number): ChildRunId {
  return makeId('crn', nowMs) as ChildRunId;
}
export function newJournalEntryId(nowMs: number): JournalEntryId {
  return makeId('jrn', nowMs) as JournalEntryId;
}

/**
 * A short random token for naming an ephemeral external resource.
 *
 * Used for container names, which have to be unique per execution, valid in
 * Docker's charset, and *not* derived from anything the model supplies — a name
 * built from a tool argument would be a way to reach a flag.
 */
export function shortId(length = 10): string {
  return randomUUID().replace(/-/g, '').slice(0, length);
}

/** Tool call ids originate from the model and are therefore untrusted input. */
export function asToolCallId(raw: string): ToolCallId {
  return raw as ToolCallId;
}

/**
 * Legalise a model-supplied tool call id.
 *
 * Providers disagree about the allowed character set and length. Rather than let
 * a provider quirk (or a malicious id) reach the event log or the filesystem, we
 * normalise here, at the Semantic Normalizer boundary.
 */
export function legalizeToolCallId(raw: unknown, fallbackIndex: number): ToolCallId {
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
    if (cleaned.length > 0) return cleaned as ToolCallId;
  }
  return `call_${fallbackIndex}` as ToolCallId;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Short, non-reversible fingerprint used in redaction placeholders and metrics. */
export function fingerprint(data: string, length = 12): string {
  return sha256Hex(data).slice(0, length);
}
