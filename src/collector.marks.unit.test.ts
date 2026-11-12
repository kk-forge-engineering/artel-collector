import { describe, expect, it } from "vitest";
import { AnalyticsState, newMemoryStorage, type StorageAdapter } from "./exports.js";
import {
  MAX_RETRY_DELAY_MS,
  newHarness,
  QUEUE_KEY,
  type Harness,
  storageKey,
} from "../tests/harness.js";

const ALL_PERIODS = ["day", "week", "month", "quarter", "year"];

/**
 * Returns a harness whose intake answers 503 while `outage.isDown` is set. Only the requests it takes reach its fetch.
 */
function newHarnessWithOutage(overrides: Parameters<typeof newHarness>[0] = {}): {
  harness: Harness;
  outage: { isDown: boolean };
} {
  const outage = { isDown: true };
  const harness: Harness = newHarness({
    ...overrides,
    transport: async (body) => (outage.isDown ? 503 : harness.transport(body)),
  });
  return { harness, outage };
}

describe("the install and version marks", () => {
  it("sends updated once for a version when another user signs in at the update", async () => {
    let id = "user-a";
    const { harness, outage } = newHarnessWithOutage({ getId: () => id, version: "2.0.0" });
    await harness.storage.set(storageKey("version"), "1.0.0");
    await harness.storage.set(storageKey("installed"), "1");
    await harness.collector.updated();
    await harness.settle();

    id = "user-b";
    const upgraded = harness.restart({ version: "3.0.0" });
    await upgraded.updated();
    outage.isDown = false;
    await harness.clock.advance(MAX_RETRY_DELAY_MS);
    const next = harness.restart({ version: "3.0.0" });
    await next.updated();
    await next.flush();

    expect(
      harness.fetch.requests.map((request) => [
        request.envelope.version,
        request.envelope.events.map((event) => event.name),
      ]),
    ).toEqual([["3.0.0", ["updated"]]]);
  });

  it("sends updated once per version when an older updated that never went is dropped after a newer one", async () => {
    let id: string | undefined = "alice";
    const harness = newHarness({ getId: () => id });
    await harness.collector.installed();
    await harness.settle();

    id = undefined;
    await harness.restart({ version: "5.0.0" }).updated();
    harness.clock.setLocal("2026-11-01T10:00:00");
    await harness.restart({ version: "6.0.0" }).updated();
    id = "alice";
    // The updated of 5.0.0 is too old by now and is dropped. The updated of 6.0.0 goes.
    await harness.collector.flush();
    const restarted = harness.restart({ version: "6.0.0" });
    await restarted.updated();
    await restarted.flush();

    expect(
      harness.fetch.requests.map((request) => [
        request.envelope.version,
        request.envelope.events.map((event) => event.name),
      ]),
    ).toEqual([
      ["4.2.0", ["installed"]],
      ["6.0.0", ["updated"]],
    ]);
  });
});

describe("marks of events the collector drops", () => {
  it("keeps the marks of an installed that went stale after its requests, since the intake may have stored it", async () => {
    const { harness, outage } = newHarnessWithOutage();
    await harness.collector.installed();
    await harness.settle();

    // The intake is down for two days of the same ISO week and month.
    harness.clock.setLocal("2026-10-31T12:00:00");
    outage.isDown = false;
    await harness.collector.flush();
    await harness.collector.installed();
    await harness.collector.track("opened");
    await harness.collector.flush();

    expect(harness.fetch.events.map((event) => [event.name, event.first])).toEqual([
      ["opened", ["day"]],
    ]);
    expect(harness.errors).toHaveLength(1);
  });

  it("gives back the marks of an envelope that never went when the 20-envelope cap drops it", async () => {
    let id: string | undefined;
    const harness = newHarness({ getId: () => id });
    await harness.collector.installed();
    for (let index = 0; index < 20; index++) {
      // Each event after ten idle minutes opens a new session, so a new envelope.
      await harness.clock.advance(11 * 60_000);
      await harness.collector.track("opened");
    }

    id = "alice";
    await harness.collector.installed();
    await harness.collector.flush();

    const installed = harness.fetch.events.filter((event) => event.name === "installed");
    expect(installed.map((event) => event.first)).toEqual([ALL_PERIODS]);
    expect(harness.fetch.events.filter((event) => event.first !== undefined)).toHaveLength(1);
  });

  it("keeps the marks of an envelope that went in a request when the 20-envelope cap drops it", async () => {
    const { harness, outage } = newHarnessWithOutage();
    await harness.collector.installed();
    await harness.settle();
    for (let index = 0; index < 20; index++) {
      await harness.clock.advance(11 * 60_000);
      await harness.collector.track("opened");
    }

    outage.isDown = false;
    await harness.clock.advance(MAX_RETRY_DELAY_MS);
    await harness.collector.installed();
    await harness.collector.flush();

    expect(harness.fetch.eventNames).not.toContain("installed");
    expect(harness.fetch.events.filter((event) => event.first !== undefined)).toEqual([]);
  });

  it("keeps the marks of an envelope in flight that another context drops by opting out and back in", async () => {
    let answer: ((status: number) => void) | undefined;
    const harness = newHarness({
      transport: (body) =>
        answer === undefined
          ? new Promise<number>((resolve) => (answer = resolve))
          : harness.transport(body),
    });
    const otherTab = harness.restart();
    await harness.collector.track("a");
    void harness.collector.flush();
    await harness.clock.advance(0);

    await otherTab.setState(AnalyticsState.OptedOut);
    await otherTab.setState(AnalyticsState.Anonymous);
    answer?.(204);
    await harness.clock.advance(0);
    await otherTab.track("b");
    await otherTab.flush();

    // The intake stored a with the first-of-day mark, so b must not take it again, or the day counts twice.
    expect(harness.fetch.events.find((event) => event.name === "b")?.first).toBeUndefined();
  });

  it("gives back the marks taken before a write of the session failed, so installed still goes", async () => {
    const memory = newMemoryStorage();
    let isFailing = true;
    const storage: StorageAdapter = {
      get: (key) => memory.get(key),
      set: async (key, value) => {
        if (isFailing && key === storageKey("session")) {
          isFailing = false;
          throw new Error("quota");
        }
        await memory.set(key, value);
      },
    };
    const harness = newHarness({ storage });

    await harness.collector.installed();
    await harness.collector.installed();
    await harness.settle();

    expect(harness.fetch.events).toEqual([
      expect.objectContaining({ name: "installed", first: ALL_PERIODS }),
    ]);
    expect(harness.errors).toEqual([new Error("quota")]);
  });

  it("never drops an opted_out for the 20-envelope cap, but the oldest envelope after it", async () => {
    const { harness, outage } = newHarnessWithOutage();
    await harness.collector.track("before");
    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.setState(AnalyticsState.Anonymous);
    for (let index = 0; index < 20; index++) {
      await harness.clock.advance(11 * 60_000);
      await harness.collector.track(`opened_${index}`);
    }

    outage.isDown = false;
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(harness.fetch.eventNames).toEqual([
      "opted_out",
      ...Array.from({ length: 19 }, (_, index) => `opened_${index + 1}`),
    ]);
  });

  it("gives back the marks of an event whose write to the storage failed", async () => {
    const harness = newHarness();
    let isQueueWriteFailing = true;
    const storage: StorageAdapter = {
      get: (key) => harness.storage.get(key),
      set: async (key, value) => {
        if (key === QUEUE_KEY && isQueueWriteFailing) {
          throw new Error("quota");
        }
        await harness.storage.set(key, value);
      },
    };
    const collector = harness.restart({ storage });
    await collector.installed();

    isQueueWriteFailing = false;
    await collector.installed();
    await collector.flush();

    expect(harness.fetch.events).toEqual([
      expect.objectContaining({ name: "installed", first: ALL_PERIODS }),
    ]);
    expect(harness.errors).toEqual([new Error("quota")]);
  });
});

describe("active days", () => {
  it("counts one active day when only one day ever had an event sent, after events of two days were dropped", async () => {
    const harness = newHarness({ getId: () => undefined });
    harness.clock.setLocal("2026-10-29T10:00:00");
    await harness.collector.track("waiting");
    harness.clock.setLocal("2026-10-30T10:00:00");
    await harness.collector.track("next_day");

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.collector.track("after");
    await harness.settle();

    expect((await harness.collector.uninstallParams())?.active_days).toBe("1");
  });

  it("counts the same day once, however many events it had", async () => {
    const harness = newHarness();
    await harness.collector.track("a");
    await harness.collector.track("b");
    harness.clock.setLocal("2026-10-30T10:00:00");
    await harness.collector.track("c");

    expect((await harness.collector.uninstallParams())?.active_days).toBe("2-5");
  });

  it("gives back today as the 21st active day when an opt-out drops its only event before a request", async () => {
    const harness = newHarness();
    for (let day = 1; day <= 20; day++) {
      harness.clock.setLocal(`2026-10-${String(day).padStart(2, "0")}T10:00:00`);
      await harness.collector.track("opened");
      await harness.collector.flush();
    }
    harness.clock.setLocal("2026-10-21T10:00:00");
    await harness.collector.track("opened");

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.setState(AnalyticsState.Anonymous);

    expect((await harness.collector.uninstallParams())?.active_days).toBe("6-20");
  });

  it("keeps all 21 counted days when an opt-out drops the only event of a 22nd day, which was never counted", async () => {
    const harness = newHarness();
    for (let day = 1; day <= 21; day++) {
      harness.clock.setLocal(`2026-10-${String(day).padStart(2, "0")}T10:00:00`);
      await harness.collector.track("opened");
      await harness.collector.flush();
    }
    harness.clock.setLocal("2026-10-22T10:00:00");
    await harness.collector.track("opened");

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.collector.setState(AnalyticsState.Anonymous);

    expect((await harness.collector.uninstallParams())?.active_days).toBe("21+");
  });

  it("gives back the 21st day when its only event is dropped before a request, and counts it once an event goes", async () => {
    const harness = newHarness({ getId: () => undefined, state: AnalyticsState.Anonymous });
    for (let day = 1; day <= 20; day++) {
      harness.clock.setLocal(`2026-10-${String(day).padStart(2, "0")}T10:00:00`);
      await harness.collector.track("opened");
      await harness.collector.flush();
    }
    expect((await harness.collector.uninstallParams())?.active_days).toBe("6-20");

    await harness.collector.setState(AnalyticsState.Identified);
    harness.clock.setLocal("2026-10-21T10:00:00");
    await harness.collector.track("waiting");
    expect((await harness.collector.uninstallParams())?.active_days).toBe("21+");
    await harness.collector.setState(AnalyticsState.Anonymous);
    expect((await harness.collector.uninstallParams())?.active_days).toBe("6-20");

    harness.clock.setLocal("2026-10-22T10:00:00");
    await harness.collector.track("opened");
    expect((await harness.collector.uninstallParams())?.active_days).toBe("21+");
    harness.clock.setLocal("2026-10-23T10:00:00");
    await harness.collector.track("opened");
    expect((await harness.collector.uninstallParams())?.active_days).toBe("21+");
  });

  it.each([
    ["an object", '{"day":1}'],
    ["text that does not parse", "[2026"],
    ["a list of what are not days", "[null,7]"],
  ])("reads stored active days that are %s as none", async (_, stored) => {
    const harness = newHarness();
    await harness.storage.set(storageKey("active_days"), stored);

    await harness.collector.track("opened");

    expect((await harness.collector.uninstallParams())?.active_days).toBe("1");
  });

  it("reads a stored value that is not a list of days as no days", async () => {
    const harness = newHarness();
    await harness.storage.set(storageKey("active_days"), "5");

    await harness.collector.track("opened");

    expect((await harness.collector.uninstallParams())?.active_days).toBe("1");
  });
});

describe("marks of envelopes no request carried", () => {
  it("gives back the marks of an event that went stale before any request, but not a mark a later event took", async () => {
    const harness = newHarness();
    // Sunday 1 Nov 2026 closes an ISO week and opens a month. The clock jumps without firing the send timer.
    harness.clock.setLocal("2026-11-01T10:00:00");
    await harness.collector.track("sunday");
    harness.clock.setLocal("2026-11-02T10:00:00");
    await harness.collector.track("monday");

    harness.clock.setLocal("2026-11-03T10:00:00");
    await harness.collector.flush();
    await harness.collector.track("tuesday");
    await harness.collector.flush();

    expect(harness.fetch.events.map((event) => [event.name, event.first])).toEqual([
      ["monday", ["day", "week"]],
      // The Sunday event never went, so its month, quarter and year marks go back. Monday took the week.
      ["tuesday", ["day", "month", "quarter", "year"]],
    ]);
  });

  it("gives back the marks of a forgotten user's envelope that went in a request, since the intake deletes its events", async () => {
    const { harness, outage } = newHarnessWithOutage({ getId: () => "alice" });
    await harness.collector.installed();
    await harness.settle();

    outage.isDown = false;
    await harness.collector.forget("alice");
    await harness.collector.installed();
    await harness.clock.advance(MAX_RETRY_DELAY_MS);

    expect(harness.fetch.events.map((event) => [event.name, event.first])).toEqual([
      ["installed", ALL_PERIODS],
    ]);
  });
});

describe("active days after the clock was set back", () => {
  it("counts a day once when the clock goes back to it", async () => {
    const harness = newHarness();
    for (const day of ["01", "02", "03", "04", "05"]) {
      harness.clock.setLocal(`2026-10-${day}T10:00:00`);
      await harness.collector.track("opened");
    }

    harness.clock.setLocal("2026-10-01T12:00:00");
    await harness.collector.track("opened");

    expect((await harness.collector.uninstallParams())?.active_days).toBe("2-5");
  });
});
