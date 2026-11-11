import { describe, expect, it, vi } from 'vitest';
import { newChromeStorageAdapter, newExtensionCollector } from './extension.js';
import { newMemoryStorage } from './exports.js';
import { FakeFetch } from '../tests/fakeFetch.js';
import { ENDPOINT, KEY, USER_ID } from '../tests/harness.js';
import { stubChrome, stubServiceWorker, type FakeChrome } from '../tests/fakeChrome.js';
import { hide, stubHideablePage } from '../tests/fakePage.js';

describe('newChromeStorageAdapter', () => {
  it('keeps string values in chrome.storage.local and answers undefined for others', async () => {
    const chrome = stubChrome();
    const storage = newChromeStorageAdapter();

    await storage.set('artel.session', 'k3j9x2m1qa0b');
    chrome.items.set('artel.number', 1);

    expect(await storage.get('artel.session')).toBe('k3j9x2m1qa0b');
    expect(await storage.get('artel.number')).toBeUndefined();
    expect(await storage.get('artel.missing')).toBeUndefined();
  });

  it('rejects outside an extension, so the collector reports it', async () => {
    vi.stubGlobal('chrome', undefined);

    await expect(newChromeStorageAdapter().get('artel.session')).rejects.toThrow('chrome extension API');
  });
});

describe('newExtensionCollector', () => {
  /**
   * Stubs a Chrome 131 worker with no Web Locks, and returns the fake Chrome and the network the collector posts to.
   */
  function stubWorker(): { chrome: FakeChrome; fetch: FakeFetch } {
    const chrome = stubChrome();
    const fetch = new FakeFetch();
    vi.stubGlobal('fetch', fetch.fetch);
    vi.stubGlobal('navigator', {
      language: 'pt-BR',
      userAgentData: { brands: [{ brand: 'Google Chrome', version: '131' }] },
    });
    return { chrome, fetch };
  }

  it('sends the manifest version and the primary browser language, over chrome.storage.local', async () => {
    const { chrome, fetch } = stubWorker();
    const usage = newExtensionCollector({ key: KEY, endpoint: ENDPOINT, mode: 'anonymous' });

    await usage.track('report_exported');
    await usage.flush();

    const envelope = fetch.requests[0]?.envelope;
    expect(envelope).toMatchObject({
      key: KEY,
      platform: 'extension',
      version: '3.1.0',
      browser_language: 'pt',
    });
    expect(envelope).not.toHaveProperty('id');
    expect(envelope).not.toHaveProperty('browser');
    expect(chrome.items.size).toBeGreaterThan(0);
  });

  it('sends no interface language unless the product gives one', async () => {
    const { fetch } = stubWorker();
    const errors: Error[] = [];
    const usage = newExtensionCollector({
      key: KEY,
      endpoint: ENDPOINT,
      mode: 'anonymous',
      onError: (error) => errors.push(error),
    });

    await usage.track('report_exported');
    await usage.flush();

    expect(fetch.requests[0]?.envelope).not.toHaveProperty('ui_language');
    expect(errors).toEqual([]);
  });

  it('sends the id, the browser and the full languages once the user is identified', async () => {
    const { fetch } = stubWorker();
    const usage = newExtensionCollector({ key: KEY, endpoint: ENDPOINT, mode: 'identified', getId: () => USER_ID });

    await usage.setState('identified');
    await usage.track('report_exported');
    await usage.flush();

    expect(fetch.requests[0]?.envelope).toMatchObject({
      browser_language: 'pt-BR',
      browser: { name: 'chrome', major: 131 },
      id: USER_ID,
    });
  });

  it('detects the browser in the pseudonymous state too', async () => {
    const { fetch } = stubWorker();
    const usage = newExtensionCollector({ key: KEY, endpoint: ENDPOINT, mode: 'pseudonymous' });

    await usage.setState('pseudonymous');
    await usage.track('report_exported');
    await usage.flush();

    expect(fetch.requests[0]?.envelope).toMatchObject({
      id_kind: 'pseudonymous',
      browser: { name: 'chrome', major: 131 },
    });
  });

  it('sends the interface language the product gives', async () => {
    const { fetch } = stubWorker();
    const usage = newExtensionCollector({
      key: KEY,
      endpoint: ENDPOINT,
      mode: 'identified',
      getId: () => USER_ID,
      uiLanguage: 'fr-CA',
    });

    await usage.setState('identified');
    await usage.track('report_exported');
    await usage.flush();

    expect(fetch.requests[0]?.envelope.ui_language).toBe('fr-CA');
  });

  it('takes the version it is given over the manifest one, and reads no manifest for it', async () => {
    const { chrome, fetch } = stubWorker();
    chrome.runtime.getManifest = () => {
      throw new Error('getManifest not implemented');
    };
    const usage = newExtensionCollector({ key: KEY, version: '3.1.0-beta.2', endpoint: ENDPOINT, mode: 'anonymous' });

    await usage.track('report_exported');
    await usage.flush();

    expect(fetch.requests[0]?.envelope.version).toBe('3.1.0-beta.2');
  });

  it('takes the manifest version and chrome.storage.local for a version and a storage given as undefined', async () => {
    const { chrome, fetch } = stubWorker();
    const usage = newExtensionCollector({
      key: KEY,
      version: undefined,
      storage: undefined,
      endpoint: ENDPOINT,
      mode: 'anonymous',
    });

    await usage.track('report_exported');
    await usage.flush();

    expect(fetch.requests[0]?.envelope.version).toBe('3.1.0');
    expect(chrome.items.size).toBeGreaterThan(0);
  });

  it('builds outside an extension context with only a version, and sends no interface language', async () => {
    vi.stubGlobal('chrome', undefined);
    const fetch = new FakeFetch();
    vi.stubGlobal('fetch', fetch.fetch);
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    const usage = newExtensionCollector({
      key: KEY,
      version: '3.1.0',
      endpoint: ENDPOINT,
      mode: 'anonymous',
      storage: newMemoryStorage(),
    });

    await usage.track('report_exported');
    await usage.flush();

    expect(fetch.requests[0]?.envelope).toMatchObject({ platform: 'extension', version: '3.1.0' });
    expect(fetch.requests[0]?.envelope).not.toHaveProperty('ui_language');
  });

  it('keeps platform extension when the options carry another platform, which their type leaves out', async () => {
    const { fetch } = stubWorker();
    const desktop = { platform: 'macos' } as const;
    const usage = newExtensionCollector({ ...desktop, key: KEY, endpoint: ENDPOINT, mode: 'anonymous' });

    await usage.track('report_exported');
    await usage.flush();

    expect(fetch.requests[0]?.envelope.platform).toBe('extension');
  });
});

describe('the access level of chrome.storage.local', () => {
  /** Makes a collector of an extension page or worker, and returns the fake Chrome and what reached onError. */
  function newCollectorIn(chrome: FakeChrome): { chrome: FakeChrome; errors: Error[] } {
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    const errors: Error[] = [];
    newExtensionCollector({ key: KEY, endpoint: ENDPOINT, mode: 'anonymous', onError: (error) => errors.push(error) });
    return { chrome, errors };
  }

  it.each(['visibilitychange', 'pagehide'])(
    'sends the queue on its own when an extension page is hidden by %s',
    async (event) => {
      const fetch = new FakeFetch();
      vi.stubGlobal('fetch', fetch.fetch);
      stubChrome();
      vi.stubGlobal('navigator', { language: 'pt-BR' });
      const page = stubHideablePage();
      const usage = newExtensionCollector({ key: KEY, endpoint: ENDPOINT, mode: 'anonymous' });
      await usage.track('report_exported');

      hide(page, event);

      // The send delay is 5 seconds, longer than the wait, so only the hide sends.
      await vi.waitFor(() => expect(fetch.eventNames).toEqual(['report_exported']));
    },
  );

  it('adds no hide listener in the service worker', () => {
    stubServiceWorker();
    stubChrome();
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    const page = stubHideablePage();
    const added: string[] = [];
    for (const target of [page.document, page.window]) {
      const add = target.addEventListener.bind(target);
      target.addEventListener = (type, listener) => {
        added.push(type);
        add(type, listener);
      };
    }

    newExtensionCollector({ key: KEY, endpoint: ENDPOINT, mode: 'anonymous' });

    expect(added).toEqual([]);
  });

  it('closes it to content scripts in the service worker', async () => {
    stubServiceWorker();
    const { chrome, errors } = newCollectorIn(stubChrome());
    await Promise.resolve();

    expect(chrome.accessLevels).toEqual([{ accessLevel: 'TRUSTED_CONTEXTS' }]);
    expect(errors).toEqual([]);
  });

  it('reads and writes no storage in the service worker until Chrome has set the level', async () => {
    stubServiceWorker();
    const chrome = stubChrome();
    let setLevel: () => void = () => undefined;
    chrome.storage.local.setAccessLevel = () =>
      new Promise<void>((resolve) => {
        setLevel = resolve;
      });
    const reads: string[] = [];
    const get = chrome.storage.local.get;
    chrome.storage.local.get = async (key) => {
      reads.push(key);
      return get(key);
    };
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    const collector = newExtensionCollector({ key: KEY, endpoint: ENDPOINT, mode: 'anonymous' });

    const tracked = collector.track('a');
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const readsBefore = reads.length;
    setLevel();
    await tracked;

    expect([readsBefore, reads.length > 0, chrome.items.has(`artel.${KEY}.queue`)]).toEqual([0, true, true]);
  });

  it('reads a storage the product gives no sooner in the service worker than Chrome has set the level', async () => {
    stubServiceWorker();
    const chrome = stubChrome();
    let setLevel: () => void = () => undefined;
    chrome.storage.local.setAccessLevel = () =>
      new Promise<void>((resolve) => {
        setLevel = resolve;
      });
    const items = new Map<string, string>();
    const reads: string[] = [];
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    const collector = newExtensionCollector({
      key: KEY,
      endpoint: ENDPOINT,
      mode: 'anonymous',
      storage: {
        get: async (key) => {
          reads.push(key);
          return items.get(key);
        },
        set: async (key, value) => {
          items.set(key, value);
        },
      },
    });

    const tracked = collector.track('a');
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const readsBefore = reads.length;
    setLevel();
    await tracked;

    expect([readsBefore, reads.length > 0]).toEqual([0, true]);
  });

  it('leaves it as it is in an extension page, which may not set it', () => {
    const { chrome, errors } = newCollectorIn(stubChrome());

    expect(chrome.accessLevels).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('reports a call that rejects to onError, throws nothing, and still records', async () => {
    stubServiceWorker();
    const chrome = stubChrome();
    chrome.storage.local.setAccessLevel = async () => {
      throw new Error('not allowed');
    };
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    const errors: Error[] = [];

    await newExtensionCollector({
      key: KEY,
      endpoint: ENDPOINT,
      mode: 'anonymous',
      onError: (error) => errors.push(error),
    }).track('a');

    expect([errors, chrome.items.has(`artel.${KEY}.queue`)]).toEqual([[new Error('not allowed')], true]);
  });

  it('reports a Chrome without setAccessLevel to onError, and throws nothing', () => {
    stubServiceWorker();
    const chrome = stubChrome();
    Reflect.deleteProperty(chrome.storage.local, 'setAccessLevel');

    const { errors } = newCollectorIn(chrome);

    expect(errors).toEqual([expect.any(Error)]);
  });

  it('names the missing setAccessLevel in what it reports', () => {
    stubServiceWorker();
    const chrome = stubChrome();
    Reflect.deleteProperty(chrome.storage.local, 'setAccessLevel');

    const { errors } = newCollectorIn(chrome);

    expect(errors).toEqual([
      new TypeError('artel: chrome.storage.local.setAccessLevel is missing, so content scripts can write it'),
    ]);
  });
});
