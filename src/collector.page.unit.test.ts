import { describe, expect, it } from 'vitest';
import { AnalyticsState, Platform, type PageFields } from './exports.js';
import { newHarness } from '../tests/harness.js';
import { fromUntypedHost } from '../tests/untypedHost.js';

/** Returns a harness of a site whose `getPage` gives `fields` and records each event name it is asked for. */
function newSiteHarness(fields: PageFields): ReturnType<typeof newHarness> & { asked: string[] } {
  const asked: string[] = [];
  const harness = newHarness({
    platform: Platform.Web,
    getPage: (name) => {
      asked.push(name);
      return fields;
    },
  });
  return { ...harness, asked };
}

describe('page fields', () => {
  it('adds the page fields getPage returns to each event', async () => {
    const harness = newSiteHarness({ page: '/pricing', referrer: 'https://www.google.com/' });

    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events[0]).toMatchObject({ page: '/pricing', referrer: 'www.google.com' });
  });

  it('sends the referrer a product getPage gives only with the first page_view of each collector', async () => {
    const fields = { page: '/pricing', referrer: 'https://www.google.com/' };
    const harness = newSiteHarness(fields);

    await harness.collector.track('report_exported');
    await harness.collector.track('page_view');
    fields.page = '/docs';
    await harness.collector.track('page_view');
    await harness.collector.installed();
    await harness.restart().track('page_view');
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.referrer])).toEqual([
      ['report_exported', undefined],
      ['page_view', 'www.google.com'],
      ['page_view', undefined],
      ['installed', undefined],
      ['page_view', 'www.google.com'],
    ]);
  });

  it('asks getPage by the name of the event', async () => {
    const harness = newSiteHarness({ page: '/pricing' });

    await harness.collector.track('page_view');
    await harness.collector.installed();
    await harness.collector.updated();

    expect(harness.asked).toEqual(['page_view', 'installed', 'updated']);
  });

  it('takes the page when the event is tracked, before an earlier event is recorded', async () => {
    let page = '/a';
    const harness = newHarness({ platform: Platform.Web, getPage: () => ({ page }) });

    const tracked = harness.collector.track('a');
    page = '/b';
    await tracked;
    await harness.settle();

    expect(harness.fetch.events[0]?.page).toBe('/a');
  });

  it('sends no page fields in the opted_out state, nor in its opted_out event', async () => {
    const harness = newSiteHarness({ page: '/pricing', referrer: 'https://www.google.com/' });

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events).toEqual([{ name: 'opted_out', day: '2026-10-29' }]);
  });

  it.each([Platform.Extension, Platform.MacOs])(
    'sends no page fields from platform %s, which the intake keeps only for a site, and never asks getPage',
    async (platform) => {
      const asked: string[] = [];
      const harness = newHarness({
        platform,
        getPage: (name) => (asked.push(name), { page: '/pricing', referrer: 'https://www.google.com/' }),
      });

      await harness.collector.track('page_view');
      await harness.settle();

      expect(harness.fetch.events).toEqual([expect.not.objectContaining({ page: expect.anything() })]);
      expect(harness.fetch.events).toEqual([expect.not.objectContaining({ referrer: expect.anything() })]);
      expect(asked).toEqual([]);
    },
  );

  it('sends no referrer with a later page_view after getPage threw at the first one', async () => {
    let calls = 0;
    const harness = newHarness({
      platform: Platform.Web,
      getPage: () => {
        calls++;
        if (calls === 1) {
          throw new Error('no location');
        }
        return { page: '/pricing', referrer: 'https://www.google.com/' };
      },
    });

    await harness.collector.track('page_view');
    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.page, event.referrer])).toEqual([
      ['page_view', undefined, undefined],
      ['page_view', '/pricing', undefined],
    ]);
  });

  it('reports a getPage that throws and sends the event without a page', async () => {
    const harness = newHarness({
      platform: Platform.Web,
      getPage: () => {
        throw new Error('no location');
      },
    });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.events).toEqual([expect.not.objectContaining({ page: expect.anything() })]);
    expect(harness.errors).toEqual([new Error('no location')]);
  });
});

describe('a getPage outside TypeScript', () => {
  it.each([
    ['a page that is not a string', (): PageFields => fromUntypedHost({ page: 5 })],
    [
      'fields whose page getter throws',
      (): PageFields => ({
        get page(): string {
          throw new Error('no page');
        },
      }),
    ],
  ])('never makes a method reject or throw when getPage returns %s, and still sends the event', async (_, getPage) => {
    const harness = newHarness({ platform: Platform.Web, getPage });

    const results = await Promise.allSettled([
      harness.collector.track('page_view'),
      Promise.resolve().then(async () => harness.collector.installed()),
    ]);
    await harness.settle();

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(harness.fetch.eventNames).toEqual(['page_view', 'installed']);
    expect(harness.fetch.events.map((event) => event.page)).toEqual([undefined, undefined]);
    expect(harness.errors).toHaveLength(2);
  });

  it('never throws from installed() or updated() at the call', () => {
    const harness = newHarness({ platform: Platform.Web, getPage: fromUntypedHost(() => ({ page: 5 })) });

    expect(() => {
      void harness.collector.installed();
      void harness.collector.updated();
    }).not.toThrow();
  });

  it('reads the referrer only for the first page_view, so a referrer getter that throws costs later views nothing', async () => {
    let path = '/a';
    const harness = newHarness({
      platform: Platform.Web,
      getPage: (): PageFields => ({
        page: path,
        get referrer(): string {
          throw new Error('no referrer');
        },
      }),
    });

    await harness.collector.track('page_view');
    path = '/b';
    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events.map((event) => event.page)).toEqual([undefined, '/b']);
    expect(harness.errors).toEqual([new Error('no referrer')]);
  });

  it('leaves out and reports a referrer that is not a string, and sends the page', async () => {
    const harness = newHarness({
      platform: Platform.Web,
      getPage: (): PageFields => fromUntypedHost({ page: '/pricing', referrer: 5 }),
    });

    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.page, event.referrer])).toEqual([['/pricing', undefined]]);
    expect(harness.errors).toHaveLength(1);
  });
});

describe('the page shaping of any getPage', () => {
  /** Tracks one page view of a site whose `getPage` gives `fields`, and returns the event sent and the reports. */
  async function sentWith(fields: PageFields): Promise<{ page?: string; referrer?: string; errors: unknown[] }> {
    const harness = newSiteHarness(fields);
    await harness.collector.track('page_view');
    await harness.settle();
    return { ...harness.fetch.events[0], errors: harness.errors };
  }

  it.each([
    ['/docs/v2.3.1/index.html', '/docs/v2.3.1/index.html'],
    ['/100%/a', '/100%/a'],
    ['/u/alice@example.com', '/u/:address'],
    ['/u/bob%40example.org/posts', '/u/:address/posts'],
    ['/u/alice%2540example.com', '/u/:address'],
    ['/u/alice%40example.com%', '/u/:address'],
    ['/u/%FFalice%40x.com', '/u/:address'],
    ['/u/alice\uFF20example.com%', '/u/:address'],
    ['/u/caf%E9%40mail.com', '/u/:address'],
    ['/u/alice\uFF20example.com', '/u/:address'],
    ['/u/alice\uFE6Bexample.com', '/u/:address'],
    ['/ip/10.0.0.1/', '/ip/:address/'],
    ['/ip/fe80::1', '/ip/:address'],
    ['/ip/2001:db8:0:0:0:0:0:1', '/ip/:address'],
    ['/docs/Vec::add', '/docs/Vec::add'],
    ['/go/https://site.com/u/alice', '/go/:address'],
    ['/go/https:%2F%2Fsite.com/u/alice', '/go/:address'],
    ['/login/next=https%3A%2F%2Fsite.com/x', '/login/:address'],
    ['/go/HTTPS:site.com', '/go/:address'],
    ['/open/myapp://item/7', '/open/:address'],
    ['/note/profile:7', '/note/profile:7'],
    ['/cart;jsessionid=ABC123/items', '/cart/items'],
    ['/search?q=alice@example.com#access_token=SECRET', '/search'],
    ['https://example.com/u/alice@example.com?q=1#top', '/u/:address'],
    ['https://example.com', '/'],
    [`/${'a'.repeat(300)}`, `/${'a'.repeat(255)}`],
    [`/x${'%D0%BF'.repeat(300)}`, `/x${'%D0%BF'.repeat(42)}`],
    [`/${'a'.repeat(300)}/alice@example.com`, `/${'a'.repeat(255)}`],
    [`/${'é'.repeat(100)}`, `/${'%C3%A9'.repeat(42)}`],
    [`/${'😀'.repeat(30)}`, `/${'%F0%9F%98%80'.repeat(21)}`],
    ['/100%', '/100%'],
  ])('sends the page %s as %s', async (page, expected) => {
    const sent = await sentWith({ page });

    expect([sent.page, sent.errors]).toEqual([expected, []]);
  });

  it.each(['http://[bad/a', 'mailto:alice@example.com'])(
    'leaves out and reports the page %s, which has no path that starts with /, and still sends the event',
    async (page) => {
      const sent = await sentWith({ page, referrer: 'https://www.google.com/' });

      expect(sent).not.toHaveProperty('page');
      expect(sent.referrer).toBe('www.google.com');
      expect(sent.errors).toEqual([
        new Error('artel: a page that is neither a path nor a URL with a path was left out'),
      ]);
    },
  );

  it.each([
    ['a full URL with a query', 'https://mail.example.org/search?q=alice+smith', 'mail.example.org'],
    ['a host with a port and capitals', 'https://Docs.Example.ORG:8443/x', 'docs.example.org'],
    ['a URL with a user', 'https://alice@example.com/', 'example.com'],
    ['a host of 128 characters', `https://${'r'.repeat(124)}.com/`, `${'r'.repeat(124)}.com`],
    ['a host of 129 characters', `https://${'r'.repeat(125)}.com/`, undefined],
    ['an IPv4 address', 'https://192.168.1.10/admin', undefined],
    ['an IPv4 address in hex', 'http://0x7f.1/', undefined],
    ['an IPv6 address', 'https://[::1]:8080/x', undefined],
    ['an at sign look-alike in a host of another scheme', 'app://alice\uFF20example.com/', undefined],
    ['an e-mail address', 'alice@example.com', undefined],
    ['a host without a scheme', 'www.google.com', undefined],
    ['no referrer', '', undefined],
  ])('sends the referrer of %s as %s', async (_, referrer, expected) => {
    expect((await sentWith({ page: '/a', referrer })).referrer).toBe(expected);
  });

  it.each([
    ['one segment', `/${'a'.repeat(2_000_000)}`],
    ['a million segments', '/a'.repeat(1_000_000)],
  ])('shapes a 2 MB page of %s, the longest URL Chrome keeps, in well under a second', async (_, page) => {
    const harness = newSiteHarness({ page });
    const started = performance.now();

    await harness.collector.track('page_view');

    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('sends no referrer of the host of a page given as a full URL', async () => {
    const sent = await sentWith({ page: 'https://example.com/a', referrer: 'https://EXAMPLE.com/b' });

    expect(sent).toEqual(expect.objectContaining({ page: '/a' }));
    expect(sent).not.toHaveProperty('referrer');
  });

  it('sends a page_view of the page the last one sent no second time in a row', async () => {
    let path = '/u/alice';
    const harness = newHarness({
      platform: Platform.Web,
      getPage: () => ({ page: path.replace(/^\/u\/[^/]+/, '/u/:name') }),
    });

    await harness.collector.track('page_view');
    path = '/u/bob';
    await harness.collector.track('page_view');
    await harness.collector.track('report_exported');
    await harness.collector.track('page_view');
    path = '/docs';
    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.page])).toEqual([
      ['page_view', '/u/:name'],
      ['report_exported', '/u/:name'],
      ['page_view', '/docs'],
    ]);
  });
});

describe('a page_view of a page that differs only in its query', () => {
  it('sends no second page_view in a row, since the page it would send is the same', async () => {
    let page = '/docs?tab=1';
    const harness = newHarness({ platform: Platform.Web, getPage: () => ({ page }) });

    await harness.collector.track('page_view');
    page = '/docs?tab=2';
    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.page])).toEqual([['page_view', '/docs']]);
  });
});

describe('a page_view without a page between two of the same page', () => {
  it('sends the second page_view of the page, since another page_view came between them', async () => {
    let page: string | undefined = '/a';
    const harness = newHarness({ platform: Platform.Web, getPage: () => (page === undefined ? {} : { page }) });

    await harness.collector.track('page_view');
    page = undefined;
    await harness.collector.track('page_view');
    page = '/a';
    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.page])).toEqual([
      ['page_view', '/a'],
      ['page_view', undefined],
      ['page_view', '/a'],
    ]);
  });
});
