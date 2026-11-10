import { describe, expect, it } from 'vitest';
import { AnalyticsState, type Collector } from './exports.js';
import { eventNamesIn } from '../tests/fakeFetch.js';
import { newSharedLock } from '../tests/sharedLock.js';
import {
  KEY,
  QUEUE_KEY,
  SEND_DELAY_MS,
  RETRY_DELAY_MS,
  VERSION,
  attemptStartMs,
  newHarness,
  type Harness,
  USER_ID,
} from '../tests/harness.js';

/**
 * Returns a harness that tracked `a` and flushed twice, the second flush queued behind the first. The first request
 * fails with 503 once both flushes have started. `answerLater` answers every later request, and `sent` holds the event
 * names of each request.
 */
async function flushBehindFailingSend(
  answerLater: (sent: string[][], harness: Harness) => Promise<number>,
): Promise<{ harness: Harness; sent: string[][] }> {
  let releaseFirst: (() => void) | undefined;
  const sent: string[][] = [];
  const harness = newHarness({
    transport: async (body) => {
      sent.push(eventNamesIn(body));
      if (sent.length === 1) {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        return 503;
      }
      return answerLater(sent, harness);
    },
  });
  await harness.collector.track('a');
  const first = harness.collector.flush();
  await harness.clock.advance(0);
  const second = harness.collector.flush();
  await harness.clock.advance(0);
  releaseFirst?.();
  await Promise.all([first, second]);
  return { harness, sent };
}

describe('delivery guarantees', () => {
  it('keeps one retry pending when a flush queued behind a failing send fails too', async () => {
    const { harness, sent } = await flushBehindFailingSend(async () => 503);

    // The queued flush keeps the 1 s wait of the first failure. Its failure makes the collector wait 2 s more. The
    // check at 1.5 s after it shows that no second 1 s timer fires.
    await harness.clock.advance(RETRY_DELAY_MS);
    expect(sent).toHaveLength(2);
    await harness.clock.advance(RETRY_DELAY_MS + RETRY_DELAY_MS / 2);
    expect(sent).toHaveLength(2);
    await harness.clock.advance(RETRY_DELAY_MS / 2);
    expect(sent).toHaveLength(3);
  });

  it('sends a full envelope at once after a queued flush succeeded past a failed send', async () => {
    const { harness, sent } = await flushBehindFailingSend(async () => 204);
    await harness.clock.advance(RETRY_DELAY_MS);

    for (let index = 0; index < 100; index++) {
      await harness.collector.track('b');
    }
    await harness.clock.advance(0);

    expect(sent.map((names) => names.length)).toEqual([1, 1, 100]);
  });

  it('sends an event tracked during that queued send within the send delay', async () => {
    const { harness, sent } = await flushBehindFailingSend(async (requests, { collector }) => {
      if (requests.length === 2) {
        await collector.track('c');
      }
      return 204;
    });

    await harness.clock.advance(RETRY_DELAY_MS + SEND_DELAY_MS);

    expect(sent).toEqual([['a'], ['a'], ['c']]);
  });

  it('renews the lease before each request, so a long send keeps other contexts off its later envelopes', async () => {
    const lock = newSharedLock();
    let other: Collector | undefined;
    const sent: string[] = [];
    const harness = newHarness({
      lock,
      transport: async (body) => {
        const names = eventNamesIn(body);
        sent.push(...names);
        // Each request takes 25 s, so the other context sends at 75 s. The first lease covered one minute, so only a
        // renewed lease keeps the other context off the envelope of c.
        harness.clock.jumpMinutes(25 / 60);
        if (names.includes('c') && other !== undefined) {
          const otherContext = other;
          other = undefined;
          await otherContext.flush();
        }
        return 204;
      },
    });
    other = harness.restart();
    for (const name of ['a', 'b', 'c']) {
      await harness.collector.track(name);
      harness.clock.jumpMinutes(11);
    }

    await harness.collector.flush();

    expect(sent).toEqual(['a', 'b', 'c']);
  });

  it('keeps an envelope in storage while its request is on its way, so a host stopped mid-send loses nothing', async () => {
    const harness = newHarness({ transport: () => new Promise<number>(() => undefined) });
    await harness.collector.track('a');
    void harness.collector.flush();
    await harness.clock.advance(0);
    harness.clock.dropTimers();

    const restarted = harness.restart({ transport: harness.transport });
    await restarted.flush();
    expect(harness.fetch.eventNames).toEqual([]);

    harness.clock.jumpMinutes(2);
    await restarted.flush();
    expect(harness.fetch.eventNames).toEqual(['a']);
  });

  it('keeps an envelope that waits for the id when getId fails during the send, and sends it once getId answers', async () => {
    let calls = 0;
    const harness = newHarness({
      getId: () => {
        calls++;
        if (calls === 2) {
          throw new Error('sign-in store unavailable');
        }
        // The collector calls getId when it records the event and at each send. No id exists yet at the record. The
        // second call is the failed send. The third call, at the next send, finds the id.
        return calls === 1 ? undefined : USER_ID;
      },
    });
    await harness.collector.track('a');
    await harness.collector.flush();

    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(harness.errors).toHaveLength(1);
  });

  it('sends the envelope again after the transport throws', async () => {
    let calls = 0;
    const harness = newHarness({
      transport: async (body) => {
        calls++;
        if (calls === 1) {
          throw new TypeError('no network here');
        }
        return harness.transport(body);
      },
    });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['a']);
  });

  it('counts a transport unsettled after 35 seconds as status 0, so flush, forget and an opt-out resolve', async () => {
    let calls = 0;
    const harness = newHarness({
      getId: () => USER_ID,
      transport: (body) => {
        calls++;
        return calls === 1 ? new Promise<number>(() => undefined) : harness.transport(body);
      },
    });
    await harness.collector.track('a');
    const settled: string[] = [];
    void harness.collector.flush().then(() => settled.push('flush'));
    void harness.collector.forget(USER_ID).then(() => settled.push('forget'));
    void harness.collector.setState(AnalyticsState.OptedOut).then(() => settled.push('setState'));

    await harness.clock.advance(35_000 - 1);
    expect(settled).toEqual([]);
    await harness.clock.advance(1 + RETRY_DELAY_MS);

    expect(settled).toEqual(['flush', 'forget', 'setState']);
    expect(harness.fetch.eventNames).toEqual(['opted_out']);
  });

  it('holds new events until the pending retry, instead of sending past it', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 4);
    await harness.collector.track('a');
    // The collector tries at 5 s, 6 s, 8 s and 12 s, and next at 20 s.
    await harness.clock.advance(attemptStartMs(4));

    await harness.collector.track('b');
    await harness.clock.advance(SEND_DELAY_MS);
    expect(harness.fetch.requests).toHaveLength(4);

    await harness.clock.advance(3 * RETRY_DELAY_MS);
    expect(harness.fetch.eventNames).toEqual(['a', 'a', 'a', 'a', 'a', 'b']);
  });

  it('drops a waiting event dated before the UTC yesterday, the date the intake goes by', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 2);
    await harness.collector.track('a');
    await harness.settle();

    // The harness clock runs in New York, where 21:00 on 30 Oct is 31 Oct in UTC. The event of 29 Oct is local
    // yesterday but two UTC days back.
    harness.clock.setLocal('2026-10-30T21:00:00');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a', 'a']);
  });

  it('keeps both events and marks the first of the day once when two contexts that share storage and a lock record together', async () => {
    const lock = newSharedLock();
    const harness = newHarness({ lock });
    const other = harness.restart();
    await Promise.all([harness.collector.getState(), other.getState()]);

    await Promise.all([harness.collector.track('a'), other.track('b')]);
    await harness.settle();

    expect(harness.fetch.eventNames).toHaveLength(2);
    expect(harness.fetch.eventNames).toEqual(expect.arrayContaining(['a', 'b']));
    expect(harness.fetch.events.filter((event) => event.first?.includes('day'))).toHaveLength(1);
  });
});

describe('batch key', () => {
  it('sends the very body of the first attempt again, byte for byte, as the intake matches a repeat by it', async () => {
    const bodies: string[] = [];
    let calls = 0;
    const harness = newHarness({
      transport: async (body) => {
        bodies.push(body);
        calls++;
        return calls === 1 ? 503 : 204;
      },
    });

    await harness.collector.track('a', { format: 'pdf' });
    await harness.settle();

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('drops a sealed envelope whole, not in part, once it went stale', async () => {
    const bodies: string[] = [];
    const harness = newHarness({
      transport: async (body) => {
        bodies.push(body);
        return 503;
      },
    });
    await harness.collector.track('a');
    await harness.settle();

    harness.clock.jumpMinutes(3 * 24 * 60);
    await harness.collector.flush();

    expect(bodies).toHaveLength(2);
    expect(harness.errors).toHaveLength(1);
  });

  it('drops at its first send an envelope a stopped host left until it went stale', async () => {
    const harness = newHarness();
    await harness.collector.track('a');
    harness.clock.dropTimers();

    harness.clock.jumpMinutes(3 * 24 * 60);
    const restarted = harness.restart();
    await restarted.flush();

    expect(harness.fetch.requests).toHaveLength(0);
    expect(harness.errors).toHaveLength(1);
  });

  it('drops a sealed envelope whole when only some of its events went stale', async () => {
    const harness = newHarness();
    const envelope = {
      key: KEY,
      platform: 'extension',
      version: VERSION,
      session: 'k3j9x2m1qa0b',
      batch: '0123456789abcdef',
      events: [
        { name: 'a', day: '2026-10-27' },
        { name: 'b', day: '2026-10-29' },
      ],
    };
    // A sealed envelope as an earlier run left it, with the body of its first attempt.
    await harness.storage.set(
      QUEUE_KEY,
      JSON.stringify([{ qid: '0123456789abcdef', body: JSON.stringify(envelope), envelope }]),
    );

    await harness.collector.flush();

    expect(harness.fetch.requests).toHaveLength(0);
    expect(harness.errors).toHaveLength(1);
  });

  it('sends each envelope with its own batch key, and the same key when it sends it again', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503);

    await harness.collector.track('a');
    await harness.settle();
    harness.clock.jumpMinutes(11);
    await harness.collector.track('b');
    await harness.collector.flush();

    const [first, retry, other] = harness.fetch.requests.map((request) => request.envelope.batch);
    expect(first).toMatch(/^[0-9A-Za-z_-]{1,64}$/);
    expect(retry).toBe(first);
    expect(other).not.toBe(first);
  });

  it('puts events tracked after a failed attempt into a new envelope, since the intake may have kept the first', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503);

    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS);
    await harness.collector.track('b');
    await harness.collector.flush();
    await harness.clock.advance(RETRY_DELAY_MS);

    expect(harness.fetch.eventNamesByRequest).toEqual([['a'], ['a'], ['b']]);
  });

  it('sends an event tracked into a later envelope while the send is busy with an earlier one', async () => {
    let answerFirst: (() => void) | undefined;
    const sent: string[][] = [];
    const harness = newHarness({
      transport: async (body) => {
        sent.push(eventNamesIn(body));
        if (sent.length === 1) {
          await new Promise<void>((resolve) => (answerFirst = resolve));
        }
        return 204;
      },
    });
    await harness.collector.track('a');
    harness.clock.jumpMinutes(11);
    await harness.collector.track('b');
    const sending = harness.collector.flush();
    await harness.clock.advance(0);

    await harness.collector.track('x');
    answerFirst?.();
    await sending;
    await harness.settle();

    expect(sent).toEqual([['a'], ['b', 'x']]);
  });

  it('keeps adding to an envelope no attempt has sent yet while the intake is down', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 3);

    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS);
    await harness.collector.track('b');
    // The retry tries a again, fails, and never reaches the envelope of b.
    await harness.clock.advance(RETRY_DELAY_MS);
    await harness.collector.track('c');
    await harness.clock.advance(2 * RETRY_DELAY_MS + 4 * RETRY_DELAY_MS);

    expect(harness.fetch.eventNamesByRequest).toEqual([['a'], ['a'], ['a'], ['a'], ['b', 'c']]);
  });
});

describe('envelopes that name the user', () => {
  it('lets another context send an envelope this one leased while it waited for the id', async () => {
    const lock = newSharedLock();
    const harness = newHarness({ getId: () => undefined, lock });
    await harness.collector.track('waiting');
    await harness.settle();
    expect(harness.fetch.requests).toEqual([]);

    await harness.restart({ getId: () => USER_ID, lock }).flush();

    expect(harness.fetch.eventNames).toEqual(['waiting']);
  });

  it('sends again the body it sealed with the id, even while getId no longer knows the id', async () => {
    let id: string | undefined;
    const harness = newHarness({ getId: () => id });
    harness.fetch.respondNextWith(503);
    await harness.collector.track('waiting');
    id = USER_ID;
    await harness.clock.advance(SEND_DELAY_MS);
    id = undefined;

    await harness.clock.advance(RETRY_DELAY_MS);

    expect(harness.fetch.requests.map((request) => request.envelope.id)).toEqual([USER_ID, USER_ID]);
  });
});
