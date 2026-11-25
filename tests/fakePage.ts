import { vi } from "vitest";
import { Platform } from "#src/shared/exports.js";
import { newHarness, type Harness } from "./harness.js";

type HistoryCall = (this: void, data: unknown, unused: string, url?: string | URL | null) => void;

/** A page loaded at `/` from a search engine, whose history moves its location as a browser's does. */
export class FakePage {
  readonly location = {
    protocol: "https:",
    host: "example.com",
    pathname: "/",
    search: "",
    hash: "",
    hostname: "example.com",
  };
  readonly document = new FakeDocument("https://www.google.com/search?q=editor");
  readonly window = new EventTarget();
  readonly history: { pushState: HistoryCall; replaceState: HistoryCall } = {
    pushState: (_data, _unused, url) => this.moveTo(url),
    replaceState: (_data, _unused, url) => this.moveTo(url),
  };

  /** Goes back to `path`, as the back button does. */
  back(path: string): void {
    this.moveTo(path);
    this.window.dispatchEvent(new Event("popstate"));
  }

  /** Sets the fragment to `hash`, as a link to `#…` does, which a browser reports as a `popstate` and a `hashchange`. */
  goToHash(hash: string): void {
    this.location.hash = hash;
    this.window.dispatchEvent(new Event("popstate"));
    this.window.dispatchEvent(new Event("hashchange"));
  }

  private moveTo(url: string | URL | null | undefined): void {
    const next = new URL(
      String(url ?? ""),
      `https://example.com${this.location.pathname}${this.location.search}`,
    );
    this.location.pathname = next.pathname;
    this.location.search = next.search;
    this.location.hash = next.hash;
  }
}

/** Puts a fresh `FakePage` in place of the page globals. */
export function stubPage(): FakePage {
  const page = new FakePage();
  vi.stubGlobal("location", page.location);
  vi.stubGlobal("document", page.document);
  vi.stubGlobal("window", page.window);
  vi.stubGlobal("history", page.history);
  return page;
}

/** Returns each sent page view as its page and referrer. */
export function pageViews(harness: Harness): [string | undefined, string | undefined][] {
  return harness.fetch.events
    .filter((event) => event.name === "page_view")
    .map((event) => [event.page, event.referrer]);
}

/** Returns a harness whose collector reads its page from `location.pathname`, as the web collector does by default. */
export function newPageHarness(): Harness {
  const harness = newHarness({
    platform: Platform.Web,
    getPage: () => ({ page: location.pathname }),
  });
  return harness;
}

/** Returns a harness of a web app that keeps its routes in the hash and sends each route without its record's number. */
export function newHashRouteHarness(): Harness {
  return newHarness({
    platform: Platform.Web,
    getPage: () => ({ page: location.hash.replace(/^#\/?/, "/").replaceAll(/\/\d+/g, "/:id") }),
  });
}

/** A visible document with a referrer, which takes listeners as a page's does and which a test can hide and show. */
export class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  constructor(readonly referrer = "") {
    super();
  }

  /** Turns the document hidden, as a switch to another tab does. */
  hide(): void {
    this.turn("hidden");
  }

  /** Turns the document visible again, as a switch back to its tab does. */
  show(): void {
    this.turn("visible");
  }

  private turn(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

/**
 * Puts a fresh `FakeDocument` and window in place of the page globals, and returns the document and the list each event
 * type that a listener is added for goes to.
 */
export function stubListenedPage(): { added: string[]; document: FakeDocument } {
  const added: string[] = [];
  const document = new FakeDocument();
  for (const [name, target] of [
    ["document", document],
    ["window", new EventTarget()],
  ] as const) {
    const add = target.addEventListener.bind(target);
    target.addEventListener = (type, listener) => {
      added.push(type);
      add(type, listener);
    };
    vi.stubGlobal(name, target);
  }
  return { added, document };
}
