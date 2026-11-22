/**
 * Holds the collector's state between runs of the host. Every key the collector uses starts with `artel.<channel
 * key>.`.
 */
export interface StorageAdapter {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/**
 * Returns storage that keeps state only while the page or worker lives. Tests use it, and so does a host with nowhere
 * to persist state.
 */
export function newMemoryStorage(): StorageAdapter {
  const items = new Map<string, string>();
  return {
    get: async (key) => items.get(key),
    set: async (key, value) => {
      items.set(key, value);
    },
  };
}

/**
 * Returns `storage` with each name stored under `artel.<key>.<name>`. Then collectors of different channel keys over
 * one storage share no state, and none drops the queued envelopes of another.
 */
export function newChannelStorage(storage: StorageAdapter, key: string): StorageAdapter {
  const prefix = `artel.${key}.`;
  return {
    get: (name) => storage.get(prefix + name),
    set: (name, value) => storage.set(prefix + name, value),
  };
}
