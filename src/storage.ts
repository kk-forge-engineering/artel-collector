/** Where the collector keeps its state between runs of the host. Every key it uses starts with `artel.`. */
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
