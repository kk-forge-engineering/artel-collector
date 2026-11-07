import { describe, expect, it, vi } from 'vitest';
import { acceptForwarded, newChromeStorageAdapter, forwardTrack, refreshUninstallUrl } from './extension.js';
import type { EventParams } from './exports.js';
import { newHarness, type Harness } from '../tests/harness.js';

const EXTENSION_ID = 'faalhcmobmdfdmmniiplhoniamdooejf';
const FROM_OTHER_EXTENSION = { id: 'abcdefghijklmnopabcdefghijklmnop' };

type MessageListener = (message: unknown, sender: { id?: string }) => undefined;

class FakeChrome {
  readonly items = new Map<string, unknown>();
  readonly sessionItems = new Map<string, unknown>();
  readonly listeners = new Set<MessageListener>();
  uninstallUrl = '';
  isWorkerGone = false;

  readonly storage = {
    local: {
      get: async (key: string): Promise<Record<string, unknown>> =>
        this.items.has(key) ? { [key]: this.items.get(key) } : {},
      set: async (items: Record<string, unknown>): Promise<void> => {
        for (const [key, value] of Object.entries(items)) {
          this.items.set(key, value);
        }
      },
    },
    session: {
      get: async (key: string): Promise<Record<string, unknown>> =>
        this.sessionItems.has(key) ? { [key]: this.sessionItems.get(key) } : {},
      set: async (items: Record<string, unknown>): Promise<void> => {
        for (const [key, value] of Object.entries(items)) {
          this.sessionItems.set(key, value);
        }
      },
    },
  };

  readonly runtime = {
    id: EXTENSION_ID,
    sendMessage: async (message: unknown, sender: { id?: string } = { id: EXTENSION_ID }): Promise<unknown> => {
      if (this.isWorkerGone) {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      for (const listener of this.listeners) {
        listener(message, sender);
      }
      return undefined;
    },
    setUninstallURL: async (url: string): Promise<void> => {
      this.uninstallUrl = url;
    },
    onMessage: {
      addListener: (listener: MessageListener): void => void this.listeners.add(listener),
      removeListener: (listener: MessageListener): void => void this.listeners.delete(listener),
    },
  };
}

function stubChrome(): FakeChrome {
  const chrome = new FakeChrome();
  vi.stubGlobal('chrome', chrome);
  return chrome;
}

/** Starts accepting forwarded events on the harness clock, which the budget counts its minutes by. */
function startForwarding(): { chrome: FakeChrome; harness: Harness; stop: () => void } {
  const chrome = stubChrome();
  const harness = newHarness();
  const stop = acceptForwarded(harness.collector, { clock: harness.clock });
  return { chrome, harness, stop };
}

/** Forwards an event `times` times, each once the one before it reached the worker. */
async function forwardOneByOne({
  times,
  name,
  params,
}: {
  times: number;
  name: string;
  params?: EventParams;
}): Promise<void> {
  for (let index = 0; index < times; index++) {
    await forwardTrack(name, params);
  }
}

/** Forwards an event `times` times before the worker takes any of them. */
function forwardAllAtOnce(times: number, name: string): void {
  for (let index = 0; index < times; index++) {
    void forwardTrack(name);
  }
}

function timesTracked(harness: Harness, name: string): number {
  return harness.fetch.eventNames.filter((eventName) => eventName === name).length;
}

describe('newChromeStorageAdapter', () => {
  it('keeps string values in chrome.storage.local and answers undefined for others', async () => {
    const chrome = stubChrome();
    const storage = newChromeStorageAdapter();

    await storage.set('artel.session', 'k3j9x2m1qa0b');
    chrome.items.set('artel.number', 1);

    expect(await storage.get('artel.session')).toBe('k3j9x2m1qa0b');
    expect(await storage.get('artel.number')).toBeUndefined();
    expect(await storage.get('artel.missing')).toBeUndefined();
  });

  it('rejects outside an extension, so the collector reports it', async () => {
    vi.stubGlobal('chrome', undefined);

    await expect(newChromeStorageAdapter().get('artel.session')).rejects.toThrow('chrome extension API');
  });
});

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

  it.each([
    ['another type', { type: 'other', name: 'a' }],
    ['no name', { type: 'artel.track' }],
    ['params that are not values', { type: 'artel.track', name: 'a', params: { nested: { deep: true } } }],
    ['params that are a list', { type: 'artel.track', name: 'a', params: ['a', 'b'] }],
    ['no object', 'artel.track'],
    ['an event the collector sends itself', { type: 'artel.track', name: 'usage_counts_off' }],
    ['a name past 40 characters', { type: 'artel.track', name: 'a'.repeat(41) }],
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

    await forwardOneByOne({ times: 61, name: 'a' });
    harness.clock.jumpMinutes(1);
    await forwardTrack('b');
    await harness.settle();

    expect(timesTracked(harness, 'a')).toBe(60);
    expect(timesTracked(harness, 'b')).toBe(1);
  });

  it('keeps the budget spent for the whole minute', async () => {
    const { harness } = startForwarding();

    await forwardOneByOne({ times: 60, name: 'a' });
    harness.clock.jumpMinutes(59 / 60);
    await forwardTrack('b');
    await harness.settle();

    expect(timesTracked(harness, 'b')).toBe(0);
  });

  it('spends no budget on a message it refuses', async () => {
    const { chrome, harness } = startForwarding();

    await forwardTrack('a');
    for (let index = 0; index < 60; index++) {
      await forwardTrack('usage_counts_off');
      await chrome.runtime.sendMessage({ type: 'artel.track', name: 'a' }, FROM_OTHER_EXTENSION);
    }
    await forwardTrack('b');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['a', 'b']);
  });

  it('keeps the budget spent when the worker restarts within the minute', async () => {
    const { harness, stop } = startForwarding();
    await forwardOneByOne({ times: 60, name: 'a' });
    await harness.clock.advance(0);
    stop();

    acceptForwarded(harness.restart(), { clock: harness.clock });
    await forwardTrack('b');
    await harness.settle();

    expect(timesTracked(harness, 'b')).toBe(0);
  });

  it.each([
    // Small events meet the count first. Large ones, 1220 bytes each, meet the bytes after 49.
    ['count', { tracked: -1e12, bytes: 0 }, {}, 60],
    [
      'bytes',
      { tracked: 0, bytes: -1e12 },
      Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`p${i}`, 'x'.repeat(64)])),
      49,
    ],
  ])('starts an empty budget over a stored budget whose %s is out of range', async (_, counts, params, tracked) => {
    const chrome = stubChrome();
    const harness = newHarness();
    chrome.sessionItems.set('artel.forwardBudget', { minuteStart: harness.clock.now(), ...counts });
    acceptForwarded(harness.collector, { clock: harness.clock });
    const name = 'a'.repeat(40);

    await forwardOneByOne({ times: 400, name, params });
    await harness.clock.advance(60_000);

    expect(harness.fetch.eventNames).toHaveLength(tracked);
  });

  it('holds at most 120 forwarded events waiting for the budget', () => {
    startForwarding();
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');

    forwardAllAtOnce(1000, 'a');

    // The worker sizes each event it lets wait, before anything else runs.
    expect(encode).toHaveBeenCalledTimes(120);
    encode.mockRestore();
  });

  it('takes new forwarded events once the waiting ones had their turn', async () => {
    const { harness } = startForwarding();
    forwardAllAtOnce(1000, 'a');
    await harness.clock.advance(0);

    harness.clock.jumpMinutes(1);
    forwardAllAtOnce(120, 'b');
    await harness.settle();

    expect(timesTracked(harness, 'b')).toBe(60);
  });

  it('keeps the budget in memory without session storage', async () => {
    const chrome = stubChrome();
    Reflect.deleteProperty(chrome.storage, 'session');
    const harness = newHarness();
    acceptForwarded(harness.collector, { clock: harness.clock });

    await forwardOneByOne({ times: 61, name: 'a' });
    await harness.settle();

    expect(harness.fetch.eventNames).toHaveLength(60);
  });

  it('starts a new minute when the clock is set back', async () => {
    const { harness } = startForwarding();

    await forwardOneByOne({ times: 60, name: 'a' });
    harness.clock.jumpMinutes(-60);
    await forwardTrack('b');
    await harness.settle();

    expect(timesTracked(harness, 'b')).toBe(1);
  });

  it('tracks at most 60 kB of forwarded names and params a minute', async () => {
    const { harness } = startForwarding();
    // 16 params of 64 characters past the basic plane, 4255 bytes an event, so 14 fit in 60 kB.
    const params = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`p${index}`, '😀'.repeat(64)]));

    await forwardOneByOne({ times: 20, name: 'big', params });
    await harness.clock.advance(60_000);

    expect(harness.fetch.eventNames).toHaveLength(14);
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

describe('refreshUninstallUrl', () => {
  it('sets the uninstall page with the uninstall parameters, keeping its own query', async () => {
    const chrome = stubChrome();
    const harness = newHarness();

    await refreshUninstallUrl(harness.collector, 'https://example.com/uninstall?product=demo');

    const url = new URL(chrome.uninstallUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      product: 'demo',
      platform: 'extension',
      version: '4.2.0',
      lang: 'en',
      age: '0',
      days: '0',
    });
  });
});
