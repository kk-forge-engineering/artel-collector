import { describe, expect, it } from 'vitest';
import { newMemoryStorage, type StorageAdapter } from './exports.js';
import { newHarness } from '../tests/harness.js';

describe('usage counts switch', () => {
  it('sends usage_counts_off at once, drops what was not sent yet, then sends nothing until switched back on', async () => {
    const harness = newHarness();
    await harness.collector.track('before');

    await harness.collector.setEnabled(false);
    expect(harness.fetch.eventNames).toEqual(['usage_counts_off']);

    await harness.collector.track('while_off');
    await harness.collector.installed();
    await harness.collector.flush();
    await harness.settle();
    expect(harness.fetch.eventNames).toEqual(['usage_counts_off']);

    await harness.collector.setEnabled(true);
    await harness.collector.track('after');
    await harness.settle();
    expect(harness.fetch.eventNames).toEqual(['usage_counts_off', 'usage_counts_on', 'after']);
  });

  it('keeps the switch across a restart of the host', async () => {
    const harness = newHarness();
    await harness.collector.setEnabled(false);

    const restarted = harness.restart();
    await restarted.track('a');
    await harness.settle();

    expect(await restarted.isEnabled()).toBe(false);
    expect(harness.fetch.eventNames).toEqual(['usage_counts_off']);
  });

  it('is on by default', async () => {
    const harness = newHarness();

    expect(await harness.collector.isEnabled()).toBe(true);
  });

  it('sends nothing when switched to the state it is already in', async () => {
    const harness = newHarness();

    await harness.collector.setEnabled(true);
    await harness.collector.setEnabled(false);
    await harness.collector.setEnabled(false);
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['usage_counts_off']);
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
    harness.clock.jumpMinutes(11);
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
    await harness.collector.isEnabled();
    for (let day = 0; day < activeDays; day++) {
      // Two events on each active day: only the first event of a day counts it.
      await harness.collector.track('a');
      await harness.collector.track('b');
      harness.clock.jumpMinutes(3 * 24 * 60);
    }
    harness.clock.setLocal('2026-04-11T10:00:00');

    expect(await harness.collector.uninstallParams()).toEqual({
      platform: 'extension',
      version: '4.2.0',
      lang: 'en',
      age: 100,
      days: bucket,
    });
  });

  it('leaves out lang the host did not give', async () => {
    const harness = newHarness({ lang: undefined });

    expect(await harness.collector.uninstallParams()).not.toHaveProperty('lang');
  });
});

describe('storage', () => {
  it('keeps every key under the artel. prefix', async () => {
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
    await harness.collector.setEnabled(false);
    await harness.collector.uninstallParams();

    expect(keys.size).toBeGreaterThan(0);
    expect([...keys].filter((key) => !key.startsWith('artel.'))).toEqual([]);
  });
});
