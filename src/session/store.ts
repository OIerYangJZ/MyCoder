/**
 * Session persistence (spec §21.1).
 *
 *   sessions/<session-id>/
 *   ├── session.json     mutable metadata snapshot
 *   ├── events.jsonl     append-only log — the source of truth
 *   ├── artifacts/       oversized tool output, referenced from events
 *   └── snapshots/       workspace change snapshots for mutation detection
 *
 * The append path is the interesting one. Every event is:
 *   1. assigned a monotonic `seq` by the store, not by the caller;
 *   2. serialised and **redacted** — the store is the last line of defence for
 *      invariant 12, and it is the one component that sees every event;
 *   3. appended with `O_APPEND` and never rewritten.
 *
 * Writes are serialised through a promise chain so concurrent tool completions
 * cannot interleave partial lines into the log.
 */

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';

import type { Clock } from '../util/clock.ts';
import { systemClock } from '../util/clock.ts';
import { newEventId, sha256Hex, type SessionId } from '../util/ids.ts';
import type { Redactor } from '../security/redactor.ts';
import type { KernelEvent, KernelEventType } from './events.ts';

export interface SessionMetadata {
  sessionId: SessionId;
  createdAt: number;
  updatedAt: number;
  kernelVersion: string;
  workspaceRoot: string;
  /** Hash of workspace root + git head, checked on resume (spec §21.3). */
  workspaceIdentity: string;
  remote?: string;
  remoteIdentity?: string;
  model: string;
  permissionProfile: string;
  backendKind: string;
  title?: string;
  goal?: {
    objective: string;
    criteria: string[];
    status: 'active' | 'paused' | 'completed' | 'cleared';
    createdAt: number;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
    modelRequests: number;
    toolCalls: number;
  };
  lastSeq: number;
  /** Set when the session ended cleanly; absent means it may be resumable. */
  endedAt?: number;
}

export interface AppendableEvent {
  type: KernelEventType;
  payload: unknown;
  turnId?: string;
  stepId?: string;
}

export interface SessionStore {
  createSession(meta: SessionMetadata): Promise<void>;
  loadMetadata(sessionId: SessionId): Promise<SessionMetadata | undefined>;
  saveMetadata(meta: SessionMetadata): Promise<void>;
  append(sessionId: SessionId, event: AppendableEvent): Promise<KernelEvent>;
  readEvents(sessionId: SessionId): AsyncIterable<KernelEvent>;
  listSessions(): Promise<SessionMetadata[]>;
  writeArtifact(sessionId: SessionId, name: string, content: string): Promise<string>;
  readArtifact(sessionId: SessionId, ref: string): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface FileSessionStoreOptions {
  rootDir: string;
  redactor: Redactor;
  clock?: Clock;
}

export class FileSessionStore implements SessionStore {
  private readonly rootDir: string;
  private readonly redactor: Redactor;
  private readonly clock: Clock;
  private readonly seqs = new Map<string, number>();
  /** Per-session write chain; guarantees ordered, non-interleaved appends. */
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(opts: FileSessionStoreOptions) {
    this.rootDir = opts.rootDir;
    this.redactor = opts.redactor;
    this.clock = opts.clock ?? systemClock;
  }

  private dir(sessionId: SessionId): string {
    return path.join(this.rootDir, sessionId);
  }

  async createSession(meta: SessionMetadata): Promise<void> {
    const dir = this.dir(meta.sessionId);
    await mkdir(path.join(dir, 'artifacts'), { recursive: true });
    await mkdir(path.join(dir, 'snapshots'), { recursive: true });
    this.seqs.set(meta.sessionId, meta.lastSeq);
    await this.saveMetadata(meta);
    // Touch the log so a crashed session is still distinguishable from a
    // never-started one.
    await appendFile(path.join(dir, 'events.jsonl'), '', 'utf8');
  }

  async loadMetadata(sessionId: SessionId): Promise<SessionMetadata | undefined> {
    try {
      const raw = await readFile(path.join(this.dir(sessionId), 'session.json'), 'utf8');
      return JSON.parse(raw) as SessionMetadata;
    } catch {
      return undefined;
    }
  }

  /**
   * Metadata is a *snapshot*, so it is written atomically (temp + rename). A
   * torn session.json would break resume; the event log can always rebuild it.
   */
  async saveMetadata(meta: SessionMetadata): Promise<void> {
    const dir = this.dir(meta.sessionId);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, 'session.json');
    const tmp = `${target}.tmp`;
    const next: SessionMetadata = { ...meta, updatedAt: this.clock.now() };
    await writeFile(tmp, this.redactor.redact(JSON.stringify(next, null, 2)) + '\n', 'utf8');
    await rename(tmp, target);
  }

  append(sessionId: SessionId, event: AppendableEvent): Promise<KernelEvent> {
    const chained = (this.writeChains.get(sessionId) ?? Promise.resolve()).then(
      () => this.appendNow(sessionId, event),
      () => this.appendNow(sessionId, event),
    );
    this.writeChains.set(sessionId, chained);
    return chained;
  }

  private async appendNow(sessionId: SessionId, event: AppendableEvent): Promise<KernelEvent> {
    const seq = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, seq);

    const ts = this.clock.now();
    const record: KernelEvent = {
      eventId: newEventId(ts),
      seq,
      ts,
      sessionId,
      type: event.type,
      payload: event.payload,
    };
    if (event.turnId) record.turnId = event.turnId as KernelEvent['turnId'];
    if (event.stepId) record.stepId = event.stepId as KernelEvent['stepId'];

    // Redact the serialised form, not the object: this catches a secret hiding
    // in a nested field nobody remembered to sanitise.
    const line = this.redactor.redact(JSON.stringify(record));
    await appendFile(path.join(this.dir(sessionId), 'events.jsonl'), line + '\n', 'utf8');

    return JSON.parse(line) as KernelEvent;
  }

  async *readEvents(sessionId: SessionId): AsyncIterable<KernelEvent> {
    const file = path.join(this.dir(sessionId), 'events.jsonl');
    let stream;
    try {
      stream = createReadStream(file, { encoding: 'utf8' });
    } catch {
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let expected = 0;
    try {
      for await (const line of rl) {
        if (line.trim() === '') continue;
        let event: KernelEvent;
        try {
          event = JSON.parse(line) as KernelEvent;
        } catch {
          // A torn final line is the normal signature of a hard kill. Stop
          // rather than guess, and let resume synthesise from what we have.
          break;
        }
        expected += 1;
        if (event.seq !== expected) {
          // Report the gap by adjusting our expectation, but keep yielding: a
          // partially damaged log is still better than none for audit.
          expected = event.seq;
        }
        this.seqs.set(sessionId, Math.max(this.seqs.get(sessionId) ?? 0, event.seq));
        yield event;
      }
    } finally {
      rl.close();
    }
  }

  async listSessions(): Promise<SessionMetadata[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return [];
    }
    const metas: SessionMetadata[] = [];
    for (const id of entries) {
      const meta = await this.loadMetadata(id as SessionId);
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Spill oversized tool output to a file and return a reference the model can
   * ask about later (spec invariant 9: large output gets a budget and a ref).
   */
  async writeArtifact(sessionId: SessionId, name: string, content: string): Promise<string> {
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
    const ref = `${sha256Hex(content).slice(0, 12)}-${safeName}`;
    const dir = path.join(this.dir(sessionId), 'artifacts');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ref), this.redactor.redact(content), 'utf8');
    return `artifact://${ref}`;
  }

  async readArtifact(sessionId: SessionId, ref: string): Promise<string | undefined> {
    const name = ref.replace(/^artifact:\/\//, '');
    if (name.includes('/') || name.includes('..')) return undefined;
    try {
      return await readFile(path.join(this.dir(sessionId), 'artifacts', name), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Wait for every queued append to reach the filesystem. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.writeChains.values()]);
    this.writeChains.clear();
  }

  /** Force the log to durable storage. Used before the process exits. */
  async fsync(sessionId: SessionId): Promise<void> {
    await this.close();
    try {
      const handle = await open(path.join(this.dir(sessionId), 'events.jsonl'), 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // A missing log at shutdown is not worth failing the process over.
    }
  }
}

/** In-memory store for unit tests and dry runs. Same contract, no filesystem. */
export class MemorySessionStore implements SessionStore {
  private readonly metas = new Map<string, SessionMetadata>();
  private readonly logs = new Map<string, KernelEvent[]>();
  private readonly artifacts = new Map<string, string>();
  private readonly redactor: Redactor;
  private readonly clock: Clock;

  constructor(redactor: Redactor, clock: Clock = systemClock) {
    this.redactor = redactor;
    this.clock = clock;
  }

  async createSession(meta: SessionMetadata): Promise<void> {
    this.metas.set(meta.sessionId, meta);
    this.logs.set(meta.sessionId, []);
  }

  async loadMetadata(sessionId: SessionId): Promise<SessionMetadata | undefined> {
    return this.metas.get(sessionId);
  }

  async saveMetadata(meta: SessionMetadata): Promise<void> {
    this.metas.set(meta.sessionId, { ...meta, updatedAt: this.clock.now() });
  }

  async append(sessionId: SessionId, event: AppendableEvent): Promise<KernelEvent> {
    const log = this.logs.get(sessionId) ?? [];
    const ts = this.clock.now();
    const record: KernelEvent = {
      eventId: newEventId(ts),
      seq: log.length + 1,
      ts,
      sessionId,
      type: event.type,
      payload: event.payload,
    };
    if (event.turnId) record.turnId = event.turnId as KernelEvent['turnId'];
    if (event.stepId) record.stepId = event.stepId as KernelEvent['stepId'];

    const redacted = JSON.parse(this.redactor.redact(JSON.stringify(record))) as KernelEvent;
    log.push(redacted);
    this.logs.set(sessionId, log);
    return redacted;
  }

  async *readEvents(sessionId: SessionId): AsyncIterable<KernelEvent> {
    for (const e of this.logs.get(sessionId) ?? []) yield e;
  }

  async listSessions(): Promise<SessionMetadata[]> {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async writeArtifact(sessionId: SessionId, name: string, content: string): Promise<string> {
    const ref = `artifact://${sha256Hex(content).slice(0, 12)}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    this.artifacts.set(`${sessionId}:${ref}`, this.redactor.redact(content));
    return ref;
  }

  async readArtifact(sessionId: SessionId, ref: string): Promise<string | undefined> {
    return this.artifacts.get(`${sessionId}:${ref}`);
  }

  async close(): Promise<void> {}

  /** Test helper: the raw log, already redacted. */
  events(sessionId: SessionId): KernelEvent[] {
    return [...(this.logs.get(sessionId) ?? [])];
  }
}
