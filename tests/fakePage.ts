import { vi } from 'vitest';
import { Platform } from '../src/exports.js';
import { newHarness, type Harness } from './harness.js';

type HistoryCall = (this: void, data: unknown, unused: string, url?: string | URL | null) => void;

/** A page loaded at `/` from a search engine, whose history moves its location as a browser's does. */
export class FakePage {
  readonly location = { protocol: 'https:', host: 'example.com', pathname: '/', search: '', hostname: 'example.com' };
  readonly document = new FakeDocument('https://www.google.com/search?q=editor');
  readonly window = new EventTarget();
  readonly history = {
    pushState: ((_data, _unused, url) => this.moveTo(url)) as HistoryCall,
    replaceState: ((_data, _unused, url) => this.moveTo(url)) as HistoryCall,
  };

  /** Goes back to `path`, as the back button does. */
  back(path: string): void {
    this.moveTo(path);
    this.window.dispatchEvent(new Event('popstate'));
  }

  private moveTo(url: string | URL | null | undefined): void {
    const next = new URL(String(url ?? ''), 'https://example.com/');
    this.location.pathname = next.pathname;
    this.location.search = next.search;
  }
}

/** Puts a fresh `FakePage` in place of the page globals. */
export function stubPage(): FakePage {
  const page = new FakePage();
  vi.stubGlobal('location', page.location);
  vi.stubGlobal('document', page.document);
  vi.stubGlobal('window', page.window);
  vi.stubGlobal('history', page.history);
  return page;
}

/** Returns each sent page view as its page and referrer. */
export function pageViews(harness: Harness): [string | undefined, string | undefined][] {
  return harness.fetch.events
    .filter((event) => event.name === 'page_view')
    .map((event) => [event.page, event.referrer]);
}

/** Returns a harness whose collector reads its page from `location.pathname`, as the web collector does by default. */
export function newPageHarness(): Harness {
  const harness = newHarness({ platform: Platform.Web, getPage: () => ({ page: location.pathname }) });
  return harness;
}

/** A document whose visibility a test sets, as a tab switch does. */
export class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';

  constructor(readonly referrer = '') {
    super();
  }

  hide(): void {
    this.visibilityState = 'hidden';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** Puts a fresh `FakeDocument` and window in place of the page globals, so a test can hide or leave the page. */
export function stubHideablePage(): { document: FakeDocument; window: EventTarget } {
  const page = { document: new FakeDocument(), window: new EventTarget() };
  vi.stubGlobal('document', page.document);
  vi.stubGlobal('window', page.window);
  return page;
}

/** Hides the page by `event`: `visibilitychange` to hidden, as a tab switch does, or `pagehide`, as leaving does. */
export function hide(page: { document: FakeDocument; window: EventTarget }, event: string): void {
  if (event === 'pagehide') {
    page.window.dispatchEvent(new Event('pagehide'));
  } else {
    page.document.hide();
  }
}
