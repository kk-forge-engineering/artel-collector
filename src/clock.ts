export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Gives the time and the timers. The collector and the transport read both through this port, so that a test can move
 * them by hand.
 */
export interface Clock {
  /** Returns milliseconds since the epoch. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};
