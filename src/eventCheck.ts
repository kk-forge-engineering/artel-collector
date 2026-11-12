import { ActiveDaysBucket, type TrackOptions } from './collectorTypes.js';
import { LifecycleEvent, SYSTEM_EVENTS, type EventParams } from './envelope.js';
import { quoted } from './hostInput.js';
import { throttleOf } from './throttle.js';

/** The form the intake takes for an event name and a param name. */
const NAME_FORMAT = /^[a-z][a-z\d_]{0,39}$/;
const MAX_PARAMS = 16;
/** The length of a string param the intake takes, in characters. */
const MAX_PARAM_STRING_LENGTH = 64;
const UNREADABLE_PARAMS = 'has params that could not be read';
const LIFECYCLE_NAMES: ReadonlySet<unknown> = new Set(Object.values(LifecycleEvent));
const ACTIVE_DAYS: readonly unknown[] = Object.values(ActiveDaysBucket);

/** Returns the rule a param value breaks, or undefined when it keeps them. */
type ParamRule = (value: unknown) => string | undefined;

/**
 * The params each system event takes, from the intake's `SystemEventParams`. A system event that this map leaves out
 * takes no params.
 */
const SYSTEM_EVENT_PARAMS: ReadonlyMap<string, Readonly<Record<string, ParamRule>>> = new Map([
  [
    'uninstalled',
    {
      // The intake reads the value as whole days from 0. It drops the event when the value has another form.
      age_days: (value: unknown) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
          ? undefined
          : 'that is not a whole number from 0',
      active_days: (value: unknown) =>
        ACTIVE_DAYS.includes(value) ? undefined : `that is not one of ${ACTIVE_DAYS.join(', ')}`,
    },
  ],
  ['install_click', { product: (value: unknown) => (typeof value === 'string' ? undefined : 'that is not a string') }],
]);

/**
 * Tells why the intake would drop the event, or returns undefined when its form passes. The check refuses `installed`,
 * `updated` and `opted_out`, because only the collector's own methods send them. It never throws: for params whose
 * getter or proxy throws, it returns that it could not read them.
 */
export function checkEvent(name: unknown, params: unknown): string | undefined {
  if (typeof name !== 'string' || !NAME_FORMAT.test(name)) {
    return 'has a name the intake does not take';
  }
  if (LIFECYCLE_NAMES.has(name)) {
    return 'is one only the collector sends';
  }
  try {
    return paramsProblem(name, params);
  } catch {
    return UNREADABLE_PARAMS;
  }
}

/**
 * Returns a copy of the params of an event `track` takes, with the `throttleMs` of its options, or reports why it
 * refuses the event and returns undefined. The copy is taken once, so a later change the host makes to its object
 * reaches neither the check nor the event.
 */
export function acceptedEvent({
  name,
  given,
  options,
  reportError,
}: {
  name: string;
  given: EventParams | undefined;
  options: TrackOptions | undefined;
  reportError: (error: unknown) => void;
}): { params: EventParams | undefined; throttleMs: number | undefined } | undefined {
  const refuse = (problem: string, cause?: unknown): undefined => {
    const message = `artel: event ${quoted(name)} ${problem}, so it was not tracked`;
    reportError(cause === undefined ? new Error(message) : new Error(message, { cause }));
    return undefined;
  };
  let params: EventParams | undefined;
  try {
    params = copyOfParams(given);
  } catch (error) {
    return refuse(UNREADABLE_PARAMS, error);
  }
  const problem = checkEvent(name, params);
  if (problem !== undefined) {
    return refuse(problem);
  }
  const throttle = throttleOf(options);
  return throttle === undefined
    ? refuse('has a throttleMs that is not a finite number from 0')
    : { params, throttleMs: throttle.throttleMs };
}

/**
 * Returns a shallow copy of the own enumerable entries of object params, and other params as they are. The collector
 * checks and queues the copy, so a later change the host makes to its object reaches neither. Throws what a getter or a
 * proxy of the params throws.
 */
function copyOfParams(params: EventParams | undefined): EventParams | undefined {
  // An untyped host can pass null or a list. The function returns such params as they are, so the check refuses them.
  const value: unknown = params;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : params;
}

/**
 * Tells why the intake would drop this event for its params, or returns undefined when it takes them. For an event that
 * is not a system event, the intake's allowlist decides the rest. The collector does not know that list.
 */
function paramsProblem(name: string, params: unknown): string | undefined {
  if (params === undefined) {
    return undefined;
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return 'has params that are not an object';
  }
  // The check counts the keys before it reads any value. A content script can send params with many keys, and this
  // order keeps their cost low.
  const keys = Object.keys(params);
  if (keys.length > MAX_PARAMS) {
    return `has more than ${MAX_PARAMS} params`;
  }
  for (const key of keys) {
    const rule = paramRule(name, key, Reflect.get(params, key));
    if (rule !== undefined) {
      return `has a param ${quoted(key)} ${rule}`;
    }
  }
  return undefined;
}

/**
 * Tells which rule of the intake one param breaks, in the order the intake checks them, or returns undefined when it
 * keeps them.
 */
function paramRule(name: string, key: string, value: unknown): string | undefined {
  if (!NAME_FORMAT.test(key)) {
    return 'whose name is not a lowercase letter, then lowercase letters, digits and _, up to 40 characters';
  }
  if (SYSTEM_EVENTS.includes(name)) {
    const rule = SYSTEM_EVENT_PARAMS.get(name)?.[key];
    if (rule === undefined) {
      return `that ${name} does not take`;
    }
    return rule(value) ?? valueRule(value);
  }
  return valueRule(value);
}

/**
 * Tells which rule of every param the value breaks, or returns undefined when it keeps them. The check refuses a number
 * that is not finite, because JSON sends it as null.
 */
function valueRule(value: unknown): string | undefined {
  if (typeof value === 'string') {
    // A string longer than twice the limit in UTF-16 units has more characters than the limit, so the check does not
    // count its characters.
    return value.length > 2 * MAX_PARAM_STRING_LENGTH || Array.from(value).length > MAX_PARAM_STRING_LENGTH
      ? `past ${MAX_PARAM_STRING_LENGTH} characters`
      : undefined;
  }
  return typeof value === 'boolean' || Number.isFinite(value)
    ? undefined
    : 'that is not a string, a boolean or a finite number';
}
