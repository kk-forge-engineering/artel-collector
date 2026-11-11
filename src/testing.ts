import { AnalyticsState, Mode, type Collector } from './collectorTypes.js';
import type { EventParams } from './envelope.js';
import { acceptedEvent } from './eventCheck.js';
import { quoted, reportTo } from './hostInput.js';
import { newQueue } from './queue.js';
import { channelTakes } from './stateFields.js';
import { newChannelStorage, type StorageAdapter } from './storage.js';

/** One event as a product tracked it. */
export interface RecordedEvent {
  name: string;
  params?: EventParams;
}

/** A collector that keeps in memory what it would send, for a product's own tests. */
export type RecordingCollector<M extends Mode = Mode> = Collector<M> & {
  /** The events it took, oldest first. */
  readonly events: RecordedEvent[];
};

/**
 * Returns a collector of channel mode `mode`, `identified` by default, that sends nothing and records each event it
 * takes. Its user starts in the anonymous state. It refuses an event `track` refuses, and a state above the mode, with
 * the same report to `onError`. It records nothing in the opted_out state, and `installed` only once. `uninstallParams`
 * resolves to undefined.
 */
export function newRecordingCollector<M extends Mode = typeof Mode.Identified>(
  mode?: M,
  { onError }: { onError?: (error: Error) => void } = {},
): RecordingCollector<M> {
  const channelMode: Mode = mode ?? Mode.Identified;
  const reportError = (error: unknown): void => reportTo(onError, error);
  const events: RecordedEvent[] = [];
  let state: AnalyticsState = AnalyticsState.Anonymous;
  let isInstalled = false;
  const record = (name: string, params?: EventParams): void => {
    if (state !== AnalyticsState.OptedOut) {
      events.push({ name, ...(params !== undefined && { params }) });
    }
  };
  return {
    events,
    track: async (name, given) => {
      const event = acceptedEvent(name, given, reportError);
      if (event !== undefined) {
        record(name, event.params);
      }
    },
    installed: async () => {
      if (!isInstalled && state !== AnalyticsState.OptedOut) {
        isInstalled = true;
        record('installed');
      }
    },
    updated: async () => record('updated'),
    setState: async (next) => {
      if (channelTakes(channelMode, next)) {
        state = next;
      } else {
        reportError(new TypeError(`artel: a channel of mode ${quoted(channelMode)} takes no state ${quoted(next)}`));
      }
    },
    getState: async () => state,
    flush: async () => undefined,
    forget: async () => undefined,
    uninstallParams: async () => undefined,
  };
}

/**
 * Resolves to the events a collector of channel `key` holds queued in `storage`, oldest first, so a product's test reads
 * them without the queue's stored form.
 */
export async function queuedEvents(storage: StorageAdapter, key: string): Promise<RecordedEvent[]> {
  const queue = newQueue({ storage: newChannelStorage(storage, key), reportError: () => undefined });
  return (await queue.envelopes()).flatMap(({ envelope }) =>
    envelope.events.map(({ name, params }) => ({ name, ...(params !== undefined && { params }) })),
  );
}
