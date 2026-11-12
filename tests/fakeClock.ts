import type { Clock, TimerHandle } from "../src/exports.js";

interface Timer {
  due: number;
  callback: () => void;
}

/**
 * A clock and its timers that a test moves by hand. The constructor and `setLocal` take local times, in the zone that
 * `vitest.config.ts` sets for the run. The collector reads calendar days in local time.
 */
export class FakeClock implements Clock {
  private current: number;
  private readonly timers = new Map<number, Timer>();
  private lastHandle = 0;

  constructor(localTime: string) {
    this.current = parseLocal(localTime);
  }

  readonly now = (): number => this.current;

  readonly setTimeout = (callback: () => void, delayMs: number): TimerHandle => {
    this.lastHandle++;
    this.timers.set(this.lastHandle, { due: this.current + delayMs, callback });
    // The build uses the dom typings, where a timer handle is a number.
    return this.lastHandle;
  };

  readonly clearTimeout = (handle: TimerHandle | undefined): void => {
    if (handle !== undefined) {
      this.timers.delete(handle);
    }
  };

  /**
   * Moves the time forward by `ms` and fires each timer that falls due, in due order. After each timer, waits until the
   * work that timer started settles.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    // Work the test started, such as an answer it just gave, settles first. On a real host, that work settles before
    // any timer fires.
    await settleWork();
    for (let next = this.nextDue(target); next !== undefined; next = this.nextDue(target)) {
      const [handle, timer] = next;
      this.timers.delete(handle);
      this.current = Math.max(this.current, timer.due);
      timer.callback();
      await settleWork();
    }
    this.current = target;
    await settleWork();
  }

  /**
   * Jumps the wall clock to a local time without firing timers, as on a device that sleeps. The next `advance` fires
   * each timer that is now overdue.
   */
  setLocal(localTime: string): void {
    this.current = parseLocal(localTime);
  }

  setUtc(utcTime: string): void {
    this.current = Date.parse(utcTime);
  }

  /** Drops every pending timer, as a host stopped mid-wait does. */
  dropTimers(): void {
    this.timers.clear();
  }

  /** Jumps the wall clock, forward or back, without firing timers. */
  jumpMinutes(minutes: number): void {
    this.current += minutes * 60_000;
  }

  private nextDue(target: number): [number, Timer] | undefined {
    let next: [number, Timer] | undefined;
    for (const entry of this.timers) {
      if (entry[1].due <= target && (next === undefined || entry[1].due < next[1].due)) {
        next = entry;
      }
    }
    return next;
  }
}

/**
 * Waits one turn of the host's real event loop. By then, the promises that the test or the fired timer started have
 * settled.
 */
function settleWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function parseLocal(localTime: string): number {
  // An ISO date-time without a zone parses as local time.
  return new Date(localTime).getTime();
}
