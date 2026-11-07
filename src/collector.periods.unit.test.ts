import { describe, expect, it } from 'vitest';
import type { SentEvent } from '../tests/fakeFetch.js';
import { newHarness, type Harness } from '../tests/harness.js';

/** Tracks one event at each local time in turn and returns what the collector sent for each. */
async function eventsAt(harness: Harness, localTimes: string[]): Promise<SentEvent[]> {
  for (const localTime of localTimes) {
    harness.clock.setLocal(localTime);
    await harness.collector.track('screenshot_taken');
    await harness.settle();
  }
  return harness.fetch.events;
}

describe('period marks', () => {
  it('marks every period on the first event ever, and none on the next one that day', async () => {
    const harness = newHarness();

    const [first, second] = await eventsAt(harness, ['2026-10-29T10:00:00', '2026-10-29T18:00:00']);

    expect(first).toEqual({
      name: 'screenshot_taken',
      day: '2026-10-29',
      first: ['day', 'week', 'month', 'quarter', 'year'],
      age_days: 0,
      age_months: 0,
    });
    expect(second).toEqual({ name: 'screenshot_taken', day: '2026-10-29' });
  });

  it.each([
    {
      boundary: 'a day inside one ISO week (Thu → Fri)',
      from: '2026-10-29T10:00:00',
      to: '2026-10-30T09:00:00',
      marks: ['day'],
    },
    {
      boundary: 'an ISO week (Sun → Mon)',
      from: '2026-10-25T10:00:00',
      to: '2026-10-26T09:00:00',
      marks: ['day', 'week'],
    },
    {
      boundary: 'a month inside one ISO week (Sat → Sun)',
      from: '2026-10-31T10:00:00',
      to: '2026-11-01T09:00:00',
      marks: ['day', 'month'],
    },
    {
      boundary: 'a quarter (Wed → Thu)',
      from: '2026-09-30T10:00:00',
      to: '2026-10-01T09:00:00',
      marks: ['day', 'month', 'quarter'],
    },
    // The row expects no week mark, as the year changes inside one ISO week: 31 Dec 2026 and 1 Jan 2027 both fall in
    // 2026-W53.
    {
      boundary: 'a year inside ISO week 2026-W53',
      from: '2026-12-31T10:00:00',
      to: '2027-01-01T09:00:00',
      marks: ['day', 'month', 'quarter', 'year'],
    },
    {
      boundary: 'an ISO week that starts a new ISO year (Sun → Mon)',
      from: '2027-01-03T10:00:00',
      to: '2027-01-04T09:00:00',
      marks: ['day', 'week'],
    },
  ])('marks the periods that change across $boundary', async ({ from, to, marks }) => {
    const harness = newHarness();

    const [, crossing] = await eventsAt(harness, [from, to]);

    expect(crossing?.first).toEqual(marks);
  });

  it('reads the day in local time, not in UTC', async () => {
    // The run's zone is America/New_York, four hours behind UTC in October.
    const harness = newHarness();
    harness.clock.setUtc('2026-10-30T02:30:00Z');
    await harness.collector.track('a');
    harness.clock.setUtc('2026-10-30T03:30:00Z');
    await harness.collector.track('b');
    harness.clock.setUtc('2026-10-30T04:30:00Z');
    await harness.collector.track('c');
    await harness.settle();

    const [a, b, c] = harness.fetch.events;

    expect([a?.day, b?.day, c?.day]).toEqual(['2026-10-29', '2026-10-29', '2026-10-30']);
    expect([a?.first, b?.first, c?.first]).toEqual([['day', 'week', 'month', 'quarter', 'year'], undefined, ['day']]);
  });

  it('keeps the marks across a restart of the host', async () => {
    const harness = newHarness();
    await harness.collector.track('a');
    await harness.settle();

    await harness.restart().track('b');
    await harness.settle();

    expect(harness.fetch.events[1]?.first).toBeUndefined();
  });
});

describe('install age', () => {
  it.each([
    { later: '2026-10-02T09:00:00', ageDays: 1 },
    { later: '2026-10-31T09:00:00', ageDays: 30 },
    { later: '2026-11-01T09:00:00', ageDays: 31 },
    { later: '2027-03-15T09:00:00', ageDays: 31 },
  ])('sends age_days $ageDays on the first event of $later after an install on 1 Oct', async ({ later, ageDays }) => {
    const harness = newHarness();

    const [, event] = await eventsAt(harness, ['2026-10-01T10:00:00', later]);

    expect(event?.age_days).toBe(ageDays);
  });

  it('counts calendar days, so a 25-hour day counts as one', async () => {
    // New York leaves daylight saving on 1 Nov 2026: from 23:30 on 31 Oct to 00:30 on 2 Nov is 26 hours.
    const harness = newHarness();

    const [, event] = await eventsAt(harness, ['2026-10-31T23:30:00', '2026-11-02T00:30:00']);

    expect(event?.age_days).toBe(2);
  });

  it('sends no age_days without the day mark', async () => {
    const harness = newHarness();

    const [, sameDay] = await eventsAt(harness, ['2026-10-01T10:00:00', '2026-10-01T11:00:00']);

    expect(sameDay).not.toHaveProperty('age_days');
  });

  it.each([
    { later: '2026-11-14T09:00:00', ageMonths: 0 },
    { later: '2026-11-15T09:00:00', ageMonths: 1 },
    { later: '2028-10-14T09:00:00', ageMonths: 23 },
    { later: '2028-10-15T09:00:00', ageMonths: 24 },
    { later: '2028-11-15T09:00:00', ageMonths: 25 },
    { later: '2031-01-01T09:00:00', ageMonths: 25 },
  ])(
    'sends age_months $ageMonths on the first event of $later after an install on 15 Oct 2026',
    async ({ later, ageMonths }) => {
      const harness = newHarness();

      const [, event] = await eventsAt(harness, ['2026-10-15T10:00:00', later]);

      expect(event?.age_months).toBe(ageMonths);
    },
  );

  it('sends no age_months on a day mark inside the same month', async () => {
    const harness = newHarness();

    const [, nextDay] = await eventsAt(harness, ['2026-10-15T10:00:00', '2026-10-16T10:00:00']);

    expect(nextDay?.first).toEqual(['day']);
    expect(nextDay).not.toHaveProperty('age_months');
  });

  it('counts the install from the first use, not from the first event', async () => {
    const harness = newHarness();
    harness.clock.setLocal('2026-10-01T10:00:00');
    await harness.collector.isEnabled();

    const [event] = await eventsAt(harness, ['2026-10-05T10:00:00']);

    expect(event?.age_days).toBe(4);
  });
});
