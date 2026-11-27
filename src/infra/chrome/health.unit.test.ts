import { describe, expect, it, vi } from "vitest";
import { stubChrome, stubServiceWorker } from "#tests/fakeChrome.js";
import { FakeFetch } from "#tests/fakeFetch.js";
import { newSharedLock } from "#tests/sharedLock.js";
import { KEY, QUEUE_KEY, storageKey } from "#tests/harness.js";
import { newHealthCollector, newHealthContentScriptCollector } from "./health.js";

const ORIGIN = "https://intake.example.com";
const operation = { feature: "convert", entry: "popup", outcome: "ok", duration_ms: 42 } as const;

function setup() {
  const chrome = stubChrome();
  const fetch = new FakeFetch();
  vi.stubGlobal("fetch", fetch.fetch);
  vi.stubGlobal("navigator", { language: "pt-BR" });
  return { chrome, fetch };
}

describe("the app health entrypoint", () => {
  it("sends an operation and first marks to health without identity fields", async () => {
    const { chrome, fetch } = setup();
    const health = newHealthCollector({ key: KEY, origin: ORIGIN, uiLanguage: "fr-CA" });

    await health.record(operation);
    await health.flush();

    expect(fetch.requests).toHaveLength(1);
    const request = fetch.requests[0];
    expect(request?.url).toBe(`${ORIGIN}/v1/public/health`);
    expect(Object.keys(request?.envelope ?? {}).sort()).toEqual([
      "batch",
      "events",
      "key",
      "platform",
      "ui_language",
      "version",
    ]);
    expect(request?.envelope).toMatchObject({
      platform: "extension",
      version: "3.1.0",
      ui_language: "fr",
      events: [
        {
          name: "operation",
          params: operation,
          first: ["day", "week", "month", "quarter", "year"],
          age_days: 0,
          age_months: 0,
        },
      ],
    });
    for (const key of ["session", "id", "id_kind", "browser", "browser_language"]) {
      expect(request?.envelope).not.toHaveProperty(key);
    }
    for (const key of ["page", "referrer"]) {
      expect(request?.envelope.events[0]).not.toHaveProperty(key);
    }
    expect(chrome.items.has(storageKey("session"))).toBe(false);
  });

  it("posts exactly the fields the relay accepts when no UI language was supplied", async () => {
    const { fetch } = setup();
    const health = newHealthCollector({ key: KEY, origin: ORIGIN });
    await health.record(operation);
    await health.flush();

    expect(Object.keys(fetch.requests[0]?.envelope ?? {}).sort()).toEqual([
      "batch",
      "events",
      "key",
      "platform",
      "version",
    ]);
  });

  it("preserves the local preference and drops queued work when switched off", async () => {
    const { chrome, fetch } = setup();
    chrome.items.set(storageKey("session"), "oldsession");
    chrome.items.set(storageKey("session_seen"), "42");
    const health = newHealthCollector({ key: KEY, origin: ORIGIN });

    expect(await health.isEnabled()).toBe(true);
    await health.record(operation);
    await health.setEnabled(false);
    await health.record(operation);
    await health.flush();

    const restarted = newHealthCollector({ key: KEY, origin: ORIGIN });
    expect(await restarted.isEnabled()).toBe(false);
    expect(fetch.requests).toEqual([]);
    expect(chrome.items.has(storageKey("session"))).toBe(false);
    expect(chrome.items.has(storageKey("session_seen"))).toBe(false);
  });

  it("stops sending even if discarding the queue fails during opt-out", async () => {
    const { chrome, fetch } = setup();
    const errors: Error[] = [];
    const health = newHealthCollector({
      key: KEY,
      origin: ORIGIN,
      onError: (error) => errors.push(error),
    });
    await health.record(operation);

    const set = chrome.storage.local.set;
    const write = vi.spyOn(chrome.storage.local, "set");
    write.mockImplementation(async (items) => {
      if (items[QUEUE_KEY] === "[]") {
        write.mockRestore();
        throw new Error("queue write failed");
      }
      await set(items);
    });
    await health.setEnabled(false);
    await health.flush();
    expect(fetch.requests).toEqual([]);
    expect(await health.isEnabled()).toBe(false);
    expect(errors).toEqual([new Error("queue write failed")]);

    await health.setEnabled(true);
    await health.flush();
    expect(fetch.requests).toEqual([]);
  });

  it("does not send a leased batch discarded by an off-on transition", async () => {
    const { chrome, fetch } = setup();
    const lock = newSharedLock();
    vi.stubGlobal("navigator", {
      language: "pt-BR",
      locks: { request: (_name: string, run: () => Promise<unknown>) => lock(run) },
    });
    chrome.items.set(
      QUEUE_KEY,
      JSON.stringify([
        {
          qid: "0123456789abcdef",
          envelope: {
            key: KEY,
            platform: "extension",
            version: "3.1.0",
            events: [
              { name: "operation", day: new Date().toISOString().slice(0, 10), params: operation },
            ],
          },
        },
      ]),
    );
    const page = newHealthCollector({ key: KEY, origin: ORIGIN });
    const other = newHealthCollector({ key: KEY, origin: ORIGIN });

    const set = chrome.storage.local.set;
    let toggled: Promise<void[]> | undefined;
    vi.spyOn(chrome.storage.local, "set").mockImplementation(async (items) => {
      await set(items);
      const queue = items[QUEUE_KEY];
      if (toggled === undefined && typeof queue === "string" && queue.includes('"leasedBy":')) {
        toggled = Promise.all([other.setEnabled(false), other.setEnabled(true)]);
      }
    });
    await page.flush();
    await toggled;

    expect(toggled).toBeDefined();
    expect(await page.isEnabled()).toBe(true);
    expect(fetch.requests).toEqual([]);
  });

  it("does not send install or update events when reporting is off", async () => {
    const { chrome, fetch } = setup();
    stubServiceWorker();
    chrome.items.set(storageKey("state"), "opted_out");
    const health = newHealthCollector({ key: KEY, origin: ORIGIN });

    chrome.install("install");
    chrome.install("update");
    await health.flush();
    expect(fetch.requests).toEqual([]);

    await health.setEnabled(true);
    chrome.install("install");
    await health.flush();
    expect(fetch.eventNames).toEqual(["installed"]);
  });

  it("only forwards operations from this extension and sends lifecycle events itself", async () => {
    const { chrome, fetch } = setup();
    stubServiceWorker();
    const health = newHealthCollector({ key: KEY, origin: ORIGIN });
    const content = newHealthContentScriptCollector();
    const message = { type: "artel.track", name: "operation", params: operation };

    chrome.install("install");
    await content.record(operation);
    await chrome.runtime.sendMessage(message, { id: "another-extension" });
    await chrome.runtime.sendMessage({
      ...message,
      params: { feature: "convert", entry: "popup" },
    });
    await health.flush();

    expect(fetch.eventNames).toEqual(["installed", "operation"]);
  });

  it("rejects error codes outside the product list and invalid durations", async () => {
    const { fetch } = setup();
    const errors: Error[] = [];
    const health = newHealthCollector({
      key: KEY,
      origin: ORIGIN,
      errorCodes: ["upload_failed"],
      onError: (error) => errors.push(error),
    });
    await health.record({ ...operation, outcome: "error", error_code: "unknown_code" });
    await health.record({ ...operation, duration_ms: 86_400_001 });
    await health.record({ ...operation, duration_ms: 1.5 });
    await health.record({ ...operation, outcome: "error", error_code: "upload_failed" });
    await health.flush();

    expect(errors).toHaveLength(3);
    expect(fetch.requests[0]?.envelope.events).toHaveLength(1);
    expect(fetch.requests[0]?.envelope.events[0]?.params).toMatchObject({
      error_code: "upload_failed",
    });
  });

  it("clears the previous URL or replaces it with a feedback-only page", () => {
    const { chrome } = setup();
    stubServiceWorker();
    chrome.uninstallUrl = "https://product.example/uninstall?age_days=7";
    newHealthCollector({ key: KEY, origin: ORIGIN });
    expect(chrome.uninstallUrl).toBe("");

    newHealthCollector({
      key: KEY,
      origin: ORIGIN,
      uninstallPage: "https://product.example/feedback",
    });
    expect(chrome.uninstallUrl).toBe("https://product.example/feedback");
  });

  it("does not send if Chrome cannot restrict storage to trusted contexts", async () => {
    const { chrome, fetch } = setup();
    const errors: Error[] = [];
    vi.spyOn(chrome.storage.local, "setAccessLevel").mockRejectedValue(new Error("access denied"));
    const health = newHealthCollector({
      key: KEY,
      origin: ORIGIN,
      onError: (error) => errors.push(error),
    });
    await health.record(operation);
    await health.flush();

    expect(errors).toContainEqual(new Error("access denied"));
    expect(fetch.requests).toEqual([]);
  });

  it("does not send before it can remove an incompatible queue", async () => {
    const { chrome, fetch } = setup();
    chrome.items.set(
      QUEUE_KEY,
      JSON.stringify([
        {
          qid: "old",
          envelope: {
            key: KEY,
            platform: "extension",
            version: "3.1.0",
            session: "old",
            events: [],
          },
        },
      ]),
    );
    const set = chrome.storage.local.set;
    const write = vi.spyOn(chrome.storage.local, "set");
    let fails = true;
    write.mockImplementation(async (items) => {
      if (fails && QUEUE_KEY in items) {
        throw new Error("queue write failed");
      }
      await set(items);
    });
    const health = newHealthCollector({ key: KEY, origin: ORIGIN });

    await health.flush();
    expect(fetch.requests).toEqual([]);

    fails = false;
    await health.record(operation);
    await health.flush();
    expect(fetch.eventNames).toEqual(["operation"]);
  });

  it.each(["session", "browser_language"])(
    "drops a sealed batch with %s only in its wire body",
    async (field) => {
      const { chrome, fetch } = setup();
      const envelope = {
        key: KEY,
        platform: "extension",
        version: "3.1.0",
        events: [{ name: "operation", day: "2026-01-01", params: operation }],
      };
      const qid = "0123456789abcdef";
      const body = JSON.stringify({ ...envelope, batch: qid, [field]: "not_allowed" });
      chrome.items.set(QUEUE_KEY, JSON.stringify([{ qid, envelope, body }]));
      const health = newHealthCollector({ key: KEY, origin: ORIGIN });

      await health.flush();

      expect(fetch.requests).toEqual([]);
      expect(chrome.items.get(QUEUE_KEY)).toBe("[]");
    },
  );

  it("drops a sealed batch whose old wire body and metadata include browser_language", async () => {
    const { chrome, fetch } = setup();
    const envelope = {
      key: KEY,
      platform: "extension",
      version: "3.1.0",
      browser_language: "en",
      events: [{ name: "operation", day: "2026-01-01", params: operation }],
    };
    const qid = "0123456789abcdef";
    const body = JSON.stringify({ ...envelope, batch: qid });
    chrome.items.set(QUEUE_KEY, JSON.stringify([{ qid, envelope, body }]));
    const health = newHealthCollector({ key: KEY, origin: ORIGIN });

    await health.flush();

    expect(fetch.requests).toEqual([]);
    expect(chrome.items.get(QUEUE_KEY)).toBe("[]");
  });

  it("does not send the ordinary extension's queue to health after an update", async () => {
    const { chrome, fetch } = setup();
    chrome.items.set(
      QUEUE_KEY,
      JSON.stringify([
        {
          qid: "old",
          envelope: {
            key: KEY,
            platform: "extension",
            version: "3.1.0",
            session: "oldsession",
            events: [{ name: "old_event", day: "2026-01-01" }],
          },
        },
      ]),
    );
    const health = newHealthCollector({ key: KEY, origin: ORIGIN });

    await health.record(operation);
    await health.flush();

    expect(fetch.eventNames).toEqual(["operation"]);
  });
});
