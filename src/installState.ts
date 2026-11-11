import { Period, formatDay, localDateAt, parseDay, periodKey, type CalendarDate } from './calendar.js';
import { LifecycleEvent, type Envelope, type UsageEvent } from './envelope.js';
import { newRandomId } from './queue.js';
import type { StorageAdapter } from './storage.js';

const SESSION_ID_LENGTH = 12;
/**
 * The most active days the collector stores. It reports the count in buckets, and the last bucket is `21+`, so the
 * collector needs no more days.
 */
const MAX_ACTIVE_DAYS = 21;
/**
 * The last id after the host forgets the user. It is longer than the 64 characters of any id the collector takes, so
 * the next id reads as another user's.
 */
const FORGOTTEN_ID = '<forgotten>'.repeat(6);
/** The install id's form: 16 random bytes as lowercase hex, as the intake expects it. */
const INSTALL_ID_FORMAT = /^[\da-f]{32}$/;
const INSTALL_ID_BYTES = 16;

const StorageKey = {
  InstallDay: 'install_day',
  Installed: 'installed',
  Version: 'version',
  State: 'state',
  /** The random id of the pseudonymous state, `''` once the user left that state. */
  InstallId: 'install_id',
  /** The last id `getId` gave, `''` when none names the user, or `FORGOTTEN_ID` after the host forgot the user. */
  LastId: 'last_id',
  Session: 'session',
  SessionSeen: 'session_seen',
  /** The local days with a queued or sent event, as a JSON list of `YYYY-MM-DD`. */
  ActiveDays: 'active_days',
  firstOf: (period: Period) => `first.${period}`,
} as const;

/** What the collector knows about one event when it records it. */
export interface EventStamp {
  today: CalendarDate;
  installDay: CalendarDate;
  /** The periods this event is the first of. */
  first: Period[];
  session: string;
}

/**
 * The state one install keeps in storage between runs of the host. The caller runs each method under its lock, since
 * each method reads and then writes.
 */
interface InstallState {
  /** Returns the stored analytics state, or undefined when the user never chose one. */
  state(): Promise<string | undefined>;
  setState(state: string): Promise<void>;
  /**
   * Returns the last id `getId` gave while the user was identified, or undefined. After `forgetLastId` it returns a
   * value no id equals.
   */
  lastId(): Promise<string | undefined>;
  /** Stores the id `getId` gave, or `''` once no id names the user. */
  setLastId(id: string): Promise<void>;
  /** Stores a last id that no id equals, so the next id counts as another user. */
  forgetLastId(): Promise<void>;
  /** Returns the install id, and stores a new one when none is stored or the stored one breaks its form. */
  installId(): Promise<string>;
  /** Deletes the install id, so the next one is new. */
  dropInstallId(): Promise<void>;
  /**
   * Gives back the marks these envelopes' events took that no later event took over, so the next such event takes them
   * again: first-of-period marks, the `installed` mark, and the `updated` version while it is still stored. A
   * first-of-day event also removes its day from the active days.
   */
  giveBack(envelopes: readonly Pick<Envelope, 'version' | 'events'>[]): Promise<void>;
  /** Ends the session, so the next event starts a new one. */
  endSession(): Promise<void>;
  /** Marks the install and stores `version`. Resolves to true, or to false when the install was marked before. */
  takeInstall(version: string): Promise<boolean>;
  /** Stores `version` and resolves to true when it differs from the stored one. */
  takeVersion(version: string): Promise<boolean>;
  /** Returns the stored install day, or stores and returns `today` when none is stored. */
  installDayOr(today: CalendarDate): Promise<CalendarDate>;
  /**
   * Takes the first-of-period marks for an event at `timestamp`, counts a new active day and renews the session. A
   * failure gives back the marks it took.
   */
  stamp(timestamp: number): Promise<EventStamp>;
  /** Renews the session for an event at `timestamp` that takes no mark and counts no active day. */
  session(timestamp: number): Promise<string>;
  /** Returns the number of local days with a queued or sent event. */
  activeDays(): Promise<number>;
}

export function newInstallState({
  storage,
  sessionIdleMs,
}: {
  storage: StorageAdapter;
  /** Time without events that ends a session. */
  sessionIdleMs: number;
}): InstallState {
  async function installDayOr(today: CalendarDate): Promise<CalendarDate> {
    const stored = parseDay(await storage.get(StorageKey.InstallDay));
    if (stored) {
      return stored;
    }
    await storage.set(StorageKey.InstallDay, formatDay(today));
    return today;
  }

  /** Takes the first-of-period marks not taken yet for `today` and adds each to `marks` once taken. */
  async function takeFirstMarks(today: CalendarDate, marks: Period[]): Promise<void> {
    for (const period of Object.values(Period)) {
      const key = periodKey(period, today);
      if ((await storage.get(StorageKey.firstOf(period))) !== key) {
        await storage.set(StorageKey.firstOf(period), key);
        marks.push(period);
      }
    }
  }

  /** Returns the stored active days. A stored value that is not a list reads as no days, and only its strings count. */
  async function readActiveDays(): Promise<string[]> {
    let days: unknown;
    try {
      days = JSON.parse((await storage.get(StorageKey.ActiveDays)) ?? '[]');
    } catch {
      return [];
    }
    return Array.isArray(days) ? days.filter((day): day is string => typeof day === 'string') : [];
  }

  async function countActiveDay(day: string): Promise<void> {
    const days = await readActiveDays();
    if (days.length < MAX_ACTIVE_DAYS) {
      await storage.set(StorageKey.ActiveDays, JSON.stringify([...new Set([...days, day])]));
    }
  }

  /** Removes a day from the active days. The cap of 21 stops only the count of new days. */
  async function uncountActiveDay(day: string): Promise<void> {
    const days = await readActiveDays();
    await storage.set(StorageKey.ActiveDays, JSON.stringify(days.filter((candidate) => candidate !== day)));
  }

  async function giveBackMark(period: Period, day: CalendarDate): Promise<void> {
    if ((await storage.get(StorageKey.firstOf(period))) === periodKey(period, day)) {
      await storage.set(StorageKey.firstOf(period), '');
    }
  }

  async function giveBackFirstMarks(day: CalendarDate, first: readonly Period[]): Promise<void> {
    for (const period of first) {
      await giveBackMark(period, day);
    }
    // The event that took the day's first mark was the day's first. Its give-back takes the day out of the count.
    if (first.includes(Period.Day)) {
      await uncountActiveDay(formatDay(day));
    }
  }

  async function giveBackMarksOf(event: UsageEvent, version: string): Promise<void> {
    const day = parseDay(event.day);
    if (day !== undefined) {
      await giveBackFirstMarks(day, event.first ?? []);
    }
    if (event.name === LifecycleEvent.Installed) {
      await storage.set(StorageKey.Installed, '');
    }
    // A later `updated` of another version stored its own version, which stays.
    if (event.name === LifecycleEvent.Updated && (await storage.get(StorageKey.Version)) === version) {
      await storage.set(StorageKey.Version, '');
    }
  }

  /**
   * Returns the session id. A session ends after the idle time without events or at local midnight. The midnight end
   * keeps a user who never pauses from carrying one session for days, which would identify the device.
   */
  async function currentSession(timestamp: number, isNewDay: boolean): Promise<string> {
    const stored = await storage.get(StorageKey.Session);
    const lastSeen = Number(await storage.get(StorageKey.SessionSeen));
    const isIdle = !(timestamp - lastSeen < sessionIdleMs);
    const session = stored === undefined || stored === '' || isIdle || isNewDay ? newSessionId() : stored;
    await storage.set(StorageKey.Session, session);
    await storage.set(StorageKey.SessionSeen, String(timestamp));
    return session;
  }

  return {
    state: () => storage.get(StorageKey.State),

    lastId: async () => {
      const id = await storage.get(StorageKey.LastId);
      return id === '' ? undefined : id;
    },

    setLastId: (id) => storage.set(StorageKey.LastId, id),

    forgetLastId: () => storage.set(StorageKey.LastId, FORGOTTEN_ID),

    installId: async () => {
      const stored = await storage.get(StorageKey.InstallId);
      if (stored !== undefined && INSTALL_ID_FORMAT.test(stored)) {
        return stored;
      }
      const id = newRandomId(INSTALL_ID_BYTES);
      await storage.set(StorageKey.InstallId, id);
      return id;
    },

    dropInstallId: () => storage.set(StorageKey.InstallId, ''),

    giveBack: async (envelopes) => {
      for (const { version, events } of envelopes) {
        for (const event of events) {
          await giveBackMarksOf(event, version);
        }
      }
    },

    setState: (state) => storage.set(StorageKey.State, state),

    // An empty session reads as none, so the next event takes a new one. The storage has no remove.
    endSession: () => storage.set(StorageKey.Session, ''),

    takeInstall: async (version) => {
      const mark = await storage.get(StorageKey.Installed);
      if (mark !== undefined && mark !== '') {
        return false;
      }
      // The version goes first, so a failed write leaves the install mark untaken.
      await storage.set(StorageKey.Version, version);
      await storage.set(StorageKey.Installed, '1');
      return true;
    },

    takeVersion: async (version) => {
      if ((await storage.get(StorageKey.Version)) === version) {
        return false;
      }
      await storage.set(StorageKey.Version, version);
      return true;
    },

    installDayOr,

    stamp: async (timestamp) => {
      const today = localDateAt(timestamp);
      const installDay = await installDayOr(today);
      const first: Period[] = [];
      try {
        await takeFirstMarks(today, first);
        const isNewDay = first.includes(Period.Day);
        if (isNewDay) {
          await countActiveDay(formatDay(today));
        }
        return { today, installDay, first, session: await currentSession(timestamp, isNewDay) };
      } catch (error) {
        await giveBackFirstMarks(today, first);
        throw error;
      }
    },

    // The only caller ends the session first, so the session it renews is always a new one.
    session: (timestamp) => currentSession(timestamp, false),

    activeDays: async () => (await readActiveDays()).length,
  };
}

function newSessionId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_ID_LENGTH));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}
