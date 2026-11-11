import { LifecycleEvent, type Envelope, type IdKind, type UsageEvent } from './envelope.js';
import type { StorageAdapter } from './storage.js';

export const QUEUE_KEY = 'queue';
/** Names the stored forget requests, a JSON list of request bodies. */
const FORGETS_KEY = 'forgets';
const MAX_ENVELOPE_EVENTS = 100;
/**
 * The largest request body, under 64 KiB with some margin. A keepalive request and the intake both refuse a larger
 * body.
 */
const MAX_ENVELOPE_BYTES = 60_000;
const MAX_QUEUED_ENVELOPES = 20;
/**
 * The most `opted_out` envelopes the queue keeps. The cap of 20 never drops one, so without this limit opt-outs that
 * never went could fill the queue, and the cap would then drop every new envelope.
 */
const MAX_QUEUED_OPT_OUTS = 2;

export interface QueuedEnvelope {
  qid: string;
  /**
   * The request body the first seal stored. No event joins a sealed envelope. The intake may keep a request that failed
   * for the sender, and it drops a repeat only when the body is the same, byte for byte.
   */
  body?: string;
  /** The holder of the lease, so that no other context sends the envelope too. */
  leasedBy?: string;
  /** The time the lease ends, in epoch milliseconds. */
  leasedUntil?: number;
  /** Marks an envelope of a state with an id the product does not know yet. It waits for the id and goes with it. */
  awaitsId?: true;
  /** Marks the envelope of an `opted_out`, which the intake takes only alone. No other event joins it. */
  isOptOut?: true;
  envelope: Envelope;
}

/** The user that an envelope awaiting an id names, known once the product knows the id. */
export interface Identity {
  id: string;
  id_kind: IdKind;
  browser?: Envelope['browser'];
}

/** Holds a sealed envelope and the body each send attempt carries. */
export interface SealedEnvelope {
  envelope: Envelope;
  body: string;
  /** Whether an earlier seal stored the body, so a request may have carried it to the intake. */
  isRepeat: boolean;
}

/** Names the lease holder, the time of the call and the time the lease ends. Both times are in epoch milliseconds. */
export interface LeaseTerms {
  holder: string;
  now: number;
  until: number;
}

/**
 * Keeps envelopes and forget requests in storage until the intake takes them, so a host that stops, such as an idle
 * extension service worker, loses none. A method that drops envelopes resolves to those whose marks may go back: the
 * ones no seal stored a body for, since the intake may keep a request that failed for the sender. `removeId` resolves
 * to all of them.
 */
interface Queue {
  /**
   * Adds the event to the newest envelope with the same fields while it has no body and stays within 100 events and 60
   * kB, else to a new one. An `opted_out` takes an envelope of its own. Resolves to whether that envelope holds 100
   * events, and to what the queue dropped: the oldest envelope past 20.
   */
  add(
    fields: Omit<Envelope, 'events'>,
    event: UsageEvent,
    options?: { awaitsId?: boolean },
  ): Promise<{ isFull: boolean; dropped: QueuedEnvelope[] }>;
  /**
   * Leases to `holder`, until `until`, every envelope no other holder has a current lease on. Resolves to them, oldest
   * first.
   */
  lease(terms: LeaseTerms): Promise<QueuedEnvelope[]>;
  /**
   * Seals one envelope before its request and extends the lease of `holder`. An envelope that awaits an id takes
   * `identity` first. The first seal stores the body, with the queue id as `batch`. Resolves to undefined when the
   * envelope is gone or another holder took it, as after an opt-out, a forget or an expired lease.
   */
  seal(qid: string, terms: LeaseTerms, identity?: Identity): Promise<SealedEnvelope | undefined>;
  /** Drops an envelope the intake took or refused for good. */
  remove(qid: string): Promise<void>;
  /** Ends the lease of `holder` on these envelopes, which keep their place. */
  release(holder: string, qids: readonly string[]): Promise<void>;
  /**
   * Drops the envelopes that carry this id, as when the host forgets the user. Resolves to all of them, since the
   * intake deletes their events too.
   */
  removeId(id: string): Promise<QueuedEnvelope[]>;
  /** Drops the envelopes that name a user or wait to, as when the user stops being identified. */
  removeIdentified(): Promise<QueuedEnvelope[]>;
  removeAllButOptOuts(): Promise<QueuedEnvelope[]>;
  /** Stores a forget request's body, unless it is stored already. */
  addForget(body: string): Promise<void>;
  /** Resolves to the stored forget request bodies, oldest first. */
  forgets(): Promise<string[]>;
  removeForget(body: string): Promise<void>;
}

/** Returns a queue in `storage`. The caller holds a lock around each call. */
export function newQueue({
  storage,
  reportError,
}: {
  storage: StorageAdapter;
  reportError: (error: unknown) => void;
}): Queue {
  /**
   * Returns the stored envelopes. A stored queue that is no JSON list is reported once and dropped. An item without a
   * queue id and an envelope with a list of events is skipped, so a value another script wrote never makes a method
   * throw.
   */
  async function read(): Promise<QueuedEnvelope[]> {
    const queued = parseQueue(await storage.get(QUEUE_KEY));
    if (queued === undefined) {
      reportError(new Error('artel: the stored queue is not a JSON list, so it was dropped'));
      await write([]);
      return [];
    }
    return queued;
  }

  async function write(items: QueuedEnvelope[]): Promise<void> {
    await storage.set(QUEUE_KEY, JSON.stringify(items));
  }

  /**
   * Keeps the newest two `opted_out` envelopes, and then the newest other envelopes while the queue holds at most 20,
   * and reports what it drops. Returns the kept envelopes, and the other dropped ones that no request carried, since an
   * `opted_out` carries no marks.
   */
  function withinCaps(items: readonly QueuedEnvelope[]): { kept: QueuedEnvelope[]; dropped: QueuedEnvelope[] } {
    const optOuts = items.filter((item) => item.isOptOut === true);
    const others = items.filter((item) => item.isOptOut !== true);
    const droppedOptOuts = optOuts.slice(0, Math.max(0, optOuts.length - MAX_QUEUED_OPT_OUTS));
    const keptOptOuts = optOuts.length - droppedOptOuts.length;
    const dropped = others.slice(0, Math.max(0, others.length - Math.max(0, MAX_QUEUED_ENVELOPES - keptOptOuts)));
    if (droppedOptOuts.length > 0) {
      reportError(
        new Error(
          `artel: the queue holds at most ${MAX_QUEUED_OPT_OUTS} opted_out envelopes, so the oldest ${droppedOptOuts.length} were dropped`,
        ),
      );
    }
    if (dropped.length > 0) {
      reportError(
        new Error(
          `artel: the queue holds at most ${MAX_QUEUED_ENVELOPES} envelopes, so the oldest ${dropped.length} were dropped`,
        ),
      );
    }
    const gone = new Set([...droppedOptOuts, ...dropped]);
    return { kept: items.filter((item) => !gone.has(item)), dropped: unsent(dropped) };
  }

  /** Returns the stored forget requests. A value that is no JSON list reads as none, and only its strings count. */
  async function readForgets(): Promise<string[]> {
    let bodies: unknown;
    try {
      bodies = JSON.parse((await storage.get(FORGETS_KEY)) ?? '[]');
    } catch {
      return [];
    }
    return Array.isArray(bodies) ? bodies.filter((body): body is string => typeof body === 'string') : [];
  }

  async function writeForgets(bodies: string[]): Promise<void> {
    await storage.set(FORGETS_KEY, JSON.stringify(bodies));
  }

  async function update(change: (items: QueuedEnvelope[]) => QueuedEnvelope[]): Promise<void> {
    await write(change(await read()));
  }

  /** Drops the envelopes `isDropped` picks and resolves to them. Writes nothing when it picks none. */
  async function removeWhere(isDropped: (item: QueuedEnvelope) => boolean): Promise<QueuedEnvelope[]> {
    const items = await read();
    const dropped = items.filter(isDropped);
    if (dropped.length > 0) {
      await write(items.filter((item) => !isDropped(item)));
    }
    return dropped;
  }

  return {
    add: async (fields, event, { awaitsId = false } = {}) => {
      const isOptOut = event.name === LifecycleEvent.OptedOut;
      const newItem = (): QueuedEnvelope => ({
        qid: newRandomId(),
        ...(awaitsId && { awaitsId: true }),
        ...(isOptOut && { isOptOut: true }),
        envelope: { ...fields, events: [event] },
      });
      const items = await read();
      const last = items.at(-1);
      const isOpen =
        last !== undefined &&
        !isOptOut &&
        last.isOptOut !== true &&
        last.body === undefined &&
        (last.awaitsId === true) === awaitsId &&
        sameFields(last.envelope, fields) &&
        last.envelope.events.length < MAX_ENVELOPE_EVENTS &&
        fits(last.envelope, event);
      if (isOpen) {
        last.envelope.events.push(event);
      } else {
        items.push(newItem());
      }
      const { kept, dropped } = withinCaps(items);
      await write(kept);
      return { isFull: kept.at(-1)?.envelope.events.length === MAX_ENVELOPE_EVENTS, dropped };
    },

    lease: async (terms) => {
      const items = await read();
      const free = items.filter((item) => isFree(item, terms));
      if (free.length > 0) {
        for (const item of free) {
          item.leasedBy = terms.holder;
          item.leasedUntil = terms.until;
        }
        await write(items);
      }
      return free;
    },

    seal: async (qid, terms, identity) => {
      const items = await read();
      const item = items.find((candidate) => candidate.qid === qid);
      if (item === undefined || !isFree(item, terms) || (item.awaitsId === true && identity === undefined)) {
        return undefined;
      }
      if (item.awaitsId === true && identity !== undefined) {
        // The browser, the session and the id with its kind go after the other fields and the events. The body stored
        // at this seal keeps that order on every attempt.
        const { session, ...fields } = item.envelope;
        item.envelope = {
          ...fields,
          ...(identity.browser !== undefined && { browser: identity.browser }),
          session,
          id: identity.id,
          id_kind: identity.id_kind,
        };
        delete item.awaitsId;
      }
      const isRepeat = item.body !== undefined;
      const body = item.body ?? bodyOf(item);
      item.body = body;
      item.leasedBy = terms.holder;
      item.leasedUntil = terms.until;
      await write(items);
      return { envelope: item.envelope, body, isRepeat };
    },

    remove: (qid) => update((items) => items.filter((item) => item.qid !== qid)),

    release: (holder, qids) =>
      update((items) =>
        items.map((item) => {
          if (!qids.includes(item.qid) || item.leasedBy !== holder) {
            return item;
          }
          const { leasedBy: _holder, leasedUntil: _until, ...released } = item;
          return released;
        }),
      ),

    removeId: (id) => removeWhere((item) => item.envelope.id === id),

    removeIdentified: async () =>
      unsent(await removeWhere((item) => item.envelope.id !== undefined || item.awaitsId === true)),

    removeAllButOptOuts: async () => unsent(await removeWhere((item) => item.isOptOut !== true)),

    addForget: async (body) => {
      const bodies = await readForgets();
      if (!bodies.includes(body)) {
        await writeForgets([...bodies, body]);
      }
    },

    forgets: readForgets,

    removeForget: async (body) => writeForgets((await readForgets()).filter((stored) => stored !== body)),
  };
}

/**
 * Returns the envelopes of a stored queue, oldest first, or undefined for a value that is no JSON list. It skips an item
 * without a queue id and an envelope with a list of events.
 */
export function parseQueue(stored: string | undefined): QueuedEnvelope[] | undefined {
  let queued: unknown;
  try {
    queued = JSON.parse(stored ?? '[]');
  } catch {
    // The caller reports a queue that is no list. The parser's message quotes the stored text, which may hold an id or
    // a page, so it goes nowhere.
  }
  return Array.isArray(queued) ? queued.filter(isQueuedEnvelope) : undefined;
}

/** Returns the envelopes no seal stored a body for, which no request carried to the intake. */
function unsent(items: readonly QueuedEnvelope[]): QueuedEnvelope[] {
  return items.filter((item) => item.body === undefined);
}

/**
 * Tells whether `holder` may lease or seal the envelope. A lease that ends later than a new one would counts as ended:
 * the clock was set back, and the lease would otherwise hold the envelope for as long.
 */
function isFree(item: QueuedEnvelope, { holder, now, until }: LeaseTerms): boolean {
  const { leasedUntil } = item;
  return leasedUntil === undefined || item.leasedBy === holder || leasedUntil <= now || leasedUntil > until;
}

function sameFields(envelope: Envelope, fields: Omit<Envelope, 'events'>): boolean {
  const { events: _, ...envelopeFields } = envelope;
  return JSON.stringify(envelopeFields) === JSON.stringify(fields);
}

function bodyOf({ qid, envelope }: QueuedEnvelope): string {
  return JSON.stringify({ ...envelope, batch: qid });
}

function fits(envelope: Envelope, event: UsageEvent): boolean {
  const withEvent = { ...envelope, events: [...envelope.events, event] };
  return new TextEncoder().encode(JSON.stringify(withEvent)).length <= MAX_ENVELOPE_BYTES;
}

/** Returns `byteCount` random bytes, 8 by default, as lowercase hex. */
export function newRandomId(byteCount = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isQueuedEnvelope(value: unknown): value is QueuedEnvelope {
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'qid') !== 'string') {
    return false;
  }
  const envelope: unknown = Reflect.get(value, 'envelope');
  return typeof envelope === 'object' && envelope !== null && Array.isArray(Reflect.get(envelope, 'events'));
}
