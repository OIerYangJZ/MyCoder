/**
 * Secret Broker (spec §13.3).
 *
 * The model never sees a credential — it sees `secret_ref://stripe/test`. When a
 * tool legitimately needs the value, it asks the broker for a *lease*.
 *
 * A lease deliberately has **no accessor that returns the string**. It can only
 * write itself into a destination the kernel controls:
 *
 *   lease.injectInto(env, 'STRIPE_KEY')     // one env slot of one subprocess
 *   lease.applyAuthorization(headers, ...)  // one outbound request
 *
 * `toString()`, `toJSON()` and Node's inspect hook all return the reference, so
 * an accidental `console.log(lease)` or `JSON.stringify({lease})` prints
 * `secret_ref://…`. Getting the value out requires deliberately calling an
 * injector, which is greppable and testable.
 *
 * Every lease registers its value with the Redactor for the lease's lifetime, so
 * a subprocess that echoes the credential has it stripped on the way back.
 */

import { fingerprint } from '../util/ids.ts';
import { kernelError, type KernelError } from '../util/errors.ts';
import type { Clock } from '../util/clock.ts';
import { systemClock } from '../util/clock.ts';
import type { Redactor } from './redactor.ts';

export type SecretRef = string;

export type SecretPurpose = 'subprocess.env' | 'model.auth' | 'egress.header' | 'remote.auth';

export interface SecretLeaseInfo {
  ref: SecretRef;
  fingerprint: string;
  purpose: SecretPurpose;
  expiresAt: number;
  released: boolean;
}

const DEFAULT_TTL_MS = 60_000;

export class SecretLease {
  readonly ref: SecretRef;
  readonly purpose: SecretPurpose;
  readonly expiresAt: number;
  /** Non-reversible id, safe to log and to put in the event log. */
  readonly fingerprint: string;

  private value: string | null;
  private disclosed = false;
  private readonly clock: Clock;
  private readonly redactor: Redactor;
  private readonly onRelease: (lease: SecretLease) => void;

  constructor(
    ref: SecretRef,
    value: string,
    purpose: SecretPurpose,
    expiresAt: number,
    clock: Clock,
    redactor: Redactor,
    onRelease: (lease: SecretLease) => void,
  ) {
    this.ref = ref;
    this.purpose = purpose;
    this.expiresAt = expiresAt;
    this.fingerprint = fingerprint(value);
    this.value = value;
    this.clock = clock;
    this.redactor = redactor;
    this.onRelease = onRelease;
    this.redactor.addLiteral(value);
  }

  get released(): boolean {
    return this.value === null;
  }

  get expired(): boolean {
    return this.clock.now() > this.expiresAt;
  }

  get wasDisclosed(): boolean {
    return this.disclosed;
  }

  /** Write the credential into exactly one environment slot of one subprocess. */
  injectInto(env: Record<string, string>, envName: string): void {
    env[envName] = this.take('subprocess.env');
  }

  /** Write the credential into one outbound request's Authorization header. */
  applyAuthorization(
    headers: Headers | Record<string, string>,
    scheme: 'Bearer' | 'raw',
    headerName = 'authorization',
  ): void {
    const v = this.take('model.auth', 'egress.header', 'remote.auth');
    const rendered = scheme === 'Bearer' ? `Bearer ${v}` : v;
    if (headers instanceof Headers) headers.set(headerName, rendered);
    else headers[headerName] = rendered;
  }

  private take(...allowed: SecretPurpose[]): string {
    if (this.value === null) {
      throw new Error(`secret lease ${this.ref} has already been released`);
    }
    if (this.expired) {
      throw new Error(`secret lease ${this.ref} has expired`);
    }
    if (!allowed.includes(this.purpose)) {
      throw new Error(`secret lease ${this.ref} was issued for "${this.purpose}" and cannot be used here`);
    }
    this.disclosed = true;
    return this.value;
  }

  /** Clear the value and drop it from the active redaction set. */
  release(): void {
    if (this.value === null) return;
    this.redactor.removeLiteral(this.value);
    this.value = null;
    this.onRelease(this);
  }

  info(): SecretLeaseInfo {
    return {
      ref: this.ref,
      fingerprint: this.fingerprint,
      purpose: this.purpose,
      expiresAt: this.expiresAt,
      released: this.released,
    };
  }

  /** What the model, the logs and any accidental stringification see. */
  toString(): string {
    return `secret_ref://${this.ref}`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.toPrimitive](): string {
    return this.toString();
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SecretLease(${this.toString()})`;
  }
}

/** Where a secret's value actually comes from. */
export type SecretSource =
  | { kind: 'literal'; value: string }
  | { kind: 'host-env'; variable: string }
  | { kind: 'file'; path: string };

export interface SecretBroker {
  resolve(ref: SecretRef, purpose: SecretPurpose): Promise<SecretLease>;
  /** Refs the model is allowed to mention, with no values attached. */
  listRefs(): SecretRef[];
  releaseAll(): void;
}

export class SecretResolutionError extends Error {
  readonly kernelError: KernelError;

  constructor(err: KernelError) {
    super(err.message);
    this.name = 'SecretResolutionError';
    this.kernelError = err;
  }
}

export class InMemorySecretBroker implements SecretBroker {
  private readonly sources = new Map<SecretRef, SecretSource>();
  private readonly active = new Set<SecretLease>();
  private readonly redactor: Redactor;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly readFileImpl: (path: string) => Promise<string>;

  constructor(
    redactor: Redactor,
    clock: Clock = systemClock,
    ttlMs: number = DEFAULT_TTL_MS,
    readFileImpl?: (path: string) => Promise<string>,
  ) {
    this.redactor = redactor;
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.readFileImpl = readFileImpl ?? (async (p) => (await import('node:fs/promises')).readFile(p, 'utf8'));
  }

  register(ref: SecretRef, source: SecretSource): void {
    this.sources.set(ref, source);
    // A literal we already hold is redacted from now on, lease or no lease. This
    // is what makes a user-registered canary value safe on every channel.
    if (source.kind === 'literal') this.redactor.addLiteral(source.value);
  }

  listRefs(): SecretRef[] {
    return [...this.sources.keys()].sort();
  }

  has(ref: SecretRef): boolean {
    return this.sources.has(ref);
  }

  async resolve(ref: SecretRef, purpose: SecretPurpose): Promise<SecretLease> {
    const source = this.sources.get(ref);
    if (!source) {
      throw new SecretResolutionError(
        kernelError('SECRET_ACCESS_DENIED', `No secret registered for ref "${ref}".`, {
          blame: 'user',
          safeDetails: { ref, knownRefs: this.listRefs().length },
        }),
      );
    }

    const value = await this.readSource(source, ref);
    if (value === '') {
      throw new SecretResolutionError(
        kernelError('SECRET_ACCESS_DENIED', `Secret "${ref}" resolved to an empty value.`, {
          blame: 'environment',
          safeDetails: { ref },
        }),
      );
    }

    const lease = new SecretLease(
      ref,
      value,
      purpose,
      this.clock.now() + this.ttlMs,
      this.clock,
      this.redactor,
      (l) => this.active.delete(l),
    );
    this.active.add(lease);
    return lease;
  }

  private async readSource(source: SecretSource, ref: SecretRef): Promise<string> {
    switch (source.kind) {
      case 'literal':
        return source.value;

      case 'host-env': {
        // This is the one component permitted to read a credential out of the
        // host environment. Everything downstream gets a scrubbed env.
        const v = process.env[source.variable];
        if (v === undefined) {
          throw new SecretResolutionError(
            kernelError('SECRET_ACCESS_DENIED', `Environment variable for "${ref}" is not set.`, {
              blame: 'user',
              safeDetails: { ref, variable: source.variable },
            }),
          );
        }
        return v;
      }

      case 'file': {
        try {
          return (await this.readFileImpl(source.path)).trim();
        } catch {
          throw new SecretResolutionError(
            kernelError('SECRET_ACCESS_DENIED', `Could not read the secret file for "${ref}".`, {
              blame: 'environment',
              // The path itself is withheld: it is frequently outside the
              // workspace and is not something the model needs.
              safeDetails: { ref },
            }),
          );
        }
      }
    }
  }

  releaseAll(): void {
    for (const lease of [...this.active]) lease.release();
    this.active.clear();
  }

  get activeLeaseCount(): number {
    return this.active.size;
  }
}
