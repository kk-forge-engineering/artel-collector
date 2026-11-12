import type { TrackOptions } from './collectorTypes.js';

/**
 * Remembers in memory when each event name last went, for the `throttleMs` of `track`. The window is leading-edge: the
 * first event goes, and a later one of the name goes only once `throttleMs` passed since the last one that went.
 */
export interface Throttle {
  /** Tells whether an event of `name` called at `now` falls inside the window of the last one of the name that went. */
  isDropped(name: string, throttleMs: number | undefined, now: number): boolean;
  /** Stores that an event of `name` called at `now` went, which opens its window. */
  went(name: string, now: number): void;
}

export function newThrottle(): Throttle {
  const lastWent = new Map<string, number>();
  return {
    isDropped: (name, throttleMs, now) => {
      const last = lastWent.get(name);
      // A clock set back counts by how far it moved, so the window never stays open until the clock catches up.
      return throttleMs !== undefined && last !== undefined && Math.abs(now - last) < throttleMs;
    },
    went: (name, now) => void lastWent.set(name, now),
  };
}

/**
 * Returns the `throttleMs` of `track`'s options, which holds undefined when they name none. Returns undefined when it is
 * no finite number from 0, when the options are no object, or when reading them throws.
 */
export function throttleOf(options: TrackOptions | undefined): { throttleMs: number | undefined } | undefined {
  const value: unknown = options;
  if (value === undefined) {
    return { throttleMs: undefined };
  }
  let throttleMs: unknown;
  try {
    // An untyped host can pass options of any kind, such as ones with a getter that throws.
    throttleMs = typeof value === 'object' && value !== null ? Reflect.get(value, 'throttleMs') : Number.NaN;
  } catch {
    return undefined;
  }
  if (throttleMs === undefined) {
    return { throttleMs: undefined };
  }
  return typeof throttleMs === 'number' && Number.isFinite(throttleMs) && throttleMs >= 0 ? { throttleMs } : undefined;
}
