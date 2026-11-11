import { AnalyticsState, Mode } from './collectorTypes.js';
import { Platform, type Envelope, type IdKind } from './envelope.js';
import { primaryLanguage } from './fields.js';

export interface Build {
  platform: Platform;
  version: string;
}

/** The fields that name the product build, as an envelope and the uninstall page carry them. */
export type ProductFields = Pick<Envelope, 'platform' | 'version' | 'browser_language' | 'ui_language'>;

/** Everything the collector shapes by the user's state. */
export interface StateFields {
  /** Whether the state records the user's events. Only `opted_out` records none. */
  recordsEvents: boolean;
  /** The build fields, with each language cut to its primary subtag unless the envelope names the user. */
  product: ProductFields;
  /** Whether the install ages go exact, rather than as the lowest value of their bucket. */
  isAgeExact: boolean;
  /** The kind of id an envelope carries, with the browser, or undefined for a state that names no user. */
  idKind: IdKind | undefined;
  /** Whether an event may carry its page and referrer. The intake keeps them only from a site channel. */
  mayCarryPage: boolean;
}

/** Ranks the modes and the states by what they reveal of a user. A mode takes the states of a rank up to its own. */
const MODE_RANKS = new Map<unknown, number>([
  [Mode.Anonymous, 0],
  [Mode.Pseudonymous, 1],
  [Mode.Identified, 2],
]);
const STATE_RANKS = new Map<unknown, number>([
  [AnalyticsState.OptedOut, 0],
  [AnalyticsState.Anonymous, 0],
  [AnalyticsState.Pseudonymous, 1],
  [AnalyticsState.Identified, 2],
]);

export function isAnalyticsState(value: unknown): value is AnalyticsState {
  return STATE_RANKS.has(value);
}

/** Tells whether a channel of `mode` takes `state`: a state up to its mode. A mode that does not exist is anonymous. */
export function channelTakes(mode: Mode, state: unknown): state is AnalyticsState {
  return (STATE_RANKS.get(state) ?? Number.POSITIVE_INFINITY) <= (MODE_RANKS.get(mode) ?? 0);
}

/** Returns whether events of this build may carry a page, which the intake keeps only from a site channel. */
export function carriesPage(build: Pick<Build, 'platform'>): boolean {
  return build.platform === Platform.Web;
}

/**
 * Returns what the collector sends in `state` for this build and these languages. Only a state with an id carries the
 * full languages and the exact ages: with the platform and version they can single out a user, so they go only with the
 * consent the id needs.
 */
export function fieldsForState({
  state,
  build,
  browserLanguage,
  uiLanguage,
}: {
  state: AnalyticsState;
  build: Build;
  browserLanguage: string | undefined;
  uiLanguage: string | undefined;
}): StateFields {
  const idKind = state === AnalyticsState.Pseudonymous || state === AnalyticsState.Identified ? state : undefined;
  const isNamed = idKind !== undefined;
  const shape = (tag: string | undefined): string | undefined =>
    tag === undefined || isNamed ? tag : primaryLanguage(tag);
  const shapedBrowserLanguage = shape(browserLanguage);
  const shapedUiLanguage = shape(uiLanguage);
  const recordsEvents = state !== AnalyticsState.OptedOut;
  return {
    recordsEvents,
    product: {
      platform: build.platform,
      version: build.version,
      ...(shapedBrowserLanguage !== undefined && { browser_language: shapedBrowserLanguage }),
      ...(shapedUiLanguage !== undefined && { ui_language: shapedUiLanguage }),
    },
    isAgeExact: isNamed,
    idKind,
    mayCarryPage: recordsEvents && carriesPage(build),
  };
}
