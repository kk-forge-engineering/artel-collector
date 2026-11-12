import { describe, expect, it, vi } from "vitest";
import { newDesktopCollector, type DesktopCollectorOptions } from "./desktop.js";
import { newMemoryStorage } from "./exports.js";
import { FakeFetch } from "../tests/fakeFetch.js";
import { stubListenedPage } from "../tests/fakePage.js";
import { DESKTOP_KEY, ENDPOINT, USER_ID, VERSION } from "../tests/harness.js";
import { fromUntypedHost } from "../tests/untypedHost.js";

const OPTIONS = {
  key: DESKTOP_KEY,
  version: VERSION,
  endpoint: ENDPOINT,
  platform: "macos",
} as const;

/**
 * Stubs a webview with `localStorage`, Web Locks and the language `de-DE`, and returns the stored items, the names of
 * the locks taken and the network the collector posts to.
 */
function stubWebview(): { items: Map<string, string>; lockNames: string[]; fetch: FakeFetch } {
  const items = new Map<string, string>();
  const lockNames: string[] = [];
  const fetch = new FakeFetch();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key),
    setItem: (key: string, value: string) => items.set(key, value),
  });
  vi.stubGlobal("navigator", {
    language: "de-DE",
    locks: {
      request: async (name: string, operation: () => Promise<unknown>) => (
        lockNames.push(name),
        operation()
      ),
    },
  });
  vi.stubGlobal("fetch", fetch.fetch);
  return { items, lockNames, fetch };
}

describe("newDesktopCollector", () => {
  it("adds no listener to the window: a send at hide would not finish before the window is gone", async () => {
    stubWebview();
    const listened = stubListenedPage();

    const collector = newDesktopCollector({ ...OPTIONS, mode: "anonymous" });

    expect(listened).toEqual([]);
    // The collector reads `localStorage` when it runs, so its start must end before the next test stubs another one.
    await collector.getState();
  });

  it("sends installed on its first start and updated on the first start of another version", async () => {
    const { fetch } = stubWebview();

    await newDesktopCollector({ ...OPTIONS, mode: "anonymous" }).flush();
    await newDesktopCollector({ ...OPTIONS, mode: "anonymous" }).flush();
    await newDesktopCollector({ ...OPTIONS, version: "4.3.0", mode: "anonymous" }).flush();

    expect(fetch.eventNames).toEqual(["installed", "updated"]);
  });

  it("sends its platform and the primary browser language, over localStorage and Web Locks", async () => {
    const { items, lockNames, fetch } = stubWebview();
    const usage = newDesktopCollector({ ...OPTIONS, mode: "anonymous" });

    await usage.track("report_exported");
    await usage.flush();

    const envelope = fetch.requests[0]?.envelope;
    expect(envelope).toMatchObject({
      key: DESKTOP_KEY,
      platform: "macos",
      version: VERSION,
      browser_language: "de",
    });
    expect(envelope).not.toHaveProperty("ui_language");
    expect(envelope).not.toHaveProperty("browser");
    expect(fetch.events[0]).not.toHaveProperty("page");
    expect([items.has(`artel.${DESKTOP_KEY}.queue`), lockNames.includes("artel")]).toEqual([
      true,
      true,
    ]);
  });

  it("sends the id, the full languages and no browser once the user is identified", async () => {
    const { fetch } = stubWebview();
    const usage = newDesktopCollector({
      ...OPTIONS,
      platform: "windows",
      mode: "identified",
      getId: () => USER_ID,
      uiLanguage: "fr-CA",
    });

    await usage.setState("identified");
    await usage.track("report_exported");
    await usage.flush();

    const envelope = fetch.requests.at(-1)?.envelope;
    expect(envelope).toMatchObject({
      platform: "windows",
      id: USER_ID,
      browser_language: "de-DE",
      ui_language: "fr-CA",
    });
    expect(envelope).not.toHaveProperty("browser");
  });

  it("takes the storage, lock and language it is given, and reads neither localStorage nor navigator", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("navigator", undefined);
    const fetch = new FakeFetch();
    vi.stubGlobal("fetch", fetch.fetch);
    const locked: string[] = [];
    const errors: Error[] = [];
    const usage = newDesktopCollector({
      ...OPTIONS,
      platform: "linux",
      mode: "anonymous",
      storage: newMemoryStorage(),
      lock: async (operation) => (locked.push("own"), operation()),
      browserLanguage: "en-GB",
      onError: (error) => errors.push(error),
    });

    await usage.track("report_exported");
    await usage.flush();

    expect(fetch.requests[0]?.envelope).toMatchObject({
      platform: "linux",
      browser_language: "en",
    });
    expect([locked.length > 0, errors]).toEqual([true, []]);
  });

  it.each([
    [
      "no platform",
      { platform: undefined },
      "artel: platform undefined is not one the intake takes",
    ],
    ["no version", { version: undefined }, "artel: version undefined is not one the intake takes"],
    [
      "a site key",
      { key: "site-aa131n3j11" },
      "artel: a key of kind site does not take platform macos",
    ],
  ])("throws a TypeError for %s", (_, overrides, message) => {
    stubWebview();

    expect(() =>
      newDesktopCollector(
        fromUntypedHost<DesktopCollectorOptions>({ ...OPTIONS, mode: "anonymous", ...overrides }),
      ),
    ).toThrow(new TypeError(message));
  });

  it("throws where navigator is missing, unless the options pass browserLanguage", () => {
    vi.stubGlobal("navigator", undefined);

    expect(() =>
      newDesktopCollector({ ...OPTIONS, mode: "anonymous", storage: newMemoryStorage() }),
    ).toThrow(TypeError);
  });
});
