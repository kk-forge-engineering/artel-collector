import { describe, expect, it } from 'vitest';
import { AnalyticsState, type Collector } from './exports.js';
import { eventNamesIn } from '../tests/fakeFetch.js';
import { newSharedLock } from '../tests/sharedLock.js';
import {
  SEND_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  QUEUE_KEY,
  RETRY_DELAY_MS,
  attemptStartMs,
  newHarness,
  type Harness,
  USER_ID,
} from '../tests/harness.js';

describe('failures', () => {
  it('keeps the retry wait when an event comes while a failing request is on its way', async () => {
    let calls = 0;
    let answerHeld: ((status: number) => void) | undefined;
    const harness = newHarness({
      transport: async () => {
        calls++;
        return calls === 4 ? new Promise<number>((resolve) => (answerHeld = resolve)) : 503;
      },
    });
    await harness.collector.track('a');
    // Three failures double the retry wait. The wait after the fourth failure is 8 s, and the event `b` must not cut
    // that wait short.
    await harness.clock.advance(attemptStartMs(4));

    await harness.collector.track('b');
    answerHeld?.(503);
    await harness.clock.advance(8 * RETRY_DELAY_MS - 1);
    expect(calls).toBe(4);

    await harness.clock.advance(1);
    expect(calls).toBe(5);
  });

  it('waits the retry delay after a 429 even when an event armed a send during the slow request', async () => {
    const starts: number[] = [];
    const answers = [429, 204, 204];
    const harness = newHarness();
    const collector = harness.restart({
      transport: (_body) =>
        new Promise<number>((resolve) => {
          starts.push(harness.clock.now());
          harness.clock.setTimeout(() => resolve(answers.shift() ?? 204), 10_000);
        }),
    });
    const start = harness.clock.now();

    await collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS + 1_000);
    await collector.track('b');
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    // The first request starts after the send delay and answers 429 ten seconds later. The retry waits its delay from
    // that answer, then sends `a` and `b` one after the other.
    expect(starts.map((time) => time - start)).toEqual([
      SEND_DELAY_MS,
      SEND_DELAY_MS + 10_000 + RETRY_DELAY_MS,
      SEND_DELAY_MS + 20_000 + RETRY_DELAY_MS,
    ]);
  });

  it('drops an envelope the intake rejects with 4xx, without a retry, and sends the next one', async () => {
    let id: string | undefined;
    const harness = newHarness({ getId: () => id });
    harness.fetch.respondNextWith(400);

    await harness.collector.track('a');
    id = USER_ID;
    await harness.collector.track('b');
    await harness.settle();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(harness.fetch.eventNames).toEqual(['a', 'b']);
    expect(harness.errors).toHaveLength(1);
  });

  it('drops and reports an envelope its transport answers with a status below 200, without a retry', async () => {
    const statuses: number[] = [];
    const harness = newHarness({ transport: async () => (statuses.push(101), 101) });

    await harness.collector.track('a');
    await harness.settle();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(statuses).toEqual([101]);
    expect(harness.errors).toEqual([new Error('artel: intake answered 101')]);
  });

  it.each([
    ['a 500', (harness: Harness) => harness.fetch.respondNextWith(500)],
    ['a 503', (harness: Harness) => harness.fetch.respondNextWith(503)],
    ['a 429', (harness: Harness) => harness.fetch.respondNextWith(429)],
    ['a network error', (harness: Harness) => harness.fetch.failNextWithNetworkError()],
  ])('sends the envelope again after %s', async (_, fail) => {
    const harness = newHarness();
    fail(harness);

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['a', 'a']);
    expect(harness.errors).toHaveLength(0);
  });

  it('keeps trying while the intake is down, waiting twice as long each time', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 3);

    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS);
    const attempts = [harness.fetch.requests.length];
    for (const pause of [RETRY_DELAY_MS, 2 * RETRY_DELAY_MS, 4 * RETRY_DELAY_MS]) {
      await harness.clock.advance(pause);
      attempts.push(harness.fetch.requests.length);
    }

    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(harness.errors).toHaveLength(0);
  });

  it('waits at most five minutes between attempts', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 12);
    await harness.collector.track('a');
    // The tenth attempt fails too. The doubled wait after it, 512 s, passes the five-minute cap.
    await harness.clock.advance(attemptStartMs(10));
    expect(harness.fetch.requests).toHaveLength(10);

    await harness.clock.advance(MAX_RETRY_DELAY_MS - 1);
    expect(harness.fetch.requests).toHaveLength(10);
    await harness.clock.advance(1);
    expect(harness.fetch.requests).toHaveLength(11);
  });

  it('waits a second again after a send that went through', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 2);
    await harness.collector.track('a');
    await harness.clock.advance(attemptStartMs(3));
    harness.fetch.respondNextWith(503);

    await harness.collector.track('b');
    await harness.clock.advance(SEND_DELAY_MS + RETRY_DELAY_MS);

    expect(harness.fetch.eventNames).toEqual(['a', 'a', 'a', 'b', 'b']);
  });

  it('sends what is still waiting before new events', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503);

    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS);
    await harness.collector.track('b');
    await harness.collector.flush();
    await harness.clock.advance(RETRY_DELAY_MS);

    expect(harness.fetch.eventNames).toEqual(['a', 'a', 'b']);
  });

  it('sends an envelope left waiting by an earlier run once a new run sends', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 2);
    await harness.collector.track('a');
    await harness.settle();

    const restarted = harness.restart();
    await restarted.track('b');
    await restarted.flush();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(harness.fetch.eventNames).toEqual(['a', 'a', 'a', 'b']);
  });

  it('keeps the newest 20 envelopes while the intake is down and reports the one it drops', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 21);

    // The loop moves the clock 11 minutes past each event. This passes the session timeout, so each event starts a
    // session in its own envelope. The 21 envelopes fill the queue past its limit of 20.
    for (let index = 0; index < 21; index++) {
      await harness.collector.track(`event_${index}`);
      await harness.collector.flush();
      harness.clock.jumpMinutes(11);
    }
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(harness.fetch.eventNames.slice(21)).toEqual(Array.from({ length: 20 }, (_, index) => `event_${index + 1}`));
    expect(harness.errors).toHaveLength(1);
  });

  it('says only that the queue is full when envelopes that wait for an id fill it', async () => {
    const harness = newHarness({ getId: () => undefined });

    for (let index = 0; index < 21; index++) {
      await harness.collector.track('waiting');
      harness.clock.jumpMinutes(11);
    }
    await harness.settle();

    expect(harness.fetch.requests).toEqual([]);
    expect(harness.errors).toEqual([
      new Error('artel: the queue holds at most 20 envelopes, so the oldest 1 were dropped'),
    ]);
  });

  it('drops waiting events from before yesterday, which the intake would count as today', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 2);
    await harness.collector.track('a');
    await harness.settle();

    harness.clock.setLocal('2026-10-31T10:00:00');
    await harness.collector.track('b');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a', 'a', 'b']);
    expect(harness.errors).toHaveLength(1);
  });

  it('sends waiting events from yesterday', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 2);
    await harness.collector.track('a');
    await harness.settle();

    harness.clock.setLocal('2026-10-30T10:00:00');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a', 'a', 'a']);
  });

  it('still sends a waiting envelope under its id after getId stops returning it, as after a sign-out', async () => {
    let id: string | undefined = USER_ID;
    const harness = newHarness({ getId: () => id });
    harness.fetch.respondNextWith(503, 2);
    await harness.collector.track('a');
    await harness.settle();

    id = undefined;
    await harness.collector.flush();
    // Two failures in a row ask for a wait of 2 s, which a flush keeps too.
    await harness.clock.advance(2 * RETRY_DELAY_MS);

    expect(harness.fetch.requests.map((request) => request.envelope.id)).toEqual([USER_ID, USER_ID, USER_ID]);
  });

  it('drops the queued events of a user the host forgets', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    harness.fetch.respondNextWith(503, 2);
    await harness.collector.track('a');
    await harness.settle();

    await harness.collector.forget(USER_ID);
    await harness.collector.flush();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(harness.fetch.eventNames).toEqual(['a', 'a']);
  });

  it('drops what a send in flight puts back after another context switched to the opted_out state', async () => {
    const sent: string[] = [];
    let calls = 0;
    let other: Collector | undefined;
    const harness = newHarness({
      transport: async (body) => {
        sent.push(...eventNamesIn(body));
        calls++;
        if (calls === 1) {
          await other?.setState(AnalyticsState.OptedOut);
          return 503;
        }
        return 204;
      },
    });
    other = harness.restart();
    await harness.collector.track('a');

    await harness.collector.flush();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(sent).toEqual(['a', 'opted_out']);
  });

  it('stops a send in progress before the envelopes another context dropped by switching to the opted_out state', async () => {
    const sent: string[] = [];
    let other: Collector | undefined;
    const harness = newHarness({
      transport: async (body) => {
        const names = eventNamesIn(body);
        sent.push(...names);
        if (names.includes('a')) {
          await other?.setState(AnalyticsState.OptedOut);
        }
        return 204;
      },
    });
    other = harness.restart();
    await harness.collector.track('a');
    harness.clock.jumpMinutes(11);
    await harness.collector.track('b');

    await harness.collector.flush();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(sent).toEqual(['a', 'opted_out']);
  });

  it('resolves forget only after a request already on its way with that id has ended', async () => {
    let answer: (() => void) | undefined;
    const harness = newHarness({
      getId: () => USER_ID,
      transport: async () => {
        await new Promise<void>((resolve) => (answer = resolve));
        return 204;
      },
    });
    await harness.collector.track('a');
    void harness.collector.flush();
    await harness.clock.advance(0);

    let isForgotten = false;
    const forgotten = harness.collector.forget(USER_ID).then(() => (isForgotten = true));
    await harness.clock.advance(0);
    expect(isForgotten).toBe(false);

    answer?.();
    await forgotten;
    expect(isForgotten).toBe(true);
  });

  it('sends one envelope once when two contexts that share storage and a lock send together', async () => {
    const harness = newHarness({ lock: newSharedLock() });
    harness.fetch.respondNextWith(503, 2);
    await harness.collector.track('a');
    await harness.settle();
    const other = harness.restart();
    await other.getState();

    await Promise.all([harness.collector.flush(), other.flush()]);
    await harness.clock.advance(2 * RETRY_DELAY_MS);

    expect(harness.fetch.eventNames).toEqual(['a', 'a', 'a']);
  });

  it('sends new events when what waits in storage cannot be read', async () => {
    const harness = newHarness();
    await harness.storage.set(QUEUE_KEY, '{not json');

    await harness.collector.track('a');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(harness.errors).toHaveLength(1);
  });

  it('sends new events when storage holds no list of envelopes', async () => {
    const harness = newHarness();
    await harness.storage.set(QUEUE_KEY, '{"events": []}');

    await harness.collector.track('a');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(await harness.storage.get(QUEUE_KEY)).toBe('[]');
  });

  it('never rejects into the host when storage fails', async () => {
    const failing = {
      get: async (): Promise<string | undefined> => {
        throw new Error('quota');
      },
      set: async (): Promise<void> => {
        throw new Error('quota');
      },
    };
    const harness = newHarness({ storage: failing });

    await expect(harness.collector.track('a')).resolves.toBeUndefined();
    await expect(harness.collector.flush()).resolves.toBeUndefined();
    await expect(harness.collector.uninstallParams()).resolves.toBeUndefined();
    expect(harness.errors.length).toBeGreaterThan(0);
  });

  it('never rejects into the host when the transport throws', async () => {
    const harness = newHarness({
      transport: () => {
        throw new TypeError('no network here');
      },
    });

    await harness.collector.track('a');

    await expect(harness.collector.flush()).resolves.toBeUndefined();
  });
});
