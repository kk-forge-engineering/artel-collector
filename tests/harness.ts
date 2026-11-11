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
/** The intake's forget address, which the collector derives from `ENDPOINT`. */
export const FORGET_URL = 'https://intake.example.com/v1/public/forget';
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
  /**
   * The transport over `fetch`, which posts an envelope to `ENDPOINT` and a forget request to `FORGET_URL`. The
   * collector does not use it when a test passes its own `transport`.
   */
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
 * otherwise, the user identified too. A `mode` of pseudonymous without `getId` makes the user pseudonymous the same
 * way. The collector takes `browser` only in those two modes on web or extension.
 */
type HarnessOverrides = Partial<CommonOptions> & {
  platform?: Platform;
  /** The channel mode, identified by default with a `getId` and anonymous without. */
  mode?: Mode;
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
  const relay = newHttpTransport(ENDPOINT, { fetch: fetch.fetch, clock });
  const forget = newHttpTransport(FORGET_URL, { fetch: fetch.fetch, clock });
  // A product's own transport tells a forget request from an envelope by its body, which holds no events.
  const transport: Transport = (body) => (isEnvelopeBody(body) ? relay(body) : forget(body));
  const build = (more: HarnessOverrides): Collector => {
    const {
      platform = Platform.Extension,
      mode,
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
    const named = modeWithId(mode, getId);
    if (platform === Platform.Web) {
      return named === undefined
        ? newCollector({ ...common, platform, getPage, mode: Mode.Anonymous })
        : newCollector({ ...common, platform, getPage, ...named, browser });
    }
    if (platform === Platform.Extension) {
      return named === undefined
        ? newCollector({ ...common, platform, mode: Mode.Anonymous })
        : newCollector({ ...common, platform, ...named, browser });
    }
    return named === undefined
      ? newCollector({ ...common, platform, mode: Mode.Anonymous })
      : newCollector({ ...common, platform, ...named });
  };
  // The harness writes this state once, before the first collector. A restart reads what the storage holds by then and
  // ignores a `state` override.
  const defaultState = defaultStateOf(modeWithId(overrides.mode, overrides.getId)?.mode);
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

/**
 * Returns the mode options of a channel with an id: identified with a `getId`, pseudonymous for that mode, and
 * undefined for an anonymous channel.
 */
function modeWithId(
  mode: Mode | undefined,
  getId: GetId | undefined,
): { mode: typeof Mode.Identified; getId: GetId } | { mode: typeof Mode.Pseudonymous } | undefined {
  if (getId !== undefined) {
    return { mode: Mode.Identified, getId };
  }
  return mode === Mode.Pseudonymous ? { mode } : undefined;
}

/** Returns the state a user of a channel of `mode` starts in: the state of the channel's id, or none stored. */
function defaultStateOf(mode: Mode | undefined): AnalyticsState | undefined {
  if (mode === Mode.Identified) {
    return AnalyticsState.Identified;
  }
  return mode === Mode.Pseudonymous ? AnalyticsState.Pseudonymous : undefined;
}

function isEnvelopeBody(body: string): boolean {
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === 'object' && parsed !== null && 'events' in parsed;
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
