# Changelog

## 0.9.0

- Chrome extensions with a health channel import the app health collector from `@kk-forge/artel-collector/health`. Use the intake origin, the channel key and the product's error code list. The collector posts completed operations and lifecycle events to `/v1/public/health`, subject to the local reporting preference.
- An anonymous envelope and the ordinary `opted_out` envelope omit `session`. On startup, the collector clears old anonymous session values, removes the field from unsealed anonymous envelopes and drops sealed anonymous envelopes that still carry it. Envelopes with a known ID can still carry a session.
- To switch an installed Chrome extension to health, keep the channel key so the stored reporting preference carries over. A worker can keep a feedback-only uninstall page by passing its clean HTTPS URL as `uninstallPage`.

## 0.8.0

- `trackPageViews` decides that a navigation leads to another page by the page the collector would send, as `getPage` gives it, not by `location.pathname`. A web app that keeps its routes in the hash passes a `getPage` that reads the route from the hash, and gets a `page_view` for each route where it got one per page load. The tracker also listens to `hashchange`, and a navigation that several events report still sends one.
- Without a `getPage` of its own nothing changes: the page is the path, so a change of the query or the hash alone still sends no `page_view`. Where the collector reads no page, as on another platform than web, the tracker compares `location.pathname` as before.
- `trackPageView(collector)` from `@kk-forge/artel-collector/infra` sends a `page_view` of the page `getPage` gives now, unless the last `page_view` sent that page. A router that changes the screen without changing the address calls it after each change.

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
