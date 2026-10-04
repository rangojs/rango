# router.prerender() for every route

**Status:** Design, not built. Red tests:
`src/testing/__tests__/prerender-warm.rsc-test.tsx` (userland, through
`serveShellRequest` and the public runner) and
`src/cache/__tests__/store-scope.test.ts` (the store declaration). Issue
#1062; stacks on #640 (`docs/design/ondemand-prerender.md`) and ships in the
same release.

## Why

After #640, `router.prerender({ env, ctx })(url)` can make one kind of route
ready before traffic: a `Prerender(..., { onDemand })` route, rendered with no
request and written to the prerender store. Every other cache the router has
fills only from a visitor's request: a `ppr` route's shell (captured on the
first document MISS), a route's `cache()` records, the `"use cache"` results the
render reaches, a loader's own `cache()`, the document cache. A deploy that
changes a router's server code moves its data and document versions
(`docs/design/per-app-cache-version.md`), so every one of those keys starts
cold, and so does every key an `updateTag()` evicts. The first visitor per key
pays the render. A `clientUrls()` group cannot use `Prerender()` at all (#818),
so for a group route with `ppr` (#817) there is today no way to be ready before
the first visitor.

This design widens the one verb. `router.prerender()` keeps #640's path for an
on-demand route, and for every other route it _warms_: it sends the URL
through the router's own request handler as a visitor would, in a mode where
every cache read misses and every write replaces the entry in place. You get
the same keys a visitor's request would fill, written before the visitor
arrives, with the old entries serving until the new ones land.

## The model

A warm is a cookie-free `GET` of the URL a visitor requests (host, path and
search included), dispatched in process through `router.fetch`'s handler with
an unforgeable mark on the request. The mark puts the request in _replace_
mode: each runtime cache read (route `cache()`, loader `cache()`, `"use
cache"`, the PPR document shell, the document cache, a response route's cache)
answers a miss without reading the store, the render runs as on a cold cache,
and every write it makes goes through the existing write path to the existing
key, replacing what was there. The response is drained and dropped; the runner
waits for the request's background work (the cache writes, the shell capture)
and reports what was written. The only stores it touches are the ones a
visitor's request would touch, under the same router versions, so a warm
writes only what a visitor's request on a cold cache would have written.

### Invariants the build must keep

1. **A warm never serves user traffic.** Its response is drained and discarded
   inside the runner; it runs in its own request context. What it renders
   reaches a visitor only through a store.
2. **It writes only under keys a visitor's request would write.** Same handler,
   same router versions (`getCacheVersions()` reads them off the warm's request
   context), same host and path, the same `cache.searchParams` filter, the same
   `key()` and store `keyGenerator` runs. A header-less request lands in the
   partition a header-less visitor lands in.
3. **It writes only what a cookie-free visitor's request on a cold cache would
   write, and never what that request would refuse to store.** The forced miss
   changes what is read, never what is written or under what rules.
4. **Correctness guards decide; the warm never bypasses them.** The identity
   guards (`guardIdentityRead` in `server/context.ts`: `cookies()`,
   `headers()`, theme reads, `{ cache: false }` vars), the tag-invalidation
   write gate (`predatesInvalidation`, `cache/tag-invalidation.ts`, and
   `putShell`'s generation gate), `cache(false)` and `condition()`, the
   document cache's `private`/`no-store`/`no-cache`/`Set-Cookie` refusals, the
   PPR nonce gate, the shell entry and snapshot size caps, the shell version
   gates, `ctx.dynamic()`.
5. **Load-shedding guards that would turn the explicit call into a silent
   no-op are bypassed for the warm's own work, and only there.** The capture's
   per-key in-flight dedup, its refused-capture backoff, its `skip-stored`
   check, and a `"use cache"` call joining an in-flight leader. Each exists to
   stop a herd of visitors repeating work; a warm is one explicit call, and
   each of these would otherwise let it return having replaced nothing. Queue
   capacity is respected and reported. This is a refinement of the decided
   "the existing guards decide" (see "Where the decided design needs a
   correction").
6. **Reads miss; writes replace; nothing is deleted first.** There is no
   eviction step, so there is no cold window.
7. **The prerender stores are not runtime caches and are never forced to
   miss.** A build-time `Prerender` entry and the on-demand overlay serve the
   warm's request exactly as they serve a visitor's.
8. **The mark lives in process.** No URL parameter, header or cookie makes a
   request a warm. A client-settable "miss everything and overwrite" switch
   would be a cache-busting amplifier.
9. **A store that is not shared beyond the place the call runs is refused
   before any render.**
10. **The capture a warm schedules reads normally.** It runs after the warm's
    writes (the capture's write barrier) and replays them, so it bakes the
    fresh generation instead of rendering every handler a second time.

## Dispatch

```txt
router.prerender(runtime)(target, options)
  |
  v
resolve the target's path              (string, URL, or { route, params } via reverse)
  |
  v
match the pathname ------------------------ nothing --> no-match
  |
  v
on-demand route?
  +-- yes: search/hash -------------------------------> skipped-unsupported-target (#640)
  |        #640 producer -> overlay write ------------> rendered | already-fresh | ...
  |        then, when the app store is shared and an origin resolves:
  |        warm GET (replace) ------------------------> result.caches
  |
  +-- no:  hash, _rsc*, __no_cache -------------------> skipped-unsupported-target
           origin: target, runtime.origin, ambient request
             +-- none --------------------------------> skipped-no-origin
           resolve createRouter({ cache }) with (env, collecting ctx)
             +-- none / enabled: false ---------------> no-store
             +-- scope not global or regional --------> skipped-store-not-shared (dev: warn once)
           warm GET (replace; fill with onlyIfStale)
             -> warmed | already-fresh | skipped-personalized | shell-not-stored
                | skipped-uncached | render-failed
```

#640's `skipped-not-on-demand` is gone: that branch is now the warm path. #640
is not released yet, so the status is removed, not deprecated.

## Path table

Statuses are `PrerenderResult.status`. "Shared" is a store whose `scope` is
`"global"` or `"regional"`; "not shared" is `"local"` or a custom store that
declares nothing. "No store" is a router without `createRouter({ cache })` (or
`enabled: false`).

| Route kind                                          | Shared (global, regional)                                                                                                                                                                                                                                                                                                         | Not shared (local, undeclared)                       | No store                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `Prerender(..., { onDemand })`                      | #640's requestless render into the prerender store, then a warm GET in replace mode: the overlay serves it, so its loaders' own `cache()` and the document cache are rebuilt on the new entry. `rendered` (or #640's failure status), with `caches`. No prerender store: `no-store` (#640).                                       | #640 only, no warm GET. `rendered` without `caches`. | #640 only. `rendered` without `caches`.                        |
| `Prerender()`, build-time only                      | Warm GET. The build entry serves the handler layer (not forced: invariant 7); loaders run and their caches, the document cache and, with `ppr`, a runtime shell are replaced. The runtime shell now shadows the build shell for that key, as an SWR recapture of a stale build shell already does. `warmed`.                      | `skipped-store-not-shared`, nothing renders          | `no-store`                                                     |
| `Passthrough(def, live)`, not on-demand             | Baked param: as the row above. Unbaked or `ctx.passthrough()` param: the live handler runs and its caches are replaced. `warmed`. (`Passthrough` + `onDemand` is the first row; #640's `skipped-passthrough` still runs the warm GET, which warms the live handler's caches.)                                                     | `skipped-store-not-shared`                           | `no-store`                                                     |
| Plain route with `cache()`                          | The `doc:` record is replaced (`CacheScope.cacheRoute`). The `partial:` and `intercept:` records are not reached. `warmed`.                                                                                                                                                                                                       | `skipped-store-not-shared`                           | `no-store`                                                     |
| `ppr` route                                         | Shell read and build-shell lookup skipped, MISS render, capture scheduled with `force`. The shell entry (doc record inside) is replaced. `warmed`; `shell-not-stored` when the capture stores nothing for a non-identity reason (`caches.shell` says which); `skipped-personalized` for an identity read during capture.          | `skipped-store-not-shared`                           | `no-store` (a `ppr` route without a store has no shell either) |
| `clientUrls()` group route with `ppr`               | Same as a `ppr` route: the group route is materialized as a server `path()` with the option (#817). This is the only way to have such a route ready before traffic, since a group cannot use `Prerender()` (#818). `warmed`.                                                                                                      | `skipped-store-not-shared`                           | `no-store`                                                     |
| Route reading `cookies()` / `headers()`             | The warm is anonymous: a read outside any cached scope sees no cookies and renders the anonymous view, which is stored wherever a cookie-free visitor's would be (a document-cache opt-in included). A read inside `cache()`, `"use cache"` or the capture trips the existing guard; the warm records it. `skipped-personalized`. | `skipped-store-not-shared`                           | `no-store`                                                     |
| Intercept target                                    | A document GET never intercepts: the full page of the target route is warmed, as its own row says. `intercept:` records and a `Prerender`'s `:i` variant are not reached.                                                                                                                                                         | `skipped-store-not-shared`                           | `no-store`                                                     |
| Response route with `cache()` (`path.json()`, MIME) | The response entry (`response:{type}:...`) is replaced, for the type the `accept: text/html` request negotiates. `warmed`.                                                                                                                                                                                                        | `skipped-store-not-shared`                           | `no-store`                                                     |
| No match / reserved params                          | `no-match` / `skipped-unsupported-target`, before any store resolves.                                                                                                                                                                                                                                                             | same                                                 | same                                                           |

Regional stores fill the region the call runs in (see "The store declaration").

## Where the forced miss hooks in, layer by layer

You might expect a flag threaded through every call that reads a cache. It is
not needed: every layer already reads the request context at the moment it
reads its store. So the mode is one field on the request context,
`RequestContext._prerenderWarm` (a record object, see "The synthetic
request"), and one predicate:

```ts
// src/prerender/warm-request.ts
export function isWarmReplace(ctx: RequestContext | undefined): boolean {
  return (
    ctx?._prerenderWarm?.mode === "replace" && ctx._shellCaptureRun !== true
  );
}
```

The `_shellCaptureRun` exclusion is invariant 10: the capture's derived
context (`deriveShellCaptureContext`, `Object.create(reqCtx)`) inherits the
record through the prototype, and must read normally. The predicate is read at
six points, all before a store read that already exists. None of them needs a
store contract change.

| Layer                | Hook point (file:function)                                                                                                                                                                                                                                | Reached through the normal pipeline?           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Route `cache()`      | `cache/cache-scope.ts:CacheScope.lookupRouteDetailed`, before `store.get` (:798)                                                                                                                                                                          | yes, plus the predicate                        |
| Loader `cache()`     | `router/segment-resolution/loader-cache.ts:executeLoaderData`, the `getItem` passed to `readThroughItem` (:771)                                                                                                                                           | yes, plus the predicate                        |
| `"use cache"`        | `cache/cache-runtime.ts:registerCachedFunction` (the wrapper), `store.getItem` (:613) and the in-flight follower loop (:801)                                                                                                                              | yes, plus the predicate                        |
| PPR document shell   | `rsc/rsc-rendering.ts:shellServePlan` (`readShellEntry` :559, `lookupBuildShell` :694, `storedSeqAtRead` :555, the descriptor :575); `rsc/shell-capture.ts:scheduleShellCapture` (:1098, :1111, :1119) and `attemptCapture` (:1824) via a descriptor flag | yes, plus the predicate and `descriptor.force` |
| Navigation shell     | none                                                                                                                                                                                                                                                      | not warmed; see below                          |
| Document cache       | `cache/document-cache.ts:createDocumentCacheMiddleware`, the `getResponse` (:411)                                                                                                                                                                         | yes, plus the predicate                        |
| Response-route cache | `rsc/response-cache-serve.ts:serveResponseRouteWithCache`, the `getResponse` (:191)                                                                                                                                                                       | yes, plus the predicate                        |

### Route `cache()`

`lookupRouteDetailed` keeps its `enabled` and `condition("read")` checks
first, so `cache(false)` and a refusing `condition()` still answer `bypass`
(invariant 4). Then, in replace mode, it returns `{ status: "miss" }` without
resolving the key or reading the store. The miss lets `withCacheStore`
(`router/match-middleware/cache-store.ts`) run its write path unchanged:
`cacheRoute` resolves the same key a visitor would (`getDefaultRouteCacheKey`:
`doc:` + `cacheKeyBase(host, pathname, search, params, filter)`, then the
`key()` / `keyGenerator` chain) and calls `store.set`, which replaces. Every
shipped store's `set` is a replace (Cache API `put`, KV `put`, Vercel
`cache.set`, `Map.set`).

- **SWR:** no read, so no `shouldRevalidate` and no REVALIDATING claim on
  `CFCacheStore`. A visitor's SWR refresh already in flight can still land after
  the warm's write and replace it with its own render: last writer wins, the
  same race two visitors have today.
- **Tag markers:** the write gate is unchanged: `predatesInvalidation` with the
  record's tags and the render's start. An `updateTag()` landing mid-warm
  refuses the warm's write, as it refuses a visitor's.
- **Versions:** the store prefixes `getCacheVersions().data` from the warm's
  request context, the router's own pair.
- **`cache.searchParams`:** the handler compiles the filter from the same
  config (`handler.ts`, `compileSearchParamsFilter`), so a warm of
  `/list?utm_source=x` under a filter that drops `utm_source` writes the
  `/list` record.
- **Not reached:** the `partial:` record (navigation requests) and `intercept:`
  records. The first navigation fills `partial:` through the existing
  proactive path.

### Loader `cache()`

`executeLoaderData` hands `readThroughItem` a `getItem` that answers `null` in
replace mode, so the read-through takes its miss path: the body runs, the value
is served, and `setItem` replaces the entry (`loader:{id}:{host}{path}:{params}`,
or the loader's own namespaced `key()` result). The identity rule (#972: an
undeclared key fails on an identity read) and the `predatesInvalidation` gate in
the `setItem` closure are unchanged. No SWR path runs.

### `"use cache"`

In replace mode `registerCachedFunction` treats the lookup as `cached = null`
and does not join an in-flight leader (`inFlightExecutions`): a leader that
started before the warm was called can be reading data from before the change
the warm exists to publish, and a follower writes nothing of its own. The warm
becomes the leader instead, replacing the map entry, so visitors that miss
meanwhile join the warm's execution and are served the fresher value.
`finalizeAndWrite` is unchanged: the envelope, the `predatesInvalidation` gate
(asked before followers get the value), and `setItem`, which replaces. A
function called without request-scoped arguments is keyed by its arguments
only, so a warm of one URL refreshes it for every URL that reads it; that is
the "shared entry" the issue describes.

### PPR document shell

In replace mode `shellServePlan` keeps every gate up to the key (`isPartial`,
method, `_dynamic`, the nonce gate, the store's shell family, the route
scope's `allowsCache("read")`, `resolveRequestShellKey`), then:

- skips `readShellEntry` and the build-shell lookup, so the request is a MISS;
- leaves `storedSeqAtRead` unset, so a capture another request stored in
  between does not cancel the warm's own (`skip-stored`);
- sets `descriptor.force = true` and chains the warm record's sink in front of
  the router's `debugShellCapture` sink (`descriptor.debugSink`), which is how
  the runner learns the capture's outcome without a new channel;
- stamps `record.shell ??= "not-eligible"` right after `resolvePprConfig`, so a
  `ppr` route that later passes on a gate (nonce, no shell family, an opt-out,
  a failed partition key, `allReady`) reports it. A capture event overwrites it.

The response renders and `requestRenderPlan` schedules the capture as on any
MISS. `scheduleShellCapture` with `force`:

- does not return on an in-flight capture for the key; it installs its own
  token, so a visitor's capture started meanwhile coalesces onto the warm's. The
  capture queue (`capture-queue.ts`) runs captures one at a time per isolate, so
  a visitor's capture queued before it stores first and the warm's stores last;
- ignores the refused-capture backoff window, and still records its outcome
  into it (a stored shell clears it, a refusal escalates it);
- keeps the inert-store skip and the queue limits, reported as
  `caches.shell: "skipped-capacity" | "skipped-queue-timeout"`.

The capture's derived context reads normally (the predicate excludes
`_shellCaptureRun`). That is load-bearing: the write barrier in `attemptCapture`
settles the warm's foreground writes first, so the capture replays the record
and the `"use cache"` items the warm just wrote (#957), and the shell, its doc
record and the stores agree on one generation. A forced miss there would render
every handler a second time and could bake a different generation than the
foreground wrote. The barrier is bounded at `SHELL_CAPTURE_WRITE_BARRIER_MS`
(1500 ms) for visitors, after which it proceeds and may read an entry that is
still the old one. With `force` the bound becomes the time left under
`SHELL_CAPTURE_TASK_HARD_CAP_MS` after the capture budget: the warm is not
latency-bound, and an old entry baked into a new shell is exactly what a warm
must not produce.

- **Overwrite:** `putShell` replaces; `CFCacheStore` drops its isolate memo for
  the key on write (`cf-cache-store.ts:2623`).
- **Tag markers:** `putShell`'s generation gate (`createdAt` against the
  markers) is unchanged; an `"invalidated"` acknowledgement reports
  `caches.shell: "refused"` with `refusal: "invalidated"`.
- **Versions:** the store prefixes the document version; the entry's
  `buildVersion` is the handler's version, as on any capture.
- **`cache.searchParams`:** the key is `buildShellKey(url, filter)`, the
  search seed `shellSearchSeed(url, filter)`; both come from the warm's URL.
- **Partitions:** `resolveRequestShellKey` runs the route's `key()` /
  `keyGenerator` against the header-less request, so only that partition is
  warmed.
- **Refusal reasons:** the capture's attempt event
  (`ShellCaptureDebugEvent`) gains an optional `refusal` field, additive, set
  at the existing refuse exits from what they already know
  (`_shellCaptureGuardTripped`, `_dynamic`, the warning they emit). Its values
  are listed under `PrerenderWarmCaches.refusal` in "Result shape".

### Navigation shell: not warmed

Partial navigations of a `ppr` route replay the **document** entry's doc
record: `matchPartialWithPprReplay` reads the document key first
(`rsc-rendering.ts:1414`) and falls back to the navigation-only key only when
that entry is not replayable. Navigation-only entries are a heal path written
by partial requests. Warming the document shell therefore covers navigations of
a `ppr` route from any page.

### Document cache

`createDocumentCacheMiddleware` answers `cached = null` in replace mode (the
same branch as `isFragmentRecovery`). Everything after is unchanged: `next()`
renders, `shouldCacheResponse` refuses `private`/`no-store`/`no-cache`, a
`Set-Cookie`, or a visitor-theme payload, the body is drained before the tag
snapshot, `predatesInvalidation(store, tags, requestStart)` gates, and
`putResponse` replaces. The warm sends `accept: text/html`, so it fills the
`:html` slot; the `:rsc` slot and the partial keys are not reached. The record
gets `document: "stored" | "not-cacheable"` (the latter when the middleware ran
and `shouldCacheResponse` refused).

### Response-route cache

`serveResponseRouteWithCache` skips its `getResponse` in replace mode and takes
the miss branch: `executeHandler`, `canStore`, `putFresh` (gated by
`predatesInvalidation`), `putResponse`.

### What the stores cannot do in place: other edge locations

Overwrite in place is exact at the location the warm runs in. On
`CFCacheStore` with KV, other colos may hold their own L1 copy of an entry
(read flow "L1 hit → serve | L1 miss → L2 hit → serve + promote to L1"), and an
L1 hit never consults KV. Those copies keep serving until they expire (`max-age
= ttl + swr`) or a tag invalidation reaches them through the KV markers. So a
warm closes the cold window the issue is about (after a deploy, after an
`updateTag()`: in both cases the other colos have no valid L1 copy and read the
warm's KV entry), but it is not a cross-colo refresh for a content change that
invalidated nothing. Two smaller cases:

- `CFCacheStore` skips the KV write for a segment, item or response entry whose
  `ttl + swr` is under 60 s (KV's minimum `expirationTtl`; `kvSetSegment`,
  `setItem`, `putResponse`). A warm of such an entry fills the calling colo
  only. Shells always reach KV (60 s floor).
- Isolate memos in other isolates (the shell memo, 2 s by default; the marker
  memo) serve their copy for their window.

None of this needs a store contract change; it is what the platform offers. The
pattern for a CMS webhook (a request, so `updateTag()` works) is
`updateTag(tag)` then `await prerender(url)`: one short cold window in the
calling colo, every other colo converges on its next read.

## The synthetic request

- **Method:** `GET`.
- **URL:** the absolute URL a visitor requests, basename included. Origin, in
  order: the target's own (a full URL string or `URL`); `runtime.origin`, a new
  optional field on the binding (`router.prerender({ env, ctx, origin })`); the
  origin of the request the runner is called from, when there is one
  (`_getRequestContext()?.url.origin`); else `skipped-no-origin`. A
  `{ route, params }` target reverses to a path and takes the same origin. An
  on-demand target needs no origin (prerender keys carry none); without one it
  skips only the follow-up warm GET, and its result has no `caches`.
  Search params are kept (keys carry them, and `cache.searchParams` filters
  them as for a visitor). A hash, and the parameters that switch the handler's
  mode (`_rsc*`, `__no_cache`, `_rsc_shell`), are `skipped-unsupported-target`.
- **Headers:** `accept: text/html` and nothing else. No cookie, no
  authorization, no user agent, no `accept-language`, no `x-rsc-*`. On
  Cloudflare there is no `request.cf` (no geo).
- **The mark:** `markWarmRequest(request, record)` puts the `Request` object in
  a module-private `WeakMap<Request, PrerenderWarmRecord>`
  (`src/prerender/warm-request.ts`). The handler reads it from the incoming
  request before `withoutShellMissMarker` rebuilds it, and sets
  `requestContext._prerenderWarm = record` where it sets `_shellForcedMiss`
  (`handler.ts:613`). A client controls the bytes of an HTTP request; it cannot
  make the worker's `Request` object a key in an in-process `WeakMap`. The
  forced-MISS marker (`_rsc_shell`) is a URL parameter because it only turns a
  HIT into a MISS; the warm mark also overwrites, so it must not be reachable
  from outside.
- **Record:** `PrerenderWarmRecord` holds the mode (`"replace"` or `"fill"`),
  the shell outcome and refusal, the identity surface that was refused, the
  document-cache outcome, and the write counts by family. The layers write it:
  the capture sink (`shell`, `refusal`), `guardIdentityRead` right before it
  throws or flags a capture (`identity`, one line), the document cache
  (`document`), and one `noteWarmWrite(ctx, family)` call after each successful
  store write (`cacheRoute`, `finalizeAndWrite` and the stale refresh in
  `cache-runtime.ts`, the loader `setItem` closure, both document-cache puts,
  `putFresh`, `putShell`). The implicit doc scope's snapshot-only write is not
  counted (`isShellImplicitDocScope`).
- **`env`:** `runtime.env`.
- **`ctx`:** a collecting `ExecutionContext`: `waitUntil(p)` pushes `p` onto
  the warm's list and forwards it to `runtime.ctx?.waitUntil(p)`;
  `passThroughOnException` is a no-op. The handler passes it to the cache
  factory (`cacheOption(env, executionCtx)`), so a `CFCacheStore`'s own
  background writes (its KV puts) are on the list too. The runner drains the
  body, then settles the list until it stops growing, bounded by
  `SHELL_CAPTURE_TASK_HARD_CAP_MS` plus the capture queue's wait budget.
- **Which handler:** `router.fetch`'s, the handler `createRouter`'s own
  `cache`, `nonce` and `version` configure (`router.ts`, `fetch`). The trigger
  has no handle on an app's custom entry, so an entry that passes `cache` or
  `version` to `createRSCHandler` directly is not what the warm runs; that is
  the same caveat #640 documents for `createRSCHandler({ version })`, and the
  same fix: put them on `createRouter`.
- **Store resolution:** the trigger resolves `createRouter({ cache })` once
  per target with `(runtime.env, collectingCtx)` to read the store's `scope`,
  and hands the resolved config to the handler through the record, so the
  store the gate checked is the store the warm writes to.
- **When the route reads identity:** see the path table. Middleware runs, and
  sees an anonymous request: an auth middleware that redirects makes the warm
  `render-failed` with `responseStatus: 302`, which is the right signal (an
  anonymous visitor is not served a cached page there).
- **Nested calls:** the runner may run inside a request (a webhook route, a
  server action). The handler opens its own request context; the caller's is
  untouched.

## The store declaration

```ts
// src/cache/types.ts
/**
 * Where an entry this store writes during one request can be read by a later
 * request. router.prerender() warms a route only when the app store answers
 * "global" or "regional": a warm fills the store where it runs, which serves
 * other traffic only when the store is shared beyond that place.
 * - "global": every location reads the same entries.
 * - "regional": each region has its own copy; a warm fills the region it runs in.
 * - "local": only the process, isolate or edge location that wrote it.
 * Absent: unknown to the router, treated as "local".
 */
export type CacheStoreScope = "global" | "regional" | "local";

export interface SegmentCacheStore<TEnv = unknown> {
  // ...
  readonly scope?: CacheStoreScope;
}
```

It is read in one place: the trigger's warm dispatch
(`create-prerender-trigger.ts`), on the app-level store. Explicit
`cache({ store })` and loader stores are written by the warm without a check:
which ones a render reaches is not known before it renders, and a write to a
local one is wasted work, not a wrong one. Nothing else reads it in v1.

| Store                              | `scope`      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MemorySegmentCacheStore`          | `"local"`    | Per process: "Suitable for development and single-instance deployments" (`memory-segment-store.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CFCacheStore` with `kv`           | `"global"`   | `cf-cache-store.ts` header: "L1 (Cache API): Per-colo, fast, ephemeral. Handles SWR atomically. L2 (KV): Global, persistent, ~50ms reads. Auto-warms cold colos." Read flow "L1 hit → serve \| L1 miss → L2 hit → serve + promote to L1". Cloudflare: "KV is a global, low-latency, key-value data store. It stores data in a small number of centralized data centers"; a write "may take up to 60 seconds or more to be visible in other global network locations". Set from `options.kv` in the constructor, next to `tagHistoryInert`. |
| `CFCacheStore` without `kv` (#819) | `"local"`    | L1 only: the Cache API is per colo. Purge mode (`tagPurge`) evicts across the zone but stores nothing beyond the colo, so it stays local.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `VercelCacheStore`                 | `"regional"` | Vercel: "Runtime cache is a regional, ephemeral cache ... within a Vercel region"; "Each region has its own cache". Functions "execute in Washington, D.C., USA (`iad1`) for all new projects"; Hobby runs one region, Pro up to 5, Enterprise all; entries can be evicted early (LRU at the storage limit). Decided: allowed for single-region deployments, by documentation only, no runtime region detection.                                                                                                                           |
| A custom store                     | its own      | Only if it declares itself. A store without the field is treated as `"local"` and refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

No knob on the shipped stores (decided). A single-process Node deployment whose
memory store really is the only copy can subclass it and declare `"global"`
(the e2e test-app does exactly that); that is a custom store declaring itself.

A non-shared store returns `{ ok: false, status: "skipped-store-not-shared" }`
before anything renders, and in dev warns once per router (the trigger's
warn-once flags, like #640's `markStale` warnings):

```txt
[rango] router.prerender("/x") did not warm: the cache store
(MemorySegmentCacheStore) declares scope "local", so entries written here serve
no other process, isolate or edge location. Warming needs a store whose scope
is "global" or "regional" (CFCacheStore with kv, VercelCacheStore), or a custom
store that declares one.
```

One compatibility note for review: a custom store class that already has a
member named `scope` of another type stops typechecking against
`SegmentCacheStore`, and at run time a non-matching value is refused (the safe
side). If that is a concern, `sharing` is a free name.

## Result shape

```ts
export interface PrerenderWarmCaches {
  /** Store writes that landed, by store family. */
  writes: { record: number; item: number; response: number; shell: number };
  /** The ppr shell. Absent on a route without ppr. */
  shell?:
    | "stored"
    | "refused"
    | "no-shell"
    | "not-eligible"
    | "skipped-capacity"
    | "skipped-queue-timeout"
    | "error";
  /** Why the capture refused (ShellCaptureDebugEvent.refusal). */
  refusal?:
    | "identity"
    | "dynamic"
    | "loader"
    | "no-record"
    | "size"
    | "invalidated"
    | "uncacheable";
  /** The document cache, when createDocumentCacheMiddleware ran. */
  document?: "stored" | "not-cacheable";
}

export type PrerenderResult =
  | {
      ok: true;
      path: "on-demand";
      status: "rendered" | "already-fresh";
      target: string;
      routeName: string;
      key: string;
      tags: string[];
      ttl?: number;
      /** The warm GET after the store write; absent on a non-shared store or with no origin. */
      caches?: PrerenderWarmCaches;
    }
  | {
      ok: true;
      path: "warm";
      status: "warmed" | "already-fresh";
      /** The absolute URL that was requested. */
      target: string;
      routeName: string;
      responseStatus: number;
      caches: PrerenderWarmCaches;
    }
  | {
      ok: false;
      /** Absent on no-match: every other result is past the route match. */
      path?: "on-demand" | "warm";
      status:
        | "no-match"
        | "no-store"
        | "skipped-unsupported-target"
        | "skipped-no-origin"
        | "skipped-personalized"
        | "skipped-passthrough"
        | "skipped-store-not-shared"
        | "shell-not-stored"
        | "skipped-uncached"
        | "render-failed"
        | "store-failed";
      target: string;
      routeName?: string;
      responseStatus?: number;
      caches?: PrerenderWarmCaches;
      error?: unknown;
    };
```

The warm's status, first match wins: the response was not 200, or the render
reported an error (`_renderErrors`): `render-failed`. The record holds an
identity refusal: `skipped-personalized`. The route declared `ppr` and the
shell is not `stored`: `shell-not-stored`. No write landed: `skipped-uncached`
in replace mode, `already-fresh` in fill mode. Otherwise `warmed`.

**`onlyIfStale` on a warm** is _fill_ mode: the request is marked (so the
runner can report it) but reads normally, so a miss renders and writes, a
stale entry serves and its SWR refresh runs (the runner waits for it), and a
fresh entry is left alone. That is exactly "top up what is cold or stale",
the cron-sweep meaning #640 gave the option, and it costs a visitor's request
when everything is fresh (a document-cache or shell HIT renders almost
nothing). Zero writes reports `already-fresh`. On an on-demand route the option
keeps #640's meaning, and a fresh overlay skips the warm GET too.

**`.many()`** dispatches each target on its own: one result per target, in
input order, under the one `concurrency` pool (default 1). The on-demand key
version still resolves once per batch; the cache config resolves per target.
`throwOnError` stops the batch at the first `ok: false`, refusals included. A
mixed batch on a local store therefore renders its on-demand targets and
refuses its warm targets, each reported.

## Answers to the open questions in #1062

1. **The synthetic request.** `GET` of the absolute visitor URL, search kept,
   `accept: text/html` only, no cookies, marked in process (a `WeakMap` on the
   `Request` object), dispatched through `router.fetch`'s handler with
   `runtime.env` and a collecting `ctx`. Recommend an optional `origin` on the
   binding for path and object targets called outside a request; identity reads
   are left to the existing guards and reported as `skipped-personalized`.
   Why: it is the only request whose keys equal a visitor's by construction, and
   a mark a client cannot set.
2. **Which caches.** The document shell (with its doc record), the route's
   `doc:` `cache()` records, the `"use cache"` results the render reaches, the
   loaders' own `cache()`, the document cache's `:html` entry, and a response
   route's cache. Leave navigation payloads to the first navigation, and do not
   warm a separate navigation shell: a `ppr` route's navigations replay the
   document entry, which the warm writes. Why: everything else depends on the
   source page or is a heal path. Follow-up worth measuring: the `partial:`
   record looks source-independent in content (a partial request with no
   client segments writes it directly, and revalidation rules run at lookup), so
   a second synthetic partial GET could fill it.
3. **A `Prerender` route's loaders.** One call does both, the requestless
   render first, then a warm GET in replace mode when the app store is shared.
   Why: the warm GET must render on top of the new overlay entry, or the
   document cache would keep (or re-bake) the old one; that ordering also
   rebuilds the document-cache entry, which #640 alone leaves stale until its
   `s-maxage` runs out. The on-demand status stays #640's; the warm's outcome
   rides `caches`. A failed render skips the warm.
4. **Result statuses.** `skipped-not-on-demand` is removed; the warm adds
   `warmed`, `skipped-store-not-shared`, `skipped-no-origin`, `shell-not-stored`,
   `skipped-uncached`, reuses `already-fresh`, `skipped-personalized`,
   `render-failed`, `no-store`, and every result past matching carries
   `path: "on-demand" | "warm"`. Per-cache outcomes go in `caches`
   (`writes` by family, `shell`, `refusal`, `document`). Why: a status a caller
   can branch on, detail a log can show, and `path` disambiguates `no-store`
   and `already-fresh`, which both paths can return.
5. **Testing.** Userland through `serveShellRequest` and the public runner
   (written: `prerender-warm.rsc-test.tsx`). `dispatch` does not apply: it
   renders response routes only. `serveShellRequest` needs one extension so the
   warm can render HTML in the rsc project (see the test plan).

## Where the decided design needs a correction

Each of these is stated so the review can decide; none is quietly built in.

- **"The old entry serves until the new one is written" holds per location.**
  On `CFCacheStore` with KV, other colos keep serving their L1 copy until it
  expires or a tag invalidation reaches it; entries under 60 s total never reach
  KV. The warm closes the cold window after a deploy or an `updateTag()`; it is
  not a cross-colo refresh for a content change that invalidated nothing
  (section "What the stores cannot do in place").
- **"The existing guards decide" needs a split.** Correctness guards are never
  bypassed (invariant 4). The capture's in-flight dedup, refused-capture backoff
  and `skip-stored`, and the `"use cache"` follower join, must be bypassed for
  the warm's own work, or a warm right after a visitor's capture, or within a
  60 s backoff window, returns having replaced nothing.
- **The capture must not run in the forced-miss mode,** and its write barrier
  needs a longer bound under a warm (invariant 10).
- **The host is part of every key, and the decided binding has no origin.** A
  path target from a cron or a queue has no host to request. Recommend
  `origin?: string` on `PrerenderRuntime` (additive). #640 also refuses search
  params; the warm needs them, so the unsupported-target check moves after the
  route is matched.
- **"The normal request handler" can only be `router.fetch`'s.** An entry that
  configures `createRSCHandler` directly (`cache`, `version`) is not seen.
- **"It replaces the URL's `cache()` entries"** means the document (`doc:`)
  records; the `partial:` and `intercept:` records are not reached.
- **The memory store is refused in dev,** so local dev on the Node preset shows
  only the refusal unless the app declares its store shared. The Cloudflare
  preset in dev runs `CFCacheStore` over miniflare KV and warms.

## Test plan

### Userland (written, red): `src/testing/__tests__/prerender-warm.rsc-test.tsx`

Through `router.prerender()` and `serveShellRequest`, on real Flight, with a
`SharedMemoryStore` (a `MemorySegmentCacheStore` subclass declaring
`"global"`):

| Test                                                                                        | Contract it pins                                                              |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| warming a ppr route fills its shell: the next document request is a HIT                     | a warm stores the shell a visitor's MISS would                                |
| warming replaces a shell in place: the old shell serves until the new one is written        | no eviction up front; the next HIT serves the newer render                    |
| warming a route with cache() fills its record                                               | the `doc:` record is written; the visitor is a record HIT                     |
| warming replaces a cache() record a visitor wrote                                           | the read misses although a fresh record exists; the write replaces it         |
| a store whose entries live in one process is refused, and nothing renders                   | `skipped-store-not-shared` for `MemorySegmentCacheStore`, no render           |
| a custom store that declares no scope is refused                                            | undeclared is treated as local                                                |
| a route that reads cookies() stores no shell and reports skipped-personalized               | the capture's identity guard decides and is reported                          |
| `.many()`: one result per target, in order, each with its path's status                     | mixed dispatch, `path` on each result                                         |
| `.many()` on a local store: the on-demand target renders, the warm target is refused        | #640 is unaffected by the store's scope                                       |
| an on-demand route keeps the requestless render of #640, then warms its loaders' own caches | open question 3: render first, then the warm GET fills the loader's `cache()` |

**The primitive extension.** The warm renders through `router.fetch`, whose
default `loadSSRModule` is `import.meta.viteRsc.loadModule("ssr", "index")`,
which the rsc Vitest project cannot run (and `react-dom/server` refuses to load
under the `react-server` condition). `serveShellRequest` already stubs exactly
that one module. The extension: `src/rsc/handler.ts` gains an internal
`setDefaultSSRModuleLoaderForTests(loader)` consulted where the default
`loadSSRModule` is chosen, and `testing/serve-shell-request.ts` installs its
`SSR_STUB` there when it loads. Everything else on the warm's path is
production code: `router.fetch`, `createRSCHandler`, the match pipeline, the
capture. Two things a test author must know: the warm writes to the store
`createRouter({ cache })` configures, not to `serveShellRequest`'s
`cacheStore` override, so a warm test configures the store on the router; and
`router.fetch` binds its handler's document version once, as a production
isolate does, so a test that moves versions with `setBuildVersions()` between
warms gets the first version's handler.

### Unit

- `src/cache/__tests__/store-scope.test.ts` (written, red): memory `"local"`,
  `CFCacheStore` with KV `"global"`, without KV `"local"`, without KV in purge
  mode `"local"`, `VercelCacheStore` `"regional"`.
- `src/prerender/__tests__/create-prerender-trigger.test.ts` (extend): dispatch
  table with fake deps (od vs warm, origin resolution order, search kept for warm
  and refused for od, reserved params, `no-store`, scope gate incl. undeclared,
  dev warning once per router, status derivation from a record, `onlyIfStale`
  fill mode, `.many()` order and `throwOnError` on a refusal, od follow-up warm
  only on shared stores and only after `rendered` / `skipped-passthrough`).
- `src/prerender/__tests__/warm-request.test.ts` (new): the mark is per
  `Request` object (a clone or a rebuilt request carries none), `isWarmReplace`
  is false under `_shellCaptureRun` and in fill mode, `noteWarmWrite` is a no-op
  without a record.
- Per layer, the forced miss and the unchanged guards, each with a record on a
  hand-built request context: `cache-scope.test.ts` (miss without `store.get`;
  `cache(false)` and a false `condition()` still `bypass`; the write still gated
  by `predatesInvalidation`), `cache-runtime-inflight.test.ts` (no follower join;
  the warm replaces the leader; followers of the warm get its envelope),
  `run-loader-cache.rsc-test.ts` (miss, identity rule unchanged),
  `document-cache.test.ts` (miss; `private`/`Set-Cookie` still refused; outcome
  recorded), `shell-capture.test.ts` (`force` bypasses in-flight, backoff and
  skip-stored, keeps capacity; the barrier bound; `refusal` on the event),
  `server/__tests__/cookie-store.test.ts` (an identity throw records
  `identity`), a response-route case in the dispatch suite.

### Browser e2e (planned; dev and `(production)` describes in both apps)

Both apps get a trigger route that calls `router.prerender({ env, ctx })` and
returns the result as JSON (like `OnDemandTrigger`), and fixtures with a
monotonic stamp per handler run: a `ppr` route, a `cache()` route, a `ppr` route
reading `cookies()`, and an on-demand route with a cached loader.

- `packages/rangojs-router/e2e/prerender-warm.test.ts` (test-app, Node). The
  test-app runs one process with a `MemorySegmentCacheStore`; its `cacheStore`
  becomes a subclass declaring `scope = "global"` (true for a one-process
  deployment, and the only behavior the declaration changes is the warm gate).
  Cases per mode: warm, then the next document is `x-rango-shell: HIT` with the
  warm's stamp; a visitor fills, the fixture's content moves, warm, the next HIT
  shows the new stamp; the `cache()` route serves the warm's stamp; the cookie
  route returns `skipped-personalized` and stays MISS; `.many()` mixed; a second
  `onlyIfStale` warm returns `already-fresh`.
- `tests/cloudflare-basic/e2e/prerender-warm.test.ts` (CFCacheStore + miniflare
  KV, `"global"`): the same cases. Dev and production share the miniflare KV, so
  each mode uses its own URLs. The refusal runs under
  `playwright.edge-only.config.ts`, where `RANGO_E2E_EDGE_ONLY_CACHE` builds the
  store without KV (`"local"`): a new `edge-only-prerender-warm.test.ts`, added
  to that config's `testMatch` for both the `edge-only-dev` and
  `edge-only-production` projects (CI already runs both, `e2e.yml`), asserts
  `skipped-store-not-shared` and a following MISS. That is the only shipped
  configuration where a refusal is observable end to end; the memory-store
  refusal stays unit and userland.

`pnpm check:e2e-bucketing` and `check:e2e-parity --strict` cover the titles.
The semantic matrix is unaffected (no middleware, ordering or visibility
change) and must stay green.

## Build estimate

Approximate non-test lines.

| Piece                                                                              | Files                                                                                                                       | Lines |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----- |
| Store declaration                                                                  | `cache/types.ts`, `memory-segment-store.ts`, `cf/cf-cache-store.ts`, `vercel/vercel-cache-store.ts`                         | 40    |
| Mark, record, predicate, write counter                                             | `prerender/warm-request.ts` (new), `server/request-context.ts`                                                              | 90    |
| Warm runner (URL and origin, request, collecting ctx, drain, settle, status)       | `prerender/warm.ts` (new)                                                                                                   | 160   |
| Dispatch, statuses, binding `origin`                                               | `prerender/create-prerender-trigger.ts`, `prerender/on-demand.ts`, `router.ts`                                              | 230   |
| Handler: read the mark, attach the record, reuse the gated config; test SSR loader | `rsc/handler.ts`                                                                                                            | 30    |
| Forced miss, six read points                                                       | `cache-scope.ts`, `cache-runtime.ts`, `loader-cache.ts`, `rsc-rendering.ts`, `document-cache.ts`, `response-cache-serve.ts` | 60    |
| Capture `force`, barrier bound, `refusal` field                                    | `rsc/shell-capture.ts`                                                                                                      | 35    |
| Identity record, write counts                                                      | `server/context.ts`, the write sites above                                                                                  | 15    |
| Testing primitive                                                                  | `testing/serve-shell-request.ts`                                                                                            | 10    |
| **Total**                                                                          |                                                                                                                             | ~670  |

Plus the internal reference docs (`docs/internal/feature-map.md`,
`feature-file-map.md`, `docs/README.md`), this doc and
`ondemand-prerender.md` updated, and the skills (`prerender`, `caching`, `ppr`,
`cloudflare`, `vercel`, `testing`): the store contract, the statuses, the CF
and Vercel scope notes, the `serveShellRequest` note.

### Risks: what an existing app could notice

- **Every request reads one more field** at six cache read points
  (`ctx?._prerenderWarm`). No measurable cost; no behavior change without a
  mark.
- **A webhook that calls `router.prerender()` for a plain route now renders
  and writes** instead of answering `skipped-not-on-demand`. #640 is unreleased,
  so no app depends on the old answer, but a stray caller costs a page render
  per call.
- **Middleware, `onError` and telemetry see warm requests:** an anonymous GET
  with no user agent, no IP header and no `request.cf`. Analytics that count
  document GETs count warms; a rate limiter keyed by IP sees an empty key. No
  public way to tell a warm in v1 (a read-only `isPrerenderWarm()` is a
  possible follow-up; the mark itself must stay unforgeable).
- **A runtime shell can now shadow a build shell** for a `Prerender` + `ppr`
  route that is warmed. Same content source (the build entry), but the runtime
  entry carries the route's `ppr.ttl`.
- **`ShellCaptureDebugEvent` gains `refusal`**, and `PrerenderResult` changes
  shape (new statuses, `path`, `caches`, no `skipped-not-on-demand`). Additive
  for the event; for the result, no released consumer exists.
- **A custom store with an unrelated `scope` member** stops typechecking.
- **Cost:** a warm costs a visitor's MISS: one render, plus a capture on a `ppr`
  route (which renders again unless the route has its own `cache()`, exactly as
  a visitor's MISS does). The settle bound per target is about 40 s in the worst
  case (capture hard cap plus queue wait), so a large list belongs in a queue,
  one message per batch, as #640 already says.
- **Races that already exist stay:** a visitor's SWR refresh, or a capture in
  another isolate, that started before the warm can land after it with an older
  render. Bounded by one ttl; the same race two visitors have.
- **Gradual deployments:** a warm fills only the version that received the
  call; each live worker version reads its own keys (per-app versions).
