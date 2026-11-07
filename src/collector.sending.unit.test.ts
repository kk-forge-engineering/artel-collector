import { describe, expect, it } from 'vitest';
import { eventNamesIn } from '../tests/fakeFetch.js';
import { SEND_DELAY_MS, ENDPOINT, KEY, VERSION, newHarness } from '../tests/harness.js';

describe('the request', () => {
  it('posts the envelope as text/plain with keepalive to the endpoint', async () => {
    const harness = newHarness();

    await harness.collector.track('screenshot_taken', { mode: 'visible', count: 2, pinned: false });
    await harness.settle();

    const [request] = harness.fetch.requests;
    expect(request).toMatchObject({
      url: ENDPOINT,
      method: 'POST',
      contentType: 'text/plain;charset=UTF-8',
      keepalive: true,
    });
    expect(request?.envelope).toMatchObject({ key: KEY, platform: 'extension', version: VERSION, lang: 'en' });
    expect(request?.envelope.events[0]?.params).toEqual({ mode: 'visible', count: 2, pinned: false });
  });

  it('hands the envelope to the transport the host gives', async () => {
    const bodies: string[] = [];
    const harness = newHarness({
      transport: async (body) => {
        bodies.push(body);
        return 204;
      },
    });

    await harness.collector.track('a');
    await harness.settle();

    expect(bodies.flatMap(eventNamesIn)).toEqual(['a']);
  });

  it('leaves out lang, id and params the host did not give', async () => {
    const harness = newHarness({ lang: undefined });

    await harness.collector.track('a');
    await harness.settle();

    const envelope = harness.fetch.requests[0]?.envelope;
    expect(envelope).not.toHaveProperty('lang');
    expect(envelope).not.toHaveProperty('id');
    expect(envelope?.events[0]).not.toHaveProperty('params');
  });

  it('includes the id getId returns', async () => {
    const harness = newHarness({ getId: () => 'c0ffee12' });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope.id).toBe('c0ffee12');
  });

  it('includes no id while getId returns none', async () => {
    const harness = newHarness({ getId: async () => undefined });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope).not.toHaveProperty('id');
  });

  it('sends events tracked under different ids in separate envelopes', async () => {
    let id: string | undefined;
    const harness = newHarness({ getId: () => id });

    await harness.collector.track('before_consent');
    id = 'c0ffee12';
    await harness.collector.track('after_consent');
    await harness.settle();

    expect(harness.fetch.requests.map((request) => [request.envelope.id, request.envelope.events.length])).toEqual([
      [undefined, 1],
      ['c0ffee12', 1],
    ]);
  });

  it('adds the page fields getPage returns to each event', async () => {
    const harness = newHarness({ getPage: () => ({ page: '/pricing', referrer: 'www.google.com' }) });

    await harness.collector.track('page_view');
    await harness.settle();

    expect(harness.fetch.events[0]).toMatchObject({ page: '/pricing', referrer: 'www.google.com' });
  });
});

describe('batching', () => {
  it('sends 101 events as a post of 100 and a post of 1', async () => {
    const harness = newHarness();

    for (let index = 0; index < 101; index++) {
      await harness.collector.track('a');
    }
    await harness.settle();

    expect(harness.fetch.requests.map((request) => request.envelope.events.length)).toEqual([100, 1]);
  });

  it('starts a new envelope before one would pass 60 kB, under the 64 KiB a keepalive request and the intake take', async () => {
    const harness = newHarness();
    const params = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`param_${index}`, 'x'.repeat(64)]));

    for (let index = 0; index < 100; index++) {
      await harness.collector.track('a', params);
    }
    await harness.settle();

    const sizes = harness.fetch.requests.map(
      (request) => new TextEncoder().encode(JSON.stringify(request.envelope)).length,
    );
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(60_000);
    expect(harness.fetch.events).toHaveLength(100);
  });

  it('posts a full envelope at once, without waiting for the pause', async () => {
    const harness = newHarness();

    for (let index = 0; index < 100; index++) {
      await harness.collector.track('a');
    }
    await harness.clock.advance(0);

    expect(harness.fetch.requests).toHaveLength(1);
  });

  it('sends within 5 s of the first queued event, even while events keep coming', async () => {
    const harness = newHarness();

    await harness.collector.track('a');
    await harness.clock.advance(SEND_DELAY_MS - 1_000);
    await harness.collector.track('b');
    await harness.clock.advance(900);
    expect(harness.fetch.requests).toHaveLength(0);

    await harness.clock.advance(100);

    expect(harness.fetch.requests).toHaveLength(1);
    expect(harness.fetch.eventNames).toEqual(['a', 'b']);
  });

  it('sends within the delay the host sets', async () => {
    const harness = newHarness({ sendDelaySeconds: 1 });

    await harness.collector.track('a');
    await harness.clock.advance(1_000);

    expect(harness.fetch.eventNames).toEqual(['a']);
  });

  it('posts at once on flush', async () => {
    const harness = newHarness();

    await harness.collector.track('a');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a']);
  });

  it('posts nothing on flush with nothing queued', async () => {
    const harness = newHarness();

    await harness.collector.flush();

    expect(harness.fetch.requests).toHaveLength(0);
  });

  it('posts events tracked without awaiting, in the order they were tracked', async () => {
    const harness = newHarness();

    void harness.collector.track('a');
    void harness.collector.track('b');
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(['a', 'b']);
    expect(harness.fetch.events.filter((event) => event.first !== undefined)).toHaveLength(1);
  });

  it('sends events a stopped host left queued, once a new run starts', async () => {
    const harness = newHarness();
    await harness.collector.track('a');
    harness.clock.dropTimers();

    const restarted = harness.restart();
    await restarted.isEnabled();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['a']);
  });
});
