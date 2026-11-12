import { describe, expect, it } from "vitest";
import { newHarness, RETRY_AT_KEY } from "../tests/harness.js";

describe("the quote of a planted value in a report", () => {
  it("quotes at most 64 characters of a planted value in a report", async () => {
    const harness = newHarness();
    await harness.storage.set(RETRY_AT_KEY, "x".repeat(100_000));

    await harness.collector.track("a");
    await harness.collector.flush();

    expect(harness.errors).toEqual([
      new Error(
        `artel: the stored retry wait "${"x".repeat(63)}… is no time within five minutes, so the wait is five minutes`,
      ),
    ]);
  });

  it("quotes a planted value whose JSON takes exactly 64 characters whole", async () => {
    const harness = newHarness();
    await harness.storage.set(RETRY_AT_KEY, "x".repeat(62));

    await harness.collector.track("a");
    await harness.collector.flush();

    expect(harness.errors).toEqual([
      new Error(
        `artel: the stored retry wait "${"x".repeat(62)}" is no time within five minutes, so the wait is five minutes`,
      ),
    ]);
  });

  it("quotes at most 64 characters of a planted value that holds characters outside the BMP", async () => {
    const harness = newHarness();
    await harness.storage.set(RETRY_AT_KEY, "\u{1F600}".repeat(100));

    await harness.collector.track("a");
    await harness.collector.flush();

    expect(harness.errors).toEqual([
      new Error(
        `artel: the stored retry wait "${"\u{1F600}".repeat(63)}… is no time within five minutes, so the wait is five minutes`,
      ),
    ]);
  });
});
