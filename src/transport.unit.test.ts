import { describe, expect, it, vi } from 'vitest';
import { newHttpTransport } from './exports.js';
import { FakeClock } from '../tests/fakeClock.js';
import { ENDPOINT } from '../tests/harness.js';

describe('newHttpTransport', () => {
  it('resolves to 0 when fetch fails, as on a refusal a browser hides behind CORS', async () => {
    const transport = newHttpTransport(ENDPOINT, {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    await expect(transport('{}')).resolves.toBe(0);
  });

  it('sends no cookies and no referrer, so neither a session nor a page address reaches the intake', async () => {
    let sent: RequestInit | undefined;
    const transport = newHttpTransport(ENDPOINT, {
      fetch: async (_, init) => {
        sent = init;
        return new Response(undefined, { status: 204 });
      },
    });

    await transport('{}');

    expect(sent).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('resolves to 0 when the intake does not answer within 30 seconds', async () => {
    const clock = new FakeClock('2026-10-29T10:00:00');
    const transport = newHttpTransport(ENDPOINT, {
      clock,
      fetch: async (_, init) => {
        await new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        );
        return new Response(undefined, { status: 204 });
      },
    });

    const status = transport('{}');
    await clock.advance(30_000);

    await expect(status).resolves.toBe(0);
  });

  it('calls the global fetch through its global, as a browser requires, when the host gives none', async () => {
    vi.stubGlobal('fetch', function (this: unknown) {
      return this === globalThis
        ? Promise.resolve(new Response(undefined, { status: 204 }))
        : Promise.reject(new TypeError('Illegal invocation'));
    });

    await expect(newHttpTransport(ENDPOINT)('{}')).resolves.toBe(204);
  });

  it('resolves to the status the intake answered', async () => {
    const transport = newHttpTransport(ENDPOINT, { fetch: async () => new Response(undefined, { status: 403 }) });

    await expect(transport('{}')).resolves.toBe(403);
  });
});
