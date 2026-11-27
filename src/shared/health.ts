import { parseDay, Period } from "./calendar.js";
import { ageInDays, ageInMonths } from "./fields.js";
import { LifecycleEvent, type EventParams } from "./envelope.js";

export type HealthOperation = {
  feature: string;
  entry: string;
  duration_ms?: number;
  tool?: string;
  step?: string;
  how?: string;
  count?: string;
} & ({ outcome: "ok"; error_code?: never } | { outcome: "error"; error_code: string });

export const OPERATION = "operation";
const MAX_DURATION_MS = 86_400_000;
const PERIODS: ReadonlySet<unknown> = new Set(Object.values(Period));
const TOKEN = /^[a-z][a-z0-9_]{0,39}$/;
const FIELDS = new Set([
  "feature",
  "entry",
  "outcome",
  "error_code",
  "duration_ms",
  "tool",
  "step",
  "how",
  "count",
]);

function isToken(value: unknown): boolean {
  return typeof value === "string" && TOKEN.test(value);
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isHealthOperation(
  value: unknown,
  errorCodes?: ReadonlySet<string>,
): value is EventParams & HealthOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (
    Object.keys(fields).every((key) => FIELDS.has(key)) &&
    isToken(fields.feature) &&
    isToken(fields.entry) &&
    ((fields.outcome === "ok" && !("error_code" in fields)) ||
      (fields.outcome === "error" &&
        typeof fields.error_code === "string" &&
        isToken(fields.error_code) &&
        (errorCodes === undefined || errorCodes.has(fields.error_code)))) &&
    (!("duration_ms" in fields) ||
      (typeof fields.duration_ms === "number" &&
        isCount(fields.duration_ms) &&
        fields.duration_ms <= MAX_DURATION_MS)) &&
    (!("tool" in fields) || isToken(fields.tool)) &&
    (!("step" in fields) || isToken(fields.step)) &&
    (!("how" in fields) || isToken(fields.how)) &&
    (!("count" in fields) || isToken(fields.count))
  );
}

export function isHealthEvent(value: unknown, errorCodes: ReadonlySet<string>): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = Object.fromEntries<unknown>(Object.entries(value));
  return (
    Object.keys(event).every((key) =>
      ["name", "day", "first", "age_days", "age_months", "params"].includes(key),
    ) &&
    typeof event.day === "string" &&
    parseDay(event.day) !== undefined &&
    (event.first === undefined ||
      (Array.isArray(event.first) && event.first.every((period) => PERIODS.has(period)))) &&
    (event.age_days === undefined ||
      (typeof event.age_days === "number" &&
        event.age_days === ageInDays(event.age_days, { isExact: false }))) &&
    (event.age_months === undefined ||
      (typeof event.age_months === "number" &&
        event.age_months === ageInMonths(event.age_months, { isExact: false }))) &&
    (event.name === OPERATION
      ? isHealthOperation(event.params, errorCodes)
      : (event.name === LifecycleEvent.Installed || event.name === LifecycleEvent.Updated) &&
        event.params === undefined)
  );
}
