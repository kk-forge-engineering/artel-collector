import {
  newCollector,
  newHttpTransport,
  newMemoryStorage,
  Platform,
  type Collector,
  type CollectorOptions,
  type Transport,
} from '../src/exports.js';
import { FakeClock } from './fakeClock.js';
import { FakeFetch } from './fakeFetch.js';

export const KEY = 'extension-aa131n3j11';
export const ENDPOINT = 'https://intake.example.com/v1/public/relay';
export const VERSION = '4.2.0';
export const QUEUE_KEY = 'artel.queue';
export const SEND_DELAY_MS = 5_000;
export const RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** A collector wired to fakes at every edge, plus those fakes, so one test can drive and read all of them. */
export interface Harness {
  collector: Collector;
  fetch: FakeFetch;
  clock: FakeClock;
  storage: CollectorOptions['storage'];
  /** The HTTP transport over `fetch`. The collector does not use it when a test passes its own `transport`. */
  transport: Transport;
  errors: unknown[];
  /** Another collector over the same storage, as after a restart of the host. */
  restart(overrides?: Partial<CollectorOptions>): Collector;
  /**
   * Advances the clock past the send delay and the first retry delay. The test then sees each queued send and the first
   * retry of a failed one.
   */
  settle(): Promise<void>;
}

/**
 * Builds a collector over fakes for fetch, storage and the clock. The overrides also apply to each collector that
 * `restart` builds.
 */
export function newHarness(overrides: Partial<CollectorOptions> = {}): Harness {
  const fetch = new FakeFetch();
  const clock = new FakeClock('2026-10-29T10:00:00');
  const storage = newMemoryStorage();
  const errors: unknown[] = [];
  const transport = newHttpTransport(ENDPOINT, { fetch: fetch.fetch, clock });
  const build = (more: Partial<CollectorOptions>): Collector =>
    newCollector({
      key: KEY,
      platform: Platform.Extension,
      version: VERSION,
      lang: 'en',
      storage,
      clock,
      transport,
      onError: (error) => errors.push(error),
      ...overrides,
      ...more,
    });
  const settle = (): Promise<void> => clock.advance(SEND_DELAY_MS + RETRY_DELAY_MS);
  return { collector: build({}), fetch, clock, storage, transport, errors, restart: build, settle };
}

/**
 * Returns the time from an event to the start of send attempt `attempt`, counted from 1, when every earlier attempt
 * fails. The retry delay doubles from `RETRY_DELAY_MS` up to `MAX_RETRY_DELAY_MS`, as the outbox does.
 */
export function attemptStartMs(attempt: number): number {
  let elapsed = SEND_DELAY_MS;
  for (let retry = 0; retry < attempt - 1; retry++) {
    elapsed += Math.min(RETRY_DELAY_MS * 2 ** retry, MAX_RETRY_DELAY_MS);
  }
  return elapsed;
}
