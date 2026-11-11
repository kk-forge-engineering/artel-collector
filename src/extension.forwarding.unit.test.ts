import { describe, expect, it, vi } from 'vitest';
import { acceptForwarded, forwardTrack, newContentScriptCollector } from './extension.js';
import { newHarness, type Harness } from '../tests/harness.js';
import { stubChrome, type FakeChrome } from '../tests/fakeChrome.js';

const FROM_OTHER_EXTENSION = { id: 'abcdefghijklmnopabcdefghijklmnop' };

/** Starts accepting forwarded events on the harness clock, which the limit counts its minutes by. */
function startForwarding(): { chrome: FakeChrome; harness: Harness } {
  const chrome = stubChrome();
  const harness = newHarness();
  acceptForwarded(harness.collector, { clock: harness.clock });
  return { chrome, harness };
}

function timesTracked(harness: Harness, name: string): number {
  return harness.fetch.eventNames.filter((eventName) => eventName === name).length;
}

describe('forwarding from a content script', () => {
  it('tracks a forwarded event in the worker, and nothing once stopped', async () => {
    stubChrome();
    const harness = newHarness();
    const stop = acceptForwarded(harness.collector);

    await forwardTrack('link_shared', { target: 'clipboard' });
    await harness.settle();
    stop();
    await forwardTrack('link_opened');
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.params])).toEqual([
      ['link_shared', { target: 'clipboard' }],
    ]);
  });

  // The worker refuses these names, the intake's `system_events`. The intake takes them from every product and skips
  // the product's allowlist, so a content script could send them past that check.
  it.each(['installed', 'updated', 'uninstalled', 'welcome_opened', 'opted_out', 'page_view', 'install_click'])(
    'ignores the system event %s from a content script',
    async (name) => {
      const { chrome, harness } = startForwarding();

      await chrome.runtime.sendMessage({ type: 'artel.track', name });
      await harness.settle();

      expect(harness.fetch.requests).toHaveLength(0);
    },
  );

  it.each([
    ['another type', { type: 'other', name: 'a' }],
    ['no name', { type: 'artel.track' }],
    ['params that are not values', { type: 'artel.track', name: 'a', params: { nested: { deep: true } } }],
    ['params that are a list', { type: 'artel.track', name: 'a', params: ['a', 'b'] }],
    ['no object', 'artel.track'],
    ['a name past 40 characters', { type: 'artel.track', name: 'a'.repeat(41) }],
    ['a name with a capital', { type: 'artel.track', name: 'Report' }],
    ['a param that is not a finite number', { type: 'artel.track', name: 'a', params: { pages: Number.NaN } }],
    ['a param name past 40 characters', { type: 'artel.track', name: 'a', params: { ['p'.repeat(41)]: 1 } }],
    ['a string param past 64 characters', { type: 'artel.track', name: 'a', params: { source: 's'.repeat(65) } }],
    [
      'more than 16 params',
      {
        type: 'artel.track',
        name: 'a',
        params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, i])),
      },
    ],
  ])('ignores a message with %s', async (_, message) => {
    const chrome = stubChrome();
    const harness = newHarness();
    acceptForwarded(harness.collector);

    await chrome.runtime.sendMessage(message);
    await harness.settle();

    expect(harness.fetch.requests).toHaveLength(0);
  });

  it('tracks a forwarded event at the limits of a product event list', async () => {
    stubChrome();
    const harness = newHarness();
    acceptForwarded(harness.collector);
    const params = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`p${index}`, index]));
    // The test uses 64 characters outside the basic plane, 128 UTF-16 units. The intake counts characters, so this
    // string is still at its limit.
    const text = '😀'.repeat(64);

    await forwardTrack('a'.repeat(40), { ...params, ['q'.repeat(40)]: text });
    await harness.settle();

    expect(harness.fetch.events.map((event) => event.params?.['q'.repeat(40)])).toEqual([text]);
  });

  it('tracks at most 60 forwarded events a minute, however many contexts forward them', async () => {
    const { harness } = startForwarding();

    for (let index = 0; index < 61; index++) {
      await forwardTrack('a');
    }
    harness.clock.jumpMinutes(1);
    await forwardTrack('b');
    await harness.settle();

    expect(timesTracked(harness, 'a')).toBe(60);
    expect(timesTracked(harness, 'b')).toBe(1);
  });

  it('starts a new minute when the clock is set back an hour', async () => {
    const { harness } = startForwarding();

    for (let index = 0; index < 61; index++) {
      await forwardTrack('a');
    }
    harness.clock.jumpMinutes(-60);
    await forwardTrack('b');
    await harness.settle();

    expect(timesTracked(harness, 'b')).toBe(1);
  });

  it('refuses params past 16 without reading their values', async () => {
    const { chrome, harness } = startForwarding();
    let reads = 0;
    const params = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`p${index}`, 1]));
    for (const key of Object.keys(params)) {
      Object.defineProperty(params, key, {
        enumerable: true,
        get: () => {
          reads++;
          return 1;
        },
      });
    }

    await chrome.runtime.sendMessage({ type: 'artel.track', name: 'a', params });
    await harness.settle();

    expect(reads).toBe(0);
    expect(harness.fetch.requests).toEqual([]);
  });

  it('refuses a param of ten million characters without counting its characters', async () => {
    const { chrome, harness } = startForwarding();
    const long = 'x'.repeat(10_000_000);
    const from = vi.spyOn(Array, 'from');

    await chrome.runtime.sendMessage({ type: 'artel.track', name: 'a', params: { long } });
    const counted = from.mock.calls.map(([value]) => value);
    from.mockRestore();
    await harness.settle();

    expect(counted).not.toContain(long);
    expect(harness.fetch.requests).toEqual([]);
  });

  it('counts no message it refuses toward the limit', async () => {
    const { chrome, harness } = startForwarding();

    await forwardTrack('a');
    for (let index = 0; index < 60; index++) {
      await forwardTrack('opted_out');
      await forwardTrack('a', { pages: Number.NaN });
      await chrome.runtime.sendMessage({ type: 'artel.track', name: 'a' }, FROM_OTHER_EXTENSION);
    }
    await forwardTrack('b');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['a', 'b']);
  });

  it('ignores a message from another extension', async () => {
    const chrome = stubChrome();
    const harness = newHarness();
    acceptForwarded(harness.collector);

    await chrome.runtime.sendMessage({ type: 'artel.track', name: 'a' }, FROM_OTHER_EXTENSION);
    await harness.settle();

    expect(harness.fetch.requests).toHaveLength(0);
  });

  it('resolves in the content script when the worker cannot be reached', async () => {
    stubChrome().isWorkerGone = true;

    await expect(forwardTrack('link_shared')).resolves.toBeUndefined();
  });
});

describe('newContentScriptCollector', () => {
  it('hands each tracked event to the worker, which tracks it', async () => {
    const { harness } = startForwarding();

    await newContentScriptCollector().track('link_shared', { target: 'clipboard' });
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.params])).toEqual([
      ['link_shared', { target: 'clipboard' }],
    ]);
  });

  it('sends nothing of its own on flush and touches no storage', async () => {
    const { chrome, harness } = startForwarding();

    await newContentScriptCollector().flush();
    await harness.settle();

    expect([harness.fetch.requests, chrome.items.size]).toEqual([[], 0]);
  });

  it('throws nothing outside an extension or with no worker', async () => {
    vi.stubGlobal('chrome', undefined);

    await expect(newContentScriptCollector().track('a')).resolves.toBeUndefined();
    stubChrome().isWorkerGone = true;
    await expect(newContentScriptCollector().track('a')).resolves.toBeUndefined();
  });
});
