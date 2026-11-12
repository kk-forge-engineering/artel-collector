import { describe, expect, it } from "vitest";
import { AnalyticsState } from "./exports.js";
import {
  MAX_RETRY_DELAY_MS,
  newHarness,
  QUEUE_KEY,
  SEND_DELAY_MS,
  type Harness,
} from "../tests/harness.js";

describe("a lease that ends too far ahead", () => {
  it("sends an envelope a stopped host left leased once the clock was set back, within five minutes", async () => {
    let isHanging = true;
    const harness: Harness = newHarness({
      transport: async (body) =>
        isHanging ? new Promise<number>(() => undefined) : harness.transport(body),
    });
    await harness.collector.track("a");
    // The send seals the envelope and its request hangs. Then the host stops, and the clock goes back an hour.
    await harness.clock.advance(SEND_DELAY_MS + 1);
    harness.clock.dropTimers();
    harness.clock.jumpMinutes(-60);
    isHanging = false;

    const next = harness.restart();
    await next.flush();
    await harness.clock.advance(6 * 60_000);
    await next.flush();

    expect(harness.fetch.eventNames).toEqual(["a"]);
  });
});

describe("opted_out envelopes in the queue", () => {
  it("keeps at most two, and drops and reports the oldest when a third comes", async () => {
    let isDown = true;
    const harness: Harness = newHarness({
      transport: async (body) => (isDown ? 503 : harness.transport(body)),
    });
    for (let index = 0; index < 3; index++) {
      await harness.collector.setState(AnalyticsState.OptedOut);
      await harness.collector.setState(AnalyticsState.Anonymous);
    }

    isDown = false;
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(harness.fetch.eventNames).toEqual(["opted_out", "opted_out"]);
    expect(harness.errors).toEqual([
      new Error(
        "artel: the queue holds at most 2 opted_out envelopes, so the oldest 1 were dropped",
      ),
    ]);
  });

  it("drops the oldest opted_out envelope, not the newest, when a third comes", async () => {
    const harness = newHarness({ transport: async () => 503 });
    // The session of each queued envelope, oldest first.
    const queuedSessions = async (): Promise<string[]> =>
      Array.from(
        ((await harness.storage.get(QUEUE_KEY)) ?? "").matchAll(/"session":"(\w+)"/g),
        ([, session]) => session ?? "",
      );
    await harness.collector.setState(AnalyticsState.OptedOut);
    const [oldest] = await queuedSessions();
    await harness.collector.setState(AnalyticsState.Anonymous);
    for (let index = 0; index < 2; index++) {
      await harness.collector.setState(AnalyticsState.OptedOut);
      await harness.collector.setState(AnalyticsState.Anonymous);
    }

    const left = await queuedSessions();
    expect(left).toHaveLength(2);
    expect(left).not.toContain(oldest);
  });
});
