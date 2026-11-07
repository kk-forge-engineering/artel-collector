import type { Period } from './calendar.js';

/** The platform the product runs on, as the intake names it. */
export const Platform = {
  Extension: 'extension',
  MacOs: 'macos',
  Windows: 'windows',
  Linux: 'linux',
  Web: 'web',
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

/** The events the collector sends itself, from its lifecycle methods and its switch. */
export const LifecycleEvent = {
  Installed: 'installed',
  Updated: 'updated',
  UsageCountsOn: 'usage_counts_on',
  UsageCountsOff: 'usage_counts_off',
} as const;
export type LifecycleEvent = (typeof LifecycleEvent)[keyof typeof LifecycleEvent];

/** Event parameters. The intake keeps only those on the product's allowlist. */
export type EventParams = Record<string, string | number | boolean>;

/** One event as the intake receives it, inside an envelope. */
export interface UsageEvent {
  name: string;
  /** The user's local calendar day the event happened on. */
  day: string;
  /** The periods, such as the day, in which this event is the user's first one. */
  first?: Period[];
  /** Days since install. Only the first event of a day carries it. */
  age_days?: number;
  /** Months since install. Only the first event of a month carries it. */
  age_months?: number;
  params?: EventParams;
  page?: string;
  referrer?: string;
}

/** What one request to the intake carries. */
export interface Envelope {
  key: string;
  platform: Platform;
  version: string;
  lang?: string;
  session: string;
  id?: string;
  /** Stays the same on each retry of this envelope. The intake keeps it once. */
  batch?: string;
  events: UsageEvent[];
}
