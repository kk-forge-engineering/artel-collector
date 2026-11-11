import { describe, expect, it } from 'vitest';
import { AnalyticsState, type Transport, type TransportResult } from './exports.js';
import { eventNamesIn } from '../tests/fakeFetch.js';
import { fromUntypedHost } from '../tests/untypedHost.js';
import {
  attemptStartMs,
  MAX_RETRY_DELAY_MS,
  newHarness,
  RETRY_AT_KEY,
  RETRY_DELAY_MS,
  SEND_DELAY_MS,
  type Harness,
} from '../tests/harness.js';
import { newSharedLock } from '../tests/sharedLock.js';

/** One answer of the intake, made at the time of the request. */
type Answer = (now: number) => number | TransportResult;

/** Returns a harness whose transport gives `answers` in turn, then 204, and records the time of each request. */
function newAnsweringHarness(
  answers: Answer[],
  overrides: Parameters<typeof newHarness>[0] = {},
): { harness: Harness; times: number[] } {
  const times: number[] = [];
  const harness: Harness = newHarness({
    ...overrides,
    transport: async () => {
      const now = harness.clock.now();
      times.push(now);
      return answers.shift()?.(now) ?? 204;
    },
  });
  return { harness, times };
}

/** Returns the wait between the first failed request and the next one. */
async function waitAfter(answer: Answer): Promise<number> {
  const { harness, times } = newAnsweringHarness([answer]);
  await harness.collector.track('a');
  await harness.clock.advance(SEND_DELAY_MS + MAX_RETRY_DELAY_MS);
  const [first = 0, second = 0] = times;
  return second - first;
}

describe('Retry-After', () => {
  it.each([
    ['a 429 with delta-seconds', () => ({ status: 429, retryAfter: '10' }), 10_000],
    ['a 503 with delta-seconds', () => ({ status: 503, retryAfter: '10' }), 10_000],
    // The first request goes at 14:00:05 UTC on 29 October 2026.
    ['a 429 with an HTTP date', () => ({ status: 429, retryAfter: 'Thu, 29 Oct 2026 14:00:25 GMT' }), 20_000],
    ['a 429 with a value that is neither', () => ({ status: 429, retryAfter: 'soon' }), RETRY_DELAY_MS],
    ['a 429 without the header', () => ({ status: 429 }), RETRY_DELAY_MS],
    ['a 429 past the five-minute cap', () => ({ status: 429, retryAfter: '3600' }), MAX_RETRY_DELAY_MS],
    ['a 500, which the intake sends without it', () => ({ status: 500, retryAfter: '10' }), RETRY_DELAY_MS],
    ['a 429 from a transport that resolves to a number', () => 429, RETRY_DELAY_MS],
  ])('waits after %s as long as the intake asks, if longer than its own wait', async (_, answer, wait) => {
    expect(await waitAfter(answer)).toBe(wait);
  });

  it('reads the header of the response newHttpTransport gets', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(429, 1, { 'Retry-After': '10' });

    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS + 10_000 - 1);
    expect(harness.fetch.requests).toHaveLength(1);
    await harness.clock.advance(1);

    expect(harness.fetch.requests).toHaveLength(2);
  });

  it('keeps its own wait when the intake asks for less', async () => {
    const failure = (): TransportResult => ({ status: 503 });
    const { harness, times } = newAnsweringHarness([
      failure,
      failure,
      failure,
      () => ({ status: 429, retryAfter: '2' }),
    ]);

    await harness.collector.track('a');
    await harness.clock.advance(attemptStartMs(5));

    expect(times.map((time) => time - (times[0] ?? 0))).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
  });
});

describe('the retry wait across contexts', () => {
  it('sends nothing during the retry wait of a 429, whichever context records', async () => {
    let calls = 0;
    const transport: Transport = async () => {
      calls++;
      return 429;
    };
    const lock = newSharedLock();
    const harness = newHarness({ transport, lock });
    await harness.collector.track('a');
    // Five 429s: the wait before the sixth attempt is 16 s.
    await harness.clock.advance(attemptStartMs(5));
    expect(calls).toBe(5);

    const otherTab = harness.restart({ transport, lock });
    await otherTab.track('b');
    await harness.clock.advance(SEND_DELAY_MS + 1);

    expect(calls).toBe(5);
  });

  it('holds a flush of another context until the wait the intake asked for is over, then sends', async () => {
    const { harness, times } = newAnsweringHarness([() => ({ status: 429, retryAfter: '30' })], {
      lock: newSharedLock(),
    });
    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS);
    const otherTab = harness.restart();

    await otherTab.flush();
    expect(times).toHaveLength(1);
    await harness.clock.advance(30_000);

    expect(times).toHaveLength(2);
    expect(harness.errors).toEqual([]);
  });

  it('keeps the longer wait of one context when another context fails at once with its own short wait', async () => {
    const answers: Array<(result: TransportResult) => void> = [];
    const starts: Array<{ at: number; names: string[] }> = [];
    const harness: Harness = newHarness({
      lock: newSharedLock(),
      transport: (body) => {
        starts.push({ at: harness.clock.now(), names: eventNamesIn(body) });
        return new Promise((resolve) => answers.push(resolve));
      },
    });
    const otherTab = harness.restart();
    await harness.collector.track('a');
    void harness.collector.flush();
    await harness.clock.advance(0);
    // The envelope of a is sealed, so b takes an envelope of its own, which the other tab leases.
    await otherTab.track('b');
    void otherTab.flush();
    await harness.clock.advance(0);
    const asked = harness.clock.now();

    answers[0]?.({ status: 429, retryAfter: '120' });
    await harness.clock.advance(0);
    answers[1]?.({ status: 503 });
    await harness.clock.advance(119_999);

    expect(starts.map((start) => [start.at - asked, start.names])).toEqual([
      [0, ['a']],
      [0, ['b']],
    ]);
  });

  it.each(['1e300', 'Infinity', 'not-a-time'])(
    'waits at most five minutes after a stored wait of %s, as a forged one is',
    async (stored) => {
      const harness = newHarness();
      await harness.storage.set(RETRY_AT_KEY, stored);

      await harness.collector.track('a');
      await harness.collector.flush();
      await harness.clock.advance(MAX_RETRY_DELAY_MS);

      expect(harness.fetch.requests).toHaveLength(1);
      expect(harness.errors).toHaveLength(1);
    },
  );

  it('waits at most five minutes after the clock was set back during a wait', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503, 1, { 'Retry-After': '300' });
    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS);
    harness.clock.jumpMinutes(-24 * 60);

    await harness.collector.flush();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(harness.fetch.requests).toHaveLength(2);
  });
});

describe('a stored wait of exactly five minutes', () => {
  it('holds the send without reporting a cut', async () => {
    const { harness, times } = newAnsweringHarness([() => ({ status: 429, retryAfter: '300' })]);
    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS);

    await harness.collector.flush();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(times).toHaveLength(2);
    expect(harness.errors).toEqual([]);
  });
});

describe('the retry wait after the clock was set back', () => {
  it('holds a send no longer than five minutes', async () => {
    const { harness, times } = newAnsweringHarness([() => ({ status: 429, retryAfter: '10' })]);
    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS);
    harness.clock.jumpMinutes(-60);

    await harness.collector.flush();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(times).toHaveLength(2);
  });
});

describe('an opt-out during a retry wait', () => {
  it('sends the opted_out at the end of the wait, not at once', async () => {
    const { harness, times } = newAnsweringHarness([() => ({ status: 429, retryAfter: '3' })]);
    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS);

    await harness.collector.setState(AnalyticsState.OptedOut);
    const sentAtOnce = times.length;
    await harness.clock.advance(3_000);

    // The opt-out dropped a, so the one request after the wait carries the opted_out.
    expect(sentAtOnce).toBe(1);
    expect(times).toHaveLength(2);
  });
});

describe('a status that is no HTTP status', () => {
  it.each([
    ['NaN', Number.NaN],
    ['1.5', 1.5],
    ['1000', 1000],
    ['-1', -1],
    ['600', 600],
    ['a string', '200'],
  ])('reads %s as a failed request, reports it and sends the envelope again', async (_, status) => {
    let calls = 0;
    const harness: Harness = newHarness({
      transport: async (body) => {
        calls++;
        return calls === 1 ? fromUntypedHost<number>(status) : harness.transport(body);
      },
    });

    await harness.collector.track('a');
    await harness.settle();

    expect(calls).toBe(2);
    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(harness.errors).toEqual([
      new Error('artel: the transport answered a status that is no whole number from 0 to 599, read as 0'),
    ]);
  });
});

describe('an answer that carries no status', () => {
  it.each([
    ['a string', '204'],
    ['an object without a status', { retryAfter: '1' }],
  ])('reads %s as a failed request, reports it and sends the envelope again', async (_, answer) => {
    let calls = 0;
    const harness: Harness = newHarness({
      transport: async (body) => {
        calls++;
        return calls === 1 ? fromUntypedHost<number>(answer) : harness.transport(body);
      },
    });

    await harness.collector.track('a');
    await harness.settle();

    expect(calls).toBe(2);
    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(harness.errors).toEqual([
      new Error('artel: the transport answered a status that is no whole number from 0 to 599, read as 0'),
    ]);
  });
});

describe('an answer of null or undefined', () => {
  // oxlint-disable-next-line unicorn/no-null -- a transport outside TypeScript can answer null.
  it.each([undefined, null])('reads %s as a failed request and sends the envelope again', async (answer) => {
    let calls = 0;
    const harness: Harness = newHarness({
      transport: async (body) => {
        calls++;
        return calls === 1 ? fromUntypedHost<number>(answer) : harness.transport(body);
      },
    });

    await harness.collector.track('a');
    await harness.settle();

    expect([calls, harness.fetch.eventNames]).toEqual([2, ['a']]);
  });
});

describe('a retryAfter that is no string', () => {
  it('waits its own delay after a 429 whose retryAfter is a symbol, and sends the envelope again', async () => {
    let calls = 0;
    const harness: Harness = newHarness({
      transport: async (body) => {
        calls++;
        return calls === 1
          ? { status: 429, retryAfter: fromUntypedHost<string>(Symbol('Retry-After')) }
          : harness.transport(body);
      },
    });

    await harness.collector.track('a');
    await harness.settle();

    expect(calls).toBe(2);
    expect(harness.fetch.eventNames).toEqual(['a']);
    expect(harness.errors).toEqual([]);
  });
});
