import { describe, expect, it } from 'vitest';
import { AnalyticsState, newMemoryStorage, Platform, type StorageAdapter } from './exports.js';
import {
  DESKTOP_KEY,
  FORGET_URL,
  KEY,
  newHarness,
  SEND_DELAY_MS,
  SITE_KEY,
  storageKey,
  USER_ID,
} from '../tests/harness.js';

const PLATFORM_KEYS = [
  [Platform.Web, SITE_KEY],
  [Platform.MacOs, DESKTOP_KEY],
  [Platform.Extension, KEY],
] as const;

/** Returns a storage whose queue holds the event `a` of a collector on `platform` that stopped before its send. */
async function storageLeftBy(platform: Platform): Promise<StorageAdapter> {
  // The stopped collector's clock never moves, so its own send never starts.
  const stopped = newHarness({ platform });
  await stopped.collector.track('a');
  return stopped.storage;
}

describe('a queue an earlier page or window left', () => {
  it.each(PLATFORM_KEYS)('goes within the send delay of a new %s collector, before any call', async (platform) => {
    const storage = await storageLeftBy(platform);

    const { clock, fetch } = newHarness({ platform, storage });
    await clock.advance(SEND_DELAY_MS - 1);
    const sentWithinDelay = fetch.eventNames.length;
    await clock.advance(1);

    expect([sentWithinDelay, fetch.eventNames]).toEqual([0, ['a']]);
  });

  it.each(PLATFORM_KEYS)('waits for the stored retry time on %s', async (platform, key) => {
    const storage = await storageLeftBy(platform);
    const { clock, fetch } = newHarness({ platform, storage });
    await storage.set(storageKey('retry_at', key), String(clock.now() + 60_000));

    await clock.advance(SEND_DELAY_MS);
    const sentBeforeRetry = fetch.eventNames.length;
    await clock.advance(60_000);

    expect([sentBeforeRetry, fetch.eventNames]).toEqual([0, ['a']]);
  });

  it('sends a stored forget request when the queue holds nothing else', async () => {
    const storage = newMemoryStorage();
    await storage.set(storageKey('forgets', SITE_KEY), JSON.stringify([USER_ID]));

    const { clock, fetch } = newHarness({ platform: Platform.Web, storage });
    await clock.advance(SEND_DELAY_MS);

    expect(fetch.forgets).toEqual([{ url: FORGET_URL, key: SITE_KEY, id: USER_ID }]);
  });

  it('never goes once the stored state is opted_out', async () => {
    const storage = await storageLeftBy(Platform.Web);
    await storage.set(storageKey('state', SITE_KEY), AnalyticsState.OptedOut);

    const { clock, fetch } = newHarness({ platform: Platform.Web, storage });
    await clock.advance(SEND_DELAY_MS);

    expect(fetch.eventNames).toEqual([]);
  });
});
