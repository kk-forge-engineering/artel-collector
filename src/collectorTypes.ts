import type { Browser } from './browser.js';
import type { Clock } from './clock.js';
import type { EventParams, Platform } from './envelope.js';
import type { Lock } from './lock.js';
import type { ProductFields } from './stateFields.js';
import type { StorageAdapter } from './storage.js';
import type { Transport } from './transport.js';

/**
 * What a channel may collect at most, as set in the intake's admin. The collector's mode matches its channel's. Each
 * mode takes the states up to its own: a pseudonymous channel adds the install id, and an identified one the account
 * id.
 */
export const Mode = {
  Anonymous: 'anonymous',
  Pseudonymous: 'pseudonymous',
  Identified: 'identified',
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

/** What the collector sends for this user, a choice the collector stores. Every user starts anonymous. */
export const AnalyticsState = {
  /** Sends nothing. Switching to it sends one `opted_out`, with no id or browser, and drops what was not sent. */
  OptedOut: 'opted_out',
  /** Sends events with no id or browser, the primary languages only and coarse ages. Needs no consent. */
  Anonymous: 'anonymous',
  /**
   * Sends a random install id the collector makes and stores, the browser, the full languages and exact ages. Needs
   * consent. A pseudonymous or identified channel takes it.
   */
  Pseudonymous: 'pseudonymous',
  /**
   * Sends what the pseudonymous state sends, with the id from `getId` in place of the install id. Needs consent. Only
   * an identified channel takes it.
   */
  Identified: 'identified',
} as const;
export type AnalyticsState = (typeof AnalyticsState)[keyof typeof AnalyticsState];

/** The states a collector of channel mode `M` takes: those up to its mode. */
export type StateOf<M extends Mode> = M extends typeof Mode.Identified
  ? AnalyticsState
  : M extends typeof Mode.Pseudonymous
    ? Exclude<AnalyticsState, typeof AnalyticsState.Identified>
    : Exclude<AnalyticsState, typeof AnalyticsState.Pseudonymous | typeof AnalyticsState.Identified>;

/**
 * Returns the user's id, or undefined while the product does not know it yet. The collector never makes one up. The
 * collector calls it while it holds its lock, so it must not await a method of the same collector, which would wait on
 * it forever. The same holds for a `browser` function.
 */
export type GetId = () => string | undefined | Promise<string | undefined>;

/** The options every collector takes, whatever its platform and mode. */
export interface CommonOptions {
  /**
   * The live channel key in the build for the store, the test key in any other build. A key that breaks the intake's
   * form, or whose channel kind does not take the platform, makes the constructor throw.
   */
  key: string;
  /**
   * Product version, such as `1.2.3` or `1.2.3-beta.1`. The intake refuses an envelope without one, so a version that
   * breaks the intake's format makes the constructor throw.
   */
  version: string;
  /** The user's language, such as `pt-BR`: what the browser asks sites for. */
  browserLanguage?: string | undefined;
  /** The language the user picked in the product, when the product offers that choice. Left out otherwise. */
  uiLanguage?: string | undefined;
  storage: StorageAdapter;
  /** Minutes without events that end a session, 10 by default. */
  sessionIdleMinutes?: number | undefined;
  /** The longest an event waits in the queue before a send starts, 5 seconds by default. */
  sendDelaySeconds?: number | undefined;
  /** Time and timers, the host's own by default. */
  clock?: Clock | undefined;
  /**
   * Runs an operation while no other context that shares `storage` runs one. Without it, two contexts recording at once
   * may both mark the first event of a day, or both send one envelope, and an event another context records during an
   * opt-out may still leave.
   */
  lock?: Lock | undefined;
  /**
   * Hears every failure the collector does not retry, such as a refused event, a dropped envelope or a storage error.
   * A request the collector sends again later, after status 0, 429 or 5xx, reaches it only once its envelope is
   * dropped.
   */
  onError?: ((error: Error) => void) | undefined;
}

/** Where envelopes go: the intake's address, or the product's own transport instead. */
export type Delivery = { endpoint: string; transport?: never } | { transport: Transport; endpoint?: never };

/**
 * The browser the product runs in, or a function that returns it, such as `() => detectBrowser(navigator)`. The
 * collector calls the function once, for the first event with an id, the only kind of envelope that carries it.
 */
type BrowserOption = Browser | (() => Browser | undefined) | undefined;

/** The channel mode, with what a channel with an id takes besides. */
export type ModeOptions =
  | { mode: typeof Mode.Anonymous; getId?: never; browser?: never }
  | { mode: typeof Mode.Pseudonymous; getId?: never; browser?: BrowserOption }
  | {
      mode: typeof Mode.Identified;
      /** Gives the id in the identified state. The collector calls it in no other state. */
      getId: GetId;
      browser?: BrowserOption;
    };

/** The options only a site's collector takes, since only platform web sends pages. */
export interface PageOptions {
  /**
   * Returns the page of an event with this name. The collector calls it when a method is called, so a navigation right
   * after the call does not move the event. The core reads no page itself, and shapes whatever this function returns
   * as `PageFields` says.
   */
  getPage?: ((name: string) => PageFields | undefined) | undefined;
}

/** The platforms whose products run in a browser. Only their envelopes may name it. */
type BrowserPlatform = typeof Platform.Web | typeof Platform.Extension;

/** The options of `newCollector`. Only a site takes `getPage`, and a desktop product names no browser. */
export type CollectorOptions = CommonOptions &
  Delivery &
  ModeOptions &
  (
    | ({ platform: typeof Platform.Web } & PageOptions)
    | { platform: typeof Platform.Extension; getPage?: never }
    | { platform: Exclude<Platform, BrowserPlatform>; browser?: never; getPage?: never }
  );

/** What a site channel's event says about its page. The intake keeps only the path and the referring host. */
export interface PageFields {
  /**
   * The page's path, or its full URL. The collector sends the path without its query string, fragment and path
   * parameters, with each segment that holds an `@`, an IPv4 or an IPv6 address as `:address`, and a segment that
   * starts a URL and the rest of the path after it as one `:address`, cut to 256 characters.
   */
  page?: string;
  /**
   * The referrer URL. The collector sends its host only, with the first `page_view` it records, and none for a host
   * that is an IP address or holds an `@`, or a host past 128 characters. It leaves the referrer out when the page is a
   * full URL of the same host.
   */
  referrer?: string;
}

/** Bucket for the number of days with at least one event. */
export const ActiveDaysBucket = {
  None: '0',
  One: '1',
  TwoToFive: '2-5',
  SixToTwenty: '6-20',
  TwentyOneOrMore: '21+',
} as const;
export type ActiveDaysBucket = (typeof ActiveDaysBucket)[keyof typeof ActiveDaysBucket];

/** What an uninstall page gets in its query string, shaped by the state as an envelope is. */
export interface UninstallParams extends ProductFields {
  /** Days since install: exact up to 31 in a state with an id, a bucket otherwise. */
  age_days: number;
  /** The bucket of the number of local days with an event. */
  active_days: ActiveDaysBucket;
}

/** Every method resolves and never rejects. A failure goes only to `onError`. */
export interface Collector<M extends Mode = Mode> {
  /**
   * Queues the event for the current state. Refuses and reports an event the intake would drop for its form or a system
   * event's params, and `installed`, `updated` and `opted_out`, which only the collector's own methods send. The intake
   * drops an event whose string param looks like an address, and the product's allowlist, which the collector does not
   * know, decides the rest. `onError` hears of neither drop.
   */
  track(name: string, params?: EventParams): Promise<void>;
  /** Sends `installed` once per install. In the opted_out state it sends nothing and marks nothing. */
  installed(): Promise<void>;
  /**
   * Sends `updated` when the version differs from the one `installed()` or `updated()` stored, or when none is stored.
   * Call it after `installed()`. In the opted_out state it sends nothing and marks nothing.
   */
  updated(): Promise<void>;
  /**
   * Stores the user's choice and starts a new session. Switching to `opted_out` drops what was not sent, except an
   * earlier `opted_out`, and sends one `opted_out`, at once or at the end of a retry wait that is running. Switching
   * from `pseudonymous` or `identified` forgets the last id, as `forget` does, and drops the queued events that wait
   * for an id. Switching from `pseudonymous` also deletes the install id. A dropped event that no request carried gives
   * back its marks. The same state again does nothing.
   */
  setState(state: StateOf<M>): Promise<void>;
  /**
   * Resolves to the stored state, `anonymous` until the user chose. A storage failure resolves to `anonymous` too,
   * whatever the user chose, and goes to `onError`.
   */
  getState(): Promise<AnalyticsState>;
  /**
   * Sends what is queued now, or once the retry wait is over. A collector of `newWebCollector`, or of
   * `newExtensionCollector` in a page, calls it itself when the page is hidden.
   */
  flush(): Promise<void>;
  /**
   * Drops this id's queued events and asks the intake to delete the id's events, after this collector's request in
   * progress. For the last id, it also drops the events that wait for an id, and the next id counts as another user.
   * The collector stores the request until the intake answers it. The intake also deletes the user's events that arrive
   * within a minute after the forget, such as a request from another context.
   */
  forget(id: string): Promise<void>;
  /**
   * Resolves to the uninstall page's parameters. Resolves to undefined in the opted_out state, and when the storage
   * fails.
   */
  uninstallParams(): Promise<UninstallParams | undefined>;
}
