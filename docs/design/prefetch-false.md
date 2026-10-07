# `prefetch: false`: keeping expensive work out of prefetches

Status: built. Written on 2026-10-07 against main `844ccda5`, from the behaviour
contract agreed with the maintainer the same day. The rules below (R1 to R14)
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

The flag applies only to a segment the client does not have yet. This router
keeps what is on screen wherever it can, and the flag must never cost you
that, so a segment the browser already holds is never deferred. The promise
the feature makes, and the one to check any change against: **a click that
adopts a prefetch with deferred units is never worse than the same click with
no prefetch at all. It never covers more of the page with a fallback than
that plain navigation does, and never for longer; it waits only where the
plain navigation would wait; and content that is already on screen is never
replaced by a fallback, blanked or remounted while a fill is pending.**

What a deferred loader does to the click follows from one sentence: **a
deferred loader never blocks the navigation, and behaves like a loader that
is still streaming.** React then decides what shows, as it does for any
value that has not arrived:

| Where the page reads the loader             | What the adopted click shows                               |
| ------------------------------------------- | ---------------------------------------------------------- |
| Inside its own `<Suspense>`                 | The page at once, with that fallback in it, then the value |
| Nearest boundary is the route's `loading()` | That fallback, as on a plain click                         |
| No boundary at all                          | The page being left, until the fill returns (R11)          |

The first row can be a finer fallback than the plain click shows. With no
prefetch the whole route is still streaming, so its `loading()` covers it;
with the prefetch adopted everything but the deferred value is already
there. That is less fallback for no longer, which the promise allows. The
shared suite pins it (`expectDeferredLoaderShowsItsOwnFallbackAtOnce`).

Three words carry the rest of this document:

- **Prefetch request**: a partial request (`_rsc_partial`) with the
  `X-Rango-Prefetch` header.
- **Deferred unit**: work a prefetch skipped, marked `deferred: true` on its
  segment. A deferred loader is one loader segment. A deferred handler unit is
  an entry's handler plus everything its fallback covers. Either is always a
  segment that is new to the client (R14).
- **Fill request**: the partial request the browser sends for the same URL
  when it adopts a payload that carries deferred units. It carries
  `_rsc_fill=1`.

## Path table

| Request kind                                                         | Flagged loader                              | Flagged `loading()` entry                    |
| -------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| Document request (hard load)                                         | runs, as before                             | runs, as before                              |
| Navigation with no prefetch to adopt                                 | runs, as before (one request)               | runs, as before (one request)                |
| Prefetch request, segment new to the client                          | not executed, marked deferred (R1)          | see R2                                       |
| Prefetch request, segment the client holds                           | runs when it revalidates, as before (R14)   | renders when it revalidates, as before (R14) |
| Click that adopts a payload with deferred units                      | fallback shows; fill request sent (R4)      | fallback shows; fill request sent (R4)       |
| Fill request                                                         | executes; only missing ids are emitted (R5) | executes; only missing ids are emitted (R5)  |
| Action revalidation, popstate, no-JS (PE)                            | unchanged                                   | unchanged                                    |
| Shell capture, warm request, on-demand prerender, `_rsc_loader` lane | unchanged (none is a prefetch)              | unchanged                                    |

## The rules

These are the invariants. If you change this feature, these are what must
still hold.

**R1. A flagged loader on a segment that is new to the client is not executed
in a prefetch.** Its own `cache()` is not read either, even when it would hit,
and no `"use cache"` function it calls is consulted. That is by intent: a
prefetch that looked would have to run the loader on a miss, which is the
work the flag keeps out. Its segment is in the payload, marked deferred, with
no data. The fill is where the loader runs, so the fill reads through both:
a warm `cache()` entry is served and the loader body does not run, a cold one
runs and stores, and a `"use cache"` function inside deferred work (a flagged
loader, or a handler behind a flagged `loading()`) hits or stores as on any
request. Pinned by `prefetch-false.rsc-test.tsx` ("a fill serves the loader's
cache() when it is warm", "a fill runs the loader and stores its cache() when
it is cold", and the `"use cache" in deferred work` describe).

**R2. A flagged `loading()` entry that is new to the client, in a prefetch.**
Two cases, and which one applies depends on whether the entry's handler output
is stored.

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

**R14. The flag applies only to a segment the client does not have yet.**
"New to the client" means the segment's id is absent from the prefetch
request's `_rsc_segments`. This is what defines the unit:

- A segment the client holds is never deferred, whether or not its
  `revalidate()` returns true. A held layout or route with a flagged
  `loading()` is rendered by a prefetch exactly as it is without the flag, and
  a flagged loader on a held segment runs in the prefetch when it revalidates.
- Nothing is deferred _because of_ a held segment. A route under a flagged
  layout the client holds follows its own flags: with none, the prefetch runs
  its handler and its loaders, and the click sends no fill.
- A segment that is new is deferred by its own flag wherever it sits: a route
  with its own flagged `loading()` under a held layout is its own unit.
- So a same-route navigation (same route, other params: the client holds the
  route and its loader segments) behaves as it does without the flag. The
  prefetch runs everything and the click sends no fill. That is for a prefetch
  taken on that page; "Limits" covers one taken elsewhere.

Why so strict? A placeholder over a segment that is on screen would put a
fallback where the visitor is looking at content, or hold the click on a fill
where a plain navigation would have streamed. Either breaks the promise in
"The model in one paragraph". If navigation inside a section has to stay out
of prefetches, flag the `loading()` of the routes inside it: they are new on
each of those navigations.

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
   fallback covers its whole outlet, so the flag reaches every deeper entry
   while that layout is new to the client.

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
loader is actually deferred is decided per request, by R14: `defersLoader()`
answers yes only when the loader's own segment is new to the client and,
for a loader that is deferrable through an entry's `loading()` (2 to 4)
rather than its own flag, at least one of those entries is new too. The scope
keeps, for each such loader, the segment ids of the flagged entries whose
fallback covers it, so that question is a set lookup. A loader the client
holds is left to revalidation, exactly as before the feature existed.

The same rule decides handler units. `defersUnit()` makes a flagged entry the
unit when its segment is new to the client and its handler output is not
stored. A flagged layout the client already holds is not a unit, also when its
`revalidate()` says to render it again.

Scar tissue, twice. The first version asked "would this run?" instead of "is
this new?", so a held layout that revalidated was deferred as a unit: on a
same-route navigation the prefetch skipped the page, and the click put a
fallback over content the visitor was reading. And "behind a flagged layout"
was a property of the tree, so with the layout held and not re-rendering, a
prefetch from inside the section ran the child route's handler and deferred
its loaders, behind no fallback of their own. Both are pinned from each side
by `src/testing/__tests__/prefetch-false.rsc-test.tsx` ("the flag applies only
to a segment the client does not have yet") and in the browser by the section
cases and the same-route case of the shared suite.

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
  loader off. A loader `defersLoader()` says yes to (R14) is emitted as
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
- `buildMatchResult` (`src/router/match-result.ts`) needs no special case: a
  deferred segment is never one the client holds, so the ordinary "send what
  the client lacks" filter keeps it.

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
proactive re-render in `withCacheStore`. Nothing is lost: the record is refreshed
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
part included. When this request defers such a layout (`defersAboveRecord()`:
a flagged, unstored chain entry the client does not hold), `withCacheLookup`
does not read the route cache and `withCacheStore` does not write it. Reading
would restore the record's handle pushes for segments the response does not
carry, and a write could only ever store an incomplete record.

That is decided per request, from what the client holds, and that is scar
tissue. It used to be decided per tree (`chainUnitPossible()`): any prefetch
of a route under a flagged layout skipped the record, also when the client
held the layout and nothing above the record was deferred, and a fill never
wrote. With the layout held, three prefetches of a `cache()` route ran its
handler three times where the same route under an unflagged layout ran it
once. A fill now writes the record too, when its response holds every segment
the record covers (the client held none of them). It still does not start the
proactive re-render a partial response normally triggers: that would run the
handlers of segments the client holds, behind a request whose rule is that
they do not run.

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
the `"stale-revalidation"` actor, renders, and commits in a transition. A
deferred loader's gate is resolved right then, with the value the committed
tree reads, which releases anything still suspended on it. A unit's gate is
resolved a moment later; "Revealing a unit" below says when and why.

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

### Revealing a unit

A plain navigation to a route with `loading()` shows the fallback and then
reveals the content through a Suspense retry, and React keeps a fallback up
for 300 ms before it lets a retry replace it. That throttle is why a loader
that needs another 100 ms does not flash a second, inner fallback: by the time
the outer one may go, the inner data is there.

The fill has to reveal a unit the same way, and at first it did not. Its tree
carried the unit's content, so the fill's own transition revealed it, and a
transition is not throttled. Measured in production from the hub, on a layout
unit whose route has its own `loading()`: fallback at 4 ms, the layout with
the route's fallback inside it at 10 ms, the value at 311 ms. The same click
with no prefetch shows the fallback at 11 ms and everything at 314 ms. One
loading state more than the plain navigation, for the same finish.

So a unit's segment keeps reading its gate in the tree the fill commits, and
the gate is resolved once React has committed that tree
(`NavigationUpdate.onCommit`, called from a layout effect of
`NavigationProvider`). React then retries the boundary, throttled like any
other, and the sequence is the plain navigation's.

Two things keep that from hanging, and both are scar tissue of the first try:

- `onCommit` also fires when a _later_ update commits. React commits only the
  last of the updates it batches, and an urgent update can supersede a
  transition it is holding. An update that is skipped that way would otherwise
  leave its gate pending for good. An _earlier_ update that commits meanwhile
  does not fire it. `src/testing/__tests__/navigation-update-on-commit.test.tsx`
  pins the order through the real provider.
- Only a unit whose fallback can show waits for the commit (`Gate.fresh`: the
  page being left has no copy of the unit's segment). The browser's prefetch
  cache is not keyed by the source page, so a prefetch taken on the hub can be
  adopted on the unit's own page, where the unit's content is on screen. React
  never commits a tree that suspends where content is showing: it holds the
  old page, which is what you want, and it would hold the fill's tree too if
  that still read the gate. Such a unit gets its content in the fill's tree
  and its gate resolved at once, as before.

The fill's update says nothing about scroll. Scroll belongs to the
navigation transaction: `tx.commit()` decides it, the adoption's update
carries the decision, and `NavigationProvider` holds that one pending action
(`pendingScrollRef`) until the React commit that follows, where
`handleNavigationEnd` applies it. A fill is not a transaction, so it has no
decision to carry.

This is scar tissue, in two parts. The fill used to send
`scroll: { enabled: false }`, and the provider used to assign the pending
action on every update, `undefined` included. So a fill that reached the
provider before React had committed the adoption replaced the adoption's
pending scroll, and the visitor stayed at the old scroll position on a new
page. That happens more often than you would guess. The fill's update is not
emitted when its loaders finish. It is emitted when the first chunk of its
response arrives, a few milliseconds after the click, with the loader data
still pending inside it. The adoption's commit is a transition, which React
renders in a later task, so the two race: on a fresh page the fill won 7
clicks out of 8 (measured from the hub, 100 ms loaders, dev and production).
And on two kinds of page React cannot commit the adoption at all until the
fill lands: a read with no boundary, and a second click on the page's own
link, whose boundaries are already revealed.

The rule now, for every update and not only the fill: an update that carries
a transaction's decision sets the pending action, the commit that follows
consumes it once, and an update with no decision (a server action, an error
update, a fill) neither sets nor clears it.

The transaction draws the same line. `commit()` returns its decision in the
shape the update carries it (`CommitResult` in
`src/browser/navigation-transaction.ts`). A navigation always decides, and "do
not scroll" is a decision that replaces a pending one: `<Link scroll={false}>`,
an intercept, the explicit `scroll: false` commits of the bridge. A commit that
is not a navigation returns none: an action's store-only refetch into the entry
on screen, and a cache-only commit. Those two used to answer `scroll: false`,
which reached the provider as "do not scroll", so an action refetch that
landed before React had committed a navigation cost the navigation its scroll,
the fill's bug by another road.

You might worry that with nothing
clearing the slot an old scroll could be replayed by a later action. It
cannot: every update re-renders the provider, and the commit that follows
consumes whatever is pending. `src/testing/__tests__/navigation-scroll-slot.test.tsx`
pins all four sides through the real provider: an update with no decision
does not cost a pending navigation its scroll, a later one does not replay
it, the second of two navigations wins, and a traversal's restore survives.
The same file drives the action refetch through the real updater and a real
transaction, the call `refetchRoute()` makes in
`src/browser/server-action-bridge.ts`.
The browser suites force both orders (the fill before the adoption's commit,
the fallback before the fill) and never leave it to timing.

A fill has no navigation transaction, so two things a transaction normally
carries need another way to their owner. `PartialUpdateConfig.fill` is that
way, supplied by the navigation bridge: `redirect(url, state)` performs a
replace navigation, and `locationState(state)` merges location state the
deferred work set into the current history entry. Without the hooks a
redirect is a document navigation and the state is dropped.

### What the page reads while a fill is pending

Three things a page can observe, each checked against a plain navigation
whose loader is still streaming:

- **`useNavigation()`** reads `state: "idle"` and `isStreaming: true`. The
  adoption's transaction has committed, and its streaming token stays open
  until the fill has landed and streamed (`fetchPartialUpdate` ends it on
  `adoption.fill.done`). A plain navigation reads the same once it has
  committed. It reads `"loading"` before that, which an adopted click never
  shows: its commit is immediate.
- **View transitions.** The fill commits through `commitInTransition` with no
  transition type, and reuses the adoption's `transition({ when })` decision
  (`fill.gatedOff`). On a route with `transition()` and a flagged loader the
  browser gets two `document.startViewTransition` calls, the commit and the
  reveal, with or without the prefetch.
- **Handle data.** A push from a handler the prefetch ran travels in the
  prefetched payload's handle stream, so it is on screen with the click's
  commit: breadcrumbs and titles from the part that was not deferred do not
  wait for the fill. A deferred handler's push arrives with the fill.

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

A gate is resolved by its fill or never settled at all. Resolving an
abandoned one with nothing would show up in a tree that may still be mounted
for a moment, and a gate is never rejected (see "Failure"). It is only
untracked: `loaderStore.releasePendingStream()` removes it from the
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

A fill that fails ends the way a navigation that fails does. `runFill()`
hands the error to `emitNavigationError` (`browser/network-error-handler.ts`),
the emitter the navigation bridge uses: the error replaces the page, and the
router's error boundary takes over. That covers:

- a response the client cannot use: undecodable (a 500 with a text body, say),
  not partial, or missing segments;
- a network failure, which the same emitter shows as the network error page;
- a redirect the client refuses to follow: another origin, or an external one
  whose scheme is not http. Returning quietly here left the fallback up for
  good.

Two conditions hold the error back. It waits for the adoption's commit: a
fill can fail while the adoption is still rendering, and an error shown then
would be replaced a moment later by the adoption's own commit, whose fallback
would wait for a fill that already failed. And it is shown only on a page
that still holds this adoption's placeholders, the same identity check the
merge makes: after an action refetch rendered the missing segments, a late
failure of the fill is nobody's problem.

The gates are never rejected, and this is scar tissue. The first version
rejected them, so that React would throw at each reader into its nearest
error boundary. It worked on screen, and it also raised an uncaught
`Connection closed.` in the page: the tree builds aggregate promises over a
segment's loaders (`getMemoizedLoaderPromise` in
`src/segment-loader-promise.ts`), and nothing handles an aggregate when a
gate inside it rejects. A navigation answered with the same 500 raises
nothing, so the fill now takes the navigation's path. The cost is where the
error shows: at the page's error boundary, not at the one nearest the read.

A redirect for the whole response (middleware, say, because the session
expired between prefetch and click) is not a failure. It is followed as a
replace navigation through `PartialUpdateConfig.fill.redirect`; an external
redirect, or a client built without the hook, is a document navigation.

### What DevTools shows

A fill request shows up in the Network panel as `(canceled)`, and Playwright
reports it as `requestfailed` with `net::ERR_ABORTED`. Nothing was aborted
and nothing is lost. Chromium reports every response that carries
`Cache-Control: no-store` this way once its body has been read to the end
through a stream reader, which is how a Flight payload is read. The report
comes after the reader has seen the end of the stream, with every byte
delivered.

How that was established, so you do not have to repeat it: no code in the
page aborts or cancels (`AbortController.abort`, the fill's signal, and every
stream and reader `cancel` were instrumented and stayed silent); a bare
`fetch()` of the same URL from the page, read with `getReader()`, ends the
same way with no router code involved, and ends as finished when a proxy
removes the header or changes it to `no-cache`; and through a proxy that
re-emits the body in four pieces 250 ms apart and closes the stream 250 ms
after the last one, all four pieces reach the page, the value renders, and
the report comes at the close. The header stays: it is what keeps a fill out
of every HTTP cache between the server and the page (R7).

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

- A prefetch is answered for the page that sent it, and the browser's
  prefetch cache is not keyed by that page. A prefetch taken where a flagged
  segment was new can be adopted on a page that holds it: the hub's prefetch
  of a section route, clicked from inside the section, or `item/b` prefetched
  on the hub and clicked from `item/a`. The payload then defers something the
  page holds, and the click sends a fill where a prefetch taken on that page
  would have sent nothing. The promise still holds, and the parity cases pin
  it: React keeps the content on screen until the fill's tree can replace it,
  and the click shows no fallback a plain navigation would not show. The cost
  is one handler run: the fill renders the held layout the prefetch skipped.
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

### Trying it by hand

The `/prefetch-false` fixture (router test app `src/urls/prefetch-false.tsx`,
cloudflare-basic `src/pages/prefetch-false.tsx`) is readable in a browser.
Open `/prefetch-false?run=<anything>&manual=1`. The page lists one link per
case with a line on what it covers. The panel on the right shows what the
server ran, one row per counter with its run count, refreshed every 400 ms,
and a fixed badge shows `scrollY`. The links prefetch on hover only, so hover
a link, watch the counters, then click it and watch them again: flagged work
shows 0 runs after the hover and 1 after the click, an unflagged case shows 1
after the hover. `run` keys the counters: each value you pick has its own, and
"Start a new run" picks a fresh one. `&tall=1` adds spacers so the page
scrolls, for checking that a navigation ends at the top. `&slow=1` makes every
deferred loader take 600 ms longer, so you can watch a fallback. Without `manual=1`
the panel, the badge and the polling are not rendered, which is what the
suites see. Every link carries the flags that are set.
