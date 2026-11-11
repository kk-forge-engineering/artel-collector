import { describe, expect, it } from 'vitest';
import type { SentEvent } from '../tests/fakeFetch.js';
import { AnalyticsState } from './exports.js';
import { newHarness, storageKey, USER_ID, type Harness } from '../tests/harness.js';

/** Tracks one event at each local time in turn and returns what the collector sent for each. */
async function eventsAt(harness: Harness, localTimes: string[]): Promise<SentEvent[]> {
  for (const localTime of localTimes) {
    harness.clock.setLocal(localTime);
    await harness.collector.track('report_exported');
    await harness.settle();
  }
  return harness.fetch.events;
}

describe('period marks', () => {
  it('marks every period on the first event ever, and none on the next one that day', async () => {
    const harness = newHarness();

    const [first, second] = await eventsAt(harness, ['2026-10-29T10:00:00', '2026-10-29T18:00:00']);

    expect(first).toEqual({
      name: 'report_exported',
      day: '2026-10-29',
      first: ['day', 'week', 'month', 'quarter', 'year'],
      age_days: 0,
      age_months: 0,
    });
    expect(second).toEqual({ name: 'report_exported', day: '2026-10-29' });
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

describe('install age in the identified state', () => {
  it.each([
    { later: '2026-10-02T09:00:00', ageDays: 1 },
    { later: '2026-10-31T09:00:00', ageDays: 30 },
    { later: '2026-11-01T09:00:00', ageDays: 31 },
    { later: '2027-03-15T09:00:00', ageDays: 31 },
  ])('sends age_days $ageDays on the first event of $later after an install on 1 Oct', async ({ later, ageDays }) => {
    const harness = newHarness({ getId: () => USER_ID });

    const [, event] = await eventsAt(harness, ['2026-10-01T10:00:00', later]);

    expect(event?.age_days).toBe(ageDays);
  });

  it('counts calendar days, so a 25-hour day counts as one', async () => {
    // The test expects 2 calendar days across 26 hours of elapsed time. The run's zone is America/New_York, which
    // leaves daylight saving on 1 Nov 2026, so that day lasts 25 hours.
    const harness = newHarness({ getId: () => USER_ID });

    const [, event] = await eventsAt(harness, ['2026-10-31T23:30:00', '2026-11-02T00:30:00']);

    expect(event?.age_days).toBe(2);
  });

  it('sends no age_days without the day mark', async () => {
    const harness = newHarness({ getId: () => USER_ID });

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
      const harness = newHarness({ getId: () => USER_ID });

      const [, event] = await eventsAt(harness, ['2026-10-15T10:00:00', later]);

      expect(event?.age_months).toBe(ageMonths);
    },
  );

  it('sends no age_months on a day mark inside the same month', async () => {
    const harness = newHarness({ getId: () => USER_ID });

    const [, nextDay] = await eventsAt(harness, ['2026-10-15T10:00:00', '2026-10-16T10:00:00']);

    expect(nextDay?.first).toEqual(['day']);
    expect(nextDay).not.toHaveProperty('age_months');
  });

  it('counts the install from the first use, not from the first event', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    harness.clock.setLocal('2026-10-01T10:00:00');
    await harness.collector.getState();

    const [event] = await eventsAt(harness, ['2026-10-05T10:00:00']);

    expect(event?.age_days).toBe(4);
  });
});

describe('install age in the anonymous state', () => {
  it.each([
    { firstUse: '2026-10-01T10:00:00', event: '2026-10-01T11:00:00', ageDays: 0 },
    { firstUse: '2026-10-01T10:00:00', event: '2026-10-02T10:00:00', ageDays: 1 },
    { firstUse: '2026-10-01T10:00:00', event: '2026-10-07T10:00:00', ageDays: 2 },
    { firstUse: '2026-10-01T10:00:00', event: '2026-10-08T10:00:00', ageDays: 7 },
    { firstUse: '2026-10-01T10:00:00', event: '2026-10-20T10:00:00', ageDays: 14 },
    { firstUse: '2026-10-01T10:00:00', event: '2026-11-15T10:00:00', ageDays: 30 },
  ])('sends age_days $ageDays, a bucket, on the first event of $event', async ({ firstUse, event, ageDays }) => {
    const harness = newHarness();
    harness.clock.setLocal(firstUse);
    await harness.collector.getState();

    const [sent] = await eventsAt(harness, [event]);

    expect(sent?.age_days).toBe(ageDays);
  });

  it.each([
    { event: '2026-11-15T10:00:00', ageMonths: 1 },
    { event: '2026-12-15T10:00:00', ageMonths: 2 },
    { event: '2027-02-15T10:00:00', ageMonths: 3 },
    { event: '2027-05-15T10:00:00', ageMonths: 6 },
    { event: '2027-11-15T10:00:00', ageMonths: 12 },
    { event: '2029-01-15T10:00:00', ageMonths: 24 },
  ])('sends age_months $ageMonths, a bucket, on the first event of $event', async ({ event, ageMonths }) => {
    const harness = newHarness();
    harness.clock.setLocal('2026-10-15T10:00:00');
    await harness.collector.getState();

    const [sent] = await eventsAt(harness, [event]);

    expect(sent?.age_months).toBe(ageMonths);
  });
});

describe('marks of events a choice of the user drops', () => {
  const ALL_PERIODS = ['day', 'week', 'month', 'quarter', 'year'];

  it('still counts the day after identified events that waited for an id are dropped by leaving identified', async () => {
    const harness = newHarness({ getId: () => undefined });
    await harness.collector.track('waiting');

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track('after');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['after']);
    expect(harness.fetch.events[0]?.first).toEqual(ALL_PERIODS);
  });

  it('still counts the day after an unsent identified event is dropped by leaving identified', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.collector.track('identified');

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track('anonymous');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['anonymous']);
    expect(harness.fetch.events[0]?.first).toEqual(ALL_PERIODS);
  });

  it('still counts the day after an unsent event is dropped by an opt-out and the user comes back', async () => {
    const harness = newHarness();
    await harness.collector.track('before');

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track('back');
    await harness.settle();

    const back = harness.fetch.events.find((event) => event.name === 'back');
    expect(back?.first).toEqual(ALL_PERIODS);
    expect((await harness.collector.uninstallParams())?.active_days).toBe('1');
  });

  it('still counts the day after the host forgets the user whose event did not go', async () => {
    let id: string | undefined = USER_ID;
    const harness = newHarness({ getId: () => id });
    await harness.collector.track('forgotten');

    await harness.collector.forget(USER_ID);
    id = 'other-user';
    await harness.collector.track('after');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['after']);
    expect(harness.fetch.events[0]?.first).toEqual(ALL_PERIODS);
  });

  it('gives back the marks of dropped events from two days', async () => {
    const harness = newHarness({ getId: () => undefined });
    harness.clock.setLocal('2026-10-29T10:00:00');
    await harness.collector.track('waiting');
    harness.clock.setLocal('2026-10-30T10:00:00');
    await harness.collector.track('next_day');

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track('after');
    await harness.settle();

    expect(harness.fetch.events).toEqual([
      { name: 'after', day: '2026-10-30', first: ALL_PERIODS, age_days: 1, age_months: 0 },
    ]);
  });

  it('sends installed again after an installed that waited for an id is dropped by leaving identified', async () => {
    const harness = newHarness({ getId: () => undefined });
    await harness.collector.installed();

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.installed();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['installed']);
  });

  it('still sends updated after an updated that waited for an id is dropped by another user', async () => {
    let id: string | undefined = USER_ID;
    const harness = newHarness({ getId: () => id, version: '1.0.0' });
    await harness.collector.installed();
    await harness.settle();

    id = undefined;
    const updated = harness.restart({ getId: () => id, version: '1.1.0' });
    await updated.updated();
    id = 'other-user';
    await updated.track('after_sign_in');
    await updated.updated();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['installed', 'after_sign_in', 'updated']);
  });

  it('keeps the marks of an event the intake refused', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(400);
    await harness.collector.track('refused');
    await harness.settle();

    await harness.collector.track('next');
    await harness.settle();

    expect(harness.fetch.events.map((event) => event.first)).toEqual([ALL_PERIODS, undefined]);
  });
});

describe('install age after the clock was set back before the install day', () => {
  it.each([
    ['identified', { getId: () => USER_ID }],
    ['anonymous', {}],
  ])('sends age_days 0 on the first event of the earlier day in the %s state', async (_, overrides) => {
    const harness = newHarness(overrides);

    const [, event] = await eventsAt(harness, ['2026-10-02T10:00:00', '2026-10-01T10:00:00']);

    expect(event?.first).toEqual(['day']);
    expect(event?.age_days).toBe(0);
  });

  it('gives age_days 0 to the uninstall page in the identified state', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    harness.clock.setLocal('2026-10-02T10:00:00');
    await harness.collector.getState();
    harness.clock.setLocal('2026-10-01T10:00:00');

    expect((await harness.collector.uninstallParams())?.age_days).toBe(0);
  });
});

describe('install age across the start of daylight saving', () => {
  it('counts calendar days, so a 23-hour day counts as one', async () => {
    // 8 Mar 2026 starts daylight saving in America/New_York, the zone of the run, so that day lasts 23 hours.
    const harness = newHarness({ getId: () => USER_ID });

    const [, event] = await eventsAt(harness, ['2026-03-07T10:00:00', '2026-03-09T09:00:00']);

    expect(event?.age_days).toBe(2);
  });
});

describe('a stored install day the collector never writes', () => {
  it('reads one with more than the date as none, and takes today as the install day', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.storage.set(storageKey('install_day'), '2026-10-01T00:00');

    await harness.collector.track('opened');
    await harness.settle();

    expect(harness.fetch.events[0]?.age_days).toBe(0);
  });
});
