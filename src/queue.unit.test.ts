import { describe, expect, it } from 'vitest';
import { newQueue } from './queue.js';
import { newMemoryStorage } from './storage.js';
import { KEY, QUEUE_KEY, VERSION } from '../tests/harness.js';

const FIELDS = {
  key: KEY,
  platform: 'extension',
  version: VERSION,
  session: 'k3j9x2m1qa0b',
} as const;
const EVENT = { name: 'a', day: '2026-10-29' };
const FIRST_LEASE = { holder: 'first', now: 0, until: 60_000 };

describe('leases', () => {
  it('keeps the lease another holder took after ours ran out when we release', async () => {
    const queue = newQueue({ storage: newMemoryStorage(), reportError: () => undefined });
    await queue.add(FIELDS, EVENT);
    const [ours] = await queue.lease(FIRST_LEASE);
    await queue.lease({ holder: 'second', now: 61_000, until: 121_000 });

    await queue.release('first', [ours?.qid ?? '']);

    expect(await queue.lease({ holder: 'third', now: 62_000, until: 122_000 })).toHaveLength(0);
  });

  it('refuses to seal an envelope another holder took after our lease ran out', async () => {
    const queue = newQueue({ storage: newMemoryStorage(), reportError: () => undefined });
    await queue.add(FIELDS, EVENT);
    const [ours] = await queue.lease(FIRST_LEASE);
    await queue.lease({ holder: 'second', now: 61_000, until: 121_000 });

    expect(await queue.seal(ours?.qid ?? '', { holder: 'first', now: 62_000, until: 122_000 })).toBeUndefined();
  });
});

describe('stored queue', () => {
  it('drops and reports a sealed envelope whose stored body is not its envelope', async () => {
    const storage = newMemoryStorage();
    const errors: unknown[] = [];
    const queue = newQueue({ storage, reportError: (error) => errors.push(error) });
    await queue.add(FIELDS, EVENT);
    const [item] = await queue.lease(FIRST_LEASE);
    await queue.seal(item?.qid ?? '', FIRST_LEASE);
    const stored = (await storage.get(QUEUE_KEY)) ?? '';
    await storage.set(QUEUE_KEY, stored.replace(/"body":"(?:[^"\\]|\\.)*"/, '"body":"{}"'));

    expect(await queue.seal(item?.qid ?? '', FIRST_LEASE)).toBeUndefined();
    expect(await queue.lease({ holder: 'second', now: 0, until: 60_000 })).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('seals the same body again after a round trip through storage', async () => {
    const queue = newQueue({ storage: newMemoryStorage(), reportError: () => undefined });
    await queue.add(FIELDS, { ...EVENT, first: ['day'], age_days: 3, params: { mode: 'visible', n: 2, ok: true } });
    const [item] = await queue.lease(FIRST_LEASE);
    const sealed = await queue.seal(item?.qid ?? '', FIRST_LEASE);

    expect((await queue.seal(item?.qid ?? '', FIRST_LEASE))?.body).toBe(sealed?.body);
  });

  it('drops a malformed item and keeps the others', async () => {
    const storage = newMemoryStorage();
    const queue = newQueue({ storage, reportError: () => undefined });
    await queue.add(FIELDS, EVENT);
    const planted = ((await storage.get(QUEUE_KEY)) ?? '').replace(/^\[/, '[{"qid":"broken"},');
    await storage.set(QUEUE_KEY, planted);

    const leased = await queue.lease(FIRST_LEASE);

    expect(planted).toContain('"qid":"broken"');
    expect(leased.map((item) => item.envelope.events)).toEqual([[EVENT]]);
    expect(await storage.get(QUEUE_KEY)).not.toContain('"qid":"broken"');
  });
});
