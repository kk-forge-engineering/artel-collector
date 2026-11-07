import type { Envelope, UsageEvent } from './envelope.js';
import type { StorageAdapter } from './storage.js';

const QUEUE_KEY = 'artel.queue';
const MAX_ENVELOPE_EVENTS = 100;
/**
 * The largest request body, under 64 KiB with some margin. A keepalive request and the intake both refuse a larger
 * body.
 */
const MAX_ENVELOPE_BYTES = 60_000;
const MAX_QUEUED_ENVELOPES = 20;

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
  envelope: Envelope;
}

/** Holds a sealed envelope and the body each send attempt carries. */
export interface SealedEnvelope {
  envelope: Envelope;
  body: string;
}

/** Names the lease holder, the time of the call and the time the lease ends. Both times are in epoch milliseconds. */
export interface LeaseTerms {
  holder: string;
  now: number;
  until: number;
}

/**
 * Keeps envelopes in storage until the intake takes them, so a host that stops, such as an idle extension service
 * worker, loses none. Past 20, the queue drops the oldest and reports them. Each method reads then writes, so the
 * caller holds a lock around each call.
 */
export interface Queue {
  /**
   * Adds the event to the newest envelope with the same fields while it has no body and stays within 100 events and 60
   * kB, else to a new one. Resolves to true once that envelope holds 100 events. Drops and reports an event that alone
   * passes 60 kB.
   */
  add(fields: Omit<Envelope, 'events'>, event: UsageEvent): Promise<boolean>;
  /**
   * Leases to `holder`, until `until`, every envelope no other holder has a current lease on. Resolves to them, oldest
   * first.
   */
  lease(terms: LeaseTerms): Promise<QueuedEnvelope[]>;
  /**
   * Seals one envelope before its request and extends the lease of `holder`. The first seal stores the body, with the
   * queue id as `batch`. Resolves to undefined when the envelope is gone or another holder took it, as after an
   * opt-out, a forget or an expired lease.
   */
  seal(qid: string, terms: LeaseTerms): Promise<SealedEnvelope | undefined>;
  /** Drops an envelope the intake took or refused for good. */
  remove(qid: string): Promise<void>;
  /** Ends the lease of `holder` on these envelopes, which keep their place. */
  release(holder: string, qids: readonly string[]): Promise<void>;
  /** Drops the envelopes that carry this id. */
  removeId(id: string): Promise<void>;
  clear(): Promise<void>;
}

export function newQueue({
  storage,
  reportError,
}: {
  storage: StorageAdapter;
  reportError: (error: unknown) => void;
}): Queue {
  async function read(): Promise<QueuedEnvelope[]> {
    const stored = await storage.get(QUEUE_KEY);
    try {
      const queued: unknown = JSON.parse(stored ?? '[]');
      return Array.isArray(queued) ? queued.filter(isQueuedEnvelope) : [];
    } catch (error) {
      // The function drops a queue that does not parse, so new events still go out. No envelope in such a queue could
      // be sent.
      reportError(error);
      return [];
    }
  }

  async function write(items: QueuedEnvelope[]): Promise<void> {
    const dropped = items.length - MAX_QUEUED_ENVELOPES;
    if (dropped > 0) {
      reportError(new Error(`artel: the intake stayed unavailable, ${dropped} oldest envelopes dropped`));
    }
    await storage.set(QUEUE_KEY, JSON.stringify(items.slice(Math.max(0, dropped))));
  }

  async function update(change: (items: QueuedEnvelope[]) => QueuedEnvelope[]): Promise<void> {
    await write(change(await read()));
  }

  return {
    add: async (fields, event) => {
      if (!fits({ ...fields, events: [] }, event)) {
        reportError(new Error(`artel: event ${event.name} passes ${MAX_ENVELOPE_BYTES} bytes and was dropped`));
        return false;
      }
      const items = await read();
      const last = items.at(-1);
      const isOpen =
        last !== undefined &&
        last.body === undefined &&
        sameFields(last.envelope, fields) &&
        last.envelope.events.length < MAX_ENVELOPE_EVENTS &&
        fits(last.envelope, event);
      if (isOpen) {
        last.envelope.events.push(event);
      } else {
        items.push({ qid: newRandomId(), envelope: { ...fields, events: [event] } });
      }
      await write(items);
      return items.at(-1)?.envelope.events.length === MAX_ENVELOPE_EVENTS;
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

    seal: async (qid, terms) => {
      const items = await read();
      const item = items.find((candidate) => candidate.qid === qid);
      if (item === undefined || !isFree(item, terms)) {
        return undefined;
      }
      const body = bodyOf(item);
      // The check drops an envelope whose stored body differs from its events. The checks before a send read the
      // envelope, so only a matching body has passed them.
      if (item.body !== undefined && item.body !== body) {
        reportError(new Error('artel: a queued envelope whose body differs from its events was dropped'));
        await write(items.filter((candidate) => candidate !== item));
        return undefined;
      }
      item.body = body;
      item.leasedBy = terms.holder;
      item.leasedUntil = terms.until;
      await write(items);
      return { envelope: item.envelope, body };
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

    removeId: (id) => update((items) => items.filter((item) => item.envelope.id !== id)),

    clear: () => storage.set(QUEUE_KEY, '[]'),
  };
}

function isFree(item: QueuedEnvelope, { holder, now }: LeaseTerms): boolean {
  return item.leasedUntil === undefined || item.leasedBy === holder || item.leasedUntil <= now;
}

function sameFields(envelope: Envelope, fields: Omit<Envelope, 'events'>): boolean {
  const { events: _, ...envelopeFields } = envelope;
  return JSON.stringify(envelopeFields) === JSON.stringify(fields);
}

/** Returns the request body of an envelope. Each call gives the same bytes, since a sealed envelope does not change. */
function bodyOf({ qid, envelope }: QueuedEnvelope): string {
  return JSON.stringify({ ...envelope, batch: qid });
}

function fits(envelope: Envelope, event: UsageEvent): boolean {
  const withEvent = { ...envelope, events: [...envelope.events, event] };
  return new TextEncoder().encode(JSON.stringify(withEvent)).length <= MAX_ENVELOPE_BYTES;
}

export function newRandomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isQueuedEnvelope(value: unknown): value is QueuedEnvelope {
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'qid') !== 'string') {
    return false;
  }
  const envelope: unknown = Reflect.get(value, 'envelope');
  return typeof envelope === 'object' && envelope !== null && Array.isArray(Reflect.get(envelope, 'events'));
}
