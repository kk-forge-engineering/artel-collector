import type { Browser } from "./browser.js";
import type { Period } from "./calendar.js";

/** The platform the product runs on, as the intake names it. */
export const Platform = {
  Extension: "extension",
  MacOs: "macos",
  Windows: "windows",
  Linux: "linux",
  Web: "web",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

/**
 * The events that only the collector sends: `installed` and `updated` from its own methods, and `opted_out` when the
 * user turns analytics off.
 */
export const LifecycleEvent = {
  Installed: "installed",
  Updated: "updated",
  OptedOut: "opted_out",
} as const;
export type LifecycleEvent = (typeof LifecycleEvent)[keyof typeof LifecycleEvent];

/** The system event of a page view. Only the first one that a collector records carries the referrer. */
export const PAGE_VIEW = "page_view";
export const UNINSTALLED = "uninstalled";

/**
 * The intake's `system_events`: the events it takes from every product without the product's allowlist. The collector
 * sends the lifecycle ones, and the product's own pages and site send the rest.
 */
export const SYSTEM_EVENTS: readonly string[] = [
  ...Object.values(LifecycleEvent),
  UNINSTALLED,
  "welcome_opened",
  PAGE_VIEW,
  "install_click",
];

/**
 * Event parameters. The intake drops the whole event when a parameter is off the product's allowlist, when an enum
 * value is off its list, or when a string looks like an address, a domain or an IP.
 */
export type EventParams = Record<string, string | number | boolean>;

/** One event as the intake receives it, inside an envelope. */
export interface UsageEvent {
  name: string;
  /** The user's local calendar day the event happened on. */
  day: string;
  /** The periods, such as the day, in which this event is the user's first one. */
  first?: Period[];
  /** Days since install, as a bucket without an `id`. Only the first event of a day carries it. */
  age_days?: number;
  /** Months since install, as a bucket without an `id`. Only the first event of a month carries it. */
  age_months?: number;
  params?: EventParams;
  page?: string;
  referrer?: string;
}

/** Where an envelope's `id` comes from: the install id the collector makes, or the account id from `getId`. */
export type IdKind = "pseudonymous" | "identified";

/** What one request to the intake carries. */
export interface Envelope {
  key: string;
  platform: Platform;
  version: string;
  /** The user's language, such as `pt-BR`; only `pt` without an `id`. */
  browser_language?: string;
  /**
   * The language the product shows its interface in. An envelope without an `id` carries only the primary language,
   * such as `pt`.
   */
  ui_language?: string;
  /** Present only on a web or extension envelope that carries an `id`. */
  browser?: Browser;
  session: string;
  id?: string;
  /** Present exactly when `id` is. The intake keeps the id only when its kind is within the channel's mode. */
  id_kind?: IdKind;
  /** Stays the same on each retry of this envelope. The intake keeps it once. */
  batch?: string;
  events: UsageEvent[];
}
