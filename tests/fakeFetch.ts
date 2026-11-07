/** One request the fake received, with its body parsed back into the envelope it carried. */
export interface RecordedRequest {
  url: string;
  method: string | undefined;
  contentType: string | undefined;
  keepalive: boolean | undefined;
  envelope: Envelope;
}

/** The envelope as the intake service reads it. Fields stay loose so a test sees exactly what was sent. */
export interface Envelope {
  key: string;
  platform: string;
  version: string;
  lang?: string;
  session: string;
  id?: string;
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

/** A network edge that records every request and answers 204 unless a test queued another outcome. */
export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly outcomes: Array<number | Error> = [];

  /** Queues `times` answers with `status` for the next requests. */
  respondNextWith(status: number, times = 1): void {
    for (let index = 0; index < times; index++) {
      this.outcomes.push(status);
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
    this.requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method,
      contentType: headers.get('content-type') ?? undefined,
      keepalive: init?.keepalive,
      envelope: parseEnvelope(init?.body),
    });
    const outcome = this.outcomes.shift() ?? 204;
    if (outcome instanceof Error) {
      throw outcome;
    }
    return new Response(undefined, { status: outcome });
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

/** Checks only for the events list. The tests assert the rest of the shape themselves. */
function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && Array.isArray(Reflect.get(value, 'events'));
}
