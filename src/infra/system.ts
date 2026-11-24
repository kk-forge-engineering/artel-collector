import type { Clock } from "../shared/clock.js";
import type { Random } from "../shared/random.js";
import type { Fetch } from "../shared/transport.js";

/** The host's clock and timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

/** The host's cryptographic random bytes. */
export const systemRandom: Random = {
  bytes: (count) => crypto.getRandomValues(new Uint8Array(count)),
};

/** The host's `fetch`, called through its global, since a browser refuses a `fetch` called apart from its global. */
export const systemFetch: Fetch = (input, init) => globalThis.fetch(input, init);
