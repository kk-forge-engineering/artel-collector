import { describe, expect, it } from "vitest";
import {
  AnalyticsState,
  Mode,
  newCollector,
  newMemoryStorage,
  Platform,
  type Browser,
  type CollectorOptions,
  type StorageAdapter,
} from "./exports.js";
import { fromUntypedHost } from "../tests/untypedHost.js";
import { newHarness, USER_ID, VERSION } from "../tests/harness.js";

const SIXTEEN_PARAMS = Object.fromEntries(
  Array.from({ length: 16 }, (_, index) => [`p${index}`, index]),
);

describe("the events track takes", () => {
  it.each([
    ["installed", "installed"],
    ["updated", "updated"],
    ["opted_out", "opted_out"],
    ["a name with a capital", "Report"],
    ["a name with a capital after its first letter", "reportExported"],
    ["a name with a hyphen", "report-exported"],
    ["a name that starts with a digit", "1report"],
    ["an empty name", ""],
    ["a name past 40 characters", "a".repeat(41)],
    ["a name that is not a string", fromUntypedHost<string>(42)],
    ["a name that is a list of one valid name", fromUntypedHost<string>(["report"])],
  ])("refuses and reports %s", async (_, name) => {
    const harness = newHarness();

    await harness.collector.track(name);
    await harness.settle();

    expect(harness.fetch.requests).toEqual([]);
    expect(harness.errors).toHaveLength(1);
  });

  it.each([
    ["more than 16 params", { ...SIXTEEN_PARAMS, p16: 16 }],
    ["a param name with a capital", { Format: "pdf" }],
    ["a param name past 40 characters", { ["p".repeat(41)]: 1 }],
    ["a string past 64 characters", { source: "😀".repeat(65) }],
    ["NaN, which JSON would send as null", { pages: Number.NaN }],
    ["Infinity", { pages: Number.POSITIVE_INFINITY }],
    [
      "a value that is an object",
      fromUntypedHost<Record<string, string>>({ nested: { deep: true } }),
    ],
    ["params that are a list", fromUntypedHost<Record<string, string>>(["a"])],
    ["params that are an empty list", fromUntypedHost<Record<string, string>>([])],
    ["params that are null", fromUntypedHost<Record<string, string>>(JSON.parse("null"))],
  ])("refuses and reports an event with %s", async (_, params) => {
    const harness = newHarness();

    await harness.collector.track("report_exported", params);
    await harness.settle();

    expect(harness.fetch.requests).toEqual([]);
    expect(harness.errors).toHaveLength(1);
  });

  it("refuses a name that is undefined before it is queued, so the events beside it still go", async () => {
    const harness = newHarness();

    await harness.collector.track(fromUntypedHost<string>(undefined));
    await harness.collector.track("opened");
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(["opened"]);
    expect(harness.errors).toHaveLength(1);
  });

  it("takes an event at the limits: page_view, 16 params and a string of 64 characters", async () => {
    const harness = newHarness();
    const params = { ...SIXTEEN_PARAMS, p0: "😀".repeat(64), p15: true };

    await harness.collector.track("page_view");
    await harness.collector.track(`a${"_".repeat(39)}`, params);
    await harness.settle();

    expect(harness.fetch.eventNames).toEqual(["page_view", `a${"_".repeat(39)}`]);
    expect(harness.errors).toEqual([]);
  });
});

describe("the channel key", () => {
  it.each([
    ["extension-test-aa131n3j11", Platform.Extension],
    ["site-aa131n3j11", Platform.Web],
    ["site-test-0123456789", Platform.Web],
    ["desktop-aa131n3j11", Platform.MacOs],
    ["desktop-aa131n3j11", Platform.Windows],
    ["desktop-test-aa131n3j11", Platform.Linux],
  ])("sends with key %s on platform %s", async (key, platform) => {
    const harness = newHarness({ key, platform });

    await harness.collector.track("report_exported");
    await harness.settle();

    expect(harness.fetch.requests.map((request) => request.envelope.key)).toEqual([key]);
    expect(harness.errors).toEqual([]);
  });
});

describe("a host outside TypeScript", () => {
  it("reads a storage that gives null for a missing key as one that gives nothing", async () => {
    const harness = newHarness({ getId: () => USER_ID });
    const storage: StorageAdapter = {
      get: async (key) =>
        (await harness.storage.get(key)) ?? fromUntypedHost<undefined>(JSON.parse("null")),
      set: (key, value) => harness.storage.set(key, value),
    };
    const collector = harness.restart({ storage });

    await collector.installed();
    await collector.track("report_exported");
    await harness.settle();

    expect(harness.fetch.eventNamesByRequest).toEqual([["installed", "report_exported"]]);
    expect(harness.fetch.requests[0]?.envelope.session).toMatch(/^[\da-z]{12}$/);
  });

  it("resolves when its onError throws", async () => {
    const harness = newHarness();
    const collector = harness.restart({
      onError: () => {
        throw new Error("the host handler failed");
      },
    });

    await expect(collector.track("Not_a_name")).resolves.toBeUndefined();
  });

  it("reports a storage failure that is not an Error as an Error", async () => {
    const harness = newHarness();
    const storage: StorageAdapter = {
      get: async () => {
        throw fromUntypedHost<Error>("quota");
      },
      set: (key, value) => harness.storage.set(key, value),
    };

    await harness.restart({ storage }).track("report_exported");

    expect(harness.errors).toEqual([new Error("quota")]);
  });
});

describe("the browser a host gives as a function", () => {
  it("calls it once, on the first event with an id, and never in the anonymous state", async () => {
    let calls = 0;
    const detect = (): Browser => {
      calls++;
      return { name: "firefox", major: 132 };
    };
    const harness = newHarness({
      getId: () => USER_ID,
      browser: detect,
      state: AnalyticsState.Anonymous,
    });
    await harness.collector.track("anonymous");
    await harness.settle();
    expect(calls).toBe(0);

    await harness.collector.setState(AnalyticsState.Identified);
    await harness.collector.track("identified");
    await harness.collector.track("again");
    await harness.settle();

    expect(calls).toBe(1);
    expect(harness.fetch.requests.map((request) => request.envelope.browser)).toEqual([
      undefined,
      { name: "firefox", major: 132 },
    ]);
  });

  it("reports a function that throws and sends no browser", async () => {
    const harness = newHarness({
      getId: () => USER_ID,
      browser: () => {
        throw new Error("no navigator");
      },
    });

    await harness.collector.track("identified");
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope).not.toHaveProperty("browser");
    expect(harness.errors).toEqual([new Error("no navigator")]);
  });
});

describe("a browser a host outside TypeScript gives", () => {
  it("reports and leaves out a browser that is not an object, and still sends", async () => {
    const harness = newHarness({
      getId: () => USER_ID,
      browser: fromUntypedHost<Browser>("chrome"),
    });

    await harness.collector.track("report_exported");
    await harness.settle();

    expect(harness.fetch.requests.map((request) => request.envelope.browser)).toEqual([undefined]);
    expect(harness.errors).toHaveLength(1);
  });

  it("leaves out a major version that is not a whole number", async () => {
    const harness = newHarness({
      getId: () => USER_ID,
      browser: fromUntypedHost<Browser>({ name: "chrome", major: 1.5 }),
    });

    await harness.collector.track("report_exported");
    await harness.settle();

    expect(harness.fetch.requests.map((request) => request.envelope.browser)).toEqual([
      { name: "chrome" },
    ]);
  });

  it("never reads a browser in an anonymous channel, so a value that is no browser goes unreported", async () => {
    const bodies: string[] = [];
    const errors: Error[] = [];
    const options = {
      key: "extension-aa131n3j11",
      platform: Platform.Extension,
      version: VERSION,
      storage: newMemoryStorage(),
      transport: async (body: string) => (bodies.push(body), 204),
      onError: (error: Error) => errors.push(error),
      mode: Mode.Anonymous,
      browser: "chrome",
    };
    const collector = newCollector(fromUntypedHost<CollectorOptions>(options));

    await collector.track("report_exported");
    await collector.flush();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('"browser"');
    expect(errors).toEqual([]);
  });
});

describe("a bigint a host outside TypeScript gives", () => {
  it("reports a bigint browserLanguage and leaves it out", async () => {
    const harness = newHarness({ browserLanguage: fromUntypedHost<string>(10n) });

    await harness.collector.track("a");
    await harness.settle();

    expect(harness.fetch.requests[0]?.envelope).not.toHaveProperty("browser_language");
    expect(harness.errors).toEqual([
      new Error("artel: browserLanguage bigint is not one the intake takes, left out"),
    ]);
  });

  it("reports a browser function that returns a bigint, leaves the browser out and sends identified events", async () => {
    const harness = newHarness({
      getId: () => USER_ID,
      browser: () => fromUntypedHost<Browser>(10n),
    });

    await harness.collector.track("report_exported");
    await harness.collector.track("report_shared");
    await harness.settle();

    expect(
      harness.fetch.requests.map((request) => [request.envelope.id, request.envelope.browser]),
    ).toEqual([[USER_ID, undefined]]);
    expect(harness.errors).toEqual([new Error("artel: browser bigint is not a browser, left out")]);
  });
});
