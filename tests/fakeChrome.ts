import { vi } from 'vitest';
import { newExtensionCollector } from '../src/extension.js';
import { newHttpTransport, newMemoryStorage, type Collector, type StorageAdapter } from '../src/exports.js';
import { FakeClock } from './fakeClock.js';
import { FakeFetch } from './fakeFetch.js';
import { ENDPOINT, KEY, RETRY_DELAY_MS, SEND_DELAY_MS } from './harness.js';

const EXTENSION_ID = 'faalhcmobmdfdmmniiplhoniamdooejf';

type MessageListener = (message: unknown, sender: { id?: string }) => undefined;
type InstalledListener = (details: { reason: string }) => void;

/** A Chrome extension context in memory: storage, messages between contexts and the uninstall page. */
export class FakeChrome {
  readonly items = new Map<string, unknown>();
  readonly listeners = new Set<MessageListener>();
  readonly installedListeners = new Set<InstalledListener>();
  readonly startupListeners = new Set<() => void>();
  uninstallUrl = '';
  isWorkerGone = false;
  /** The access levels `chrome.storage.local.setAccessLevel` was called with. */
  readonly accessLevels: unknown[] = [];

  readonly storage = {
    local: {
      get: async (key: string): Promise<Record<string, unknown>> =>
        this.items.has(key) ? { [key]: this.items.get(key) } : {},
      set: async (items: Record<string, unknown>): Promise<void> => {
        for (const [key, value] of Object.entries(items)) {
          this.items.set(key, value);
        }
      },
      setAccessLevel: async (options: unknown): Promise<void> => {
        this.accessLevels.push(options);
      },
    },
  };

  readonly runtime = {
    id: EXTENSION_ID,
    getManifest: (): { version: string } => ({ version: '3.1.0' }),
    sendMessage: async (message: unknown, sender: { id?: string } = { id: EXTENSION_ID }): Promise<unknown> => {
      if (this.isWorkerGone) {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      for (const listener of this.listeners) {
        listener(message, sender);
      }
      return undefined;
    },
    setUninstallURL: async (url: string): Promise<void> => {
      this.uninstallUrl = url;
    },
    onMessage: {
      addListener: (listener: MessageListener): void => void this.listeners.add(listener),
    },
    onInstalled: {
      addListener: (listener: InstalledListener): void => void this.installedListeners.add(listener),
    },
    onStartup: {
      addListener: (listener: () => void): void => void this.startupListeners.add(listener),
    },
  };

  /** Fires `chrome.runtime.onInstalled`, as Chrome does after an install or an update. */
  install(reason: 'install' | 'update' | 'chrome_update'): void {
    for (const listener of this.installedListeners) {
      listener({ reason });
    }
  }
}

/** Puts a fresh `FakeChrome` in place of the global `chrome`. */
export function stubChrome(): FakeChrome {
  const chrome = new FakeChrome();
  vi.stubGlobal('chrome', chrome);
  return chrome;
}

/** Makes the global scope read as an extension's service worker, as `self instanceof ServiceWorkerGlobalScope` does. */
export function stubServiceWorker(): void {
  const scope = (): undefined => undefined;
  Object.defineProperty(scope, Symbol.hasInstance, { value: () => true });
  vi.stubGlobal('ServiceWorkerGlobalScope', scope);
}

/** An extension collector over fakes, with the fake Chrome, network and clock it uses. */
export interface ExtensionHarness {
  collector: Collector;
  chrome: FakeChrome;
  fetch: FakeFetch;
  clock: FakeClock;
  errors: Error[];
  /** Advances the clock past the send delay and the first retry delay, so each queued send runs. */
  settle: () => Promise<void>;
}

/**
 * Builds `newExtensionCollector` in the service worker when `isWorker` is set, and in an extension page otherwise, over
 * a fake Chrome, a memory storage, a fake network and a fake clock.
 */
export function newExtensionHarness({
  isWorker,
  uninstallPage,
  version,
  storage = newMemoryStorage(),
}: {
  isWorker: boolean;
  uninstallPage?: string;
  /** The product version, the fake manifest's `3.1.0` by default. */
  version?: string;
  storage?: StorageAdapter;
}): ExtensionHarness {
  if (isWorker) {
    stubServiceWorker();
  }
  const chrome = stubChrome();
  vi.stubGlobal('navigator', { language: 'pt-BR' });
  const fetch = new FakeFetch();
  const clock = new FakeClock('2026-10-29T10:00:00');
  const errors: Error[] = [];
  const collector = newExtensionCollector({
    key: KEY,
    mode: 'anonymous',
    storage,
    clock,
    transport: newHttpTransport(ENDPOINT, { fetch: fetch.fetch, clock }),
    onError: (error) => errors.push(error),
    ...(uninstallPage !== undefined && { uninstallPage }),
    ...(version !== undefined && { version }),
  });
  return { collector, chrome, fetch, clock, errors, settle: () => clock.advance(SEND_DELAY_MS + RETRY_DELAY_MS) };
}
