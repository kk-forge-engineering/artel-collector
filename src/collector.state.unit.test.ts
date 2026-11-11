import { describe, expect, it } from 'vitest';
import { AnalyticsState, type StorageAdapter } from './exports.js';
import { fromUntypedHost } from '../tests/untypedHost.js';
import { KEY, newHarness, QUEUE_KEY, STATE_KEY, USER_ID, VERSION } from '../tests/harness.js';

describe('the analytics state', () => {
  it('starts anonymous', async () => {
    const harness = newHarness();

    expect(await harness.collector.getState()).toBe('anonymous');
  });

  it('starts anonymous in an identified channel too, and asks for no id', async () => {
    let asked = 0;
    const harness = newHarness({ getId: () => (asked++, USER_ID), state: undefined });

    await harness.collector.track('first');
    await harness.settle();

    expect(await harness.collector.getState()).toBe('anonymous');
    expect(harness.fetch.requests[0]?.envelope).not.toHaveProperty('id');
    expect(asked).toBe(0);
  });

  it('switches off with one opted_out that names no user and drops what was not sent, then sends nothing', async () => {
    const harness = newHarness({ getId: () => USER_ID, browser: { name: 'chrome', major: 131 } });
    await harness.collector.track('before');

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.track('while_off');
    await harness.collector.flush();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['opted_out']);
    const [request] = harness.fetch.requests;
    expect(request?.envelope).not.toHaveProperty('id');
    expect(request?.envelope).not.toHaveProperty('browser');
    expect(request?.envelope).toMatchObject({ browser_language: 'pt', ui_language: 'zh' });
    // The collector sends opted_out with no first-of-period mark and no age, so no count of active users takes this
    // event.
    expect(request?.envelope.events[0]).toEqual({ name: 'opted_out', day: '2026-10-29' });
    expect(await harness.collector.getState()).toBe('opted_out');
  });

  it('sends opted_out in an envelope of its own, under a session no other event shares', async () => {
    const harness = newHarness({ getId: () => USER_ID, browser: { name: 'chrome', major: 131 } });
    await harness.collector.track('before');

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.setState(AnalyticsState.Identified);
    await harness.collector.track('after');
    await harness.settle();

    expect(harness.fetch.eventNamesByRequest).toEqual([['opted_out'], ['after']]);
    const [optOut, after] = harness.fetch.requests;
    expect(optOut?.envelope).not.toHaveProperty('id');
    expect(optOut?.envelope).not.toHaveProperty('browser');
    expect(optOut?.envelope.session).not.toBe(after?.envelope.session);
  });

  it('sends opted_out under a new session, apart from the events sent before it', async () => {
    const harness = newHarness();
    await harness.collector.track('before');
    await harness.settle();

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.settle();

    const [before, optOut] = harness.fetch.requests.map((request) => request.envelope.session);
    expect(harness.fetch.eventNames).toEqual(['before', 'opted_out']);
    expect(optOut).not.toBe(before);
  });

  it('sends opted_out at once, without waiting for the send delay', async () => {
    const harness = newHarness();

    await harness.collector.setState(AnalyticsState.OptedOut);

    expect(harness.fetch.eventNames).toEqual(['opted_out']);
  });

  it('keeps an unsent opted_out when the user opts out a second time', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503);

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.settle();

    const [first, retry, second] = harness.fetch.requests.map((request) => request.envelope.batch);
    expect(harness.fetch.eventNamesByRequest).toEqual([['opted_out'], ['opted_out'], ['opted_out']]);
    expect(retry).toBe(first);
    expect(second).not.toBe(first);
  });

  it('queues no opted_out and keeps the state when storing the opted_out state fails', async () => {
    const harness = newHarness();
    const failing: StorageAdapter = {
      get: (key) => harness.storage.get(key),
      set: async (key, value) => {
        if (key === STATE_KEY) {
          throw new Error('quota');
        }
        await harness.storage.set(key, value);
      },
    };
    const collector = harness.restart({ storage: failing });
    await collector.track('before');

    await collector.setState(AnalyticsState.OptedOut);
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['before']);
    expect(await collector.getState()).toBe('anonymous');
    expect(harness.errors).toEqual([new Error('quota')]);
  });

  it('sends opted_out when the queue it drops holds an event whose day does not parse', async () => {
    const harness = newHarness();
    const event = { name: 'a', day: 'not a day', first: ['day'] };
    const envelope = { key: KEY, platform: 'extension', version: VERSION, session: 'k3j9x2m1qa0b', events: [event] };
    await harness.storage.set(QUEUE_KEY, JSON.stringify([{ qid: 'aaaaaaaaaaaaaaaa', envelope }]));

    await harness.collector.setState(AnalyticsState.OptedOut);

    expect(harness.fetch.eventNames).toEqual(['opted_out']);
    expect(harness.errors).toEqual([]);
  });

  it('drops what is queued, but an opted_out, on the first call in the opted_out state', async () => {
    const harness = newHarness();
    harness.fetch.respondNextWith(503);
    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.storage.set(STATE_KEY, AnalyticsState.Anonymous);
    await harness.collector.track('left_by_a_stopped_run');
    await harness.storage.set(STATE_KEY, AnalyticsState.OptedOut);

    await harness.restart().flush();
    await harness.settle();

    expect(harness.fetch.eventNamesByRequest).toEqual([['opted_out'], ['opted_out']]);
    expect(harness.errors).toEqual([]);
  });

  it('sends no event when the user leaves the opted_out state, and counts again from there', async () => {
    const harness = newHarness({ state: AnalyticsState.OptedOut });

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track('after');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['after']);
  });

  it('takes no install or version mark while opted out, so both go once the user is back', async () => {
    const harness = newHarness({ state: AnalyticsState.OptedOut });
    await harness.collector.installed();
    await harness.collector.updated();

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.installed();
    await harness.restart({ version: '4.3.0' }).updated();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['installed', 'updated']);
  });

  it('takes no version mark for an update while opted out, so updated goes once the user is back', async () => {
    const harness = newHarness();
    await harness.collector.installed();
    await harness.settle();
    await harness.collector.setState(AnalyticsState.OptedOut);

    const upgraded = harness.restart({ version: '4.3.0' });
    await upgraded.updated();
    await upgraded.setState(AnalyticsState.Anonymous);
    await upgraded.updated();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['installed', 'opted_out', 'updated']);
  });

  it('does nothing when set to the state it is in', async () => {
    const harness = newHarness({ state: AnalyticsState.OptedOut });

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.settle();

    expect(harness.fetch.requests).toEqual([]);
  });

  it('refuses the identified state in an anonymous channel, which only a host outside TypeScript asks for', async () => {
    const harness = newHarness();

    await harness.collector.setState(fromUntypedHost(AnalyticsState.Identified));

    expect(await harness.collector.getState()).toBe('anonymous');
    expect(harness.errors).toEqual([new TypeError('artel: a channel of mode "anonymous" takes no state "identified"')]);
  });

  it.each([
    ['bigint', 10n],
    ['symbol', Symbol('state')],
  ])('names a state JSON cannot write by its type, %s, in the report', async (type, state) => {
    const harness = newHarness();

    await harness.collector.setState(fromUntypedHost(state));

    expect(harness.errors).toEqual([new TypeError(`artel: a channel of mode "anonymous" takes no state ${type}`)]);
  });

  it('refuses a state that does not exist', async () => {
    const harness = newHarness();

    await harness.collector.setState(fromUntypedHost('on'));

    expect(await harness.collector.getState()).toBe('anonymous');
    expect(harness.errors).toHaveLength(1);
  });

  it('drops the queued events that name the user when the user leaves the identified state', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.collector.track('identified');

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track('anonymous');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['anonymous']);
    expect(harness.fetch.requests[0]?.envelope).not.toHaveProperty('id');
  });

  it('starts a new session on each change of state', async () => {
    const harness = newHarness({ getId: () => USER_ID, state: AnalyticsState.Anonymous });
    await harness.collector.track('anonymous');
    await harness.settle();

    await harness.collector.setState(AnalyticsState.Identified);
    await harness.collector.track('identified');
    await harness.settle();

    const [before, after] = harness.fetch.requests.map((request) => request.envelope.session);
    expect(before).not.toBe(after);
    expect(after).toMatch(/^[\da-z]{12}$/);
  });

  it('keeps the state across a restart of the host', async () => {
    const harness = newHarness();
    await harness.collector.setState(AnalyticsState.OptedOut);

    expect(await harness.restart().getState()).toBe('opted_out');
  });
});

describe('what a change of state leaves behind', () => {
  it('lets the opt-out take no first-of-day mark and no active day, so the day still counts after a return', async () => {
    const harness = newHarness();

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track('back');
    await harness.settle();

    const back = harness.fetch.events.find((event) => event.name === 'back');
    expect(back?.first).toEqual(['day', 'week', 'month', 'quarter', 'year']);
    expect((await harness.collector.uninstallParams())?.active_days).toBe('1');
  });

  it('asks for no id once the state left identified, even for an envelope already waiting', async () => {
    let calls = 0;
    const harness = newHarness({
      getId: () => {
        calls++;
        return undefined;
      },
    });
    await harness.collector.track('waiting');
    await harness.settle();
    const callsWhileIdentified = calls;

    // The test acts as another context that switches the state after this context leased the waiting envelope and
    // before it sealed it.
    await harness.storage.set(STATE_KEY, 'anonymous');
    await harness.collector.flush();

    expect(callsWhileIdentified).toBeGreaterThan(0);
    expect(calls).toBe(callsWhileIdentified);
    expect(harness.fetch.requests).toEqual([]);
  });

  it('reads an identified state another context stored as anonymous in an anonymous channel', async () => {
    const harness = newHarness();
    await harness.collector.track('before');

    await harness.storage.set(STATE_KEY, AnalyticsState.Identified);
    await harness.collector.track('after');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['before', 'after']);
    expect(await harness.collector.getState()).toBe('anonymous');
  });

  it('starts a new session once the channel is anonymous under a stored identified state', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.collector.track('identified');
    await harness.settle();

    await harness.restart({ getId: fromUntypedHost(undefined) }).track('anonymous');
    await harness.settle();

    const [identified, anonymous] = harness.fetch.requests.map((request) => request.envelope.session);
    expect(harness.fetch.eventNames).toEqual(['identified', 'anonymous']);
    expect(anonymous).not.toBe(identified);
  });

  it('drops the identified state and the waiting events once the channel is anonymous', async () => {
    const harness = newHarness({ getId: () => undefined });
    await harness.collector.track('waiting');

    const anonymous = harness.restart({ getId: fromUntypedHost(undefined) });
    await anonymous.track('anonymous');
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['anonymous']);
    expect(await harness.storage.get(QUEUE_KEY)).toBe('[]');
    const identifiedAgain = harness.restart({ getId: () => USER_ID });
    expect(await identifiedAgain.getState()).toBe('anonymous');
  });
});

describe('the opted_out state, further', () => {
  it('dates opted_out by the local day, not the UTC one', async () => {
    const harness = newHarness();
    // 22:30 in New York is 02:30 UTC of the next day.
    harness.clock.setLocal('2026-10-29T22:30:00');

    await harness.collector.setState(AnalyticsState.OptedOut);

    expect(harness.fetch.events).toEqual([{ name: 'opted_out', day: '2026-10-29' }]);
  });

  it('queues nothing for the methods called in the opted_out state, so nothing is dropped and reported later', async () => {
    const harness = newHarness();
    await harness.collector.setState(AnalyticsState.OptedOut);

    await harness.collector.installed();
    await harness.collector.updated();
    await harness.collector.track('opened');
    await harness.collector.flush();
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(['opted_out']);
    expect(harness.errors).toEqual([]);
  });
});

describe('getState over a failing storage', () => {
  it('resolves to anonymous and reports the failure', async () => {
    const storage: StorageAdapter = {
      get: () => Promise.reject(new Error('storage gone')),
      set: () => Promise.reject(new Error('storage gone')),
    };
    const harness = newHarness({ storage, state: undefined });

    expect(await harness.collector.getState()).toBe(AnalyticsState.Anonymous);
    expect(harness.errors).toEqual([new Error('storage gone')]);
  });
});
