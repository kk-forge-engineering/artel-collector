import { systemClock, type Clock } from './clock.js';
import type { Collector } from './collector.js';
import { LifecycleEvent, type EventParams } from './envelope.js';
import type { StorageAdapter } from './storage.js';

const FORWARD_TYPE = 'artel.track';
// The intake refuses an event past these limits. The worker refuses such a forwarded event, so the queue never holds an
// event the intake rejects.
const MAX_NAME_LENGTH = 40;
const MAX_PARAMS = 16;
const MAX_PARAM_STRING_LENGTH = 64;
/**
 * The forwarded events the worker tracks in a minute from every tab and frame together. A page can open any number of
 * frames that run the content script, so only a budget in the worker bounds how fast a page can fill the queue and push
 * out what waits in it.
 */
const FORWARDS_PER_MINUTE = 60;
/** The bytes of forwarded names and params the worker tracks in a minute, about one envelope. */
const FORWARD_BYTES_PER_MINUTE = 60_000;
const MINUTE_MS = 60_000;
/**
 * The `chrome.storage.session` key the worker keeps the budget under, so the budget outlasts a restart of the service
 * worker, which a page can bring about by going quiet.
 */
const BUDGET_KEY = 'artel.forwardBudget';

/** The minute the budget counts from, and what the worker tracked in it. */
interface ForwardBudget {
  minuteStart: number;
  tracked: number;
  bytes: number;
}

/**
 * Returns a storage adapter over `chrome.storage.local`, which the service worker and the extension pages share. It
 * needs the `storage` permission.
 */
export function newChromeStorageAdapter(): StorageAdapter {
  return {
    get: async (key) => {
      const value = (await chromeApi().storage.local.get(key))[key];
      return typeof value === 'string' ? value : undefined;
    },
    set: async (key, value) => {
      await chromeApi().storage.local.set({ [key]: value });
    },
  };
}

/**
 * Hands an event from a content script to the service worker, whose collector tracks it. The intake refuses a content
 * script's own requests, which carry the page's origin.
 */
export async function forwardTrack(name: string, params?: EventParams): Promise<void> {
  try {
    await chromeApi().runtime.sendMessage({ type: FORWARD_TYPE, name, ...(params !== undefined && { params }) });
  } catch {
    // The send fails while the service worker updates or is gone. The content script drops the event and does not fail.
  }
}

/**
 * Tracks the events content scripts forward with `forwardTrack`, at most 60 or 60 kB a minute. It takes them only from
 * this extension, and never the collector's own lifecycle events, which a content script has no reason to send. Returns
 * the function that stops it.
 */
export function acceptForwarded(collector: Collector, { clock = systemClock }: { clock?: Clock } = {}): () => void {
  let budget: ForwardBudget | undefined;
  /** The chain the messages take their turn on, one by one, so each reads the budget the one before it left. */
  let turn: Promise<void> = Promise.resolve();
  /**
   * The number of messages waiting their turn. Two minutes' budget is the most the waiting ones could use: what is left
   * of the minute they arrived in, and the next minute once it starts.
   */
  let waiting = 0;

  async function spend(now: number, bytes: number): Promise<boolean> {
    budget ??= await readBudget();
    if (!isWithinMinute(budget, now)) {
      budget = { minuteStart: now, tracked: 0, bytes: 0 };
    }
    if (budget.tracked >= FORWARDS_PER_MINUTE || budget.bytes + bytes > FORWARD_BYTES_PER_MINUTE) {
      return false;
    }
    budget = { minuteStart: budget.minuteStart, tracked: budget.tracked + 1, bytes: budget.bytes + bytes };
    await writeBudget(budget);
    return true;
  }

  const onMessage: MessageListener = (message, sender) => {
    if (sender.id !== chromeApi().runtime.id || !isForwarded(message)) {
      return undefined;
    }
    const now = clock.now();
    // A message that finds this minute's count spent, or the queue full, is dropped at once rather than queued.
    if ((budget !== undefined && isSpent(budget, now)) || waiting >= 2 * FORWARDS_PER_MINUTE) {
      return undefined;
    }
    waiting++;
    // The turn keeps only the checked fields, not whatever else the message carries.
    const { name, params } = message;
    const bytes = new TextEncoder().encode(JSON.stringify({ name, params })).length;
    turn = turn
      .then(() => spend(now, bytes))
      .then((isWithinBudget) => (isWithinBudget ? collector.track(name, params) : undefined))
      .finally(() => {
        waiting--;
      });
    return undefined;
  };
  chromeApi().runtime.onMessage.addListener(onMessage);
  return () => chromeApi().runtime.onMessage.removeListener(onMessage);
}

/**
 * Sets the uninstall page with `uninstallParams()` in its query. Chrome keeps the address as it was set, so the service
 * worker calls this on each start to keep the age and the active days current.
 */
export async function refreshUninstallUrl(collector: Collector, pageUrl: string): Promise<void> {
  const url = new URL(pageUrl);
  for (const [name, value] of Object.entries(await collector.uninstallParams())) {
    url.searchParams.set(name, String(value));
  }
  await chromeApi().runtime.setUninstallURL(url.toString());
}

/** A wall clock set back starts a new minute too, or the budget would stay spent until the clock caught up. */
function isWithinMinute(budget: ForwardBudget, now: number): boolean {
  return now >= budget.minuteStart && now - budget.minuteStart < MINUTE_MS;
}

function isSpent(budget: ForwardBudget, now: number): boolean {
  return isWithinMinute(budget, now) && budget.tracked >= FORWARDS_PER_MINUTE;
}

/** Reads the budget a worker before this one left. Without `chrome.storage.session` the budget starts empty. */
async function readBudget(): Promise<ForwardBudget> {
  try {
    const stored: unknown = (await chromeApi().storage.session.get(BUDGET_KEY))[BUDGET_KEY];
    if (isForwardBudget(stored)) {
      return stored;
    }
  } catch {
    // The budget then lives only as long as this worker.
  }
  return { minuteStart: 0, tracked: 0, bytes: 0 };
}

async function writeBudget(budget: ForwardBudget): Promise<void> {
  try {
    await chromeApi().storage.session.set({ [BUDGET_KEY]: budget });
  } catch {
    // The budget then lives only as long as this worker.
  }
}

/** Checks a stored budget, including that its counts stay within the limits, so a tampered one cannot widen them. */
function isForwardBudget(value: unknown): value is ForwardBudget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const [minuteStart, tracked, bytes]: unknown[] = ['minuteStart', 'tracked', 'bytes'].map((key) =>
    Reflect.get(value, key),
  );
  return (
    Number.isFinite(minuteStart) &&
    typeof tracked === 'number' &&
    Number.isInteger(tracked) &&
    tracked >= 0 &&
    tracked <= FORWARDS_PER_MINUTE &&
    typeof bytes === 'number' &&
    Number.isInteger(bytes) &&
    bytes >= 0 &&
    bytes <= FORWARD_BYTES_PER_MINUTE
  );
}

type MessageListener = (message: unknown, sender: { id?: string }) => undefined;

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The slice of the `chrome` API these helpers call. The package carries no Chrome typings. */
interface ChromeApi {
  storage: {
    local: StorageArea;
    session: StorageArea;
  };
  runtime: {
    id: string;
    sendMessage(message: unknown): Promise<unknown>;
    setUninstallURL(url: string): Promise<void>;
    onMessage: {
      addListener(listener: MessageListener): void;
      removeListener(listener: MessageListener): void;
    };
  };
}

/** Returns the global `chrome` API, or throws outside an extension context. */
function chromeApi(): ChromeApi {
  const chrome: unknown = Reflect.get(globalThis, 'chrome');
  if (!isChromeApi(chrome)) {
    throw new Error('artel: the chrome extension API is not available here');
  }
  return chrome;
}

/** Checks only that the extension runtime is there. A missing `storage` permission surfaces when storage is used. */
function isChromeApi(value: unknown): value is ChromeApi {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'runtime') === 'object';
}

/**
 * Checks the shape of a forwarded message and its sizes against the intake's limits, and refuses lifecycle event names.
 * Content scripts run among the page's scripts, so the worker cannot trust what they send.
 */
function isForwarded(message: unknown): message is { name: string; params?: EventParams } {
  if (typeof message !== 'object' || message === null || Reflect.get(message, 'type') !== FORWARD_TYPE) {
    return false;
  }
  const name: unknown = Reflect.get(message, 'name');
  const params: unknown = Reflect.get(message, 'params');
  const lifecycleEvents: readonly unknown[] = Object.values(LifecycleEvent);
  return (
    typeof name === 'string' &&
    characters(name) <= MAX_NAME_LENGTH &&
    !lifecycleEvents.includes(name) &&
    (params === undefined || isEventParams(params))
  );
}

function isEventParams(value: unknown): value is EventParams {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length <= MAX_PARAMS &&
    Object.keys(value).every((key) => characters(key) <= MAX_NAME_LENGTH) &&
    Object.values(value).every(
      (item) =>
        (typeof item === 'string' && characters(item) <= MAX_PARAM_STRING_LENGTH) ||
        typeof item === 'number' ||
        typeof item === 'boolean',
    )
  );
}

/** Counts characters as the intake does, so a character outside the basic plane counts once. */
function characters(text: string): number {
  return Array.from(text).length;
}
