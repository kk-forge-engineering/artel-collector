# @kk-forge/artel-collector

Sends a product's usage events to the intake service. It runs in a website, a web app, a browser extension or a desktop window, and has no runtime dependencies.

The collector marks the first event of each local day, week, month, quarter and year, and adds the install age to those events. From these marks the intake counts daily, weekly and monthly active users without a user id. The collector also keeps a session, holds every event in a queue in storage until the intake takes it, and carries an on/off switch for the user.

## Install

```sh
npm install @kk-forge/artel-collector
```

## Usage

```ts
import { newCollector, newHttpTransport, Platform } from '@kk-forge/artel-collector';

const usage = newCollector({
  key, // the channel key, a variable of the build
  platform: Platform.Extension,
  version: '4.2.0',
  lang: 'en',
  storage, // see "Storage"
  transport: newHttpTransport('https://intake.example.com/v1/public/relay'),
});

void usage.track('report_exported', { format: 'pdf', pages: 12, with_images: true });
```

### Options

- `key`: the channel key. It comes in as a variable at build time, so the code holds no key and one commit builds every target. A channel has a live key, `<kind>-<10 characters>`, for the build for the store and a test key, `<kind>-test-<10 characters>`, for any other build. The intake marks test events and keeps them out of the product's analytics. The live key is no secret. The test key stays out of the build for the store, since anyone who has it can read the channel's test events.
- `platform`: `Platform.Extension`, `MacOs`, `Windows`, `Linux` or `Web`.
- `version`: the product version, such as `1.2.3` or `1.2.3-beta.1`, up to 32 characters.
- `lang`: the interface language as a BCP 47 code, such as `en` or `pt-BR`. Optional.
- `storage`: where the collector keeps its state. See "Storage".
- `transport`: `newHttpTransport(endpoint)`, or a function that delivers the envelope body. It resolves within 30 seconds to the intake's HTTP status, or to `0` when the request did not reach the intake.
- `getId`: returns the user's id in a `full` channel once they consented, or `undefined`. The collector never creates an id.
- `getPage`: returns `{ page, referrer }` for an event of a site channel, the path without the query string and the referring host. The collector reads no page itself, and cuts the two to 256 and 128 characters.
- `lock`: runs an operation while no other context that shares `storage` runs one, such as `newWebLock()` from the web module. Without it, two contexts recording at once may both mark the first event of a day, or overwrite each other's queued events.
- `sessionIdleMinutes`: minutes without events that end a session, 10 by default.
- `sendDelaySeconds`: the longest an event waits in the queue before a send starts, 5 by default.
- `clock`: time and timers, the host's own by default. Tests pass a fake.
- `onError`: receives every failure the collector swallows.

### Methods

Every method returns a promise that resolves and never rejects. A failure goes to `onError`. So a call whose result you do not wait for is marked `void`, as in the examples.

- `track(name, params?)` records an event. The name and each param name must be on the product's allowlist and match this form: a lowercase letter, then lowercase letters, digits and `_`, up to 40 characters. A param value is a string up to 64 characters, a number or a boolean.
- `installed()` sends `installed` once per install. A later call sends no event.
- `updated()` sends `updated` when `version` differs from the last version seen. Call it after `installed()`, so that a fresh install does not also count as an update.
- `setEnabled(on)` with `false` drops the events not sent yet, sends `usage_counts_off` and stops sending. With `true` it sends `usage_counts_on`. The choice persists.
- `isEnabled()` resolves to the stored choice, on by default.
- `flush()` sends what is queued now.
- `forget(id)` drops the queued events of this id, and resolves once this collector's request in flight has ended. To forget a user, make `getId` stop returning the id, call `forget(id)`, then ask the intake to forget the user. A request another context sent arrives within its 30 seconds, and the intake deletes events that arrive up to a minute after the forget. The intake forgets by the live key only. Test events go when the channel's test data is cleared.
- `uninstallParams()` resolves to `{ platform, version, lang, age, days }` for an uninstall page. `age` is days since install, and `days` is the bucket of active days: `0`, `1`, `2-5`, `6-20` or `21+`.

### Types

The main module also exports `systemClock`, the host's own `clock`, and the types `Collector`, `CollectorOptions`, `PageFields`, `UninstallParams`, `ActiveDaysBucket` (the values of `days`), `EventParams`, `StorageAdapter`, `Transport`, `Lock`, `Clock` and `TimerHandle`. `ActiveDaysBucket` is also a value: `ActiveDaysBucket.None` through `ActiveDaysBucket.TwentyOneOrMore`.

## Sending

The collector writes each event to the queue in storage at once. A send starts at most `sendDelaySeconds` after the first event waiting, so the events of those seconds share one request. An envelope of 100 events goes at once. An event that would take an envelope past 60 kB starts a new one, and an event that alone passes 60 kB is dropped and reported.

An envelope leaves the queue once the intake answered it, or by a drop rule, so a host stopped at any point keeps its queued events. Its next run sends the queue. A context that sends an envelope holds a one-minute lease on it and renews the lease before each request, so no other context sends it at the same time. An envelope whose sender stopped goes with the first send after that lease runs out. A failed request ends the lease, so the next send of any context may take the envelope before its sender's own retry. Each envelope carries a `batch` key, and every attempt sends the body of the first attempt byte for byte. So the intake keeps the envelope once, even when an answer never came back. Events tracked after the first attempt go into a new envelope, and an envelope that may no longer go is dropped whole.

When the request fails or the intake answers 429 or 5xx, the envelope keeps its place. It goes again after 1 second, then after 2, 4 and so on, up to 5 minutes. New events wait for that retry. At most 20 envelopes wait, and the oldest is dropped and reported. Any other 4xx drops the envelope and reports it.

Before a send, the collector drops queued events dated before yesterday in UTC, which the intake would move to its own today. It also drops an envelope whose id `getId` no longer returns, as after a user withdrew consent. A sealed envelope whose stored body no longer matches its events is dropped and reported.

## Storage

`storage` is any `{ get(key), set(key, value) }` that returns promises. Every key starts with `artel.`. `newMemoryStorage()` keeps the state only while the page or worker lives. The platform modules below bring adapters over `localStorage` and `chrome.storage.local`.

## Platform modules

The core touches no platform API. Two optional modules hold the code a website or an extension would otherwise write for itself.

### `@kk-forge/artel-collector/web`

For a website, a web app, or a window of a desktop app such as Tauri or Electron.

- `newLocalStorageAdapter()` returns a `storage` over `localStorage`. Every script of the origin can read it, the queued events with their `id` included, and no other storage of the origin hides them from its scripts. A site that runs untrusted scripts sends no `id`.
- `newWebLock()` returns a `lock` over Web Locks, so that the tabs and workers of one origin do not send one envelope at the same time. Without Web Locks, operations run unguarded.
- `pageFields()` is a `getPage` for a site channel: the path without the query string, and the referring host when it is another site. A site whose paths carry a secret or a person, such as `/share/<token>`, passes its own `getPage` with the route pattern instead.
- `flushWhenHidden(collector)` sends the queue when the page is hidden, since the user may not come back. `newHttpTransport` posts with `keepalive`, so a request started before the tab closes still finishes. A send that has not started by then stays queued for the next visit. It returns the function that stops it.

```ts
import { newCollector, newHttpTransport, Platform } from '@kk-forge/artel-collector';
import { flushWhenHidden, newLocalStorageAdapter, newWebLock, pageFields } from '@kk-forge/artel-collector/web';

const usage = newCollector({
  key,
  platform: Platform.Web,
  version,
  lang: navigator.language,
  storage: newLocalStorageAdapter(),
  lock: newWebLock(),
  transport: newHttpTransport(endpoint),
  getPage: pageFields,
});

void usage.track('page_view');
flushWhenHidden(usage);
```

A desktop app calls both lifecycle methods on every start. `installed()` sends once, and `updated()` sends only after a version change.

### `@kk-forge/artel-collector/extension`

For a Chrome extension. Its service worker and its pages each create a collector over `newChromeStorageAdapter()`, the shared `chrome.storage.local`, with `lock: newWebLock()` from the web module.

- `newChromeStorageAdapter()` returns a `storage` over `chrome.storage.local`. It needs the `storage` permission.
- `forwardTrack(name, params?)` hands an event from a content script to the service worker. A content script's own requests carry the page's origin, which the intake refuses. The worker refuses a name or a param name past 40 characters, more than 16 params and a param string past 64 characters, the limits of a product's event list.
- `acceptForwarded(collector, { clock }?)` tracks, in the service worker, the events content scripts forward, and returns the function that stops it. It takes them only from this extension, and never the collector's own lifecycle events. It tracks at most 60 forwarded events, or 60 kB of their names and params, a minute from all tabs and frames together and drops the rest, since a page can open any number of frames that run the content script. The budget outlasts a restart of the worker in `chrome.storage.session`, under the `storage` permission. `clock` is the time source, as in Options.
- `refreshUninstallUrl(collector, pageUrl)` sets the uninstall page with `uninstallParams()` in its query. Chrome keeps the address as it was set, so call it on each start of the worker.

```ts
// service worker
const usage = newCollector({
  key,
  platform: Platform.Extension,
  version: chrome.runtime.getManifest().version,
  storage: newChromeStorageAdapter(),
  lock: newWebLock(),
  transport: newHttpTransport(endpoint),
});

acceptForwarded(usage);
void refreshUninstallUrl(usage, 'https://example.com/uninstall');
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await usage.installed();
  } else if (reason === 'update') {
    await usage.updated();
  }
});

// content script
void forwardTrack('link_shared', { target: 'clipboard' });
```

## What is sent

One envelope per request:

```json
{
  "key": "extension-aa131n3j11",
  "platform": "extension",
  "version": "4.2.0",
  "lang": "en",
  "session": "k3j9x2m1qa0b",
  "batch": "9f2c41d07ab35e18",
  "events": [
    {
      "name": "report_exported",
      "day": "2026-10-29",
      "first": ["day", "week"],
      "age_days": 3,
      "params": { "format": "pdf", "pages": 12, "with_images": true }
    }
  ]
}
```

- `day` is the local calendar date. `first` lists the periods this event is the first of, in local time. Weeks are ISO weeks and start on Monday.
- `age_days` comes with the `day` mark. It counts days since install from 0 to 30, and 31 stands for 31 or more. `age_months` comes with the `month` mark, which a `quarter` or `year` mark always comes with. It counts months from 0 to 24, and 25 stands for more than 24. The install date is the local date of the collector's first use.
- `session` is 12 random characters from `[0-9a-z]`, a window of activity. A new one starts after `sessionIdleMinutes` without events, and at local midnight.
- `batch` is 16 random hex characters per envelope, the same on every attempt to send it.
- `id` is present only when `getId` returns one.
- `page` and `referrer` are present only when `getPage` returns them.

The collector reads no page, URL or user input. `params`, `id` and the page fields carry only what the product passes.

## Development

```sh
mise install
mise run setup
mise run check     # types, oxlint, format, build, tests
mise run check:ci  # the same with coverage, as CI runs it
```

## Release

Versions follow semver: a breaking change to the API this README describes raises the major version, or the minor one before 1.0.0. `src/exports.unit.test.ts` holds the names of that API's values and types. Raise `version` in `package.json` in a PR. Once it merges to `main`, `.github/workflows/release.yml` checks the package, publishes it to npm with provenance and tags `v<version>`. npm trusts that workflow as the package's Trusted Publisher, so the repository keeps no npm token. A merge that keeps the version publishes no new release. When the tag job fails after the publish, rerun that run's failed jobs, so the tag lands on the published commit. Until the tag exists, a later merge that keeps the version fails at the publish.

## License

MIT, KK Forge
