import { describe, expect, it } from "vitest";
import { systemClock } from "./exports.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

describe("the system clock", () => {
  it("runs a timer when it falls due", async () => {
    let fired = 0;
    systemClock.setTimeout(() => fired++, 1);
    await wait(20);
    expect(fired).toBe(1);
  });

  it("never runs a timer cancelled before it falls due", async () => {
    let fired = 0;
    const cancel = systemClock.setTimeout(() => fired++, 1);
    cancel();
    await wait(20);
    expect(fired).toBe(0);
  });

  it("takes a cancel after the timer ran, and a second cancel, without a throw", async () => {
    const cancel = systemClock.setTimeout(() => undefined, 1);
    await wait(20);
    expect(() => {
      cancel();
      cancel();
    }).not.toThrow();
  });
});
