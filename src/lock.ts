/** Runs `operation` while no other context that shares the storage runs one, such as through Web Locks. */
export type Lock = <T>(operation: () => Promise<T>) => Promise<T>;
