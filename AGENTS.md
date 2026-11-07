# artel-collector

`@kk-forge/artel-collector`, the npm library a product uses to send its usage events to the intake service (idea-packer's `/v1/public/relay`). The intake's contract is `GET https://idea-packer-api.kk-forge.com/v1/public/schema`, and its code is `backend/relay` in idea-packer. README.md is the library's own documentation.

## Commands and release

README.md → Development lists the commands, and README.md → Release how a version reaches npm.

## Rules this code relies on

- The core reaches the host only through its clock, `crypto.getRandomValues`, `TextEncoder`, and in `newHttpTransport` `fetch` and `AbortController`. The product gives it the intake's address. The product passes `storage` and `transport`, and may pass `lock` and `clock`. `src/web.ts` and `src/extension.ts` hold the platform recipes, and the core imports neither.
- An event goes to the queue in storage at once and leaves it once the intake answers or a drop rule removes it. A send leases its envelopes and seals each one just before its first request, storing that request's body. Every attempt sends the stored body with its `batch`, the envelope's queue id, byte for byte, since the intake drops only an exact repeat. Each seal drops and reports an envelope whose stored body differs from the body `bodyOf` builds from the envelope. A change to `bodyOf`, or to how the queue reads a stored envelope, drops every envelope an older version sealed. Read `src/queue.ts` and `src/outbox.ts` before changing either.
- Every collector method resolves and never rejects. A failure goes to `onError`.
- Tests drive the collector through `tests/harness.ts`: `FakeClock` owns time and timers, `FakeFetch` the network. No test fakes the global timers.
- The shape checks of a forwarded message and of the stored queue are written by hand, without a schema library. The checks are small, and the package keeps no runtime dependencies.
