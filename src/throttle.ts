import type { TrackOptions } from './collectorTypes.js';

/**
 * Remembers in memory when each event name last went from a call with `throttleMs`. The window is leading-edge: the
 * first such call goes, and a later one of the name goes only once its `throttleMs` passed since the last one that
 * went. A call without `throttleMs` opens no window and is never dropped.
 */
export interface Throttle {
  /** Tells whether a call of `name` at `now` with `throttleMs` falls inside the window of the name. */
  isDropped(call: ThrottledCall): boolean;
  /** Opens the window of `name` at `now` for a call with `throttleMs` that went. */
  went(call: ThrottledCall): void;
}

/** One `track` call as the throttle reads it. */
interface ThrottledCall {
  name: string;
  throttleMs: number | undefined;
  now: number;
}

export function newThrottle(): Throttle {
  const lastWent = new Map<string, number>();
  return {
    isDropped: ({ name, throttleMs, now }) => {
      const last = lastWent.get(name);
      // A clock set back counts by how far it moved, so the window never stays open until the clock catches up.
      return throttleMs !== undefined && last !== undefined && Math.abs(now - last) < throttleMs;
    },
    went: ({ name, throttleMs, now }) => {
      if (throttleMs !== undefined) {
        lastWent.set(name, now);
      }
    },
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
