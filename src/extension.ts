import { detectBrowser } from './browser.js';
import { systemClock, type Clock } from './clock.js';
import { newCollectorNotingDays, sendDelayMsOf } from './collector.js';
import {
  AnalyticsState,
  Mode,
  type Collector,
  type CommonOptions,
  type Delivery,
  type ModeOptions,
  type UninstallParams,
} from './collectorTypes.js';
import { Platform, SYSTEM_EVENTS, type EventParams } from './envelope.js';
import { checkEvent } from './eventCheck.js';
import { quoted, reportTo } from './hostInput.js';
import { parseQueue, QUEUE_KEY, type QueuedEnvelope } from './queue.js';
import type { StorageAdapter } from './storage.js';
import { newWebLock } from './web.js';

const FORWARD_TYPE = 'artel.track';
/**
 * The event names the worker refuses from a content script: every system event, which the intake counts from any page
 * without the product's allowlist.
 */
const REFUSED_NAMES: ReadonlySet<string> = new Set(SYSTEM_EVENTS);
/**
 * The forwarded events the worker tracks in a minute from every tab and frame together. A page can open any number of
 * frames that run the content script, so only a limit in the worker bounds how fast a page can fill the queue and push
 * out what waits in it.
 */
const FORWARDS_PER_MINUTE = 60;
const MINUTE_MS = 60_000;

/**
 * The options of `newExtensionCollector`: those of `newCollector` without `platform`, with `storage` and `version`
 * optional. An option left out or `undefined` takes its default.
 */
export type ExtensionCollectorOptions = Omit<CommonOptions, 'storage' | 'version'> & {
  /** The storage, `chrome.storage.local` by default. */
  storage?: StorageAdapter | undefined;
  /** The product version, the manifest's by default. */
  version?: string | undefined;
  /**
   * The address of the page Chrome opens when the user removes the extension. The collector sets it with the fields of
   * `uninstallParams()` in its query at construction, after each `setState` and after the first event of a local day.
   * Left out, the collector sets none.
   */
  uninstallPage?: string | undefined;
  /** An extension sends no page. */
  getPage?: never;
} & Delivery &
  ModeOptions;

/**
 * Returns a collector for an extension's worker or page. It needs the `storage` permission. In the worker it first
 * closes the storage to content scripts, which could otherwise change the user's analytics state and the queue. The
 * worker's collector also sends `installed` and `updated` at Chrome's `onInstalled`, and tracks the events content
 * scripts forward. Chrome needs these listeners registered synchronously at the worker's top level on every start of
 * the worker, so the product builds it there. The worker's collector also sends what the pages queue, even after the
 * page closed.
 */
export function newExtensionCollector<M extends Mode>(options: ExtensionCollectorOptions & { mode: M }): Collector<M>;
export function newExtensionCollector(options: ExtensionCollectorOptions): Collector {
  const isWorker = isServiceWorker();
  const closed = isWorker ? closeToContentScripts(options.onError) : Promise.resolve();
  const defaults = {
    platform: Platform.Extension,
    // The function reads each default only when the caller leaves the option out, so outside an extension it needs only
    // `version`.
    version: options.version ?? chromeApi().runtime.getManifest().version,
    storage: after(closed, options.storage ?? newChromeStorageAdapter()),
    lock: options.lock ?? newWebLock(),
    browserLanguage: options.browserLanguage ?? navigator.language,
  };
  // The first event of a day changes the uninstall page's fields. The collector queues no event before it is built.
  let refreshUninstallPage = (): void => undefined;
  const onNewDay = (): void => refreshUninstallPage();
  const built =
    options.mode === Mode.Anonymous
      ? newCollectorNotingDays({ ...options, ...defaults }, onNewDay)
      : newCollectorNotingDays(
          { ...options, ...defaults, browser: options.browser ?? (() => detectBrowser(navigator)) },
          onNewDay,
        );
  const { collector, refresh } = withUninstallPage(built, options.uninstallPage, options.onError);
  refreshUninstallPage = () => void refresh();
  if (isWorker) {
    listenAsWorker(collector, {
      queueKey: `artel.${options.key}.${QUEUE_KEY}`,
      sendDelayMs: sendDelayMsOf(options),
      clock: options.clock ?? systemClock,
      onError: options.onError,
    });
  }
  return collector;
}

/**
 * Registers the worker's listeners: `installed` and `updated` at `onInstalled`, the events content scripts forward, the
 * events pages queue, and an empty `onStartup` listener. Chrome starts a worker with an `onStartup` listener when the
 * browser starts, so the access level is set again before any page or content script runs.
 */
function listenAsWorker(
  collector: Collector,
  {
    queueKey,
    sendDelayMs,
    clock,
    onError,
  }: {
    /** The storage key of this channel's queue. */
    queueKey: string;
    sendDelayMs: number;
    clock: Clock;
    onError: ((error: Error) => void) | undefined;
  },
): void {
  const { runtime, storage } = chromeApi();
  // A page's own send cannot finish once the page closes, as when a popup closes right after an event. The worker
  // sends what pages queue within the send delay. Its own sends add no event to the queue, so they schedule nothing.
  let isSendScheduled = false;
  storage.onChanged.addListener((changes, area) => {
    const change = changes[queueKey];
    if (area !== 'local' || change === undefined || isSendScheduled || !addsEvents(change)) {
      return;
    }
    isSendScheduled = true;
    clock.setTimeout(() => {
      isSendScheduled = false;
      void collector.flush();
    }, sendDelayMs);
  });
  runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') {
      void collector.installed();
    } else if (reason === 'update') {
      void collector.updated();
    }
  });
  runtime.onStartup.addListener(() => undefined);
  acceptForwarded(collector, clock, onError);
}

/**
 * Returns the collector, which sets the uninstall page now and after each `setState` when `pageUrl` is given, and
 * `refresh`, which sets it again. Chrome keeps the address as it was set, so the query must follow the user's state
 * and the active days.
 */
function withUninstallPage(
  collector: Collector,
  pageUrl: string | undefined,
  onError: ((error: Error) => void) | undefined,
): { collector: Collector; refresh: () => Promise<void> } {
  if (pageUrl === undefined) {
    return { collector, refresh: async () => undefined };
  }
  // Every write of this context goes in turn on one chain. A write that started before the latest `setState` is
  // dropped, so a slow refresh never puts back the fields of a state the user has left.
  let writes = Promise.resolve();
  let changes = 0;
  const write = (params: () => Promise<UninstallParams | undefined>): Promise<void> => {
    const startedAt = changes;
    const earlier = writes;
    writes = (async () => {
      await earlier;
      const fields = await params();
      if (startedAt === changes) {
        await setUninstallUrl(pageUrl, fields, onError);
      }
    })();
    return writes;
  };
  const refresh = (): Promise<void> => write(() => collector.uninstallParams());
  void refresh();
  return {
    collector: {
      ...collector,
      setState: async (state) => {
        changes++;
        if (state === AnalyticsState.OptedOut || state === AnalyticsState.Anonymous) {
          // A change of state can take 30 seconds or more, as for the opted_out or forget request it sends, and the
          // page must not carry the earlier state's fields meanwhile. The page alone carries fewer than any state's.
          await write(async () => undefined);
        }
        await collector.setState(state);
        await refresh();
      },
    },
    refresh,
  };
}

/** Tells whether a change of the stored queue adds an event to it, as a new envelope or one more event of an envelope. */
function addsEvents({ oldValue, newValue }: { oldValue?: unknown; newValue?: unknown }): boolean {
  const queueOf = (value: unknown): QueuedEnvelope[] => parseQueue(typeof value === 'string' ? value : undefined) ?? [];
  const before = new Map(queueOf(oldValue).map(({ qid, envelope }) => [qid, envelope.events.length]));
  return queueOf(newValue).some(({ qid, envelope }) => envelope.events.length > (before.get(qid) ?? 0));
}

/** Tells whether the caller runs in the extension's service worker, the one context that may set the access level. */
function isServiceWorker(): boolean {
  const scope: unknown = Reflect.get(globalThis, 'ServiceWorkerGlobalScope');
  return typeof scope === 'function' && globalThis instanceof scope;
}

/**
 * Lets only the extension's own pages and worker read and write `chrome.storage.local`, and resolves once Chrome has
 * answered. It never rejects. A failure, such as a Chrome without the call, goes to `onError`.
 */
async function closeToContentScripts(onError: ((error: Error) => void) | undefined): Promise<void> {
  try {
    const local = chromeApi().storage.local;
    if (typeof local.setAccessLevel !== 'function') {
      throw new TypeError('artel: chrome.storage.local.setAccessLevel is missing, so content scripts can write it');
    }
    await local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (error) {
    reportTo(onError, error);
  }
}

/** Returns `storage` whose every read and write waits for `ready` first. */
function after(ready: Promise<void>, storage: StorageAdapter): StorageAdapter {
  return {
    get: async (key) => {
      await ready;
      return storage.get(key);
    },
    set: async (key, value) => {
      await ready;
      await storage.set(key, value);
    },
  };
}

/**
 * Returns a storage adapter over `chrome.storage.local`, which the service worker and the extension pages share. It
 * needs the `storage` permission.
 */
export function newChromeStorageAdapter(): StorageAdapter {
  return {
    get: async (key) => {
      const value = (await chromeApi().storage.local.get(key))[key];
      return typeof value === 'string' ? value : undefined;
    },
    set: async (key, value) => {
      await chromeApi().storage.local.set({ [key]: value });
    },
  };
}

/**
 * Hands an event from a content script to the service worker, whose collector tracks it. The intake refuses a content
 * script's own requests, which carry the page's origin.
 */
export async function forwardTrack(name: string, params?: EventParams): Promise<void> {
  try {
    await chromeApi().runtime.sendMessage({ type: FORWARD_TYPE, name, ...(params !== undefined && { params }) });
  } catch {
    // The send fails while the service worker updates or is gone. The content script drops the event and does not fail.
  }
}

/** The part of the collector a content script uses: it tracks events, and the worker keeps the analytics state. */
export type ContentScriptCollector = Pick<Collector, 'track'>;

/**
 * Returns the collector of a content script. Its `track` hands each event to the service worker with `forwardTrack`,
 * and the worker's collector checks, queues and sends it under the user's analytics state. The state lives in the
 * worker and the extension pages, so a content script can neither read nor change it. It reads no storage, needs no
 * key, version or endpoint, and never throws.
 */
export function newContentScriptCollector(): ContentScriptCollector {
  return { track: forwardTrack };
}

/**
 * Tracks the events content scripts forward with `forwardTrack`, at most 60 a minute. It takes them only from this
 * extension, and only the product's own events: never a system event of the intake, such as `installed` or
 * `uninstalled`, which a content script has no reason to send. The limit guards the queue against a flood, and the
 * first event it drops in a minute goes to `onError`, so the drop is not silent.
 */
function acceptForwarded(collector: Collector, clock: Clock, onError: ((error: Error) => void) | undefined): void {
  let minuteStart = Number.NEGATIVE_INFINITY;
  let tracked = 0;
  const onMessage: MessageListener = (message, sender) => {
    if (sender.id !== chromeApi().runtime.id || !isForwarded(message)) {
      return undefined;
    }
    const now = clock.now();
    // A clock set back by a minute or more starts a new window too, so forwarding never stops until it catches up.
    if (Math.abs(now - minuteStart) >= MINUTE_MS) {
      minuteStart = now;
      tracked = 0;
    }
    if (tracked < FORWARDS_PER_MINUTE) {
      void collector.track(message.name, message.params);
    } else if (tracked === FORWARDS_PER_MINUTE) {
      reportTo(
        onError,
        new Error(
          `artel: the worker tracks at most ${FORWARDS_PER_MINUTE} forwarded events a minute, so it dropped the rest`,
        ),
      );
    }
    tracked++;
    return undefined;
  };
  chromeApi().runtime.onMessage.addListener(onMessage);
}

/**
 * Sets the uninstall page to `pageUrl` with `params` added to its query, or to `pageUrl` alone without them. It
 * resolves and never rejects: a failure, such as a `pageUrl` that is not a URL, goes to `onError`.
 */
async function setUninstallUrl(
  pageUrl: string,
  params: UninstallParams | undefined,
  onError: ((error: Error) => void) | undefined,
): Promise<void> {
  if (!URL.canParse(pageUrl)) {
    reportTo(onError, new TypeError(`artel: uninstallPage is not a URL: ${quoted(pageUrl)}`));
    return;
  }
  try {
    await chromeApi().runtime.setUninstallURL(withQueryAdded(pageUrl, params));
  } catch (error) {
    reportTo(onError, error);
  }
}

/**
 * Returns `pageUrl` with `params` added at the end of its query, before any fragment. The page's own query stays as
 * written, since a page may read it in a form that `URLSearchParams` would write another way.
 */
function withQueryAdded(pageUrl: string, params: UninstallParams | undefined): string {
  const query = new URLSearchParams(
    Object.entries(params ?? {}).map(([name, value]) => [name, String(value)]),
  ).toString();
  if (query === '') {
    return pageUrl;
  }
  const hashAt = pageUrl.indexOf('#');
  const beforeFragment = hashAt === -1 ? pageUrl : pageUrl.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : pageUrl.slice(hashAt);
  return `${beforeFragment}${joinerAfter(beforeFragment)}${query}${fragment}`;
}

/** Returns what goes between `address` and an added query: `?`, `&`, or nothing after a `?` or `&` it ends in. */
function joinerAfter(address: string): string {
  if (!address.includes('?')) {
    return '?';
  }
  return address.endsWith('?') || address.endsWith('&') ? '' : '&';
}

type MessageListener = (message: unknown, sender: { id?: string }) => undefined;

/** The slice of the `chrome` API these helpers call. The package carries no Chrome typings. */
interface ChromeApi {
  storage: {
    onChanged: {
      addListener(
        listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void,
      ): void;
    };
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      /** Chrome 102 and later have `setAccessLevel`. */
      setAccessLevel?: (options: { accessLevel: string }) => Promise<void>;
    };
  };
  runtime: {
    id: string;
    getManifest(): { version: string };
    sendMessage(message: unknown): Promise<unknown>;
    setUninstallURL(url: string): Promise<void>;
    onMessage: { addListener(listener: MessageListener): void };
    onInstalled: { addListener(listener: (details: { reason: string }) => void): void };
    onStartup: { addListener(listener: () => void): void };
  };
}

/** Returns the global `chrome` API, or throws outside an extension context. */
function chromeApi(): ChromeApi {
  const chrome: unknown = Reflect.get(globalThis, 'chrome');
  if (!isChromeApi(chrome)) {
    throw new Error('artel: the chrome extension API is not available here');
  }
  return chrome;
}

/** Checks only that the extension runtime is there. A missing `storage` permission surfaces when storage is used. */
function isChromeApi(value: unknown): value is ChromeApi {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'runtime') === 'object';
}

/**
 * Checks a forwarded message against what the intake takes, as `track` does, and refuses the names in
 * `REFUSED_NAMES`. Content scripts run among the page's scripts, so the worker cannot trust what they send.
 */
function isForwarded(message: unknown): message is { name: string; params?: EventParams } {
  if (typeof message !== 'object' || message === null || Reflect.get(message, 'type') !== FORWARD_TYPE) {
    return false;
  }
  const name: unknown = Reflect.get(message, 'name');
  return (
    typeof name === 'string' &&
    !REFUSED_NAMES.has(name) &&
    checkEvent(name, Reflect.get(message, 'params')) === undefined
  );
}
