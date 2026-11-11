import {
  AnalyticsState,
  Mode,
  newCollector,
  newHttpTransport,
  newMemoryStorage,
  Platform,
  type Browser,
  type Collector,
  type CommonOptions,
  type GetId,
  type PageFields,
  type StorageAdapter,
  type Transport,
} from '../src/exports.js';
import { FakeClock } from './fakeClock.js';
import { FakeFetch } from './fakeFetch.js';

/** The live key of an extension channel, the harness's default platform. */
export const KEY = 'extension-aa131n3j11';
export const SITE_KEY = 'site-aa131n3j11';
export const DESKTOP_KEY = 'desktop-aa131n3j11';
export const ENDPOINT = 'https://intake.example.com/v1/public/relay';
export const VERSION = '4.2.0';
/** A consented user's id in an identified channel. */
export const USER_ID = 'c0ffee12';
/** Returns the storage key the collector of channel `key` keeps `name` under. */
export function storageKey(name: string, key = KEY): string {
  return `artel.${key}.${name}`;
}
export const QUEUE_KEY = storageKey('queue');
export const STATE_KEY = storageKey('state');
/** The end of the retry wait every context keeps, in epoch milliseconds. */
export const RETRY_AT_KEY = storageKey('retry_at');
const BROWSER_LANGUAGE = 'pt-BR';
const UI_LANGUAGE = 'zh-Hant-TW';
export const SEND_DELAY_MS = 5_000;
export const RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** A collector wired to fakes at every edge, plus those fakes, so one test can drive and read all of them. */
export interface Harness {
  collector: Collector;
  fetch: FakeFetch;
  clock: FakeClock;
  storage: StorageAdapter;
  /** The HTTP transport over `fetch`. The collector does not use it when a test passes its own `transport`. */
  transport: Transport;
  errors: unknown[];
  /**
   * Builds another collector over the same storage and clock, as after a restart of the host. Its overrides add to
   * those given to `newHarness`.
   */
  restart(overrides?: HarnessOverrides): Collector;
  /**
   * Advances the clock past the send delay and the first retry delay. The test then sees each queued send and the first
   * retry of a failed one.
   */
  settle(): Promise<void>;
}

/**
 * Lists what a test changes in the harness's collector. A `getId` makes the channel identified and, unless `state` says
 * otherwise, the user identified too. The collector takes `browser` only with a `getId` on web or extension.
 */
type HarnessOverrides = Partial<CommonOptions> & {
  platform?: Platform;
  /** The page of each event. The collector takes it on platform web only. */
  getPage?: (name: string) => PageFields | undefined;
  transport?: Transport;
  getId?: GetId;
  browser?: Browser | (() => Browser | undefined);
  /**
   * The state the user chose before the collector starts. Given as `undefined`, the harness stores none, as on a first
   * run.
   */
  state?: AnalyticsState | undefined;
};

/**
 * Builds a collector over fakes for fetch, storage and the clock. The overrides also apply to each collector that
 * `restart` builds.
 */
export function newHarness(overrides: HarnessOverrides = {}): Harness {
  const fetch = new FakeFetch();
  const clock = new FakeClock('2026-10-29T10:00:00');
  const storage = newMemoryStorage();
  const errors: unknown[] = [];
  const transport = newHttpTransport(ENDPOINT, { fetch: fetch.fetch, clock });
  const build = (more: HarnessOverrides): Collector => {
    const {
      platform = Platform.Extension,
      getId,
      browser,
      getPage,
      state: _state,
      ...rest
    } = { ...overrides, ...more };
    const common = {
      key: keyOf(platform),
      version: VERSION,
      browserLanguage: BROWSER_LANGUAGE,
      uiLanguage: UI_LANGUAGE,
      storage,
      clock,
      transport,
      onError: (error: Error) => errors.push(error),
      ...rest,
    };
    const identified = getId === undefined ? undefined : ({ mode: Mode.Identified, getId } as const);
    if (platform === Platform.Web) {
      return identified === undefined
        ? newCollector({ ...common, platform, getPage, mode: Mode.Anonymous })
        : newCollector({ ...common, platform, getPage, ...identified, browser });
    }
    if (platform === Platform.Extension) {
      return identified === undefined
        ? newCollector({ ...common, platform, mode: Mode.Anonymous })
        : newCollector({ ...common, platform, ...identified, browser });
    }
    return identified === undefined
      ? newCollector({ ...common, platform, mode: Mode.Anonymous })
      : newCollector({ ...common, platform, ...identified });
  };
  // The harness writes this state once, before the first collector. A restart reads what the storage holds by then and
  // ignores a `state` override.
  const defaultState = overrides.getId === undefined ? undefined : AnalyticsState.Identified;
  const initialState = 'state' in overrides ? overrides.state : defaultState;
  if (initialState !== undefined) {
    // The memory storage writes at once, before the collector reads anything.
    void storage.set(
      storageKey('state', overrides.key ?? keyOf(overrides.platform ?? Platform.Extension)),
      initialState,
    );
  }
  const settle = (): Promise<void> => clock.advance(SEND_DELAY_MS + RETRY_DELAY_MS);
  return { collector: build({}), fetch, clock, storage, transport, errors, restart: build, settle };
}

/** Returns a key of the channel kind that takes `platform`. */
function keyOf(platform: Platform): string {
  if (platform === Platform.Extension) {
    return KEY;
  }
  return platform === Platform.Web ? SITE_KEY : DESKTOP_KEY;
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
