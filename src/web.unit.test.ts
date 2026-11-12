import { describe, expect, it, vi } from "vitest";
import { newMemoryStorage } from "./exports.js";
import { newLocalStorageAdapter, newWebCollector, pageFields, newWebLock } from "./web.js";
import { FakeFetch } from "../tests/fakeFetch.js";
import { FakeDocument, stubListenedPage } from "../tests/fakePage.js";
import { ENDPOINT, USER_ID, SITE_KEY } from "../tests/harness.js";

/** The part of the Web Storage API the adapter uses, over a Map. */
class FakeWebStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    // oxlint-disable-next-line unicorn/no-null -- Web Storage answers null for a missing key, and so does this fake.
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** A visible document with a referrer, which a test can hide. */
describe("newLocalStorageAdapter", () => {
  it("keeps values in localStorage and answers undefined for a missing key", async () => {
    const webStorage = new FakeWebStorage();
    vi.stubGlobal("localStorage", webStorage);
    const storage = newLocalStorageAdapter();

    await storage.set("artel.session", "k3j9x2m1qa0b");

    expect(await storage.get("artel.session")).toBe("k3j9x2m1qa0b");
    expect(await storage.get("artel.missing")).toBeUndefined();
    expect(webStorage.items.get("artel.session")).toBe("k3j9x2m1qa0b");
  });

  it("rejects where there is no localStorage, so the collector reports it", async () => {
    vi.stubGlobal("localStorage", undefined);

    await expect(newLocalStorageAdapter().get("artel.session")).rejects.toThrow(TypeError);
  });
});

describe("newWebLock", () => {
  it("runs the operation under the origin-wide lock named artel", async () => {
    const names: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: async (name: string, operation: () => Promise<unknown>) => (
          names.push(name),
          operation()
        ),
      },
    });

    await expect(newWebLock()(async () => "done")).resolves.toBe("done");
    expect(names).toEqual(["artel"]);
  });

  it.each([
    ["no Web Locks", {}],
    // This row covers test DOMs such as happy-dom, which set `locks` to null.
    ["Web Locks set to null", { locks: JSON.parse("null") }],
    ["Web Locks without a request method", { locks: {} }],
  ])("runs the operation unguarded where the host has %s", async (_, host) => {
    vi.stubGlobal("navigator", host);

    await expect(newWebLock()(async () => "done")).resolves.toBe("done");
  });

  it("runs the operation unguarded where the host has no navigator", async () => {
    vi.stubGlobal("navigator", undefined);

    await expect(newWebLock()(async () => "done")).resolves.toBe("done");
  });
});

describe("pageFields", () => {
  it("gives the address of the page without its query and fragment, and the referrer as the browser gives it", () => {
    vi.stubGlobal("location", new URL("https://example.com/products/editor?tab=2#top"));
    vi.stubGlobal("document", new FakeDocument("https://www.google.com/search?q=report"));
    vi.stubGlobal("window", new EventTarget());

    expect(pageFields()).toEqual({
      page: "https://example.com/products/editor",
      referrer: "https://www.google.com/search?q=report",
    });
  });
});

describe("the page a web collector sends by default", () => {
  /** Tracks one page view at `address`, opened from `referrer`, and returns the event sent. */
  async function sentAt(
    address: string,
    referrer = "",
  ): Promise<{ page?: string; referrer?: string }> {
    const fetch = new FakeFetch();
    vi.stubGlobal("fetch", fetch.fetch);
    vi.stubGlobal("navigator", { language: "de-DE" });
    vi.stubGlobal("location", new URL(address));
    vi.stubGlobal("document", new FakeDocument(referrer));
    vi.stubGlobal("window", new EventTarget());
    const usage = newWebCollector({
      key: SITE_KEY,
      version: "1.0.0",
      endpoint: ENDPOINT,
      mode: "anonymous",
      storage: newMemoryStorage(),
    });

    await usage.track("page_view");
    await usage.flush();
    return fetch.events[0] ?? {};
  }

  it.each([
    ["https://example.com/u/alice@example.com", "/u/:address"],
    ["https://example.com/docs/index.html", "/docs/index.html"],
  ])("sends the page at %s as %s", async (address, page) => {
    expect((await sentAt(address)).page).toBe(page);
  });

  it.each([
    ["another site", "https://docs.example.org:8443/guide", "docs.example.org"],
    ["the same site", "https://example.com/products", undefined],
    ["no referrer", "", undefined],
  ])("sends the referring host of %s only when it is another host", async (_, referrer, host) => {
    expect((await sentAt("https://example.com/privacy", referrer)).referrer).toBe(host);
  });
});

describe("newWebCollector", () => {
  /**
   * Stubs a Firefox page at `/editor` with no Web Locks, and returns the network the collector posts to and the fake
   * `localStorage`.
   */
  function stubPage(): { fetch: FakeFetch; webStorage: FakeWebStorage; listened: string[] } {
    const fetch = new FakeFetch();
    const webStorage = new FakeWebStorage();
    vi.stubGlobal("fetch", fetch.fetch);
    vi.stubGlobal("localStorage", webStorage);
    vi.stubGlobal("navigator", {
      language: "de-DE",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    });
    vi.stubGlobal("location", new URL("https://example.com/editor"));
    return { fetch, webStorage, listened: stubListenedPage() };
  }

  it("adds no listener to the page: a send at hide would not finish before the page is gone", () => {
    const { listened } = stubPage();

    newWebCollector({ key: SITE_KEY, version: "1.0.0", endpoint: ENDPOINT, mode: "anonymous" });

    expect(listened).toEqual([]);
  });

  it("sends a web envelope with the primary language of the user and the page, over localStorage, and no id or browser", async () => {
    const { fetch, webStorage } = stubPage();
    const usage = newWebCollector({
      key: SITE_KEY,
      version: "1.0.0",
      endpoint: ENDPOINT,
      mode: "anonymous",
    });

    await usage.track("report_exported");
    await usage.flush();

    const envelope = fetch.requests[0]?.envelope;
    expect(envelope).toMatchObject({
      key: SITE_KEY,
      platform: "web",
      version: "1.0.0",
      browser_language: "de",
    });
    expect(envelope).not.toHaveProperty("ui_language");
    expect(envelope).not.toHaveProperty("id");
    expect(envelope).not.toHaveProperty("browser");
    expect(envelope?.events[0]).toMatchObject({ page: "/editor" });
    expect(envelope?.events[0]).not.toHaveProperty("referrer");
    expect([...webStorage.items.keys()].every((key) => key.startsWith("artel."))).toBe(true);
    expect(webStorage.items.size).toBeGreaterThan(0);
  });

  it("sends the page from the getPage it is given", async () => {
    const { fetch } = stubPage();
    const usage = newWebCollector({
      key: SITE_KEY,
      version: "1.0.0",
      endpoint: ENDPOINT,
      mode: "anonymous",
      getPage: pageFields,
    });

    await usage.track("report_exported");
    await usage.flush();

    expect(fetch.requests[0]?.envelope.events[0]).toMatchObject({ page: "/editor" });
  });

  it("sends the id, the browser and the full language once the user is identified", async () => {
    const { fetch } = stubPage();
    const usage = newWebCollector({
      key: SITE_KEY,
      version: "1.0.0",
      endpoint: ENDPOINT,
      mode: "identified",
      getId: () => USER_ID,
    });

    await usage.setState("identified");
    await usage.track("report_exported");
    await usage.flush();

    expect(fetch.requests[0]?.envelope).toMatchObject({
      id: USER_ID,
      browser: { name: "firefox", major: 132 },
      browser_language: "de-DE",
    });
  });

  it("detects the browser in the pseudonymous state too", async () => {
    const { fetch } = stubPage();
    const usage = newWebCollector({
      key: SITE_KEY,
      version: "1.0.0",
      endpoint: ENDPOINT,
      mode: "pseudonymous",
    });

    await usage.setState("pseudonymous");
    await usage.track("report_exported");
    await usage.flush();

    expect(fetch.requests[0]?.envelope).toMatchObject({
      id_kind: "pseudonymous",
      browser: { name: "firefox", major: 132 },
    });
  });

  it("sends the browser it is given over the one it detects", async () => {
    const { fetch } = stubPage();
    const usage = newWebCollector({
      key: SITE_KEY,
      version: "1.0.0",
      endpoint: ENDPOINT,
      mode: "identified",
      getId: () => USER_ID,
      browser: { name: "edge", major: 130 },
    });

    await usage.setState("identified");
    await usage.track("report_exported");
    await usage.flush();

    expect(fetch.requests[0]?.envelope.browser).toEqual({ name: "edge", major: 130 });
  });

  it("reads the browser only once the user is identified", async () => {
    stubPage();
    let reads = 0;
    vi.stubGlobal("navigator", {
      language: "de-DE",
      get userAgent(): string {
        reads++;
        return "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
      },
    });
    const usage = newWebCollector({
      key: SITE_KEY,
      version: "1.0.0",
      endpoint: ENDPOINT,
      mode: "identified",
      getId: () => USER_ID,
    });

    await usage.track("report_exported");
    await usage.flush();
    expect(reads).toBe(0);

    await usage.setState("identified");
    await usage.track("report_exported");
    const readsForFirstId = reads;
    await usage.track("report_exported");
    await usage.flush();
    expect(readsForFirstId).toBeGreaterThan(0);
    expect(reads).toBe(readsForFirstId);
  });

  it("takes the options it is given over its defaults, and a default for an option given as undefined", async () => {
    const { fetch, webStorage } = stubPage();
    const usage = newWebCollector({
      key: SITE_KEY,
      version: "1.0.0",
      endpoint: ENDPOINT,
      mode: "identified",
      getId: () => USER_ID,
      browser: undefined,
      getPage: undefined,
      browserLanguage: "en-GB",
      uiLanguage: "fr-CA",
      storage: newMemoryStorage(),
    });

    await usage.setState("identified");
    await usage.track("report_exported");
    await usage.flush();

    const envelope = fetch.requests[0]?.envelope;
    expect(envelope).toMatchObject({
      browser_language: "en-GB",
      ui_language: "fr-CA",
      browser: { name: "firefox", major: 132 },
    });
    expect(envelope?.events[0]).toMatchObject({ page: "/editor" });
    expect(webStorage.items.size).toBe(0);
  });

  it("keeps platform web when the options carry another platform, which their type leaves out", async () => {
    const { fetch } = stubPage();
    const desktop = { platform: "macos" } as const;
    const usage = newWebCollector({
      ...desktop,
      key: SITE_KEY,
      version: "1.0.0",
      endpoint: ENDPOINT,
      mode: "anonymous",
    });

    await usage.track("report_exported");
    await usage.flush();

    expect(fetch.requests[0]?.envelope.platform).toBe("web");
  });
});
