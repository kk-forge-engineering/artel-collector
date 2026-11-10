import { AnalyticsState, Mode } from './collectorTypes.js';
import { Platform, type Envelope } from './envelope.js';
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
  /** Whether an envelope may carry the id `getId` gives and the browser. */
  mayName: boolean;
  /** Whether an event may carry its page and referrer. The intake keeps them only from a site channel. */
  mayCarryPage: boolean;
}

/** Tells whether a channel of `mode` takes `state`. An anonymous channel never takes `identified`. */
export function channelTakes(mode: Mode, state: unknown): state is AnalyticsState {
  return (
    (Object.values(AnalyticsState) as unknown[]).includes(state) &&
    (state !== AnalyticsState.Identified || mode === Mode.Identified)
  );
}

/** Returns whether events of this build may carry a page, which the intake keeps only from a site channel. */
export function carriesPage(build: Pick<Build, 'platform'>): boolean {
  return build.platform === Platform.Web;
}

/**
 * Returns what the collector sends in `state` for this build and these languages. Only the identified state carries the
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
  const isIdentified = state === AnalyticsState.Identified;
  const shape = (tag: string | undefined): string | undefined =>
    tag === undefined || isIdentified ? tag : primaryLanguage(tag);
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
    isAgeExact: isIdentified,
    mayName: isIdentified,
    mayCarryPage: recordsEvents && carriesPage(build),
  };
}
