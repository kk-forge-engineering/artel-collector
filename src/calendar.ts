/** A calendar date. Its month runs 1…12. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** The periods an event can be the first of, in the order the intake lists them. */
export const Period = {
  Day: "day",
  Week: "week",
  Month: "month",
  Quarter: "quarter",
  Year: "year",
} as const;
export type Period = (typeof Period)[keyof typeof Period];

const DAY_MS = 86_400_000;

/**
 * Returns the calendar date in the host's time zone. The collector counts install age and first-of-period marks by this
 * date.
 */
export function localDateAt(epochMs: number): CalendarDate {
  const date = new Date(epochMs);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** Returns the UTC calendar date, the date the intake goes by. */
export function utcDateAt(epochMs: number): CalendarDate {
  const date = new Date(epochMs);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Formats the date as `YYYY-MM-DD`, the form of the envelope's `day` field. */
export function formatDay(date: CalendarDate): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** Parses a `YYYY-MM-DD` day, or returns undefined when the text is missing or has another form. */
export function parseDay(text: string | undefined): CalendarDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? "");
  if (!match) {
    return undefined;
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Returns a key for the period that holds the date. Two dates get the same key only when they fall in the same period.
 */
export function periodKey(period: Period, date: CalendarDate): string {
  switch (period) {
    case Period.Day:
      return formatDay(date);
    case Period.Week:
      return isoWeekKey(date);
    case Period.Month:
      return `${date.year}-${pad(date.month)}`;
    case Period.Quarter:
      return `${date.year}-Q${Math.ceil(date.month / 3)}`;
    case Period.Year:
      return String(date.year);
  }
}

/**
 * Returns whole calendar days from one date to another, negative when `to` comes first. A daylight saving change does
 * not shift the count.
 */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}

/** Returns whole months from one date to another: 15 Oct to 14 Nov is 0, to 15 Nov is 1. */
export function monthsBetween(from: CalendarDate, to: CalendarDate): number {
  const months = (to.year - from.year) * 12 + (to.month - from.month);
  return to.day < from.day ? months - 1 : months;
}

/** Returns the date of the ISO 8601 week's Monday, as `YYYY-MM-DD`. */
function isoWeekKey(date: CalendarDate): string {
  const midnight = utcMidnight(date);
  const daysSinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return formatDay(utcDateAt(midnight - daysSinceMonday * DAY_MS));
}

function utcMidnight(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
