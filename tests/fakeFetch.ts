/** One request the fake received, with its body parsed back into the envelope it carried. */
export interface RecordedRequest {
  url: string;
  method: string | undefined;
  contentType: string | undefined;
  keepalive: boolean | undefined;
  envelope: Envelope;
}

/**
 * The envelope as the intake service reads it. This type is looser than the collector's own type, so a test sees
 * exactly what the collector sent.
 */
export interface Envelope {
  key: string;
  platform: string;
  browser?: { name: string; major?: number };
  version: string;
  browser_language?: string;
  ui_language?: string;
  session: string;
  id?: string;
  id_kind?: string;
  batch?: string;
  events: SentEvent[];
}

export interface SentEvent {
  name: string;
  day: string;
  first?: string[];
  age_days?: number;
  age_months?: number;
  params?: Record<string, string | number | boolean>;
  page?: string;
  referrer?: string;
}

/** One request to forget a user, with its body as the intake reads it. */
export interface RecordedForget {
  url: string;
  key: unknown;
  id: unknown;
}

/** The last segment of the intake's forget address, under any path. Every other request carries an envelope. */
const FORGET_SEGMENT = '/forget';

/**
 * A fake `fetch` that records every request, the envelopes in `requests` and the forget requests in `forgets`. It
 * answers 204 unless a test queued another outcome, which the next request of either kind takes.
 */
export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  readonly forgets: RecordedForget[] = [];
  private readonly outcomes: Array<{ status: number; headers?: Record<string, string> } | Error> = [];

  /** Queues `times` answers with `status`, and `headers` when given, for the next requests. */
  respondNextWith(status: number, times = 1, headers?: Record<string, string>): void {
    for (let index = 0; index < times; index++) {
      this.outcomes.push({ status, ...(headers !== undefined && { headers }) });
    }
  }

  failNextWithNetworkError(): void {
    this.outcomes.push(new TypeError('Failed to fetch'));
  }

  get events(): SentEvent[] {
    return this.requests.flatMap((request) => request.envelope.events);
  }

  get eventNames(): string[] {
    return this.events.map((event) => event.name);
  }

  get eventNamesByRequest(): string[][] {
    return this.requests.map((request) => eventNamesOf(request.envelope));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname.endsWith(FORGET_SEGMENT)) {
      this.forgets.push({ url, ...parseForget(init?.body) });
    } else {
      this.requests.push({
        url,
        method: init?.method,
        contentType: headers.get('content-type') ?? undefined,
        keepalive: init?.keepalive,
        envelope: parseEnvelope(init?.body),
      });
    }
    const outcome = this.outcomes.shift() ?? { status: 204 };
    if (outcome instanceof Error) {
      throw outcome;
    }
    return new Response(undefined, outcome);
  };
}

/** Returns the names of the events one request body carries, in order. */
export function eventNamesIn(body: unknown): string[] {
  return eventNamesOf(parseEnvelope(body));
}

function eventNamesOf(envelope: Envelope): string[] {
  return envelope.events.map((event) => event.name);
}

function parseEnvelope(body: unknown): Envelope {
  if (typeof body !== 'string') {
    throw new Error(`expected a string body, got ${typeof body}`);
  }
  const envelope: unknown = JSON.parse(body);
  if (!isEnvelope(envelope)) {
    throw new Error(`expected an envelope, got ${body}`);
  }
  return envelope;
}

function parseForget(body: unknown): { key: unknown; id: unknown } {
  const forget: unknown = typeof body === 'string' ? JSON.parse(body) : undefined;
  if (typeof forget !== 'object' || forget === null || Object.keys(forget).join() !== 'key,id') {
    throw new Error(`expected a forget body of key and id, got ${String(body)}`);
  }
  return { key: Reflect.get(forget, 'key'), id: Reflect.get(forget, 'id') };
}

/** Checks only for the events list. The tests assert the rest of the shape themselves. */
function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && Array.isArray(Reflect.get(value, 'events'));
}
