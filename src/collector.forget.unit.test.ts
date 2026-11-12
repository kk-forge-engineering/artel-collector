import { describe, expect, it, vi } from "vitest";
import { AnalyticsState, Mode, newCollector, newMemoryStorage, Platform } from "./exports.js";
import { FakeClock } from "../tests/fakeClock.js";
import { FakeFetch } from "../tests/fakeFetch.js";
import {
  ENDPOINT,
  FORGET_URL,
  KEY,
  newHarness,
  storageKey,
  USER_ID,
  VERSION,
} from "../tests/harness.js";
import { fromUntypedHost } from "../tests/untypedHost.js";

const LAST_ID_KEY = storageKey("last_id");

describe("leaving a state with an id", () => {
  it.each([AnalyticsState.Anonymous, AnalyticsState.OptedOut])(
    "asks the intake to forget the install id on a change to %s, and deletes it",
    async (next) => {
      const harness = newHarness({ mode: Mode.Pseudonymous });
      await harness.collector.track("a");
      await harness.settle();
      const installId = harness.fetch.requests[0]?.envelope.id;

      await harness.collector.setState(next);

      expect(harness.fetch.forgets).toEqual([{ url: FORGET_URL, key: KEY, id: installId }]);
      expect(await harness.storage.get(storageKey("install_id"))).toBe("");
    },
  );

  it("asks the intake to forget the last account id on a change to anonymous", async () => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.collector.track("a");

    await harness.collector.setState(AnalyticsState.Anonymous);

    expect(harness.fetch.forgets).toEqual([{ url: FORGET_URL, key: KEY, id: USER_ID }]);
    expect(harness.fetch.requests).toEqual([]);
  });

  it("asks for nothing when getId never gave an id", async () => {
    const harness = newHarness({ getId: () => undefined });
    await harness.collector.track("a");

    await harness.collector.setState(AnalyticsState.Anonymous);
    await harness.settle();

    expect(harness.fetch.forgets).toEqual([]);
  });

  it("asks for nothing when the host already forgot the last id", async () => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.collector.track("a");
    await harness.collector.forget(USER_ID);

    await harness.collector.setState(AnalyticsState.Anonymous);

    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual([USER_ID]);
  });

  it("finishes a change a stopped run left, as the first call of the next run", async () => {
    const harness = newHarness({ getId: () => USER_ID, state: AnalyticsState.Anonymous });
    await harness.storage.set(LAST_ID_KEY, USER_ID);

    await harness.collector.track("a");
    await harness.settle();

    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual([USER_ID]);
    expect(await harness.storage.get(LAST_ID_KEY)).toBe("");
  });

  it.each([
    ["as given", ENDPOINT, FORGET_URL],
    ["with a trailing slash", `${ENDPOINT}/`, FORGET_URL],
    [
      "with a query, which it keeps as the envelopes do",
      `${ENDPOINT}?region=eu`,
      `${FORGET_URL}?region=eu`,
    ],
    ["with a trailing slash and a query", `${ENDPOINT}/?region=eu`, `${FORGET_URL}?region=eu`],
    ["with several trailing slashes", `${ENDPOINT}///`, FORGET_URL],
    [
      "under a long path",
      `https://intake.example.com/${"a/".repeat(500)}v1/public/relay`,
      `https://intake.example.com/${"a/".repeat(500)}v1/public/forget`,
    ],
    ["at the root", "https://intake.example.com/", "https://intake.example.com/forget"],
  ])(
    "posts the forget to the forget address of the endpoint %s",
    async (_case, endpoint, forgetUrl) => {
      const fetch = new FakeFetch();
      vi.stubGlobal("fetch", fetch.fetch);
      const collector = newCollector({
        key: KEY,
        platform: Platform.Extension,
        version: VERSION,
        storage: newMemoryStorage(),
        clock: new FakeClock("2026-10-29T10:00:00"),
        endpoint,
        mode: Mode.Pseudonymous,
      });
      await collector.setState(AnalyticsState.Pseudonymous);
      await collector.track("a");
      await collector.flush();

      await collector.setState(AnalyticsState.Anonymous);

      expect(fetch.requests.map((request) => request.url)).toEqual([endpoint]);
      expect(fetch.forgets.map((forget) => forget.url)).toEqual([forgetUrl]);
    },
  );
});

describe("forget(id)", () => {
  it("asks the intake to forget the id, after the request in flight that may carry it", async () => {
    const harness = newHarness({ getId: () => USER_ID });
    await harness.collector.track("a");
    await harness.settle();

    await harness.collector.forget(USER_ID);

    expect(harness.fetch.forgets).toEqual([{ url: FORGET_URL, key: KEY, id: USER_ID }]);
  });

  it.each([
    ["empty", ""],
    ["past 64 characters", "é".repeat(65)],
    ["no string, from a host outside TypeScript", fromUntypedHost<string>(42)],
  ])("refuses an id that is %s, which the intake would refuse", async (_case, id) => {
    const harness = newHarness({ getId: () => USER_ID });

    await harness.collector.forget(id);
    await harness.settle();

    expect(harness.fetch.forgets).toEqual([]);
    expect(harness.errors).toEqual([
      new TypeError("artel: forget takes an id of 1 to 64 characters"),
    ]);
  });

  it("takes an id of 64 characters", async () => {
    const harness = newHarness({ getId: () => USER_ID });

    await harness.collector.forget("é".repeat(64));

    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual(["é".repeat(64)]);
  });
});

describe("a forget with a test key", () => {
  it("drops the id and its events here, and asks the intake nothing, since it answers a test key 403", async () => {
    const harness = newHarness({ getId: () => USER_ID, key: "extension-test-aa131n3j11" });
    await harness.collector.track("a");

    await harness.collector.forget(USER_ID);
    await harness.settle();

    expect([harness.fetch.forgets, harness.fetch.requests, harness.errors]).toEqual([[], [], []]);
    expect(await harness.storage.get(storageKey("last_id", "extension-test-aa131n3j11"))).not.toBe(
      USER_ID,
    );
  });
});

describe("the stored forget requests", () => {
  it("stores the id alone, and sends it with the channel key of the collector", async () => {
    const harness = newHarness({ getId: () => USER_ID });
    harness.fetch.failNextWithNetworkError();

    await harness.collector.forget(USER_ID);

    expect(await harness.storage.get(storageKey("forgets"))).toBe(JSON.stringify([USER_ID]));
  });

  it("sends a planted entry only as an id under its own key, and skips one the intake would refuse", async () => {
    const harness = newHarness();
    const planted = '{"key":"site-zz131n3j11","id":"victim"}';
    await harness.storage.set(storageKey("forgets"), JSON.stringify(["x".repeat(65), planted]));

    await harness.collector.flush();

    expect(harness.fetch.forgets).toEqual([{ url: FORGET_URL, key: KEY, id: planted }]);
    expect(await harness.storage.get(storageKey("forgets"))).toBe("[]");
  });
});

describe("the answer to a forget", () => {
  it("reports a 403 once and never sends it again", async () => {
    const harness = newHarness({ getId: () => USER_ID });
    harness.fetch.respondNextWith(403);

    await harness.collector.forget(USER_ID);
    await harness.clock.advance(10 * 60_000);
    await harness.collector.flush();

    expect(harness.fetch.forgets).toHaveLength(1);
    expect(harness.errors).toEqual([new Error("artel: intake answered 403 to a forget")]);
  });

  it("sends it again after the wait a 429 asks for, and keeps it across a restart", async () => {
    const harness = newHarness({ getId: () => USER_ID });
    harness.fetch.respondNextWith(429, 1, { "Retry-After": "30" });

    await harness.collector.forget(USER_ID);
    await harness.clock.advance(29_000);
    expect(harness.fetch.forgets).toHaveLength(1);

    await harness.clock.advance(1_000);
    await harness.restart().flush();

    expect(harness.fetch.forgets).toHaveLength(2);
    expect(harness.errors).toEqual([]);
  });

  it("stores one request for an id forgotten twice before the intake answered", async () => {
    const harness = newHarness({ getId: () => USER_ID });
    harness.fetch.failNextWithNetworkError();
    await harness.collector.forget(USER_ID);

    await harness.collector.forget(USER_ID);
    await harness.settle();

    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual([USER_ID, USER_ID]);
  });

  it("keeps a forget that an opt-out follows", async () => {
    const harness = newHarness({ getId: () => USER_ID });
    harness.fetch.failNextWithNetworkError();
    await harness.collector.forget(USER_ID);

    await harness.collector.setState(AnalyticsState.OptedOut);
    await harness.settle();

    expect(harness.fetch.forgets.map((forget) => forget.id)).toEqual([USER_ID, USER_ID]);
    expect(harness.fetch.eventNames).toEqual(["opted_out"]);
  });

  it.each(['{"id":1}', "not json", "[1]"])(
    "reads a stored list of forgets %s as empty",
    async (stored) => {
      const harness = newHarness();
      await harness.storage.set(storageKey("forgets"), stored);

      await harness.collector.flush();

      expect(harness.fetch.forgets).toEqual([]);
    },
  );
});
