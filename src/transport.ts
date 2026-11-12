import { systemClock, type Clock } from './clock.js';
import type { CollectorOptions } from './collectorTypes.js';

/** What the intake answered: its HTTP status, 0 when the request did not reach it, and its `Retry-After` header. */
export interface TransportResult {
  status: number;
  retryAfter?: string;
}

/**
 * Sends one request body and resolves to the intake's answer or its HTTP status. The body is an envelope, for the
 * intake's `/v1/public/relay`, or a forget request `{ key, id }` without `events`, for its `/v1/public/forget`. It must
 * resolve within 30 seconds. After 35 seconds the outbox counts it as status 0 and sends the body again. The intake
 * keeps a forgotten user's events from a request that arrives over a minute after the forget.
 */
export type Transport = (body: string) => Promise<number | TransportResult>;

const TIMEOUT_MS = 30_000;

/**
 * Returns a transport that posts each body to `endpoint` with `fetch`, the host's own by default. The transport
 * resolves to the status and the raw `Retry-After` header, or to status 0 when a request fails or takes over 30
 * seconds.
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
      const retryAfter = response.headers.get('Retry-After');
      return { status: response.status, ...(retryAfter !== null && { retryAfter }) };
    } catch {
      return { status: 0 };
    } finally {
      clock.clearTimeout(timer);
    }
  };
}

/**
 * Returns the transport of the envelopes and that of the forget requests. A product's own transport takes both kinds
 * of request.
 */
export function transportsOf(options: CollectorOptions): { transport: Transport; forgetTransport: Transport } {
  if (options.transport !== undefined) {
    return { transport: options.transport, forgetTransport: options.transport };
  }
  return {
    transport: newHttpTransport(options.endpoint),
    forgetTransport: newHttpTransport(forgetUrlOf(options.endpoint)),
  };
}

/**
 * Returns the intake's forget address: `endpoint` with `forget` in place of the last segment of its path, which is
 * `relay`. A trailing slash goes with that segment. The query stays, as on the envelopes' address.
 */
function forgetUrlOf(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/[^/]*\/*$/, 'forget');
  return url.href;
}
