import type { Collector } from './collectorTypes.js';

/**
 * Sends the collector's queue when the page is hidden, at `visibilitychange` to hidden or at `pagehide`, since the user
 * may not come back. A request that started before the tab closes still finishes, and a send not started by then waits
 * for the next visit. Does nothing where there is no `document`, as in a worker. Returns the collector.
 */
export function flushOnHide<C extends Collector>(collector: C): C {
  if (typeof document === 'undefined') {
    return collector;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void collector.flush();
    }
  });
  window.addEventListener('pagehide', () => void collector.flush());
  return collector;
}
