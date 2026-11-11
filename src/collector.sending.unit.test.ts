import { describe, expect, it, vi } from 'vitest';
import { Mode, newCollector, newMemoryStorage, Platform, type StorageAdapter } from './exports.js';
import { eventNamesIn, FakeFetch } from '../tests/fakeFetch.js';
import { ENDPOINT, KEY, SEND_DELAY_MS, SITE_KEY, VERSION, newHarness, USER_ID } from '../tests/harness.js';
import { fromUntypedHost } from '../tests/untypedHost.js';

/** Returns the options every collector needs, for a test that calls `newCollector` without the harness. */
function bareOptions(platform: Platform = Platform.Extension): {
  key: string;
  platform: Platform;
  version: string;
  storage: StorageAdapter;
} {
  return { key: platform === Platform.Web ? SITE_KEY : KEY, platform, version: VERSION, storage: newMemoryStorage() };
}

describe('the request', () => {
  it('posts the envelope as text/plain with keepalive to the endpoint', async () => {
    const harness = newHarness();

    await harness.collector.track('report_exported', { format: 'pdf', pages: 2, with_images: false });
    await harness.settle();

    const [request] = harness.fetch.requests;
    expect(request).toMatchObject({
      url: ENDPOINT,
      method: 'POST',
      contentType: 'text/plain;charset=UTF-8',
      keepalive: true,
    });
    expect(request?.envelope).toMatchObject({
      key: KEY,
      platform: 'extension',
      version: VERSION,
      browser_language: 'pt',
      ui_language: 'zh',
    });
    expect(request?.envelope.events[0]?.params).toEqual({ format: 'pdf', pages: 2, with_images: false });
  });

  it('names the browser in the envelope of an extension product', async () => {
    const harness = newHarness({ getId: () => USER_ID, browser: { name: 'chrome', major: 131 } });

    await harness.collector.track('report_exported');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope.browser).toEqual({ name: 'chrome', major: 131 });
  });

  it.each([
    ['undefined', undefined],
    // oxlint-disable-next-line unicorn/no-null -- a getId over localStorage, outside TypeScript, gives null.
    ['null', null],
    ['an empty string', ''],
  ])('keeps an identified event queued, reporting nothing, while getId returns %s', async (_, id) => {
    const harness = newHarness({ getId: () => fromUntypedHost(id), browser: { name: 'chrome', major: 131 } });

    await harness.collector.track('report_exported');
    await harness.settle();

    expect(harness.fetch.requests).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it('keeps an identified event queued and reports an id past 64 characters, which the intake refuses', async () => {
    const harness = newHarness({ getId: () => 'x'.repeat(65) });

    await harness.collector.track('report_exported');
    await harness.settle();

    expect(harness.fetch.requests).toEqual([]);
    expect(harness.errors).toContainEqual(new Error('artel: an id past 64 characters is not one the intake takes'));
  });

  it('sends an id of 64 characters', async () => {
    const id = '😀'.repeat(64);
    const harness = newHarness({ getId: () => id });

    await harness.collector.track('report_exported');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope.id).toBe(id);
  });

  it('names the browser in the envelope of a web product', async () => {
    const harness = newHarness({
      platform: Platform.Web,
      getId: () => USER_ID,
      browser: { name: 'firefox', major: 132 },
    });

    await harness.collector.track('report_exported');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope.browser).toEqual({ name: 'firefox', major: 132 });
  });

  it.each([
    ['an unknown name as other', { name: 'netscape', major: 4 }, { name: 'other' }],
    ['a major version past 999 without it', { name: 'chrome', major: 1000 }, { name: 'chrome' }],
    ['a major version below 1 without it', { name: 'chrome', major: 0 }, { name: 'chrome' }],
    ['a browser without a major version as it is', { name: 'chrome' }, { name: 'chrome' }],
  ])('sends %s, as the intake keeps it', async (_, browser, sent) => {
    const harness = newHarness({ getId: () => USER_ID, browser: fromUntypedHost(browser) });

    await harness.collector.track('report_exported');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope.browser).toEqual(sent);
    expect(harness.errors).toEqual([]);
  });

  it('leaves out a browser that is not an object and reports it, which only a host outside TypeScript passes', async () => {
    // oxlint-disable-next-line unicorn/no-null -- a host outside TypeScript can pass null.
    const harness = newHarness({ getId: () => USER_ID, browser: fromUntypedHost(null) });

    await harness.collector.track('report_exported');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope.browser).toBeUndefined();
    expect(harness.errors).toHaveLength(1);
  });

  it('sends a fresh copy of the browser, without keys of its own or a major version on other', async () => {
    const browser = { name: 'other', major: 5, note: 'x' };
    const harness = newHarness({ getId: () => USER_ID, browser: fromUntypedHost(browser) });
    browser.name = 'chrome';

    await harness.collector.track('report_exported');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope.browser).toEqual({ name: 'other' });
  });

  it('sends neither an id nor a browser from an anonymous collector, whatever a host outside TypeScript passes', async () => {
    const bodies: string[] = [];
    const options = {
      ...bareOptions(),
      transport: async (body: string) => (bodies.push(body), 204),
      mode: Mode.Anonymous,
      getId: () => USER_ID,
      browser: { name: 'chrome', major: 131 },
    };
    const collector = newCollector(fromUntypedHost(options));

    await collector.track('report_exported');
    await collector.flush();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(USER_ID);
    expect(bodies[0]).not.toContain('"browser"');
  });

  it('posts to the endpoint the host gives', async () => {
    const fetch = new FakeFetch();
    vi.stubGlobal('fetch', fetch.fetch);
    const collector = newCollector({ ...bareOptions(Platform.Web), endpoint: ENDPOINT, mode: Mode.Anonymous });

    await collector.track('a');
    await collector.flush();

    expect(fetch.requests.map((request) => request.url)).toEqual([ENDPOINT]);
  });

  it('refuses options with neither an endpoint nor a transport, which only a host outside TypeScript can pass', () => {
    const options = { ...bareOptions(Platform.Web), mode: 'anonymous' };

    expect(() => newCollector(fromUntypedHost(options))).toThrow(TypeError);
  });

  it('hands the envelope to the transport the host gives', async () => {
    const bodies: string[] = [];
    const harness = newHarness({
      transport: async (body) => {
        bodies.push(body);
        return 204;
      },
    });

    await harness.collector.track('a');
    await harness.settle();

    expect(bodies.flatMap(eventNamesIn)).toEqual(['a']);
  });

  it.each([
    ['browserLanguage', 'english', 'browser_language'],
    ['uiLanguage', 'en-US-x-private-tag', 'ui_language'],
    ['browserLanguage', 'abc-abcdefgh-abcd', 'browser_language'],
    ['uiLanguage', 'en-ab-cd-ef', 'ui_language'],
  ])('leaves out a %s the intake does not take, and reports it', async (option, value, field) => {
    const harness = newHarness({ [option]: value });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope).not.toHaveProperty(field);
    expect(harness.errors).toContainEqual(
      new Error(`artel: ${option} ${JSON.stringify(value)} is not one the intake takes, left out`),
    );
  });

  it('reads an underscore in a language tag as a hyphen', async () => {
    const harness = newHarness({ getId: () => USER_ID, browserLanguage: 'en_US', uiLanguage: 'zh_Hant_TW' });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope).toMatchObject({ browser_language: 'en-US', ui_language: 'zh-Hant-TW' });
    expect(harness.errors).toEqual([]);
  });

  it('leaves out the languages, the id and the params the host did not give', async () => {
    const harness = newHarness({ browserLanguage: undefined, uiLanguage: undefined });

    await harness.collector.track('a');
    await harness.settle();

    const envelope = harness.fetch.requests[0]?.envelope;
    expect(envelope).not.toHaveProperty('browser_language');
    expect(envelope).not.toHaveProperty('ui_language');
    expect(envelope).not.toHaveProperty('id');
    expect(envelope?.events[0]).not.toHaveProperty('params');
  });

  it('includes the id getId returns', async () => {
    const harness = newHarness({ getId: () => USER_ID });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope.id).toBe(USER_ID);
  });
});

describe('batching', () => {
  it('sends 101 events as a post of 100 and a post of 1', async () => {
    const harness = newHarness();

    for (let index = 0; index < 101; index++) {
      await harness.collector.track('a');
    }
    await harness.settle();

    expect(harness.fetch.requests.map((request) => request.envelope.events.length)).toEqual([100, 1]);
  });

  it('starts a new envelope before one would pass 60 kB, under the 64 KiB a keepalive request and the intake take', async () => {
    const harness = newHarness();
    const params = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`param_${index}`, 'x'.repeat(64)]));

    for (let index = 0; index < 100; index++) {
      await harness.collector.track('a', params);
    }
    await harness.settle();

    const sizes = harness.fetch.requests.map(
      (request) => new TextEncoder().encode(JSON.stringify(request.envelope)).length,
    );
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(60_000);
    expect(harness.fetch.events).toHaveLength(100);
  });

  it('counts the 60 kB in bytes, not in characters', async () => {
    const harness = newHarness();
    const params = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`param_${index}`, '😀'.repeat(64)]));

    for (let index = 0; index < 20; index++) {
      await harness.collector.track('a', params);
    }
    await harness.settle();

    const sizes = harness.fetch.requests.map(
      (request) => new TextEncoder().encode(JSON.stringify(request.envelope)).length,
    );
    expect(Math.max(...sizes)).toBeLessThanOrEqual(60_000);
    expect(harness.fetch.events).toHaveLength(20);
  });

  it('posts a full envelope at once, without waiting for the pause', async () => {
    const harness = newHarness();

    for (let index = 0; index < 100; index++) {
      await harness.collector.track('a');
    }
    await harness.clock.advance(0);

    expect(harness.fetch.requests).toHaveLength(1);
  });

  it('sends within 5 s of the first queued event, even while events keep coming', async () => {
    const harness = newHarness();

    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS - 1_000);
    await harness.collector.track('b');
    await harness.clock.advance(900);
    expect(harness.fetch.requests).toHaveLength(0);

    await harness.clock.advance(100);

    expect(harness.fetch.requests).toHaveLength(1);
    expect(harness.fetch.eventNames).toEqual(['a', 'b']);
  });

  it('sends within the delay the host sets', async () => {
    const harness = newHarness({ sendDelaySeconds: 1 });

    await harness.collector.track('a');
    await harness.clock.advance(1_000);

    expect(harness.fetch.eventNames).toEqual(['a']);
  });

  it('posts at once on flush', async () => {
    const harness = newHarness();

    await harness.collector.track('a');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a']);
  });

  it('posts nothing on flush with nothing queued', async () => {
    const harness = newHarness();

    await harness.collector.flush();

    expect(harness.fetch.requests).toHaveLength(0);
  });

  it('posts events tracked without awaiting, in the order they were tracked', async () => {
    const harness = newHarness();

    void harness.collector.track('a');
    void harness.collector.track('b');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a', 'b']);
    expect(harness.fetch.events.filter((event) => event.first !== undefined)).toHaveLength(1);
  });

  it('sends events a stopped host left queued, once a new run starts', async () => {
    const harness = newHarness();
    await harness.collector.track('a');
    harness.clock.dropTimers();

    const restarted = harness.restart();
    await restarted.getState();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['a']);
  });
});
