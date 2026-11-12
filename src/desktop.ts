import { newCollector } from "./collector.js";
import type { Collector, CommonOptions, Delivery, Mode, ModeOptions } from "./collectorTypes.js";
import type { Platform } from "./envelope.js";
import type { StorageAdapter } from "./storage.js";
import { newLocalStorageAdapter, newWebLock } from "./web.js";

/**
 * The options of `newDesktopCollector`: those of `newCollector` with `storage` optional and a desktop `platform`. An
 * option left out or `undefined` takes its default.
 */
export type DesktopCollectorOptions = Omit<CommonOptions, "storage"> & {
  /** The operating system the app runs on, as the intake names it. */
  platform: typeof Platform.MacOs | typeof Platform.Windows | typeof Platform.Linux;
  /** The storage, the webview's `localStorage` by default. */
  storage?: StorageAdapter | undefined;
  /** A desktop product names no browser. */
  browser?: never;
  /** A desktop product sends no page. */
  getPage?: never;
} & Delivery &
  ModeOptions;

/**
 * Returns a collector for a window of a desktop app, such as a Tauri webview. Its windows share the webview's
 * `localStorage` and Web Locks, so they keep one queue and one state. It sends the user's language from
 * `navigator.language`. The app passes its own `uiLanguage`. It sends `installed` and `updated` itself when they are
 * due.
 */
export function newDesktopCollector<M extends Mode>(
  options: DesktopCollectorOptions & { mode: M },
): Collector<M>;
export function newDesktopCollector(options: DesktopCollectorOptions): Collector {
  const collector = newCollector({
    ...options,
    storage: options.storage ?? newLocalStorageAdapter(),
    lock: options.lock ?? newWebLock(),
    browserLanguage: options.browserLanguage ?? navigator.language,
  });
  // A desktop app has no install event, so each start marks the install and the version. Both send once under the
  // lock, so every window may build a collector. The collector runs its calls in this order.
  void collector.installed();
  void collector.updated();
  return collector;
}
