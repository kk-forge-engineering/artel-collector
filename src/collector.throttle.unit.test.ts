import { describe, expect, it } from 'vitest';
import { AnalyticsState } from './exports.js';
import { newHarness, type Harness } from '../tests/harness.js';
import { fromUntypedHost } from '../tests/untypedHost.js';

const THROTTLE_MS = 500;

/** Tracks `name` with `THROTTLE_MS` once at each of `times`, in milliseconds from the first call. */
async function trackedAt(harness: Harness, name: string, times: readonly number[]): Promise<void> {
  let now = 0;
  for (const time of times) {
    await harness.clock.advance(time - now);
    now = time;
    await harness.collector.track(name, undefined, { throttleMs: THROTTLE_MS });
  }
}

async function sentNames(harness: Harness): Promise<string[]> {
  await harness.collector.flush();
  return harness.fetch.eventNames;
}

describe('track with throttleMs', () => {
  it('sends the first of a series inside the window, and drops the rest without a report', async () => {
    const harness = newHarness();

    await trackedAt(harness, 'slider_moved', [0, 100, 200, 499]);

    expect(await sentNames(harness)).toEqual(['slider_moved']);
    expect(harness.errors).toEqual([]);
  });

  it('sends again once the window after the last event that went is over', async () => {
    const harness = newHarness();

    await trackedAt(harness, 'slider_moved', [0, 400, 500, 900, 1_000]);

    expect(await sentNames(harness)).toEqual(['slider_moved', 'slider_moved', 'slider_moved']);
  });

  it('keeps a window for each event name', async () => {
    const harness = newHarness();

    await trackedAt(harness, 'undo_pressed', [0, 100]);
    await harness.collector.track('redo_pressed', undefined, { throttleMs: THROTTLE_MS });

    expect(await sentNames(harness)).toEqual(['undo_pressed', 'redo_pressed']);
  });

  it('drops one of three calls that overlap inside the window, and none with a throttleMs of 0', async () => {
    const throttled = newHarness();
    const unthrottled = newHarness();

    await Promise.all(
      [0, 1, 2].map(() => throttled.collector.track('slider_moved', undefined, { throttleMs: THROTTLE_MS })),
    );
    await Promise.all([0, 1, 2].map(() => unthrottled.collector.track('slider_moved', undefined, { throttleMs: 0 })));

    expect([await sentNames(throttled), await sentNames(unthrottled)]).toEqual([
      ['slider_moved'],
      ['slider_moved', 'slider_moved', 'slider_moved'],
    ]);
  });

  it('opens no window for a call without throttleMs, and drops no such call', async () => {
    const harness = newHarness();

    await harness.collector.track('slider_moved');
    await harness.collector.track('slider_moved', undefined, { throttleMs: THROTTLE_MS });
    await harness.collector.track('slider_moved');

    expect(await sentNames(harness)).toEqual(['slider_moved', 'slider_moved', 'slider_moved']);
  });

  it('opens no window for an event it refuses for its params', async () => {
    const harness = newHarness();

    await harness.collector.track('slider_moved', { Bad: 1 }, { throttleMs: THROTTLE_MS });
    await harness.collector.track('slider_moved', undefined, { throttleMs: THROTTLE_MS });

    expect(await sentNames(harness)).toEqual(['slider_moved']);
    expect(harness.errors).toHaveLength(1);
  });

  it('opens no window for an event it does not record in the opted_out state', async () => {
    const harness = newHarness();
    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.track('slider_moved', undefined, { throttleMs: THROTTLE_MS });

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track('slider_moved', undefined, { throttleMs: THROTTLE_MS });

    expect((await sentNames(harness)).filter((name) => name === 'slider_moved')).toEqual(['slider_moved']);
  });

  it.each([
    ['negative', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a string, from a host outside TypeScript', fromUntypedHost<number>('500')],
  ])('refuses and reports an event whose throttleMs is %s', async (_case, throttleMs) => {
    const harness = newHarness();

    await harness.collector.track('slider_moved', undefined, { throttleMs });

    expect(await sentNames(harness)).toEqual([]);
    expect(harness.errors.map((error) => String(error))).toEqual([
      'Error: artel: event "slider_moved" has a throttleMs that is not a finite number from 0, so it was not tracked',
    ]);
  });

  it('takes a throttleMs of 0, which drops nothing', async () => {
    const harness = newHarness();

    await harness.collector.track('slider_moved', undefined, { throttleMs: 0 });
    await harness.collector.track('slider_moved', undefined, { throttleMs: 0 });

    expect(await sentNames(harness)).toEqual(['slider_moved', 'slider_moved']);
  });
});
