import { describe, expect, it } from 'vitest';
import { AnalyticsState } from './exports.js';
import { forwardTrack } from './extension.js';
import { newExtensionHarness } from '../tests/fakeChrome.js';

const UNINSTALL_PAGE = 'https://example.com/uninstall?product=demo';

describe('the service worker collector', () => {
  it('sends installed when Chrome installs the extension, and updated when Chrome updates it', async () => {
    const { chrome, fetch, settle } = newExtensionHarness({ isWorker: true });

    chrome.install('install');
    await settle();
    chrome.runtime.getManifest = () => ({ version: '3.2.0' });
    const updated = newExtensionHarness({ isWorker: true });
    updated.chrome.install('update');
    await updated.settle();

    expect(fetch.eventNames).toEqual(['installed']);
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

  it('tracks the events content scripts forward', async () => {
    const { fetch, settle } = newExtensionHarness({ isWorker: true });

    await forwardTrack('link_shared', { target: 'clipboard' });
    await settle();

    expect(fetch.events.map((event) => [event.name, event.params])).toEqual([['link_shared', { target: 'clipboard' }]]);
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

  it('sets it again after each setState, to the page alone in the opted_out state', async () => {
    const { chrome, collector } = newExtensionHarness({ isWorker: false, uninstallPage: UNINSTALL_PAGE });

    await collector.setState(AnalyticsState.OptedOut);

    expect(chrome.uninstallUrl).toBe(UNINSTALL_PAGE);
  });

  it('sets no uninstall page without the option', async () => {
    const { chrome, collector } = newExtensionHarness({ isWorker: true });

    await collector.setState(AnalyticsState.OptedOut);

    expect(chrome.uninstallUrl).toBe('');
  });

  it('reports a page that is no URL to onError', async () => {
    const { errors, collector } = newExtensionHarness({ isWorker: false, uninstallPage: 'not a url' });

    await collector.setState(AnalyticsState.OptedOut);

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
