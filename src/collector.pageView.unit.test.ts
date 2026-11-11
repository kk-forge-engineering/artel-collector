import { describe, expect, it } from 'vitest';
import { AnalyticsState, newMemoryStorage, Platform, type PageFields, type StorageAdapter } from './exports.js';
import { newHarness } from '../tests/harness.js';

/** Returns a harness of a site whose `getPage` gives `fields`. */
function newSiteHarness(fields: PageFields, state?: AnalyticsState): ReturnType<typeof newHarness> {
  return newHarness({ platform: Platform.Web, getPage: () => fields, state });
}

describe('a page_view the collector does not record', () => {
  it('leaves the dedup and the referrer to the first page_view it records after an opt-in', async () => {
    const harness = newSiteHarness({ page: '/a', referrer: 'https://news.example.org/story' }, AnalyticsState.OptedOut);

    await harness.collector.track('page_view');
    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.page, event.referrer])).toEqual([
      ['page_view', '/a', 'news.example.org'],
    ]);
  });

  it('sends the referrer with only the first of two page_views called before either is recorded', async () => {
    const fields = { page: '/a', referrer: 'https://news.example.org/story' };
    const harness = newSiteHarness(fields);

    const first = harness.collector.track('page_view');
    fields.page = '/b';
    const second = harness.collector.track('page_view');
    await Promise.all([first, second]);
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.page, event.referrer])).toEqual([
      ['/a', 'news.example.org'],
      ['/b', undefined],
    ]);
  });
});

describe('a page_view the queue did not take', () => {
  it('leaves the dedup and the referrer to the next page_view of the page', async () => {
    const memory = newMemoryStorage();
    let isFailing = true;
    const storage: StorageAdapter = {
      get: (key) => memory.get(key),
      set: async (key, value) => {
        if (isFailing && key.endsWith('.queue')) {
          isFailing = false;
          throw new Error('quota');
        }
        await memory.set(key, value);
      },
    };
    const harness = newHarness({
      platform: Platform.Web,
      storage,
      getPage: () => ({ page: '/a', referrer: 'https://news.example.org/story' }),
    });

    await harness.collector.track('page_view');
    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.page, event.referrer])).toEqual([
      ['page_view', '/a', 'news.example.org'],
    ]);
    expect(harness.errors).toEqual([new Error('quota')]);
  });
});
