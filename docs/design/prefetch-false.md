# `prefetch: false`: keeping expensive work out of prefetches

Status: built. Written on 2026-10-07 against main `844ccda5`, from the behaviour
contract agreed with the maintainer the same day. The rules below (R1 to R13)
are that contract; the mechanics are what the code does.

Read [caching.md](./caching.md) first if you have not, and
`packages/rangojs-router/docs/internal/execution-model.md` for the revalidation
contract this feature leans on.

## Why

A Rango prefetch is a navigation sent early. `src/browser/prefetch/fetch.ts`
sends the same partial request a click would send, plus an `X-Rango-Prefetch`
header, and the server renders everything for it: handlers, loaders, the lot.
The production default strategy is `"viewport"`, so a product grid with forty
links is forty renders of pages the visitor will mostly never open. Until now
the only server read of that header set `cache-control`; nothing could say
"this part of the page is too expensive to render on speculation".

Two options do that now:

```tsx
// One loader stays out of prefetches.
loader(ReviewsLoader, { prefetch: false });

// Everything behind this fallback stays out of prefetches.
loading(<OrdersSkeleton />, { prefetch: false });
```

`prefetch: true`, or leaving it out, is the behaviour you had before. Both
options sit beside the existing `{ ssr?: boolean }` on the same two helpers.

## The model in one paragraph

A prefetch of a flagged route skips the flagged work and says so in the
payload: each skipped piece is a segment marked `deferred`. When a click adopts
that payload the browser commits it at once, shows the `loading()` fallback
(or holds the transition) where the deferred pieces are, and sends one second
request for the same URL, the **fill**, which runs only what the client does
not hold yet. The fill's response merges into the committed tree like any
partial update. Nothing else changes: a hard load, a navigation with no
prefetch to adopt, an action, a back/forward and a no-JS form post never see a
deferred segment.

Three words carry the rest of this document:

- **Prefetch request**: a partial request (`_rsc_partial`) with the
  `X-Rango-Prefetch` header.
- **Deferred unit**: work a prefetch skipped, marked `deferred: true` on its
  segment. A deferred loader is one loader segment. A deferred handler unit is
  an entry's handler plus everything its fallback covers.
- **Fill request**: the partial request the browser sends for the same URL
  when it adopts a payload that carries deferred units. It carries
  `_rsc_fill=1`.

## Path table

| Request kind                                                         | Flagged loader                              | Flagged `loading()` entry                   |
| -------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Document request (hard load)                                         | runs, as before                             | runs, as before                             |
| Navigation with no prefetch to adopt                                 | runs, as before (one request)               | runs, as before (one request)               |
| Prefetch request                                                     | not executed, marked deferred (R1)          | see R2                                      |
| Click that adopts a payload with deferred units                      | fallback shows; fill request sent (R4)      | fallback shows; fill request sent (R4)      |
| Fill request                                                         | executes; only missing ids are emitted (R5) | executes; only missing ids are emitted (R5) |
| Action revalidation, popstate, no-JS (PE)                            | unchanged                                   | unchanged                                   |
| Shell capture, warm request, on-demand prerender, `_rsc_loader` lane | unchanged (none is a prefetch)              | unchanged                                   |

## The rules

These are the invariants. If you change this feature, these are what must
still hold.

**R1. A flagged loader in a prefetch is not executed.** Its own `cache()` is
not read either, even when it would hit. Its segment is in the payload, marked
deferred, with no data.

**R2. A flagged `loading()` entry in a prefetch.** Two cases, and which one
applies depends on whether the entry's handler output is stored.

- _Not stored_ (no enabled `cache()` boundary covers it, the route is not
  `ppr`, it is not a `Prerender`/`Static` handler): the handler does not run.
  Neither do the entry's loaders, its orphan layouts or its parallel slots,
  and for a layout no deeper entry of the chain runs. The fallback is sent and
  the entry's segment is marked deferred.
- _Stored or about to be stored_ (enabled `cache()` scope, `ppr` route,
  `Prerender`/`Static`): segments are looked up, served, rendered and written
  exactly as before, hit or miss. Only the loaders behind the fallback are
  deferred, as in R1.
- A parallel slot with its own flagged `loading()` is its own unit.

**R3. `ssr: false` with `prefetch: false` on a loader.** Outside `ppr` both
apply: the document awaits the loader, a prefetch skips it. On a `ppr` route
an `ssr: false` loader is the bake lane (shell material, served from the
record), so the flag is ignored there and development logs a warning.

**R4. Adoption.** Any payload the client adopts that carries deferred units is
committed at once, whatever its source. The deferred units show their
fallback. Exactly one fill request is sent per adoption, started before the
tree is rendered.

**R5. Fill.** A partial request to the same URL. `_rsc_segments` lists what
the client holds, so the deferred ids are absent. It carries `_rsc_fill=1` and
no `X-Rango-Prefetch`, so nothing is deferred in it. Ids absent from the list
render. Held segments are skipped outright: no `revalidate()` predicate runs,
no handler runs, nothing is emitted for them.

**R6. Merge.** The fill's response merges into the committed tree without
remounting it. Errors, `notFound()`, `redirect()` and handle pushes from
deferred work behave as they do for work that streams behind `loading()`, only
later.

**R7. Deferral belongs to one response, never to stored data.** A deferred
marker is never written to a segment cache entry, a `ppr` shell record, the
prerender store or a loader cache entry. A stored body that carries deferred
units answers prefetch requests only: never a navigation, never a fill. Fill
responses are stored neither in the document cache nor in the browser HTTP
cache, and a fill is never answered from one. A stored body that is complete
may answer a prefetch; "The document cache" below says why.

**R8. Safe degrade.** Where the flag cannot be honoured the work runs in the
prefetch, as before. Never missing data, never a hole with no fill.

**R9. No change without the flag.** A prefetch response for a route with no
flag is byte-identical to what it was. Pinned by
`src/testing/__tests__/prefetch-false-unflagged.rsc-test.tsx`.

**R10. Context limitation.** Deferred work runs in the fill request.
Middleware runs there as on any render pass. Handlers outside the deferred
unit do not, so values they would have set with `ctx.set()` are not visible to
deferred work. This is the rule a revalidation that skips the producer already
has (execution-model.md, "Revalidation Contract", semantic matrix row `[R1]`).

**R11. No boundary.** A flagged loader whose read site has no boundary makes
React hold the transition until the fill returns. No definition-time error.

**R12. A deferrable loader cannot call `ctx.rendered()`.** It throws on every
request kind, document included, so you see it on the first load in
development where automatic prefetch is off.

**R13. A prefetch that skipped a handler cannot satisfy the barrier for
anyone.** A loader that is not deferrable and awaits `ctx.rendered()` in such
a prefetch gets an error naming the skipped segment, and development warns
about the combination on any other request.

## Which loaders are deferrable

You will want this list when a loader runs in a prefetch and you expected it
not to. `resolveDeferralScope()` in
`src/router/segment-resolution/prefetch-deferral.ts` walks the matched chain
once per route and memoizes the answer. A loader registration is deferrable
when any of these holds:

1. It was registered with `loader(Def, { prefetch: false })`.
2. Its entry has a flagged `loading()` (a layout, a route, or a parallel
   entry).
3. Its entry is an orphan layout or a parallel slot of an entry with a flagged
   `loading()`.
4. A layout above it in the chain has a flagged `loading()`. A layout's
   fallback covers its whole outlet, so the flag reaches every deeper entry.

And never when:

- The route is `ppr` and the loader is `ssr: false` (R3).
- The route segment belongs to a `clientUrls()` group. Those routes present
  their destination optimistically in the browser and render `loading()`
  themselves, so the flag is inert for the whole route (R8). `clientUrls()`
  `loader()` rejects the option at definition time; its `loading()` takes
  none.
- The loader is declared inside `intercept()`. Intercept loaders do not go
  through the shared funnel (`intercept-resolution.ts` calls
  `resolveLoaderData` itself), and a prefetch that resolves an intercept is
  not deferred at all (R8).

"Deferrable" is a static property of the registration. Whether a deferrable
loader is actually deferred is decided per request: **deferral replaces
execution**. The server evaluates revalidation exactly as before, and a
deferrable loader that would have run is marked deferred instead. One the
client holds and that would not re-run is kept, as before, and nothing is sent
for it.

The same rule decides handler units. A flagged entry whose handler would run
in this prefetch becomes the unit. A flagged layout the client already holds
and that does not re-render is not a unit for that prefetch: its fallback
would not show on that navigation, so there is nothing for it to cover. If
navigation inside such a section must stay out of prefetches too, flag the
route's own `loading()`.

## The server

### The plan

`createMatchContextForFull` and `createMatchContextForPartial`
(`src/router/match-api.ts`) put a `PrefetchDeferral` on the match's handler
context as `_prefetchDeferral` whenever the matched tree declares a flag or
the request is a fill:

- `scope`: the memoized static answer above (deferrable `LoaderEntry` set,
  their `$$id`s, unit candidates).
- `mode`: `"prefetch"` for a GET partial request with `X-Rango-Prefetch` that
  is not an action, not a shell capture and resolves no intercept; `"fill"`
  when the raw URL carries `_rsc_fill`; otherwise unset. The decision is one
  function, `partialDeferralMode()`, with a truth table beside it: an action
  is always a POST and a capture always runs the full match, so no real
  request can show those conditions apart.
- `storedFrom`: the first chain index whose handler output is stored. `0` for
  a `ppr` leaf and for `Prerender` routes, the `cache()` boundary's index when
  the route's scope is enabled, `Infinity` otherwise. A `Prerender` route
  counts from its definition (`isPrerender` on the leaf), not from whether
  this request found an artifact: the dev server has none, and a prefetch
  there should skip what a production prefetch skips.
- `deferredUnit`: the id of the handler unit this prefetch skipped, set during
  resolution.

Why the handler context and not the request context? A shell capture derives
its request context from the request that scheduled it, so a field there would
leak a prefetch's mode into a capture. The background re-renders
(`rerenderAndCacheRoute`, a stale route-cache refresh) build their own handler
context and so start with no plan, which is what they need: none of them is a
prefetch.

### Where the decisions are made

All of it is in `src/router/segment-resolution/revalidation.ts`, the partial
path. The document path (`fresh.ts`) never defers.

- `resolveLoadersWithRevalidation` is the one place a navigation kicks a DSL
  loader off. A deferrable loader whose revalidation said "run" is emitted as
  `{ type: "loader", deferred: true }` with no `loaderData`, and
  `resolveLoaderData` is never called, so its `cache()` is not read (R1).
- `resolveEntryHandlerWithRevalidation` skips a unit's handler and emits the
  segment with `component: null`, the fallback and `deferred: true`.
  `resolveSegmentWithRevalidation` then skips the unit's orphan layouts and
  slot handlers, and `resolveAllSegmentsWithRevalidation` stops walking the
  chain. Skipped entries are absent from `segments` and from `matched`.
- `resolveParallelSegmentsWithRevalidation` does the same for a slot unit.
- A unit's own loaders, and its slots' loaders, are still emitted as deferred
  loader segments. That is for the browser: the segment tree it builds for the
  placeholder then has the same shape it will have after the fill (see "No
  remount" below).
- `buildMatchResult` (`src/router/match-result.ts`) keeps a deferred segment
  even when the client holds its id. Without that, a unit that re-runs on a
  same-route navigation would be dropped as "the client has it".

In a fill, every one of those decision points answers
`!clientSegmentIds.has(id)` and nothing else. The two store paths in
`src/router/match-middleware/cache-lookup.ts` (the `cache()` HIT loop and
`yieldFromStore`) keep a held segment without consulting predicates or the
params comparison.

A fill also leaves a stale `cache()` record alone. A stale hit normally
schedules a background re-render of the whole route
(`withBackgroundRevalidation`), and so did a fill at first: the layout and
the route handler ran again behind a request whose rule is that no handler of
a held segment runs. The fill now skips the refresh, as it skips the
proactive write in `withCacheStore`. Nothing is lost: the record is refreshed
by the next request that reads it, and the prefetch that came before the
fill was already one.

### Handlers that read a flagged loader

A handler that calls `await ctx.use(ReviewsLoader)` needs the value to render,
so the loader runs in the prefetch whatever its flag says. Marking its segment
deferred anyway would make the fill run it a second time. So after resolution,
`resolveAllSegmentsWithRevalidation` looks at each deferred loader segment and
asks the handler context whether that loader was started in this request
(`_loaderStarted`, installed by `setupLoaderAccess`). If it was, the segment
is delivered from the memoized run, as before the feature existed (R8).

This only catches handlers resolution awaits. A handler under `loading()` is
streamed, so it may reach `ctx.use()` after the check; that loader then runs in
the prefetch and again in the fill. Data is never missing, only fetched twice.

### `cache()`, `ppr` and `Prerender`

Stored routes need no special path. A `cache()` HIT, a `ppr` partial replay
and a prerender store hit all resolve their loaders through
`resolveLoadersOnlyWithRevalidation`, which is
`resolveLoadersWithRevalidation` in a loop, so the same check defers them. A
`ppr` prefetch that defers live loaders still schedules its navigation capture
as before; the capture is a document render on a derived context and never
sees the plan.

One case does need care. A flagged layout above a `cache()` boundary is not
stored, so it can be a unit, and a unit skips everything below it, the cached
part included. When that can happen (`chainUnitPossible()`), `withCacheLookup`
does not read the route cache and `withCacheStore` does not write it for that
prefetch. Reading would restore the record's handle pushes for segments the
response does not carry, and a write could only ever store an incomplete
record.

### Wire format

The marker is one field on the segment, `ResolvedSegment.deferred?: true`
(`src/types/segments.ts`):

| Deferred unit | `type`                              | `component` | `loading`    | `loaderData` |
| ------------- | ----------------------------------- | ----------- | ------------ | ------------ |
| Loader        | `"loader"`                          | `null`      | (none)       | absent       |
| Handler unit  | `"layout"`, `"route"`, `"parallel"` | `null`      | the fallback | (none)       |

There is no list in `metadata` beside it. The segments are part of the
payload's root model, so the marker is readable the moment the payload root
resolves, which is before the browser builds anything, also when it adopts a
prefetch that is still streaming.

The fill marker is a query param, `_rsc_fill=1`. A param rather than a header
because the document cache middleware (`src/cache/document-cache.ts`) decides
from the raw URL before the request is classified, and `stripInternalParams`
already removes every `_rsc*` param from the URL handlers see.

### Keeping the modes apart (R7)

- **Document cache**: two slots, and a request with `_rsc_fill` skips the
  cache the way `_rsc_action` and `_rsc_loader` do. See "The document cache"
  below.
- **`Vary`**: a partial response for a route whose tree declares a flag lists
  `X-Rango-Prefetch` (`renderPreparedRscResponse` in
  `src/rsc/rsc-rendering.ts`, from `RequestContext._prefetchFlagged`). A route
  with no flag keeps the exact `vary` string it had (R9).
- **Fill responses** are `cache-control: no-store`, and the browser sends the
  fill with `cache: "no-store"`.
- **Client prefetch cache**: a fill never reads or writes it
  (`src/browser/navigation-client.ts`), and its URL carries `_rsc_fill`, so
  its key could not match a prefetch entry anyway.

### The document cache

The middleware (`createDocumentCacheMiddleware`, `src/cache/document-cache.ts`)
answers a request before the router has matched it. It cannot know whether
the route declares a flag, so it cannot decide up front which body a prefetch
should get. It decides from what it finds and from what the render says:

| Slot                        | Holds                                                                 | Read by                               |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| plain (the key main has)    | complete bodies: a navigation, or the prefetch of a tree with no flag | navigations, and prefetches first     |
| `:prefetch` (suffix in key) | the prefetch body of a flagged tree, which may carry deferred units   | prefetches that found no plain answer |

- A **navigation** reads the plain slot and nothing else. Nothing with a
  deferred unit is ever written there, so it can never be answered with one.
- A **prefetch** reads the plain slot first. A fresh entry there is served.
  Otherwise it reads the `:prefetch` slot: one extra read, paid only by a
  prefetch that found no plain answer.
- A **write** picks its slot after the render. A prefetch's body goes to
  `:prefetch` when the tree declares a flag (`RequestContext._prefetchFlagged`,
  or the response's own `Vary`, whichever says so) and to the plain slot
  otherwise.

So a route with no flag behaves as it did before the feature: a prefetch and
a navigation with the same held segments share one entry, in either order.
An earlier version of this code gave every prefetch its own slot, and the
handler of an unflagged cached route ran twice where it used to run once.

Can a complete navigation body answer a prefetch of a flagged tree? Yes, and
on purpose. You might expect strict separation, a prefetch of a flagged tree
always getting the deferred body. Three reasons it is not:

1. The stored body is complete. The click that adopts it has nothing to wait
   for and sends no fill.
2. Serving it runs nothing. Keeping expensive work out of prefetches is the
   whole point of the flag, and a cache hit is no work at all.
3. Strict separation would make the flagged work run on every prefetched
   click (a fill is never cached) while a plain click was a cache hit. The
   flag would cost server time on exactly the routes that opted into caching.

One exception: a **stale** plain entry of a flagged tree does not answer a
prefetch. Serving stale means re-rendering in the background, and that
re-render is a prefetch of a flagged tree, so its body goes to the other
slot. The stale entry would be served, and re-rendered, by every prefetch
until a navigation replaced it. The prefetch falls through to its own slot
instead. The middleware tells a flagged tree's stale entry by the `Vary` the
stored response carries; if an app middleware rewrote it, the cost is only
that loop, never a wrong body.

Pinned by `src/cache/__tests__/document-cache.test.ts` ("prefetch and
navigation slots") and, through a real router, by
`src/testing/__tests__/prefetch-false.rsc-test.tsx` ("the document cache").

## The browser

### Adoption

`fetchPartialUpdate` (`src/browser/partial-update.ts`) is where every partial
payload is reconciled and committed. When the payload it is about to commit
carries deferred segments, three things happen before the tree is built:

1. `armGates()` gives each deferred segment a **gate**: a promise the browser
   created. A deferred loader's gate becomes its `loaderData`; a deferred
   unit's gate becomes its `component`. To the rest of the client a gate is a
   loader stream that has not arrived yet, which is something it already
   knows how to show. This happens before the reconcile, on the payload's own
   segment objects. That is safe because every adoption decodes its own
   payload (see "Reuse" below).
2. The reconcile runs without the page's copies of the deferred ids. This one
   is scar tissue. The reconciler keeps the cached component when the server
   sends `component: null` for a layout the client holds, and the navigation
   actor keeps the cached `loading`. On a same-route navigation that turned a
   deferred unit back into the old page's content, with no fallback and no
   gate. A deferred id has no usable copy, so it is given none.
3. `runFill()` starts the fill request (`client.fetchPartial({ fill: true })`)
   with its own `AbortController`, and the commit proceeds on the lane it
   would have taken anyway. A fully prefetched payload still commits in a
   transition with `forceAwait`; `renderSegments`
   (`src/segment-system.tsx`) skips the awaits that would wait on a gate.

The store never reports a placeholder as held. `tx.commit` receives the
matched ids minus the deferred ones, so `_rsc_segments` of every later request
from this page (the fill, an action, a prefetch of another link) leaves them
out and the server renders them. `getCurrentCachedSegments()` filters
placeholders out of the reconcile cache for the same reason: a placeholder is
never a copy of the segment.

### The fill and the merge

The fill request and the adoption's render run side by side, and the request
can win: the adoption may still be awaiting its own tree when the response
arrives. So `runFill()` first waits for `whenCommitted`, which settles when
`tx.commit()` has put the placeholders on screen, or with `false` when the
adoption is abandoned.

Then it checks that the entry on screen still holds this adoption's
placeholders. By object identity, not by history key: a shallow navigation
that copied the entry to a new key is still filled, and an action refetch
that already rendered the missing segments (its request listed them as not
held) is not overwritten. It reconciles the response against the entry with
the `"stale-revalidation"` actor, renders, and commits in a transition. Last,
it resolves each gate with the value the committed tree reads, which releases
anything still suspended on one.

The entry is rewritten **in place**: the fill splices the filled segments
into the array the history cache already holds for the entry, and calls
`store.setSegmentIds()`. It does not go through `cacheSegmentsForHistory`.
The fill belongs to the visit that adopted, and re-caching would do two wrong
things: advance the store's navigation instance, which disowns the adoption's
still-open handle stream, and reset the entry's stale flag.

For the same reason the fill updates the adoption payload's `matched` array
in place. `processHandles` in `NavigationProvider` reads `matched` on every
yield of that payload's handle stream and deletes the handle buckets of
segments outside it. A deferred unit's `matched` stops at the unit, so a late
yield from the adoption would delete what the fill had pushed below it
(breadcrumbs from a deferred route, say).

The fill's update carries no scroll action, and it must not clear one
either (`NavigationUpdate.keepScroll`). This is scar tissue. React holds the
adoption's commit when nothing can show a fallback: a read with no boundary,
or a second click on the page's own link, whose boundaries are already
revealed. The scroll the adoption queued is then still waiting when the fill
lands, and `NavigationProvider` replaces the pending action on every update.
A fill that said "do not scroll" left the visitor at the old scroll position
on a new page.

A fill has no navigation transaction, so two things a transaction normally
carries need another way to their owner. `PartialUpdateConfig.fill` is that
way, supplied by the navigation bridge: `redirect(url, state)` performs a
replace navigation, and `locationState(state)` merges location state the
deferred work set into the current history entry. Without the hooks a
redirect is a document navigation and the state is dropped.

### No remount (R6)

The fill replaces props, not elements. For that the placeholder's tree has to
have the shape the filled tree will have, and that is why a unit's own loaders
travel as deferred loader segments: `renderSegments` wraps a segment's content
in `StreamedLoaderErrorBoundary` only when the segment has loaders, and takes
the per-loader streams lane only then. With the loader ids present from the
start, the `LoaderBoundary`, the `RouteContentWrapper` and their keys are the
same before and after.

### History

The adopted entry is stored with its placeholders, flagged `deferred`. The
fill rewrites it in place with the filled segments (above), and back/forward
to it is then an ordinary cache restore.

If the user leaves first, the fill is cancelled and the entry keeps its
placeholders. Both readers of the history cache treat such an entry as a miss:
`handlePopstate` falls through to the fetch path, and `navigate()` does not
offer it as `targetCacheSegments` (`hasUsableCache` in
`src/browser/navigation-bridge.ts`). So returning to the entry fetches what
is missing; it never restores a tree suspended on a gate nobody will resolve.

An abandoned gate is never settled. Resolving it with nothing or rejecting it
would both show up in a tree that may still be mounted for a moment. It is
only untracked: `loaderStore.releasePendingStream()` removes it from the
pending streams, so `useLoader().isLoading` and the streaming indicators do
not wait on it forever.

### Abort

The fill is not a navigation in the event controller: starting it must not
cancel anything, and a navigation that starts and then fails must not leave
the page with fallbacks nobody fills. Instead `browser/pending-fill.ts` holds
the one in-flight fill, and it is cancelled when the tree it belongs to is
replaced: a navigation transaction that commits
(`createNavigationTransaction().commit`), a back/forward (`handlePopstate`),
or a newer adoption. An adoption that never commits (aborted or failed before
`tx.commit()`) cancels its own fill. Cancelling aborts the request only while
it is waiting for the response; aborting a Flight stream mid-read makes the
decoder throw asynchronously, so a response that has arrived is simply
dropped.

Two commits deliberately do not cancel: a cache-only commit, which touches no
tree, and an action's store-only commit, which updates the page the fill is
for. After an action the identity check decides. If the action's refetch
replaced the entry's segments the fill finds none of its placeholders and
drops its response; if the entry is untouched the fill lands.

While a fill is in flight the adoption's streaming token stays open, so
`useNavigation().isStreaming` is true until the deferred work has streamed in,
and idle-time prefetching waits for it.

### Failure

- A response the client cannot use (undecodable, not partial, missing
  segments): every gate rejects with the error, which React delivers to the
  nearest error boundary, the same place a rejected streamed loader lands.
- A network failure goes to `emitNetworkError`, like a failed navigation.
- A redirect for the whole response (middleware, say, because the session
  expired between prefetch and click) is followed, as a replace navigation
  through `PartialUpdateConfig.fill.redirect`. An external redirect, or a
  client built without the hook, is a document navigation.
- A redirect the client refuses to follow (another origin, or an external one
  whose scheme is not http) rejects the gates like any other unusable
  response. Returning quietly would leave the fallback up for good.

### Reuse within `prefetchCacheTTL`

A prefetch entry respawns on every adoption (`makeRespawn` in
`prefetch/fetch.ts`), so each adoption decodes its own payload, arms its own
gates and sends its own fill.

## `ctx.rendered()`: R12 and R13

`ctx.rendered()` resolves when the non-loader segments of the request have
settled, so a loader can read handle data
(`packages/rangojs-router/docs/internal/rendered-barrier.md`).

**R12.** In a fill the deferrable loader's own entry is held and its handler
does not run. There is no render to wait for and the handle data is not there.
So `rendered()` throws for a deferrable loader, on every request kind, from
the plan's `scope.loaderIds`. The message names the loader and both fixes:
remove `{ prefetch: false }` from the loader or from the `loading()` above it,
or stop calling `ctx.rendered()`. Pushing a handle from a deferrable loader is
still fine; the push streams with the fill.

**R13.** When a prefetch skips a handler unit, that handler's pushes do not
exist in the request. A loader outside the unit that awaits `ctx.rendered()`
would read a handle list with a hole in it, and the fill never re-runs that
loader. The contract asks for one of two things: an error, or a safe degrade
such as deferring that loader too. The degrade is tempting and it is not
safe, for two reasons:

- The decision is only known when the loader calls `rendered()`, which is
  after its segment was emitted as a running loader.
- Even if it could be deferred, the fill would run it with every handler the
  prefetch did render held and skipped. It would read the unit's pushes and
  miss everyone else's: the same silent hole, moved to the other side.

So it is the error. In such a prefetch `rendered()` rejects once the barrier
resolves, naming the skipped segment. In development, a non-prefetch request
warns once when a loader calls `rendered()` in a tree that has a unit
candidate, so the combination is seen before production. A prefetch that
defers only loaders does not trigger it: the barrier never covered loader
segments. A fill refuses `rendered()` outright for the same reason R12 exists.

## Limits

- A flagged layout the client already holds and that does not re-render is
  not a unit (see "Which loaders are deferrable"). Its deferrable loaders are
  still deferred when they would run.
- An orphan layout's flagged `loading()` defers its loaders but not its
  handler. A route's handler runs before its orphan layouts, so there is
  nothing left to skip by the time the orphan is reached.
- A flagged loader that something else reads with `ctx.use()` runs in the
  prefetch with its reader. Whether it then runs a second time depends on
  when the read happens. Resolution checks once, when it has awaited every
  handler it awaits, which loaders were started (`deliverStartedLoaders` in
  `revalidation.ts`). A loader started by then is delivered from that run
  and is not deferred: one run, no fill for it. A read after the check is not
  seen: the loader runs for its reader, its own segment has already been
  emitted as deferred, and the fill runs it again. Two readers can be late:
  1. a handler under `loading()`. It is streamed, so resolution calls it and
     does not wait for it. A `ctx.use(Flagged)` after its first `await` is
     late unless resolution happens to be waiting on something else.
  2. a loader that is not deferred itself and calls `ctx.use(Flagged)` after
     an `await`. Loaders are started, never awaited, by resolution, so the
     same holds.

  In both, a read before the reader's first `await` happens while resolution
  is still calling things and is always in time. A handler with no
  `loading()` is awaited, so any read inside it is in time. Data is never missing in the
  late cases, only fetched twice, and the page shows the fill's value. To get
  one run, start the read before the first `await`, or drop the flag from a
  loader the page cannot render without.

- `clientUrls()` routes and `intercept()` ignore the flag.
- A fill does not refresh a stale `cache()` record (see "Where the decisions
  are made"). The record waits for the next request that reads it.
- Values a held handler would have set with `ctx.set()` are not visible to
  deferred work (R10).
- A page restored from the back/forward cache with a fill in flight shows the
  network error boundary if the browser dropped the request.
