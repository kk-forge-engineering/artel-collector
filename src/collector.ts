import { daysBetween, formatDay, localDateAt } from './calendar.js';
import { LifecycleEvent, UNINSTALLED, type EventParams, type UsageEvent } from './envelope.js';
import { activeDaysBucket, ageInDays, isLanguage, languageTag, newEvent, uninstalledParams } from './fields.js';
import {
  accepted,
  checkedBuild,
  isUsableId,
  newBrowserReader,
  newStringStorage,
  quoted,
  reportTo,
  usableId,
} from './hostInput.js';
import { systemClock } from './clock.js';
import { newChannelStorage } from './storage.js';
import { AnalyticsState, Mode, type Collector, type CollectorOptions } from './collectorTypes.js';
import { acceptedEvent } from './eventCheck.js';
import { newInstallState } from './installState.js';
import { exclusive } from './lock.js';
import { newOutbox } from './outbox.js';
import { newPageReader, type PageRead, type PageReader } from './page.js';
import type { Identity, QueuedEnvelope } from './queue.js';
import { carriesPage, channelTakes, fieldsForState, isAnalyticsState, type StateFields } from './stateFields.js';
import { newHttpTransport, type Transport } from './transport.js';

const SESSION_IDLE_MINUTES = 10;
const SEND_DELAY_SECONDS = 5;

/**
 * Returns a collector. Throws a `TypeError` that names the option for options that would make the intake refuse every
 * envelope, such as a bad key, version or endpoint, and for options only a host outside TypeScript passes. A language
 * that breaks the intake's format is left out and goes to `onError`, since it often comes from the browser.
 */
export function newCollector<M extends Mode>(options: CollectorOptions & { mode: M }): Collector<M>;
export function newCollector(options: CollectorOptions): Collector {
  const product = checkedBuild(options);
  const { mode } = options;
  const transports = transportsOf(options);
  const storage = newChannelStorage(newStringStorage(options.storage), options.key);
  const clock = options.clock ?? systemClock;
  const reportError = (error: unknown): void => reportTo(options.onError, error);
  const lock = exclusive(options.lock);
  const getId = options.mode === Mode.Identified ? usableId(options.getId, reportError) : undefined;
  const readBrowser = options.mode === Mode.Anonymous ? undefined : newBrowserReader(options.browser, reportError);
  const browserLanguage = accepted('browserLanguage', languageTag(options.browserLanguage), isLanguage, reportError);
  const uiLanguage = accepted('uiLanguage', languageTag(options.uiLanguage), isLanguage, reportError);
  const install = newInstallState({
    storage,
    sessionIdleMs: durationOr(options.sessionIdleMinutes, SESSION_IDLE_MINUTES) * 60_000,
  });
  const outbox = newOutbox({
    key: options.key,
    storage,
    lock,
    ...transports,
    // The current state decides the id, so an envelope names no user once the state has left the one it was recorded
    // in. The state can change in this or another context after the lease.
    identify: () => lock(async () => identityIn(await currentFields())),
    giveBack: (items) => giveBack(items),
    sendDelayMs: durationOr(options.sendDelaySeconds, SEND_DELAY_SECONDS) * 1_000,
    clock,
    reportError,
  });

  // The collector takes the page when a method is called, so a navigation before the event is recorded does not move
  // it. Only platform web asks `getPage`.
  const pages: PageReader | undefined = carriesPage(product)
    ? newPageReader({ getPage: options.getPage, reportError })
    : undefined;
  const pageOf = (name: string): PageRead | undefined => pages?.read(name);

  // The install day is the local date of the first call of any method, so it waits on no particular event.
  let isInstallDayKnown = false;

  function serialize<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    const withInstallDay = async (): Promise<T> => {
      if (!isInstallDayKnown) {
        await install.installDayOr(localDateAt(clock.now()));
        await settleStoredState();
        isInstallDayKnown = true;
        // The first send carries what an earlier run of the host left queued. A run stopped mid-send holds a lease, and
        // its events go with the first send after the lease runs out.
        outbox.sendSoon();
      }
      return operation();
    };
    // Each operation reads and writes several storage keys. The lock keeps two events from both taking the same
    // first-of-day mark.
    return lock(withInstallDay).catch((error: unknown) => {
      reportError(error);
      return fallback;
    });
  }

  /** Gives back the marks of the dropped envelopes. */
  async function giveBack(items: readonly QueuedEnvelope[]): Promise<void> {
    await install.giveBack(items.map((item) => item.envelope));
  }

  /**
   * Stores the id an envelope names the user by. An id other than the last one means another user: the events of the
   * last one, and those that waited for an id after it, are dropped, so none goes under another user's id. The session
   * ends, so no session holds the events of two users.
   */
  async function noteId(id: string): Promise<void> {
    const last = await install.lastId();
    if (last === id) {
      return;
    }
    if (last !== undefined) {
      await giveBack(await outbox.discardIdentified());
      await install.endSession();
    }
    await install.setLastId(id);
  }

  /**
   * Resolves to the id the state of `fields` names the user by, with its kind and the browser, or to undefined while
   * there is none. The pseudonymous state's id is the install id, which the collector makes once. A new id counts as
   * another user, as `noteId` describes.
   */
  async function identityIn({ idKind }: StateFields): Promise<Identity | undefined> {
    if (idKind === undefined) {
      return undefined;
    }
    const id = idKind === AnalyticsState.Pseudonymous ? await install.installId() : await getId?.();
    if (id === undefined) {
      return undefined;
    }
    await noteId(id);
    const browser = readBrowser?.();
    return { id, id_kind: idKind, ...(browser !== undefined && { browser }) };
  }

  /**
   * Forgets the last id, as `forget` does, and drops the queued events that name the user or wait for an id. Deletes
   * the install id, so a later pseudonymous state takes a new one.
   */
  async function leaveIdentity(): Promise<void> {
    const last = await install.lastId();
    if (isUsableId(last)) {
      await giveBack(await outbox.forget(last));
    }
    await giveBack(await outbox.discardIdentified());
    // The install id goes before the last id. A run that stops between them then keeps the last id, and the next run
    // leaves it again.
    await install.dropInstallId();
    await install.setLastId('');
  }

  /**
   * Stores `next` and leaves the id of `previous`, and resolves to whether `previous` had one. A change between the two
   * states with an id leaves first. A run that stops in between keeps the old state with its id forgotten, so no event
   * goes under the other state's id. Any other change stores first, so an opt-out stays, and the next run leaves the id
   * the stored state no longer has.
   */
  async function storeState(previous: AnalyticsState, next: AnalyticsState): Promise<boolean> {
    const hadId = fieldsIn(previous).idKind !== undefined;
    const isSwitch = hadId && fieldsIn(next).idKind !== undefined;
    if (isSwitch) {
      await leaveIdentity();
    }
    await install.setState(next);
    if (hadId && !isSwitch) {
      await leaveIdentity();
    }
    return hadId;
  }

  /**
   * Finishes a change of state that a stopped run or a change of the channel's mode left. Stores a state this channel
   * no longer takes as anonymous. Leaves the last id in a state without one, and drops the queue in the opted_out
   * state.
   */
  async function settleStoredState(): Promise<void> {
    const stored = await install.state();
    const isUntaken = isAnalyticsState(stored) && !takes(stored);
    if (isUntaken) {
      await install.setState(AnalyticsState.Anonymous);
      await install.endSession();
    }
    const state = await currentState();
    if (isUntaken || (fieldsIn(state).idKind === undefined && isUsableId(await install.lastId()))) {
      await leaveIdentity();
    }
    if (state === AnalyticsState.OptedOut) {
      await giveBack(await outbox.discard());
    }
  }

  async function currentState(): Promise<AnalyticsState> {
    const stored = await install.state();
    // The function reads a state this channel does not take as anonymous. Such a state stays after the product changes
    // its mode.
    return takes(stored) ? stored : AnalyticsState.Anonymous;
  }

  function takes(state: unknown): state is AnalyticsState {
    return channelTakes(mode, state);
  }

  /** Resolves to what the current state, or `state`, sends. */
  async function currentFields(state?: AnalyticsState): Promise<StateFields> {
    return fieldsIn(state ?? (await currentState()));
  }

  function fieldsIn(state: AnalyticsState): StateFields {
    return fieldsForState({ state, build: product, browserLanguage, uiLanguage });
  }

  /**
   * Queues the event for the current state, and resolves to whether it did. Does nothing in the opted_out state, or
   * when `takeMark` finds its install or version mark taken.
   */
  async function record({
    name,
    params,
    page,
    takeMark,
  }: {
    name: string;
    params?: EventParams | undefined;
    page: PageRead | undefined;
    takeMark?: (version: string) => Promise<boolean>;
  }): Promise<boolean> {
    const fields = await currentFields();
    if (!fields.recordsEvents) {
      return false;
    }
    const view = page === undefined ? undefined : pages?.view(page);
    // A second `page_view` of the same page in a row, as from two trackers or a change of the query, sends nothing.
    if (view?.isRepeatedView === true) {
      return false;
    }
    // A state with an id names the user once the id is known. Another user's id gives back the marks of the last user's
    // dropped events, the install and version marks included, before this event takes its own.
    const identity = await identityIn(fields);
    const productVersion = fields.product.version;
    // A `takeMark` that fails took no mark, so nothing goes back.
    if (takeMark !== undefined && !(await takeMark(productVersion))) {
      return false;
    }
    let event: UsageEvent | undefined;
    let dropped: QueuedEnvelope[];
    try {
      const stamp = await install.stamp(clock.now());
      event = newEvent({
        name,
        // The `uninstalled` age gets the precision of the envelope's ages, so a state that sends no exact age does not
        // send one here.
        params: name === UNINSTALLED ? uninstalledParams(params, { isExact: fields.isAgeExact }) : params,
        stamp,
        page: fields.mayCarryPage ? view?.fields : undefined,
        isAgeExact: fields.isAgeExact,
      });
      const { browser, ...id } = identity ?? {};
      dropped = await outbox.add(
        {
          key: options.key,
          ...fields.product,
          ...(browser !== undefined && { browser }),
          session: stamp.session,
          ...id,
        },
        event,
        { awaitsId: fields.idKind !== undefined && identity === undefined },
      );
    } catch (error) {
      // A failure before the queue holds the event loses it. Its marks go back, so the next event takes them and the
      // day still counts. A failed stamp gave back its own first-of-period marks.
      await install.giveBack([
        { version: productVersion, events: [event ?? { name, day: formatDay(localDateAt(clock.now())) }] },
      ]);
      throw error;
    }
    view?.recorded();
    // The queue holds the event by now, so a failure here keeps its marks.
    await giveBack(dropped);
    return true;
  }

  /**
   * Queues one `opted_out` with no id, no browser, no first-of-period mark and no age, so that no count of active users
   * takes it.
   */
  async function recordOptOut(): Promise<void> {
    await install.endSession();
    const fields = await currentFields(AnalyticsState.OptedOut);
    const session = await install.session(clock.now());
    const dropped = await outbox.add(
      { key: options.key, ...fields.product, session },
      { name: LifecycleEvent.OptedOut, day: formatDay(localDateAt(clock.now())) },
    );
    await giveBack(dropped);
  }

  async function flush(): Promise<void> {
    // Waiting for the queue of operations first lets an event tracked just before flush join this send.
    await serialize(async () => undefined, undefined);
    await outbox.send();
  }

  const collector: Collector = {
    track: async (name, given) => {
      const event = acceptedEvent(name, given, reportError);
      if (event === undefined) {
        return;
      }
      const page = pageOf(name);
      await serialize(async () => record({ name, params: event.params, page }), false);
    },

    // The opted_out state takes no install mark. A user who turns analytics back on still sends `installed`.
    installed: async () => {
      const page = pageOf(LifecycleEvent.Installed);
      const takeMark = (productVersion: string): Promise<boolean> => install.takeInstall(productVersion);
      await serialize(async () => record({ name: LifecycleEvent.Installed, page, takeMark }), false);
    },

    updated: async () => {
      const page = pageOf(LifecycleEvent.Updated);
      const takeMark = (productVersion: string): Promise<boolean> => install.takeVersion(productVersion);
      await serialize(async () => record({ name: LifecycleEvent.Updated, page, takeMark }), false);
    },

    setState: async (next) => {
      const hasRequest = await serialize(async () => {
        if (!takes(next)) {
          reportError(new TypeError(`artel: a channel of mode ${quoted(mode)} takes no state ${quoted(next)}`));
          return false;
        }
        const previous = await currentState();
        if (previous === next) {
          return false;
        }
        const hadId = await storeState(previous, next);
        if (next === AnalyticsState.OptedOut) {
          // Events from before the opt-out that have not gone yet never go.
          await giveBack(await outbox.discard());
          await recordOptOut();
        }
        // A new session keeps the intake from tying together events from before and after the change.
        await install.endSession();
        return hadId || next === AnalyticsState.OptedOut;
      }, false);
      // The forget request and the opted_out go at once.
      if (hasRequest) {
        await flush();
      }
    },

    getState: () => serialize(currentState, AnalyticsState.Anonymous),

    flush,

    forget: async (id) => {
      // The intake refuses a forget of any other value, which no envelope carries as its id.
      if (!isUsableId(id)) {
        reportError(new TypeError('artel: forget takes an id of 1 to 64 characters'));
        return;
      }
      await serialize(async () => {
        // The intake deletes the id's events, so each envelope of the id gives back its marks, sent or not.
        await giveBack(await outbox.forget(id));
        // The events that wait for an id after the last user are that user's, so they go with it. The next id counts
        // as another user, so the events that wait after the forget never go under it.
        if ((await install.lastId()) === id) {
          await giveBack(await outbox.discardIdentified());
          await install.forgetLastId();
        }
      }, undefined);
      await outbox.send();
    },

    uninstallParams: () =>
      serialize(async () => {
        const fields = await currentFields();
        if (!fields.recordsEvents) {
          return undefined;
        }
        const today = localDateAt(clock.now());
        const age = Math.max(0, daysBetween(await install.installDayOr(today), today));
        return {
          ...fields.product,
          age_days: ageInDays(age, { isExact: fields.isAgeExact }),
          active_days: activeDaysBucket(await install.activeDays()),
        };
      }, undefined),
  };
  return collector;
}

/**
 * Returns the transport of the envelopes and that of the forget requests. The intake's forget address replaces the last
 * segment of the relay path, `/v1/public/relay`. A product's own transport takes both kinds of request.
 */
function transportsOf(options: CollectorOptions): { transport: Transport; forgetTransport: Transport } {
  if (options.transport !== undefined) {
    return { transport: options.transport, forgetTransport: options.transport };
  }
  return {
    transport: newHttpTransport(options.endpoint),
    forgetTransport: newHttpTransport(new URL('forget', options.endpoint).href),
  };
}

/** Returns `value`, or `fallback` for a duration that is no finite number from 0. */
function durationOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
