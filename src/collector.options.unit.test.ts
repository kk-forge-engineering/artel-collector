import { describe, expect, it } from 'vitest';
import { AnalyticsState, newCollector, newMemoryStorage, Platform, type Transport } from './exports.js';
import { newExtensionCollector } from './extension.js';
import { newWebCollector } from './web.js';
import { DESKTOP_KEY, ENDPOINT, KEY, newHarness, SITE_KEY, USER_ID, VERSION } from '../tests/harness.js';
import { fromUntypedHost } from '../tests/untypedHost.js';

type Options = Parameters<typeof newCollector>[0];

const ENDPOINT_MESSAGE =
  'artel: endpoint is not an https URL without a user or password, or http to a development host';
const KEY_FORM = 'is not <kind>-<10 characters> or <kind>-test-<10 characters>';

/** Returns what `newCollector` throws for the harness's valid options with `overrides`, or undefined. */
function thrownFor(overrides: object): unknown {
  try {
    newCollector(
      fromUntypedHost<Options>({
        key: KEY,
        platform: Platform.Extension,
        version: VERSION,
        mode: 'anonymous',
        storage: newMemoryStorage(),
        endpoint: ENDPOINT,
        ...overrides,
      }),
    );
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('options the intake would refuse every envelope of, or that only untyped code passes', () => {
  it.each([
    [
      'an extension key on platform web',
      { platform: 'web' },
      'artel: a key of kind extension does not take platform web',
    ],
    [
      'a site test key on platform macos',
      { key: 'site-test-aa131n3j11', platform: 'macos' },
      'artel: a key of kind site does not take platform macos',
    ],
    ['a key of no channel kind', { key: 'web-aa131n3j11' }, `artel: key "web-aa131n3j11" ${KEY_FORM}`],
    [
      'a key of 9 characters after its kind',
      { key: 'extension-aa131n3j1' },
      `artel: key "extension-aa131n3j1" ${KEY_FORM}`,
    ],
    ['a key with a capital', { key: 'extension-Aa131n3j11' }, `artel: key "extension-Aa131n3j11" ${KEY_FORM}`],
    ['a key that is a list of one valid key', { key: [KEY] }, `artel: key ["${KEY}"] ${KEY_FORM}`],
    ['a key that is a bigint', { key: 10n }, `artel: key bigint ${KEY_FORM}`],
    [
      'a platform the intake does not take',
      { platform: 'android' },
      'artel: platform "android" is not one the intake takes',
    ],
    ['a version of five numbers', { version: '1.2.3.4.5' }, 'artel: version "1.2.3.4.5" is not one the intake takes'],
    [
      'a version past 32 characters',
      { version: `1.2.3-${'a'.repeat(27)}` },
      `artel: version "1.2.3-${'a'.repeat(27)}" is not one the intake takes`,
    ],
    ['no version', { version: undefined }, 'artel: version undefined is not one the intake takes'],
    [
      'a browser on a desktop platform',
      { key: DESKTOP_KEY, platform: 'macos', browser: { name: 'chrome' } },
      'artel: platform macos names no browser',
    ],
    [
      'a transport that is not a function',
      { endpoint: undefined, transport: ENDPOINT },
      'artel: transport is a string, not a function',
    ],
    ['neither endpoint nor transport', { endpoint: undefined }, ENDPOINT_MESSAGE],
  ])('throw a TypeError for %s', (_, overrides, message) => {
    expect(thrownFor(overrides)).toEqual(new TypeError(message));
  });

  it.each([
    ['text that is no URL', 'intake'],
    ['a URL of another scheme', 'ftp://intake.example.com/v1/public/relay'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a value that is no string', 42],
    ['an http URL of a public host', 'http://intake.example.com/v1/public/relay'],
    ['an http URL of a host that only starts like localhost', 'http://localhost.example.com/v1/public/relay'],
    ['an http URL of a host whose name only ends like localhost', 'http://notlocalhost/v1/public/relay'],
    ['an http URL of a host that holds .test before its own domain', 'http://relay.test.example.com/v1/public/relay'],
    ['an https URL with a user and a password, which fetch refuses', 'https://u:p@intake.example.com/v1/public/relay'],
    ['an https URL with a user', 'https://u@intake.example.com/v1/public/relay'],
    ['an http URL of a development host with a password', 'http://:p@localhost:8080/v1/public/relay'],
  ])('throw a TypeError that quotes no endpoint for %s', (_, endpoint) => {
    expect(thrownFor({ endpoint })).toEqual(new TypeError(ENDPOINT_MESSAGE));
  });

  it('throw from the web and extension constructors too', () => {
    const common = { version: VERSION, endpoint: ENDPOINT, mode: 'anonymous', browserLanguage: 'en' } as const;

    expect(() => newWebCollector({ ...common, key: KEY })).toThrow(
      new TypeError('artel: a key of kind extension does not take platform web'),
    );
    expect(() => newExtensionCollector({ ...common, key: SITE_KEY, uiLanguage: 'en' })).toThrow(
      new TypeError('artel: a key of kind site does not take platform extension'),
    );
  });
});

describe('options the intake takes', () => {
  it.each([
    'https://intake.example.com/v1/public/relay',
    'http://localhost:8080/v1/public/relay',
    'http://127.0.0.1/v1/public/relay',
    'http://[::1]:8080/v1/public/relay',
    'http://relay.localhost/v1/public/relay',
    'http://intake.test/v1/public/relay',
  ])('build a collector with the endpoint %s', (endpoint) => {
    expect(thrownFor({ endpoint })).toBeUndefined();
  });

  it('build a collector with a transport, whatever http endpoint stands beside it', () => {
    const transport: Transport = async () => 204;

    expect(thrownFor({ endpoint: 'http://intake.example.com/v1/public/relay', transport })).toBeUndefined();
  });
});

describe('a send delay of 0', () => {
  it('sends at the next turn of the clock, without a report', async () => {
    const harness = newHarness({ sendDelaySeconds: 0 });

    await harness.collector.track('a');
    await harness.clock.advance(0);

    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(harness.errors).toEqual([]);
  });
});

describe('options only untyped code passes', () => {
  it('reads a mode the collector does not know as anonymous', async () => {
    const bodies: string[] = [];
    const collector = newCollector(
      fromUntypedHost<Options>({
        key: KEY,
        platform: Platform.Extension,
        version: VERSION,
        mode: 'other',
        getId: () => USER_ID,
        storage: newMemoryStorage(),
        transport: async (body: string) => (bodies.push(body), 204),
      }),
    );

    await collector.setState(AnalyticsState.Identified);
    await collector.track('a');
    await collector.flush();

    expect(await collector.getState()).toBe(AnalyticsState.Anonymous);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(USER_ID);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, '1'])('sends after 5 s for a send delay of %s', async (delay) => {
    const harness = newHarness({ sendDelaySeconds: fromUntypedHost<number>(delay) });

    await harness.collector.track('a');
    await harness.clock.advance(4_999);
    const early = harness.fetch.requests.length;
    await harness.clock.advance(1);

    expect([early, harness.fetch.eventNames]).toEqual([0, ['a']]);
  });

  it('keeps a session 10 minutes for a session idle time of NaN', async () => {
    const harness = newHarness({ sessionIdleMinutes: Number.NaN, sendDelaySeconds: 0 });

    await harness.collector.track('a');
    await harness.clock.advance(9 * 60_000);
    await harness.collector.track('b');
    await harness.clock.advance(0);

    expect(new Set(harness.fetch.requests.map((request) => request.envelope.session)).size).toBe(1);
  });
});
