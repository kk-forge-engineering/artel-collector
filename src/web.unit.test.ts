import { describe, expect, it, vi } from 'vitest';
import { flushWhenHidden, newLocalStorageAdapter, pageFields, newWebLock } from './web.js';
import { newHarness } from '../tests/harness.js';

/** The part of the Web Storage API the adapter uses, over a Map. */
class FakeWebStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    // oxlint-disable-next-line unicorn/no-null -- Web Storage answers null for a missing key, and so does this fake.
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** A visible document with a referrer, which a test can hide. */
class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';

  constructor(readonly referrer = '') {
    super();
  }

  hide(): void {
    this.visibilityState = 'hidden';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

describe('newLocalStorageAdapter', () => {
  it('keeps values in localStorage and answers undefined for a missing key', async () => {
    const webStorage = new FakeWebStorage();
    vi.stubGlobal('localStorage', webStorage);
    const storage = newLocalStorageAdapter();

    await storage.set('artel.session', 'k3j9x2m1qa0b');

    expect(await storage.get('artel.session')).toBe('k3j9x2m1qa0b');
    expect(await storage.get('artel.missing')).toBeUndefined();
    expect(webStorage.items.get('artel.session')).toBe('k3j9x2m1qa0b');
  });

  it('rejects where there is no localStorage, so the collector reports it', async () => {
    vi.stubGlobal('localStorage', undefined);

    await expect(newLocalStorageAdapter().get('artel.session')).rejects.toThrow(TypeError);
  });
});

describe('newWebLock', () => {
  it('runs the operation under the origin-wide lock named artel', async () => {
    const names: string[] = [];
    vi.stubGlobal('navigator', {
      locks: { request: async (name: string, operation: () => Promise<unknown>) => (names.push(name), operation()) },
    });

    await expect(newWebLock()(async () => 'done')).resolves.toBe('done');
    expect(names).toEqual(['artel']);
  });

  it.each([
    ['no Web Locks', {}],
    // This row covers test DOMs such as happy-dom, which set `locks` to null.
    ['Web Locks set to null', { locks: JSON.parse('null') }],
    ['Web Locks without a request method', { locks: {} }],
  ])('runs the operation unguarded where the host has %s', async (_, host) => {
    vi.stubGlobal('navigator', host);

    await expect(newWebLock()(async () => 'done')).resolves.toBe('done');
  });
});

describe('pageFields', () => {
  it('gives the path and the host of a referring site', () => {
    vi.stubGlobal('location', { pathname: '/products/editor', hostname: 'example.com' });
    vi.stubGlobal('document', new FakeDocument('https://www.google.com/search?q=report'));

    expect(pageFields()).toEqual({ page: '/products/editor', referrer: 'www.google.com' });
  });

  it.each([
    ['the same site', 'https://example.com/products'],
    ['no referrer', ''],
    ['a referrer that is not a URL', 'not a url'],
  ])('leaves out the referrer for %s', (_, referrer) => {
    vi.stubGlobal('location', { pathname: '/privacy', hostname: 'example.com' });
    vi.stubGlobal('document', new FakeDocument(referrer));

    expect(pageFields()).toEqual({ page: '/privacy' });
  });
});

describe('flushWhenHidden', () => {
  it('sends the queue when the page is hidden, and no more once stopped', async () => {
    const page = new FakeDocument();
    vi.stubGlobal('document', page);
    const harness = newHarness();
    const stop = flushWhenHidden(harness.collector);

    await harness.collector.track('a');
    page.hide();
    await harness.clock.advance(0);
    expect(harness.fetch.eventNames).toEqual(['a']);

    stop();
    await harness.collector.track('b');
    page.hide();
    await harness.clock.advance(0);
    expect(harness.fetch.eventNames).toEqual(['a']);
  });
});
