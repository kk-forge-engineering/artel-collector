import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from './exports.js';
import type {
  ActiveDaysBucket,
  AnalyticsState,
  Browser,
  Clock,
  Collector,
  CollectorOptions,
  CommonOptions,
  Delivery,
  EventParams,
  GetId,
  Lock,
  ModeOptions,
  StateOf,
  NavigatorFields,
  PageFields,
  StorageAdapter,
  TimerHandle,
  Transport,
  TransportResult,
  UninstallParams,
} from './exports.js';
import * as desktop from './desktop.js';
import type { DesktopCollectorOptions } from './desktop.js';
import * as extension from './extension.js';
import type { ExtensionCollectorOptions } from './extension.js';
import * as testing from './testing.js';
import type { RecordedEvent, RecordingCollector } from './testing.js';
import * as web from './web.js';
import { USER_ID, SITE_KEY } from '../tests/harness.js';
import type { WebCollectorOptions } from './web.js';

// This suite fails when a change removes or renames an export that README.md documents. Products build on these names,
// so such a change needs a breaking release.
describe('the public API', () => {
  it('exports these values from each entry point', () => {
    expect(new Set(Object.keys(core))).toEqual(
      new Set([
        'ActiveDaysBucket',
        'AnalyticsState',
        'BrowserName',
        'checkEvent',
        'checkOptions',
        'isTestKey',
        'Mode',
        'Platform',
        'detectBrowser',
        'newCollector',
        'newHttpTransport',
        'newMemoryStorage',
        'systemClock',
      ]),
    );
    expect(new Set(Object.keys(web))).toEqual(
      new Set(['newLocalStorageAdapter', 'newWebCollector', 'newWebLock', 'pageFields', 'trackPageViews']),
    );
    expect(new Set(Object.keys(extension))).toEqual(
      new Set(['forwardTrack', 'newChromeStorageAdapter', 'newContentScriptCollector', 'newExtensionCollector']),
    );
    expect(new Set(Object.keys(desktop))).toEqual(new Set(['newDesktopCollector']));
    expect(new Set(Object.keys(testing))).toEqual(new Set(['newRecordingCollector', 'queuedEvents']));
  });

  it('exports these types', () => {
    // Each name fails the type check once its export goes.
    expectTypeOf<
      [
        ActiveDaysBucket,
        Browser,
        Clock,
        Collector,
        CollectorOptions,
        CommonOptions,
        Delivery,
        DesktopCollectorOptions,
        EventParams,
        ExtensionCollectorOptions,
        GetId,
        Lock,
        ModeOptions,
        NavigatorFields,
        StateOf<'anonymous'>,
        PageFields,
        RecordedEvent,
        RecordingCollector,
        StorageAdapter,
        TimerHandle,
        Transport,
        TransportResult,
        UninstallParams,
        WebCollectorOptions,
      ]
    >().not.toBeNever();
  });

  it('keeps the methods of a collector and the options every collector takes', () => {
    expectTypeOf<keyof Collector>().toEqualTypeOf<
      'track' | 'installed' | 'updated' | 'setState' | 'getState' | 'flush' | 'forget' | 'uninstallParams'
    >();
    expectTypeOf<keyof CommonOptions>().toEqualTypeOf<
      | 'key'
      | 'version'
      | 'browserLanguage'
      | 'uiLanguage'
      | 'storage'
      | 'sessionIdleMinutes'
      | 'sendDelaySeconds'
      | 'clock'
      | 'lock'
      | 'onError'
    >();
  });

  it('takes getId only in an identified channel, and a browser only with an id and from a web or extension product', () => {
    const base = { key: SITE_KEY, version: '1.0.0', storage: core.newMemoryStorage(), endpoint: 'https://x' };
    const getId = (): string => USER_ID;
    const browser = { name: 'chrome', major: 131 } as const;

    expectTypeOf({ ...base, platform: 'web', mode: 'anonymous' } as const).toExtend<CollectorOptions>();
    expectTypeOf({
      ...base,
      platform: 'web',
      mode: 'identified',
      getId,
      browser,
    } as const).toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'web', mode: 'pseudonymous', browser } as const).toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'macos', mode: 'pseudonymous' } as const).toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'macos', mode: 'identified', getId } as const).toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'web', mode: 'anonymous', getId } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'web', mode: 'pseudonymous', getId } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'web', mode: 'anonymous', browser } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'web', mode: 'identified' } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({
      ...base,
      platform: 'macos',
      mode: 'identified',
      getId,
      browser,
    } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({
      ...base,
      platform: 'macos',
      mode: 'pseudonymous',
      browser,
    } as const).not.toExtend<CollectorOptions>();
  });

  it('takes getPage only on platform web, the one platform that sends pages', () => {
    const base = { key: SITE_KEY, version: '1.0.0', storage: core.newMemoryStorage(), endpoint: 'https://x' };
    const platformBase = { key: SITE_KEY, version: '1.0.0', endpoint: 'https://x', mode: 'anonymous' } as const;
    const getPage = (): PageFields => ({ page: '/a' });

    expectTypeOf({ ...base, platform: 'web', mode: 'anonymous', getPage } as const).toExtend<CollectorOptions>();
    expectTypeOf({
      ...base,
      platform: 'extension',
      mode: 'anonymous',
      getPage,
    } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'macos', mode: 'anonymous', getPage } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({ ...platformBase, getPage }).toExtend<WebCollectorOptions>();
    expectTypeOf(platformBase).toExtend<ExtensionCollectorOptions>();
  });

  it('refuses getPage in extension options held in a variable, where no excess-property check runs', () => {
    const options = {
      key: SITE_KEY,
      endpoint: 'https://x',
      mode: 'anonymous' as const,
      getPage: () => ({ page: '/a' }),
    };

    expectTypeOf(options).not.toExtend<Parameters<typeof extension.newExtensionCollector>[0]>();
  });

  it('takes no options without a version, but in an extension, which reads the manifest', () => {
    const base = { key: SITE_KEY, storage: core.newMemoryStorage(), endpoint: 'https://x', mode: 'anonymous' } as const;
    const platformBase = { key: SITE_KEY, endpoint: 'https://x', mode: 'anonymous' } as const;

    expectTypeOf({ ...base, platform: 'web' } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'macos' } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'extension' } as const).not.toExtend<CollectorOptions>();
    expectTypeOf({ ...base, platform: 'web', version: '1.0.0' } as const).toExtend<CollectorOptions>();
    expectTypeOf(platformBase).not.toExtend<WebCollectorOptions>();
    expectTypeOf({ ...platformBase, version: '1.0.0' }).toExtend<WebCollectorOptions>();
    expectTypeOf(platformBase).toExtend<ExtensionCollectorOptions>();
  });

  it('takes the intake endpoint or a transport, one of the two', () => {
    const base = { key: SITE_KEY, version: '1.0.0', storage: core.newMemoryStorage() };
    const options = { ...base, platform: 'web', mode: 'anonymous' } as const;
    const transport = async (): Promise<number> => 204;

    expectTypeOf({ ...options, transport } as const).toExtend<CollectorOptions>();
    expectTypeOf({ ...options, endpoint: 'https://x', transport } as const).not.toExtend<CollectorOptions>();
    expectTypeOf(options).not.toExtend<CollectorOptions>();
  });

  it('lets a collector take only the states up to its channel mode', () => {
    expectTypeOf<Parameters<Collector<'identified'>['setState']>[0]>().toEqualTypeOf<
      'opted_out' | 'anonymous' | 'pseudonymous' | 'identified'
    >();
    expectTypeOf<Parameters<Collector<'pseudonymous'>['setState']>[0]>().toEqualTypeOf<
      'opted_out' | 'anonymous' | 'pseudonymous'
    >();
    expectTypeOf<Parameters<Collector<'anonymous'>['setState']>[0]>().toEqualTypeOf<'opted_out' | 'anonymous'>();
    expectTypeOf<StateOf<'identified'>>().toEqualTypeOf<AnalyticsState>();
    expectTypeOf<StateOf<'pseudonymous'>>().toEqualTypeOf<'opted_out' | 'anonymous' | 'pseudonymous'>();
    expectTypeOf<StateOf<'anonymous'>>().toEqualTypeOf<'opted_out' | 'anonymous'>();
    const options = { key: SITE_KEY, platform: 'web', version: '1.0.0', storage: core.newMemoryStorage() } as const;
    const anonymous = core.newCollector({ ...options, endpoint: 'https://x', mode: 'anonymous' });
    const pseudonymous = core.newCollector({ ...options, endpoint: 'https://x', mode: 'pseudonymous' });
    expectTypeOf(anonymous).toEqualTypeOf<Collector<'anonymous'>>();
    expectTypeOf(pseudonymous).toEqualTypeOf<Collector<'pseudonymous'>>();
    // The functions are never called: a platform constructor reads its host's globals.
    const platformBase = { key: SITE_KEY, version: '1.0.0', endpoint: 'https://x', mode: 'pseudonymous' } as const;
    expectTypeOf(() => web.newWebCollector(platformBase)).returns.toEqualTypeOf<Collector<'pseudonymous'>>();
    expectTypeOf(() => extension.newExtensionCollector(platformBase)).returns.toEqualTypeOf<
      Collector<'pseudonymous'>
    >();
    expectTypeOf(() => desktop.newDesktopCollector({ ...platformBase, platform: 'linux' })).returns.toEqualTypeOf<
      Collector<'pseudonymous'>
    >();
  });

  it('takes a mode known only at run time on every platform constructor', () => {
    expectTypeOf((options: CollectorOptions) => core.newCollector(options)).returns.toEqualTypeOf<Collector>();
    expectTypeOf((options: WebCollectorOptions) => web.newWebCollector(options)).returns.toEqualTypeOf<Collector>();
    expectTypeOf((options: ExtensionCollectorOptions) =>
      extension.newExtensionCollector(options),
    ).returns.toEqualTypeOf<Collector>();
    expectTypeOf((options: DesktopCollectorOptions) =>
      desktop.newDesktopCollector(options),
    ).returns.toEqualTypeOf<Collector>();
  });

  it('takes only a desktop platform, and no browser or page, in desktop options', () => {
    const base = { key: SITE_KEY, version: '1.0.0', endpoint: 'https://x', mode: 'anonymous' } as const;

    expectTypeOf({ ...base, platform: 'macos' } as const).toExtend<DesktopCollectorOptions>();
    expectTypeOf(base).not.toExtend<DesktopCollectorOptions>();
    expectTypeOf({ ...base, platform: 'web' } as const).not.toExtend<DesktopCollectorOptions>();
    expectTypeOf({
      ...base,
      platform: 'linux',
      getPage: () => undefined,
    } as const).not.toExtend<DesktopCollectorOptions>();
    expectTypeOf({
      ...base,
      platform: 'linux',
      mode: 'identified',
      getId: () => USER_ID,
      browser: { name: 'chrome' },
    } as const).not.toExtend<DesktopCollectorOptions>();
  });

  it("gives a content script only track, so it can neither read nor change the user's choice", () => {
    expectTypeOf<keyof extension.ContentScriptCollector>().toEqualTypeOf<'track'>();
    expectTypeOf(extension.newContentScriptCollector()).toEqualTypeOf<extension.ContentScriptCollector>();
    expectTypeOf(extension.newContentScriptCollector()).not.toHaveProperty('setState');
    expectTypeOf(extension.newContentScriptCollector()).not.toHaveProperty('getState');
  });
});
