import { Period, daysBetween, formatDay, monthsBetween } from './calendar.js';
import { ActiveDaysBucket, type PageFields } from './collectorTypes.js';
import type { EventParams, UsageEvent } from './envelope.js';
import type { EventStamp } from './installState.js';

// The intake takes `version` and the language fields only in these formats. The intake refuses an envelope with a field
// that breaks them, and all its events are lost. So the collector drops a bad language, and its constructor throws for
// a bad version.
const VERSION_FORMAT = /^\d+(\.\d+){0,3}(-[0-9A-Za-z.]+)?(\+[0-9A-Za-z.]+)?$/;
const MAX_VERSION_LENGTH = 32;
const LANGUAGE_FORMAT = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
const MAX_LANGUAGE_LENGTH = 16;

/** Checks a product version, such as `1.2.3` or `1.2.3-beta.1`, against the format and length the intake takes. */
export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && VERSION_FORMAT.test(value);
}

/** Checks a language tag, such as `en`, `pt-BR` or `zh-Hant-TW`, against the format and length the intake takes. */
export function isLanguage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_LANGUAGE_LENGTH && LANGUAGE_FORMAT.test(value);
}

/** Returns the tag with `-` for each `_`, as `en_US` becomes `en-US`. The intake reads the tag this way too. */
export function languageTag(value: string | undefined): string | undefined {
  return typeof value === 'string' ? value.replaceAll('_', '-') : value;
}

export function primaryLanguage(tag: string): string {
  return tag.split('-')[0] ?? tag;
}

/** The highest exact age in days. The intake reads 31 as 31 days or more. */
const MAX_AGE_DAYS = 31;
/** The highest exact age in months. The intake reads 25 as over 24 months. */
const MAX_AGE_MONTHS = 25;
/**
 * The age buckets in days for an anonymous event. Each bucket covers the days up to the next one: 2 means 2 to 6 days.
 */
const AGE_DAYS_BUCKETS: readonly number[] = [0, 1, 2, 7, 14, 30];
/**
 * The age buckets in months for an anonymous event. Each bucket covers the months up to the next one: 3 means 3 to 5
 * months.
 */
const AGE_MONTHS_BUCKETS: readonly number[] = [0, 1, 2, 3, 6, 12, 24];

/** Returns the age capped at 31 days when `isExact`, and its bucket otherwise. */
export function ageInDays(days: number, { isExact }: { isExact: boolean }): number {
  return isExact ? clamp(days, MAX_AGE_DAYS) : bucketOf(days, AGE_DAYS_BUCKETS);
}

/**
 * Returns the params of an `uninstalled` event with `age_days` shaped as an envelope's age: capped at 31 days when
 * `isExact`, and its bucket otherwise.
 */
export function uninstalledParams(
  params: EventParams | undefined,
  { isExact }: { isExact: boolean },
): EventParams | undefined {
  const age = params?.age_days;
  return typeof age === 'number' ? { ...params, age_days: ageInDays(age, { isExact }) } : params;
}

/** Returns the age capped at 25 months when `isExact`, and its bucket otherwise. */
function ageInMonths(months: number, { isExact }: { isExact: boolean }): number {
  return isExact ? clamp(months, MAX_AGE_MONTHS) : bucketOf(months, AGE_MONTHS_BUCKETS);
}

/** Returns `value` limited to the range from 0 to `max`. */
function clamp(value: number, max: number): number {
  return Math.min(Math.max(0, value), max);
}

/** Returns the highest bucket at or below `value`, or the lowest bucket for a negative value. */
function bucketOf(value: number, buckets: readonly number[]): number {
  let bucket = buckets[0] ?? 0;
  for (const candidate of buckets) {
    if (candidate <= value) {
      bucket = candidate;
    }
  }
  return bucket;
}

/** Returns the bucket for the number of days with at least one event. */
export function activeDaysBucket(days: number): ActiveDaysBucket {
  if (days <= 0) {
    return ActiveDaysBucket.None;
  }
  if (days === 1) {
    return ActiveDaysBucket.One;
  }
  if (days <= 5) {
    return ActiveDaysBucket.TwoToFive;
  }
  return days <= 20 ? ActiveDaysBucket.SixToTwenty : ActiveDaysBucket.TwentyOneOrMore;
}

/**
 * Returns the event to queue. It carries install ages only on the first event of a day or a month, exact or as buckets
 * by `isAgeExact`.
 */
export function newEvent({
  name,
  params,
  stamp: { today, installDay, first },
  page,
  isAgeExact,
}: {
  name: string;
  params: EventParams | undefined;
  stamp: EventStamp;
  page: PageFields | undefined;
  isAgeExact: boolean;
}): UsageEvent {
  const event: UsageEvent = { name, day: formatDay(today), ...(first.length > 0 && { first }) };
  if (first.includes(Period.Day)) {
    event.age_days = ageInDays(daysBetween(installDay, today), { isExact: isAgeExact });
  }
  if (first.includes(Period.Month)) {
    event.age_months = ageInMonths(monthsBetween(installDay, today), { isExact: isAgeExact });
  }
  if (params !== undefined) {
    event.params = params;
  }
  if (page?.page !== undefined) {
    event.page = page.page;
  }
  if (page?.referrer !== undefined) {
    event.referrer = page.referrer;
  }
  return event;
}
