export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A controllable clock for tests. */
export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}
