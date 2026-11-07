import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from './exports.js';
import type {
  ActiveDaysBucket,
  Clock,
  Collector,
  CollectorOptions,
  EventParams,
  Lock,
  PageFields,
  StorageAdapter,
  TimerHandle,
  Transport,
  UninstallParams,
} from './exports.js';
import * as extension from './extension.js';
import * as web from './web.js';

// The published API that README.md describes. Products build on these names, so a change here is a breaking release.
describe('the public API', () => {
  it('exports these values from each entry point', () => {
    expect(new Set(Object.keys(core))).toEqual(
      new Set(['ActiveDaysBucket', 'Platform', 'newCollector', 'newHttpTransport', 'newMemoryStorage', 'systemClock']),
    );
    expect(new Set(Object.keys(web))).toEqual(
      new Set(['flushWhenHidden', 'newLocalStorageAdapter', 'newWebLock', 'pageFields']),
    );
    expect(new Set(Object.keys(extension))).toEqual(
      new Set(['acceptForwarded', 'forwardTrack', 'newChromeStorageAdapter', 'refreshUninstallUrl']),
    );
  });

  it('exports these types', () => {
    // Each name fails the type check once its export goes.
    expectTypeOf<
      [
        ActiveDaysBucket,
        Clock,
        Collector,
        CollectorOptions,
        EventParams,
        Lock,
        PageFields,
        StorageAdapter,
        TimerHandle,
        Transport,
        UninstallParams,
      ]
    >().not.toBeNever();
  });

  it('keeps the methods of a collector and its options', () => {
    expectTypeOf<keyof Collector>().toEqualTypeOf<
      'track' | 'installed' | 'updated' | 'setEnabled' | 'isEnabled' | 'flush' | 'forget' | 'uninstallParams'
    >();
    expectTypeOf<keyof CollectorOptions>().toEqualTypeOf<
      | 'key'
      | 'platform'
      | 'version'
      | 'lang'
      | 'storage'
      | 'transport'
      | 'getId'
      | 'sessionIdleMinutes'
      | 'sendDelaySeconds'
      | 'clock'
      | 'getPage'
      | 'lock'
      | 'onError'
    >();
  });
});
