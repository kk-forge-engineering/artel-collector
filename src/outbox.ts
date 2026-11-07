import type { Clock, TimerHandle } from './clock.js';
import { daysBetween, parseDay, utcDateAt, type CalendarDate } from './calendar.js';
import type { Envelope, UsageEvent } from './envelope.js';
import type { Lock } from './lock.js';
import { newQueue, newRandomId, type LeaseTerms, type QueuedEnvelope } from './queue.js';
import type { StorageAdapter } from './storage.js';
import type { Transport } from './transport.js';

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/**
 * The time one send holds the lease on a queued envelope, twice the 30 s request limit of `newHttpTransport` in
 * `src/transport.ts`. The send renews the lease before each request. A host that stops mid-send blocks the envelope
 * only until its lease ends.
 */
const LEASE_MS = 60_000;

/**
 * Holds the envelopes on their way to the intake. They leave one at a time, in the order they were made. An envelope
 * the intake cannot take now goes again later, and each wait doubles, up to five minutes.
 */
export interface Outbox {
  /**
   * Queues the event and sends it within the send delay, at once when its envelope is full, or with the pending retry.
   */
  add(fields: Omit<Envelope, 'events'>, event: UsageEvent): Promise<void>;
  /** Sends what is queued within the send delay, such as what an earlier run of the host left. */
  sendSoon(): void;
  /** Sends what is queued now, in turn after any send in progress. */
  send(): Promise<void>;
  /** Drops every envelope not sent yet and cancels the next retry. */
  discard(): Promise<void>;
  /** Drops the envelopes of this id. */
  forget(id: string): Promise<void>;
  /** Resolves once the send in progress, if any, has ended. */
  settled(): Promise<void>;
}

/**
 * Expects the caller to run `add`, `discard` and `forget` inside its own `lock`, which it holds for the whole recording
 * of an event. The sends take the lock themselves.
 */
export function newOutbox({
  storage,
  lock,
  transport,
  getId,
  sendDelayMs,
  clock,
  reportError,
}: {
  storage: StorageAdapter;
  lock: Lock;
  transport: Transport;
  /** The longest an event waits in the queue before a send starts. */
  sendDelayMs: number;
  getId: (() => string | undefined | Promise<string | undefined>) | undefined;
  clock: Clock;
  reportError: (error: unknown) => void;
}): Outbox {
  const queue = newQueue({ storage, reportError });
  /** Names this outbox's leases, apart from those of other contexts that share the storage. */
  const holder = newRandomId();
  let sendTimer: TimerHandle | undefined;
  let sendDue = Number.POSITIVE_INFINITY;
  let retryTimer: TimerHandle | undefined;
  let retryDelay = RETRY_DELAY_MS;
  /** Chains the sends, so that one runs at a time and queued envelopes leave in the order they were made. */
  let sending: Promise<void> = Promise.resolve();

  function reportDropped(count: number): void {
    if (count > 0) {
      reportError(new Error(`artel: ${count} queued events dropped as too old or under a withdrawn id`));
    }
  }

  function leaseTerms(): LeaseTerms {
    return { holder, now: clock.now(), until: clock.now() + LEASE_MS };
  }

  function cancelSend(): void {
    clock.clearTimeout(sendTimer);
    sendDue = Number.POSITIVE_INFINITY;
  }

  function cancelRetry(): void {
    clock.clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  /** Starts a send within `delayMs`, unless a send is due sooner or a retry is pending. */
  function sendWithin(delayMs: number): void {
    // The pending retry carries the new events too. An earlier send would reach an intake that asked the outbox to
    // wait.
    if (retryTimer !== undefined || sendDue <= clock.now() + delayMs) {
      return;
    }
    clock.clearTimeout(sendTimer);
    sendDue = clock.now() + delayMs;
    sendTimer = clock.setTimeout(() => void send(), delayMs);
  }

  function send(): Promise<void> {
    cancelSend();
    cancelRetry();
    sending = sending.then(sendLeased).catch(reportError);
    return sending;
  }

  /** Leases what is queued and sends it. An envelope not settled when the send stops goes back to the queue. */
  async function sendLeased(): Promise<void> {
    const leased = await lock(async () => queue.lease(leaseTerms()));
    const unsettled = new Set(leased.map((item) => item.qid));
    try {
      await sendInOrder(leased, unsettled);
    } finally {
      if (unsettled.size > 0) {
        await lock(async () => queue.release(holder, [...unsettled]));
      }
    }
  }

  /**
   * Sends the envelopes in order. The function seals and reads each one just before its request, so the request carries
   * every event added since the lease. From the first envelope the intake cannot take now, the rest wait for a retry.
   */
  async function sendInOrder(leased: QueuedEnvelope[], unsettled: Set<string>): Promise<void> {
    const mayGo = sendableCheck({ id: await getId?.(), today: utcDateAt(clock.now()) });
    for (const item of leased) {
      const sealed = await lock(async () => queue.seal(item.qid, leaseTerms()));
      if (sealed === undefined) {
        unsettled.delete(item.qid);
        continue;
      }
      // An envelope goes whole or not at all. The intake drops a repeat only when it matches the first body byte for
      // byte, and a repeat with fewer events would not match.
      const { envelope, body } = sealed;
      const isFresh = envelope.events.every((event) => mayGo(envelope, event));
      if (!isFresh) {
        reportDropped(envelope.events.length);
      }
      if (isFresh && !(await deliver({ body, transport, reportError }))) {
        // An event that came during the request armed a send. The retry carries that event, so the intake gets its
        // wait.
        cancelSend();
        cancelRetry();
        retryTimer = clock.setTimeout(() => void send(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        return;
      }
      await lock(async () => queue.remove(item.qid));
      unsettled.delete(item.qid);
    }
    retryDelay = RETRY_DELAY_MS;
    // A failed send may have armed a retry while this send waited its turn. An event that came meanwhile armed no send
    // of its own, so it gets one now.
    if (retryTimer !== undefined) {
      cancelRetry();
      sendWithin(sendDelayMs);
    }
  }

  return {
    add: async (fields, event) => {
      const isFull = await queue.add(fields, event);
      // A full envelope goes at once. Otherwise the send waits, so that the events of the next few seconds share one
      // request.
      sendWithin(isFull ? 0 : sendDelayMs);
    },
    sendSoon: () => sendWithin(sendDelayMs),
    send,
    discard: async () => {
      cancelRetry();
      // A send in progress holds leases on what it took. Dropping those envelopes here keeps that send from sending
      // them again.
      await queue.clear();
    },
    forget: (id) => queue.removeId(id),
    settled: () => sending,
  };
}

/**
 * Sends one envelope, and resolves to false when it must go again later: on 429, a rate limit, on 5xx, a store that
 * missed the write, or on status 0, which a browser also gives for a refusal without CORS headers. Any other 4xx means
 * a wrong envelope or channel, so a retry would fail the same way.
 */
async function deliver({
  body,
  transport,
  reportError,
}: {
  body: string;
  transport: Transport;
  reportError: (error: unknown) => void;
}): Promise<boolean> {
  let status: number;
  try {
    status = await transport(body);
  } catch {
    status = 0;
  }
  if (status === 0 || status === 429 || status >= 500) {
    return false;
  }
  if (status < 200 || status >= 300) {
    reportError(new Error(`artel: intake answered ${status}`));
  }
  return true;
}

/**
 * Returns the check whether an event may still go: its envelope carries no id or the current `id`, and its day is UTC
 * yesterday or later. The intake moves an older day to its own today, and first-of-period marks would count the user
 * twice. An old id may belong to a user who withdrew consent and was forgotten.
 */
function sendableCheck({
  id,
  today,
}: {
  id: string | undefined;
  today: CalendarDate;
}): (envelope: Envelope, event: UsageEvent) => boolean {
  return (envelope, event) => {
    const day = parseDay(event.day);
    return (envelope.id === undefined || envelope.id === id) && day !== undefined && daysBetween(day, today) <= 1;
  };
}
