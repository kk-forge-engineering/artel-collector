import type { Clock, TimerHandle } from './clock.js';
import { daysBetween, parseDay, utcDateAt, type CalendarDate } from './calendar.js';
import type { Envelope, UsageEvent } from './envelope.js';
import { isTestKey, isUsableId, quoted } from './hostInput.js';
import type { Lock } from './lock.js';
import {
  newQueue,
  newRandomId,
  type Identity,
  type LeaseTerms,
  type QueuedEnvelope,
  type SealedEnvelope,
} from './queue.js';
import type { StorageAdapter } from './storage.js';
import type { Transport, TransportResult } from './transport.js';

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** Names the stored time, in epoch milliseconds, before which no context that shares the storage starts a send. */
const RETRY_AT_KEY = 'retry_at';
/**
 * The time one send holds the lease on a queued envelope, twice the 30 s request limit of `newHttpTransport` in
 * `src/transport.ts`. The send renews the lease before each request. A host that stops mid-send blocks the envelope
 * only until its lease ends.
 */
const LEASE_MS = 60_000;
/**
 * The longest the outbox waits for a transport's answer, a little over the 30 s a transport must answer in. A request
 * that took longer counts as status 0, so a broken transport stops no send, `flush`, `forget` or opt-out for good.
 */
const TRANSPORT_LIMIT_MS = 35_000;
const MAX_HTTP_STATUS = 599;

/**
 * Holds the envelopes and the forget requests on their way to the intake. The forget requests leave first, then the
 * envelopes, one at a time, in the order they were made. A request the intake cannot take now goes again later, and
 * each wait doubles, up to five minutes. A longer `Retry-After` of a 429 or 503 sets the wait instead. Every context
 * that shares the storage keeps the longest wait any of them stored.
 */
interface Outbox {
  /**
   * Queues the event and sends it within the send delay, at once when its envelope is full, or with the pending retry.
   * Resolves to what the queue dropped to take it, whose marks may go back.
   */
  add(fields: Omit<Envelope, 'events'>, event: UsageEvent, options?: { awaitsId?: boolean }): Promise<QueuedEnvelope[]>;
  /** Sends what is queued within the send delay, such as what an earlier run of the host left. */
  sendSoon(): void;
  /**
   * Sends what is queued now, in turn after any send in progress, or once the retry wait is over. A request in progress
   * that carries a forgotten id thus reaches the intake before the forget does.
   */
  send(): Promise<void>;
  /**
   * Drops every envelope not sent yet but those of an `opted_out`. Resolves to those whose marks may go back, as
   * `src/queue.ts` describes.
   */
  discard(): Promise<QueuedEnvelope[]>;
  /**
   * Drops the envelopes of this id and stores the request that asks the intake to delete the id's events, except with
   * a test key. Resolves to all of them, since the intake deletes their events too.
   */
  forget(id: string): Promise<QueuedEnvelope[]>;
  /** Drops the envelopes that name a user or that await an id. Resolves to those whose marks may go back. */
  discardIdentified(): Promise<QueuedEnvelope[]>;
}

/**
 * Expects the caller to run `add`, `discard`, `forget` and `discardIdentified` inside its own `lock`, which it holds
 * for the whole recording of an event. The sends take the lock themselves.
 */
export function newOutbox({
  key,
  storage,
  lock,
  transport,
  forgetTransport,
  identify,
  giveBack,
  sendDelayMs,
  clock,
  reportError,
}: {
  /** The channel key, which a forget request names. */
  key: string;
  storage: StorageAdapter;
  lock: Lock;
  transport: Transport;
  /** Delivers a forget request, whose body is `{ key, id }`. */
  forgetTransport: Transport;
  /** The longest an event waits in the queue before a send starts. */
  sendDelayMs: number;
  /**
   * Resolves to the user that an envelope awaiting an id will name, or to undefined while the product does not know the
   * id yet. The envelope then stays queued. It takes `lock` itself, so the outbox calls it outside the lock.
   */
  identify: () => Promise<Identity | undefined>;
  /**
   * Gives back the marks of an envelope too old to send that no request carried. The outbox calls it under `lock`.
   */
  giveBack: (items: readonly QueuedEnvelope[]) => Promise<void>;
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
      reportError(new Error(`artel: ${count} queued events dropped as too old`));
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
    sendTimer = clock.setTimeout(() => void sendUnlessRetryPending(), delayMs);
  }

  /** Sends at once, cancelling a pending retry, as `flush` and a retry timer do. */
  function send(): Promise<void> {
    cancelSend();
    cancelRetry();
    sending = sending.then(sendLeased).catch(reportError);
    return sending;
  }

  /**
   * Sends in turn after any send in progress, unless that send failed and left a retry pending. The intake asked the
   * outbox to wait, and the retry carries these events too.
   */
  function sendUnlessRetryPending(): Promise<void> {
    cancelSend();
    sending = sending.then(async () => (retryTimer === undefined ? sendLeased() : undefined)).catch(reportError);
    return sending;
  }

  /**
   * Resolves to the time left of the retry wait any context stored. A stored wait longer than five minutes, as after a
   * clock set back, or a value another script wrote that is no time, is reported and stored again as five minutes from
   * now, so it holds no send for longer. The caller holds `lock`.
   */
  async function retryWaitMs(): Promise<number> {
    const stored = (await storage.get(RETRY_AT_KEY)) ?? '';
    const waitMs = Math.max(0, Number(stored) - clock.now());
    if (waitMs <= MAX_RETRY_DELAY_MS) {
      return waitMs;
    }
    reportError(
      new Error(
        `artel: the stored retry wait ${quoted(stored)} is no time within five minutes, so the wait is five minutes`,
      ),
    );
    await storage.set(RETRY_AT_KEY, String(clock.now() + MAX_RETRY_DELAY_MS));
    return MAX_RETRY_DELAY_MS;
  }

  /** Stores a retry wait of `waitMs` from now, unless a longer one is stored. The caller holds `lock`. */
  async function keepRetryWait(waitMs: number): Promise<void> {
    const longest = Math.max(waitMs, await retryWaitMs());
    await storage.set(RETRY_AT_KEY, String(clock.now() + longest));
  }

  /**
   * Leases what is queued and sends it, or schedules the send for the end of the retry wait. An envelope not settled
   * when the send stops goes back to the queue.
   */
  async function sendLeased(): Promise<void> {
    const { taken, waitMs } = await lock(async () => {
      const wait = await retryWaitMs();
      return {
        waitMs: wait,
        taken: wait > 0 ? undefined : { forgets: await queue.forgets(), leased: await queue.lease(leaseTerms()) },
      };
    });
    if (taken === undefined) {
      // The pending retry of this context sends at the end of the wait. Without one, a send of its own does.
      sendWithin(waitMs);
      return;
    }
    const { forgets, leased } = taken;
    const unsettled = new Set(leased.map((item) => item.qid));
    try {
      if (await sendForgets(forgets)) {
        await sendInOrder(leased, unsettled);
      }
    } finally {
      if (unsettled.size > 0) {
        await lock(async () => queue.release(holder, [...unsettled]));
      }
    }
  }

  /**
   * Seals the envelope for its request, or resolves to undefined when it does not go now. An envelope gone from the
   * queue, or one another holder took, is settled. One that waits for an id the product does not know yet stays leased
   * until the send ends.
   */
  async function sealIfItMayLeave(item: QueuedEnvelope, unsettled: Set<string>): Promise<SealedEnvelope | undefined> {
    const identity = item.awaitsId === true ? await identify() : undefined;
    if (item.awaitsId === true && identity === undefined) {
      return undefined;
    }
    const sealed = await lock(async () => queue.seal(item.qid, leaseTerms(), identity));
    if (sealed === undefined) {
      unsettled.delete(item.qid);
    }
    return sealed;
  }

  /**
   * Starts the retry wait after a request the intake could not take now. The retry carries the requests that came
   * during the wait. A send they armed skips its turn while the retry is pending.
   */
  async function waitForRetry(askedWaitMs: number | undefined): Promise<void> {
    cancelSend();
    cancelRetry();
    const waitMs = Math.min(Math.max(retryDelay, askedWaitMs ?? 0), MAX_RETRY_DELAY_MS);
    retryTimer = clock.setTimeout(() => void send(), waitMs);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    await lock(async () => keepRetryWait(waitMs));
  }

  /**
   * Sends the stored forget requests, and resolves to whether the intake answered each one. Another context may send
   * the same request at once, which deletes nothing more. The body names this collector's own key, and an id the
   * intake would refuse is dropped unsent: any script of the origin can write the stored ids.
   */
  async function sendForgets(ids: readonly string[]): Promise<boolean> {
    for (const id of ids) {
      if (!isUsableId(id)) {
        await lock(async () => queue.removeForget(id));
        continue;
      }
      const { isSettled, askedWaitMs } = await deliver({
        body: JSON.stringify({ key, id }),
        transport: forgetTransport,
        what: 'a forget',
        reportError,
        clock,
      });
      if (!isSettled) {
        await waitForRetry(askedWaitMs);
        return false;
      }
      await lock(async () => queue.removeForget(id));
    }
    return true;
  }

  /**
   * Sends the envelopes in order. The function seals and reads each one just before its request, so the request carries
   * every event added since the lease. From the first envelope the intake cannot take now, the rest wait for a retry.
   */
  async function sendInOrder(leased: QueuedEnvelope[], unsettled: Set<string>): Promise<void> {
    const today = utcDateAt(clock.now());
    for (const item of leased) {
      const sealed = await sealIfItMayLeave(item, unsettled);
      if (sealed === undefined) {
        continue;
      }
      // An envelope goes whole or not at all. The intake drops a repeat only when it matches the first body byte for
      // byte, and a repeat with fewer events would not match.
      const { envelope, body, isRepeat } = sealed;
      if (!envelope.events.every((event) => isRecent(event, today))) {
        reportDropped(envelope.events.length);
        await lock(async () => {
          await queue.remove(item.qid);
          await giveBack(isRepeat ? [] : [{ ...item, envelope }]);
        });
        unsettled.delete(item.qid);
        continue;
      }
      const { isSettled, askedWaitMs } = await deliver({ body, transport, what: 'an envelope', reportError, clock });
      if (!isSettled) {
        await waitForRetry(askedWaitMs);
        return;
      }
      await lock(async () => queue.remove(item.qid));
      unsettled.delete(item.qid);
    }
    retryDelay = RETRY_DELAY_MS;
  }

  return {
    add: async (fields, event, options) => {
      const { isFull, dropped } = await queue.add(fields, event, options);
      // A full envelope goes at once. Otherwise the send waits, so that the events of the next few seconds share one
      // request.
      sendWithin(isFull ? 0 : sendDelayMs);
      return dropped;
    },
    sendSoon: () => sendWithin(sendDelayMs),
    send,
    // A send in progress holds leases on what it took. Dropping those envelopes here keeps that send from sending them
    // again.
    discard: () => queue.removeAllButOptOuts(),
    forget: async (id) => {
      // The intake answers a forget with a test key 403, since it would delete the user's live events too.
      if (!isTestKey(key)) {
        await queue.addForget(id);
      }
      return queue.removeId(id);
    },
    discardIdentified: () => queue.removeIdentified(),
  };
}

/**
 * Sends one request, and resolves to whether it is settled. It is not on 429, a rate limit, on 5xx, a store that
 * missed the write, or on status 0, which a browser also gives for a refusal without CORS headers. Then it resolves to
 * the wait the `Retry-After` of a 429 or 503 asks for too. Any other status outside 2xx means a wrong envelope or
 * channel, so a retry would fail the same way.
 */
async function deliver({
  body,
  transport,
  what,
  reportError,
  clock,
}: {
  body: string;
  transport: Transport;
  /** Names the request in a report, such as `an envelope`. */
  what: string;
  reportError: (error: unknown) => void;
  clock: Clock;
}): Promise<{ isSettled: boolean; askedWaitMs?: number | undefined }> {
  const result = await answerOf(transport, body, clock);
  const status = httpStatus(result.status, reportError);
  if (status === 429 || status === 503) {
    return { isSettled: false, askedWaitMs: retryAfterMs(result.retryAfter, clock.now()) };
  }
  if (status === 0 || status >= 500) {
    return { isSettled: false };
  }
  if (status < 200 || status >= 300) {
    reportError(new Error(`artel: intake answered ${status} to ${what}`));
  }
  return { isSettled: true };
}

/**
 * Returns the status, or reports a value that is not a whole number from 0 to 599 and returns 0, a failed request.
 * Only a product's own transport, outside TypeScript or with a bug, gives such a value.
 */
function httpStatus(status: unknown, reportError: (error: unknown) => void): number {
  if (typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= MAX_HTTP_STATUS) {
    return status;
  }
  reportError(new Error('artel: the transport answered a status that is no whole number from 0 to 599, read as 0'));
  return 0;
}

/**
 * Resolves to the transport's answer, or to status 0 for a transport that throws, rejects or answers too late, or that
 * answers null or undefined, as only a product's own transport outside TypeScript does.
 */
async function answerOf(
  transport: Transport,
  body: string,
  clock: Clock,
): Promise<{ status: number; retryAfter?: string | undefined }> {
  let timer: TimerHandle | undefined;
  const late = new Promise<TransportResult>((resolve) => {
    timer = clock.setTimeout(() => resolve({ status: 0 }), TRANSPORT_LIMIT_MS);
  });
  try {
    const answer = await Promise.race([transport(body), late]);
    // A null or undefined answer throws here, and reads as status 0.
    return typeof answer === 'number' ? { status: answer } : { status: answer.status, retryAfter: answer.retryAfter };
  } catch {
    return { status: 0 };
  } finally {
    clock.clearTimeout(timer);
  }
}

/**
 * Returns the wait a `Retry-After` value asks for at `now`, in milliseconds: its delta-seconds, or the time to its HTTP
 * date, none for a date in the past. Returns undefined for a missing or invalid value, or one that is no string, which
 * only a product's own transport outside TypeScript gives.
 */
function retryAfterMs(value: unknown, now: number): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1_000;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - now) : undefined;
}

/**
 * Tells whether an event may still go: its day is UTC yesterday or later. The intake moves an older day to its own
 * today, and first-of-period marks would count the user twice.
 */
function isRecent(event: UsageEvent, today: CalendarDate): boolean {
  const day = parseDay(event.day);
  return day !== undefined && daysBetween(day, today) <= 1;
}
