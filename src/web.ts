import { detectBrowser } from "./browser.js";
import { newCollector } from "./collector.js";
import {
  Mode,
  type Collector,
  type CommonOptions,
  type Delivery,
  type ModeOptions,
  type PageFields,
  type PageOptions,
} from "./collectorTypes.js";
import { PAGE_VIEW, Platform } from "./envelope.js";
import type { Lock } from "./lock.js";
import type { StorageAdapter } from "./storage.js";

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
 * `detectBrowser`. The site passes its own `uiLanguage`. A desktop window uses `newDesktopCollector`.
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
  return options.mode === Mode.Anonymous
    ? newCollector({ ...options, ...defaults })
    : newCollector({
        ...options,
        ...defaults,
        browser: options.browser ?? (() => detectBrowser(navigator)),
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
 * Sends `page_view` for the current page and after each navigation that changes `location.pathname`, and returns the
 * function that stops it. A query change alone sends none. Once every tracker stops, `history` is as they found it.
 */
export function trackPageViews(collector: Collector): () => void {
  let lastPath: string | undefined;
  const onNavigation = (): void => {
    // A navigation can reach the tracker twice, as a `pushState` and as a `currententrychange`.
    if (location.pathname === lastPath) {
      return;
    }
    lastPath = location.pathname;
    void collector.track(PAGE_VIEW);
  };
  const unwrapPushState = callAfter("pushState", onNavigation);
  const unwrapReplaceState = callAfter("replaceState", onNavigation);
  window.addEventListener("popstate", onNavigation);
  const navigation = navigationApi();
  navigation?.addEventListener("currententrychange", onNavigation);
  onNavigation();
  return () => {
    unwrapPushState();
    unwrapReplaceState();
    window.removeEventListener("popstate", onNavigation);
    navigation?.removeEventListener("currententrychange", onNavigation);
  };
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
