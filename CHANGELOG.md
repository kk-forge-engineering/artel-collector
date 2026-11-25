# Changelog

## 0.7.0

- A collector sends its first event at once, not after the send delay. A page closed a second after its load has its `page_view` on the way.
- `newWebCollector` and `newDesktopCollector` flush when the page or window turns hidden, as on a switch to another tab or app. The flush keeps the retry wait the intake asked for, and sends nothing in the `opted_out` state but a queued `opted_out`.
- A page that closes or navigates away still sends nothing at that moment: its send needs the lock, which a closing page never gets. What it queued goes with the next visit, as before.

## 0.6.1

Nothing a product sees changes. The package lints with `@kk-forge/oxlint-config` 13, and its tests reach their helpers and the source through the `#tests/` and `#/` subpath imports.

## 0.6.0

The entry points now follow the layers of the package's code. Every export keeps its name and signature, and only the path it is imported from changes.

Breaking:

- `@kk-forge/artel-collector/web` and `@kk-forge/artel-collector/desktop` are gone. Import `newWebCollector`, `newLocalStorageAdapter`, `newWebLock`, `pageFields`, `trackPageViews`, `newDesktopCollector` and their option types from `@kk-forge/artel-collector/infra`.
- `@kk-forge/artel-collector/extension` is gone. Import `newExtensionCollector`, `newContentScriptCollector`, `newChromeStorageAdapter`, `forwardTrack` and their types from `@kk-forge/artel-collector/infra/chrome`.
- `newCollector`, `newHttpTransport` and `systemClock` moved from `@kk-forge/artel-collector` to `@kk-forge/artel-collector/infra`.

Unchanged: `@kk-forge/artel-collector` keeps the types, the enums, `detectBrowser`, `checkOptions`, `isTestKey`, `checkEvent` and `newMemoryStorage`. `@kk-forge/artel-collector/testing` keeps its names. What the collector sends and stores, and when, is the same as in 0.5.0.
