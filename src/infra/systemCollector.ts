import type { Clock } from "../shared/clock.js";
import { newCollectorOn } from "../shared/collector.js";
import type { Collector, CollectorOptions, Mode } from "../shared/collectorTypes.js";
import { systemClock, systemFetch, systemRandom } from "./system.js";
import { newFetchTransport, type Fetch, type Transport } from "../shared/transport.js";

/**
 * Returns a collector. Throws a `TypeError` that names the option for options that would make the intake refuse every
 * envelope, such as a bad key, version or endpoint, and for options only a host outside TypeScript passes. A language
 * that breaks the intake's format is left out and goes to `onError`, since it often comes from the browser.
 */
export function newCollector<M extends Mode>(options: CollectorOptions & { mode: M }): Collector<M>;
export function newCollector(options: CollectorOptions): Collector {
  return newCollectorNotingDays(options, () => undefined);
}

/**
 * Returns a collector, as `newCollector` does, that calls `onNewDay` inside its lock each time it queues the first
 * event of a local day. That event adds the day to the active days.
 */
export function newCollectorNotingDays(options: CollectorOptions, onNewDay: () => void): Collector {
  // The transport's timeout runs on the system clock even when the product passes its own.
  const host = {
    clock: options.clock ?? systemClock,
    random: systemRandom,
    newTransport: newHttpTransport,
  };
  return newCollectorOn({ host, options, onNewDay });
}

/**
 * Returns a transport that posts each body to `endpoint` with `fetch`, the host's own by default. The transport
 * resolves to the status and the raw `Retry-After` header, or to status 0 when a request fails or takes over 30
 * seconds.
 */
export function newHttpTransport(
  endpoint: string,
  { fetch = systemFetch, clock = systemClock }: { fetch?: Fetch; clock?: Clock } = {},
): Transport {
  return newFetchTransport(endpoint, { fetch, clock });
}
