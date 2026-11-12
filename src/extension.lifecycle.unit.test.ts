import { describe, expect, it, vi } from 'vitest';
import { AnalyticsState, Mode, newHttpTransport, newMemoryStorage, type GetId, type Transport } from './exports.js';
import { newExtensionCollector } from './extension.js';
import { newExtensionHarness, stubChrome, stubServiceWorker, type FakeChrome } from '../tests/fakeChrome.js';
import { FakeFetch } from '../tests/fakeFetch.js';
import { FakeClock } from '../tests/fakeClock.js';
import { ENDPOINT, KEY, SEND_DELAY_MS } from '../tests/harness.js';

const UNINSTALL_PAGE = 'https://example.com/uninstall?product=demo';

describe('the service worker collector', () => {
  it('sends installed when Chrome installs the extension, and updated when Chrome updates it to a new version', async () => {
    const storage = newMemoryStorage();
    const installed = newExtensionHarness({ isWorker: true, storage });
    installed.chrome.install('install');
    await installed.settle();

    const updated = newExtensionHarness({ isWorker: true, storage, version: '3.2.0' });
    updated.chrome.install('update');
    await updated.settle();

    expect(installed.fetch.eventNames).toEqual(['installed']);
    expect(updated.fetch.eventNames).toEqual(['updated']);
  });

  it('sends nothing for an update of Chrome itself', async () => {
    const { chrome, fetch, settle } = newExtensionHarness({ isWorker: true });

    chrome.install('chrome_update');
    await settle();

    expect(fetch.requests).toEqual([]);
  });

  it('listens to onStartup, so Chrome starts the worker with the browser, and does nothing more there', async () => {
    const { chrome, fetch, errors, settle } = newExtensionHarness({ isWorker: true });

    for (const listener of chrome.startupListeners) {
      listener();
    }
    await settle();

    expect([chrome.startupListeners.size, fetch.requests, errors]).toEqual([1, [], []]);
  });
});

describe('the events an extension page queues', () => {
  /**
   * Builds the worker's and a page's collector over one fake Chrome, each with its own network and clock. With `getId`
   * both are of an identified channel, and the user is identified.
   */
  function newWorkerAndPage(getId?: GetId): {
    page: ReturnType<typeof newExtensionCollector>;
    worker: { fetch: FakeFetch; clock: FakeClock };
    pageFetch: FakeFetch;
    chrome: FakeChrome;
  } {
    const chrome = stubChrome();
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    const mode = getId === undefined ? ({ mode: 'anonymous' } as const) : ({ mode: 'identified', getId } as const);
    if (getId !== undefined) {
      chrome.items.set(`artel.${KEY}.state`, AnalyticsState.Identified);
    }
    const newContext = (): { fetch: FakeFetch; clock: FakeClock; transport: Transport } => {
      const fetch = new FakeFetch();
      const clock = new FakeClock('2026-10-29T10:00:00');
      return { fetch, clock, transport: newHttpTransport(ENDPOINT, { fetch: fetch.fetch, clock }) };
    };
    const worker = newContext();
    stubServiceWorker();
    newExtensionCollector({ key: KEY, ...mode, clock: worker.clock, transport: worker.transport });
    vi.stubGlobal('ServiceWorkerGlobalScope', undefined);
    // The page's clock never moves, so the page never sends itself, as a popup closed right after an event.
    const pageContext = newContext();
    const page = newExtensionCollector({
      key: KEY,
      ...mode,
      clock: pageContext.clock,
      transport: pageContext.transport,
    });
    return { page, worker, pageFetch: pageContext.fetch, chrome };
  }

  it('go through the worker within the send delay, though the page sends nothing', async () => {
    const { page, worker, pageFetch } = newWorkerAndPage();

    await page.track('popup_opened');
    await worker.clock.advance(SEND_DELAY_MS);

    expect([worker.fetch.eventNames, pageFetch.requests]).toEqual([['popup_opened'], []]);
  });

  it('schedule no send for a change in another area, or for a stored queue that is no list of envelopes', async () => {
    const { worker, chrome } = newWorkerAndPage();
    const queueKey = `artel.${KEY}.queue`;
    const queued = JSON.stringify([{ qid: 'a', envelope: { events: [{ name: 'a', day: '2026-10-29' }] } }]);
    let flushes = 0;
    chrome.storage.local.get = async (key) => {
      flushes += key === queueKey ? 1 : 0;
      return {};
    };

    for (const listener of chrome.changeListeners) {
      listener({ [queueKey]: { newValue: queued } }, 'sync');
      listener({ [queueKey]: { oldValue: 7, newValue: '{"a":1}' } }, 'local');
    }
    await worker.clock.advance(SEND_DELAY_MS);

    expect(flushes).toBe(0);
  });

  it('make the worker send once, and its own writes to the queue schedule no more sends', async () => {
    // An event that waits for the account id stays queued, and each send leases it again, which writes the queue.
    let idCalls = 0;
    const { page, worker } = newWorkerAndPage(() => (idCalls++, undefined));
    await page.track('waiting');
    await worker.clock.advance(SEND_DELAY_MS);
    const callsOfTheSend = idCalls;

    await worker.clock.advance(10 * 60_000);

    expect([callsOfTheSend > 0, idCalls]).toEqual([true, callsOfTheSend]);
  });
});

describe('an extension page collector', () => {
  it('listens to no install, startup or forwarded event, which only the worker handles', () => {
    const { chrome } = newExtensionHarness({ isWorker: false });

    expect([chrome.installedListeners.size, chrome.startupListeners.size, chrome.listeners.size]).toEqual([0, 0, 0]);
  });
});

describe('uninstallPage', () => {
  it('sets the uninstall page with the uninstall parameters at construction, keeping its own query', async () => {
    const { chrome } = newExtensionHarness({ isWorker: true, uninstallPage: UNINSTALL_PAGE });

    await expect.poll(() => chrome.uninstallUrl).not.toBe('');
    expect(Object.fromEntries(new URL(chrome.uninstallUrl).searchParams)).toEqual({
      product: 'demo',
      platform: 'extension',
      version: '3.1.0',
      browser_language: 'pt',
      age_days: '0',
      active_days: '0',
    });
  });

  it.each([
    ['without a query', 'https://example.com/uninstall', '?', ''],
    ['with a query of its own', 'https://example.com/uninstall?b=2&a=1&flag&q=a%20b+c&version=x', '&', ''],
    ['with an empty query', 'https://example.com/uninstall?', '', ''],
    ['with a query that ends in &', 'https://example.com/uninstall?a=1&', '', ''],
    ['with a fragment', 'https://example.com/uninstall', '?', '#top'],
    ['with a query and a fragment that holds ?', 'https://example.com/uninstall?a=1', '&', '#top?x=1'],
  ])(
    'adds the parameters to a page %s and leaves the page as it was',
    async (_case, beforeFragment, joiner, fragment) => {
      const { chrome } = newExtensionHarness({ isWorker: true, uninstallPage: `${beforeFragment}${fragment}` });

      await expect.poll(() => chrome.uninstallUrl).not.toBe('');
      expect(chrome.uninstallUrl).toBe(
        `${beforeFragment}${joiner}platform=extension&version=3.1.0&browser_language=pt&age_days=0&active_days=0${fragment}`,
      );
    },
  );

  it('sets it again after each setState, to the page alone in the opted_out state', async () => {
    const { chrome, collector } = newExtensionHarness({ isWorker: false, uninstallPage: UNINSTALL_PAGE });

    await collector.setState(AnalyticsState.OptedOut);

    expect(chrome.uninstallUrl).toBe(UNINSTALL_PAGE);
  });

  it('sets the page alone as soon as the user opts out, before the opted_out send ends', async () => {
    const chrome = stubChrome();
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    let answer: ((status: number) => void) | undefined;
    const collector = newExtensionCollector({
      key: KEY,
      mode: 'anonymous',
      storage: newMemoryStorage(),
      clock: new FakeClock('2026-10-29T10:00:00'),
      // The opted_out request stays in flight until the test answers it, as on a slow network.
      transport: () => new Promise<number>((resolve) => (answer = resolve)),
      uninstallPage: UNINSTALL_PAGE,
    });
    await expect.poll(() => chrome.uninstallUrl).toContain('age_days');

    const optingOut = collector.setState(AnalyticsState.OptedOut);
    await expect.poll(() => answer).toBeDefined();
    const urlWhileSending = chrome.uninstallUrl;
    answer?.(204);
    await optingOut;

    expect([urlWhileSending, chrome.uninstallUrl]).toEqual([UNINSTALL_PAGE, UNINSTALL_PAGE]);
  });

  it('sets the uninstall parameters again once the user leaves the opted_out state', async () => {
    const { chrome, collector } = newExtensionHarness({ isWorker: false, uninstallPage: UNINSTALL_PAGE });
    await collector.setState(AnalyticsState.OptedOut);

    await collector.setState(AnalyticsState.Anonymous);

    expect(new URL(chrome.uninstallUrl).searchParams.get('age_days')).toBe('0');
  });

  it('keeps the earlier state fields out of the page during an opt-out right after construction', async () => {
    const chrome = stubChrome();
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    let answer: ((status: number) => void) | undefined;
    const collector = newExtensionCollector({
      key: KEY,
      mode: 'anonymous',
      storage: newMemoryStorage(),
      clock: new FakeClock('2026-10-29T10:00:00'),
      transport: () => new Promise<number>((resolve) => (answer = resolve)),
      uninstallPage: UNINSTALL_PAGE,
    });

    const optingOut = collector.setState(AnalyticsState.OptedOut);
    await expect.poll(() => answer).toBeDefined();
    const urlWhileSending = chrome.uninstallUrl;
    answer?.(204);
    await optingOut;

    expect([urlWhileSending, chrome.uninstallUrl]).toEqual([UNINSTALL_PAGE, UNINSTALL_PAGE]);
  });

  it('sets the page alone before any move to a state without an id, then the new fields', async () => {
    const { chrome, collector } = newExtensionHarness({ isWorker: false, uninstallPage: UNINSTALL_PAGE });
    await collector.setState(AnalyticsState.OptedOut);
    const urls: string[] = [];
    const setUninstallUrl = chrome.runtime.setUninstallURL;
    chrome.runtime.setUninstallURL = async (url) => {
      urls.push(url);
      await setUninstallUrl(url);
    };

    await collector.setState(AnalyticsState.Anonymous);

    expect(urls.map((url) => new URL(url).searchParams.has('age_days'))).toEqual([false, true]);
  });

  it('keeps the fields in the page while the user moves to a state with an id', async () => {
    const { chrome, collector } = newExtensionHarness({
      isWorker: false,
      mode: Mode.Pseudonymous,
      uninstallPage: UNINSTALL_PAGE,
    });
    await expect.poll(() => chrome.uninstallUrl).toContain('age_days');
    const urls: string[] = [];
    chrome.runtime.setUninstallURL = async (url) => void urls.push(url);

    await collector.setState(AnalyticsState.Pseudonymous);

    expect(urls.map((url) => new URL(url).searchParams.has('age_days'))).toEqual([true]);
  });

  it('sets no uninstall page without the option', async () => {
    const { chrome, collector } = newExtensionHarness({ isWorker: true });

    await collector.setState(AnalyticsState.OptedOut);

    expect(chrome.uninstallUrl).toBe('');
  });

  it('reports a page that is no URL to onError', async () => {
    const { errors, collector } = newExtensionHarness({ isWorker: false, uninstallPage: 'not a url' });

    await collector.setState(AnalyticsState.OptedOut);

    // The page goes before the opt-out and after it. The opt-out drops the write of the construction.
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error instanceof TypeError)).toBe(true);
  });

  it('sets the page alone when uninstallParams fails, and reports only the storage failure', async () => {
    const { chrome, errors, collector } = newExtensionHarness({
      isWorker: false,
      uninstallPage: UNINSTALL_PAGE,
      storage: {
        get: async () => {
          throw new Error('storage down');
        },
        set: async () => undefined,
      },
    });
    await expect.poll(() => chrome.uninstallUrl).toBe(UNINSTALL_PAGE);
    errors.length = 0;

    await collector.setState(AnalyticsState.OptedOut);

    expect(chrome.uninstallUrl).toBe(UNINSTALL_PAGE);
    expect(errors).toEqual([new Error('storage down'), new Error('storage down')]);
  });
});
