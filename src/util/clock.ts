/**
 * Injectable clock.
 *
 * Every timestamp in the event log goes through here so that replay tests can
 * assert on exact event sequences without racing the wall clock.
 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Deterministic clock for tests: advances by a fixed step on every read. */
export class FakeClock implements Clock {
  private current: number;
  private readonly stepMs: number;

  constructor(startMs = 1_700_000_000_000, stepMs = 1) {
    this.current = startMs;
    this.stepMs = stepMs;
  }

  now(): number {
    const t = this.current;
    this.current += this.stepMs;
    return t;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
