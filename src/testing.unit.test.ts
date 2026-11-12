import { describe, expect, expectTypeOf, it } from "vitest";
import { AnalyticsState, Mode } from "./exports.js";
import { newRecordingCollector, queuedEvents, type RecordingCollector } from "./testing.js";
import { KEY, newHarness, QUEUE_KEY } from "../tests/harness.js";
import { fromUntypedHost } from "../tests/untypedHost.js";

describe("newRecordingCollector", () => {
  it("records the events it takes, starting anonymous, and sends nothing", async () => {
    const collector = newRecordingCollector();

    await collector.installed();
    await collector.installed();
    await collector.track("report_exported", { format: "pdf" });
    await collector.flush();

    expect(collector.events).toEqual([
      { name: "installed" },
      { name: "report_exported", params: { format: "pdf" } },
    ]);
    expect(await collector.getState()).toBe("anonymous");
    expect(await collector.uninstallParams()).toBeUndefined();
  });

  it.each([
    ["installed, updated, updated", ["installed", "updated", "updated"], ["installed"]],
    ["updated, updated", ["updated", "updated"], ["updated"]],
  ])(
    "records installed and updated as the real collector sends them of one version: %s",
    async (_, calls, sent) => {
      const recording = newRecordingCollector(Mode.Anonymous);
      const real = newHarness();
      for (const collector of [recording, real.collector]) {
        for (const call of calls) {
          await (call === "installed" ? collector.installed() : collector.updated());
        }
      }
      await real.settle();

      expect(real.fetch.eventNames).toEqual(sent);
      expect(recording.events.map((event) => event.name)).toEqual(sent);
    },
  );

  it("records the one opted_out the real collector sends at the opt-out, then nothing while opted out", async () => {
    const recording = newRecordingCollector(Mode.Anonymous);
    const real = newHarness();
    for (const collector of [recording, real.collector]) {
      await collector.setState(AnalyticsState.OptedOut);
      await collector.setState(AnalyticsState.OptedOut);
      await collector.track("a");
      await collector.installed();
    }
    await real.settle();

    expect(real.fetch.eventNames).toEqual(["opted_out"]);
    expect(recording.events.map((event) => event.name)).toEqual(["opted_out"]);
    expect(await recording.getState()).toBe("opted_out");
  });

  it("records again once the user leaves the opted_out state", async () => {
    const collector = newRecordingCollector();
    await collector.setState(AnalyticsState.OptedOut);

    await collector.setState(AnalyticsState.Anonymous);
    await collector.track("a");

    expect(collector.events.map((event) => event.name)).toEqual(["opted_out", "a"]);
  });

  it("refuses to forget an id the intake refuses, with the same report", async () => {
    const errors: Error[] = [];
    const collector = newRecordingCollector(Mode.Anonymous, {
      onError: (error) => errors.push(error),
    });
    const real = newHarness();

    await collector.forget("");
    await collector.forget("user");
    await real.collector.forget("");

    expect(errors).toEqual(real.errors);
    expect(errors).toHaveLength(1);
  });

  it("refuses an event track refuses, with the same report", async () => {
    const errors: Error[] = [];
    const collector = newRecordingCollector(Mode.Anonymous, {
      onError: (error) => errors.push(error),
    });

    await collector.track("Report", { pages: 1 });
    await collector.track("a", { pages: Number.NaN });

    const harness = newHarness();
    await harness.collector.track("Report", { pages: 1 });
    await harness.collector.track("a", { pages: Number.NaN });
    expect(collector.events).toEqual([]);
    expect(errors).toEqual(harness.errors);
    expect(errors).toHaveLength(2);
  });

  it("drops and refuses tracked events by throttleMs as the real collector does", async () => {
    const real = newHarness();
    const recordingErrors: Error[] = [];
    const recording = newRecordingCollector(Mode.Anonymous, {
      onError: (error) => recordingErrors.push(error),
      clock: real.clock,
    });
    const calls = [
      [0, "undo_pressed", 400],
      [100, "undo_pressed", 400],
      [0, "undo_pressed", undefined],
      [0, "redo_pressed", undefined],
      [0, "redo_pressed", 400],
      [0, "redo_pressed", -1],
      [300, "undo_pressed", 400],
      [0, "undo_pressed", 400],
    ] as const;
    for (const [step, name, throttleMs] of calls) {
      await real.clock.advance(step);
      await recording.track(name, undefined, { throttleMs });
      await real.collector.track(name, undefined, { throttleMs });
    }
    await real.collector.flush();

    expect(recording.events.map((event) => event.name)).toEqual(real.fetch.eventNames);
    expect(recording.events.map((event) => event.name)).toEqual([
      "undo_pressed",
      "undo_pressed",
      "redo_pressed",
      "redo_pressed",
      "undo_pressed",
    ]);
    expect(recordingErrors).toEqual(real.errors);
    expect(recordingErrors).toHaveLength(1);
  });

  it("refuses a state above its mode", async () => {
    const errors: Error[] = [];
    const collector = newRecordingCollector(Mode.Anonymous, {
      onError: (error) => errors.push(error),
    });

    await collector.setState(fromUntypedHost(AnalyticsState.Pseudonymous));

    expect(await collector.getState()).toBe("anonymous");
    expect(errors).toEqual([
      new TypeError('artel: a channel of mode "anonymous" takes no state "pseudonymous"'),
    ]);
  });

  it("is of an anonymous channel by default, as every product today is", async () => {
    const errors: Error[] = [];
    const collector = newRecordingCollector(undefined, { onError: (error) => errors.push(error) });

    await collector.setState(fromUntypedHost(AnalyticsState.Pseudonymous));

    expect(await collector.getState()).toBe("anonymous");
    expect(errors).toHaveLength(1);
    expectTypeOf(newRecordingCollector()).toEqualTypeOf<RecordingCollector<"anonymous">>();
  });
});

describe("queuedEvents", () => {
  it("returns the names and params of the events a collector queued in its storage", async () => {
    const harness = newHarness();
    await harness.collector.track("a", { pages: 2 });
    await harness.collector.track("b");

    expect(await queuedEvents(harness.storage, KEY)).toEqual([
      { name: "a", params: { pages: 2 } },
      { name: "b" },
    ]);
    expect(await queuedEvents(harness.storage, "site-aa131n3j11")).toEqual([]);
  });

  it.each(["{not json", '{"a":1}'])(
    "reads a stored queue %s as empty, and leaves it as it was",
    async (stored) => {
      const harness = newHarness();
      await harness.storage.set(QUEUE_KEY, stored);

      expect(await queuedEvents(harness.storage, KEY)).toEqual([]);
      expect(await harness.storage.get(QUEUE_KEY)).toBe(stored);
    },
  );
});
