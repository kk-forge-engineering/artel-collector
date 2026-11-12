import { describe, expect, it } from "vitest";
import { newMemoryStorage, type StorageAdapter } from "./exports.js";
import { KEY, newHarness, VERSION, storageKey } from "../tests/harness.js";

const DAY = "2026-10-29";
const FIELDS = { key: KEY, platform: "extension", version: VERSION, session: "k3j9x2m1qa0b" };

/** Returns `count` queued envelopes with these fields, each holding `event`, with queue ids from `first` on. */
function queued(count: number, fields: object, event: object, first = 0): object[] {
  return Array.from({ length: count }, (_, index) => ({
    qid: (first + index).toString(16).padStart(16, "0"),
    envelope: { ...fields, events: [event] },
  }));
}

describe("marks after a failure while recording", () => {
  it("keeps an install mark it never took when reading the mark fails", async () => {
    const memory = newMemoryStorage();
    let failsRead = false;
    const storage: StorageAdapter = {
      get: async (key) => {
        if (failsRead && key === storageKey("installed")) {
          failsRead = false;
          throw new Error("storage read failed");
        }
        return memory.get(key);
      },
      set: (key, value) => memory.set(key, value),
    };
    await memory.set(storageKey("installed"), "1");
    await memory.set(storageKey("version"), VERSION);
    const harness = newHarness({ storage });

    failsRead = true;
    await harness.collector.installed();
    await harness.collector.installed();
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual([]);
  });

  it("keeps the marks of an event already in the queue when the give-back of the cap drop fails", async () => {
    const memory = newMemoryStorage();
    let failsOnce = true;
    const storage: StorageAdapter = {
      get: (key) => memory.get(key),
      set: async (key, value) => {
        if (failsOnce && key === storageKey("installed") && value === "") {
          failsOnce = false;
          throw new Error("storage write failed");
        }
        await memory.set(key, value);
      },
    };
    // Twenty envelopes wait, the oldest an installed no request carried. The next new envelope pushes it out.
    const fields = { ...FIELDS, browser_language: "pt", ui_language: "zh" };
    const planted = [
      ...queued(1, fields, { name: "installed", day: DAY }),
      ...queued(19, fields, { name: "b", day: DAY }, 1),
    ];
    await memory.set(storageKey("queue"), JSON.stringify(planted));
    const harness = newHarness({ storage });

    await harness.collector.track("a");
    await harness.collector.track("c");
    await harness.collector.flush();
    await harness.settle();

    const firstOfDay = harness.fetch.events.filter(
      (event) => event.first?.includes("day") === true,
    );
    expect(firstOfDay.map((event) => event.name)).toEqual(["a"]);
    expect(harness.errors).toContainEqual(new Error("storage write failed"));
  });

  it("sends installed later when taking the install mark fails at the write of the version", async () => {
    const memory = newMemoryStorage();
    let failsOnce = true;
    const storage: StorageAdapter = {
      get: (key) => memory.get(key),
      set: async (key, value) => {
        if (failsOnce && key === storageKey("version")) {
          failsOnce = false;
          throw new Error("storage write failed");
        }
        await memory.set(key, value);
      },
    };
    const harness = newHarness({ storage });

    await harness.collector.installed();
    await harness.collector.installed();
    await harness.collector.flush();

    expect(harness.fetch.eventNames).toEqual(["installed"]);
  });
});
