import { detectBrowser } from './browser.js';
import { systemClock, type Clock } from './clock.js';
import { newCollector } from './collector.js';
import { Mode, type Collector, type CommonOptions, type Delivery, type ModeOptions } from './collectorTypes.js';
import { Platform, SYSTEM_EVENTS, type EventParams } from './envelope.js';
import { eventProblem } from './eventCheck.js';
import { reportTo } from './hostInput.js';
import type { StorageAdapter } from './storage.js';
import { newWebLock } from './web.js';

/** The message in each of the extension's `_locales` that holds that locale's code, such as `pt-BR`. */
const UI_LANGUAGE_MESSAGE = 'ui_language';
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
  /** An extension sends no page. */
  getPage?: never;
} & Delivery &
  ModeOptions;

/**
 * Returns a collector for an extension's worker or page. It needs the `storage` permission. In the worker it first
 * closes the storage to content scripts, which could otherwise change the user's choice and the queue. The product
 * builds it at the worker's top level, so the call runs at each worker start.
 */
export function newExtensionCollector(
  options: ExtensionCollectorOptions & { mode: typeof Mode.Identified },
): Collector<'identified'>;
export function newExtensionCollector(
  options: ExtensionCollectorOptions & { mode: typeof Mode.Anonymous },
): Collector<'anonymous'>;
export function newExtensionCollector(options: ExtensionCollectorOptions): Collector;
export function newExtensionCollector(options: ExtensionCollectorOptions): Collector {
  const closed = isServiceWorker() ? closeToContentScripts(options.onError) : Promise.resolve();
  const defaults = {
    platform: Platform.Extension,
    // The function reads each default only when the caller leaves the option out. A test's fake browser may lack the
    // manifest and `chrome.i18n`.
    version: options.version ?? chromeApi().runtime.getManifest().version,
    storage: after(closed, options.storage ?? newChromeStorageAdapter()),
    lock: options.lock ?? newWebLock(),
    browserLanguage: options.browserLanguage ?? navigator.language,
    uiLanguage: options.uiLanguage ?? localeOfExtension(),
  };
  return options.mode === Mode.Identified
    ? newCollector({ ...options, ...defaults, browser: options.browser ?? (() => detectBrowser(navigator)) })
    : newCollector({ ...options, ...defaults });
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
 * Returns the locale Chrome picked from the extension's `_locales`, which each locale names in its `ui_language`
 * message, or undefined when the extension has no such message. Chrome gives no other way to read that choice.
 */
function localeOfExtension(): string | undefined {
  const locale = chromeApi().i18n?.getMessage(UI_LANGUAGE_MESSAGE);
  return locale === undefined || locale === '' ? undefined : locale;
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

/**
 * Tracks the events content scripts forward with `forwardTrack`, at most 60 a minute. It takes them only from this
 * extension, and only the product's own events: never a system event of the intake, such as `installed` or
 * `uninstalled`, which a content script has no reason to send. Returns the function that stops it.
 */
export function acceptForwarded(collector: Collector, { clock = systemClock }: { clock?: Clock } = {}): () => void {
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
      tracked++;
      void collector.track(message.name, message.params);
    }
    return undefined;
  };
  chromeApi().runtime.onMessage.addListener(onMessage);
  return () => chromeApi().runtime.onMessage.removeListener(onMessage);
}

/**
 * Sets the uninstall page to `pageUrl` with the fields of `uninstallParams()` added to its query, or to `pageUrl` alone
 * when `uninstallParams()` resolves to undefined. Chrome keeps the address as it was set, so the service worker calls
 * this on each start and after each change of state. It resolves and never rejects. A failure of `uninstallParams()`
 * goes to the collector's `onError`, and any other failure to its own `onError`.
 */
export async function refreshUninstallUrl(
  collector: Collector,
  pageUrl: string,
  { onError }: { onError?: (error: Error) => void } = {},
): Promise<void> {
  try {
    const url = new URL(pageUrl);
    const params = await collector.uninstallParams();
    for (const [name, value] of Object.entries(params ?? {})) {
      url.searchParams.set(name, String(value));
    }
    await chromeApi().runtime.setUninstallURL(url.toString());
  } catch (error) {
    reportTo(onError, error);
  }
}

type MessageListener = (message: unknown, sender: { id?: string }) => undefined;

/** The slice of the `chrome` API these helpers call. The package carries no Chrome typings. */
interface ChromeApi {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      /** Chrome 102 and later have `setAccessLevel`. */
      setAccessLevel?: (options: { accessLevel: string }) => Promise<void>;
    };
  };
  /** Missing in a test's fake browser; a real extension context has it. */
  i18n?: { getMessage(name: string): string };
  runtime: {
    id: string;
    getManifest(): { version: string };
    sendMessage(message: unknown): Promise<unknown>;
    setUninstallURL(url: string): Promise<void>;
    onMessage: {
      addListener(listener: MessageListener): void;
      removeListener(listener: MessageListener): void;
    };
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
    eventProblem(name, Reflect.get(message, 'params')) === undefined
  );
}
