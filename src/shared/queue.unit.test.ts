import { describe, expect, it } from "vitest";
import { newQueue } from "./queue.js";
import { newMemoryStorage } from "./storage.js";
import { KEY, VERSION } from "#tests/harness.js";

/** The name the queue keeps its envelopes under, in the storage `newChannelStorage` gives it. */
const QUEUE_KEY = "queue";

const FIELDS = {
  key: KEY,
  platform: "extension",
  version: VERSION,
  session: "k3j9x2m1qa0b",
} as const;
const EVENT = { name: "a", day: "2026-10-29" };
const FIRST_LEASE = { holder: "first", now: 0, until: 60_000 };

function newTestQueue(storage = newMemoryStorage()): ReturnType<typeof newQueue> {
  return newQueue({
    storage,
    random: { bytes: (count) => crypto.getRandomValues(new Uint8Array(count)) },
    reportError: () => undefined,
  });
}

describe("leases", () => {
  it("keeps the lease another holder took after ours ran out when we release", async () => {
    const queue = newTestQueue();
    await queue.add(FIELDS, EVENT);
    const [ours] = await queue.lease(FIRST_LEASE);
    await queue.lease({ holder: "second", now: 61_000, until: 121_000 });

    await queue.release("first", [ours?.qid ?? ""]);

    expect(await queue.lease({ holder: "third", now: 62_000, until: 122_000 })).toHaveLength(0);
  });

  it("refuses to seal an envelope another holder took after our lease ran out", async () => {
    const queue = newTestQueue();
    await queue.add(FIELDS, EVENT);
    const [ours] = await queue.lease(FIRST_LEASE);
    await queue.lease({ holder: "second", now: 61_000, until: 121_000 });

    expect(
      await queue.seal(ours?.qid ?? "", { holder: "first", now: 62_000, until: 122_000 }),
    ).toBeUndefined();
  });
});

describe("stored queue", () => {
  it("skips an item without a queue id, whatever its envelope", async () => {
    const storage = newMemoryStorage();
    const queue = newTestQueue(storage);
    await storage.set(QUEUE_KEY, JSON.stringify([{ envelope: { ...FIELDS, events: [EVENT] } }]));

    expect(await queue.lease(FIRST_LEASE)).toEqual([]);
  });
});

describe("opted_out", () => {
  const OPT_OUT = { name: "opted_out", day: "2026-10-29" };

  it.each([
    ["joins no envelope with the same fields", [EVENT, OPT_OUT]],
    ["takes no event into its envelope", [OPT_OUT, EVENT]],
  ])("%s", async (_, events) => {
    const queue = newTestQueue();
    for (const event of events) {
      await queue.add(FIELDS, event);
    }

    const leased = await queue.lease(FIRST_LEASE);

    expect(leased.map((item) => item.envelope.events)).toEqual(events.map((event) => [event]));
  });
});
