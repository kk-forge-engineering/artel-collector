import { describe, expect, it } from 'vitest';
import { AnalyticsState } from './exports.js';
import { newHarness, USER_ID } from '../tests/harness.js';

describe('session', () => {
  it('keeps one session id of 12 characters from [0-9a-z] while the user stays active', async () => {
    const harness = newHarness();

    await harness.collector.track('a');
    for (let step = 0; step < 4; step++) {
      harness.clock.jumpMinutes(9);
      await harness.collector.track('b');
      await harness.settle();
    }
    await harness.settle();

    const sessions = new Set(harness.fetch.requests.map((request) => request.envelope.session));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(/^[0-9a-z]{12,}$/);
  });

  it('starts a new session after 10 minutes without events', async () => {
    const harness = newHarness();

    await harness.collector.track('a');
    harness.clock.jumpMinutes(10);
    await harness.collector.track('b');
    await harness.settle();

    const [first, second] = harness.fetch.requests.map((request) => request.envelope.session);
    expect(harness.fetch.requests).toHaveLength(2);
    expect(first).not.toBe(second);
  });

  it('keeps the session through the idle time the host sets', async () => {
    const harness = newHarness({ sessionIdleMinutes: 30 });

    await harness.collector.track('a');
    harness.clock.jumpMinutes(29);
    await harness.collector.track('b');
    await harness.settle();

    expect(new Set(harness.fetch.requests.map((request) => request.envelope.session)).size).toBe(1);
  });

  it('starts a new session on a new local day, however active the user stays', async () => {
    const harness = newHarness();
    harness.clock.setLocal('2026-10-29T23:58:00');

    await harness.collector.track('a');
    harness.clock.jumpMinutes(5);
    await harness.collector.track('b');
    await harness.settle();

    const [first, second] = harness.fetch.requests.map((request) => request.envelope.session);
    expect(harness.fetch.requests).toHaveLength(2);
    expect(first).not.toBe(second);
  });

  it('keeps the session across a restart of the host', async () => {
    const harness = newHarness();
    await harness.collector.track('a');
    await harness.settle();

    harness.clock.jumpMinutes(5);
    await harness.restart().track('b');
    await harness.settle();

    const [first, second] = harness.fetch.requests.map((request) => request.envelope.session);
    expect(second).toBe(first);
  });
});

describe('uninstall parameters', () => {
  it.each([
    { activeDays: 0, bucket: '0' },
    { activeDays: 1, bucket: '1' },
    { activeDays: 2, bucket: '2-5' },
    { activeDays: 5, bucket: '2-5' },
    { activeDays: 6, bucket: '6-20' },
    { activeDays: 20, bucket: '6-20' },
    { activeDays: 21, bucket: '21+' },
  ])('puts $activeDays active days into the bucket $bucket', async ({ activeDays, bucket }) => {
    const harness = newHarness();
    harness.clock.setLocal('2026-01-01T10:00:00');
    await harness.collector.getState();
    for (let day = 0; day < activeDays; day++) {
      // Two events on each active day: only the first event of a day counts it.
      await harness.collector.track('a');
      await harness.collector.track('b');
      // Sent, so the 20-envelope cap drops no day's events and gives back no day.
      await harness.collector.flush();
      harness.clock.jumpMinutes(3 * 24 * 60);
    }
    harness.clock.setLocal('2026-04-11T10:00:00');

    expect((await harness.collector.uninstallParams())?.active_days).toBe(bucket);
  });

  it('gives the primary languages and the age as a bucket in the anonymous state', async () => {
    const harness = newHarness();
    harness.clock.setLocal('2026-01-01T10:00:00');
    await harness.collector.getState();
    harness.clock.setLocal('2026-01-11T10:00:00');

    expect(await harness.collector.uninstallParams()).toEqual({
      platform: 'extension',
      version: '4.2.0',
      browser_language: 'pt',
      ui_language: 'zh',
      age_days: 7,
      active_days: '0',
    });
  });

  it('gives the full languages and the age up to 31 days in the identified state', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    harness.clock.setLocal('2026-01-01T10:00:00');
    await harness.collector.getState();
    harness.clock.setLocal('2026-04-11T10:00:00');

    expect(await harness.collector.uninstallParams()).toMatchObject({
      browser_language: 'pt-BR',
      ui_language: 'zh-Hant-TW',
      age_days: 31,
    });
  });

  it('gives nothing in the opted_out state', async () => {
    const harness = newHarness({ state: AnalyticsState.OptedOut });

    expect(await harness.collector.uninstallParams()).toBeUndefined();
  });

  it('leaves out the languages the host did not give', async () => {
    const harness = newHarness({ browserLanguage: undefined, uiLanguage: undefined });

    const params = await harness.collector.uninstallParams();
    expect(params).not.toHaveProperty('browser_language');
    expect(params).not.toHaveProperty('ui_language');
  });
});
