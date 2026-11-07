import { Period, daysBetween, formatDay, localDateAt, monthsBetween } from './calendar.js';
import { LifecycleEvent, Platform, type EventParams, type UsageEvent } from './envelope.js';
import { systemClock, type Clock } from './clock.js';
import { newInstallState, type EventStamp } from './installState.js';
import type { Lock } from './lock.js';
import { newOutbox } from './outbox.js';
import type { StorageAdapter } from './storage.js';
import type { Transport } from './transport.js';

export interface CollectorOptions {
  /** The live channel key in the build for the store, the test key in any other build. */
  key: string;
  platform: Platform;
  /** Product version, up to 32 characters. */
  version: string;
  /** Interface language, such as `en` or `pt-BR`. */
  lang?: string | undefined;
  storage: StorageAdapter;
  /** How an envelope reaches the intake: `newHttpTransport(endpoint)`, or the product's own. */
  transport: Transport;
  /** The user's id in a `full` channel, once they consented. The collector never makes one up. */
  getId?: (() => string | undefined | Promise<string | undefined>) | undefined;
  /** Minutes without events that end a session, 10 by default. */
  sessionIdleMinutes?: number | undefined;
  /** The longest an event waits in the queue before a send starts, 5 seconds by default. */
  sendDelaySeconds?: number | undefined;
  /** Time and timers, the host's own by default. */
  clock?: Clock | undefined;
  /** The page an event happened on, for a site channel. The collector reads no page itself. */
  getPage?: (() => PageFields | undefined) | undefined;
  /**
   * Runs an operation while no other context that shares `storage` runs one. Without it, two contexts recording at once
   * may both mark the first event of a day, or both send one envelope.
   */
  lock?: Lock | undefined;
  /** Hears every failure the collector swallows, such as a dropped envelope or a storage error. */
  onError?: ((error: Error) => void) | undefined;
}

/** What a site channel's event says about its page. The intake keeps only the path and the referring host. */
export interface PageFields {
  /** The page's path without the query string. */
  page?: string;
  /** The host of the referring page, when it is another site. */
  referrer?: string;
}

/** Bucket for the number of days with at least one event. */
export const ActiveDaysBucket = {
  None: '0',
  One: '1',
  TwoToFive: '2-5',
  SixToTwenty: '6-20',
  TwentyOneOrMore: '21+',
} as const;
export type ActiveDaysBucket = (typeof ActiveDaysBucket)[keyof typeof ActiveDaysBucket];

/** What an uninstall page gets in its query string. */
export interface UninstallParams {
  platform: Platform;
  version: string;
  lang?: string;
  /** Days since install. */
  age: number;
  days: ActiveDaysBucket;
}

/** Every method resolves, never rejects: a failure goes to `onError` and nowhere else. */
export interface Collector {
  track(name: string, params?: EventParams): Promise<void>;
  /** Sends `installed` once per install. Later calls do nothing. */
  installed(): Promise<void>;
  /** Sends `updated` when the version differs from the last one seen. Call it after `installed()`. */
  updated(): Promise<void>;
  /**
   * Off sends `usage_counts_off` at once and then nothing. On sends `usage_counts_on`. The collector stores the choice.
   */
  setEnabled(on: boolean): Promise<void>;
  isEnabled(): Promise<boolean>;
  /** Sends what is queued now. A page calls it when it is hidden, since the user may not come back. */
  flush(): Promise<void>;
  /**
   * Drops this id's queued events and resolves once this collector's request in progress ends. The host calls it after
   * `getId` stops returning the id, then asks the intake to forget the user. The intake keeps a forget for a minute,
   * and drops a request from another context, which arrives within 30 seconds.
   */
  forget(id: string): Promise<void>;
  uninstallParams(): Promise<UninstallParams>;
}

const SESSION_IDLE_MINUTES = 10;
const SEND_DELAY_SECONDS = 5;
/** The length of a page path the intake keeps. */
const MAX_PAGE_LENGTH = 256;
/** The length of a referring host the intake keeps. */
const MAX_REFERRER_LENGTH = 128;
const MAX_AGE_DAYS = 31;
const MAX_AGE_MONTHS = 25;

export function newCollector(options: CollectorOptions): Collector {
  const { storage } = options;
  const clock = options.clock ?? systemClock;
  const reportError = (error: unknown): void => {
    try {
      options.onError?.(toError(error));
    } catch {
      // The host's own handler failing must not reach the host either.
    }
  };
  const lock = exclusive(options.lock);
  /** Names the product build. Every envelope and the uninstall page carry these fields. */
  const product = {
    platform: options.platform,
    version: options.version,
    ...(options.lang !== undefined && { lang: options.lang }),
  };
  const install = newInstallState({
    storage,
    sessionIdleMs: (options.sessionIdleMinutes ?? SESSION_IDLE_MINUTES) * 60_000,
  });
  const outbox = newOutbox({
    storage,
    lock,
    transport: options.transport,
    getId: options.getId,
    sendDelayMs: (options.sendDelaySeconds ?? SEND_DELAY_SECONDS) * 1_000,
    clock,
    reportError,
  });

  // The install day is the local date of the first call of any method, so it waits on no particular event.
  let isInstallDayKnown = false;

  function serialize<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    const withInstallDay = async (): Promise<T> => {
      if (!isInstallDayKnown) {
        await install.installDayOr(localDateAt(clock.now()));
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

  /** Records the event, unless the user switched usage counts off. */
  async function record(name: string, params?: EventParams): Promise<void> {
    if (!(await install.isEnabled())) {
      return;
    }
    const stamp = await install.stamp(clock.now());
    const id = await options.getId?.();
    await outbox.add(
      { key: options.key, ...product, session: stamp.session, ...(id !== undefined && { id }) },
      newEvent({ name, params, stamp, page: options.getPage?.() }),
    );
  }

  async function flush(): Promise<void> {
    // Waiting for the queue of operations first lets an event tracked just before flush join this send.
    await serialize(async () => undefined, undefined);
    await outbox.send();
  }

  return {
    track: (name, params) => serialize(async () => record(name, params), undefined),

    installed: () =>
      serialize(async () => {
        if (await install.takeInstall(options.version)) {
          await record(LifecycleEvent.Installed);
        }
      }, undefined),

    updated: () =>
      serialize(async () => {
        if (await install.takeVersion(options.version)) {
          await record(LifecycleEvent.Updated);
        }
      }, undefined),

    setEnabled: async (on) => {
      const wasChanged = await serialize(async () => {
        if ((await install.isEnabled()) === on) {
          return false;
        }
        // The collector records nothing while it is off. It records the off event before the switch and the on event
        // after it, so both events go out.
        if (on) {
          await install.setEnabled(true);
          await record(LifecycleEvent.UsageCountsOn);
        } else {
          // Events from before the opt-out that have not gone yet never go.
          await outbox.discard();
          await record(LifecycleEvent.UsageCountsOff);
          await install.setEnabled(false);
        }
        return true;
      }, false);
      if (wasChanged && !on) {
        await flush();
      }
    },

    isEnabled: () => serialize(async () => install.isEnabled(), true),

    flush,

    forget: async (id) => {
      await serialize(async () => outbox.forget(id), undefined);
      // A request already on its way may carry the id. It must reach the intake before the host asks the intake to
      // forget the user.
      await outbox.settled();
    },

    uninstallParams: () =>
      serialize(
        async () => {
          const today = localDateAt(clock.now());
          const age = daysBetween(await install.installDayOr(today), today);
          return { ...product, age: Math.max(0, age), days: activeDaysBucket(await install.activeDays()) };
        },
        { ...product, age: 0, days: ActiveDaysBucket.None },
      ),
  };
}

/**
 * Returns the event to queue. It carries install ages only on the first event of a day or a month, and cuts page fields
 * to the lengths the intake keeps.
 */
function newEvent({
  name,
  params,
  stamp: { today, installDay, first },
  page,
}: {
  name: string;
  params: EventParams | undefined;
  stamp: EventStamp;
  page: PageFields | undefined;
}): UsageEvent {
  const event: UsageEvent = { name, day: formatDay(today), ...(first.length > 0 && { first }) };
  if (first.includes(Period.Day)) {
    event.age_days = clamp(daysBetween(installDay, today), MAX_AGE_DAYS);
  }
  if (first.includes(Period.Month)) {
    event.age_months = clamp(monthsBetween(installDay, today), MAX_AGE_MONTHS);
  }
  if (params !== undefined) {
    event.params = params;
  }
  if (page?.page !== undefined) {
    event.page = page.page.slice(0, MAX_PAGE_LENGTH);
  }
  if (page?.referrer !== undefined) {
    event.referrer = page.referrer.slice(0, MAX_REFERRER_LENGTH);
  }
  return event;
}

function activeDaysBucket(days: number): ActiveDaysBucket {
  if (days <= 0) {
    return ActiveDaysBucket.None;
  }
  if (days === 1) {
    return ActiveDaysBucket.One;
  }
  if (days <= 5) {
    return ActiveDaysBucket.TwoToFive;
  }
  return days <= 20 ? ActiveDaysBucket.SixToTwenty : ActiveDaysBucket.TwentyOneOrMore;
}

/** Returns the value held between 0 and `max`. The intake reads the top value of an age as that age or more. */
function clamp(value: number, max: number): number {
  return Math.min(Math.max(0, value), max);
}

/**
 * Returns a lock that runs one operation at a time within this collector, inside the host's lock when there is one.
 * Without it, two operations over an asynchronous storage could interleave reads and writes and lose an event.
 */
function exclusive(hostLock: Lock | undefined): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return (operation) => {
    const run = tail.then(async () => (hostLock === undefined ? operation() : hostLock(operation)));
    tail = run.catch(() => undefined);
    return run;
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
