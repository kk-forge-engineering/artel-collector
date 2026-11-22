/**
 * Runs `operation` once while no other context that shares the storage runs one, such as through Web Locks. It holds
 * the lock until the operation's promise settles, and it resolves or rejects as the operation does. The collector never
 * asks for the lock while it holds it.
 */
export type Lock = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * Returns a lock that runs one operation at a time within this collector, inside the host's lock when there is one.
 * Without it, two operations over an asynchronous storage could interleave reads and writes and lose an event.
 */
export function exclusive(hostLock: Lock | undefined): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return (operation) => {
    const run = tail.then(async () => (hostLock === undefined ? operation() : hostLock(operation)));
    tail = run.catch(() => undefined);
    return run;
  };
}
