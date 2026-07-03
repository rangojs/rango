# PPR shell caching and resume (revived streams)

If you're about to touch the shell-cache middleware, the SSR capture/resume
strategies, or the render orchestration around them, start here. This doc is
the contract the implementation was built against, and it records why each
piece has the shape it has.

## The problem

Even on a full segment/prerender cache hit, the worker re-does the whole HTML
tier per request: deserialize stored Flight segments, re-encode a fresh Flight
stream (`src/rsc/rsc-rendering.ts`), then run a complete fizz render over it
(`src/ssr/index.tsx`). The HTML is never cached below the coarse all-or-nothing
document cache (`src/cache/document-cache.ts`). TTFB always pays for the shell
render and every upstream read it needs.

React 19.2 shipped Partial Pre-rendering in **stable**: `prerender` from
`react-dom/static` returns `{ prelude, postponed }` when aborted mid-suspense,
and `resume` from `react-dom/server` continues that exact render, emitting only
the postponed holes. The repo's pinned react/react-dom/vendored RSD (19.2.6)
all carry the full surface — verified by runtime probe, not just export lists.

So: cache the rendered HTML **prelude** plus the postponed state, serve those
bytes on the first read of the request, and resume fizz for just the live
holes. The browser sees one ordinary streamed document.

## Two axes

The existing render path is untouched and stays the default:

|                     | Axis 1 — HTML stream (default)     | Axis 2 — PPR (opt-in middleware)                        |
| ------------------- | ---------------------------------- | ------------------------------------------------------- |
| HTML production     | full fizz `renderToReadableStream` | stored prelude bytes + `resume(postponed)`              |
| Shell definition    | n/a                                | everything that isn't a live loader hole                |
| First byte waits on | Flight render + fizz shell pass    | one shell-store lookup                                  |
| Request fizz cost   | O(whole tree)                      | O(paths to holes) — resume replays only postponed paths |

Everything upstream is shared: matching, middleware, segment cache lookup and
replay, fresh loaders, and the **full** Flight render (the browser still needs
the complete payload for hydration; there is no Flight-side resume — that is a
React limitation, not ours).

A correctness property we get for free: `resume` requires the tree above the
holes to match the prerendered tree. Both the capture pass and every serve
pass render `SsrRoot` over the same replayed cached segments, so shell
identity holds by construction. This is what Next needs its resume-data-cache
for; our segment cache already is that mechanism.

## Proven by POC (do not re-derive)

A two-process POC (scratchpad `poc-flight.mjs` + `poc-fizz.mjs`, results
2026-07-03, react-dom 19.2.6 stable + plugin-rsc vendored RSD 19.2.6):

1. Flight static `prerender` + abort halts pending rows — the live hole's row
   is simply absent from the shell payload.
2. Feeding shell Flight bytes through a stream that **never closes** makes the
   fizz side suspend at the hole instead of erroring ("Connection closed").
   This is Next's `asUnclosingStream` trick and it is load-bearing.
3. `prerender(<Root/>, { signal, bootstrapScriptContent })` aborted after the
   shell settles returns a servable prelude (shell HTML + Suspense fallback +
   `<template id="B:0">` hole + bootstrap script) and a ~600-byte
   JSON-round-trippable `postponed` object.
4. `resume` over a **fresh full Flight render** emits only the hole content and
   the `$RC` stitch script; `.pipeThrough(injectRSCPayload(...))` composes
   unchanged; composite = prelude bytes + resumed stream.
5. **Cross-instance resume works**: resuming with a freshly created component
   function of identical shape (different identity, as happens across two
   requests with the closure-scoped `SsrRoot`) stitches correctly. Replay
   matches structure, not function reference.
6. The prelude ends with `</body></html>` — React relies on HTML parser
   foster-parenting for content streamed after it (same as Next PPR
   responses). Byte concatenation is the correct composition; do not try to
   strip or reopen the document.

## Architecture

The middleware calls `next()` EXACTLY ONCE on every path — the executor's
per-entry `next()` is a single-use latch (`src/router/middleware.ts`), so a
second call throws `"Middleware called next() more than once."`. Capture does not
re-run the pipeline; it runs as a render-layer background task that re-derives
the shell via `router.match()` under its own derived context.

```
request ──> shell-cache middleware (src/cache/shell-cache.ts)
              │ GET + HTML document only, bypass matrix below
              │
              ├─ getShell(key) HIT ──> set requestCtx._shellResume
              │     (+ set requestCtx._shellCapture descriptor if stale/SWR)
              │     ──> next()  [called once]
              │        rsc-rendering resume branch:
              │          full Flight render ──> ssrModule.resumeShellHTML
              │          response marked x-rango-shell-resumed
              │        rsc-rendering, after building the response:
              │          _shellCapture set + eligible ──> scheduleShellCapture (recapture)
              │     middleware: strip marker, prepend prelude bytes, return composite
              │
              └─ MISS ──> set requestCtx._shellCapture descriptor ──> next()  [called once]
                    rsc-rendering, after building the axis-1 response:
                      _shellCapture set + eligible (nonce/allReady/200-HTML gate)
                      ──> scheduleShellCapture(ctx, request, env, url, reqCtx, ssrModule, descriptor)
                           runBackground: runWithRequestContext(derivedCtx, () =>
                             router.match() [loaders MASKED via _shellCaptureRun]
                             ──> buildFullPayload ──> Flight render
                             ──> ssrModule.captureShellHTML (prerender + abort)
                             ──> store.putShell(key, { prelude, postponed, ... }))
                    middleware: clear the descriptor, tag x-rango-shell: MISS
```

Two request-context fields carry the handshake. `_shellCapture` is the DESCRIPTOR
(`{ key, ttl, swr, store }`) — "a capture is wanted" — set by the middleware
before its single `next()`; its presence must NOT change the foreground render.
`_shellCaptureRun` is the ACTIVE marker, set to `true` only on the background
task's derived context; loader masking (`loader-mask.ts`), the `emitStreaming`
guard (`fresh.ts`), and the `cookies()`/`headers()` capture guard
(`cookie-store.ts assertNotInsideShellCapture`) all key off it.

Why `router.match()` and not a second `next()`: the middleware chain (auth,
logging, and that single-use `next()` latch) must run exactly once per request.
Re-deriving through `match()` re-runs only the route handlers/segment resolution
— not the middleware — and the derived context inherits the foreground's
post-middleware state (variables, cache store) while overriding the render-scoped
accumulators (a fresh handle store, request-tag set, and transition list). This
is strictly better than a pipeline re-run: no double middleware side effects, and
the served response is never blocked on the capture (`runBackground` =
`waitUntil` on workerd, fire-and-forget in Node dev).

## Contracts

### SSR strategies (`src/ssr/`)

`createSSRHandler` stays byte-identical in behavior. The `SsrRoot` builder is
extracted so three handlers share it. Two new factories, wired by the
generated SSR virtual entry (`src/vite/plugins/virtual-entries.ts`), which
additionally imports `prerender` from `react-dom/static.edge` and `resume`
from `react-dom/server.edge`:

```ts
createShellCaptureHandler(deps) =>
  captureShellHTML(rscStream, opts: {
    quiesce: Promise<void>;   // caller signals "cached content settled"
    maxWaitMs?: number;       // guard, default 5000
  }): Promise<{ prelude: Uint8Array; postponed: string | null } | null>

createShellResumeHandler(deps) =>
  resumeShellHTML(rscStream, opts: {
    postponed: string | null; // JSON from capture; null = DATA variant
    nonce?: string;
  }): Promise<ReadableStream<Uint8Array>>
```

Capture semantics:

- `prerender(<SsrRoot/>, { signal, bootstrapScriptContent })`. No
  `injectRSCPayload` (the hydration payload must be fresh per request). No
  `formState`. No nonce (nonce'd requests never reach capture).
- Abort ordering: await the caller's `quiesce` (bounded by `maxWaitMs`), then a
  fixed `POST_QUIESCE_TASK_HOPS` (= 2) macrotask hops, then `controller.abort()`.
  `prerender`'s promise settles only after the abort when holes are pending —
  start it first, run the abort logic concurrently. By the time `quiesce`
  resolves the Flight input is byte-quiet AND frozen (see "Capture quiesce:
  task-based, not wall-clock" below), so the hops are deterministic and
  `maxWaitMs` is only a pathological guard that should never fire.
- Sanity gate: if the prelude is trivial (no `<body`) or empty, return `null`
  and store nothing. This is the safe failure mode for the root-postpone /
  hung-handles cases.
- `postponed === null` with a healthy prelude means the shell completed with
  no holes — store it; serve as the DATA variant.

Resume semantics:

- Tee the fresh Flight stream; build `SsrRoot` over one branch (a new function
  instance is fine — POC item 5); `resume(element, JSON.parse(postponed),
{ onError, nonce })`; pipe through `injectRSCPayload(otherBranch, { nonce })`.
- DATA variant (`postponed === null`): no fizz at all — pipe an empty,
  immediately-closed HTML stream through `injectRSCPayload` so the flush
  appends the payload scripts after the complete stored shell.

### Store family (`src/cache/types.ts`)

```ts
export interface ShellCacheEntry {
  prelude: string;          // base64-encoded prelude bytes
  postponed: string | null; // JSON.stringify of React postponed state
  reactVersion: string;     // React.version at capture time
  createdAt: number;        // epoch ms
}

getShell?(key: string): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null>;
putShell?(key, entry, ttlSeconds?, swrSeconds?, tags?): Promise<void>;
```

One entry carries both artifacts — the pair is version- and generation-coupled
and must never mix (Next's platform guide makes this an explicit requirement).
Implementations: memory store (tests/dev), CF store (KV-backed, mirroring the
item family; the Cache-API L1 tier is a follow-up), Vercel store (runtime
cache; respect the 2 MB item cap — skip storage with a debug log when over).
Shell entries participate in `invalidateTags` via the same tag machinery as
their store's item family.

Stores that don't implement the family simply disable the middleware
(fail-open to axis 1, log once under `debug`).

### Request-context flags (`src/server/request-context.ts`, internal)

```ts
_shellResume?: { postponed: string | null };
// The DESCRIPTOR: "a capture is wanted". Set by the middleware before its single
// foreground next(); its presence must NOT change the foreground render.
_shellCapture?: {
  key: string;
  ttl?: number;
  swr?: number;
  tags?: string[];
  // The same store the middleware resolved for its getShell read
  // (options.store ?? _cacheStore), threaded so a store-attached middleware
  // writes captures where it reads them.
  store?: SegmentCacheStore;
};
// The ACTIVE marker: true ONLY on the background capture task's derived context.
// Loader masking, the fresh.ts emitStreaming guard, and the cookies()/headers()
// capture guard all read this — NOT the descriptor.
_shellCaptureRun?: boolean;
```

`tags` on the descriptor is left unset by the middleware; the background capture
collects the shell's own non-loader request tags from its derived render. None of
the three fields are on `PublicRequestContext`.

### Middleware (`src/cache/shell-cache.ts`)

`createShellCacheMiddleware<TEnv>(options)` — exported from
`@rangojs/router/cache` beside `createDocumentCacheMiddleware`, and modeled on
it (store from `requestCtx._cacheStore` unless `options.store` is given;
`reportCacheError`; fail-open pre-handler, throw post-handler). It calls `next()`
exactly once and never schedules background work itself — that is the render
layer's job (below).

```ts
interface ShellCacheOptions<TEnv> {
  store?: SegmentCacheStore<TEnv>;
  ttlSeconds?: number; // default 300
  swrSeconds?: number;
  keyGenerator?: (url: URL) => string;
  isEnabled?: (ctx: MiddlewareContext<TEnv>) => boolean | Promise<boolean>;
  skipPaths?: string[];
  debug?: boolean;
}
```

Bypass matrix (every bypass = plain `next()`, axis 1):

| Condition                                             | Why                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| non-GET                                               | mutations are dynamic                                                                                                                 |
| `_rsc_action` / `_rsc_loader` / `_rsc_partial` params | not document requests                                                                                                                 |
| RSC request (`!mayNeedSSR`)                           | Flight path is untouched by PPR                                                                                                       |
| CSP nonce in play                                     | frozen prelude cannot carry a fresh nonce                                                                                             |
| `streamMode: "allReady"` render                       | buffering defeats PPR                                                                                                                 |
| `skipPaths` / `isEnabled` false                       | consumer opt-out                                                                                                                      |
| store lacks `getShell`/`putShell`                     | fail-open                                                                                                                             |
| entry `reactVersion !== React.version`                | postponed blobs are build-coupled; treated as a miss (recapture overwrites the key, entry ages out via TTL — v1 has no `deleteShell`) |

HIT flow: validate entry, set `_shellResume` (and, on a stale/SWR hit, the
`_shellCapture` descriptor), `await next()` once, then compose **only if** the
response carries the internal `x-rango-shell-resumed` marker (the resume branch
engages solely on the main 200 document path — redirects, 404s, and error renders
never resumed, so their responses pass through untouched). Strip the marker,
prepend prelude bytes via a TransformStream, keep the live response's
status/headers (Set-Cookie and friends are per-request and belong to the live
pass), add `x-rango-shell: HIT`. The recapture on a stale hit is scheduled by the
render layer off the descriptor — not by the middleware.

MISS flow: set the `_shellCapture` descriptor, `await next()` once (streaming the
live response to the user, plus `x-rango-shell: MISS`), then clear the descriptor
in a finally. The render layer schedules the background capture off the descriptor
after building the response.

Resume failure policy (v1): if `next()` throws while `_shellResume` is set,
disarm both single-request flags and rethrow (v1 has no `deleteShell` to eagerly
evict the entry). The entry is version-keyed so this is rare; the next request
self-heals via axis 1 + re-capture, which overwrites the same key.

### Render orchestration (`src/rsc/rsc-rendering.ts` + `src/rsc/shell-capture.ts`)

In the document branch (where `ssrModule.renderHTML` is called), the foreground
render is unchanged except for the resume branch and a post-response hook:

- `_shellResume` set and `ssrModule.resumeShellHTML` present (and no nonce, not
  `allReady`): render the full payload Flight stream as usual, call
  `resumeShellHTML` instead of `renderHTML`, mark the response
  `x-rango-shell-resumed`.
- After building the served response (axis 1 OR resume), `maybeScheduleShellCapture`
  fires: if `_shellCapture` (the descriptor) is set and the render is eligible —
  no nonce, not `allReady`, document path, `ssrModule.captureShellHTML` present,
  and the response is a 200 HTML document — call `scheduleShellCapture`.
- Neither flag: axis 1, byte-identical to today. The foreground render NEVER masks
  loaders — masking keys off `_shellCaptureRun`, which only the background context
  sets.

`scheduleShellCapture` (in `shell-capture.ts`) is the single owner of the stampede
guard (a module-level in-flight key set: one capture per key per isolate, added on
schedule and cleared in the task's finally). It dispatches `runBackground(reqCtx,
runShellCapture)`. `runShellCapture` builds the derived context (`Object.create`
of `reqCtx` overriding a fresh handle store / request-tag set / transition list,
`_shellCaptureRun: true`, a fresh `_metricsStore`), then under
`runWithRequestContext` re-derives the shell: `router.match()` (loaders masked),
`buildFullPayload` (extracted to `src/rsc/full-payload.ts` so foreground and
capture build the same shape), a fresh Flight render, then the seal → quiesce →
`captureShellHTML` → `putShell` flow. A redirecting match aborts with no store
write; every error routes through `reportCacheError`.

Known trap — the handles generator: `SsrRoot` consumes `payload.metadata.handles`
to completion before rendering anything (`consumeAsyncGenerator`,
`src/ssr/ssr-root.tsx`). In capture the generator completes once the (freshly
re-derived) handle pushes settle; if a deferred handle depends on a masked loader
it can never resolve, so `SsrRoot` suspends at the root, the prelude comes back
trivial, and the sanity gate refuses to store — the designed fail-safe no-op.

### Capture retry-in-place, and why cold-start stopped being noisy

This started as a DX bug: a `/shell-cache` route with `loading()` (a perfectly
shell-capturable shape) needed roughly five MISS requests before it flipped to
HIT in dev, and every one of those requests dumped a full `DOMException
[AbortError]` stack to the console. Two things were wrong, and both are worth
knowing before you touch capture.

**The abort dumps were React, not us.** Capture WORKS by aborting: once the shell
is byte-quiet we `controller.abort()` to freeze the prelude and let the still-
pending holes postpone. `prerender` reports the abort reason for each pending
boundary through its `onError`, and `captureShellHTML` passed no `onError`, so
React fell back to `console.error` — one DOMException dump per pending hole, on
EVERY capture that still had a live hole at abort time (i.e. the normal case, and
every cold capture where the shell had not finished). The fix is a one-liner with
a load-bearing shape: pass `prerender` an `onError` that SWALLOWS the abort
(`signal.aborted && name === "AbortError"`) and routes only genuine shell errors
to `deps.onError` (`src/ssr/index.tsx`). A fair reaction is "won't that hide real
errors?" — no: a real component throw is not the abort and still surfaces.

**The multi-request warmup was cold modules.** In dev the module transform graph
(route modules, the SSR/Flight transforms) is built lazily and outlasts the task-
quantized quiesce, so the first capture freezes a shell that has not finished
rendering — the prelude comes back trivial and the sanity gate refuses. The old
code stored nothing and waited for the NEXT HTTP request to try again; several
requests each warmed a little more of the graph until one finally stuck. The first
attempt already warmed the graph, so we now retry ONCE in place: `runShellCapture`
is a two-attempt loop (`attemptCapture` × 2) with a short `delay`
(`SHELL_CAPTURE_RETRY_DELAY_MS`, 400 ms) between them. Each attempt re-derives
EVERYTHING — fresh context, fresh `router.match()`, fresh Flight render — because a
capture consumes its handle store, its request-tag set, and its one-shot Flight
stream; a second attempt is a clean capture, not a resumption. We retry only on the
retryable outcome (`no-shell`, or a defensively-caught abort); a genuine render
error is NOT retried — it propagates to `reportCacheError`.

The two changes compose: cold-start now heals inside one background task, so the
once-per-key "no usable shell" warning fires only AFTER the in-place retry also
failed. That makes the warning meaningful again — by the time it fires, cold-start
has usually healed, so it points at the structural cause (a loader route without
`loading()`), and its text names both causes with the distinguishing signal (does
the route ever flip to HIT). Under the middleware's `debug` flag (threaded onto the
`_shellCapture` descriptor, since the capture layer cannot see the middleware's
options) each attempt emits one concise breadcrumb instead of a stack dump.

### Refused-capture backoff (mounting the middleware app-wide)

An ineligible route — a loader route without `loading()`, or a cookie-reading
handler whose capture throws — refuses on every request. Without a memory of that,
mounting the shell middleware broadly (`router.use("/*", …)`) would schedule a
doomed background render on EVERY request the route serves. `scheduleShellCapture`
keeps a module-level negative cache (`refusedCaptures`): a key enters backoff only
after the in-place retry ALSO failed (or a genuine error), and within the window
the key is not re-probed.

The window is EXPONENTIAL in the consecutive-failure count —
`min(BASE * 2^(failures-1), MAX)`, so 1 s, 2 s, 4 s, … capped at 60 s
(`REFUSED_CAPTURE_BASE_MS` / `REFUSED_CAPTURE_MAX_MS`). A flat 60 s conflated two
very different failures. A structurally ineligible route fails forever and wants
the long cap. But a cold-but-ELIGIBLE route can also fail the retry under a truly
cold graph (dev module transform, or a cold worker under parallel load), and it
must recover on the next request or two — freezing it for 60 s would re-break the
cold-start DX the retry exists to fix (this is not hypothetical: a flat 60 s
backoff made the cloudflare dev PPR e2e time out, because `warmToHit`'s
multi-request recovery was blocked). Escalating from 1 s lets the eligible route
re-probe almost immediately (warm now → HIT, which clears the entry), while the
doomed route ramps to the 60 s cap within a handful of failures. Either way an
app-wide mount never re-renders a doomed route on every request. A successful
capture clears the entry outright.

### Capture quiesce: task-based, not wall-clock

Capture has to decide when the shell has finished streaming so it can abort
`prerender` and freeze the prelude. The original mechanism was a 50 ms wall-clock
debounce (`monitorFlightQuiet`): once no Flight chunk had arrived for 50 ms,
declare quiet. That worked but coupled correctness to a magic number — too short
and a slow shell row is dropped, too long and every capture pays 50 ms — and it
gave no principled statement of what is and isn't captured. It is now
task-quantized (`gateFlightForCapture`, `src/rsc/shell-capture.ts`).

The mechanism rests on one verified fact about React Flight. The capture Flight
render is a REGULAR `renderToReadableStream` (not a static `prerender`), and in
the vendored edge production react-server-dom build a regular render schedules
both its retries (`pingTask`) and its byte-flush to the destination
(`enqueueFlush`) on `setTimeout(0)` MACROTASKS — `scheduleMicrotask` is used for
retries only when `request.type === PRERENDER`. So the stream produces bytes on
macrotask boundaries, and the masked loaders are the live lane: their rows never
emit (`createMaskedLoaderPromise` never settles). Once the shell rows have
flushed, the stream is permanently byte-silent.

So the gate measures quiet in TASKS: after the first byte it hops macrotasks and,
each turn, compares a byte counter; after `FLIGHT_QUIET_HOPS` (= 2) consecutive
turns with no new byte it declares quiesce. At that instant it FREEZES —
forwarding no further byte to the fizz side, but never closing or erroring the
readable, so the still-pending references postpone (the "unclosing stream"
property, here for free because the masked rows never emit). The DATA variant
(no holes) closes the source outright, which fires quiesce immediately and lets
the readable close so fizz completes with `postponed = null`. The full quiesce
the caller awaits is `Promise.all([handleStore.settled, gate.quiesce])`; both
halves are bounded by `captureShellHTML`'s `maxWaitMs`, now a pathological guard
rather than the normal path.

The determinism rule, stated honestly: **any shell work that is byte-silent for
two macrotask hops is treated as settled; anything still producing bytes within
the window keeps the shell open.** Masked loaders (and any genuinely pending I/O)
produce no bytes, so they are always holes — that is deterministic. The residual
race window is exactly one class: raw per-request I/O rendered DIRECTLY in the
shell (a server component doing its own `await fetch()`, not via a loader) that
resolves and flushes within two hops of the shell going quiet. That is a
documented shell anti-pattern — put per-request data in a loader (masked) or
behind `live()` (below) — and it degrades to a hydration repair, not corruption,
if it happens. Freezing also guarantees no post-quiesce byte, including an error
row from any later abort/cancel of the underlying render, can corrupt the frozen
prelude.

On the fizz side (`captureShellHTML`, `src/ssr/index.tsx`) the wall clock is gone
too: once `quiesce` resolves the input is frozen, so a fixed `POST_QUIESCE_TASK_HOPS`
(= 2) macrotask hops — enough turns for React to flush the settled shell and mark
still-pending boundaries as postponed — precede `controller.abort()`. No
`Promise.race` against a clock except the `maxWaitMs` guard.

### The hole contract: a hole needs a loading() boundary

This started as "the capture prerender hangs" — the HIT e2e was `test.fixme` and
the leading suspects were exotic: the live Flight wire staying open on the
pending masked row, the handles generator, backpressure from the quiet-monitor
transform. A deterministic two-process repro (live RSD flight stream piped into
the real `captureShellHTML` deps, each suspect toggled independently, 10 runs per
combination) cleared all three: live-vs-halted wire, generator present/absent,
monitor on/off — every combination captured cleanly. The wire semantics from POC
items 1–2 are simply not load-bearing for capture; a pending-but-present `$@` row
deserializes to a pending thenable and blocks nothing at the root.

The real mechanism, confirmed by instrumenting the built test-app worker: the
demo route had a loader but NO route-level `loading()`. `renderSegments`
(`src/segment-system.tsx`) has three shapes for a segment's loaders, and the
loading-less one **awaits loader data at tree-build** (`await
buildLoaderPromise(...)`) before any element exists. That await sits above every
Suspense boundary — including any `<Suspense>` the page hand-rolls around a
`useLoader` reader, because `useLoader` reads already-resolved context data and
never suspends. Under capture the masked loader never resolves, so the
`renderSegments` promise pins, `SsrRoot` suspends at the root (above `<body>`),
the prelude comes back empty with a root postpone, and the sanity gate refuses.
Deterministic, not intermittent — the "~2 of ~10 renders passed `use(payload)`"
reading was replay-count noise (the signature is 3 render attempts: suspend on
payload, suspend on handles, suspend forever on the segment tree).

So the contract, by construction: **a hole exists only where a Suspense boundary
separates loader consumption from the shell, and the route-level `loading()` DSL
is that boundary.** `loading()` becomes `LoaderBoundary`
(`src/route-content-wrapper.tsx`) — a Suspense whose resolver `use()`es the
loader promise INSIDE it — so the masked promise postpones exactly there and the
prelude freezes the layouts plus the fallback. A loader route without
`loading()` keeps its documented axis-1 semantic (block tree-build on loader
data, no skeleton); under PPR that shape has no sub-document shell at all, the
capture correctly refuses, and the route stays on axis 1 forever. That refusal
was silent, which is what made this expensive to find — `shell-capture.ts` now
logs a once-per-key warning naming the shape.

Consumer shape for a PPR route, then: shell material (static content, handle
reads, interactive islands) in a LAYOUT segment; the loader-consuming route
below it with `loading()` as the hole boundary. The e2e fixtures
(`e2e/test-app/src/urls/shell-cache.tsx`, cloudflare-basic
`src/pages/ppr-shell.tsx`) are the reference. The HIT round-trip is pinned green
in dev and production in both apps: MISS → background capture → HIT, first chunk
= frozen shell + fallback in under the loader delay, live content + `$RC` stitch
in the same response, zero hydration errors. The tree-build-await refusal is
pinned by a unit test (`src/ssr/__tests__/shell-handlers.test.tsx`, "returns
null (and does not hang) when tree-build awaits a masked loader").

OTel: resume and capture both reuse `observePhase(PHASES.ssr, ...)` rather
than introducing new phase names — the shell render lands under the existing
`ssr` phase/span (resume wrapper in `rsc-rendering.ts`, capture wrapper in
`shell-capture.ts`). The middleware's shell lookup (`getShell`) is not
separately instrumented in v1.

## Loaders and handles under PPR

Loaders are the live lane — always fresh, never cached — and that is exactly
what makes them the holes. Capture masks them (never executed, never-resolving
values), so a loader-consuming subtree BEHIND a `loading()` boundary suspends
and postpones there (see "The hole contract" above — without `loading()` the
await happens at tree-build and there is no hole, only a refused capture).
Serve runs them fresh through the unchanged execution path; `resume` streams
their output into the frozen shell's holes. Fetchable loaders and refresh
groups are `_rsc_loader` requests and never touch this middleware.

Handles are shell material. `SsrRoot` consumes the handles generator to
completion before rendering anything (`consumeAsyncGenerator` sits above every
Suspense boundary), so handle data cannot be a hole. Three classes:

1. Replayed pushes from cached segments (the shell-manifest pattern): identical
   at capture time and serve time by construction. This is the intended shape
   for shell-cached routes.
2. Fresh handler pushes on uncached shells: they settle fine, but the prelude
   is an older render than the hydration payload — see the drift note below.
3. Deferred handles resolved by loaders: masked loaders can never resolve
   them. `handleStore.seal()` + `await settled` (the same regime the
   `__prerender_collect` path already runs, which also excludes loaders) must
   settle them during capture; if the generator still hangs, the prelude comes
   back trivial and the sanity gate refuses to store — a fail-safe no-op, not
   an error.

The drift class PPR introduces: today the HTML and the hydration payload always
agree because they come from one render. With a cached prelude they can
diverge for any shell content that is not cache-replayed or deterministic. The
fresh Flight payload is hydration's source of truth, so React repairs the
mismatch at hydration (console warning + client re-render of the subtree) —
degraded, not corrupt, and bounded by TTL/SWR. The segment cache is the
designed consistency mechanism: `cache()` the route so the same replayed
segments feed the captured shell and every resumed render. Consumer guidance:
shell-cache routes whose non-loader content is cached or deterministic; put
per-request data in loaders (holes); keep handles on the replay path.

## The live() hole primitive

The loader mask makes a route loader a hole. `live()` (`src/server/live.ts`,
exported from `@rangojs/router` under the react-server condition; a passthrough
under the default/client condition in `index.ts`) is the userland analogue — it
makes ANY Suspense boundary a deterministic hole, including one whose data is
already resolved.

Why it exists: the capture quiet window (above) freezes anything that settles
synchronously or on a microtask into the shared prelude. That is correct for
deterministic content but wrong for a per-request value that happens to resolve
fast — `Promise.resolve(x)`, an in-memory lookup, a cached read. Under
`<Suspense>` such a value settles inside the quiet window and bakes into the
shell. `live()` holds it out: during the background capture it returns a
never-settling promise (the SAME mechanism as `createMaskedLoaderPromise`), so
the consuming boundary postpones and the prelude freezes only the fallback. On
the serve pass — and on the client, where there is no capture — it is a
passthrough.

```ts
// hole even though the data is already resolved:
const name = await live(() => Promise.resolve(currentUserName()));
```

Two forms, keyed on `typeof input === "function"`:

- `live(fn)` — thunk, preferred. During capture the thunk is NOT invoked: no
  fetch, no side effect, no cost. Outside capture it runs and its result (value
  or promise) is returned as a promise.
- `live(promise)` — value form. The work already fired before `live()` saw it,
  so during capture the real promise is discarded and a hole returned in its
  place (the promise still runs — prefer the thunk). Outside capture the promise
  passes through unchanged.

Settle policy: the capture-time hole is **never-settling**, deliberately
identical to the loader mask (`createMaskedLoaderPromise`). Nothing awaits it to
resolve — the capture aborts fizz to freeze the prelude, and workerd/GC reclaims
the pending promise when the capture render tree is dropped. A capture-scoped
reject signal was considered and rejected: it would buy no capture-behavior
difference (the abort, not the hole promise, ends the render) at the cost of
diverging from the loader mask.

Guard gating: `live()` keys off `_getRequestContext()?._shellCaptureRun`, the
same ACTIVE marker the loader mask and the `cookies()`/`headers()` capture guard
read — so it is a hole ONLY inside the background capture render, never in the
foreground serve pass (whose `_shellCapture` descriptor merely means "a capture
is wanted"). The capture/serve split is pinned unit (`live()` through the capture
primitive, `src/ssr/__tests__/shell-handlers.test.tsx`; the function contract,
`src/server/__tests__/live.test.ts`) and dev + production e2e (the "live() makes
a resolved promise a HOLE" case in both apps).

## Constraints (the contract with consumers)

| Case                       | Behavior                                                                                                                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell content              | shared per host+URL key — personalization must live in loaders/holes (the shell-manifest pattern). ENFORCED: `cookies()`/`headers()` reads throw during a capture render (`assertNotInsideShellCapture`, cookie-store.ts), making cookie-reading shells PPR-ineligible by construction |
| Multi-tenant / host-router | the default key incorporates `url.host` so one tenant's shell can never compose into another tenant's page on a shared worker + store; custom `keyGenerator`s own host scoping themselves                                                                                              |
| Status/headers/cookies     | committed with the live response's headers before the first shell byte; a failing hole cannot become a 500/redirect — error UI renders inline via Suspense/error boundaries                                                                                                            |
| Actions / PE / formState   | always axis 1                                                                                                                                                                                                                                                                          |
| Per-request nonce          | always axis 1                                                                                                                                                                                                                                                                          |
| React/router upgrade       | shells invalidated via `reactVersion` check (treated as a miss on mismatch; recapture overwrites and TTL ages the entry out — v1 has no `deleteShell`)                                                                                                                                 |
| Dev server                 | middleware works; shells are memory-store-scoped and cheap to recapture; HMR edits produce stale shells until TTL/recapture — documented, acceptable                                                                                                                                   |
| Composite response         | per-request; only the shell entry is cacheable. Note ordering with the document cache: if both middlewares wrap a route, the document cache may cache the composite — correct output, but it makes shell caching redundant for that route. Pick one per route.                         |

## Platform notes

Cloudflare Workers: the in-worker pattern is the endgame — the worker always
runs (~5 ms cold starts); the win is skipping shell-render CPU and its
upstream reads. `waitUntil` (via `runBackground`) covers capture. Chunked
encoding and edge compression of the composite are automatic; never store
compressed bytes.

Vercel: identical in-function pattern on Fluid Compute via the Vercel store.
The Build Output API `chain` mechanism (platform-appended streaming, shell
served from the PoP cache) exists but is undocumented and Next-only in
practice — deliberately out of scope; revisit with Vercel directly.

## Out of scope (v1)

- Build-time capture in the prerender pipeline (B segments). Runtime capture
  via background re-render covers the feature; build-time is an optimization
  with the same storage contract.
- CF Cache-API L1 tier for shell entries (KV only in v1).
- Vercel BOA `chain` / streaming-lambda serving.
- Segment-tag union auto-collection for shell entries (v1: TTL/SWR + explicit
  tags option + reactVersion gate).
- Flight-byte splicing for the cached portion of the payload (the full Flight
  render still runs per request; hydration needs it anyway).
- Warm-pass two-phase capture: a second capture render that lets non-loader
  in-shell async settle (closing the last residual quiesce window — raw
  in-component I/O in the shell, above) rather than relying on the anti-pattern
  guidance. Deferred because the current mechanism (mask loaders, task-quantized
  quiesce, `live()` for the resolved-value case) covers the intended shapes; the
  research on the alternatives — Flight static `prerender` with halt semantics
  (microtask retries) vs. the regular-render gate we ship, and Next's
  `runInSequentialTasks` / `makeHangingPromise` — is captured in the design
  history and revisited only if a real route needs it.

## Testing requirements (repo mandates)

- Unit: SSR strategies tested with an injected fake `createFromReadableStream`
  (the deps-injection seam means no react-server condition is needed);
  middleware tested against the memory store, including the bypass matrix,
  version-mismatch deletion, marker-gated composition, and stampede guard.
- Userland dogfood: a consumer-visible test in the mini suite
  (`packages/rangojs-router/e2e/mini/test/`) exercising the middleware through
  the real server.
- E2e dev + production in cloudflare-basic and test-app: slow live loader
  (~400 ms); assert MISS then HIT via `x-rango-shell`; on HIT the first chunk
  contains shell content without the dynamic content and arrives before the
  loader delay elapses; the dynamic content arrives in the same response;
  hydration and interactivity work. `(production)` describe-title bucketing
  rules apply.
- Semantic matrix must stay green (axis 1 untouched).
