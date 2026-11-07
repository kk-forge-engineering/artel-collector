import type { Lock } from '../src/exports.js';

/**
 * Returns a lock that runs operations one at a time, in call order. A failed operation does not block the next one.
 * Tests use it in place of the Web Locks that two contexts share.
 */
export function newSharedLock(): Lock {
  let held: Promise<unknown> = Promise.resolve();
  return (operation) => {
    const run = held.then(operation);
    held = run.catch(() => undefined);
    return run;
  };
}
