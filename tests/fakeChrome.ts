import { vi } from 'vitest';

const EXTENSION_ID = 'faalhcmobmdfdmmniiplhoniamdooejf';

type MessageListener = (message: unknown, sender: { id?: string }) => undefined;

/** A Chrome extension context in memory: storage, messages between contexts and the uninstall page. */
export class FakeChrome {
  readonly items = new Map<string, unknown>();
  readonly listeners = new Set<MessageListener>();
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
      removeListener: (listener: MessageListener): void => void this.listeners.delete(listener),
    },
  };
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
