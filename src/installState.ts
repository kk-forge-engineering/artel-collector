import { Period, formatDay, localDateAt, parseDay, periodKey, type CalendarDate } from './calendar.js';
import type { StorageAdapter } from './storage.js';

const SESSION_ID_LENGTH = 12;

const StorageKey = {
  InstallDay: 'artel.install_day',
  Installed: 'artel.installed',
  Version: 'artel.version',
  Enabled: 'artel.enabled',
  Session: 'artel.session',
  SessionSeen: 'artel.session_seen',
  ActiveDays: 'artel.active_days',
  firstOf: (period: Period) => `artel.first.${period}`,
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
export interface InstallState {
  isEnabled(): Promise<boolean>;
  setEnabled(on: boolean): Promise<void>;
  /** Marks the install and stores `version`. Resolves to true, or to false when the install was marked before. */
  takeInstall(version: string): Promise<boolean>;
  /** Stores `version` and resolves to true when it differs from the stored one. */
  takeVersion(version: string): Promise<boolean>;
  /** Returns the stored install day, or stores and returns `today` when none is stored. */
  installDayOr(today: CalendarDate): Promise<CalendarDate>;
  /** Takes the first-of-period marks for an event at `timestamp`, counts a new active day and renews the session. */
  stamp(timestamp: number): Promise<EventStamp>;
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

  async function takeFirstMarks(today: CalendarDate): Promise<Period[]> {
    const marks: Period[] = [];
    for (const period of Object.values(Period)) {
      const key = periodKey(period, today);
      if ((await storage.get(StorageKey.firstOf(period))) !== key) {
        marks.push(period);
        await storage.set(StorageKey.firstOf(period), key);
      }
    }
    return marks;
  }

  async function activeDays(): Promise<number> {
    return Number(await storage.get(StorageKey.ActiveDays)) || 0;
  }

  /**
   * Returns the session id. A session ends after the idle time without events or at local midnight. The midnight end
   * keeps a user who never pauses from carrying one session for days, which would identify the device.
   */
  async function currentSession(timestamp: number, isNewDay: boolean): Promise<string> {
    const stored = await storage.get(StorageKey.Session);
    const lastSeen = Number(await storage.get(StorageKey.SessionSeen));
    const isIdle = !(timestamp - lastSeen < sessionIdleMs);
    const session = stored === undefined || isIdle || isNewDay ? newSessionId() : stored;
    await storage.set(StorageKey.Session, session);
    await storage.set(StorageKey.SessionSeen, String(timestamp));
    return session;
  }

  return {
    isEnabled: async () => (await storage.get(StorageKey.Enabled)) !== '0',

    setEnabled: (on) => storage.set(StorageKey.Enabled, on ? '1' : '0'),

    takeInstall: async (version) => {
      if ((await storage.get(StorageKey.Installed)) !== undefined) {
        return false;
      }
      await storage.set(StorageKey.Installed, '1');
      await storage.set(StorageKey.Version, version);
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
      const first = await takeFirstMarks(today);
      const isNewDay = first.includes(Period.Day);
      if (isNewDay) {
        await storage.set(StorageKey.ActiveDays, String((await activeDays()) + 1));
      }
      return { today, installDay, first, session: await currentSession(timestamp, isNewDay) };
    },

    activeDays,
  };
}

function newSessionId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_ID_LENGTH));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}
