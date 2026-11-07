import type { Collector, PageFields } from './collector.js';
import type { Lock } from './lock.js';
import type { StorageAdapter } from './storage.js';

export function newLocalStorageAdapter(): StorageAdapter {
  return {
    get: async (key) => localStorage.getItem(key) ?? undefined,
    set: async (key, value) => {
      localStorage.setItem(key, value);
    },
  };
}

/**
 * Returns a lock that uses Web Locks over the origin, so that its tabs and workers do not send one queued envelope at
 * the same time. Where a browser lacks Web Locks, the operation runs unguarded.
 */
export function newWebLock(): Lock {
  return (operation) => {
    // A test DOM such as happy-dom sets `navigator.locks` to null, so the check asks for the method itself.
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return typeof locks?.request === 'function' ? locks.request('artel', operation) : operation();
  };
}

/**
 * Returns the current page's path without the query string, and the referring host only when it is another site. A site
 * whose paths carry a secret or a person, such as `/share/<token>`, passes its own `getPage` with the route pattern
 * instead.
 */
export function pageFields(): PageFields {
  const referrer = referrerHost(document.referrer);
  return { page: location.pathname, ...(referrer !== undefined && referrer !== location.hostname && { referrer }) };
}

/**
 * Flushes the queue when the page is hidden, since the user may not return. The collector's fetch uses `keepalive`, so
 * a send started before the tab closes still finishes. A send not yet started waits for the next visit. Returns the
 * function that removes the listener.
 */
export function flushWhenHidden(collector: Collector): () => void {
  const onChange = (): void => {
    if (document.visibilityState === 'hidden') {
      void collector.flush();
    }
  };
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function referrerHost(referrer: string): string | undefined {
  try {
    return referrer === '' ? undefined : new URL(referrer).hostname;
  } catch {
    return undefined;
  }
}
