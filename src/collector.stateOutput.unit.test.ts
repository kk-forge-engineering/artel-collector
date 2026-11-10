import { describe, expect, it } from 'vitest';
import { AnalyticsState, newMemoryStorage, Platform, type StorageAdapter } from './exports.js';
import { KEY, newHarness, SITE_KEY, USER_ID } from '../tests/harness.js';

const ALL_PERIODS = ['day', 'week', 'month', 'quarter', 'year'];

describe('what each state sends', () => {
  it('sends neither id nor browser and only the primary languages in the anonymous state, and never asks for the id', async () => {
    let asked = 0;
    const harness = newHarness({
      getId: () => (asked++, USER_ID),
      browser: { name: 'chrome', major: 131 },
      state: AnalyticsState.Anonymous,
    });

    await harness.collector.track('a');
    await harness.settle();

    const envelope = harness.fetch.requests[0]?.envelope;
    expect(envelope).toMatchObject({ browser_language: 'pt', ui_language: 'zh' });
    expect(envelope).not.toHaveProperty('id');
    expect(envelope).not.toHaveProperty('browser');
    expect(asked).toBe(0);
  });

  it('sends the id, the browser and the full languages in the identified state', async () => {
    const harness = newHarness({ getId: () => USER_ID, browser: { name: 'chrome', major: 131 } });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope).toMatchObject({
      browser_language: 'pt-BR',
      ui_language: 'zh-Hant-TW',
      browser: { name: 'chrome', major: 131 },
      id: USER_ID,
    });
  });

  it('keeps identified events while the product does not know the id yet, and sends them with it once it does', async () => {
    let id: string | undefined;
    const harness = newHarness({ getId: () => id, browser: { name: 'chrome', major: 131 } });

    await harness.collector.track('before_sign_in');
    await harness.settle();
    expect(harness.fetch.requests).toEqual([]);

    id = USER_ID;
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['before_sign_in']);
    expect(harness.fetch.requests[0]?.envelope).toMatchObject({ id: USER_ID, browser: { name: 'chrome', major: 131 } });
  });
});

describe('installed and updated', () => {
  it('sends installed once per install, across restarts', async () => {
    const harness = newHarness();

    await harness.collector.installed();
    await harness.collector.installed();
    await harness.restart().installed();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['installed']);
  });

  it('sends updated once when the version changes, and not right after installed', async () => {
    const harness = newHarness();
    await harness.collector.installed();
    await harness.collector.updated();

    const upgraded = harness.restart({ version: '4.3.0' });
    await upgraded.updated();
    await upgraded.updated();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['installed', 'updated']);
    expect(harness.fetch.requests.at(-1)?.envelope.version).toBe('4.3.0');
  });
});

describe('storage', () => {
  it('keeps every key under artel. and its channel key', async () => {
    const keys = new Set<string>();
    const inner = newMemoryStorage();
    const recording: StorageAdapter = {
      get: (key) => {
        keys.add(key);
        return inner.get(key);
      },
      set: (key, value) => {
        keys.add(key);
        return inner.set(key, value);
      },
    };
    const harness = newHarness({ storage: recording });

    await harness.collector.installed();
    await harness.collector.updated();
    await harness.collector.track('a');
    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.uninstallParams();

    expect(keys.size).toBeGreaterThan(0);
    expect([...keys].filter((key) => !key.startsWith(`artel.${KEY}.`))).toEqual([]);
  });

  it('keeps collectors of two channel keys over one storage apart, so neither drops the events of the other', async () => {
    const harness = newHarness({ platform: Platform.Web, sendDelaySeconds: 3600 });
    const otherProduct = harness.restart({ key: 'site-bbbbbbbbbb' });

    await harness.collector.track('from_a');
    await otherProduct.setState(AnalyticsState.OptedOut);
    await otherProduct.setState(AnalyticsState.Anonymous);
    await otherProduct.track('from_b');
    await otherProduct.flush();
    await harness.collector.flush();

    expect(
      harness.fetch.requests.map((request) => [
        request.envelope.key,
        request.envelope.events.map((event) => [event.name, event.first]),
      ]),
    ).toEqual([
      ['site-bbbbbbbbbb', [['opted_out', undefined]]],
      ['site-bbbbbbbbbb', [['from_b', ALL_PERIODS]]],
      [SITE_KEY, [['from_a', ALL_PERIODS]]],
    ]);
    expect(harness.errors).toEqual([]);
  });
});
