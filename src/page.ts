import type { PageFields } from './collectorTypes.js';
import { PAGE_VIEW } from './envelope.js';
import { pagePath, referrerHost } from './pagePath.js';

/** What `getPage` gave when a method was called, shaped as the collector sends it. */
export interface PageRead {
  name: string;
  /** The page fields the event carries, the referrer only when it may be the first `page_view` recorded. */
  fields?: PageFields | undefined;
}

/** What a recorded event carries of its page, from `PageReader.view`. */
interface PageView {
  fields?: PageFields | undefined;
  /** Whether the event is a `page_view` of the page the last recorded `page_view` sent, which sends nothing. */
  isRepeatedView: boolean;
  /** Notes the event as recorded, so a later `page_view` reads it as the last one. */
  recorded(): void;
}

/** Reads the page fields of an event when a method is called, and decides what they carry when it is recorded. */
export interface PageReader {
  read(name: string): PageRead;
  view(read: PageRead): PageView;
}

/**
 * Returns the reader of an event's page fields from `getPage`. It sends the referrer only with the first recorded
 * `page_view`, as the referrer belongs to the page load. It sends nothing for a `page_view` that repeats the last page.
 * It never throws: it reports a bad `getPage` result and leaves that field out.
 */
export function newPageReader({
  getPage,
  reportError,
}: {
  getPage: ((name: string) => PageFields | undefined) | undefined;
  reportError: (error: unknown) => void;
}): PageReader {
  let isPageViewRecorded = false;
  let lastViewedPage: string | undefined;

  function fieldsOf(name: string, mayCarryReferrer: boolean): PageFields | undefined {
    // A host outside TypeScript can return any value, or fields whose getters throw.
    try {
      const fields = getPage?.(name);
      const page = stringField('page', fields?.page, reportError);
      const referrer = mayCarryReferrer ? stringField('referrer', fields?.referrer, reportError) : undefined;
      const path = page === undefined ? undefined : checkedPath(page, reportError);
      const host = referrer === undefined ? undefined : referrerHost(referrer);
      const isPageHost = page !== undefined && host === referrerHost(page);
      return {
        ...(path !== undefined && { page: path }),
        ...(host !== undefined && !isPageHost && { referrer: host }),
      };
    } catch (error) {
      reportError(error);
      return undefined;
    }
  }

  return {
    read: (name) => ({ name, fields: fieldsOf(name, name === PAGE_VIEW && !isPageViewRecorded) }),
    view: ({ name, fields }) => {
      if (name !== PAGE_VIEW) {
        return { fields, isRepeatedView: false, recorded: () => undefined };
      }
      // The view drops the referrer if another call recorded a page_view since this call read it. Only the first
      // recorded page_view has a referrer.
      const { referrer: _referrer, ...withoutReferrer } = fields ?? {};
      const page = fields?.page;
      return {
        fields: isPageViewRecorded ? withoutReferrer : fields,
        isRepeatedView: page !== undefined && page === lastViewedPage,
        recorded: () => {
          isPageViewRecorded = true;
          lastViewedPage = page;
        },
      };
    },
  };
}

/** Returns a page field that is a string, or reports and leaves out one that is not. */
function stringField(name: string, value: unknown, reportError: (error: unknown) => void): string | undefined {
  if (value === undefined || typeof value === 'string') {
    return value;
  }
  reportError(new TypeError(`artel: the ${name} getPage gave is a ${typeof value}, not a string, left out`));
  return undefined;
}

/**
 * Returns the path `pagePath` gives, or reports and leaves out a page it cannot read. The report names no part of the
 * page, which may hold an address or a secret.
 */
function checkedPath(page: string, reportError: (error: unknown) => void): string | undefined {
  const path = pagePath(page);
  if (path === undefined) {
    reportError(new Error('artel: a page that is neither a path nor a URL with a path was left out'));
  }
  return path;
}
