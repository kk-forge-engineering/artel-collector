/**
 * Gives the time and the timers. The collector and the transport read both through this port, so that a test can move
 * them by hand. A timer hands back its own cancel, so the port names no timer handle, whose type differs between
 * hosts.
 */
export interface Clock {
  /** Returns milliseconds since the epoch. */
  now(): number;
  /** Runs `callback` after `delayMs` and returns the function that cancels it. A cancel after the run does nothing. */
  setTimeout(callback: () => void, delayMs: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};
