import { describe, expect, it, vi } from "vitest";
import { newHttpTransport } from "./exports.js";
import { FakeClock } from "../tests/fakeClock.js";
import { ENDPOINT } from "../tests/harness.js";

describe("newHttpTransport", () => {
  it("resolves to 0 when fetch fails, as on a refusal a browser hides behind CORS", async () => {
    const transport = newHttpTransport(ENDPOINT, {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(transport("{}")).resolves.toEqual({ status: 0 });
  });

  it("sends no cookies and no referrer, so neither a session nor a page address reaches the intake", async () => {
    let sent: RequestInit | undefined;
    const transport = newHttpTransport(ENDPOINT, {
      fetch: async (_, init) => {
        sent = init;
        return new Response(undefined, { status: 204 });
      },
    });

    await transport("{}");

    expect(sent).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("resolves to 0 when the intake does not answer within 30 seconds", async () => {
    const clock = new FakeClock("2026-10-29T10:00:00");
    const transport = newHttpTransport(ENDPOINT, {
      clock,
      fetch: async (_, init) => {
        await new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        );
        return new Response(undefined, { status: 204 });
      },
    });

    const status = transport("{}");
    await clock.advance(30_000);

    await expect(status).resolves.toEqual({ status: 0 });
  });

  it("calls the global fetch through its global, as a browser requires, when the host gives none", async () => {
    vi.stubGlobal("fetch", function (this: unknown) {
      return this === globalThis
        ? Promise.resolve(new Response(undefined, { status: 204 }))
        : Promise.reject(new TypeError("Illegal invocation"));
    });

    await expect(newHttpTransport(ENDPOINT)("{}")).resolves.toEqual({ status: 204 });
  });

  it("resolves to the status the intake answered", async () => {
    const transport = newHttpTransport(ENDPOINT, {
      fetch: async () => new Response(undefined, { status: 403 }),
    });

    await expect(transport("{}")).resolves.toStrictEqual({ status: 403 });
  });

  it("passes up the Retry-After the intake sent, as it came", async () => {
    const transport = newHttpTransport(ENDPOINT, {
      fetch: async () => new Response(undefined, { status: 429, headers: { "Retry-After": "7" } }),
    });

    await expect(transport("{}")).resolves.toEqual({ status: 429, retryAfter: "7" });
  });
});
