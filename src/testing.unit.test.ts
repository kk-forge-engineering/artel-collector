import { describe, expect, it } from 'vitest';
import { AnalyticsState, Mode } from './exports.js';
import { newRecordingCollector, queuedEvents } from './testing.js';
import { KEY, newHarness, QUEUE_KEY } from '../tests/harness.js';
import { fromUntypedHost } from '../tests/untypedHost.js';

describe('newRecordingCollector', () => {
  it('records the events it takes, starting anonymous, and sends nothing', async () => {
    const collector = newRecordingCollector();

    await collector.installed();
    await collector.installed();
    await collector.updated();
    await collector.track('report_exported', { format: 'pdf' });
    await collector.flush();

    expect(collector.events).toEqual([
      { name: 'installed' },
      { name: 'updated' },
      { name: 'report_exported', params: { format: 'pdf' } },
    ]);
    expect(await collector.getState()).toBe('anonymous');
    expect(await collector.uninstallParams()).toBeUndefined();
  });

  it('keeps the state and records nothing while opted out', async () => {
    const collector = newRecordingCollector(Mode.Anonymous);

    await collector.setState(AnalyticsState.OptedOut);
    await collector.track('a');
    await collector.installed();
    await collector.forget('user');

    expect(await collector.getState()).toBe('opted_out');
    expect(collector.events).toEqual([]);
  });

  it('refuses an event track refuses, with the same report', async () => {
    const errors: Error[] = [];
    const collector = newRecordingCollector(Mode.Anonymous, { onError: (error) => errors.push(error) });

    await collector.track('Report', { pages: 1 });
    await collector.track('a', { pages: Number.NaN });

    const harness = newHarness();
    await harness.collector.track('Report', { pages: 1 });
    await harness.collector.track('a', { pages: Number.NaN });
    expect(collector.events).toEqual([]);
    expect(errors).toEqual(harness.errors);
    expect(errors).toHaveLength(2);
  });

  it('refuses a state above its mode', async () => {
    const errors: Error[] = [];
    const collector = newRecordingCollector(Mode.Anonymous, { onError: (error) => errors.push(error) });

    await collector.setState(fromUntypedHost(AnalyticsState.Pseudonymous));

    expect(await collector.getState()).toBe('anonymous');
    expect(errors).toEqual([new TypeError('artel: a channel of mode "anonymous" takes no state "pseudonymous"')]);
  });

  it('takes every state by default', async () => {
    const collector = newRecordingCollector();

    await collector.setState(AnalyticsState.Identified);

    expect(await collector.getState()).toBe('identified');
  });
});

describe('queuedEvents', () => {
  it('returns the names and params of the events a collector queued in its storage', async () => {
    const harness = newHarness();
    await harness.collector.track('a', { pages: 2 });
    await harness.collector.track('b');

    expect(await queuedEvents(harness.storage, KEY)).toEqual([{ name: 'a', params: { pages: 2 } }, { name: 'b' }]);
    expect(await queuedEvents(harness.storage, 'site-aa131n3j11')).toEqual([]);
  });

  it('reads a stored queue that is no JSON list as empty', async () => {
    const harness = newHarness();
    await harness.storage.set(QUEUE_KEY, '{not json');

    expect(await queuedEvents(harness.storage, KEY)).toEqual([]);
  });
});
