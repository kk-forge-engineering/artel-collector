# Changelog

## 0.6.1

Nothing a product sees changes. The package lints with `@kk-forge/oxlint-config` 13, and its tests reach their helpers and the source through the `#tests/` and `#/` subpath imports.

## 0.6.0

The entry points now follow the layers of the package's code. Every export keeps its name and signature, and only the path it is imported from changes.

Breaking:

- `@kk-forge/artel-collector/web` and `@kk-forge/artel-collector/desktop` are gone. Import `newWebCollector`, `newLocalStorageAdapter`, `newWebLock`, `pageFields`, `trackPageViews`, `newDesktopCollector` and their option types from `@kk-forge/artel-collector/infra`.
- `@kk-forge/artel-collector/extension` is gone. Import `newExtensionCollector`, `newContentScriptCollector`, `newChromeStorageAdapter`, `forwardTrack` and their types from `@kk-forge/artel-collector/infra/chrome`.
- `newCollector`, `newHttpTransport` and `systemClock` moved from `@kk-forge/artel-collector` to `@kk-forge/artel-collector/infra`.

Unchanged: `@kk-forge/artel-collector` keeps the types, the enums, `detectBrowser`, `checkOptions`, `isTestKey`, `checkEvent` and `newMemoryStorage`. `@kk-forge/artel-collector/testing` keeps its names. What the collector sends and stores, and when, is the same as in 0.5.0.
