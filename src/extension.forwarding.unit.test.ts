import { describe, expect, it, vi } from 'vitest';
import { forwardTrack, newContentScriptCollector } from './extension.js';
import { newExtensionHarness, stubChrome, type ExtensionHarness } from '../tests/fakeChrome.js';
import { FakeClock } from '../tests/fakeClock.js';

const FROM_OTHER_EXTENSION = { id: 'abcdefghijklmnopabcdefghijklmnop' };

/** Builds the service worker's collector, which accepts forwarded events and counts the limit's minutes by its clock. */
function startForwarding(): { chrome: ExtensionHarness['chrome']; harness: ExtensionHarness } {
  const harness = newExtensionHarness({ isWorker: true });
  return { chrome: harness.chrome, harness };
}

function timesTracked(harness: ExtensionHarness, name: string): number {
  return harness.fetch.eventNames.filter((eventName) => eventName === name).length;
}

describe('forwarding from a content script', () => {
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
    const { chrome, harness } = startForwarding();

    await chrome.runtime.sendMessage(message);
    await harness.settle();

    expect(harness.fetch.requests).toHaveLength(0);
  });

  it('tracks a forwarded event at the limits of a product event list', async () => {
    const { harness } = startForwarding();
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

  it('reports the first forwarded event it drops in each minute, and no more of that minute', async () => {
    const { harness } = startForwarding();
    const report = new Error('artel: the worker tracks at most 60 forwarded events a minute, so it dropped the rest');

    for (let index = 0; index < 62; index++) {
      await forwardTrack('a');
    }
    expect(harness.errors).toEqual([report]);
    harness.clock.jumpMinutes(1);
    for (let index = 0; index < 61; index++) {
      await forwardTrack('b');
    }

    expect(harness.errors).toEqual([report, report]);
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
    const { chrome, harness } = startForwarding();

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

  it('has track alone and touches no storage', async () => {
    const { chrome, harness } = startForwarding();

    const collector = newContentScriptCollector();
    await harness.settle();

    expect([Object.keys(collector), harness.fetch.requests, chrome.items.size]).toEqual([['track'], [], 0]);
  });

  it('forwards the first of a series inside throttleMs, in its own memory, and again after the window', async () => {
    const { chrome, harness } = startForwarding();
    const forwarded: unknown[] = [];
    const sendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (message, sender) => {
      forwarded.push(message);
      return sendMessage(message, sender);
    };
    const clock = new FakeClock('2026-10-29T10:00:00');
    const collector = newContentScriptCollector({ clock });

    for (const step of [0, 100, 399, 1, 100]) {
      await clock.advance(step);
      await collector.track('undo_pressed', undefined, { throttleMs: 400 });
    }
    await collector.track('redo_pressed', undefined, { throttleMs: 400 });
    await harness.settle();

    expect(forwarded).toHaveLength(3);
    expect(harness.fetch.eventNames).toEqual(['undo_pressed', 'undo_pressed', 'redo_pressed']);
  });

  it('forwards nothing for a throttleMs that is no finite number from 0, and opens no window', async () => {
    const { harness } = startForwarding();
    const collector = newContentScriptCollector();

    await collector.track('undo_pressed', undefined, { throttleMs: -1 });
    await collector.track('undo_pressed', undefined, { throttleMs: 400 });
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['undo_pressed']);
  });

  it('forwards a call without throttleMs whatever the window, and opens none for it', async () => {
    const { harness } = startForwarding();
    const collector = newContentScriptCollector();

    await collector.track('undo_pressed');
    await collector.track('undo_pressed', undefined, { throttleMs: 400 });
    await collector.track('undo_pressed');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['undo_pressed', 'undo_pressed', 'undo_pressed']);
  });

  it("opens no window of the worker's collector for a forwarded event", async () => {
    const { chrome, harness } = startForwarding();

    await chrome.runtime.sendMessage({ type: 'artel.track', name: 'undo_pressed' });
    await harness.collector.track('undo_pressed', undefined, { throttleMs: 400 });
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['undo_pressed', 'undo_pressed']);
  });

  it('throws nothing outside an extension or with no worker', async () => {
    vi.stubGlobal('chrome', undefined);

    await expect(newContentScriptCollector().track('a')).resolves.toBeUndefined();
    stubChrome().isWorkerGone = true;
    await expect(newContentScriptCollector().track('a')).resolves.toBeUndefined();
  });
});
