# router.prerender() for every route

**Status:** Built. Issue #1062; stacks on #640
(`docs/design/ondemand-prerender.md`) and ships in the same release. The
analysis below is the design as reviewed, kept so you can see why each piece
is where it is; where the build differs from what was first written, the
text says what was built, and "What changed between the design and the build"
lists every difference in one place. The consumer-facing version is the
`prerender` skill ("Warm any route before traffic").

Where it lives: the dispatch in `src/prerender/create-prerender-trigger.ts`,
the request and its wait in `src/prerender/warm.ts`, the mark, record and
predicate in `src/prerender/warm-request.ts`, the scope gate in
`src/cache/store-scope.ts`. Tests: the userland suites
`src/testing/__tests__/prerender-warm.rsc-test.tsx` and
`prerender-warm-layers.rsc-test.tsx`, the unit tests listed under "Test plan",
and `e2e/prerender-warm.test.ts` in both apps.

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
11. **A warm renders outside the scopes of the code that called it.** Called
    from a handler, a loader or an action, it runs in the async context that
    request entered the handler with, not in the caller's (see "Nested
    calls").
12. **A warm starts in a later millisecond than the call.** So the
    invalidation in `await updateTag(tag)` then `prerender(url)` never refuses
    the warm's own shell.

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
  +-- no:  hash, _rsc*, __no_cache, __rsc, __html ----> skipped-unsupported-target
           origin: target, runtime.origin, ambient request
             +-- none --------------------------------> skipped-no-origin
           resolve createRouter({ cache }) with (env, collecting ctx)
             +-- none / enabled: false ---------------> no-store
             +-- scope not global or regional --------> skipped-store-not-shared (dev: warn once)
           warm GET (replace; fill with onlyIfStale)
             -> warmed | already-fresh | skipped-personalized | shell-not-stored
                | skipped-uncached | render-failed
```

A target that does not parse as an http(s) URL or a path is
`skipped-unsupported-target` before the match; every other check runs after
it, because the route decides which rules apply (an on-demand key carries no
search, a warm's keys do).

#640's `skipped-not-on-demand` is gone: that branch is now the warm path. #640
is not released yet, so the status is removed, not deprecated. (#1060 gave the
name to `prerender.remove()` on a route that is not on-demand, which must
never turn into a warm; a refresh still never returns it. See
`ondemand-prerender.md`, "Removing A Page".)

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

| Layer                | Hook point (file:function)                                                                                                                                                                                           | Reached through the normal pipeline?           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Route `cache()`      | `cache/cache-scope.ts:CacheScope.lookupRouteDetailed`, before `store.get`                                                                                                                                            | yes, plus the predicate                        |
| Loader `cache()`     | `router/segment-resolution/loader-cache.ts:executeLoaderData`, the `getItem` passed to `readThroughItem`                                                                                                             | yes, plus the predicate                        |
| `"use cache"`        | `cache/cache-runtime.ts:registerCachedFunction` (the wrapper), `store.getItem` and the in-flight follower loop                                                                                                       | yes, plus the predicate                        |
| PPR document shell   | `rsc/rsc-rendering.ts:shellServePlan` (`readShellEntry`, `lookupBuildShell`, `storedSeqAtRead`, the descriptor); `rsc/shell-capture.ts:scheduleShellCapture` and `attemptCapture` via `ShellCaptureDescriptor.force` | yes, plus the predicate and `descriptor.force` |
| Navigation shell     | none                                                                                                                                                                                                                 | not warmed; see below                          |
| Document cache       | `cache/document-cache.ts:createDocumentCacheMiddleware`, the `getResponse`                                                                                                                                           | yes, plus the predicate                        |
| Response-route cache | `rsc/response-cache-serve.ts:serveResponseRouteWithCache`, the `getResponse`                                                                                                                                         | yes, plus the predicate                        |

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
- stamps `record.shell ??= "not-eligible"` at the top of the plan when the
  route declares `ppr` (`resolvePprConfig`), ahead of every gate, so a `ppr`
  route that passes on one (a request already marked `ctx.dynamic()`, a nonce,
  no shell family, an opt-out, a failed partition key, `allReady`) reports it.
  A capture event overwrites it, and so does a served HIT in fill mode
  (`"fresh"`). The stamp is also how the runner knows the route declared
  `ppr`: a route without it leaves `record.shell` unset.

The sink is chained for a warm in either mode (a fill-mode MISS or stale HIT
schedules an ordinary capture, and the runner still wants its outcome); the
skipped reads, the unset sequence and `force` are replace mode only.

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
`SHELL_CAPTURE_TASK_HARD_CAP_MS` after the capture budget
(`max(1500, 25000 - (ppr.captureTimeout ?? 15000))` ms, 10 s by default, both
existing constants): the warm is not latency-bound, and an old entry baked
into a new shell is exactly what a warm must not produce.

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
  are `ShellCaptureRefusal` (`rsc/shell-capture-constants.ts`), listed under
  `PrerenderWarmCaches.refusal` in "Result shape".
- **The write count:** `noteWarmWrite(reqCtx, "shell")` after a `putShell`
  that was not refused; the capture's derived context inherits the record.

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
warm closes the cold window after a deploy (new version, no colo holds a copy,
each one reads the warm's KV entry), but it is not a cross-colo refresh for a
content change that invalidated nothing. After an `updateTag()` it depends on
what a colo holds, see below. Two smaller cases:

- `CFCacheStore` skips the KV write for a segment, item or response entry whose
  `ttl + swr` is under 60 s (KV's minimum `expirationTtl`; `kvSetSegment`,
  `setItem`, `putResponse`). A warm of such an entry fills the calling colo
  only. Shells always reach KV (60 s floor).
- Isolate memos in other isolates (the shell memo, 2 s by default; the marker
  memo) serve their copy for their window.

None of this needs a store contract change; it is what the platform offers,
and it is decided: the stores are not changed. A global content refresh is two
calls, `await updateTag(tag)` and then `await prerender(url)` (a webhook is a
request, so `updateTag()` works there): the invalidation makes every colo's
copy unservable, and the warm writes the new entry to the calling colo and to
KV. What another colo does on its next read depends on what it holds:

- **No copy of its own** (it never served the URL, its copy expired, or
  `tagPurge` evicted it): an L1 miss, so it reads the warm's entry from KV and
  renders nothing.
- **Its own, now invalidated, copy:** it answers a miss and renders once for
  itself. `CFCacheStore.get` (and `getItem`, and the shell read) return `null`
  for an invalidated L1 hit without reading the entry's KV key; the comment
  there calls the KV fall-through a deferred follow-up. It never serves the
  old copy, and its own render heals it.

So the pattern guarantees that no location serves the old content and that
the calling location and every location without a copy are ready. It does not
spare a render to a colo that was serving the old copy, unless the store runs
in purge mode. That is narrower than "their next read finds the warmed entry
in KV", which is how the decision was first worded; the test below is what
showed it.

Two tests pin the sequence, at the two levels it crosses:

- `src/cache/cf/__tests__/cf-cache-store-warm-refresh.test.ts` runs two
  `CFCacheStore` instances over one fake KV, each with its own fake Cache API
  (two colos). It shows the read flow the pattern relies on: without an
  invalidation the other colo keeps serving its own L1 copy after the warm's
  write; after `updateTag` and then the write, a colo with no copy (or whose
  copy a purge evicted) reads the warmed entry from KV, and a colo holding the
  old copy stops serving it; an entry under 60 s never reaches the other colo.
  It cannot show Cloudflare's KV propagation delay (a write "may take up to 60
  seconds or more to be visible in other global network locations"), real
  per-colo Cache API isolation, or the isolate memo windows: those are
  platform behavior.
- `src/testing/__tests__/prerender-warm-layers.rsc-test.tsx` ("updateTag(tag),
  then prerender(url)") runs the two calls from one route handler through the
  router: the warm's own record and shell are stored, not refused by the
  invalidation that preceded them.

That second test is why a warm starts in a later millisecond than the call
(`prerender/warm.ts`, `runWarmRequest`). A store refuses a shell whose capture
started in the millisecond of an invalidation of one of its tags (`putShell`'s
generation gate compares whole milliseconds, and cannot tell "just before"
from "just after" inside one). On a memory store the two calls land in one
millisecond often enough that the test failed one run in three before the
wait was added. The wait is bounded (`awaitLaterMillisecond`,
`cache/background-task.ts`, ten macrotask turns): on Cloudflare the clock
stands still between I/O events, so an unbounded wait could hang a warm. At
the bound the warm proceeds, a store may refuse the shell write, and the result
says so (`shell-not-stored`).

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
  mode (the router's reserved set, `isReservedSearchParam` in
  `cache/cache-key-utils.ts`: `_rsc*`, which covers `_rsc_shell`, and
  `__no_cache`, `__rsc`, `__html`), are `skipped-unsupported-target`. A
  consumer's own `__variant=b` is a page like any other. An `origin` option
  that is not a URL is `skipped-no-origin` with the parse error.
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
  the gated cache config, the shell outcome and refusal, the identity surface
  that was refused, the document-cache outcome, the write counts by family,
  and the request's render errors (the record owns the list; the handler adopts
  it as the request's `_renderErrors`). The layers write it:
  the capture sink (`shell`, `refusal`), the identity guards where they throw
  (`guardIdentityRead`, `refuseInCacheScope`: `identity`), the document cache
  (`document`, its store write counted with the rest), and one `noteWarmWrite(ctx, family)` call after each successful
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
  server action). The handler opens its own request context, but that is not
  enough: the caller also sits inside every other `AsyncLocalStorage` scope of
  its request, and a request dispatched from there inherits them. The one that
  broke first is the route-definition store: `router/manifest.ts loadManifest`
  builds a route's manifest into `getContext()`'s store, which for a top-level
  request is a fresh detached one and for a nested request was the calling
  route's. A warm called from a route handler answered 404 for every route no
  visitor had requested yet (a visitor's request fills the module-level
  manifest cache, which hid it afterwards). The loader and `cache()` scope
  flags the identity guards read, and the tag scopes, would leak the same
  way from a loader or a cached handler.

  So a request captures the async context it entered the handler with
  (`captureRequestEntryContext`, `RequestContext._runAtRequestEntry`, set in
  `rsc/handler.ts` before any router scope), and the runner dispatches the
  warm through the calling request's (`router.ts`, the trigger's `fetch`
  dep). With no calling request there is no scope to leave. It is captured
  per request, not once per module: workerd refuses to run a snapshot outside
  the request that created it ("Cannot call this AsyncLocalStorage bound
  function outside of the request in which it was created"), which is what a
  module-level snapshot did on the Cloudflare preset. The cost is one
  `AsyncLocalStorage.snapshot()` per request, about 0.8 µs measured on Node
  24; a runtime without `snapshot` skips it and a warm there runs in the
  caller's context.

- **Start:** in a later millisecond than the call (see "What the stores
  cannot do in place").

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
(`create-prerender-trigger.ts`, through `resolveWarmStoreScope` in
`cache/store-scope.ts`), on the app-level store. Explicit
`cache({ store })` and loader stores are written by the warm without a check:
which ones a render reaches is not known before it renders, and a write to a
local one is wasted work, not a wrong one. Nothing else reads it in v1.

| Store                              | `scope`      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MemorySegmentCacheStore`          | `"local"`    | Per process: "Suitable for development and single-instance deployments" (`memory-segment-store.ts`). Under the Vite dev server the gate counts it as shared: see below.                                                                                                                                                                                                                                                                                                                                                                    |
| `CFCacheStore` with `kv`           | `"global"`   | `cf-cache-store.ts` header: "L1 (Cache API): Per-colo, fast, ephemeral. Handles SWR atomically. L2 (KV): Global, persistent, ~50ms reads. Auto-warms cold colos." Read flow "L1 hit → serve \| L1 miss → L2 hit → serve + promote to L1". Cloudflare: "KV is a global, low-latency, key-value data store. It stores data in a small number of centralized data centers"; a write "may take up to 60 seconds or more to be visible in other global network locations". Set from `options.kv` in the constructor, next to `tagHistoryInert`. |
| `CFCacheStore` without `kv` (#819) | `"local"`    | L1 only: the Cache API is per colo. Purge mode (`tagPurge`) evicts across the zone but stores nothing beyond the colo, so it stays local.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `VercelCacheStore`                 | `"regional"` | Vercel: "Runtime cache is a regional, ephemeral cache ... within a Vercel region"; "Each region has its own cache". Functions "execute in Washington, D.C., USA (`iad1`) for all new projects"; Hobby runs one region, Pro up to 5, Enterprise all; entries can be evicted early (LRU at the storage limit). Decided: allowed for single-region deployments, by documentation only, no runtime region detection.                                                                                                                           |
| A custom store                     | its own      | Only if it declares itself. A store without the field is treated as `"local"` and refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The memory store stays `"local"` and refused by default in production
(decided). It is per process, and the router cannot tell one long-running
server from several replicas or serverless instances: counting it as shared
would report `warmed` while most visitors hit cold instances. An author who
does run one process opts in with
`new MemorySegmentCacheStore({ scope: "global" })`
(`MemorySegmentCacheStoreOptions.scope`, default `"local"`; the e2e test-app
does this, which is what lets its production describe warm). Instances sharing
a `name` share their maps, but `scope` is per instance, as `defaults` and
`keyGenerator` already are (see the option's JSDoc): the store does not
reconcile them, and the author keeps them identical.

**The memory store in dev (decided).** Refusing it everywhere would leave an
author on the Node preset with nothing to try: every warm in local dev would
answer the refusal. So under the Vite dev server the gate treats a
`MemorySegmentCacheStore` as `"global"`: one process serves every dev request,
so the entry a warm writes is the entry the next request reads. "Dev" here is
the dev server itself, not `NODE_ENV`: `isViteDevServer()` (which the
not-shared warning below reads too, so the warning and the rule cannot
disagree) reads the origin the
routes-manifest virtual module sets (`globalThis.__PRERENDER_DEV_URL`), which a
build, a preview server and a test runner never have. In production the store
stays `"local"` and is refused. The class's `scope` declaration never moves
(`store-scope.test.ts` pins `"local"`); only the gate reads the dev rule. If
the production answer is ever revisited, it is that one declaration in
`memory-segment-store.ts`.

The shared-store check covers the app store only. A warm also overwrites
entries in a route's or loader's own `cache({ store })` (the forced miss is a
flag read at each read point, not a wrapper on the app store, because
`CacheScope.getStore` lets an explicit store bypass it and the `"use cache"`
in-flight dedup lives outside any store), and that store is not checked: a
`local` explicit store is warmed for the calling process only.

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

One compatibility note: a custom store class that already has a member named
`scope` of another type stops typechecking against `SegmentCacheStore`, and at
run time a value the router does not know is refused (the safe side;
`warm-store-scope.test.ts`).

## Result shape

```ts
export interface PrerenderWarmCaches {
  /** Store writes that landed, by store family. */
  writes: { record: number; item: number; response: number; shell: number };
  /** The ppr shell. Absent on a route without ppr. */
  shell?:
    | "stored"
    | "fresh" // onlyIfStale found a servable shell
    | "refused"
    | "no-shell"
    | "not-eligible"
    | "skipped-capacity"
    | "skipped-queue-timeout"
    | "error";
  /** Why the capture refused (ShellCaptureRefusal). */
  refusal?:
    | "identity"
    | "dynamic"
    | "loader"
    | "no-record"
    | "handles"
    | "size"
    | "record-expired"
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

The warm's status (`warmStatus` in `prerender/warm.ts`), first match wins:
the record holds an identity refusal: `skipped-personalized`. The handler
threw, the response was not 200, or the render reported an error
(`_renderErrors`): `render-failed`. The route declared `ppr` and the shell is
neither `stored` nor `fresh`: `shell-not-stored`. No write landed:
`skipped-uncached` in replace mode, `already-fresh` in fill mode. Otherwise
`warmed`. The identity check comes first because the guard throws: a cookie
read inside a `cache()` boundary also fails the render, and
`skipped-personalized` is the cause a caller can act on.

`shell-not-stored` is `ok: false` even when another cache wrote: the route
declared a shell and the next visitor will not get one. `caches` still shows
every write that landed.

**`onlyIfStale` on a warm** is _fill_ mode: the request is marked (so the
runner can report it) but reads normally, so a miss renders and writes, a
stale entry serves and its SWR refresh runs (the runner waits for it), and a
fresh entry is left alone. That is exactly "top up what is cold or stale",
the cron-sweep meaning #640 gave the option, and it costs a visitor's request
when everything is fresh (a document-cache or shell HIT renders almost
nothing). Zero writes reports `already-fresh`, and a served shell reports
`caches.shell: "fresh"`. On an on-demand route the option
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

## Where the decided design needed a correction, and what was decided

The write-up raised seven points where the design as first decided did not
hold. The maintainer approved each recommendation; this is what was built.

1. **"The old entry serves until the new one is written" holds per
   location.** On `CFCacheStore` with KV, other colos keep serving their L1
   copy until it expires or a tag invalidation reaches it; entries under 60 s
   total never reach KV. Decided: do not change that. A global content refresh
   is `updateTag(tag)` and then `prerender(url)`, documented in the skills and
   pinned by the two tests named under "What the stores cannot do in place".
   The tests narrowed the claim: a colo still holding the invalidated copy
   renders once instead of reading the warmed entry.
2. **"The existing guards decide" needed a split.** Built as written: a
   warm's capture bypasses the in-flight dedup, the refused-capture backoff and
   `skip-stored`, and a warm leads its `"use cache"` execution instead of
   joining one. Every correctness guard decides as for a visitor: identity
   reads, the tag-invalidation write gates, render errors, `maxSnapshotBytes`
   and the store limits, `cache(false)` and `condition()`, the document
   cache's refusals, queue capacity.
3. **The capture must not run in the forced-miss mode,** and its write
   barrier gets a longer bound under a warm (invariant 10; the bound reuses
   `SHELL_CAPTURE_TASK_HARD_CAP_MS` and the capture budget).
4. **The host is part of every key, and the decided binding had no origin.**
   Built: an optional `origin` on the binding, else the calling request's
   origin, else `skipped-no-origin` for a warm target (the on-demand render
   never needs one). #640's search-param rejection moved after the route
   match: a warm target keeps its search params, an on-demand target still
   rejects them.
5. **"The normal request handler" can only be `router.fetch`'s.** An entry
   that configures `createRSCHandler` directly (`cache`, `version`) is not
   seen. Documented; no code.
6. **"It replaces the URL's `cache()` entries"** means the document (`doc:`)
   records; the `partial:` and `intercept:` records are not reached and fill
   on the first navigation. Documented.
7. **The memory store is refused in dev** as first written. Decided
   otherwise: it counts as shared under the Vite dev server and stays `local`
   in production (see "The store declaration").

### What changed between the design and the build

Things the write-up did not have, or had differently. Each is described where
it belongs above; this is the list.

- **A warm leaves the caller's async context** (invariant 11, "Nested
  calls"). The write-up said the handler's own request context was enough. It
  was not: a warm called from a route handler answered 404 for a route no
  visitor had requested yet.
- **A warm starts in a later millisecond than the call** (invariant 12).
  Found by the userland test for decision 1.
- **The status order:** an identity refusal is checked before a failed
  render, not after.
- **`caches.shell` has `"fresh"`,** for `onlyIfStale` finding a servable
  shell; without it a fill-mode HIT read as `shell-not-stored`.
- **`refusal` has two more values,** `"handles"` and `"record-expired"`: two
  existing refuse exits the first list did not name.
- **The test SSR loader lives in a leaf module,** `rsc/ssr-module-loader.ts`,
  not in `rsc/handler.ts`: `testing/serve-shell-request.ts` must install its
  stub when it loads, and it cannot import the handler at module scope (the
  handler binds build-only virtual modules).
- **The reserved search params** are the router's existing set
  (`isReservedSearchParam`), which adds `__rsc` and `__html` to the ones the
  write-up listed.
- **The edge-only refusal e2e was not built.** The refusal is pinned by the
  trigger's unit tests and the userland test; the browser suites cover the
  four behaviors a browser adds something to.
- **An on-demand route's existing triggers now also send a warm request**
  when the app store is shared and an origin resolves, including #640's own
  e2e fixtures. Their statuses are unchanged; the result gains `caches`.

## Test plan

What is written, and the contract each suite pins.

### Userland: through `router.prerender()` and `serveShellRequest`

On real Flight, with `new MemorySegmentCacheStore({ scope: "global" })`.

`src/testing/__tests__/prerender-warm.rsc-test.tsx` (the 10 tests written red
with this design, unchanged):

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

`src/testing/__tests__/prerender-warm-layers.rsc-test.tsx` (22 tests) does the
same for what that file does not reach: a loader's own `cache()`, `"use
cache"`, the document cache (and its `private` refusal), a response route's
cache; the key a warm writes under (search params, `cache.searchParams`, the
host); the origin (`skipped-no-origin`, the binding's `origin`, the calling
request's); a warm called from a route handler for a route no visitor has
requested (the nested-call regression, red without `_runAtRequestEntry`);
`updateTag(tag)` then `prerender(url)` from one handler; `onlyIfStale`; and
each refusal a visitor can provoke (`skipped-uncached`, `render-failed` on a
middleware redirect, `skipped-personalized` for a cookie read inside
`cache()`, `shell-not-stored` for `ctx.dynamic()`).

**The primitive extension.** The warm renders through `router.fetch`, whose
default `loadSSRModule` is `import.meta.viteRsc.loadModule("ssr", "index")`,
which the rsc Vitest project cannot run (and `react-dom/server` refuses to load
under the `react-server` condition). `serveShellRequest` already stubs exactly
that one module. The extension: `src/rsc/ssr-module-loader.ts`, an import-free
leaf holding `setDefaultSSRModuleLoaderForTests(loader)`, consulted in
`rsc/handler.ts` where the default `loadSSRModule` is chosen;
`testing/serve-shell-request.ts` installs its `SSR_STUB` there when it loads.
Everything else on the warm's path is production code: `router.fetch`,
`createRSCHandler`, the match pipeline, the capture. Two things a test author
must know: the warm writes to the store `createRouter({ cache })` configures,
not to `serveShellRequest`'s `cacheStore` override, so a warm test configures
the store on the router; and `router.fetch` binds its handler's document
version once, as a production isolate does, so a test that moves versions with
`setBuildVersions()` between warms gets the first version's handler.

### Unit

- `src/cache/__tests__/store-scope.test.ts` (5, written red): memory `"local"`,
  `CFCacheStore` with KV `"global"`, without KV `"local"`, without KV in purge
  mode `"local"`, `VercelCacheStore` `"regional"`.
- `src/cache/__tests__/warm-store-scope.test.ts`: `resolveWarmStoreScope`
  (declared, undeclared, an unknown value, the memory store in and out of the
  dev server, `isViteDevServer`).
- `src/prerender/__tests__/create-prerender-trigger.test.ts`: the dispatch
  table with fake deps (on-demand vs warm, the origin order, search kept for a
  warm and refused for on-demand after the match, reserved params, `no-store`,
  the scope gate incl. undeclared, the dev warning once per router, each
  status, `onlyIfStale` fill mode, `.many()` order, default concurrency and
  `throwOnError` on a refusal, the follow-up warm only after `rendered` /
  `skipped-passthrough` and only on a shared store with an origin).
- `src/prerender/__tests__/warm-request.test.ts`: the mark is per `Request`
  object, `isWarmReplace` is false under `_shellCaptureRun` and in fill mode,
  the record's writers, `noteWarmShellEvent`.
- `src/prerender/__tests__/warm.test.ts`: the request (a GET, `accept:
text/html` only, marked), the collecting context, the drain, the wait for
  nested background work, the later-millisecond start, `warmStatus`,
  `warmCaches`.
- `src/server/__tests__/request-entry-context.test.ts`:
  `captureRequestEntryContext`.
- Per layer, the forced miss and the unchanged guards, each with a record on
  the file's own request context: `cache-scope.test.ts` (miss without
  `store.get`; `cache(false)` and a false `condition()` still `bypass`; the
  write under the visitor's key; a write whose tag was invalidated still
  refused), `cache-runtime-inflight.test.ts` (no follower join; the warm
  replaces the leader; a later caller joins the warm), `document-cache.test.ts`
  (miss; `private` / no `s-maxage` / `Set-Cookie` still refused; outcome
  recorded), `rsc/__tests__/response-cache-serve.test.ts`,
  `shell-capture.test.ts` and `shell-capture-queue-skip.test.ts` (`force`
  bypasses in-flight and backoff, keeps the inert-store skip, capacity and the
  queue timeout; the barrier bound; `refusal` at every refuse exit; the write
  count; a throwing `putShell`), `rsc-rendering-shell-ppr.test.ts` (replace
  mode reads no shell and no build shell and forces the capture; the sink
  order; `not-eligible` at each gate; fill mode), `server/__tests__/
cookie-store.test.ts` (an identity throw records `identity`).
- `src/cache/cf/__tests__/cf-cache-store-warm-refresh.test.ts`: the
  `updateTag` then warm sequence across two colos (see "What the stores cannot
  do in place").

### Browser e2e (dev and `(production)` describes in both apps)

Six shared bodies in `tests/shared-e2e/src/index.ts` (`PrerenderWarmFixture`),
run by `packages/rangojs-router/e2e/prerender-warm.test.ts` (test-app, Node)
and `tests/cloudflare-basic/e2e/prerender-warm.test.ts` (CFCacheStore over
miniflare KV). Each app has a trigger route that calls
`router.prerender({ env })` with no `origin` and answers the result as JSON,
and fixtures whose stamp carries a per-`?probe=` generation a test moves on.

- warming a `ppr` route makes the next document request `x-rango-shell: HIT`,
  and it hydrates clean (`guardHydrationErrors`, a client counter);
- a warm replaces a stored shell: the next document shows the newer render;
- a warm replaces a route `cache()` record a visitor's request wrote;
- a route that reads `cookies()` reports `skipped-personalized` and stays a
  MISS;
- a route handler's `.many()` with no `origin` warms on the request's origin,
  an on-demand and a plain target in one batch;
- `onlyIfStale` leaves a warmed shell alone (`already-fresh`).

The test-app runs one process with a memory store; its `cacheStore` is
`new MemorySegmentCacheStore({ scope: "global" })`, which is what lets the production
describe warm. The edge-only refusal suite the plan had
(`edge-only-prerender-warm.test.ts`) was not built: the refusal renders
nothing, so a browser adds nothing to the unit and userland coverage.

`pnpm check:e2e-bucketing` and `check:e2e-parity --strict` cover the titles.
The semantic matrix is unaffected (no middleware, ordering or visibility
change) and stays green.

## What was built

The estimate was about 670 non-test lines. The build added 1,024 and removed
57: 622 lines of code, 350 of JSDoc and comments, 52 blank. Added lines, by
piece:

| Piece                                                              | Files                                                                                                                                               | Lines |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Store declaration and the gate                                     | `cache/types.ts`, `cache/index.ts`, `memory-segment-store.ts`, `cf/cf-cache-store.ts`, `vercel/vercel-cache-store.ts`, `cache/store-scope.ts` (new) | 78    |
| Mark, record, predicate, writers                                   | `prerender/warm-request.ts` (new), `server/request-context.ts` (the field)                                                                          | 151   |
| Warm runner (request, collecting ctx, drain, settle, status)       | `prerender/warm.ts` (new)                                                                                                                           | 187   |
| Dispatch, statuses, binding `origin`, result types                 | `prerender/create-prerender-trigger.ts`, `prerender/on-demand.ts`, `prerender/index.ts`, `router.ts`, `cache/cache-key-utils.ts`                    | 346   |
| Handler: the mark, the record, the gated config, the entry context | `rsc/handler.ts`, `server/request-context.ts` (`captureRequestEntryContext`)                                                                        | 50    |
| Forced miss at the read points, write counts, the identity note    | `cache-scope.ts`, `cache-runtime.ts`, `loader-cache.ts`, `rsc-rendering.ts`, `document-cache.ts`, `response-cache-serve.ts`, `server/context.ts`    | 84    |
| Capture `force`, the barrier bound, `refusal`                      | `rsc/shell-capture.ts`, `rsc/shell-capture-constants.ts`                                                                                            | 90    |
| Testing primitive                                                  | `rsc/ssr-module-loader.ts` (new), `testing/serve-shell-request.ts`, `testing/index.ts`                                                              | 38    |
| **Total**                                                          |                                                                                                                                                     | 1,024 |

Where the extra went: the result type and its documentation (87 lines in
`on-demand.ts`), the two things the build found (the request-entry context and
the later-millisecond start, about 60), the capture's refusal reasons (about
45), and comments throughout. The client bundle is unchanged: `pnpm
check:bundle-guards` reports the router chunk of `tests/cloudflare-basic` at
47,488 B gzip (ratchet 48,128 B), and the same chunk built from #640's source
is 1 B larger (47,537 B against 47,536 B with `gzip -c`).

### Risks: what an existing app could notice

- **Every request reads one more field** at six cache read points
  (`ctx?._prerenderWarm`), and captures its entry async context once
  (`AsyncLocalStorage.snapshot()`, about 0.8 µs on Node 24). No behavior
  change without a mark.
- **An on-demand refresh now also sends one warm request** when the app store
  is shared and an origin resolves. #640 is unreleased, so no app depends on
  the previous cost; the request is what rebuilds the document cache on the
  new entry.
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
