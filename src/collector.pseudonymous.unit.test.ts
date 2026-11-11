import { describe, expect, it } from 'vitest';
import { AnalyticsState, Mode, newMemoryStorage, Platform, type StorageAdapter } from './exports.js';
import { newHarness, STATE_KEY, storageKey, USER_ID } from '../tests/harness.js';
import { fromUntypedHost } from '../tests/untypedHost.js';

const INSTALL_ID_KEY = storageKey('install_id');
const INSTALL_ID = /^[\da-f]{32}$/;
const BROWSER = { name: 'chrome', major: 131 } as const;

describe('the pseudonymous state', () => {
  it('sends a random install id of its kind, the browser, the full languages and exact ages', async () => {
    const harness = newHarness({ mode: Mode.Pseudonymous, browser: BROWSER });
    harness.clock.setLocal('2026-11-02T10:00:00');
    await harness.storage.set(storageKey('install_day'), '2026-10-29');

    await harness.collector.track('a');
    await harness.settle();

    const envelope = harness.fetch.requests[0]?.envelope;
    expect(envelope).toMatchObject({
      browser_language: 'pt-BR',
      ui_language: 'zh-Hant-TW',
      browser: BROWSER,
      id_kind: 'pseudonymous',
    });
    expect(envelope?.id).toMatch(INSTALL_ID);
    expect(envelope?.events[0]?.age_days).toBe(4);
  });

  it('keeps one install id across events and restarts, and stores it under the channel key', async () => {
    const harness = newHarness({ mode: Mode.Pseudonymous });

    await harness.collector.track('a');
    await harness.settle();
    await harness.restart().track('b');
    await harness.settle();

    const [first, second] = harness.fetch.requests.map((request) => request.envelope.id);
    expect(second).toBe(first);
    expect(await harness.storage.get(INSTALL_ID_KEY)).toBe(first);
  });

  it('makes a fresh install id when the user comes back after leaving', async () => {
    const harness = newHarness({ mode: Mode.Pseudonymous });
    await harness.collector.track('a');
    await harness.settle();

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.setState(AnalyticsState.Pseudonymous);
    await harness.collector.track('b');
    await harness.settle();

    const [first, second] = harness.fetch.requests.map((request) => request.envelope.id);
    expect(second).toMatch(INSTALL_ID);
    expect(second).not.toBe(first);
  });

  it('replaces a stored install id that breaks its format', async () => {
    const harness = newHarness({ mode: Mode.Pseudonymous });
    await harness.storage.set(INSTALL_ID_KEY, 'planted-id');

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope.id).toMatch(INSTALL_ID);
  });

  it('sends the install id from a desktop product, with no browser', async () => {
    const harness = newHarness({ mode: Mode.Pseudonymous, platform: Platform.MacOs });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope).toMatchObject({ platform: 'macos', id_kind: 'pseudonymous' });
    expect(harness.fetch.requests[0]?.envelope).not.toHaveProperty('browser');
  });

  it('reads no browser in the anonymous state of a pseudonymous channel', async () => {
    let reads = 0;
    const harness = newHarness({
      mode: Mode.Pseudonymous,
      browser: () => (reads++, BROWSER),
      state: AnalyticsState.Anonymous,
    });

    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope).not.toHaveProperty('id');
    expect(reads).toBe(0);
  });
});

describe('the states a mode takes', () => {
  it.each([
    [Mode.Anonymous, AnalyticsState.Pseudonymous],
    [Mode.Anonymous, AnalyticsState.Identified],
    [Mode.Pseudonymous, AnalyticsState.Identified],
  ])('refuses in a %s channel the %s state, which only a host outside TypeScript asks for', async (mode, state) => {
    const harness = newHarness({ mode, state: AnalyticsState.Anonymous });

    await harness.collector.setState(fromUntypedHost(state));

    expect(await harness.collector.getState()).toBe('anonymous');
    expect(harness.errors).toEqual([new TypeError(`artel: a channel of mode "${mode}" takes no state "${state}"`)]);
  });

  it('takes the pseudonymous state in an identified channel', async () => {
    const harness = newHarness({ getId: () => USER_ID, state: AnalyticsState.Anonymous });

    await harness.collector.setState(AnalyticsState.Pseudonymous);
    await harness.collector.track('a');
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope).toMatchObject({ id_kind: 'pseudonymous' });
    expect(harness.fetch.requests[0]?.envelope.id).toMatch(INSTALL_ID);
  });

  it('reads an identified state stored in a pseudonymous channel as anonymous, and forgets its last id', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.collector.track('identified');
    await harness.settle();

    const pseudonymous = harness.restart({ getId: fromUntypedHost(undefined), mode: Mode.Pseudonymous });
    await pseudonymous.track('anonymous');
    await harness.settle();

    expect(await pseudonymous.getState()).toBe('anonymous');
    expect(harness.fetch.requests[1]?.envelope).not.toHaveProperty('id');
    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual([USER_ID]);
  });
});

describe('a change between the pseudonymous and the identified state', () => {
  it('drops the unsent events of the install id and starts a new session, as for another user', async () => {
    const harness = newHarness({ getId: () => USER_ID, state: AnalyticsState.Pseudonymous });
    await harness.collector.track('sent');
    await harness.settle();
    await harness.collector.track('unsent');

    await harness.collector.setState(AnalyticsState.Identified);
    await harness.collector.track('identified');
    await harness.settle();

    const sent = harness.fetch.requests.map((request) => [request.envelope.id_kind, request.envelope.events[0]?.name]);
    expect(sent).toEqual([
      ['pseudonymous', 'sent'],
      ['identified', 'identified'],
    ]);
    const [before, after] = harness.fetch.requests.map((request) => request.envelope.session);
    expect(after).not.toBe(before);
  });

  it('forgets the install id when the user moves to the identified state', async () => {
    const harness = newHarness({ getId: () => USER_ID, state: AnalyticsState.Pseudonymous });
    await harness.collector.track('a');
    await harness.settle();

    await harness.collector.setState(AnalyticsState.Identified);

    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual([harness.fetch.requests[0]?.envelope.id]);
  });

  it('forgets the account id when the user moves to the pseudonymous state', async () => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.collector.track('a');

    await harness.collector.setState(AnalyticsState.Pseudonymous);

    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual([USER_ID]);
  });

  it('sends what waited for the account id under that id after the change', async () => {
    let id: string | undefined;
    const harness = newHarness({ getId: () => id, state: AnalyticsState.Pseudonymous });
    await harness.collector.track('pseudonymous');
    await harness.settle();

    await harness.collector.setState(AnalyticsState.Identified);
    await harness.collector.track('waiting');
    await harness.settle();
    id = USER_ID;
    await harness.collector.flush();

    expect(harness.fetch.requests.at(-1)?.envelope).toMatchObject({ id: USER_ID, id_kind: 'identified' });
    expect(harness.fetch.eventNames).toEqual(['pseudonymous', 'waiting']);
  });
});

/**
 * Returns a harness over a storage whose writes of `failingKey` fail while `isStopping` is set, as when the host stops
 * at that write: nothing after it in the same call runs. The user starts in `state`.
 */
async function newStoppingHarness({
  failingKey,
  state,
  ...overrides
}: Parameters<typeof newHarness>[0] & { failingKey: string; state: AnalyticsState }) {
  const memory = newMemoryStorage();
  const control = { isStopping: false };
  const storage: StorageAdapter = {
    get: (name) => memory.get(name),
    set: (name, value) =>
      name === failingKey && control.isStopping ? Promise.reject(new Error('host stopped')) : memory.set(name, value),
  };
  await storage.set(STATE_KEY, state);
  return { harness: newHarness({ ...overrides, storage, state: undefined }), storage, control };
}

describe('a run that stops while it switches between the pseudonymous and the identified state', () => {
  it('has forgotten the account id, and sends nothing under it on the next run', async () => {
    const { harness, control } = await newStoppingHarness({
      getId: () => USER_ID,
      failingKey: STATE_KEY,
      state: AnalyticsState.Identified,
    });
    await harness.collector.track('a');
    control.isStopping = true;

    await harness.collector.setState(AnalyticsState.Pseudonymous);
    control.isStopping = false;
    await harness.restart().flush();
    await harness.settle();

    expect(harness.fetch.requests.map((request) => request.envelope.id)).not.toContain(USER_ID);
    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual([USER_ID]);
  });

  it('has forgotten the install id, and the next run sends under a new one', async () => {
    const { harness, control } = await newStoppingHarness({
      getId: () => USER_ID,
      failingKey: STATE_KEY,
      state: AnalyticsState.Pseudonymous,
    });
    await harness.collector.track('a');
    await harness.settle();
    const installId = harness.fetch.requests[0]?.envelope.id;
    control.isStopping = true;

    await harness.collector.setState(AnalyticsState.Identified);
    control.isStopping = false;
    await harness.restart().track('b');
    await harness.settle();

    expect(installId).toMatch(INSTALL_ID);
    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual([installId]);
    expect(harness.fetch.requests[1]?.envelope.id).not.toBe(installId);
  });

  it('never seals an event that waited for the account id under the install id', async () => {
    const { harness, control } = await newStoppingHarness({
      getId: () => undefined,
      // The first write after the state is the queue's, which drops the waiting event.
      failingKey: storageKey('queue'),
      state: AnalyticsState.Identified,
    });
    await harness.collector.track('waiting');
    control.isStopping = true;

    await harness.collector.setState(AnalyticsState.Pseudonymous);
    control.isStopping = false;
    await harness.restart().flush();
    await harness.settle();

    expect(harness.fetch.requests).toEqual([]);
  });

  it('deletes the install id even when it stops before it clears the last id', async () => {
    const { harness, storage, control } = await newStoppingHarness({
      mode: Mode.Pseudonymous,
      failingKey: storageKey('last_id'),
      state: AnalyticsState.Pseudonymous,
    });
    await harness.collector.track('a');
    control.isStopping = true;

    await harness.collector.setState(AnalyticsState.Anonymous);

    expect(await storage.get(INSTALL_ID_KEY)).toBe('');
  });
});
