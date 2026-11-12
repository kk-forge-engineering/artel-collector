# @kk-forge/artel-collector

Sends a product's analytics events to the intake service. It runs in a website, a web app, a Chrome extension or a desktop window, and has no runtime dependencies.

The collector marks the first event of each local day, week, month, quarter and year, and adds the install age to those events, so the intake counts active users per period without a user id. The collector also keeps a session, holds every event in a queue in storage until the intake takes it, and keeps the user's analytics state.

## Install

```sh
npm install @kk-forge/artel-collector
```

## Modes and states

A channel's mode decides what the product learns about its users and whether it must ask their consent. The admin picks it on the product's card in the intake: a new channel starts as Anonymous, and only the admin raises it. The channel's collector takes the same `mode`. The modes go up: each one learns more about a user and needs more trust.

| `mode`         | In the admin               | What the channel sees                                                                  | Consent                                                           | Suits                                                                                                                           |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `anonymous`    | Anonymous                  | which features users use and how many come per day, week and month, but not who is who | none, and the user can only opt out where the product offers it   | almost every product, such as an extension without accounts that needs its daily and monthly active users and the features used |
| `pseudonymous` | Recognizes returning users | the same, and who came back, how many users stay over time and the browser they use    | before the first id, such as a site banner or a settings checkbox | retention without accounts: how many installs come back after a week, where users leave                                         |
| `identified`   | Recognizes by account      | the same, and a user with an account is one user on all their devices                  | before the first id                                               | a product with accounts, where support looks into a request by account and needs to see what that user did                      |

Pick the lowest mode that is enough: when Anonymous does the job, stay there.

The mode is a ceiling. The user's state decides what the collector sends, and the collector stores it. Every user starts in `anonymous`.

| State          | What the collector sends                                                                                            | Modes                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `opted_out`    | one `opted_out` when the user enters the state, then nothing                                                        | every mode                   |
| `anonymous`    | events with no id and no browser, the primary languages only, ages in coarse buckets                                | every mode                   |
| `pseudonymous` | events with a random install id that the collector makes and stores, the browser, the full languages and exact ages | `pseudonymous`, `identified` |
| `identified`   | the same, with the account id from `getId` in place of the install id                                               | `identified`                 |

- `anonymous` needs no consent. An anonymous channel's options take neither `getId` nor `browser`, and its `setState` takes `opted_out` and `anonymous`.
- `pseudonymous` and `identified` need the user's consent before the product calls `setState` with them. A pseudonymous or identified channel's options take `browser` on the web and in an extension. Only an identified channel's options take `getId`, which they require.
- A state above the channel's mode is a type error. In untyped code `setState` refuses it and reports it to `onError`.
- Leaving `pseudonymous` or `identified` forgets the last id, as `forget(id)` does: the collector drops the id's queued events and asks the intake to delete the id's events. The collector also deletes the install id when the user leaves `pseudonymous`, so a later `pseudonymous` takes a new one.

On a site, the events of the sending states also carry their page path, and the first `page_view` the referring host, as `getPage` describes.

Any site can read the browser and the full language tags. With the exact install age, and with the `platform` and `version` every envelope carries, these fields can single out a user, so only the states with an id, which need the user's consent, send them. Every envelope of those states carries the id. The uninstall query of those states carries the full languages and an exact age up to 31, with no id.

### Languages

- `browserLanguage` is the user's language: the one the browser asks sites for, `navigator.language` by default on the web and in an extension.
- `uiLanguage` is the language the user picked in the product, when the product offers that choice. Only the product's option sets it, on every platform. A product without that choice passes none, and its envelopes carry no `ui_language`.

In the `anonymous` state both are cut to the primary language: `pt-BR` goes as `pt`, `zh-Hant-TW` as `zh`.

## Usage

One line per context makes its collector. `key`, `version`, `endpoint` and `uninstallPage` are variables of the build, and `getId` returns the user's account id in the identified state.

```ts
// a website or a web app
const analytics = newWebCollector({ key, version, endpoint, mode: 'anonymous' });
// a Chrome extension: the service worker, at its top level, and each of its pages, such as the popup
const analytics = newExtensionCollector({ key, endpoint, mode: 'anonymous', uninstallPage });
// a content script of that extension, which hands its events to the service worker
const analytics = newContentScriptCollector();
// a window of a desktop app, such as a Tauri webview, where `platform` is 'macos', 'windows' or 'linux'
const analytics = newDesktopCollector({ key, version, endpoint, platform, mode: 'anonymous' });
```

A channel of another mode passes it, and `getId` in the identified mode, such as `mode: 'identified', getId`. A site whose paths carry a secret or a person passes `getPage: () => ({ page: route.pattern, referrer: document.referrer })` to send the route pattern instead.

Then the product tracks what the user does, and sets the analytics state when the user picks one, here in a pseudonymous channel:

```ts
const analytics = newWebCollector({ key, version, endpoint, mode: 'pseudonymous' });
void analytics.track('report_exported', { format: 'pdf', pages: 12, with_images: true });
void analytics.setState(consented ? 'pseudonymous' : 'anonymous');
void analytics.setState('opted_out'); // the user turned analytics off
```

The collectors do the rest themselves:

- Every collector sends its queue a few seconds after an event, as "Sending" describes. In an extension, the service worker sends what a page or popup queued, even after it closed.
- The extension's service worker sends `installed` and `updated` at Chrome's `onInstalled`, tracks the events content scripts forward, and listens to `onStartup`, so Chrome starts the worker with the browser.
- An extension collector with `uninstallPage` keeps Chrome's uninstall page up to date with the user's state.
- A desktop window sends `installed` and `updated` when they are due.

`newWebCollector` comes from `@kk-forge/artel-collector/web`, `newExtensionCollector` and `newContentScriptCollector` from `@kk-forge/artel-collector/extension`, `newDesktopCollector` from `@kk-forge/artel-collector/desktop`, and `newCollector` from the main module. Each platform constructor fills in the defaults in the table below and passes the result to `newCollector`. The web and extension constructors set `platform`, and the desktop one takes it. An option left out or `undefined` takes its default. Each constructor takes `mode` as the literal `'anonymous'`, `'pseudonymous'` or `'identified'`, and returns a collector whose `setState` takes only that channel's states. A `mode` known only at run time goes in options typed `CollectorOptions`, `WebCollectorOptions`, `ExtensionCollectorOptions` or `DesktopCollectorOptions` and built per mode, and gives a collector whose `setState` takes every state. `newContentScriptCollector` takes no channel options, as "`@kk-forge/artel-collector/extension`" describes.

Each constructor throws a `TypeError` that names the option when the options would make the intake refuse every envelope. A mistake in the build then fails its first run and its tests. That is a `key`, `platform` or `version` the intake does not take, an `endpoint` that is not `https`, or a `transport` that is not a function, as "Options" describes. It also throws for a `browser` on a desktop platform, which only untyped code passes and whose envelopes the intake refuses. The message never quotes the endpoint, so it carries no password. `newWebCollector`, `newExtensionCollector` and `newDesktopCollector` also throw where `navigator` is missing, unless the options pass `browserLanguage`. Node 21.2 and later define `navigator.language`, so server rendering there builds a collector with the server's language. `newExtensionCollector` also throws outside an extension context unless the options pass `version`. `newContentScriptCollector` never throws. A `browserLanguage` or `uiLanguage` that breaks the format throws nothing: the collector leaves it out and reports it to `onError`, since it often comes from the browser.

| Option                              | `newWebCollector`                | `newExtensionCollector`          | `newDesktopCollector`                 |
| ----------------------------------- | -------------------------------- | -------------------------------- | ------------------------------------- |
| `platform`                          | `web`                            | `extension`                      | required: `macos`, `windows`, `linux` |
| `version`                           | required                         | the manifest's                   | required                              |
| `storage`                           | `newLocalStorageAdapter()`       | `newChromeStorageAdapter()`      | `newLocalStorageAdapter()`            |
| `lock`                              | `newWebLock()`                   | `newWebLock()`                   | `newWebLock()`                        |
| `browserLanguage`                   | `navigator.language`             | `navigator.language`             | `navigator.language`                  |
| `uiLanguage`                        | none                             | none                             | none                                  |
| `getPage`                           | `pageFields`, see below          | not taken                        | not taken                             |
| `browser`, pseudonymous, identified | `() => detectBrowser(navigator)` | `() => detectBrowser(navigator)` | not taken                             |
| `uninstallPage`                     | not taken                        | none                             | not taken                             |

### Options

- `key`: the channel key. It comes in as a variable at build time, so the code holds no key and one commit builds every target. A channel has a live key, `<kind>-<10 characters>`, for the build for the store and a test key, `<kind>-test-<10 characters>`, for any other build. The kind is `extension`, `desktop` or `site`, and the 10 characters are lowercase letters and digits. The intake marks test events and keeps them out of the product's analytics. The live key is no secret. The test key stays out of the build for the store, since anyone who has it can read the channel's test events. A key that breaks this form, or whose kind does not take `platform`, makes the constructor throw, since the intake would refuse every envelope.
  - The origins the intake takes a request from, per channel kind. A test key of any kind also takes the origins of a developer build: the `chrome-extension://` origin of any real Chrome id, 32 letters from `a` to `p`, and `http://localhost` and `http://127.0.0.1` on any port. Any other origin, and a request with no `Origin`, gets 403, which drops the envelope and reports it.

    | Kind        | Origins                                                       |
    | ----------- | ------------------------------------------------------------- |
    | `site`      | the one origin the channel sets                               |
    | `extension` | `chrome-extension://<id>` for the Chrome Web Store id it sets |
    | `desktop`   | `tauri://localhost` and `http://tauri.localhost`              |

  - An extension channel without a Chrome Web Store id takes no live request.
  - These get 403 with either key: a Tauri 2 window on Windows with `useHttpsScheme`, whose origin is `https://tauri.localhost`; a dev server over `https://localhost`; a Firefox extension, whose origin is `moz-extension://`; and a `transport` that sends from Rust, as Tauri's HTTP plugin does, with no browser `Origin`.
- `mode`: `'anonymous'`, `'pseudonymous'` or `'identified'`, as "Modes and states" describes. `Mode.Anonymous`, `Mode.Pseudonymous` and `Mode.Identified` name the same values. Another value, which only untyped code can pass, works as `'anonymous'`.
- `endpoint`: the intake's relay address, whose path is `/v1/public/relay`. The channel's admin gives the address. The collector posts each envelope there with `keepalive`, without cookies or a referrer. It posts a forget request the same way to the endpoint with `forget` in place of the path's last segment, `relay`, so to `/v1/public/forget`. A slash after `relay` goes with it, and the endpoint's query stays, as on the envelopes' address. An `endpoint` that is not `https`, or that names a user or a password, which `fetch` refuses, makes the constructor throw. Plain `http` is taken only for development, to `localhost`, `127.0.0.1`, `[::1]`, a host under `.localhost` or one under `.test`.
- `transport`, in place of `endpoint`: a function that delivers a request body. It must resolve within 30 seconds to `{ status, retryAfter }`, the intake's HTTP status and the raw value of its `Retry-After` header, or to the status alone. The status is `0` when the request did not reach the intake. A transport that rejects counts as `0`. So does a transport that has not resolved after 35 seconds, and an answer whose status is no whole number from 0 to 599, an answer with no status included. A `retryAfter` that is not a string counts as none, and an answer of `null` or `undefined` as `0`. `newHttpTransport` resolves to the object. A `transport` that is not a function, which only untyped code can pass, makes the constructor throw. With a `transport`, the collector never reads `endpoint`. The collector also hands the transport each forget request, a body `{"key":…,"id":…}` with no `events`, which goes to the intake's `/v1/public/forget`, and reads its answer the same way. A transport written for 0.3.0 posts every body to the relay, so it must now post a body without `events` to `/v1/public/forget`.
- `platform`: the platform of the envelope, `'web'`, `'extension'`, `'macos'`, `'windows'` or `'linux'`, also `Platform.Web` and so on. It is not the kind of the channel in the intake's admin, `site`, `extension` or `desktop`. A `site` channel takes `web`, an `extension` channel `extension`, and a `desktop` channel `macos`, `windows` or `linux`, and `key` names the kind. Another platform, which only untyped code can pass, makes the constructor throw.
- `version`: the product version, required on every platform, up to 32 characters: one to four dot-separated numbers, then an optional `-` prerelease and `+` build of letters, digits and dots, such as `1.2.3` or `1.2.3-beta.1`. The intake refuses an envelope without one, so a version that is missing or breaks this format makes the constructor throw. Chrome's own manifest versions all fit it.
- `browserLanguage` and `uiLanguage`: as "Languages" describes. Each is a language tag of up to 16 characters: two or three lowercase letters, then up to two `-` parts of 2 to 8 letters or digits, such as `en`, `pt-BR` or `zh-Hant-TW`. The collector reads `_` as `-`, so `en_US` goes as `en-US`. The intake refuses a whole envelope whose language breaks this format, so the collector leaves such a language out and reports it to `onError`.
- `storage`: where the collector keeps its state. See "Storage".
- `getId`, identified only: returns the user's account id, up to 64 characters, or `undefined` while the product does not know it yet, as before sign-in loads. It may return a promise of either. The collector calls it only in the `identified` state, and never creates an id. Events of the identified state wait in the queue until `getId` returns an id. A longer id is reported and counts as not known yet. An empty string, or a value that is not a string, such as the `null` of untyped code, also counts as not known yet, without a report. A `getId` that throws loses the event being recorded, or stops the send that called it, and the queue waits for the next send. Both go to `onError`. Events that wait go under the next id only when it is the last id `getId` gave, or when it gave none before. When `getId` gives another id, as after a sign-out and another user's sign-in, or after a change from `pseudonymous`, the collector drops the unsent events of the last user and those that waited after them, and starts a new session. So no event goes under another user's id. Two contexts that see different users at once each drop the other's unsent events. `getId` runs while the collector holds its lock. So `getId` must resolve, and must call no method of the collector, or every later call waits forever.
- `browser`, pseudonymous and identified only, web and extension only: the browser the product runs in, `{ name, major }`, or a function that returns it or `undefined`. The function runs under the lock too, with the same rule as `getId`. The collector calls the function once, for the first event with an id, so the anonymous state never reads the browser. The collector sends a copy. A name the intake does not list goes as `other`, and a major version outside 1 to 999 is left out. A browser on a desktop platform, which only untyped code can pass, makes the constructor throw.
- `getPage(name)`: returns `{ page, referrer }` for an event named `name`. `page` is the page's path or its full URL, and `referrer` a URL. Only platform `web` takes it and sends the two fields, since the intake keeps them only for a `site` channel. Another platform never calls it. The collector calls it when the method is called, so a navigation right after `track` does not move the event. `newWebCollector` takes `pageFields` by default. The collector shapes whatever `getPage` returns by the rules below. The intake masks the page by wider rules of its own and stores the event without such a referrer, so a stored page may hold an `:address` the collector did not send.
  - The page goes as its path only, as the platform `URL` reads it, so the query and the fragment go nowhere. Each segment is cut at its first `;`, so a path parameter such as `/cart;jsessionid=…` goes as `/cart`. The path is cut to 256 characters, never inside an escape.
  - Each segment that holds an e-mail address or an IP address goes as `:address`, so `/u/alice@example.com` goes as `/u/:address`. An `@` counts, and so do `＠` (U+FF20) and `﹫` (U+FE6B), which a browser shows alike. So do four dotted numbers, as in `10.0.0.1`, and an IPv6 address, as in `fe80::1`. A four-part version counts too, so `/docs/1.2.3.4` goes as `/docs/:address`. The collector reads the segment as written and decoded up to twice, so `%40` and `%2540` count as `@`. An escape that does not decode as UTF-8 stays as written, and the ASCII escapes around it still decode, so `/u/caf%E9%40mail.com%` goes as `/u/:address`.
  - A segment that starts a URL goes with the rest of the path as one `:address`. It holds a scheme and `://`, as in `/login/next=https%3A%2F%2Fsite.com`, or ends in a scheme's `:` before an empty segment, as in `/open/myapp://item`. It also holds `http:`, `https:`, `ws:`, `wss:`, `ftp:` or `file:` in any case, at its start or after a character that is not a letter or a digit, as in `/go/https:site.com`.
  - The collector leaves out a page that `URL` cannot read, or whose path does not start with `/`, such as `mailto:alice@example.com`. The report names no part of the page. It also leaves out and reports a field that is not a string.
  - The referrer goes as the lowercased host of a URL. The collector sends no referrer for text that is no URL, such as a bare `www.google.com`. It also sends none for a host longer than 128 characters, the most the intake keeps, or a host that is an IP address or holds an `@`. `URL` writes every IPv4 form a browser reads as four decimal numbers, so a host whose last label is a number counts as one. The referrer goes only with the first `page_view` the collector records, which on a site is the first of a page load. A referrer of the same host as a page given as a full URL goes nowhere.
  - The collector sends no `page_view` of the page the last recorded `page_view` sent, so two in a row for one page send one. A recorded `page_view` without a page ends that run. A `page_view` the collector does not record, as in the `opted_out` state, counts for neither rule.

  A site whose paths carry another secret or person, such as `/share/<token>` or `/u/<name>`, passes its own `getPage` that returns the route pattern, such as `/share/:token`.

- `lock`: a function that takes an async operation, runs it while no other context that shares `storage` runs one, and resolves or rejects as the operation does. It must run the operation exactly once and hold the lock until the operation's promise settles, as `navigator.locks.request` does. The collector never asks for it while it holds it. The collector runs each method, and each queue change of a send, under it. Without it, two contexts recording at once may both mark the first event of a day, overwrite each other's queued events or send one envelope twice. The rule that no event goes under another user's id then holds only within one context, and so does the opt-out: an event another context records during `setState('opted_out')` may still leave. Each collector runs one of its own operations at a time with or without a lock.
- `sessionIdleMinutes`: minutes without events that end a session, 10 by default. A value that is not a finite number from 0 takes the default, and so does one of `sendDelaySeconds`.
- `sendDelaySeconds`: the longest an event waits in the queue before a send starts, 5 by default.
- `clock`: time and timers, the host's own by default. Tests pass a fake.
- `onError`: receives each failure the collector does not retry. An `onError` that throws is ignored. A report quotes at most 64 characters of host or stored text, and never a page. It receives:
  - an event `track` refuses;
  - an event or envelope dropped by a limit, by its age or by the intake's refusal;
  - a forget request the intake refuses, once, since the collector does not send it again;
  - a stored queue that is no JSON list, which the collector reads as empty;
  - a stored retry wait more than 5 minutes ahead or that is no time;
  - a language the collector leaves out, a state `setState` refuses, an id past 64 characters, an id `forget` refuses, a transport status that is no HTTP status, a page the collector leaves out, and a page field that is not a string;
  - a storage, lock, `getId`, `browser` or `getPage` error, an extension worker's `setAccessLevel` that fails, and an `uninstallPage` that is no URL or that Chrome refuses.

  A request that goes again later, after a network failure, 429 or 5xx, does not reach it. Its envelope reaches it only when a drop rule removes it. These reach no `onError` of the collector: a forwarded event the extension worker refuses or drops, and a `forwardTrack` or a content script's `track` that fails.

### Methods

Every method returns a promise that resolves and never rejects. A failure goes to `onError`. So a call whose result you do not wait for is marked `void`, as in the examples.

- `track(name, params?)` records an event. It records nothing in the `opted_out` state. The name and each param name must be on the product's allowlist and match this form: a lowercase letter, then lowercase letters, digits and `_`, up to 40 characters. An event takes up to 16 params. A param value is a string up to 64 characters, a finite number or a boolean. The intake also drops an event whose string param looks like an address, a domain or an IP, a four-part version such as `1.0.0.1` included. The collector does not check this rule, so `onError` does not hear of such a drop. A system event takes only its own params:

  | Event                         | Params                                                                                        |
  | ----------------------------- | --------------------------------------------------------------------------------------------- |
  | `page_view`, `welcome_opened` | none                                                                                          |
  | `install_click`               | `product`, a string                                                                           |
  | `uninstalled`                 | `age_days`, a whole number from 0, and `active_days`, one of `0`, `1`, `2-5`, `6-20` or `21+` |

  The intake keeps `welcome_opened` and `uninstalled` without an id at most once an hour per source, and drops the rest.

  The collector refuses an event that breaks one of these rules, and `installed`, `updated` and `opted_out`, which only its own methods send. It reports a refused event to `onError`, naming the rule it breaks, and queues none of it. `track` copies the params once, when it is called, so a later change to the object reaches neither the check nor the event. Params whose reading throws, as a getter or a proxy may, go to `onError`, and nothing is recorded. The intake also drops the whole event when a param is off the allowlist or an enum param's value is off its list. The collector does not know the allowlist, so it cannot refuse these.

- `installed()` sends `installed` once per install. A later call sends no event. The extension's service worker and `newDesktopCollector` call it and `updated()` themselves, and a website calls it where its product counts an install. In the `opted_out` state it sends nothing and marks nothing, so a user who turns analytics back on still sends it.
- `updated()` sends `updated` when `version` differs from the last version `installed()` or `updated()` stored, or when none is stored. Call it after `installed()`, so that a fresh install does not also count as an update. In the `opted_out` state it sends nothing and marks nothing.
- `setState(state)` stores the user's analytics state and starts a new session, so events from before and after the change share no session. The same state again does nothing.
  - To `opted_out`: stores the state first, then drops the events not sent yet and sends one `opted_out`. It goes at once, or at the end of a retry wait that is running. An `opted_out` from an earlier opt-out that has not gone yet stays queued. The `opted_out` goes in an envelope of its own, with no id, no browser, no first-of-period mark and no age, so no count of active users takes it. Its session is new and no other event shares it. A run that stops after storing the state drops the queue on the first call of its next run. If that run stopped before it queued the `opted_out`, none is sent.
  - From `pseudonymous` or `identified`, to any other state: forgets the last id, as `forget(id)` does, and drops the queued events of that state, those waiting for an id included. A change between `pseudonymous` and `identified` thus counts as another user. The collector also deletes the install id when the user leaves `pseudonymous`. A change to a state without an id stores the state first. A run that stops after that forgets the last id on the first call of its next run. A change between `pseudonymous` and `identified` forgets the last id first, so a run that stops in between keeps the old state with its id forgotten.
  - A state above the channel's mode is refused: a type error, and `onError` in untyped code.
- `getState()` resolves to the stored state, `anonymous` until the user chose. It also resolves to `anonymous` when the storage fails, whatever the user chose, and reports the failure. On the first call of any method, a stored state above the channel's mode becomes `anonymous`, as `setState('anonymous')` would make it, as after the admin lowered the mode.
- `flush()` sends what is queued now and resolves once that send ends. While the wait after a failed request runs, it schedules the send for the end of the wait instead. The collector sends within `sendDelaySeconds` without it, as "Sending" describes, so `flush()` is only for a product that wants to send sooner.
- `forget(id)` drops the queued events of this id and asks the intake to delete the id's events, with `{ key, id }` to its `/v1/public/forget`. The product calls it for an account id the collector does not hold, such as one `getId` no longer gives. Leaving a state with an id does the same for the last id by itself. An `id` that is not a string of 1 to 64 characters, which the intake refuses, is reported and drops nothing. When this id is the last one `getId` gave, it also drops the events that wait for an id. The next id `getId` gives then counts as another user, so the events that waited after the forget never go under it. The collector stores the request until the intake answers it, and sends it after this collector's request in flight, which may carry the id, and before the queued envelopes. It resolves once that send ends. A forget answered 0, 429 or 5xx goes again under the wait rules of "Sending", and any other status outside 2xx drops it and reports it. The intake checks the request's `Origin` as it checks a relay request. With a test key the collector forgets the id and drops its events here but sends no request and reports nothing: the intake answers a test key's forget 403, since it would delete the user's live events too, and test events go when the channel's test data is cleared. The collector stores only the ids of its forget requests, and sends each with its own key. It drops a stored id that is not 1 to 64 characters unsent. The intake deletes the id's events in every channel of the product within a minute, and those that arrive up to a minute after the forget. A request another context sent arrives within its 30-second limit.
- `uninstallParams()` resolves to the query of an uninstall page. It resolves to `undefined` in the `opted_out` state, and when the storage fails. The query is `{ platform, version, browser_language, ui_language, age_days, active_days }`, each shaped by the state as an envelope is. `age_days` is days since install, and `active_days` the bucket of active days, the local days whose first event is queued or sent: `0`, `1`, `2-5`, `6-20` or `21+`, the values of `ActiveDaysBucket`. The uninstall page that `uninstallPage` sets carries the values of its last refresh, so on the install day it keeps `active_days=0` until the user's state changes or the worker starts again. A day leaves the count when the event that took its first-of-day mark gives its marks back, as "Sending" describes. The next event of that day counts it again. The uninstall page is a page of the product's site. It sends `uninstalled` from its own `site` channel, with the params `age_days`, as a JSON number, and `active_days`. `track('uninstalled')` sends `age_days` shaped by the state as `uninstallParams()` gives it. The `platform`, `version` and languages in the query are for the page itself and are not params of the event.

### Other exports

`detectBrowser(nav)` names the browser from the `userAgentData.brands` and `userAgent` of the `navigator` it is given. It returns `{ name, major }`, where `name` is `chrome`, `edge`, `opera`, `yandex`, `brave`, `firefox` or `safari`, and leaves out a major version outside 1 to 999. Any other browser is `{ name: 'other' }`. Chrome is named only by its brands, since every Chromium browser carries Chrome's User-Agent token. It returns `undefined` when `nav` has neither a Chromium brand nor a User-Agent.

The main module also exports the checks of "Testing", `newHttpTransport(endpoint, { fetch, clock }?)`, the transport behind `endpoint`, `newMemoryStorage()`, `systemClock`, `Mode`, `AnalyticsState`, `Platform`, `ActiveDaysBucket` and `BrowserName`, and the types of every option, method and value above. `WebCollectorOptions`, `ExtensionCollectorOptions` and `DesktopCollectorOptions` come from their own modules.

## Sending

The collector writes each event to the queue in storage at once. A send starts at most `sendDelaySeconds` after the first event waiting, so the events of those seconds share one request. An envelope of 100 events goes at once. An event that would take an envelope past 60 kB starts a new one.

The queue lives in storage, so every event outlives the page that recorded it. A page or a window that closes within the send delay after its last events leaves them queued. They go with the first send of a later visit or launch, which starts once that visit tracks an event. The collector does not send when a page is hidden: a send reads the storage and takes the lock before its request, and a closing page is gone by then. In an extension, the service worker sends what its pages queue, even after a page closed. It listens to `chrome.storage.onChanged` for the channel's queue and sends within the send delay of the page's write. A page still sends on its own as well, and the leases keep an envelope from going twice.

An envelope leaves the queue once the intake answered it, or by a drop rule, so a host stopped at any point keeps its queued events. Its next run sends the queue. A context that sends an envelope holds a one-minute lease on it and renews the lease before each request, so no other context sends it at the same time. An envelope whose sender stopped goes with the first send after that lease runs out. A lease that ends more than a minute ahead, as after the clock was set back, counts as run out. A failed request ends the lease, so the first send of any context after the retry wait below takes the envelope. Each envelope carries a `batch` key, and every attempt sends the body of the first attempt byte for byte. Events tracked after the first attempt go into a new envelope. The intake drops a repeat of an envelope it stored in the last 72 hours. The collector stops repeating an envelope within that time, by the rule for old events below. A 503 can also come back after the intake wrote part of an envelope. The intake catches the repeat of such an envelope only while it remembers that write among its last 10 000 inserts. Past that, part of the envelope is stored twice.

Each send first sends the stored forget requests, as `forget(id)` describes, then the envelopes. When the request fails or the intake answers 429 or 5xx, the envelope keeps its place. It goes again after 1 second, then after 2, 4 and so on, up to 5 minutes. The intake sends `Retry-After` with a 429, in seconds or as an HTTP date, and the collector reads it from a 503 too. The collector reads a date with `Date.parse`, which also takes other forms of a date. It then waits that long instead if it is longer, up to the same 5 minutes. The collector stores the end of the wait, so every context that shares the storage keeps it, and so does `flush()`. A shorter wait never replaces a longer one stored. A stored end more than 5 minutes ahead, as after the clock was set back, or one that is no time, counts as 5 minutes from now. New events wait for that retry. At most 20 envelopes wait, those waiting for an id included. Past 20 the oldest is dropped and reported, but never an `opted_out`. At most 2 `opted_out` envelopes wait, and a third drops and reports the oldest of them. Any other status outside 2xx, such as a 3xx, 400, 403 or 413, drops the envelope and reports it.

Just before its request, the collector drops an envelope that holds an event dated before yesterday in UTC, and reports it. The intake would move such an event to its own today, and a sent envelope goes whole or not at all. An envelope of the identified state stays queued while `getId` returns `undefined`, and the envelopes after it go. Once `getId` returns an id, the envelope goes with that id, and with the browser, under the same rule for old events.

Any script that can write the storage can also write the queue. Such a script can already call `track` and post to the intake with the public key, so the collector checks a stored queue only for the shape it reads. It reads a stored queue that is no JSON list as empty and reports it once, and skips an item without a queue id and an envelope with a list of events. The intake applies every rule of its own to whatever arrives.

The marks an event takes go back when the collector drops it before any request carried it. The drops that give them back are a change of state, another id, the 20-envelope cap, the rule for old events, and a failure while the event was recorded. So the next event takes the first-of-period marks and counts its day again, and `installed()` and `updated()` send again. An envelope a request carried keeps its marks whatever drops it later, since the intake may have stored it. `forget` gives back the marks of the id's queued envelopes, those a request carried included, since the intake deletes their events, and so does leaving a state with an id for the last id.

## Storage

`storage` is any `{ get(key), set(key, value) }` over strings that returns promises. `get` resolves to the stored string, or to `undefined` for a missing key. The collector reads any other value, such as the `null` of some stores, as a missing key. A `get` must see every `set` that resolved before it, in every context that shares the storage. The collector never removes a key. Every key is `artel.<key>.<name>`, where `<key>` is the channel key, such as `artel.site-aa131n3j11.queue`. Collectors of different keys over one storage share no stored value, so a live and a test build, or two products on one origin, keep their own state and queues. The storage holds the state, the install day, the install mark and the last version. It also holds the session and the time of its last event, the first-of-period marks, the active days and the end of the retry wait. It holds the queue, whose envelopes of the states with an id carry the id, the last id the collector sent, the install id of the pseudonymous state and the forget requests not answered yet. The queue is one value: up to 20 envelopes of up to 60 kB each, and the request body of each sealed one.

A `get` or `set` that fails goes to `onError`, and the method that called it stops there. A `set` that fails while an event is recorded loses the event, and the event gives back its marks.

`newMemoryStorage()` keeps the state only while the page or worker lives. The platform modules below bring adapters over `localStorage` and `chrome.storage.local`.

## Platform modules

The core touches no platform API. Three optional modules hold the code a website, an extension or a desktop app would otherwise write for itself.

### `@kk-forge/artel-collector/web`

For a website or a web app. The desktop module builds on its storage and lock.

- `newWebCollector(options)` makes a collector for a website or a web app, as in "Usage".
- `newLocalStorageAdapter()` returns a `storage` over `localStorage`. Every script of the origin can read it, the queued events with their `id`, the last id and the install id included, and no other storage of the origin hides them from its scripts. A site that runs untrusted scripts uses an anonymous channel.
- `newWebLock()` returns a `lock` over the Web Lock named `artel`, shared by the tabs and workers of one origin. Without Web Locks, operations run unguarded.
- `pageFields()` gives the page's address without its query string and fragment, and `document.referrer`. `newWebCollector`'s default `getPage` takes it, and the collector shapes both as "Options" describes under `getPage`.
- `trackPageViews(collector)` sends `page_view` for the page now and for each later navigation: `history.pushState` and `replaceState`, `popstate`, and the Navigation API's `currententrychange` where the browser has it. A navigation that keeps `location.pathname` sends none. So a change of the query or the hash alone sends none, and a router that keeps its routes in the hash gets one `page_view` per page load. A navigation that both `pushState` and the Navigation API report sends one. Two trackers of one collector each send their own, which the collector of platform `web` takes as one, since it sends no `page_view` of the page its last one sent. A tracker counts a path whether or not the collector records its `page_view`, so a page loaded in the `opted_out` state sends a `page_view` at the first navigation to another path after the user leaves that state. Leaving `opted_out` sends none by itself. `page_view` is a system event, which the intake counts without the product's allowlist. It returns the function that stops it. Once every tracker stopped, in any order, `history` is as they found it: a method the page inherited from `History.prototype` is inherited again. A product that wraps a method after the tracker keeps its wrapper, and the stopped tracker's wrapper under it stays and only passes calls on.

`newWebCollector` needs `localStorage`, which a Web Worker lacks, so a worker passes its own `storage`. Its default `getPage` sends no page where there is no `document` or `location`.

A site sets up page views in two lines:

```ts
import { newWebCollector, trackPageViews } from '@kk-forge/artel-collector/web';

const analytics = newWebCollector({ key, version, endpoint, mode: 'anonymous' });
trackPageViews(analytics);
```

### `@kk-forge/artel-collector/extension`

For a Chrome extension. Its service worker and its pages each make a collector with `newExtensionCollector`. They share `chrome.storage.local` and Web Locks, so they keep one queue and one state.

- `newExtensionCollector(options)` makes a collector for the service worker or a page, as in "Usage". It needs the `storage` permission. In the service worker it closes `chrome.storage.local` to content scripts with `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, since a content script that could write the user's analytics state, the queue and the last id `getId` gave could send events the user refused. The collector reads and writes no storage until Chrome answers the call, and a failure of the call goes to `onError`. The call runs only in the service worker, so build the collector at the top level of the worker: until it runs, content scripts keep access to `chrome.storage.local`. The call closes the whole `chrome.storage.local` area, every key and not only the collector's, even when the product passes its own `storage`. So a content script of the product that reads its own settings there must get them from the worker instead. `setAccessLevel` needs Chrome 102 or later. The collector calls it again on each start of the service worker.
- `newChromeStorageAdapter()` returns a `storage` over `chrome.storage.local`.
- `newContentScriptCollector()` returns the collector of a content script, typed `ContentScriptCollector`: `track` only. Its `track` is `forwardTrack`, so the worker's collector checks, queues and sends the event under the user's analytics state. The state lives in the service worker and the extension pages, so a content script can neither read nor change it, and its types say so. It reads no storage, needs no key, version or endpoint, and never throws.
- `forwardTrack(name, params?)` hands an event from a content script to the service worker. A content script's own requests carry the page's origin, which the intake refuses. It never rejects. While the worker cannot take the message, as during an update, the event is lost.
- The service worker's collector tracks the events content scripts forward. It takes them only from this extension, and only the product's own events. It refuses every system event of the intake, which the intake counts from any product without its allowlist: `installed`, `updated`, `opted_out`, `uninstalled`, `welcome_opened`, `page_view` and `install_click`. It also refuses each event `track` refuses. A page can open any number of frames that run the content script. So the worker tracks at most 60 forwarded events a minute from all tabs and frames together, a guard against a flood, and drops the rest. It reports the first event it drops in a minute to `onError`. It keeps the count in memory, so a restart of the worker starts it again.
- The service worker's collector sends `installed` at Chrome's `onInstalled` with reason `install`, and `updated` with reason `update`. It also adds an empty `onStartup` listener, so Chrome starts the worker with the browser and the worker closes the storage again before content scripts run. Chrome needs these listeners registered synchronously at the worker's top level on every start of the worker, so build the collector there. A product may add `onInstalled` listeners of its own, such as one that opens a welcome page.
- `uninstallPage`, an option of `newExtensionCollector`: the address Chrome opens when the user removes the extension. The collector sets it with the fields of `uninstallParams()` added to its query, or alone when `uninstallParams()` resolves to `undefined`, at construction and after each `setState`, in the worker and in each page, since Chrome keeps the address as it was set. Before a change to `anonymous` or `opted_out` it sets the page alone, so the earlier state's fields are gone while the change runs. A write that began before the latest `setState` is dropped. Left out, the collector sets no uninstall page.

```ts
// service worker
import { newExtensionCollector } from '@kk-forge/artel-collector/extension';

const analytics = newExtensionCollector({
  key,
  endpoint,
  mode: 'anonymous',
  uninstallPage: 'https://example.com/uninstall',
});

// content script
import { newContentScriptCollector } from '@kk-forge/artel-collector/extension';

const analytics = newContentScriptCollector();
void analytics.track('link_shared', { target: 'clipboard' });
```

### `@kk-forge/artel-collector/desktop`

For a window of a desktop app, such as a Tauri webview.

- `newDesktopCollector(options)` makes a collector for a desktop window, as in "Usage". It takes `platform` as `'macos'`, `'windows'` or `'linux'`, the platforms a `desktop` channel takes. Its windows share the webview's `localStorage` through `newLocalStorageAdapter()` and its Web Locks through `newWebLock()`, so they keep one queue and one state. It sends `installed` and `updated` when it is built, each only when due, so every window may build one. Events of the last seconds before the app closes go at its next launch, as "Sending" describes. It names no browser and sends no page.

## What is sent

One envelope per request. An envelope in the `anonymous` state, in any channel:

```json
{
  "key": "extension-aa131n3j11",
  "platform": "extension",
  "version": "4.2.0",
  "browser_language": "pt",
  "ui_language": "en",
  "session": "k3j9x2m1qa0b",
  "events": [
    {
      "name": "report_exported",
      "day": "2026-10-29",
      "first": ["day", "week"],
      "age_days": 2,
      "params": { "format": "pdf", "pages": 12, "with_images": true }
    }
  ],
  "batch": "9f2c41d07ab35e18"
}
```

- `browser_language` and `ui_language` are the two languages "Languages" describes, each present when the collector has it.
- `day` is the local calendar date. `first` lists the periods this event is the first of, in local time. Weeks are ISO weeks and start on Monday.
- `age_days` comes with the `day` mark, and counts days since install. `age_months` comes with the `month` mark, which a `quarter` or `year` mark always comes with, and counts months since install. The install date is the local date of the collector's first use. In the `anonymous` state each age is the lowest value of its bucket:
  - `age_days`: `0`, `1`, `2` for 2 to 6 days, `7` for 7 to 13, `14` for 14 to 29, and `30` for 30 or more.
  - `age_months`: `0`, `1`, `2`, `3` for 3 to 5 months, `6` for 6 to 11, `12` for 12 to 23, and `24` for 24 or more.
- `session` is 12 random characters from `[0-9a-z]`, a window of activity. A new one starts after `sessionIdleMinutes` without events, with the event that takes the `day` mark, at each change of state and when another id comes.
- `batch` is 16 random hex characters per envelope, the same on every attempt to send it.
- `key`, `platform` and `version` name the channel and the build, as "Options" describes.
- `params` holds what the product passed to `track`.
- `page` and `referrer` are present only on platform `web`, when `getPage` returns them, as it does by default.

In the `pseudonymous` and `identified` states the ages are exact: `age_days` from 0 to 30, where 31 stands for 31 or more, and `age_months` from 0 to 24, where 25 stands for more than 24. The languages are whole, and the envelope adds `browser`, the browser on the web and in an extension, `id` and `id_kind`. In the `pseudonymous` state `id` is the install id, 32 lowercase hex characters from `crypto.getRandomValues`, and `id_kind` is `pseudonymous`:

```json
{
  "browser_language": "pt-BR",
  "ui_language": "en",
  "browser": { "name": "chrome", "major": 131 },
  "id": "3f9a0c4e1b7d26a85e0f4c91d2b7a630",
  "id_kind": "pseudonymous"
}
```

In the `identified` state `id` is the account id from `getId`, and `id_kind` is `identified`. The intake keeps the id only when its kind is within the channel's mode. It stores an event whose id it drops as one without an id: no browser and no session, the primary languages only, and the ages in buckets.

The `opted_out` event that `setState('opted_out')` sends:

```json
{ "name": "opted_out", "day": "2026-10-29" }
```

The core reads no page, URL or user input. `params`, the account `id` and the page fields carry only what the product passes, and the page fields only as the collector shapes them.

## Testing

`@kk-forge/artel-collector/testing` serves a product's own tests:

- `newRecordingCollector(mode?, { onError }?)` returns a `Collector` that sends nothing and records each event it takes in `events`, as `{ name, params }`. `mode` is the channel mode, `anonymous` by default. The user starts in `anonymous`. It refuses an event `track` refuses, a state above the mode and an id `forget` refuses, with the same report to `onError`, so a test catches a bad event name or param. It records what the real collector sends: `opted_out` once at the opt-out and nothing after it in that state, `installed` once, and `updated` only when neither was recorded before, as for one version. `uninstallParams()` resolves to `undefined`.
- `queuedEvents(storage, key)` resolves to the `{ name, params }` of the events a real collector of channel `key` holds queued in `storage`, oldest first. It writes nothing, and reads a stored queue that is no JSON list as empty.

The main module exports three checks that read no `chrome`, `navigator` or storage, so a build script or a test can call them:

- `checkOptions({ key, version, platform, endpoint })` throws the `TypeError` a constructor throws for these options, and returns otherwise. It takes `transport` in place of `endpoint` too.
- `isTestKey(key)` tells whether `key` is a channel's test key, `<kind>-test-<10 characters>`.
- `checkEvent(name, params)` returns the problem `track` would report for the event, or `undefined` when it takes it.

## Development

```sh
mise install
mise run setup
mise run check     # types, oxlint, format, build, tests
mise run check:ci  # the same with coverage, as CI runs it
```

## Release

Versions follow semver: a breaking change to the API this README describes raises the major version, or the minor one before 1.0.0. `src/exports.unit.test.ts` holds the names of that API's values and types. Raise `version` in `package.json` in a PR, as `X.Y.Z`: the release workflow takes no prerelease version. Once it merges to `main`, `.github/workflows/release.yml` runs the shared [Release npm](https://github.com/kk-forge-engineering/gh-actions/blob/main/.github/workflows/release-npm.yml) workflow. It checks the package and waits for a reviewer of the `production` environment to approve the publish. It then publishes the package to npm with provenance and tags `v<version>`. npm trusts `release.yml` as the package's Trusted Publisher, so the repository keeps no npm token. A merge that keeps the version publishes no new release.

## License

MIT, KK Forge
