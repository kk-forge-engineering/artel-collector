import { describe, expect, it } from "vitest";
import type { EventParams } from "./exports.js";
import { newHarness, USER_ID } from "../tests/harness.js";
import { fromUntypedHost } from "../tests/untypedHost.js";

/** Tracks one event and returns the names sent and the messages reported. */
async function tracked(
  name: string,
  params?: EventParams,
): Promise<{ sent: string[]; errors: string[] }> {
  const harness = newHarness();
  await harness.collector.track(name, params);
  await harness.settle();
  return { sent: harness.fetch.eventNames, errors: harness.errors.map((error) => String(error)) };
}

describe("the params of a system event", () => {
  it.each([
    ["page_view", { from: "menu" }],
    ["welcome_opened", { step: 1 }],
    ["install_click", { other: "x" }],
    ["install_click", { product: 3 }],
    ["uninstalled", { age_days: -1 }],
    ["uninstalled", { age_days: 1.5 }],
    ["uninstalled", { age_days: "3" }],
    ["uninstalled", { active_days: "3" }],
    ["uninstalled", { active_days: 1 }],
    ["uninstalled", { reason: "slow" }],
  ])("refuses and reports %s with %j", async (name, params) => {
    const { sent, errors } = await tracked(name, fromUntypedHost<EventParams>(params));

    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it.each([
    ["page_view", undefined],
    ["page_view", {}],
    ["welcome_opened", undefined],
    ["install_click", { product: "editor" }],
    ["uninstalled", { age_days: 0, active_days: "0" }],
    ["uninstalled", { age_days: 400, active_days: "21+" }],
    ["uninstalled", { active_days: "2-5" }],
    ["uninstalled", { active_days: "6-20" }],
    ["uninstalled", { age_days: 7, active_days: "1" }],
  ])("takes %s with %j", async (name, params) => {
    const { sent, errors } = await tracked(name, params);

    expect(sent).toEqual([name]);
    expect(errors).toEqual([]);
  });
});

describe("the report of a refused param", () => {
  it.each([
    [
      "report_exported",
      { Format: "pdf" },
      "whose name is not a lowercase letter, then lowercase letters, digits and _, up to 40 characters",
    ],
    [
      "report_exported",
      { pages: Number.NaN },
      "that is not a string, a boolean or a finite number",
    ],
    ["report_exported", { source: "x".repeat(65) }, "past 64 characters"],
    ["page_view", { from: "menu" }, "that page_view does not take"],
    ["install_click", { product: true }, "that is not a string"],
    ["uninstalled", { age_days: 1.5 }, "that is not a whole number from 0"],
    ["uninstalled", { active_days: "3" }, "that is not one of 0, 1, 2-5, 6-20, 21+"],
  ])("names the rule that %s with %j breaks", async (name, params, rule) => {
    const { errors } = await tracked(name, fromUntypedHost<EventParams>(params));

    const [param] = Object.keys(params);
    expect(errors).toEqual([
      `Error: artel: event ${JSON.stringify(name)} has a param ${JSON.stringify(param)} ${rule}, so it was not tracked`,
    ]);
  });
});

describe("the report of a param with a long name", () => {
  it("quotes at most 64 characters of the name, so a name that holds an address reaches onError cut", async () => {
    const name = `${"a".repeat(4_990)}@corp.example`;

    const { errors } = await tracked(
      "report_exported",
      fromUntypedHost<EventParams>({ [name]: 1 }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("@corp.example");
    expect(errors[0]?.length).toBeLessThan(300);
  });
});

describe("a name outside TypeScript", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  it.each([
    ["a bigint", 10n],
    ["a symbol", Symbol("event")],
    ["a circular object", circular],
  ])("resolves and reports a name that is %s", async (_, name) => {
    const harness = newHarness();

    await expect(harness.collector.track(fromUntypedHost(name))).resolves.toBeUndefined();
    expect(harness.errors).toHaveLength(1);
  });

  it.each([
    ["bigint", 10n],
    ["symbol", Symbol("event")],
    ["object", circular],
  ])("names a name JSON cannot write by its type, %s, in the report", async (type, name) => {
    const harness = newHarness();

    await harness.collector.track(fromUntypedHost(name));

    expect(harness.errors).toEqual([
      new Error(`artel: event ${type} has a name the intake does not take, so it was not tracked`),
    ]);
  });
});

describe("reading the params", () => {
  it("queues the params as track read them, so a later change of the object reaches neither the check nor the event", async () => {
    const harness = newHarness();
    await harness.collector.track("first");
    const params: Record<string, string> = { query: "ok" };

    const tracking = harness.collector.track("second", params);
    params.query = "alice@example.com";
    await tracking;
    await harness.settle();

    expect(harness.fetch.events.map((event) => [event.name, event.params])).toEqual([
      ["first", undefined],
      ["second", { query: "ok" }],
    ]);
    expect(harness.errors).toEqual([]);
  });

  it("reads each param once, and checks and queues that one read", async () => {
    const harness = newHarness();
    const reads: string[] = ["ok", "alice@example.com"];
    let count = 0;
    const params = {
      get query(): string {
        count++;
        return reads.shift() ?? "alice@example.com";
      },
    };

    await harness.collector.track("search", params);
    await harness.settle();

    expect(count).toBe(1);
    expect(harness.fetch.events.map((event) => [event.name, event.params])).toEqual([
      ["search", { query: "ok" }],
    ]);
    expect(harness.errors).toEqual([]);
  });

  it.each([
    [
      "a getter that throws",
      {
        get boom(): string {
          throw new Error("getter");
        },
      },
    ],
    [
      "a proxy whose keys throw",
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("getter");
          },
        },
      ),
    ],
  ])("resolves and reports params with %s, and records nothing", async (_, params) => {
    const harness = newHarness();

    await expect(harness.collector.track("a", params)).resolves.toBeUndefined();
    await harness.settle();

    expect(harness.fetch.requests).toEqual([]);
    expect(harness.errors).toEqual([new Error("getter")]);
  });
});

describe("the age a tracked uninstalled carries", () => {
  it.each([
    ["anonymous", 417, 30, undefined],
    ["anonymous", 5, 2, undefined],
    ["identified", 417, 31, () => USER_ID],
    ["identified", 5, 5, () => USER_ID],
  ])("goes in the %s state as an envelope age: %i days as %i", async (_, age, sent, getId) => {
    const harness = newHarness({ ...(getId !== undefined && { getId }) });

    await harness.collector.track("uninstalled", { age_days: age, active_days: "21+" });
    await harness.settle();

    expect(harness.fetch.events.map((event) => event.params)).toEqual([
      { age_days: sent, active_days: "21+" },
    ]);
  });

  it("leaves an age_days param of another event as the product gave it", async () => {
    const harness = newHarness();

    await harness.collector.track("report_exported", { age_days: 417 });
    await harness.settle();

    expect(harness.fetch.events.map((event) => event.params)).toEqual([{ age_days: 417 }]);
  });
});
