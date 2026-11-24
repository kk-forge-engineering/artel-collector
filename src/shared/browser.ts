/** The browsers the intake tells apart. Any other browser is `other`. */
export const BrowserName = {
  Chrome: "chrome",
  Edge: "edge",
  Opera: "opera",
  Yandex: "yandex",
  Brave: "brave",
  Firefox: "firefox",
  Safari: "safari",
  Other: "other",
} as const;
export type BrowserName = (typeof BrowserName)[keyof typeof BrowserName];

type VersionedBrowserName = Exclude<BrowserName, typeof BrowserName.Other>;

/** The browser and its major version, when it is known. `other` carries no version. */
export type Browser =
  | { name: VersionedBrowserName; major?: number }
  | { name: typeof BrowserName.Other };

/** The part of `navigator` the detection reads. */
export interface NavigatorFields {
  userAgent?: string;
  userAgentData?: { brands?: readonly { brand: string; version: string }[] };
}

/**
 * The brands of a Chromium browser, each browser's own ahead of Google Chrome. A browser that lists both goes by its
 * own.
 */
const BRANDS: readonly [string, VersionedBrowserName][] = [
  ["Microsoft Edge", BrowserName.Edge],
  ["Opera", BrowserName.Opera],
  ["YaBrowser", BrowserName.Yandex],
  ["Brave", BrowserName.Brave],
  ["Google Chrome", BrowserName.Chrome],
];

/**
 * User-Agent tokens of the browsers that name themselves there. Chrome goes by its brands: every Chromium browser's
 * User-Agent has its token, so that token alone names no browser.
 */
const USER_AGENT_TOKENS: readonly [RegExp, VersionedBrowserName][] = [
  [/\bEdg\/(\d+)/, BrowserName.Edge],
  [/\bOPR\/(\d+)/, BrowserName.Opera],
  [/\bYaBrowser\/(\d+)/, BrowserName.Yandex],
  [/\bFirefox\/(\d+)/, BrowserName.Firefox],
];

/**
 * Names the browser from what `navigator` gives any site: the Client Hints brands of a Chromium browser, or else the
 * User-Agent string. Returns undefined when it has neither, as outside a browser.
 */
export function detectBrowser(nav: NavigatorFields): Browser | undefined {
  for (const [brand, name] of BRANDS) {
    const entry = nav.userAgentData?.brands?.find((candidate) => candidate.brand === brand);
    if (entry !== undefined) {
      return withMajor(name, entry.version);
    }
  }
  // This check names a Chromium browser with no brand of its own `other`, and skips its User-Agent string. Such a
  // browser copies Chrome's User-Agent string, so that string names no browser.
  const chromiumBrands = new Set(["Chromium", ...BRANDS.map(([brand]) => brand)]);
  if (nav.userAgentData?.brands?.some((entry) => chromiumBrands.has(entry.brand)) === true) {
    return { name: BrowserName.Other };
  }
  if (nav.userAgent === undefined || nav.userAgent === "") {
    return undefined;
  }
  return fromUserAgent(nav.userAgent);
}

function fromUserAgent(userAgent: string): Browser {
  for (const [pattern, name] of USER_AGENT_TOKENS) {
    const match = pattern.exec(userAgent);
    if (match !== null) {
      return withMajor(name, match[1]);
    }
  }
  // The check names Safari only without a Chrome or Chromium token. A Chromium browser's User-Agent string carries
  // Safari's tokens too. One regular expression per token keeps a long User-Agent string free of backtracking.
  const version = /\bVersion\/(\d+)/.exec(userAgent)?.[1];
  if (
    version !== undefined &&
    /\bSafari\//.test(userAgent) &&
    !/\b(?:Chrome|Chromium)\//.test(userAgent)
  ) {
    return withMajor(BrowserName.Safari, version);
  }
  return { name: BrowserName.Other };
}

/**
 * Returns a fresh copy of a browser as the intake keeps it: a name off the list as `other`, and a major version outside
 * 1 to 999 left out. Returns undefined for a value that is not an object, which only a host outside TypeScript passes.
 */
export function copyBrowser(value: unknown): Browser | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const name: unknown = Reflect.get(value, "name");
  const major: unknown = Reflect.get(value, "major");
  const known = Object.values(BrowserName).find(
    (candidate) => candidate === name && candidate !== BrowserName.Other,
  );
  if (known === undefined) {
    return { name: BrowserName.Other };
  }
  return isMajor(major) ? { name: known, major } : { name: known };
}

/** Returns the browser with its major version, or without one outside 1 to 999, which the intake does not take. */
function withMajor(name: VersionedBrowserName, version: string | undefined): Browser {
  const major = majorOf(version);
  return major === undefined ? { name } : { name, major };
}

/** Returns the major version, or undefined when the string has none from 1 to 999, the range the intake takes. */
function majorOf(version: string | undefined): number | undefined {
  const major = Number.parseInt(version ?? "", 10);
  return isMajor(major) ? major : undefined;
}

/** Checks for a whole number from 1 to 999, the range the intake takes. */
function isMajor(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 999;
}
