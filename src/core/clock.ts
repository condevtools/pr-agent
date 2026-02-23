export interface Clock {
  now(): number;
}

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export const systemClock: Clock = new SystemClock();

export function nowMs(clock: Clock = systemClock): number {
  return clock.now();
}

export class ManualClock implements Clock {
  private current: number;

  constructor(initialMs = 0) {
    this.current = Math.max(0, Math.floor(initialMs));
  }

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = Math.max(0, Math.floor(ms));
  }

  advance(ms: number): void {
    this.current = Math.max(0, this.current + Math.floor(ms));
  }
}
