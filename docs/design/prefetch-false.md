# `prefetch: false`: keeping expensive work out of prefetches

Status: built. Written on 2026-10-07 against main `844ccda5`, from the behaviour
contract agreed with the maintainer the same day. The rules below (R1 to R15)
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

A deferred `loading()` entry shows its fallback with the click. One case
does not: on a route with `transition()` the click commits when its fill
starts answering, which is when the plain click commits. The work is still
kept out of the prefetch. What the click gives up there is a head start that
cost more than it gave ("A unit under `transition()` waits for its fill").

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
| The same click, on a route with `transition()`                       | as above                                    | commits with the fill's first chunk (R4)     |
| Click on another page than the one that prefetched                   | that prefetch is not used (R15)             | that prefetch is not used (R15)              |
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

**R4. Adoption.** A payload that carries deferred units is committed at once
when the client adopts it, and it is adopted only on the page that prefetched
it (R15). The deferred units show their fallback. Exactly one fill request is
sent per adoption, started before the tree is rendered. One adoption is not
committed at once: a deferred `loading()` entry on a page that commits in a
transition is committed with the first chunk of its fill, as the plain click
is committed with the first chunk of its response.

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
prerender store or a loader cache entry. A response that carries deferred
units is never reused by the document cache or by a shared cache in front of
the app, and the browser's in-memory prefetch cache keeps it only under the
page that sent the prefetch (R15). The browser's HTTP cache is not ours to
rule: it may keep a copy, and reuses it only while it reloads a document for
back/forward, for the same prefetch from the same page ("Where a deferring
response may be kept" below). So no stored body answers a navigation with a
deferred unit, and if one ever did, the client completes any payload that
carries deferred work, wherever it came from. A fill is never answered from
a stored body. A stored body that is complete may answer a prefetch; "The
document cache" below says why.

**R8. Safe degrade.** Where the flag cannot be honoured the work runs in the
prefetch, as before. Never missing data, never a hole with no fill.

**R9. No change without the flag.** A prefetch response for a route with no
flag is byte-identical to what it was. Pinned by
`src/testing/__tests__/prefetch-false-unflagged.rsc-test.tsx`. Such a route
also does one document-cache read per request and answers with the `vary` and
`cache-control` it has on main (`prefetch-false.rsc-test.tsx`, "a route with
no flag answers a prefetch and a navigation as it does without the feature").

**R10. Context limitation.** Deferred work runs in the fill request.
Middleware runs there as on any render pass. Handlers outside the deferred
unit do not, so values they would have set with `ctx.set()` are not visible to
deferred work. This is the rule a revalidation that skips the producer already
has (execution-model.md, "Revalidation Contract", semantic matrix row `[R1]`).

**R11. No boundary.** A flagged loader whose read site has no boundary makes
React hold the transition until the fill returns. No definition-time error.
`useNavigation()` reads `loading` for that time, as it does on a plain
navigation that is still streaming, so a progress bar shows.

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
  prefetch runs everything and the click sends no fill. A prefetch taken on
  another page is not used for that click (R15).

**R15. A prefetch that deferred something is adopted only on the page it was
made on.** What a prefetch defers depends on what its source page holds
(R14), so a response that carries deferred units is for that page. It is sent
with `x-rsc-prefetch-scope: source`, the scope a route an intercept targets
already uses, and the browser's prefetch cache then keys it by the source page
and the segments that page held. A page that holds the segment makes its own
prefetch, which defers nothing for it, and a click there never sends a fill
for content it is showing.

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
  when the raw URL carries `_rsc_fill`; otherwise unset. The header and the
  param are read once, when the request context is created (`requestKind()`,
  kept as `RequestContext._requestKind`; the names are `PREFETCH_HEADER` and
  `FILL_PARAM`). The decision is one function, `partialDeferralMode()`, with a
  truth table beside it: an action is always a POST and a capture always runs
  the full match, so no real request can show those conditions apart.
- `held`: the client's segment ids as the request listed them in
  `_rsc_segments`. Deferral reads this set and no other. It is the set
  `buildMatchResult` filters the response with, and it is not the set
  resolution works on: the match drops a route's id from that one to force a
  same-route render from an intercept source. Deferring on the forced set
  skipped the handler of a route the response then left out as held, so the
  click got nothing for it.
- `skipped` and `skipsChain`: for a prefetch, the segment ids of the units
  this request skips, and whether one of them is a chain entry. `defersUnit()`
  and `defersAboveRecord()` are lookups on them. One computation, so the
  resolver and the cache middleware cannot disagree about what was skipped.
- `storedFrom`: the first chain index whose handler output is stored. `0` for
  a `ppr` leaf and for `Prerender` routes, the `cache()` boundary's index when
  the route's scope is enabled, `Infinity` otherwise. A `Prerender` route
  counts from its definition (`isPrerender` on the leaf), not from whether
  this request found an artifact: the dev server has none, and a prefetch
  there should skip what a production prefetch skips.
- `deferredUnit`: the id of the handler unit this prefetch skipped, set during
  resolution.

Why is the mode on the handler context when the request kind is on the
request context? The kind is a fact about the request. The mode is a decision
about one match. A shell capture derives its request context from the request
that scheduled it, so a mode there would leak a prefetch's into a capture. The background re-renders
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
  the client lacks" filter keeps it. Both sides read the ids the request
  listed (`PrefetchDeferral.held`).
- The partial render (`src/rsc/rsc-rendering.ts`) looks at what it is about
  to send. One deferred segment makes the response source-scoped (R15), marks
  `RequestContext._payloadDeferred` and sets its `cache-control` (R7).

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

One more field can ride on a handler unit's placeholder. The browser decides
how a click commits from the segments it has: a page with a `transition()`
commits in a transition. A unit's placeholder carries its own entry's
`transition` as any segment does. When the entry declares none and
something the unit covers does (a deeper chain entry of a flagged layout, a
slot, an orphan layout), the entries that say so are the ones the prefetch
skipped, so the placeholder carries `transition: { viewTransition: false }`
in their place (`placeholderTransition` in `prefetch-deferral.ts`, from
`DeferralUnit.transition` of the plan): a transition, and no boundary of
its own to place. A slot's unit covers the slot alone and never carries it.
"A unit under `transition()` waits for its fill" has what the browser does
with it and what it cost before.

The fill marker is a query param, `_rsc_fill=1`. A param rather than a header
because the document cache middleware (`src/cache/document-cache.ts`) decides
from the raw URL before the request is classified, and `stripInternalParams`
already removes every `_rsc*` param from the URL handlers see.

### Keeping deferral out of storage (R7)

- **Document cache**: one slot per key, as on main. A response whose payload
  carries deferred units is refused, and a request with `_rsc_fill` skips the
  cache the way `_rsc_action` and `_rsc_loader` do. See "The document cache"
  below.
- **HTTP caches**: such a response, and a fill response, are sent with
  `cache-control: private, no-cache` (`NOT_REUSED` in
  `src/rsc/rsc-rendering.ts`), whatever `Cache-Control` the route set. The
  browser also sends the fill with `cache: "no-store"`. A response that
  defers adds `X-Rango-Prefetch` to `Vary`; every other response keeps the
  string main has, byte for byte. See "Where a deferring response may be
  kept" below.
- **Client prefetch cache**: a response that defers is kept under its source
  page only (R15). A fill never reads or writes the cache
  (`src/browser/navigation-client.ts`), and its URL carries `_rsc_fill`, so
  its key could not match a prefetch entry anyway.

Why does a deferring response need a `cache-control` of its own? You might
expect "no header" to be enough: a source-scoped prefetch gets none from the
router. But the route's own header reaches the response wherever the render
set none (`applyStubHeaders` in `src/rsc/helpers.ts`), and a route that opts
into the document cache does it with `s-maxage`. A prefetch and a navigation
with the same held segments share a URL, so a CDN honouring that header would
store a body with deferred units and answer a navigation with it. The render
sets the header, so the route's cannot apply.

Why `private, no-cache` and not `no-store`? This is scar tissue. A fill used
to be answered `no-store`, and showed up in the Network panel as `(canceled)`
(Playwright: `requestfailed`, `net::ERR_ABORTED`). Nothing was aborted.
Chromium reports every `no-store` response that way once its body has been
read to the end through a stream reader, which is how a Flight payload is
read. A bare `fetch()` of the same URL read with `getReader()` or `tee()`
ends the same way with no router code involved, and ends as finished when the
header is `no-cache`. It was documented and left alone while only fills
carried the header. With deferring prefetches carrying it too, every hover on
a flagged link read as canceled, and Playwright's `response.finished()` never
settled on the second one. `private, no-cache` keeps both from being reused
where it matters: a shared cache may not store it, and the browser has to
revalidate and has no validator to do it with, so it asks again in full.

#### Where a deferring response may be kept

"Never stored by the browser" was the claim here once, and it was wrong.
`no-cache` forbids reuse without revalidation, not storage, and Chromium
does keep the body (measured: `fetch(url, { cache: "only-if-cached" })`
returns it). Two things read that copy without asking the server: a `fetch()`
with `force-cache` or `only-if-cached`, which the router never sends, and
any `fetch()` made while a document is being reloaded for back/forward,
where the browser prefers what it has over what is fresh. That second one is
real: go back to a page that is still streaming, hover the same link, and
the prefetch is answered from disk.

It does no harm, for two reasons you can rely on separately:

- The copy only ever answers the request it was stored for. `Vary` carries
  `X-RSC-Router-Client-Path` on every response (the source page) and, on a
  deferring response, `X-Rango-Prefetch`. A navigation has the same URL as
  its prefetch and lacks that header, so it goes to the network and gets a
  complete payload. Without the header in `Vary`, a navigation fetch made
  during a back/forward reload was answered with the stored deferring body
  (measured in Chromium, `fromDiskCache` in the Network domain).
- The client does not care where a payload came from. Any payload that
  carries deferred segments gets its gates and its one fill ("The browser"
  below), and the fill is sent `cache: "no-store"`. A prefetch answered from
  the browser's copy is adopted exactly like one answered by the server.

main has the same exposure for complete bodies (a prefetch stored with
`private, max-age=300` answers during a back/forward reload too); nothing
here widens it.

### The document cache

The middleware (`createDocumentCacheMiddleware`, `src/cache/document-cache.ts`)
answers a request before the router has matched it. It cannot know whether
the route declares a flag, and it does not need to. It keeps one entry per
key, reads it once per request, and stores only complete bodies:

- A **write** is refused when the payload carries deferred units. The partial
  render marks `RequestContext._payloadDeferred` and `shouldCacheResponse()`
  returns null for it, the way it does for a payload that carries the
  visitor's theme. The response's own `private, no-cache` would be refused
  too, but a middleware can replace `Cache-Control` after `next()`. The marker
  cannot be replaced.
- A **navigation** and a **prefetch** read the same entry. Every stored body
  is complete, so either can be answered with it.
- A **fill** skips the cache.

So a route with no flag behaves as it does on main: one slot, one read, the
same headers. The file differs from main by the fill's skip and that one
refusal.

This is the third design, and the first two are scar tissue. The first gave
every prefetch its own slot, and the handler of an unflagged cached route ran
twice where it used to run once. The second kept a `:prefetch` slot for the
prefetch body of a flagged tree and varied on `X-Rango-Prefetch`. Every
prefetch that missed the plain slot then read a second key, flagged tree or
not: on Cloudflare, one more KV read for apps that never use the flag. Both
existed to keep two kinds of stored body apart. Storing only one kind removes
the need.

Can a complete navigation body answer a prefetch of a flagged tree? Yes, and
on purpose. You might expect a prefetch of a flagged tree to always get the
deferred body. Two reasons it does not:

1. The stored body is complete. The click that adopts it has nothing to wait
   for and sends no fill.
2. Serving it runs nothing. Keeping expensive work out of prefetches is the
   whole point of the flag, and a cache hit is no work at all.

What does a prefetch that defers cost here? One render each time, the cheap
one the flag asks for: nothing answers it but a complete body a navigation
left behind. A **stale** complete entry still answers a prefetch, as it
answers a navigation. Its background refresh re-renders the request that hit
it, and when that is a prefetch that defers, nothing is written. The entry
stays stale until a navigation refreshes it or it expires, and until then
each prefetch is served the stale body and pays one deferred render in the
background, which is what it would have paid with no entry at all.

Pinned by `src/cache/__tests__/document-cache.test.ts` ("a prefetch and a
navigation share one slot") and, through a real router, by
`src/testing/__tests__/prefetch-false.rsc-test.tsx` ("the document cache").

## The browser

### Adoption

`fetchPartialUpdate` (`src/browser/partial-update.ts`) is where every partial
payload is reconciled and committed. When the payload it is about to commit
carries deferred segments, two things happen before the tree is built:

1. `armGates()` gives each deferred segment a **gate**: a promise the browser
   created. A deferred loader's gate becomes its `loaderData`; a deferred
   unit's gate becomes its `component`. To the rest of the client a gate is a
   loader stream that has not arrived yet, which is something it already
   knows how to show. This happens before the reconcile, on the payload's own
   segment objects. That is safe because every adoption decodes its own
   payload (see "Reuse" below).
2. `runFill()` starts the fill request (`client.fetchPartial({ fill: true })`)
   with its own `AbortController`, and the commit proceeds on the lane it
   would have taken anyway. A fully prefetched payload still renders with
   `forceAwait`; `renderSegments` (`src/segment-system.tsx`) skips the awaits
   that would wait on a gate. One adoption does not commit right away: a
   deferred unit on a page that commits in a transition waits for its fill
   ("A unit under `transition()` waits for its fill" below). Its fallback
   shows with the fill's first chunk, as a plain click's shows with its
   response, not at the click.

The reconcile needs no special case. A payload that defers is adopted only on
the page that prefetched it, with the segments that page held when it did
(R15), so a deferred id is always new to the page: there is no copy of the
segment to keep, and none to hide.

That is scar tissue. The prefetch cache used to hand such a payload to any
page, and the browser tried to make that safe: the reconcile ran without the
page's copies of the deferred ids, and a unit the page already showed had its
gate resolved at once (`Gate.fresh`). It could not be made safe. A prefetch
made on the hub and adopted inside the section it had deferred held the click
on a fill for content a plain click showed at once, and ran held work again.
Measured in production: `slot` to `slot-b` with slow loaders showed the new
page at 706 ms against 8 ms, and ran `slot.side` and `slot.data` again;
`section` to `section-own` with a 600 ms layout showed nothing until 608 ms
where the plain click had the fallback at 7 ms. 28 of 30 such clicks sent a
fill. The fix is on the server, where the response says which page it is for,
and the browser code for the other pages is gone.
`expectPrefetchThatDeferredStaysWithItsPage` pins it in both apps and both
modes, including a prefetch still in flight when the click happens elsewhere.

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
held) is not overwritten.

From there the fill does four things, in this order. "Revealing a unit"
below has the reason for each, and the measurement behind it:

1. It reconciles the response against the entry with the
   `"stale-revalidation"` actor and checks that nothing its `matched` names
   is missing. Nothing is handed over before that. A response the client
   then refuses used to leave its `matched`, its location state and its
   handle data behind, under the error that replaced the page.
2. It hands over what the deferred handlers pushed (the response's handle
   stream): an urgent update under the tree that is on screen, made once
   React has committed the adoption.
3. Where the adoption is on screen when the fill answers, fallbacks
   included, it waits until its response is complete, or until 300 ms have
   passed since its first chunk, whichever comes first. Where React has not
   committed the adoption yet, it does not wait.
4. It resolves the gates. A deferred loader's gate resolves right then,
   which releases anything still suspended on it. A fill that brings a unit
   also renders a tree, commits it urgently, and resolves the unit's gate
   once React has committed that tree.

Steps 2 to 4 are for an adoption that commits its own tree. One that waits
for its fill (a unit on a page that commits in a transition) gets everything
in one update: "A unit under `transition()` waits for its fill".

The entry is rewritten **in place**: the fill splices the filled segments
into the array the history cache already holds for the entry, and calls
`store.setSegmentIds()`. It does not go through `cacheSegmentsForHistory`.
The fill belongs to the visit that adopted, and re-caching would do two wrong
things: advance the store's navigation instance, which disowns the adoption's
still-open handle stream, and reset the entry's stale flag.

What goes into the entry is what the fill sent, loader streams included. A
gate is for the tree that is on screen. The next render from this page (a
click that keeps the layout, an action) builds on the entry, and a gate left
there is a promise React has read only where some reader happened to be
mounted.

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

`onCommit` also fires when a _later_ update commits. React commits only the
last of the updates it batches, and an urgent update can supersede a
transition it is holding. An update that is skipped that way would otherwise
leave its gate pending for good. An _earlier_ update that commits meanwhile
does not fire it. `src/testing/__tests__/navigation-update-on-commit.test.tsx`
pins the order through the real provider.

That is the mechanism. Around it sit seven rules about _when_ and _how_ the
fill commits. Every one of them was a measured parity violation first, so
each comes with what broke. They all follow from four things React 19.3 does
(`react-dom-client`, read in the production build):

- **R-wait.** A commit in a transition, retry or idle lane waits for the view
  transition that is running to finish.
- **R-start.** Such a commit, if it changes anything at all (a DOM node, a
  ref, an effect), calls `document.startViewTransition` whenever a
  `<ViewTransition>` with a DOM node is mounted on the page: the router's own
  under `transition()`, or one the app placed in a layout. React names every
  boundary beside the path of the change, whether or not anything inside it
  changed. A transition that changes nothing you can see still runs its 250
  to 300 ms. (A commit with no effects at all starts none.)
- **R-throttle.** A Suspense retry is not committed sooner than 300 ms after
  the last time any boundary on the page showed or hid its fallback. A retry
  that suspends again is committed all the same once that time is up.
- **R-sync.** An urgent update is rendered without waiting. A `use()` of a
  promise React has not read before suspends to the nearest boundary at once,
  even when the promise is already resolved. A transition or a retry gives it
  one microtask.

#### The fill never commits in a transition

It used to: the fill's tree went through `commitInTransition`, like the
adoption. On a unit under `transition()` that is a third view transition
between the two a plain click makes (the commit and the reveal). It changes
nothing on screen, runs its full length (R-start), and the reveal waits for
it (R-wait). Whether you saw it depended on when the loader landed, which is
why a suite with 100 and 700 ms loaders never did. Hub to `vt-unit`,
production, completed content, medians of three clicks each:

| loader | before: plain | before: adopted | transitions | now: plain | now: adopted | transitions |
| ------ | ------------- | --------------- | ----------- | ---------- | ------------ | ----------- |
| 100 ms | 334 ms        | 294 ms          | 2 and 2     | 335 ms     | 331 ms       | 2 and 2     |
| 200 ms | 332 ms        | 306 ms          | 2 and 2     | 339 ms     | 328 ms       | 2 and 2     |
| 300 ms | 333 ms        | 611 ms          | 2 and 3     | 338 ms     | 314 ms       | 2 and 2     |
| 400 ms | 417 ms        | 602 ms          | 2 and 3     | 409 ms     | 414 ms       | 2 and 2     |
| 500 ms | 521 ms        | 578 ms          | 2 and 3     | 521 ms     | 513 ms       | 2 and 2     |
| 600 ms | 620 ms        | 613 ms          | 2 and 3     | 623 ms     | 614 ms       | 2 and 2     |
| 700 ms | 718 ms        | 711 ms          | 2 and 3     | 718 ms     | 714 ms       | 2 and 2     |

It is not about `transition()`. R-start asks only for a `<ViewTransition>`
somewhere on the page. With one of the app's own in the layout
(`&boundary=1` in the fixture) a route with no `transition()` at all did the
same: `unit` with a 100 ms loader completed at 586 ms against the plain
click's 317, with three view transitions against one. Now: 335 ms against
322, 2 against 1. The one that is left is the adoption's own
commit, which is a transition as every prefetched click's is ("Limits").

So every update a fill makes on a page that is on screen is urgent. An
urgent commit starts no view transition and waits for none. Nothing is lost
by it: what a fill brings is read behind a fallback that is already on
screen, so there is nothing for a transition to hold.

Two updates of a fill are transitions, and neither is made on a page the
adoption has put on screen. The update that lands an adoption React is
holding joins that adoption's own transition ("A unit under `transition()`
waits for its fill"). And a fill that fails hands its error to
`emitNavigationError` (`src/browser/network-error-handler.ts`), which wraps
the update in `startTransition` as it does for a navigation that failed: the
error replaces the page.

Urgent has a price, and the next two rules pay it.

#### Not before the adoption is on screen

An urgent update that reaches React while it is still holding the adoption's
transition commits the page ahead of that transition. So a fill's updates
wait for `Fill.whenShown`, which resolves from the adoption update's
`onCommit`.

React may be holding the adoption for the fill itself: a deferred loader
read with no boundary (R11) suspends the transition on that loader's gate.
So nothing a gate waits for may wait for the adoption's commit. When a fill
answers and React has not committed the adoption (`Fill.shown` is still
unset), every loader gate resolves at once. The adoption commits, and the
fill's updates follow it.

"Every" is scar tissue. A unit's own loaders used to resolve with the unit,
in the commit of the fill's tree ("The loaders a unit owns resolve with the
unit" below), whatever the adoption was doing. And a unit's loader can be
read above the unit's fallback: a layout that calls `useLoader()` on its
route's loader reads the route's stream through its outlet. That gate waited
for the fill's tree, the tree waited for the adoption's commit, and the
commit was waiting for the gate. The page being left stayed for good,
`useNavigation()` read `loading`, and nothing was thrown. `above` in the
fixture is that page; `expectNoBoundaryHoldsThePageLeftUntilTheFillReturns`
pins it in a browser, and
`src/testing/__tests__/navigation-adoption-loading.test.tsx` through the
real provider and updater.

The unit's own gate still resolves with the commit of the fill's tree, and
the tree still waits for the adoption. So the commit that ends such a hold
shows the unit's fallback, for React's 300 ms. That is not always what a
plain click does there ("Limits").

#### The fill's tree is built the way the adoption's was

R-sync is the reason. The adoption of a fully prefetched payload renders with
`forceAwait`, so the boundaries on screen were handed values. A tree built
without it hands the same boundaries promises, and an urgent render suspends
on every one React has not read. Measured in production on `section-own`
from the hub: the layout's boundary showed its fallback a second time (the
skeleton unmounted and mounted again, which restarts its animation),
R-throttle started over, and the content was 100 to 303 ms late.

So the fill renders with the adoption's `forceAwait` (`Fill.forceAwait`), and
marks what it brought as `deferred` for the length of the render, so that
none of it is awaited: to the tree it is still streaming.

The same rule reaches one line outside the fill. A boundary with no loaders
used to get one shared, already resolved promise in the browser
(`src/segment-loader-promise.ts`). Resolved is not the same as read: React
knows a promise as fulfilled only after its first `use()`. After a
prefetched click and its fill, every tree had been awaited and that promise
had never been read. The next plain click inside the section handed it to
the layout's boundary, which was on screen, in a render that cannot wait:
the layout was replaced by its own fallback for 300 ms (21 browser tests
caught it). A boundary with no loaders has nothing to wait for, so in the
browser it now gets an empty array, which `LoaderResolver` renders without a
`use()`. On the server nothing changes: every render still builds a fresh
promise, which is what makes Suspense emit the fallback.

#### The fill lands when a plain click would reveal

Take a server 100 ms away. A plain click shows its fallback when its response
starts, at 100 ms, and R-throttle lets it reveal at 400. An adopted click
shows its fallback with the click, so React is ready to reveal at 300. The
fill's data is not there any sooner than the plain click's. A value that
lands between 300 and 400 ms is too late for the adopted click's reveal and
in time for the plain one: the adopted click reveals the unit without it,
shows the fallback inside it, R-throttle starts again, and the content comes
at 600 ms where the plain click has everything at 400.

The window is as wide as the round trip, so on localhost it is a few
milliseconds and no suite had seen it. Production, the server 100 ms away,
`section` (a deferred layout with the route's own boundary below it),
completed content, medians of three clicks:

| loader | before: plain | before: adopted | now: plain | now: adopted |
| ------ | ------------- | --------------- | ---------- | ------------ |
| 100 ms | 406 ms        | 303 ms          | 408 ms     | 304 ms       |
| 200 ms | 408 ms        | 605 ms          | 411 ms     | 310 ms       |
| 250 ms | 408 ms        | 606 ms          | 408 ms     | 360 ms       |
| 400 ms | 708 ms        | 604 ms          | 710 ms     | 712 ms       |

`section-own` had the same numbers and showed `pf-section-own-fallback`,
which the plain click never shows, in every late click.

So a fill that is still streaming does not land before the plain click would
reveal: 300 ms after the fill's own first chunk (`FALLBACK_THROTTLE_MS`, named
for React's constant). A fill whose response is complete lands at once: all
of it is there, so one reveal shows all of it, and that reveal is never later
than the plain click's. Waiting for the end of the stream with no deadline is
not an option: a unit with a slow read behind an inner `<Suspense>` would
keep its outer fallback up long after a plain click had revealed it.

The rule is for a fallback that is on screen. Where React has not committed
the adoption when the fill answers, nothing is up that could be revealed
early, and the fill does not wait. It used to wait there too. A page React
held for a read with no boundary then stayed 300 ms after the value it was
waiting for, whenever the response stayed open behind that value (a slower
flagged loader behind its own `<Suspense>`: `bare-inner` in the fixture).
Production, a 100 ms loader: the page at 307 ms against the plain click's
108, now at 106.

Look at the last row: the rule costs something. Before it, a loader slower
than the throttle made the adopted click 100 ms _earlier_ than the plain one,
because its reveal clock had started a round trip sooner. That head start
cannot be kept without the 200 ms loss in the rows above it: at 300 ms the
client cannot know whether the value is 20 ms away or 200. Never worse comes
first, so above the throttle the two clicks are now equal.

The 300 is React's number, not ours. If React changes it the latency cases
of the parity matrix go red in one direction or the other, which is what you
want: holding the adopted click longer than React holds a plain one is the
same violation mirrored.

The same rule covers a slow handler. A plain click to a section whose layout
handler takes 600 ms keeps the page it is on for about 610 ms and then shows
the fallback for 300 more. The adopted click shows the fallback with the
click. It used to reveal the layout the moment the fill started answering,
with the route below it still pending: the fallback mounted a second time
inside the layout, or `pf-section-own-fallback` showed where the plain click
shows none (from the hub, from another page and after back/forward alike).
Now the fill lands when it is complete, which here is the route's 100 ms
loader after the handler, and lands whole: the page is there at 715 ms
against the plain click's 910, with one fallback and one reveal.

#### The loaders a unit owns resolve with the unit

A parallel slot reads its loaders above its content: its `LoaderBoundary`
suspends on their aggregate, and the content's own boundary sits inside it
with the same fallback element. Resolve the loader gates when the fill
lands and the unit's gate one commit later, and the outer boundary reveals
onto the inner one: the same skeleton, mounted a second time, and R-throttle
starts over (measured on `slot`: content 99 to 250 ms late). So where the
adoption's fallbacks are on screen, the gates of the loaders a unit owns
(same `namespace`) resolve in the same `onCommit` as the unit's. In the
fill's tree those loaders are read from the fill's own streams, the way the
entry will have them afterwards, so the aggregate React reads there is the
one the next render builds. A loader that belongs to no unit has a reader on
screen: its gate resolves when the fill lands, and that reader keeps reading
the gate in the fill's tree.

Where React has not committed the adoption, no fallback is up that could
mount twice, and the rule does not apply: a unit's loaders resolve at once
with every other loader ("Not before the adoption is on screen").

#### A unit under `transition()` waits for its fill

A plain click to a route with `transition()` commits once, in a transition,
when its response starts. React renders the unit's content in that same
commit, in a render that can wait, so the boundary ends up suspended on what
the content reads and on nothing else. The reveal is the retry that fires
when that read arrives: the second view transition.

An adopted click that commits with the click has shown the fallback before
the content exists. From there nothing brings the content in the way the
plain click's first commit did. What was tried, hub to `vt-unit`, completed
content against the plain click:

| How the content arrives                                             | Transitions (plain: 2) | Content against the plain click               |
| ------------------------------------------------------------------- | ---------------------- | --------------------------------------------- |
| Behind the unit's gate, resolved once the fill's tree has committed | 4                      | +280 ms                                       |
| In the fill's tree, committed in a transition                       | 3                      | +278 ms (loader 300), +185 (400), +57 (500)   |
| In the fill's tree, committed urgently                              | 3                      | +295 ms (loader 300, development), +192 (400) |
| The adoption commits with the fill's first chunk, content included  | 2                      | -25 to +3 ms (loaders 100 to 700)             |

The first is R-throttle's second half: the gate's retry suspends again on
the loader that is still streaming, React commits it when the throttle is
up, and under a `<ViewTransition>` that commit is a view transition (R-start)
which the real reveal then waits for (R-wait). The second is R-start and
R-wait on the fill's own commit. The third has no commit of the fill's in a
transition lane and still ends with three: the urgent tree brings the
content, the boundary retries, and the retry does what the first row's did
(`startViewTransition` at 7, 310 and 601 ms in one such click).

So the adopted click does what the plain click does. Where a payload defers a
unit and the page commits in a transition (`shouldStartViewTransition`), the
adoption's update carries a promise nobody resolves in place of the tree
(`Fill.held`). React holds the page being left, exactly as it holds it for a
plain click whose response has not started. With its first chunk the fill
hands over one update, in a transition of its own: the tree, with the unit's
content in it, and the fill's metadata. Two transition updates of one state
are one commit to React (it entangles the lanes of updates to one queue), so
the page commits once, with what the deferred handlers pushed and the
location state the server set, as a plain click's one update brings them. No
300 ms wait here: there is no fallback on screen to run ahead of anything.

Said plainly, because it is the one place the click is not ahead: under
`transition()` a deferred unit's fallback shows with the fill's first chunk,
as a plain click's shows with its response, not at the click.

The promise used to be resolved with the tree, and the rest was handed over
after that commit, in an urgent update. Location state a deferred handler
set was then one commit behind the content it belongs to.
`src/testing/__tests__/navigation-adoption-loading.test.tsx` pins the single
commit through the real provider.

Whether the page commits in a transition is a fact about the page, and the
adoption used to learn it from the segments it had. A prefetch that defers a
layout stops the chain there, so a `transition()` on the route below it was
not in the payload: the adoption committed with the click after all, and the
content came in a commit of its own. Production, a flagged `loading()` on a
layout whose route has `transition()` (`vt-below` in the fixture), plain
click against adopted click:

| loader | before: the layout | before: the page | transitions | now: the layout | now: the page | transitions |
| ------ | ------------------ | ---------------- | ----------- | --------------- | ------------- | ----------- |
| 100 ms | 6 and 304 ms       | 317 and 304 ms   | 1 and 0     | 10 and 4 ms     | 328 and 314   | 1 and 1     |
| 400 ms | 6 and 306 ms       | 418 and 619 ms   | 1 and 1     | 9 and 4 ms      | 435 and 414   | 1 and 1     |
| 700 ms | 6 and 306 ms       | 717 and 715 ms   | 1 and 1     | 6 and 4 ms      | 712 and 716   | 1 and 1     |

The plain click's first commit is a transition and has the layout in it,
with the route's fallback below. The adopted click showed the layout's
fallback alone for 300 ms, then the layout with that fallback mounted a
second time, and with a 400 ms loader the page 200 ms late; with a 100 ms
loader the reveal lost its view transition. (In development the plain click
shows the layout's fallback alone for 300 ms as well, because the layout is
not in the response's first chunk there: fallback at 13 ms, layout at 315.
So the gap only shows in a production build.)

The server knows what a unit covers, so the placeholder says it. When the
deferred entry declares no `transition()` and something its fallback covers
does (a deeper chain entry, a slot, an orphan layout), the placeholder
carries `transition: { viewTransition: false }` (`placeholderTransition` in
`prefetch-deferral.ts`). To the browser that is a segment with a transition
and no boundary to place, which is true of the layout, and the adoption
waits for its fill. A `transition({ when })` on an entry the prefetch
skipped is not asked for that click: the predicate travels with a segment
the adoption does not have ("Limits").

`transition({ viewTransition: false })` takes the same road. It places no
`<ViewTransition>`, so there is nothing to animate, but the plain click still
commits in a transition, and the app may have a boundary of its own
(`vt-unit-off` and `vt-unit-own` in the fixture). Both were measured at
parity this way, so one rule serves all three.

What it costs is the head start. With the server 100 ms away the click shows
its fallback when the fill starts answering, about 100 ms in, where it used
to show it with the click; the plain click shows it about 100 ms in too.
Without latency the table above has the same thing in its first two rows:
26 to 40 ms earlier than the plain click before, equal now. It was not a
head start worth having: in exchange for it the content was up to 278 ms
late. `useNavigation()` reads `loading` for that time, as it does on the
plain click.

A flagged `loader()` under `transition()` is not a unit and is not affected:
its page commits with the click, and its fill, like any fill of loaders
alone, renders nothing.

Why not the simpler fix, running such a unit in the prefetch after all? It
would be instant on click, and it would spend, on every prefetch, exactly
the work the flag was written to keep out. Waiting for the fill costs
nothing a plain click does not cost.

#### A fill that carries loaders only renders no tree

The tree the adoption rendered reads the gates, and they resolve when the
fill lands. The one update such a fill makes is the handle data, with the
tree that is already on screen (`Fill.root`). A new tree there would be one
more commit with nothing to show.

#### A fill says nothing about scroll

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
page. That happened more often than you would guess. The fill's update was
emitted when the first chunk of its response arrived, a few milliseconds
after the click. The adoption's commit is a transition, which React renders
in a later task, so the two raced: on a fresh page the fill won 7 clicks out
of 8 (measured from the hub, 100 ms loaders, dev and production). A fill's
updates now wait for the adoption's commit, so that race is gone. The rule
below stands on its own all the same: a fill is not the only update with no
decision.

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

What a page can observe, each checked against a plain navigation whose
loader is still streaming:

- **`useNavigation()`** reads what it reads on a plain navigation that is
  still streaming: `state: "loading"` until React commits the adopted
  payload, then `"idle"` with `isStreaming: true` until the fill has landed
  and streamed (the adoption's streaming token stays open until then). Where
  a fallback can show, that commit is immediate and `"loading"` lasts a few
  milliseconds, as on a plain click. Where nothing can show one (R11) React
  holds the commit until the fill returns, and `"loading"` is what an app's
  progress bar has to see for all of that time. A deferred unit under
  `transition()` is held the same way until its fill starts answering.

  It used not to. The adoption commits in the task of the click, so the
  controller goes to `loading` and back before React has rendered either, and
  the state after the commit reaches React inside the payload update's
  transition (`flushRouteState`), which React was holding. Hub to `bare` with
  slow loaders, production: the plain click read `loading` from 5 to 712 ms,
  the adopted one read `idle` until 709 ms. Now the adoption's update is
  handed over through `emitAdoption()` (`browser/pending-fill.ts`), and while
  that runs `useNavigation()` sets its optimistic value to `loading` inside
  the same transition. An optimistic value shows at once and gives way to the
  real state when its transition commits, so the pin lasts exactly as long as
  React holds the commit.

  Releasing the pin from outside was tried first (a flag on the controller,
  cleared in `onCommit`) and is wrong. The release is then a transition of
  its own, which under `transition()` waits for the entering view transition
  and starts another: three view transitions for two, and the content 280 ms
  late. `src/testing/__tests__/navigation-adoption-loading.test.tsx` pins the
  behaviour through the real provider, and
  `expectPendingFillReadsLikeAStreamingNavigation` in the browser, on a unit
  and on a read with no boundary.

- **The URL and the URL hooks** are the one thing here that is not at
  parity. The address bar and `useNavigation().location` move with the
  click, also where React holds the page; on a plain click
  the hooks move with the page. The parity check measures it (how far the
  address bar and a URL hook on the page being left are ahead of the page,
  against the same for the plain click, with a 50 ms margin) and the cells
  that break it are open ("Limits").

- **View transitions.** A fill starts none on a page that is on screen: its
  updates there are urgent ("Revealing a unit"). It reuses the adoption's
  `transition({ when })` decision (passed to `runFill`) for the tree it
  renders. On a route with `transition()` the browser gets two
  `document.startViewTransition` calls,
  the commit and the reveal, with or without the prefetch, for a flagged
  loader and for a flagged `loading()`, whatever the loader takes. The parity
  check allows the adopted click no call the plain click does not make.
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

A response is checked before anything of it is handed over, so a failure
that is in the response itself (missing segments) leaves nothing behind. A
failure can still come later, while the tree is built. Once the error is
shown the fill hands nothing more over. Its handle update waits for the
adoption's commit, and where React was still holding the adoption (a read
with no boundary) the error's commit is that commit: handed over then, the
update would put the adoption's tree back over the error, with gates nobody
resolves.

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

### Reuse within `prefetchCacheTTL`

A prefetch entry respawns on every adoption (`makeRespawn` in
`prefetch/fetch.ts`), so each adoption decodes its own payload, arms its own
gates and sends its own fill.

An entry that defers lives under its source page's key, which includes the
segments that page held (`buildSourceKey` in `prefetch/cache.ts`). Coming
back to a page the client still has in its history cache is a different
request: it lists that page's segments, so the key does not match and the
click is a plain navigation over the cached copy
(`expectRevisitUsesWhatTheClientHolds`).

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

- A deferred `loading()` entry on a page that commits in a transition (its
  own `transition()`, or one on anything its fallback covers) shows its
  fallback when its fill starts answering, not with the click ("A unit under
  `transition()` waits for its fill"). Equal to the plain click, never ahead
  of it.
- A `transition({ when })` on an entry the prefetch skipped is not asked for
  the adopted click. The decision is made once, over the segments the
  adoption has (`decideGatedOff` in `partial-update.ts`), and the predicate
  travels with a segment that arrives in the fill. The click then commits as
  under a plain `transition()`: held until the fill answers, and animated,
  where a predicate that returns false would have made the plain click
  urgent. Read from the code, not measured: no fixture has that shape.
- Two flagged loaders read in boundaries of their own, on a route whose
  `loading()` covers both, used to cost one fallback and 100 ms against the
  plain click (`nested` with loaders of 400 and 550 ms: 706 ms against 612 in
  production). The plain click showed the route's `loading()` first and
  revealed the page 300 ms later, which restarted React's throttle, so both
  values showed together. Since the held-boundary fix (#1080) a route whose
  handler has returned is handed to its boundary as the node, the plain
  click shows the page with its response, and the two clicks show the same
  sequence: measured 710 ms against 706, and 811 against 808 with the server
  100 ms away, green three runs of three in both apps and modes.
- A loader that lands within a few milliseconds of React's 300 ms is a coin
  flip for a plain click too: the value either makes the throttled reveal or
  waits 300 ms for the next one. The fill's deadline runs from its first
  chunk and the plain click's throttle from its fallback's commit, a few
  milliseconds later, so at exactly 300 ms the adopted click loses the flip
  a little more often (production, `section` routes: 3 clicks of 12 against
  1 of 12; development: none of either). The parity matrix keeps its
  mid-duration column at 400 ms for that reason.
- With a `<ViewTransition>` mounted on the page being left, the adopted
  click starts a view transition the plain click does not, and the reveal
  of what was deferred waits behind it. Any boundary does it: one of the
  app's own (`&boundary=1` in the fixture), or the router's on a page with
  `transition()` (the fixture's `vt`). The cause is not the flag. A click
  that commits from a prefetch commits in a transition, flagged or not,
  where the plain click to a route with no `transition()` commits urgently,
  and React animates a transition's commit (R-start). What the flag adds is
  a reveal that has to queue behind that view transition (R-wait). The
  queue is free while a view transition is shorter than the 300 ms React
  keeps a fallback up, and late by the rest of it otherwise: at the
  browser's default duration the three `vt` rows below are within 5 ms of
  the plain click, and an app that sets a longer one pays the difference.
  Production, plain against adopted, the page complete, at the default
  duration and with `animation-duration: 600ms` on the view-transition
  pseudo-elements (`&vtms=600`):

  | click                           | transitions | default        | 600 ms          |
  | ------------------------------- | ----------- | -------------- | --------------- |
  | `vt` to `unit`                  | 0 and 1     | 309 and 308 ms | 307 and 641 ms  |
  | `vt` to `section`               | 0 and 1     | 309 and 314 ms | 306 and 655 ms  |
  | `vt` to `loader`                | 0 and 1     | 307 and 311 ms | 308 and 625 ms  |
  | hub with a boundary to `unit`   | 1 and 2     | 311 and 349 ms | 319 and 664 ms  |
  | hub with a boundary to `loader` | 2 and 3     | 328 and 614 ms | 666 and 1313 ms |

  The last row is late at the default duration too: a flagged loader that
  lands inside the adoption's own view transition is revealed one whole
  transition late. A unit on a page that commits in a transition itself
  (`vt-unit`) is not affected: the plain click commits in a transition
  there too. Not fixed, and no mechanism was built for it: whether a click
  that adopts a prefetch should commit urgently where the plain click does
  is a decision about every prefetched click, not about this flag. The ten
  cells run as expected failures (`OPEN_QUEUED`).

- A unit whose loader is read above its fallback with no boundary (a layout
  that calls `useLoader()` on its route's loader) can show the unit's
  fallback for 300 ms where a plain click shows the page complete. React
  holds the adoption on the loader's gate. The unit's own gate resolves with
  the commit of the fill's tree, and that tree waits for the adoption to be
  on screen, so the commit that ends the hold has the unit's fallback in it
  and React keeps a fallback up for 300 ms. A plain click has the route's
  content in the response that carries the value. The commit that ends its
  hold shows the page complete, or the same fallback for 300 ms, depending
  on whether the content is ready in it; which of the two was not pinned
  down, and it differs by app and by how long the loader takes. Production,
  plain against adopted, the page complete (`above` in the fixture):

  | loader | Cloudflare app  | node app         |
  | ------ | --------------- | ---------------- |
  | 100 ms | 411 and 410 ms  | 410 and 405 ms   |
  | 400 ms | 408 and 711 ms  | 707 and 712 ms   |
  | 700 ms | 711 and 1012 ms | 1012 and 1012 ms |

  This page used not to show at all ("Not before the adoption is on
  screen"). Closing the rest needs the fill's tree in the commit that ends
  the hold, which is what a unit under `transition()` gets (`Fill.held`).
  Doing the same for every adoption React has not committed when its fill
  answers has one case against it, by React's rules and not measured: an
  adoption whose commit is under way behind a view transition would take
  the fill's update as a transition of its own, which waits for that view
  transition and starts another (R-wait, R-start). Telling a hold from a
  commit under way needs a signal from React the client does not have. A
  unit whose fill brings nothing but what its placeholders stand
  for (a route and its loaders) could have its gate resolved at once
  instead: its adoption's tree is complete without the fill's. Tried and
  measured: on the Cloudflare app in development the adopted click then
  completes at 111, 417 and 710 ms against the plain click's 421, 495 and
  711, with no fallback of its own. It costs 14 bytes gzip, which puts the
  router chunk at 49,163 against its ratchet of 49,152, and it leaves a
  flagged layout with deeper entries, and a unit with slots or orphan
  layouts, where they are. Not fixed; the cells run as expected failures
  (`OPEN_ABOVE`).

- Where React holds an adopted click, the address bar and the URL hooks
  move with the click and the page moves when the hold ends. The adoption's
  transaction commits in the task of the click (the history entry, the
  event controller's location), and React holds only the tree. Two holds
  exist: a deferred unit on a page that commits in a transition, until its
  fill answers, and a deferred loader read with no boundary, until its
  value arrives. A plain click moves the hooks with the page. Production,
  plain against adopted, how far ahead of the page:

  | click                               | address bar     | `useNavigation().location` |
  | ----------------------------------- | --------------- | -------------------------- |
  | `bare`                              | 101 and 106 ms  | 1 and 106 ms               |
  | `bare`, a slow loader               | 700 and 709 ms  | 0 and 709 ms               |
  | `above`                             | 100 and 103 ms  | 0 and 103 ms               |
  | `vt-unit`, the server 100 ms away   | 6 and 113 ms    | 5 and 113 ms               |
  | `vt-unit`, the fill's head held 1 s | 12 and 1011 ms  | 11 and 1011 ms             |
  | `bare`, the fill's head held 1 s    | 101 and 1109 ms | 0 and 1108 ms              |

  On a read with no boundary the plain click's address bar is ahead of the
  page as well (it moves with the response, and React then holds the page
  for the value); the hooks are what differs there. With no latency a held
  unit's hold is the fill's round trip, a few milliseconds, inside the
  rule's 50 ms margin. Not fixed: moving the transaction's commit to
  React's commit is a change to how every navigation records itself. The
  back/forward fix that made `usePathname` and `useSearchParams` change
  with the page instead of at popstate (#1049) is the precedent. The cells
  run as expected failures (`OPEN_HELD`).

- A prefetch that is still unanswered when its link is clicked on _another_
  page is waited for and then dropped, because a response that defers is for
  its source page only (R15). That click is later than a plain one by what
  was left of the wait: +303 to +315 ms with a 300 ms hold. main has the
  same path for a prefetch an intercept scopes to its source (the in-flight
  entry in `src/browser/navigation-client.ts`).
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

### Open cases

A gap that is known and not fixed is data on its parity case
(`PrefetchFalseParityCase.open`: a reason and the rules it breaks). The case
still runs. Every rule the gap does not break is asserted first, so a
regression in the same cell is a real failure. Then the test is marked with
`test.fail` and the broken rules are asserted: the run reports an expected
failure with the reason, and an unexpected pass, which fails the suite, the
day the gap is fixed. 33 cells per mode and app:

| Gap           | Cells | Rules it breaks            |
| ------------- | ----- | -------------------------- |
| `OPEN_HELD`   | 20    | the URL rule               |
| `OPEN_ABOVE`  | 3     | URL, fallbacks, lateness   |
| `OPEN_QUEUED` | 10    | transitions, lateness, URL |

A gap need not break every rule it names in every cell or app: `OPEN_ABOVE`
breaks the URL rule everywhere, and the other two where the plain click
shows the page complete.

The retry of a late pair (three pairs, the case fails only if every one is
late; structure is judged on the first pair alone) means a lateness that
shows in one pair of three passes by design. An open case is never retried
for what its gap explains.

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
deferred loader take 600 ms longer, so you can watch a fallback, and
`&hslow=1` does the same to the section layout's handler. `&delay=<ms>` adds
that much to every deferred loader, which is how the parity matrix puts a
loader on either side of React's 300 ms. `&boundary=1` wraps the hub's
heading in a `<ViewTransition>` of the app's own, and `&vtms=<ms>` makes
every view transition take that long (an app's own
`animation-duration` on the view-transition pseudo-elements). Without `manual=1`
the panel, the badge and the polling are not rendered, which is what the
suites see. Every link carries the flags that are set.
