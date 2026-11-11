import { describe, expect, it } from 'vitest';
import { AnalyticsState, type Collector, type Transport } from './exports.js';
import { MAX_RETRY_DELAY_MS, newHarness, storageKey, USER_ID } from '../tests/harness.js';
import { fromUntypedHost } from '../tests/untypedHost.js';
import { newSharedLock } from '../tests/sharedLock.js';

const LAST_ID_KEY = storageKey('last_id');

describe('when the id changes', () => {
  /** Tracks one event under each value `getId` gives in turn, then sends, and returns each sent event with its id. */
  async function trackUnder(ids: (string | undefined)[]): Promise<string[][]> {
    let id: string | undefined;
    const harness = newHarness({ getId: () => id });
    for (const [index, next] of ids.entries()) {
      id = next;
      await harness.collector.track(`event_${String(index)}`);
    }
    await harness.settle();
    return harness.fetch.requests.flatMap((request) =>
      request.envelope.events.map((event) => [request.envelope.id ?? 'no id', event.name]),
    );
  }

  it('drops the events of the last user when another one comes, so none goes under the other id', async () => {
    expect(await trackUnder(['user-a', 'user-b'])).toEqual([['user-b', 'event_1']]);
  });

  it('drops what waited after a sign-out once another user signs in', async () => {
    expect(await trackUnder(['user-a', undefined, 'user-b'])).toEqual([['user-b', 'event_2']]);
  });

  it('sends what waited after a sign-out under the same user once they are back', async () => {
    expect(await trackUnder(['user-a', undefined, 'user-a'])).toEqual([
      ['user-a', 'event_0'],
      ['user-a', 'event_1'],
      ['user-a', 'event_2'],
    ]);
  });

  it('sends what waited before the first id under that id', async () => {
    expect(await trackUnder([undefined, 'user-a'])).toEqual([
      ['user-a', 'event_0'],
      ['user-a', 'event_1'],
    ]);
  });

  it('drops what waited when another user is identified at send time, not at a later event', async () => {
    let id: string | undefined = 'user-a';
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('as_a');
    await harness.settle();
    id = undefined;
    await harness.collector.track('waiting');
    await harness.settle();

    id = 'user-b';
    await harness.collector.flush();

    expect(harness.fetch.requests.map((request) => [request.envelope.id, request.envelope.events.length])).toEqual([
      ['user-a', 1],
    ]);
  });

  it('starts afresh after forget, so the next user takes nothing of the forgotten one', async () => {
    let id: string | undefined = 'user-a';
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('as_a');
    await harness.collector.forget('user-a');
    id = 'user-b';
    await harness.collector.track('as_b');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['as_b']);
  });

  it('drops what waited after the forgotten user, so the next user takes none of it', async () => {
    let id: string | undefined = 'user-a';
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('as_a');
    id = undefined;
    await harness.collector.track('waiting');
    await harness.collector.forget('user-a');
    id = 'user-b';
    await harness.collector.track('as_b');
    await harness.settle();

    expect(harness.fetch.requests.map((request) => request.envelope.id)).toEqual(['user-b']);
    expect(harness.fetch.eventNames).toEqual(['as_b']);
  });

  it('counts the next id after forget as another user, so what waited after the forget goes under no id', async () => {
    let id: string | undefined = 'user-a';
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('as_a');
    await harness.settle();
    id = undefined;
    await harness.collector.forget('user-a');
    await harness.collector.track('signed_out');

    id = 'user-b';
    await harness.collector.track('as_b');
    await harness.settle();

    expect(harness.fetch.eventNamesByRequest).toEqual([['as_a'], ['as_b']]);
  });

  it('counts the next id after forget as another user, even an id that spells the forget marker', async () => {
    let id: string | undefined = 'user-a';
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('as_a');
    await harness.settle();
    id = undefined;
    await harness.collector.forget('user-a');
    await harness.collector.track('signed_out');

    id = '<forgotten>';
    await harness.collector.track('as_next');
    await harness.settle();

    expect(harness.fetch.eventNamesByRequest).toEqual([['as_a'], ['as_next']]);
  });

  it('starts a new session for another user, so no session holds the events of two users', async () => {
    let id: string | undefined = 'user-a';
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('as_a');
    await harness.settle();

    id = 'user-b';
    await harness.collector.track('as_b');
    await harness.settle();

    const [first, second] = harness.fetch.requests.map((request) => request.envelope.session);
    expect(harness.fetch.eventNames).toEqual(['as_a', 'as_b']);
    expect(second).not.toBe(first);
  });

  it('keeps what waited when the host forgets a user other than the last one', async () => {
    let id: string | undefined = 'user-a';
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('as_a');
    id = undefined;
    await harness.collector.track('waiting');
    await harness.collector.forget('user-z');
    id = 'user-a';
    await harness.collector.flush();

    expect(harness.fetch.requests.map((request) => request.envelope.id)).toEqual(['user-a', 'user-a']);
  });

  it.each([
    ['leaving the identified state', (collector: Collector) => collector.setState(AnalyticsState.Anonymous)],
    ['opting out', (collector: Collector) => collector.setState(AnalyticsState.OptedOut)],
    ['forgetting the user', (collector: Collector) => collector.forget('user-a')],
  ])('keeps no id in storage after %s', async (_, leave) => {
    const harness = newHarness({ getId: () => 'user-a' });
    await harness.collector.track('as_a');
    expect(await harness.storage.get(LAST_ID_KEY)).toBe('user-a');

    await leave(harness.collector);

    expect(await harness.storage.get(LAST_ID_KEY)).not.toContain('user-a');
  });

  it('drops what another context left waiting when it identifies another user mid-send', async () => {
    let id: string | undefined = 'user-a';
    let other: Collector | undefined;
    let forward: Transport | undefined;
    const harness = newHarness({
      getId: () => id,
      lock: newSharedLock(),
      transport: async (body) => {
        const status = (await forward?.(body)) ?? 0;
        if (harness.fetch.requests.length === 1) {
          // Another context that shares the storage, such as a second tab, sees the next user while the first request
          // is out.
          id = 'user-b';
          await other?.track('as_b');
          return 503;
        }
        return status;
      },
    });
    forward = harness.transport;
    other = harness.restart();
    await harness.collector.track('as_a');
    id = undefined;
    await harness.collector.track('waiting');

    await harness.collector.flush();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(
      harness.fetch.requests.map((request) => [
        request.envelope.id,
        ...request.envelope.events.map((event) => event.name),
      ]),
    ).toEqual([
      ['user-a', 'as_a'],
      ['user-b', 'as_b'],
    ]);
  });
});

describe('the first id after the user left the identified state', () => {
  it('sends what waited for it under that id, as for the first id ever', async () => {
    let id: string | undefined = 'user-a';
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('first');
    await harness.settle();
    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.setState(AnalyticsState.Identified);
    id = undefined;
    await harness.collector.track('waiting');
    id = 'user-b';

    await harness.collector.track('known');
    await harness.settle();

    expect(harness.fetch.requests.map((request) => [request.envelope.id, eventNamesOf(request)])).toEqual([
      ['user-a', ['first']],
      ['user-b', ['waiting']],
      ['user-b', ['known']],
    ]);
  });
});

/** Returns the names of the events one request carried. */
function eventNamesOf(request: { envelope: { events: { name: string }[] } }): string[] {
  return request.envelope.events.map((event) => event.name);
}

describe('forget of the last id, further', () => {
  it('gives back at once the marks of the events that waited for an id after that user', async () => {
    let id: string | undefined = 'user-a';
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('sent');
    await harness.settle();
    id = undefined;
    harness.clock.setLocal('2026-10-30T10:00:00');
    await harness.collector.track('waiting');

    await harness.collector.forget('user-a');

    expect((await harness.collector.uninstallParams())?.active_days).toBe('1');
  });
});

describe('a host outside TypeScript that calls a method with any argument', () => {
  it.each([
    ['a number', 42],
    ['undefined', undefined],
    ['an object', { id: USER_ID }],
    ['a bigint', 10n],
  ])('gets a report for forget of %s, which drops nothing', async (_, id) => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.collector.track('a');

    await expect(harness.collector.forget(fromUntypedHost<string>(id))).resolves.toBeUndefined();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(harness.errors).toEqual([new TypeError('artel: forget takes an id of 1 to 64 characters')]);
  });

  it('keeps the events that wait for an id at a forget of undefined before any id is known', async () => {
    let id: string | undefined;
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('a');

    await harness.collector.forget(fromUntypedHost<string>(undefined));
    id = USER_ID;
    await harness.collector.track('b');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['a', 'b']);
    expect(harness.errors).toEqual([new TypeError('artel: forget takes an id of 1 to 64 characters')]);
  });

  it('resolves getState and flush whatever they are given, and reports nothing', async () => {
    const harness = newHarness();
    await harness.collector.track('a');
    const untyped = fromUntypedHost<{
      getState(value: unknown): Promise<unknown>;
      flush(value: unknown): Promise<unknown>;
    }>(harness.collector);

    await expect(untyped.getState(10n)).resolves.toBe(AnalyticsState.Anonymous);
    await expect(untyped.flush({ now: true })).resolves.toBeUndefined();

    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(harness.errors).toEqual([]);
  });
});
