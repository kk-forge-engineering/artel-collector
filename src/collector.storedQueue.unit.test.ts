import { describe, expect, it } from 'vitest';
import { KEY, newHarness, QUEUE_KEY, VERSION, storageKey } from '../tests/harness.js';

const FIELDS = { key: KEY, platform: 'extension', version: VERSION, session: 'k3j9x2m1qa0b' };
const EVENT = { name: 'a', day: '2026-10-29' };

describe('what the storage holds that the collector does not know', () => {
  it('skips a queued item without a queue id and a list of events, and sends the others', async () => {
    const harness = newHarness();
    const items = [42, { qid: 'bbbbbbbbbbbbbbbb' }, { qid: 'cccccccccccccccc', envelope: { ...FIELDS } }];
    await harness.storage.set(
      QUEUE_KEY,
      JSON.stringify([...items, { qid: 'aaaaaaaaaaaaaaaa', envelope: { ...FIELDS, events: [EVENT] } }]),
    );

    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(harness.errors).toEqual([]);
  });

  it.each([
    ['a value that is not a list', JSON.stringify({ events: [] })],
    ['text that does not parse', '[{"qid":'],
  ])('reports a queue with %s once, and reads it as empty', async (_, stored) => {
    const harness = newHarness();
    await harness.storage.set(QUEUE_KEY, stored);

    await harness.collector.flush();
    await harness.collector.track('b');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['b']);
    expect(harness.errors).toEqual([new Error('artel: the stored queue is not a JSON list, so it was dropped')]);
  });

  it('reads a stored state it does not know as anonymous', async () => {
    const harness = newHarness();
    await harness.storage.set(storageKey('state'), 'on');

    await harness.collector.track('a');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(await harness.collector.getState()).toBe('anonymous');
    expect(harness.errors).toEqual([]);
  });
});
