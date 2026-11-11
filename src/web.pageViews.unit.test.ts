import { describe, expect, it, vi } from 'vitest';
import { newWebCollector, trackPageViews } from './web.js';
import { newMemoryStorage, Platform } from './exports.js';
import { FakeFetch } from '../tests/fakeFetch.js';
import { ENDPOINT, SITE_KEY, newHarness, storageKey } from '../tests/harness.js';
import { FakeDocument, newPageHarness, pageViews, stubPage } from '../tests/fakePage.js';

/** Returns a harness of a site whose `getPage` gives a page that is no URL for each path under `/bad`. */
function newUnreadablePageHarness(): ReturnType<typeof newHarness> {
  return newHarness({
    platform: Platform.Web,
    getPage: () => ({ page: location.pathname.replace('/bad', 'http://[') }),
  });
}

describe('trackPageViews', () => {
  it('sends page_view on load and on each navigation to another path', async () => {
    const page = stubPage();
    const harness = newPageHarness();

    trackPageViews(harness.collector);
    history.pushState({}, '', '/pricing');
    history.replaceState({}, '', '/pricing/team');
    page.back('/');
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(['/', '/pricing', '/pricing/team', '/']);
  });

  it('sends nothing for a navigation that keeps the path, such as a new query', async () => {
    const page = stubPage();
    const harness = newPageHarness();

    trackPageViews(harness.collector);
    history.pushState({}, '', '/?tab=2');
    history.replaceState({}, '', '/?tab=3');
    page.back('/');
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(['/']);
  });

  it('sends one page_view for a navigation the Navigation API reports too', async () => {
    stubPage();
    const navigation = new EventTarget();
    vi.stubGlobal('navigation', navigation);
    const harness = newPageHarness();

    trackPageViews(harness.collector);
    history.pushState({}, '', '/pricing');
    navigation.dispatchEvent(new Event('currententrychange'));
    location.pathname = '/docs';
    navigation.dispatchEvent(new Event('currententrychange'));
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(['/', '/pricing', '/docs']);
  });

  it('keeps working where a script of the page holds its own value in the global navigation', async () => {
    stubPage();
    vi.stubGlobal('navigation', { menu: [] });
    const harness = newPageHarness();

    const stop = trackPageViews(harness.collector);
    history.pushState({}, '', '/pricing');
    stop();
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(['/', '/pricing']);
  });

  it('stops, and gives back the history methods it found', async () => {
    const page = stubPage();
    const { pushState, replaceState } = page.history;
    const navigation = new EventTarget();
    vi.stubGlobal('navigation', navigation);
    const harness = newPageHarness();

    const stop = trackPageViews(harness.collector);
    stop();
    history.pushState({}, '', '/pricing');
    page.back('/docs');
    navigation.dispatchEvent(new Event('currententrychange'));
    await harness.settle();

    expect(page.history.pushState).toBe(pushState);
    expect(page.history.replaceState).toBe(replaceState);
    expect(pageViews(harness).map(([path]) => path)).toEqual(['/']);
  });

  it('stops, and leaves no own history method over one the page inherits from its prototype', () => {
    stubPage();
    /** A history whose methods sit on its prototype, as `History.prototype` holds them in a browser. */
    class InheritedHistory {
      pushState(_data: unknown, _unused: string, _url?: string): void {}
      replaceState(_data: unknown, _unused: string, _url?: string): void {}
    }
    const inherited = new InheritedHistory();
    vi.stubGlobal('history', inherited);
    const harness = newPageHarness();

    const stop = trackPageViews(harness.collector);
    stop();
    const recorder: string[] = [];
    // A tool that patches History.prototype later, as a session recorder may.
    InheritedHistory.prototype.pushState = (_data, _unused, url) => {
      recorder.push(String(url));
    };
    inherited.pushState({}, '', '/pricing');

    expect(Object.hasOwn(inherited, 'pushState')).toBe(false);
    expect(Object.hasOwn(inherited, 'replaceState')).toBe(false);
    expect(recorder).toEqual(['/pricing']);
  });

  it.each([
    ['the order they started in', [0, 1]],
    ['the reverse order', [1, 0]],
  ])('leaves history as it found it after two trackers stop in %s', (_, order) => {
    stubPage();
    class InheritedHistory {
      pushState(_data: unknown, _unused: string, _url?: string): void {}
      replaceState(_data: unknown, _unused: string, _url?: string): void {}
    }
    const inherited = new InheritedHistory();
    vi.stubGlobal('history', inherited);
    const harness = newPageHarness();

    const stops = [trackPageViews(harness.collector), trackPageViews(harness.collector)];
    for (const index of order) {
      stops[index]?.();
    }

    expect(Object.hasOwn(inherited, 'pushState')).toBe(false);
    expect(Object.hasOwn(inherited, 'replaceState')).toBe(false);
  });

  it('gives back its own history methods after two trackers stop in the order they started', async () => {
    const page = stubPage();
    const { pushState } = page.history;
    const harness = newPageHarness();

    const stopFirst = trackPageViews(harness.collector);
    const stopSecond = trackPageViews(harness.collector);
    stopFirst();
    history.pushState({}, '', '/pricing');
    stopSecond();
    history.pushState({}, '', '/docs');
    await harness.settle();

    expect(page.history.pushState).toBe(pushState);
    // The collector sends the page both trackers start on once. Only the second still tracks /pricing, and neither
    // tracks /docs.
    expect(pageViews(harness).map(([path]) => path)).toEqual(['/', '/pricing']);
  });

  it('sends one page_view for each navigation when two trackers watch one collector', async () => {
    const page = stubPage();
    const harness = newPageHarness();

    trackPageViews(harness.collector);
    trackPageViews(harness.collector);
    history.pushState({}, '', '/pricing');
    page.back('/');
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(['/', '/pricing', '/']);
  });

  it('keeps working beside a product that patches history after it, and leaves that patch on stop', async () => {
    const page = stubPage();
    const harness = newPageHarness();
    const productSaw: string[] = [];

    const stop = trackPageViews(harness.collector);
    const tracked = page.history.pushState;
    page.history.pushState = (data, unused, url) => {
      productSaw.push(String(url));
      tracked(data, unused, url);
    };
    history.pushState({}, '', '/pricing');
    stop();
    history.pushState({}, '', '/docs');
    await harness.settle();

    expect(productSaw).toEqual(['/pricing', '/docs']);
    expect(location.pathname).toBe('/docs');
    expect(pageViews(harness).map(([path]) => path)).toEqual(['/', '/pricing']);
  });
});

describe('newWebCollector page fields', () => {
  function stubSite(): FakeFetch {
    stubPage();
    const fetch = new FakeFetch();
    vi.stubGlobal('fetch', fetch.fetch);
    vi.stubGlobal('navigator', { language: 'de-DE' });
    return fetch;
  }

  it('sends the path, and the referring host only on the first page view of a load', async () => {
    const fetch = stubSite();
    const usage = newWebCollector({
      key: SITE_KEY,
      version: '1.0.0',
      endpoint: ENDPOINT,
      mode: 'anonymous',
      storage: newMemoryStorage(),
    });

    trackPageViews(usage);
    history.pushState({}, '', '/pricing?plan=team');
    await usage.flush();

    expect(fetch.events.map((event) => [event.name, event.page, event.referrer])).toEqual([
      ['page_view', '/', 'www.google.com'],
      ['page_view', '/pricing', undefined],
    ]);
  });

  it('sends the referring host with the first page view of a load that calls installed and updated first', async () => {
    const fetch = stubSite();
    const storage = newMemoryStorage();
    await storage.set(storageKey('installed', SITE_KEY), '1');
    await storage.set(storageKey('version', SITE_KEY), '1.0.0');
    const usage = newWebCollector({ key: SITE_KEY, version: '1.0.0', endpoint: ENDPOINT, mode: 'anonymous', storage });

    await usage.installed();
    await usage.updated();
    await usage.track('report_exported');
    trackPageViews(usage);
    await usage.flush();

    expect(fetch.events.map((event) => [event.name, event.referrer])).toEqual([
      ['report_exported', undefined],
      ['page_view', 'www.google.com'],
    ]);
  });

  it('sends no referring host for a load that came from no other site', async () => {
    const fetch = stubSite();
    vi.stubGlobal('document', new FakeDocument(''));
    const usage = newWebCollector({
      key: SITE_KEY,
      version: '1.0.0',
      endpoint: ENDPOINT,
      mode: 'anonymous',
      storage: newMemoryStorage(),
    });

    trackPageViews(usage);
    await usage.flush();

    expect(fetch.events).toEqual([expect.objectContaining({ name: 'page_view', page: '/' })]);
    expect(fetch.events).toEqual([expect.not.objectContaining({ referrer: expect.anything() })]);
  });

  it('records an event in a Web Worker, which has no document or location, and reports nothing', async () => {
    const fetch = new FakeFetch();
    vi.stubGlobal('fetch', fetch.fetch);
    vi.stubGlobal('navigator', { language: 'de-DE' });
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('location', undefined);
    const errors: Error[] = [];
    const usage = newWebCollector({
      key: SITE_KEY,
      version: '1.0.0',
      endpoint: ENDPOINT,
      mode: 'anonymous',
      storage: newMemoryStorage(),
      onError: (error) => errors.push(error),
    });

    await usage.track('report_exported');
    await usage.flush();

    expect(fetch.events).toEqual([expect.not.objectContaining({ page: expect.anything() })]);
    expect(errors).toEqual([]);
  });

  it('takes the product getPage over its own, such as a route pattern for a path with a secret', async () => {
    const fetch = stubSite();
    history.pushState({}, '', '/share/s3cr3t');
    const usage = newWebCollector({
      key: SITE_KEY,
      version: '1.0.0',
      endpoint: ENDPOINT,
      mode: 'anonymous',
      storage: newMemoryStorage(),
      getPage: () => ({ page: '/share/:token' }),
    });

    trackPageViews(usage);
    await usage.flush();

    expect(fetch.events.map((event) => [event.page, event.referrer])).toEqual([['/share/:token', undefined]]);
  });
});

describe('trackPageViews on any platform and for any page', () => {
  it('sends one page_view without a page for a navigation to a path the collector leaves out', async () => {
    stubPage();
    vi.stubGlobal('navigation', new EventTarget());
    const harness = newUnreadablePageHarness();

    trackPageViews(harness.collector);
    history.pushState({}, '', '/bad/%E0%A4%A');
    Reflect.get(globalThis, 'navigation').dispatchEvent(new Event('currententrychange'));
    await harness.settle();

    expect(pageViews(harness)).toEqual([
      ['/', undefined],
      [undefined, undefined],
    ]);
  });

  it('sends one page_view per navigation between paths the collector leaves out', async () => {
    const page = stubPage();
    const navigation = new EventTarget();
    vi.stubGlobal('navigation', navigation);
    const harness = newUnreadablePageHarness();
    const navigate = (move: () => void): void => {
      move();
      navigation.dispatchEvent(new Event('currententrychange'));
    };

    trackPageViews(harness.collector);
    navigate(() => history.pushState({}, '', '/bad/%E0%A4%A/1'));
    navigate(() => history.pushState({}, '', '/bad/%E0%A4%A/2'));
    navigate(() => page.back('/bad/%E0%A4%A/1'));
    navigate(() => history.replaceState({}, '', '/bad/%E0%A4%A/3'));
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(['/', undefined, undefined, undefined, undefined]);
  });

  it('sends one page_view per pushState for a getPage that gives no page', async () => {
    stubPage();
    const navigation = new EventTarget();
    vi.stubGlobal('navigation', navigation);
    const harness = newHarness({ platform: Platform.Web, getPage: () => ({}) });

    trackPageViews(harness.collector);
    history.pushState({}, '', '/a');
    navigation.dispatchEvent(new Event('currententrychange'));
    history.pushState({}, '', '/b');
    navigation.dispatchEvent(new Event('currententrychange'));
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['page_view', 'page_view', 'page_view']);
  });
});
