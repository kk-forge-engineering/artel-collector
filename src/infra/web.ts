import { detectBrowser } from "../shared/browser.js";
import { newCollector } from "./systemCollector.js";
import {
  Mode,
  type Collector,
  type CommonOptions,
  type Delivery,
  type ModeOptions,
  type PageFields,
  type PageOptions,
} from "../shared/collectorTypes.js";
import { PAGE_VIEW, Platform } from "../shared/envelope.js";
import { currentPage } from "../shared/page.js";
import type { Lock } from "../shared/lock.js";
import type { StorageAdapter } from "../shared/storage.js";

/**
 * The options of `newWebCollector`: those of `newCollector` without `platform`, with `storage` optional. An option left
 * out or `undefined` takes its default.
 */
export type WebCollectorOptions = Omit<CommonOptions, "storage"> & {
  storage?: StorageAdapter | undefined;
} & PageOptions &
  Delivery &
  ModeOptions;

/**
 * Returns a collector for a website or a web app. It runs over `localStorage` and Web Locks, and sends the user's
 * language from `navigator.language`, the page from `pageFields` and, in a state with an id, the browser from
 * `detectBrowser`. It sends what is queued each time the page turns hidden, as `flushWhenHidden` describes. The site
 * passes its own `uiLanguage`. A desktop window uses `newDesktopCollector`.
 */
export function newWebCollector<M extends Mode>(
  options: WebCollectorOptions & { mode: M },
): Collector<M>;
export function newWebCollector(options: WebCollectorOptions): Collector {
  const defaults = {
    platform: Platform.Web,
    storage: options.storage ?? newLocalStorageAdapter(),
    lock: options.lock ?? newWebLock(),
    browserLanguage: options.browserLanguage ?? navigator.language,
    getPage: options.getPage ?? pageFieldsWherePageIs,
  };
  const collector =
    options.mode === Mode.Anonymous
      ? newCollector({ ...options, ...defaults })
      : newCollector({
          ...options,
          ...defaults,
          browser: options.browser ?? (() => detectBrowser(navigator)),
        });
  flushWhenHidden(collector);
  return collector;
}

/**
 * Flushes `collector` each time the document turns hidden, as when the user switches to another tab or app or
 * minimizes the window. The page lives on then, so the send ends, and a mobile browser that freezes a hidden page soon
 * after finds the queue sent. A page that closes or navigates away gets no further than the lock, so its events wait
 * for the next visit. A Web Worker has no document, so the function does nothing there.
 */
export function flushWhenHidden(collector: Collector): void {
  if (typeof document === "undefined") {
    return;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void collector.flush();
    }
  });
}

/**
 * Returns a storage adapter over `localStorage`, which every tab of the origin shares. A Web Worker has no
 * `localStorage`, so a collector there passes its own storage.
 */
export function newLocalStorageAdapter(): StorageAdapter {
  return {
    get: async (key) => localStorage.getItem(key) ?? undefined,
    set: async (key, value) => {
      localStorage.setItem(key, value);
    },
  };
}

/**
 * Returns a lock that uses Web Locks over the origin, so that its tabs and workers run one collector operation at a
 * time. Where a browser lacks Web Locks, the operation runs unguarded.
 */
export function newWebLock(): Lock {
  return (operation) => {
    // A test DOM such as happy-dom sets `navigator.locks` to null, so the check asks for the method itself.
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    return typeof locks?.request === "function" ? locks.request("artel", operation) : operation();
  };
}

/**
 * Returns the page's address without query and fragment, and the raw referrer. The collector sends only the path and
 * the referrer's host. A site with a secret or a personal ID in its paths, such as `/share/<token>`, passes its own
 * `getPage` that returns the route pattern instead.
 */
export function pageFields(): PageFields {
  return {
    page: `${location.protocol}//${location.host}${location.pathname}`,
    referrer: document.referrer,
  };
}

/** Returns `pageFields`, or undefined in a Web Worker, which has no page. */
function pageFieldsWherePageIs(): PageFields | undefined {
  return typeof document === "undefined" || typeof location === "undefined"
    ? undefined
    : pageFields();
}

/**
 * Sends `page_view` for the current page and after each navigation to another page, and returns the function that
 * stops it. The page is the one the collector would send, as its `getPage` gives it: with the default `getPage` the
 * path, so a change of the query or the hash alone sends none, and with a `getPage` that reads a route from the hash, the
 * route. Where the collector reads no page, as on another platform than web, or `getPage` gives none, the page is
 * `location.pathname`. Once every tracker stops, `history` is as they found it.
 */
export function trackPageViews(collector: Collector): () => void {
  const onNavigation = (): void => {
    // One navigation can reach the tracker up to three times: as a `pushState` and a `currententrychange`, or as a
    // `popstate`, a `hashchange` and a `currententrychange`. All of them find the same page.
    if (pageNow(collector) !== trackedPages.get(collector)) {
      void trackPageView(collector);
    }
  };
  const unwrapPushState = callAfter("pushState", onNavigation);
  const unwrapReplaceState = callAfter("replaceState", onNavigation);
  // By the HTML standard, a browser reports a change of the hash as a `popstate` and then a `hashchange`. The tracker
  // listens to `hashchange` as well, so a change still counts in a browser that skips the `popstate`.
  window.addEventListener("popstate", onNavigation);
  window.addEventListener("hashchange", onNavigation);
  const navigation = navigationApi();
  navigation?.addEventListener("currententrychange", onNavigation);
  // The page it starts on counts even when an earlier tracker of the collector counted it, as one stopped and started
  // again after the user left `opted_out`. The collector drops it if its last recorded `page_view` sent that page.
  void trackPageView(collector);
  return () => {
    unwrapPushState();
    unwrapReplaceState();
    window.removeEventListener("popstate", onNavigation);
    window.removeEventListener("hashchange", onNavigation);
    navigation?.removeEventListener("currententrychange", onNavigation);
  };
}

/**
 * Sends `page_view` for the page `getPage` gives now, unless the last recorded `page_view` sent that page. A router
 * that changes the screen without changing the address calls it after each change, with a `getPage` that reads the
 * screen. It resolves once the collector has queued or dropped the event, and never rejects.
 */
export function trackPageView(collector: Collector): Promise<void> {
  trackedPages.set(collector, pageNow(collector));
  return collector.track(PAGE_VIEW);
}

/**
 * The page of the last `page_view` each collector was asked for, whether or not it recorded one. The trackers of a
 * collector and its calls of `trackPageView` share it, so a navigation back to a page after a call counts.
 */
const trackedPages = new WeakMap<Collector, string | undefined>();

/**
 * Returns the page a `page_view` of `collector` would send now, or `location.pathname` where it reads none, or
 * undefined where there is no `location`.
 */
function pageNow(collector: Collector): string | undefined {
  return (
    currentPage(collector) ?? (typeof location === "undefined" ? undefined : location.pathname)
  );
}

/** What `callAfter` keeps of one wrapper it installed. */
interface Wrapping {
  /** The method the wrapper calls, which `history` held before it. */
  found: History["pushState"];
  /** Whether `history` held `found` as its own property, rather than inheriting it from `History.prototype`. */
  wasOwn: boolean;
  /** Whether the wrapper still calls its listener. A stopped wrapper only passes the call on. */
  isActive: boolean;
}

/** The wrappers `callAfter` installed, by the wrapper function. */
const wrappings = new WeakMap<object, Wrapping>();

/**
 * Wraps a history method so `listener` runs after each call, and returns the undo. The undo removes stopped wrappers
 * from the top down, so trackers that stop in any order leave `history` as they found it. A stopped wrapper under an
 * active one or under a product's own wrapper stays and passes calls on.
 */
function callAfter(method: "pushState" | "replaceState", listener: () => void): () => void {
  const wrapping: Wrapping = {
    found: history[method],
    wasOwn: Object.hasOwn(history, method),
    isActive: true,
  };
  const wrapper: History["pushState"] = function (this: History, ...args) {
    wrapping.found.apply(this, args);
    if (wrapping.isActive) {
      listener();
    }
  };
  wrappings.set(wrapper, wrapping);
  history[method] = wrapper;
  return () => {
    wrapping.isActive = false;
    for (
      let top = wrappings.get(history[method]);
      top?.isActive === false;
      top = wrappings.get(history[method])
    ) {
      if (top.wasOwn) {
        history[method] = top.found;
      } else {
        Reflect.deleteProperty(history, method);
      }
    }
  };
}

/** Returns the Navigation API, or undefined where the browser lacks it. */
function navigationApi(): EventTarget | undefined {
  const navigation: unknown = Reflect.get(globalThis, "navigation");
  return navigation instanceof EventTarget ? navigation : undefined;
}
