import { systemClock, type Clock } from './clock.js';

/**
 * Sends one envelope and resolves to the intake's HTTP status, or 0 on failure. It must resolve within 30 seconds. Past
 * a minute, the intake keeps a forgotten user's events, and the envelope's lease ends, so another context may resend
 * it.
 */
export type Transport = (body: string) => Promise<number>;

const TIMEOUT_MS = 30_000;

/**
 * Returns a transport that posts each envelope to `endpoint` with `fetch`, the host's own by default. The transport
 * resolves to 0 when a request takes over 30 seconds.
 */
export function newHttpTransport(
  endpoint: string,
  {
    // The default calls `fetch` through its global. A browser refuses a `fetch` called apart from its global.
    fetch = (input, init) => globalThis.fetch(input, init),
    clock = systemClock,
  }: { fetch?: typeof globalThis.fetch; clock?: Clock } = {},
): Transport {
  return async (body) => {
    const timeout = new AbortController();
    const timer = clock.setTimeout(() => timeout.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        // This type skips a CORS preflight. The intake reads the body as JSON.
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body,
        // An extension with host access, or a page on the intake's own origin, would otherwise send the user's cookies
        // for that host. The intake reads none.
        credentials: 'omit',
        // A page's own policy could otherwise send its full address, which `getPage` exists to keep out.
        referrerPolicy: 'no-referrer',
        keepalive: true,
        signal: timeout.signal,
      });
      return response.status;
    } catch {
      return 0;
    } finally {
      clock.clearTimeout(timer);
    }
  };
}
