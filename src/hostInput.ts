import { copyBrowser, type Browser } from "./browser.js";
import type { CollectorOptions, Delivery, GetId } from "./collectorTypes.js";
import { Platform } from "./envelope.js";
import { isVersion } from "./fields.js";
import type { Build } from "./stateFields.js";
import type { StorageAdapter } from "./storage.js";

type ReportError = (error: unknown) => void;

/** The most characters an id may have for the intake to take it. */
const MAX_ID_LENGTH = 64;
/** The hosts an http endpoint may name: this machine, as `URL` writes its hostname. */
const DEVELOPMENT_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The most characters of host or stored text a report quotes. A planted value can be megabytes long. */
const MAX_QUOTED_LENGTH = 64;

/**
 * The channel kinds, each with the form of its key and the platforms it takes. A key is the kind, `test-` for a test
 * key, then 10 characters of `[0-9a-z]`. The intake refuses an envelope of a platform its channel's kind does not take.
 */
const CHANNEL_KINDS = [
  { kind: "extension", platforms: [Platform.Extension] },
  { kind: "desktop", platforms: [Platform.MacOs, Platform.Windows, Platform.Linux] },
  { kind: "site", platforms: [Platform.Web] },
].map(({ kind, platforms }) => ({
  kind,
  keyFormat: new RegExp(String.raw`^${kind}-(?:test-)?[\da-z]{10}$`),
  platforms: platforms as readonly Platform[],
}));

/**
 * Returns `value` as JSON, cut to its first 64 characters with `…` after a cut, or its type where JSON cannot write it,
 * such as a symbol, a bigint or a circular object. A report that quotes host input uses it, so no value makes the report
 * throw or grow past a line.
 */
export function quoted(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
  const characters = Array.from(text.slice(0, 2 * MAX_QUOTED_LENGTH));
  return characters.length > MAX_QUOTED_LENGTH
    ? `${characters.slice(0, MAX_QUOTED_LENGTH).join("")}…`
    : text;
}

/** Hands `error` to the host's `onError` as an Error. A handler that throws reaches no caller. */
export function reportTo(onError: ((error: Error) => void) | undefined, error: unknown): void {
  try {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // The host's own handler failing must not make the caller reject or throw.
  }
}

/** Returns `value` when it passes `check`, or reports it and returns undefined. */
export function accepted(
  name: string,
  value: string | undefined,
  check: (candidate: unknown) => candidate is string,
  reportError: ReportError,
): string | undefined {
  if (value === undefined || check(value)) {
    return value;
  }
  reportError(new Error(`artel: ${name} ${quoted(value)} is not one the intake takes, left out`));
  return undefined;
}

/**
 * Returns the platform and the version of the options. Throws a `TypeError` that names the option for options the
 * intake would refuse every envelope of, or that only a host outside TypeScript passes: a platform, a key or a version
 * the intake does not take, an endpoint that is not https, a transport that is not a function, and a browser on a
 * platform that names none. A mistake in the build then fails its first run and its tests.
 */
export function checkedBuild(options: CollectorOptions): Build {
  checkOptions(options);
  const { platform, version } = options;
  if (
    options.browser !== undefined &&
    platform !== Platform.Web &&
    platform !== Platform.Extension
  ) {
    throw new TypeError(`artel: platform ${platform} names no browser`);
  }
  return { platform, version };
}

/**
 * Throws the `TypeError` a constructor throws for a key, a version, a platform, an endpoint or a transport the intake
 * would refuse every envelope of, and returns otherwise. It reads no host API, so a product's build or test can call it.
 */
export function checkOptions(
  options: Pick<CollectorOptions, "key" | "version" | "platform"> & Delivery,
): void {
  checkDelivery(options);
  const { platform, version } = options;
  if (!Object.values(Platform).includes(platform)) {
    throw new TypeError(`artel: platform ${quoted(platform)} is not one the intake takes`);
  }
  checkKey(options.key, platform);
  if (!isVersion(version)) {
    throw new TypeError(`artel: version ${quoted(version)} is not one the intake takes`);
  }
}

/** Tells whether `key` is a channel's test key, `<kind>-test-<10 characters>`. */
export function isTestKey(key: string): boolean {
  return CHANNEL_KINDS.some(
    ({ kind, keyFormat }) => key.startsWith(`${kind}-test-`) && keyFormat.test(key),
  );
}

/**
 * Throws unless the options name a transport that is a function, or an endpoint that is an https URL, or an http URL of
 * a development host, without a user or a password. Plain http would send ids and events readable on the way, `fetch`
 * refuses every URL with credentials, and a request to any other address never reaches the intake. The message quotes
 * no endpoint, so it never carries a password.
 */
function checkDelivery({ endpoint, transport }: Delivery): void {
  if (transport !== undefined) {
    if (typeof transport !== "function") {
      throw new TypeError(`artel: transport is a ${typeof transport}, not a function`);
    }
    return;
  }
  let url: URL | undefined;
  try {
    url = typeof endpoint === "string" ? new URL(endpoint) : undefined;
  } catch {
    // The throw below covers an endpoint that is no URL.
  }
  const isHttps =
    url?.protocol === "https:" || (url?.protocol === "http:" && isDevelopmentHost(url.hostname));
  if (!isHttps || url?.username !== "" || url.password !== "") {
    throw new TypeError(
      "artel: endpoint is not an https URL without a user or password, or http to a development host",
    );
  }
}

/** Tells whether a URL's host is one only this machine or a development setup serves. */
function isDevelopmentHost(hostname: string): boolean {
  return (
    DEVELOPMENT_HOSTS.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".test")
  );
}

/** Throws unless `key` has the intake's form, and its channel kind takes `platform`. */
function checkKey(key: unknown, platform: Platform): void {
  const channel =
    typeof key === "string"
      ? CHANNEL_KINDS.find(({ keyFormat }) => keyFormat.test(key))
      : undefined;
  if (channel === undefined) {
    throw new TypeError(
      `artel: key ${quoted(key)} is not <kind>-<10 characters> or <kind>-test-<10 characters>`,
    );
  }
  if (!channel.platforms.includes(platform)) {
    throw new TypeError(`artel: a key of kind ${channel.kind} does not take platform ${platform}`);
  }
}

/**
 * Returns a function that gives the host's browser as the intake keeps it, or undefined when there is none. A function
 * the host passes runs only at the first call, which the collector makes only for an event with an id. Reports and
 * leaves out a value that is not a browser, which only a host outside TypeScript passes.
 */
export function newBrowserReader(
  browser: Browser | (() => Browser | undefined) | undefined,
  reportError: ReportError,
): () => Browser | undefined {
  if (typeof browser !== "function") {
    const copy = acceptedBrowser(browser, reportError);
    return () => copy;
  }
  let read: { browser: Browser | undefined } | undefined;
  return () => {
    read ??= { browser: acceptedBrowser(callBrowser(browser, reportError), reportError) };
    return read.browser;
  };
}

function callBrowser(
  browser: () => Browser | undefined,
  reportError: ReportError,
): Browser | undefined {
  try {
    return browser();
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

/** Returns a copy of the browser as the intake keeps it, or reports and drops a value that is not a browser. */
function acceptedBrowser(
  browser: Browser | undefined,
  reportError: ReportError,
): Browser | undefined {
  if (browser === undefined) {
    return undefined;
  }
  const copy = copyBrowser(browser);
  if (copy === undefined) {
    reportError(new Error(`artel: browser ${quoted(browser)} is not a browser, left out`));
  }
  return copy;
}

/** Tells whether `id` is an id the intake takes: a string of 1 to 64 characters. */
export function isUsableId(id: unknown): id is string {
  return typeof id === "string" && id !== "" && Array.from(id).length <= MAX_ID_LENGTH;
}

/**
 * Returns a `getId` that gives a non-empty string of at most 64 characters, or undefined. A host outside TypeScript may
 * return null or an empty string, which then reads as an id the product does not know yet.
 */
export function usableId(getId: GetId, reportError: ReportError): GetId {
  return async () => {
    const id: unknown = await getId();
    if (typeof id !== "string" || id === "") {
      return undefined;
    }
    // The intake refuses the whole envelope of an id past 64 characters. The event waits as for an unknown id instead.
    if (Array.from(id).length > MAX_ID_LENGTH) {
      reportError(
        new Error(`artel: an id past ${MAX_ID_LENGTH} characters is not one the intake takes`),
      );
      return undefined;
    }
    return id;
  };
}

/**
 * Returns the storage with every value that is not a string read as absent. A product's own storage may resolve null
 * for a missing key, which would read as a stored install mark or another user's id.
 */
export function newStringStorage(storage: StorageAdapter): StorageAdapter {
  return {
    get: async (key) => {
      const value: unknown = await storage.get(key);
      return typeof value === "string" ? value : undefined;
    },
    set: (key, value) => storage.set(key, value),
  };
}
