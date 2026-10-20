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
(or React holds the click) where the deferred pieces are, and sends one second
request for the same URL, the **fill**, which runs only what the client does
not hold yet. The navigation that committed the tree owns that request: it
waits for the response and resolves what the tree is waiting for. The click
builds the page once, and the fill hands React no tree of its own (one
failure ending aside, "Failure").
Nothing else changes: a hard load, a navigation with no prefetch to adopt, an
action, a back/forward and a no-JS form post never see a deferred segment.

The flag applies only to a segment the client does not have yet. This router
keeps what is on screen wherever it can, and the flag must never cost you
that, so a segment the browser already holds is never deferred. The promise
the feature makes, and the one to check any change against, is the
maintainer's bar of 2026-10-11: **a click that adopts a prefetch shows the
next page, or its skeleton, at the click. It never shows that page later
than the same click with no prefetch at all, and the router adds no wait of
its own: what shows after the click is decided by React's own Suspense
rules. Content that is already on screen is never replaced by a fallback,
blanked or remounted while a fill is pending.**

Showing the next page early is what justifies a prefetch; the parts it
deferred are meant to arrive after the click. So a fallback that shows for
them is the design, not a failure, even where a plain click shows none. The
adopted click reveals the deferred part a response sooner than the plain
click, so a read inside it that lands later shows its own fallback, and
React keeps that fallback up its 300 ms ("When the holes resolve").

You may meet an older statement of the promise: "never covers more of the
page with a fallback than the plain navigation, and never for longer". It
asked the adopted click to complete no later than the plain one, and it is
wrong. It held back a page the visitor could already be reading, to line it
up with a value that was not there yet, and meeting it took router code
that steers React's timing: first an alignment of the reveal to React's
300 ms, then a `<Suspense>` that never resolves, placed to restart React's
throttle. Both were dropped. When React's own behaviour leaves a difference
from the plain click, it is documented and the test follows it.

Timing is judged at a realistic distance. The parity cases run against a
server that takes 300 ms before its first byte on every request (the
fixture's `&server=` middleware, "The parity cases"). A local server answers
in a few ms, and at that distance React's 300 ms throttle is the slowest
thing on the page: it decides when anything shows, and a comparison there
says nothing about what a prefetch saves.

Two cases differ from the plain click on purpose, both the maintainer's
call, both asserted rather than left open. The first is the one place where
the adopted click shows a different page: a flagged `loading()` on a layout,
entered from a page without the layout, shows its skeleton with the click
over the layout's whole area, and the layout once the fill has answered, at
least React's 300 ms after the skeleton, where a plain click shows the
layout with its first chunk ("A layout unit shows its skeleton with the
click"). That is the bar's shape: the skeleton at the click, the layout when
React reveals it. With the server 300 ms away the layout shows when the
plain click's does; a server nearer than React's 300 ms makes it wait for
the throttle. Whatever
is still pending below it then shows its fallback inside the layout, as on a
plain click: a `loading()` of its own, an app's `<Suspense>`, or, for a read
with no boundary of its own, the layout's own fallback a second time. React
keeps that fallback up 300 ms from the layout's reveal and holds every other
reveal on the page as long, so content can come up to that much later. The
second is a click that comes before its own prefetch has answered. The
router reuses a prefetch that is still in flight, with or without the flag, and keeps doing
so. When that answer has holes the click sends its fill after it, so the
deferred part completes later than a plain click's, by up to what was left
of the prefetch. The flag exists to keep expensive or slow work out of every
prefetch, so that the API behind it is not called for every link a visitor
might click; the later deferred part is the price the app chose. The
exception is asserted with a bound, so it
cannot grow ("A click before its prefetch has answered").

Two trade-offs of the navigation filling its own holes are the maintainer's
call as well, accepted rather than fixed. A newer navigation cancels the
fill when it starts, not when it commits, so a navigation that then ends
without replacing the page (a redirect the client refuses, an action refetch
that drops its response) leaves the deferred part's fallbacks up with nobody
to fill them ("Abort"). And `navigate()` resolves once the fill has
answered, not when the page commits: the navigation that commits the tree is
the one that fills it ("Adoption"). `useNavigation()` is idle from the
commit, with `isStreaming` true until the fill has streamed.

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
| The same click, before the prefetch has answered                     | waits for the prefetch, then as above       | waits for the prefetch, then as above        |
| Click on another page than the one that prefetched                   | that prefetch is not used (R15)             | that prefetch is not used (R15)              |
| Fill request                                                         | executes; only missing ids are emitted (R5) | executes; only missing ids are emitted (R5)  |
| Action revalidation, popstate, no-JS (PE)                            | unchanged                                   | unchanged                                    |
| Shell capture, warm request, on-demand prerender, `_rsc_loader` lane | unchanged (none is a prefetch)              | unchanged                                    |

For a loader inside `intercept()`, in `urls()` or `clientUrls()` ("Intercepts"
below). Its loaders are loader segments of the intercept's slot.

| Request kind                                           | Flagged intercept loader                                                       | Unflagged intercept loader        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------- |
| Document request of the target                         | no intercept renders (unchanged)                                               | no intercept renders              |
| Navigation from the source, no prefetch                | runs (one request)                                                             | runs                              |
| Prefetch from the source (slot new)                    | not executed, marked deferred (R1)                                             | runs                              |
| Prefetch with the modal open (slot and loader held)    | runs when it revalidates (R14)                                                 | runs when it revalidates          |
| Click that adopts the source's prefetch                | the modal and its `loading()` at the click; one fill with the intercept source | its value in the slot's aggregate |
| Fill                                                   | executes                                                                       | skipped, no predicate (R5)        |
| Action with the modal open                             | its `revalidate()`, per loader                                                 | its `revalidate()`, per loader    |
| Leaving the intercept, back/forward                    | unchanged                                                                      | unchanged                         |
| `loading(…, { prefetch: false })` inside `intercept()` | ignored: the slot is never a unit                                              | ignored                           |

The same for a route of a `clientUrls()` group, whose `loading()` takes no
options. "In-group click" is a click from one route of the group to another
route of the same group mount: the click that presents its destination
optimistically ("`clientUrls()` routes" below).

| Request kind                                                   | Flagged group `loader()`                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Document request (hard load)                                   | runs, as before (an `ssr: false` one is awaited, R3)                                                                           |
| Prefetch request, loader segment new to the client             | not executed, marked deferred (R1); the response is source-scoped (R15)                                                        |
| Prefetch request, loader segment the client holds (same-route) | runs when it revalidates, as before (R14); the click sends no fill                                                             |
| In-group click that adopts the prefetch                        | the destination at the click; the prefetched tree, the URL and the other loaders' data with the commit after it; one fill (R4) |
| The same click, before the prefetch has answered               | the destination at the click; waits for the prefetch, then as above                                                            |
| In-group click with no prefetch to adopt                       | runs, as before: the destination at the click, then the commit with the response (one request)                                 |
| Click into the group from a server page, adopted               | the server-route path: urgent commit with the hole, one fill                                                                   |
| Fill request                                                   | executes; only the deferred loader segments are emitted (R5)                                                                   |
| Back/forward, action refetch                                   | unchanged                                                                                                                      |
| Intercept target                                               | the optimistic presentation declines: as the intercept table above, its flagged loaders deferred from the group's source       |

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
it is cold", and the `"use cache" in deferred work` describe). R1 is about a
loader nothing starts: one that a reader starts in the prefetch runs there and
reads its `cache()` as on a plain navigation ("Handlers that read a flagged
loader").

**R2. A flagged `loading()` entry that is new to the client, in a prefetch.**
Two cases, and which one applies depends on whether the entry's handler output
is stored.

- _Not stored_ (no enabled `cache()` boundary covers it, the route is not
  `ppr`, it is not a `Prerender`/`Static` handler): the handler does not run.
  Neither do the entry's loaders, its orphan layouts or its parallel slots,
  and for a layout no deeper entry of the chain runs. The fallback is sent,
  and every segment that did not run is in the payload as a placeholder
  marked deferred: the page's whole skeleton ("Wire format").
- _Stored or about to be stored_ (enabled `cache()` scope, `ppr` route,
  `Prerender`/`Static`): segments are looked up, served, rendered and written
  exactly as before, hit or miss. Only the loaders behind the fallback are
  deferred, as in R1. For a layout that is every loader of the chain below
  it, also where the layout's handler runs because its output is stored
  (`defersLoader` in `router/segment-resolution/prefetch-deferral.ts`): the
  flag is about the block, and keeps the block's work, its loaders included,
  out of prefetches.
- A parallel slot with its own flagged `loading()` is its own unit.

**R3. `ssr: false` with `prefetch: false` on a loader.** Outside `ppr` both
apply: the document awaits the loader, a prefetch skips it. On a `ppr` route
an `ssr: false` loader is the bake lane (shell material, served from the
record), so the flag is ignored there and development logs a warning.

**R4. Adoption.** A payload that carries deferred units is committed at once
when the client adopts it, and it is adopted only on the page that prefetched
it (R15). The deferred units show their fallback. Exactly one fill request is
sent per adoption, by the navigation that adopts it and with that
navigation's signal, started before the tree is rendered. One adoption is not
committed at once: a deferred `loading()` entry on a page that commits in a
transition is committed with the first chunk of its fill, as the plain click
is committed with the first chunk of its response.

**R5. Fill.** A partial request to the same URL. `_rsc_segments` lists what
the client holds, so the deferred ids are absent. It carries `_rsc_fill=1` and
no `X-Rango-Prefetch`, so nothing is deferred in it. Ids absent from the list
render. Held segments are skipped outright: no `revalidate()` predicate runs,
no handler runs, nothing is emitted for them.

**R6. Merge.** The fill settles the tree the click committed: it resolves
what that tree is waiting for and writes the stores, and hands React no tree
of its own, so nothing on the page is mounted twice. Errors, `notFound()`,
`redirect()` and handle pushes from deferred work behave as they do for work
that streams behind `loading()`, only later. One ending replaces the page: a
handler the fill awaited failed, so the page is not the one the tree was built
for ("Failure").

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
prefetch, as before. Never missing data, never a hole with no fill. On a
route of a `clientUrls()` group the flag is honoured on `loader()`: a group
route's own `loader(Def, { prefetch: false })` (a group `layout()`'s
included), and a flagged `loader()` on a server layout above the group. A
flagged `loading()` defers nothing on a group route, and neither does a
flagged `loading()` inside `intercept()`, in `urls()` or in `clientUrls()`.

**R9. No change without the flag.** A route or intercept with no flag defers
nothing: its prefetch carries no deferred segment and is followed by no fill.
For a route the response is byte-identical to what it was. Pinned by
`src/testing/__tests__/prefetch-false-unflagged.rsc-test.tsx` (an intercept's
response changed shape when its loaders became loader segments of its slot,
and is pinned there by what it carries). Such a route
also does one document-cache read per request and answers with the `vary` and
`cache-control` it has on main (`prefetch-false.rsc-test.tsx`, "a route with
no flag answers a prefetch and a navigation as it does without the feature").

One client rule is the same for every navigation, flag or not: a partial
request is cancelled by its signal only until its response arrives, and a
response that has arrived is never aborted. Aborting a Flight body
mid-stream errors every chunk a mounted tree may be reading, so the response
streams to its end and the navigation that sent it ignores it: it commits
nothing, writes no history entry, store or handle data, restores no scroll
position, reloads nothing and stops counting toward
`useNavigation().isStreaming` at the abort
(`src/__tests__/navigation-ignored-response.test.ts`, and "a navigation left
after its response arrived" in `partial-update.test.ts`). The cost is that
the server renders an ignored response to its end. That is not new for a
navigation: `fetchPartialUpdate` (`src/browser/partial-update.ts`) never
handed the navigation's own request its signal, on main either, so a
superseded navigation and the stale entry's revalidation on back/forward
were always ignored rather than cancelled. The request whose cancellation
changed is the development HMR refetch (`src/browser/rsc-router.tsx`), which
a newer HMR update used to cut mid-stream. The event controller also aborts
a committed navigation whose stream is still open when a newer navigation or
a back/forward starts ("Abort"); for a navigation with no fill that only ends
its streaming token.

**R10. Context limitation.** Deferred work runs in the fill request.
Middleware runs there as on any render pass. Handlers outside the deferred
unit do not, so values they would have set with `ctx.set()` are not visible to
deferred work. This is the rule a revalidation that skips the producer already
has (execution-model.md, "Revalidation Contract", semantic matrix row `[R1]`).

**R11. No boundary.** A flagged loader whose read site has no boundary makes
React hold the click until the fill returns. No definition-time error.
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
- A `clientUrls()` group `layout()` loader is held the same way on every route
  of its layout: the copy under the route the page leaves counts as the
  destination's (`client-urls/layout-loader-copies.ts`), so between two of those
  routes it is never deferred, and its `revalidate()` (or a layout's default,
  which holds it) decides whether it runs in the prefetch. A prefetch that
  enters the layout defers it. Pinned for every loader kind by
  `src/testing/__tests__/prefetch-false-on-screen.rsc-test.tsx`.

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
- The route segment belongs to a `clientUrls()` group and the loader is
  deferrable only through a `loading()` (2 to 4). In a group route's chain
  `resolveDeferralScope` counts no flagged `loading()`, the group's or a
  server layout's above it: a group route's handler is `ClientUrlsRoot`,
  keyed by its group (`segment-system.tsx`), and a unit there would hand
  React a promise in place of the optimistic destination the visitor is
  already looking at. A loader's own flag (1) counts wherever it sits in that
  chain: the group's own, and a server layout's above the group.

A loader declared inside `intercept()`, in `urls()` or in `clientUrls()`, is
deferrable by its own flag (1) alone, in a request that resolves that
intercept ("Intercepts" below). A flagged `loading()` there defers nothing.

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
  is not an action and not a shell capture; `"fill"`
  when a GET's raw URL carries `_rsc_fill`; otherwise unset. A request of
  another method that carries either marker is a normal request. The header
  and the param are read once, when the request context is created
  (`requestKind()`, kept as `RequestContext._requestKind`; the names are
  `PREFETCH_HEADER` and `FILL_PARAM`, in the dependency-free
  `src/prefetch-markers.ts` the browser imports too). The decision is one
  function, `partialDeferralMode()`, with a truth table beside it: an action
  is always a POST and a capture always runs the full match, so no real
  request can show those conditions apart.
- `held`: the client's segment ids as the request listed them in
  `_rsc_segments`. Deferral reads this set and no other. It is the set
  `buildMatchResult` filters the response with, and it is not the set
  resolution works on: the match drops a route's id from that one to force a
  same-route render from an intercept source. Deferring on the forced set
  skipped the handler of a route the response then left out as held, so the
  click got nothing for it.
- `skipped` and `record`: for a prefetch, the segment ids of the units this
  request skips, and how the request may use the route's `cache()` record
  (`RecordUse`: `read`, `write` and `refresh`). `defersUnit()` is a lookup on
  `skipped`, and the cache middleware reads `record` through `recordUse()`.
  One computation, so the resolver and the cache middleware cannot disagree
  about what was skipped.
- `storedFrom`: the first chain index whose handler output is stored. `0` for
  a `ppr` leaf and for `Prerender` routes, the `cache()` boundary's index when
  the route's scope is enabled, `Infinity` otherwise. A `Prerender` route
  counts from its definition (`isPrerender` on the leaf), not from whether
  this request found an artifact: the dev server has none, and a prefetch
  there should skip what a production prefetch skips.
- `deferredUnit`: the id of the handler unit this prefetch skipped, set during
  resolution.
- `below`: a latch, set during resolution when the walk skips a chain unit.
  Resolution is in chain order, so everything it reaches afterwards is behind
  that unit's fallback: `defersUnit()` answers yes for every segment below
  the latch that is new to the client (`belowDeferredUnit()`).

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

- `resolveOwnerLoaders` is the one place a navigation kicks a DSL
  loader off. A loader `defersLoader()` says yes to (R14) is registered
  (`registerDeferredLoader`) and emitted as `{ type: "loader", deferred: true }`
  with no `loaderData`. Registering starts nothing: `resolveLoaderData` is
  called only when a reader starts the loader, so the `cache()` of a loader
  nothing reads is not read (R1).
- `resolveEntryHandlerWithRevalidation` skips a unit's handler, emits the
  segment with `component: null`, the fallback and `deferred: true`, and sets
  the latch (`markUnitDeferred`). The walk goes on.
- Everything the walk reaches below a chain unit is emitted the same way, as
  a placeholder of its own: each deeper chain entry
  (`resolveAllSegmentsWithRevalidation` no longer stops), each orphan layout
  and each parallel slot (`resolveParallelSegmentsWithRevalidation`), with
  its own `loading`, its own `transition` and its slot name. No handler runs.
  A slot below the latch is not asked its `revalidate()` predicates: it is
  new, so there is nothing to revalidate against.
- A slot with its own flagged `loading()` is a unit by itself and sets no
  latch: the route beside it renders.
- The loaders of every skipped entry are emitted as deferred loader segments.
- So a prefetch that defers a unit sends the `segments` and the `matched` of
  a plain navigation to the same page, minus the values. The browser builds
  the page's tree from that once and never needs a second one ("The browser").
  Pinned by `src/testing/__tests__/prefetch-false.rsc-test.tsx` ("the
  skeleton of a deferred unit"), which compares the wrapper fields of every
  segment and `matched` with a plain navigation's, on a flagged layout with a
  slot, a route with `loading()`, `transition()` and a slot of its own, and
  an orphan layout with a loader and a slot.

  It used to stop at the unit. Skipped entries were absent from `segments`
  and from `matched`, and everything below the unit reached the browser only
  in the fill, which is why the fill had to render a tree.

- `buildMatchResult` (`src/router/match-result.ts`) needs no special case: a
  deferred segment is never one the client holds, so the ordinary "send what
  the client lacks" filter keeps it. Both sides read the ids the request
  listed (`PrefetchDeferral.held`).
- The partial render (`src/rsc/rsc-rendering.ts`) looks at what it is about
  to send. One deferred segment makes the response source-scoped (R15), marks
  `RequestContext._payloadDeferred` and sets its `cache-control` (R7).

In a fill, every one of those decision points answers
`!clientSegmentIds.has(id)` and nothing else. That answer is one function,
`fillSends()` in `prefetch-deferral.ts`. `revalidation.ts` asks it through
`revalidateHeld()` for a held loader, entry or orphan layout, and directly
for a slot, where the fill decides a slot the client lacks as well. The two
store paths in `src/router/match-middleware/cache-lookup.ts` (the `cache()`
HIT loop and `yieldFromStore`) ask it too, so they keep a held segment
without consulting predicates or the params comparison. Each path keeps its
own rule for every other request, and the two differ: `yieldFromStore`
ignores a search change, re-sends every held segment when the params
changed and the route's own segments on an action, while the HIT loop re-sends a route's own segments when the params
or the search changed and asks `revalidate()` where a segment declares one.

A fill also leaves a stale `cache()` record alone. A stale hit normally
schedules a background re-render of the whole route
(`withBackgroundRevalidation`), and so did a fill at first: the layout and
the route handler ran again behind a request whose rule is that no handler of
a held segment runs. The fill now skips the refresh, as it skips the
proactive re-render in `withCacheStore`: its plan's `record.refresh` is
false. Nothing is lost: the record is refreshed by the next request that
reads it, and the prefetch that came before the fill was already one.

### Handlers that read a flagged loader

A handler that calls `await ctx.use(ReviewsLoader)` needs the value to render,
so the loader runs in the prefetch whatever its flag says. The rule is lazy
deferral: a deferred loader is one nobody started by the end of resolution.

Deferring a loader registers it and starts nothing. The registration
(`PrefetchDeferral.deferredLoaders`, `registerDeferredLoader`) holds the
segment that registers the loader and how resolution would have started it:
`resolveLoaderData` with the loader's entry, its `cache()` binding included.
When something reads the loader, a handler's `ctx.use()` or another loader's,
the loader executor (`createLoaderExecutor` in `router/loader-resolution.ts`)
finds no run and no binding and starts it through that registration
(`startDeferredLoader`), once. So the read takes the path a navigation takes:
a warm `cache()` serves the reader and the body does not run, a cold one runs
it and stores. After resolution, `resolveAllSegmentsWithRevalidation` looks
at each deferred loader segment and delivers every loader that was started
(`deliverStartedLoaders`): its own `resolveLoaderData` finds the same run or
binding, so the reader and the loader's segment carry one value from one
run, as on a plain navigation (R8). What a prefetch does with a flagged
loader's `cache()` therefore follows whether the loader is started: an
unstarted one is not read (R1), a started one reads and writes its `cache()`
exactly as a navigation's run does.

It used to start the other way round. The reader ran the loader bare, without
its binding, which only resolution primes, and the delivery afterwards read
the `cache()`. On a HIT the page rendered the loader's fresh run while its
segment carried the cached value, two values on one page, and the loader ran
once more than on a plain navigation. Pinned by
`src/testing/__tests__/prefetch-false.rsc-test.tsx` ("with its own cache()").

Two reads are not redirected. A stale refresh's executor
(`_runLoaderIsolated`) reads each loader fresh by design and never starts a
registration. And once a `cache()` binding of the loader has started, under
any registration, a read that reaches the executor is that binding's own MISS
execution: starting the registration there would hand the binding its own
pending value.

This only catches handlers resolution awaits. A handler under `loading()` is
streamed, so it may reach `ctx.use()` after the check; that loader then starts
in the prefetch, through its registration, and is resolved again by the fill.
Data is never missing, only fetched twice, unless its own `cache()` serves the
fill.

The run a reader starts files the loader's handle pushes under the segment
that registers the loader, as a navigation's run does: the loader executor
and a `cache()` HIT's replay (`executeLoaderData`) ask `loaderOwner`, which
answers with the registration's segment before falling back to the segment
being resolved. Without it, a layout loader that a route handler started
pushed into the route's bucket, and a later navigation to a sibling route
under the same layout dropped the push.

### `cache()`, `ppr` and `Prerender`

Stored routes need no special path. A `cache()` HIT, a `ppr` partial replay
and a prerender store hit all resolve their loaders through
`resolveLoadersOnlyWithRevalidation`, which is
`resolveOwnerLoaders` in a loop, so the same check defers them. A
`ppr` prefetch that defers live loaders still schedules its navigation capture
as before; the capture is a document render on a derived context and never
sees the plan.

One case does need care. A flagged layout above a `cache()` boundary is not
stored, so it can be a unit, and a unit skips everything below it, the cached
part included. When this request defers such a layout (a flagged, unstored
chain entry the client does not hold), its plan's `record` has `read` and
`write` false: `withCacheLookup` does not read the route cache and
`withCacheStore` does not write it. Reading would restore the record's handle
pushes for segments the response does not carry, and a write could only ever
store an incomplete record.

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

| Placeholder                    | `type`                              | `component` | `loading`              | `loaderData` |
| ------------------------------ | ----------------------------------- | ----------- | ---------------------- | ------------ |
| A deferred loader              | `"loader"`                          | `null`      | (none)                 | absent       |
| A handler unit                 | `"layout"`, `"route"`, `"parallel"` | `null`      | the fallback           | (none)       |
| An entry or slot a unit covers | `"layout"`, `"route"`, `"parallel"` | `null`      | its own, if it has one | (none)       |

There is no list in `metadata` beside it. The segments are part of the
payload's root model, so the marker is readable the moment the payload root
resolves, which is before the browser builds anything, also when it adopts a
prefetch that is still streaming.

Every placeholder carries what the browser builds its wrapper chain from, as
the segment itself would: `id`, `type`, `namespace`, `loading`, `transition`,
a slot's `slot`, a loader's `loaderId`, `belongsToRoute`, the mount path. A
payload that defers a unit carries one per segment the unit covers and a
complete `matched`. What is not in it is anything a handler or a loader
returns.

That costs bytes where a unit covers more than itself. Router test app,
production, the prefetch response's body and its gzip, before the skeleton
and with it:

| Prefetch of                                          | before         | with the skeleton |
| ---------------------------------------------------- | -------------- | ----------------- |
| `section` (a flagged layout, a route and its loader) | 1102 B / 612 B | 1821 B / 707 B    |
| `vt-below` (the same, `transition()` on the route)   | 1117 B / 626 B | 1814 B / 716 B    |
| `unit` (a flagged route and its loader)              | 1409 B / 659 B | 1409 B / 659 B    |
| `vt-unit`                                            | 1428 B / 667 B | 1428 B / 667 B    |

The fills are unchanged (`section` 2236 B / 856 B, `unit` 1693 B / 771 B).
A route unit already sent both of its segments; a layout unit now sends the
route below it and that route's loader as well.

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
  carries deferred segments gets its defers and its one fill ("The browser"
  below), and the fill is sent `cache: "no-store"`. A prefetch answered from
  the browser's copy is adopted exactly like one answered by the server.

A complete prefetch body had the same exposure while prefetches were sent
with `private, max-age=300`; since #1170 no prefetch carries `Cache-Control`,
so only a route's own header can store one. Nothing here widens it.

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

One sentence carries this whole section: **the navigation that adopts the
prefetch builds the page's tree once and commits it, then waits for its fill
and resolves what that tree is waiting for.** The fill hands React no tree.

That follows a rule the client already kept everywhere else. An update that
hands React a tree (`onUpdate`) belongs to a navigation or an action. Anything
else that changes on a page reaches its readers as React state: the
subscription of the store that received it dispatches the new value into the
reading hook's state with `setState` inside `startTransition` (loader
refreshes from the router store's `loaders` in `use-loader.tsx`, handle data from the event
controller in `browser/react/use-handle.ts`), or it resolves a promise a
boundary is already reading. The fill
used to be the one exception: it rendered a second tree and committed it, and
most of the parity gaps this document used to list came from the differences
between that tree and the first.

How many trees a click hands React, counted in the tests named at the end of
this section:

| Click                                                    | by the click                | by the fill |
| -------------------------------------------------------- | --------------------------- | ----------- |
| Plain click                                              | 1                           | (no fill)   |
| Adopted, with holes (loader, unit, layout, slot, `bare`) | 1                           | 0           |
| Adopted, a unit on a page that commits in a transition   | 1, with the fill's response | 0           |
| A fill answered with a redirect                          | 1                           | 0           |
| A fill whose segments are not the tree's ("Failure")     | 1                           | 1           |
| A fill the client refuses, or that fails                 | 1                           | 1           |

### Adoption

`fetchPartialUpdate` (`src/browser/partial-update.ts`) is where every partial
payload is reconciled and committed. A payload that carries deferred segments
is the page with holes in it. The prefetch sent one placeholder per segment
whose work did not run ("Wire format"), each with what its wrapper chain is
built from, so the tree built from them is the tree a plain click's payload
builds: the same router elements with the same keys around every segment
("No remount"). What is missing is what the boundaries are handed.

`armHoles()` fills that in. Each placeholder gets its own **defer**
(`Defer` in `src/browser/defer.ts`): a promise the browser created, the
function that resolves it, and what the router knows of it (`status`,
`value`, `read`). A defer is never rejected ("Failure"). A deferred loader's
defer becomes its `loaderData`; any other placeholder's becomes its
`component`. To the rest of the client it is a stream that has not arrived
yet, which is something it already knows how to show, and every reader of
the hole waits on the defer's one promise ("How a hole is read" below). This
happens before the reconcile, on the payload's own segment objects. That is
safe because every adoption decodes its own payload (see "Reuse" below). The
result is a `Holes` record: the defers and the `matched` the tree was built
for.

Then the navigation sends the fill request, before it renders anything:
`client.fetchPartial({ fill: true, signal })`, with its own signal ("Abort").
From there the click goes one of two ways.

1. **It commits with the click.** `renderSegments` builds the tree,
   `tx.commit()` records the navigation, and the tree is handed to React. A
   fully prefetched payload still renders with `forceAwait`, so everything
   the prefetch did bring is handed to its boundary as a value;
   `renderSegments` (`src/segment-system.tsx`) skips the awaits that would
   wait on a defer. The commit is urgent ("The click commits on the plain
   click's lane"). Then the same navigation waits for the fill's answer and
   fills the holes (next section). `navigate()` resolves once it has.
2. **It waits for its fill.** A placeholder that is not a loader, on a page
   that commits in a transition, is the one case where the client knows
   before it renders that committing now would be wrong. That click is a
   navigation whose response is the prefetch plus the fill ("A unit under
   `transition()` waits for its fill"). Nothing reads its defers.

The reconcile needs no special case. A payload that defers is adopted only on
the page that prefetched it, with the segments that page held when it did
(R15), so a deferred id is always new to the page: there is no copy of the
segment to keep, and none to hide.

That is scar tissue. The prefetch cache used to hand such a payload to any
page, and the browser tried to make that safe: the reconcile ran without the
page's copies of the deferred ids, and a unit the page already showed had its
hole resolved at once. It could not be made safe. A prefetch
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

### The navigation fills the holes

`fillHoles(holes, answer, signal, url, gatedOff)` is the routine. It takes
the holes, the answer (the promise of a partial payload plus the end of its
stream, which is what `client.fetchPartial` returns) and the navigation's
signal. Nothing inside it asks where the tree or the answer came from: an
in-group `clientUrls()` click fills the canonical tree it commits after its
optimistic one with the same routine ("`clientUrls()` routes").

The navigation calls it after `tx.commit()` and after it has handed React the
tree. The request left before the render, so it can answer first: its answer
then waits, unread, until the navigation gets there. Sequencing inside the
navigation is all the ordering there is: no answer is read before the tree it
fills is committed, and the routine never waits for React.

It drops an answer that arrives after the navigation's signal was aborted
("Abort"). Then it checks that the entry on screen still holds this tree's
placeholders (`entryToFill`). By object identity, not by history key: a
shallow navigation that copied the entry to a new key is still filled, and an
action refetch that already rendered the missing segments (its request listed
them as not held) is not overwritten.

From there, in this order:

1. It reconciles the answer against the entry with the `"stale-revalidation"`
   actor and checks that nothing its `matched` names is missing. Nothing is
   handed over before that. An answer the client then refuses used to leave
   its `matched`, its location state and its handle data behind, under the
   error that replaced the page.
2. It writes the location state the answer's handlers set ("What a fill
   writes" below).
3. It finds, for every placeholder, the answer's segment with the same id and
   type, and checks that `matched` is the one the tree was built for. If not,
   the answer is not for this tree: see "Failure".
4. It hands the answer's handle stream to the handle store.
5. It resolves every defer, in one task, with the value of its segment: a
   loader's `loaderData`, any other segment's `component` ("When the holes
   resolve").
6. It rewrites the entry and the store's segment ids.

The entry is rewritten **in place**: the answer's segments are spliced into
the array the history cache already holds for the entry, and
`store.setSegmentIds()` is called. It does not go through
`cacheSegmentsForHistory`. The fill belongs to the visit that built the tree,
and re-caching would do two wrong things: advance the store's navigation
instance, which disowns the tree's still-open handle stream, and reset the
entry's stale flag.

What goes into the entry is what the answer sent, loader streams included,
not the defers. A defer is for the tree that is on screen. The next render
from this page (a click that keeps the layout, an action) builds on the
entry, and finds the segment's own node or stream where each hole stood: the
same thing a plain click's entry holds, in the place React already has it
("How a hole is read" says why no router component may stand there).

That rule reaches one line outside the fill, and it is scar tissue of this
design. The first render from a filled entry is the first time anything
aggregates the answer's loader streams, because the tree on screen read the
defers. A slot reads its loaders through one aggregate promise
(`getMemoizedLoaderPromise` in `src/segment-loader-promise.ts`), and a fresh
aggregate over streams that have all arrived is still a promise React has not
read. Moving between two pages that keep the slot then replaced the slot,
which was on screen, with its fallback: seven browser cases failed with
`content on screen was detached or hidden: pf-slot-side`. So an aggregate
whose sources are all promises that have fulfilled (React's `status` on the
thenable, which Flight sets itself) is known on its first call and is
returned as the array, never as a promise. A plain value is not a stream,
whatever fields it carries: `renderRoute` seeds loader values as they are,
and `{ status: "fulfilled", total: 10 }` is data. `src/__tests__/segment-loader-promise.test.ts` pins it
("returns the array at once when every source is a stream that has
fulfilled").

When is that decided? Only while a tree is built. `getMemoizedLoaderPromise`
is called from `renderSegments` (`src/segment-system.tsx`, a segment's own
loaders and a slot's), which the browser runs before it hands the tree to
React, never from a component's render. A slot's boundary is handed the
result through the slot segment's `loaderDataPromise`, which
`renderSegments` writes and `renderSlotContent` (`src/client.tsx`) reads.
The fill writes no field of a segment the tree on screen reads: it resolves
defers (the router's own objects, which the segments keep pointing to) and
rewrites the entry's array. One write predates this feature
and is left alone: a navigation that keeps a slot reuses the slot's segment
object from the entry (the reconciler returns a segment the server did not
re-send as it is), so its `renderSegments` writes `loaderDataPromise` on an
object the tree on screen reads, until React commits the new tree. One
boundary can be handed the promise in one tree and the array in a later one
for the same streams: that is the held-boundary rule (#1080), a value that
has become known is handed over as the value.

#### What a fill writes

Everything a fill brings beside the segments has a store, so none of it needs
a tree update to reach its readers. The writes come from the navigation
bridge (`PartialUpdateConfig.fill`, supplied in
`src/browser/navigation-bridge.ts`), the ones its own updates make: by the
time the fill answers, the transaction has committed the entry and React has
the tree, and the fill hands React no update to carry them.

| What the answer carries       | Where it goes                                                                                                       | Who reads it                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `handles` (the handle stream) | `fill.handles(metadata)`: `consumeHandles` in `NavigationProvider.tsx`, the function the provider's own updates use | `useHandle` (`eventController.subscribeToHandles`)                               |
| `locationState`               | `fill.locationState(state)`: `eventController.commitLocationState(merged, true)`, then `flushRouteState()`          | `useLocationState` (the provider takes the snapshot with the state notification) |
| `matched`                     | `store.setSegmentIds()`, and the tree's own `matched` array when it changes ("Failure")                             | later requests' `_rsc_segments`                                                  |
| `segments`                    | the defers, and the entry in the history cache                                                                      | the tree on screen; the next render                                              |
| `redirect`                    | `fill.redirect(url, state)`: a replace navigation                                                                   | the bridge                                                                       |

`consumeHandles` reads the stream with the `matched`, `isPartial` and
`resolvedIds` of the answer and the history key at the time of the call,
exactly as an update's metadata is read. The fill's `matched` is the tree's
(step 3 checked it), so a late yield from the tree's own handle stream cannot
drop the buckets the fill pushed below a unit: both streams name the same
segments. That used to need the fill to rewrite the click payload's `matched`
array in place, because a deferred unit's `matched` stopped at the unit. The
skeleton made it complete.

The remaining fields of a payload's metadata have nothing new in a fill. The
provider's subscriber reads `params`, `handles`, `matched`, `isPartial`,
`resolvedIds` and `cachedHandleData` off an update
(`NavigationProvider.tsx`), and a fill is for the URL the click committed:
its `params` and `routeName` are the click's. So there is no field that
reaches its readers only as a prop of a tree update.

Without the bridge's writes (a client built with no `fill` config) a redirect
is a document navigation and the rest is dropped.

### When the holes resolve

All at once, when the fill answers. Each defer resolves with its own
segment's stream or node and follows it: a loader whose data is still
streaming resolves its defer with that stream, and the boundary that reads
it keeps waiting for the stream, as it would on a plain click. Nothing waits
for another stream, for the end of the response, or for React to commit the
tree. What shows meanwhile, and when React reveals it, is React's: the
nearest boundary of each read, and React's own timing below.

Four things React 19.3 does decide what that timing is (`react-dom-client`,
read in the production build):

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

What R-throttle does to an adopted click is the one thing to keep in mind
here. A plain click shows its fallback when its response starts, so React
reveals nothing sooner than 300 ms after that. An adopted click shows its
fallback with the click, a round trip earlier, so React reveals a deferred
unit as soon as its data lands, before a nested read that the plain click's
one reveal includes. That read then shows a fallback of its own, which the
plain click never shows, and R-throttle holds its content 300 ms from then.
The page is up sooner and the late read is React's to reveal: that is the
bar, not a gap. Nothing in the client lines the two reveals up, and nothing
should; the client did once, with React's 300 ms copied into it, and that
code is gone (R-throttle is React's number, and a copy of it goes stale the
day React changes it).

Production, router app, the server 300 ms away, adopted against plain, in
ms (the full production run):

| click    | first fallback | the page's first content       | late read, its own fallback | complete    |
| -------- | -------------- | ------------------------------ | --------------------------- | ----------- |
| `inner`  | 4 and 315      | 408 and 614 (`pf-inner-early`) | 711 and 614, at 408         | 711 and 614 |
| `nested` | 3 and 314      | 3 and 314 (the page)           | 715 and 614, at 413         | 715 and 614 |

`nested`'s early read shows at 413 against 614. The Cloudflare app reads the
same within 10 ms.

The parity cases hold what shows after the page's first content to React's
rule, not to the plain click's completion: a value is on time when it shows
no later than the plain click shows it, or than 300 ms after the last time a
fallback showed or hid on the adopted click (`reactHold` in the shared
suite), with the margin. A value held past both is a wait the router added,
and fails ("The parity cases").

#### A layout unit shows its skeleton with the click

A flagged `loading()` on a layout, entered from a page that does not hold the
layout, defers the layout's handler with everything below it (R2), so the
adopted click shows the layout's skeleton over the layout's whole area. A
plain click in a production build shows the layout with its response's first
chunk and the fallback inside the layout's outlet (#1080 hands a handler that
has returned to its boundary as the node). That is the one place where the
page a prefetched click shows differs from a plain click's, and it is the
maintainer's call: the skeleton with the click, rather than the page being
left until the fill's first chunk (holding the click was rejected), and the
layout's handler stays out of the prefetch (running it there was rejected).

The layout's defer resolves with the rest, when the fill answers, and
React reveals the layout no sooner than its 300 ms after the skeleton. What
shows inside it then depends on where the app reads:

- A read in an app `<Suspense>` (fixture `section-read`): the layout shows
  with the page and that fallback in it, as on a plain click.
- A read with no boundary of its own (`section`, `outer`): React suspends it
  to the layout's outlet, whose fallback is the layout's own `loading()`. The
  skeleton shows a second time, inside the layout, as a plain click shows it
  there with its first chunk. No router code decides this: it is React's
  nearest boundary.
- A `loading()` of its own below the layout (`section-own`), or an app
  `<Suspense>` around a slow read (`section-suspense`): its own fallback,
  inside the layout.

A fallback that shows inside the layout is a fallback React keeps up 300 ms
from then, and R-throttle is page-wide: it holds every reveal on the page as
long, inside the layout or not. So content whose data lands between the
layout's reveal and 300 ms later shows no sooner than the layout plus 300 ms,
where a plain click, whose fallbacks all went up with its first chunk, shows
it when it lands.

The parity cases of these clicks (`layoutSkeleton` in the shared suite)
assert the expectation instead of the plain click's layout time:

- the skeleton is the click's first change and shows within the parity
  margin of the click;
- the layout shows no sooner than 280 ms after the skeleton (React's 300,
  with sampling to spare), and no later than the plain click shows the
  covered part, or React's 300 ms after the skeleton when that is later,
  with the margin;
- in the layout's frame it shows with the covered part, or with its own
  fallback inside it, and only then may that fallback mount a second time
  (`skeletonInsideLayout`);
- a fallback inside the layout (`innerFallback`: the child's `loading()`,
  the app's `<Suspense>`) shows on the plain click too, in the frame the
  layout or its page shows;
- what showed inside the layout in its frame is held by the layout's bound
  (`watchPage` records which elements first showed inside the layout); what
  shows later is compared with the plain click's time, or with React's
  300 ms after the last fallback that showed or hid when that is later (the
  layout's reveal is such a change, as in every parity case);
- every other rule is asserted as in any parity case, nothing else mounted
  twice and React's log included.

The skeleton, and a fallback inside the layout, are the fallbacks the adopted
click may show that the plain click does not (a development server's plain
click can still be on the layout's fallback when the adopted click shows the
layout).

#### Where React holds the tree

A deferred loader read with no boundary (R11) makes React hold the click's
commit on that defer. The navigation hands React the tree and goes on to
wait for the fill without waiting for React, so the page React holds shows as
soon as the fill answers. Two pages are why nothing a defer waits for may
wait for React's commit, a unit's own defer included:

- `bare-inner`: a read with no boundary, in a response that stays open behind
  it (a slower flagged loader behind its own `<Suspense>`).
- `above`: a unit whose loader is read above the unit's fallback, by a layout
  that calls `useLoader()` on its route's loader. React holds the click on
  the loader's defer. When the unit's own resolved one commit later, the
  commit that ended the hold showed the unit's fallback for React's 300 ms,
  where a plain click showed the page. Before that the page did not show at
  all: the loader's defer waited for a tree of the fill's, that tree
  waited for the click's commit, and the commit was waiting for the
  defer.

`expectNoBoundaryHoldsThePageLeftUntilTheFillReturns` pins both pages in a
browser, and `src/testing/__tests__/navigation-adoption-loading.test.tsx`
through the real provider and updater.

#### In one task

A unit's content renders the holes below it: a layout's outlet, a slot, a
loader the route reads. When the unit's defer resolves, React retries its
boundary and reads those holes in that render. A hole resolved by then with a
node costs the retry nothing where a router reader reads it (the read rule,
next section); one resolved with a stream, or read by React itself, costs it
one microtask (R-sync, second half). A hole that resolves a task later is a
second suspension: the inner boundary shows its fallback, or, where the inner
fallback is the same element as the outer one (a parallel slot reads its
loaders above its content, behind the same skeleton), the skeleton mounts a
second time and R-throttle starts over (measured on `slot`: content 99 to 250
ms late). The old design needed a rule
per ownership for this ("the loaders a unit owns resolve with the unit"). One
`forEach` over the defers replaces it.

#### How a hole is read

Every reader of a hole reads its defer, and when it waits, it waits on the
defer's one promise: two `useLoader()` calls of the same deferred loader
suspend on the same `defer.promise`. Which reader that is depends on where
the hole sits:

| Where the hole is                                        | Who reads it                                                     | How                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| A deferred loader                                        | `useLoader` (`src/use-loader.tsx`)                               | `readDefer`                                                     |
| A placeholder with `loading()` (a unit, a slot with one) | `Suspender` (`src/route-content-wrapper.tsx`)                    | `readDefer`                                                     |
| A placeholder with no `loading()`, a slot with none      | React itself, as a child (`renderSegments`, `renderSlotContent`) | `asStream`: the promise while pending, the value once fulfilled |
| A slot's loader aggregate, the pending-stream registry   | `buildLoaderPromise`, `announcePendingStreams`                   | `asStream`                                                      |

`readDefer` (`src/browser/defer.ts`) is the read rule:

- A hole that has fulfilled, and whose promise no reader has handed React
  (`read` is unset), is its value: no suspension. A `use()` of a promise
  React has never seen suspends an urgent render once (R-sync), and the
  boundary shows its fallback even though the value is in hand.
- Otherwise the reader sets `read` and calls `use(defer.promise)`. A promise
  React has waited on, React marks itself, so once the hole has resolved the
  read returns at once. It has to be the same promise every time: React
  replays a reader that suspended with the thenables it read the first time,
  and a replay that switched to the value logs "A component was suspended by
  an uncached promise".
- Either path calls `use()` once (`SETTLED_THENABLE` on the value path), as
  every `useLoader` read with route context does: a reader that suspended in
  `use()` on mount and then finished without it logs "This library called
  use() to suspend in a previous render but did not call use() when it
  finished".

The router writes `status`, `value` and `read` on the defer, its own object,
and never React's thenable fields on the promise. `status` turns `fulfilled`
when the router resolves the hole with a value it holds (a node). Resolved
with a stream (a loader's Flight chunk), the promise follows the stream, and
so does the defer: `status` turns `fulfilled`, with the stream's value, once
the stream arrives. Readers mounted before that wait on the promise, which
React then marks. A reader that mounts after it (a tab the user opens with a
plain `setState` once the fill landed) reads the value, as it reads the chunk
Flight marked on a plain click. Before the defer followed its stream, that
reader called `use()` of a promise React had never seen, and the urgent
render showed the boundary's fallback over the page (R-sync). A stream that
rejects leaves the defer pending; its promise carries the rejection.

Why does React read a hole with no `loading()` itself, and not a small router
component? The filled entry hands the next render from this page the
segment's own node in that place. A router component around the hole would
be a fiber that node does not have, and React would remount the segment
there, a layout with everything under it, on the next navigation that keeps
it. React reads a promise child in place: it suspends the component above
it, which commits nothing until the hole fulfils, so a fulfilled hole can be
handed there as its value whether or not React read the promise before.
Where a segment has `loading()`, `Suspender` stands in that place in every
render already, so it reads the defer.

`src/__tests__/browser-defer.test.tsx` pins the rule against real React,
each case red without its part of it: one promise for every reader of a
deferred loader; a fulfilled hole never read renders with no fallback, as a
route's content and as a `useLoader()` read (red when the read always calls
`use(defer.promise)`); a hole a reader suspended on reads at once after it
resolves with no `use()` warning (red when such a read switches to the value
with no `use()`: "This library called use() to suspend..."); and a
time-sliced reader that suspended and is replayed hands `use()`
the same promise (red without `read`: "A component was suspended by an
uncached promise"); and a defer resolved with a stream takes the stream's
status and value. `src/testing/__tests__/navigation-adoption-loading.test.tsx`
("a useLoader() reader mounted after the fill arrived") pins the late reader
through the real updater against the plain click: red while the defer stayed
`pending` (the fallback over the page, `'pageskeleton'`).

### The click commits on the plain click's lane

A click that commits from a prefetch whose payload is whole commits in a
transition (`commitInTransition`, the content-hold branch): everything is
there, so React can hold the old page for the instant the new one needs. A
page with holes is not whole, and a plain click to it commits urgently and
shows fallbacks. So a click with holes commits urgently too.

It did not at first, and that was a parity gap of its own (`OPEN_QUEUED`, ten
cells). R-start: with a `<ViewTransition>` mounted on the page being left
(the router's own on a `transition()` page, or one of the app's) React
started a view transition for the adopted click's commit that the plain click
does not start. R-wait: the reveal of what was deferred then queued behind
it. That is free while a view transition is shorter than the 300 ms React
keeps a fallback up, and late by the rest of it otherwise. Production, plain
against adopted, view transitions and the page complete, at the browser's
default duration and with `animation-duration: 600ms` on the view-transition
pseudo-elements (`&vtms=600`), before and now:

| click                           | before: transitions | default        | 600 ms          | now: transitions | default        | 600 ms         |
| ------------------------------- | ------------------- | -------------- | --------------- | ---------------- | -------------- | -------------- |
| `vt` to `unit`                  | 0 and 1             | 309 and 308 ms | 307 and 641 ms  | 0 and 0          | 306 and 303 ms | 305 and 303 ms |
| `vt` to `section`               | 0 and 1             | 309 and 314 ms | 306 and 655 ms  | 0 and 0          | 307 and 303 ms | 306 and 303 ms |
| `vt` to `loader`                | 0 and 1             | 307 and 311 ms | 308 and 625 ms  | 0 and 0          | 306 and 303 ms | 305 and 303 ms |
| hub with a boundary to `unit`   | 1 and 2             | 311 and 349 ms | 319 and 664 ms  | 1 and 1          | 320 and 313 ms | 320 and 312 ms |
| hub with a boundary to `loader` | 2 and 3             | 328 and 614 ms | 666 and 1313 ms | 2 and 2          | 322 and 312 ms | 655 and 674 ms |

"Before" is `bfacee1f`, "now" the medians of three production runs of the
router app. `vt` to `section` is at parity on these columns; its layout shows
its skeleton with the click, by design ("A layout unit shows its skeleton
with the click"). The `loader` rows once failed the animated-changes count (plain 1, adopted 2) in 3 of 12
runs: both clicks start a view transition for the handle push right after
their first commit, and the adopted click's commit and that call landed in
the same millisecond, which the count read as an animated change. It now
counts only changes after the call (`animatedChanges` in the shared suite):
`startViewTransition` updates the page a frame later at the earliest. Green
three runs of three in both apps since.

An urgent commit has R-sync's price: a boundary handed a promise React has
not read shows its fallback. Two things pay it. `forceAwait` stays on for a
prefetched payload, so what the prefetch brought is handed over as values and
only the defers are holes, each behind the fallback a plain click shows
there. And a value that is known is never handed to a boundary as a promise
(#1080, `getBoundaryContent` and the aggregate rule above).

### A unit under `transition()` waits for its fill

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
| Behind the unit's hole, resolved once the fill's tree has committed | 4                      | +280 ms                                       |
| In the fill's tree, committed in a transition                       | 3                      | +278 ms (loader 300), +185 (400), +57 (500)   |
| In the fill's tree, committed urgently                              | 3                      | +295 ms (loader 300, development), +192 (400) |
| The page commits with the fill's first chunk, content included      | 2                      | -25 to +3 ms (loaders 100 to 700)             |

The first is R-throttle's second half: the hole's retry suspends again on
the loader that is still streaming, React commits it when the throttle is
up, and under a `<ViewTransition>` that commit is a view transition (R-start)
which the real reveal then waits for (R-wait). The second is R-start and
R-wait on a commit of the fill's own. The third has no commit of the fill's
in a transition lane and still ends with three: the urgent tree brings the
content, the boundary retries, and the retry does what the first row's did.

So the adopted click does what the plain click does, and here the client can
know it before it renders anything. Where a placeholder that is not a loader
sits on a page that commits in a transition (`shouldStartViewTransition` over
the reconciled segments), the click is a navigation that waits for its fill:

- The fill is fetched with the navigation's own signal. Leaving aborts it as
  it aborts any navigation's request.
- Nothing commits with the click. No transaction, no history entry, no tree:
  the address bar, the URL hooks and the page being left all stay, and
  `useNavigation()` reads `loading`, as during a plain click whose response
  has not started.
- With the fill's first chunk the prefetched segments (minus the
  placeholders) and the fill's are reconciled together, and the result goes
  down the ordinary commit path: one `tx.commit`, one tree, one transition.
  No defer is read by anything. The fill's location state rides on the
  commit's `serverState`, and its handle stream is read right after the
  commit, under the entry it made.
- A fill that fails, or answers with a redirect, is the navigation failing or
  being redirected: the error is thrown to the navigation's caller, and a
  redirect goes through the routine a navigation's own answer goes through
  (`redirected()`: a `ServerRedirect` for a target in the app). Nothing of
  the click was committed, so there is nothing to take back.
- An answer that does not make the page with the prefetch (it is not a
  partial payload, or `matched` names a segment neither answer carries: the
  routes changed between the prefetch and the click) starts the navigation
  over with nothing held, as a navigation whose own response misses segments
  does. That request is never answered from a prefetch
  (`src/browser/navigation-client.ts`), so it defers nothing and cannot wait
  again.

The address bar and the hooks used to move with the click here and the page
with the fill, a round trip apart (with the fill's head held a second:
`vt-unit` 12 against 1011 ms). The old mechanism kept the transaction's
commit at the click and handed React a promise nobody resolved in place of
the tree (`Fill.held`). Now the three move together:
`expectUnitUnderTransitionCommitsWithItsFill` holds the fill and reads the
hub's URL, the hub's content and `loading`, and
`expectLeavingAHeldAdoptionAbortsItsFill` checks that a click that is left
while it waits leaves no history entry and runs no deferred work.

Said plainly, because it is the one place the click is not ahead: under
`transition()` a deferred unit's fallback shows with the fill's first chunk,
as a plain click's shows with its response, not at the click.

Whether the page commits in a transition is a fact about the page, and the
click learns it from the segments it has. That used to need help: a prefetch
that deferred a layout stopped the chain there, so a `transition()` on the
route below it was not in the payload, and the server put a stand-in on the
unit's placeholder (`placeholderTransition`). With the whole skeleton in the
payload every placeholder carries its own entry's `transition`, `when`
predicate included, and the stand-in is gone. `vt-below` in the fixture is
that shape (a flagged `loading()` on a layout whose route has
`transition()`).

`transition({ viewTransition: false })` takes the same road. It places no
`<ViewTransition>`, so there is nothing to animate, but the plain click still
commits in a transition, and the app may have a boundary of its own
(`vt-unit-off` and `vt-unit-own` in the fixture).

What it costs is the head start. With the server 100 ms away the click shows
its fallback when the fill starts answering, about 100 ms in, where it could
show it with the click; the plain click shows it about 100 ms in too. It was
not a head start worth having: in exchange for it the content was up to
278 ms late.

A flagged `loader()` under `transition()` is not a unit and is not affected:
its page commits with the click, with the loader's deferred behind whatever
boundary reads it.

Why not the simpler fix, running such a unit in the prefetch after all? It
would be instant on click, and it would spend, on every prefetch, exactly
the work the flag was written to keep out. Waiting for the fill costs
nothing a plain click does not cost.

### A read with no boundary

The other click React holds is one the client cannot see coming. A deferred
loader whose read has no `<Suspense>` and no `loading()` above it suspends
the click's render with nothing to fall back to, and React keeps the page
being left until the defer resolves (R11). Whether a tree does that is not in
the segments: it depends on where the app's components call `useLoader()`.
`bare`, `bare-inner` and `above` in the fixture are such pages.

A plain click to the same page is held the same way, for the same value. What
has to match is what the page being left can observe while it waits:

- **The page**: held until the value arrives, then shown, in both clicks.
- **`useNavigation()`**: `loading` for all of that time, in both. This needs
  one line. The click commits in its own task, before the event controller's
  notification of the click has gone out (its notifier is debounced), so the
  state after the commit used to reach React in the batch React was holding,
  and `useNavigation()` read `idle` on the page being left for the whole
  wait. `PartialUpdateConfig.fill.flush()` (`eventController.flushRouteState`
  in `flushSync`) now delivers the state before the render's awaits, and
  React commits `loading` before the tree's update arrives. It has to be
  synchronous: `useNavigation()` sets its state where the controller's
  notification runs, and at default priority `loading` joined the tree's
  urgent update, which brings `idle` with the new URL (#1164), in the one
  batch React holds, so `loading` never showed (the parity e2e caught it in
  both apps). While React holds that update, the state it carries (`idle`,
  the new location) is held with it.
- **The URL hooks**: `useNavigation().location` moves with the page, in both
  (the `hook` column in "Limits"). Same mechanism: the location it reads is
  controller state, and it arrives in the batch React holds. `usePathname`
  and `useSearchParams` were not measured here.
- **The address bar**: moves when the router commits the navigation, before
  React shows a page it holds, on every navigation: `commit` in
  `src/browser/navigation-transaction.ts` updates the store and the URL
  together, and the tree reaches React after it. A plain click commits with
  its response, so its address bar leads a page React holds by the loader's
  time. `prefetch: false` moves that commit to the click, so the adopted
  click's address bar leads by the fill's round trip more. The page itself
  is not later for it, and under the bar the URL changing at the click is
  feedback at the click: the parity cases do not compare the address bar
  (the maintainer's call, 2026-10-11; "Limits").

A page whose every deferred read has a boundary is not held and shows with
the click: a reader behind its own `<Suspense>` on a route with no
`loading()` shows that fallback at once, exactly as the first row of the
table in "The model in one paragraph" says. `loading` is delivered there too,
one commit before the page, and the page follows at once (measured in
development on `unit`: the fallback, the address bar and the hook 7 ms after
the click). `own` in the fixture is that route, and
`expectOwnBoundaryWithNoLoadingShowsWithTheClick` holds its fill back and
finds the page, the read's fallback, the address bar and the hook all moved,
with `useNavigation()` on `idle` and streaming.

Why not move the address bar with the page as well, for these clicks or for
any navigation React holds? Three ways were looked at and none was built,
because each breaks something a page with a boundary relies on (reasoned
from the code, not measured):

- _Commit the transaction when React commits the tree._ The first render of
  the new page would then run before the URL, the history entry and the
  hooks' state had moved: components that read `window.location` or a URL
  hook while rendering, or in a layout effect, would read the old page. That
  is every adopted click, to fix the ones React holds.
- _Push the entry at the click and put the old URL back while React holds._
  `history.replaceState` during the hold leaves the wrong URL in the forward
  entry when the visitor goes back while waiting, and a navigation started
  during the hold reads `window.location.href` as the page it is leaving.
- _Render the tree once to find out, then decide._ A probe render that
  suspends is not something React exposes; it would be the router guessing at
  React's work loop.

So the hold is detected by the only thing that knows, React, and what the
client can move with React's commit (the hooks) moves with it.

`src/testing/__tests__/navigation-adoption-loading.test.tsx` pins the state
through the real provider: `loading` until React commits the tree, no longer
than the commit where a fallback can show, and the control where the state is
not delivered first reads `idle` all the while.
`expectPendingFillReadsLikeAStreamingNavigation` pins it in the browser, on a
unit and on a read with no boundary.

### What the page reads while a fill is pending

What a page can observe, each checked against a plain navigation whose
loader is still streaming:

- **`useNavigation()`** reads what it reads on a plain navigation that is
  still streaming: `state: "loading"` until React commits the click's tree,
  then `"idle"` with `isStreaming: true` until the fill has streamed (the
  click's streaming token stays open until then). Where a fallback can show,
  that commit is immediate. Where nothing can show one, React holds the
  commit until the fill answers ("A read with no boundary"). A deferred unit
  under `transition()` reads `loading` until its fill starts answering,
  because the navigation has not committed.
- **The URL and the URL hooks** move with the page. The address bar does too,
  except where React holds a click for a read with no boundary: there it
  moves when the router commits, at the click, as it moves before a held
  page on any navigation ("A read with no boundary"). The parity check
  measures the URL hook (how far `useNavigation().location` on the page
  being left is ahead of the page, against the same for the plain click,
  with a 50 ms margin), not the address bar.
- **View transitions.** A fill starts none: it hands React nothing, and a
  defer that resolves is a Suspense retry, which is what reveals a plain
  click's content too. On a route with `transition()` the browser gets two
  `document.startViewTransition` calls, the commit and the reveal, with or
  without the prefetch, for a flagged loader and for a flagged `loading()`,
  whatever the loader takes. The parity check allows the adopted click no
  call the plain click does not make.
- **Handle data.** A push from a handler the prefetch ran travels in the
  prefetched payload's handle stream, so it is on screen with the click's
  commit: breadcrumbs and titles from the part that was not deferred do not
  wait for the fill. A deferred handler's push arrives with the fill, through
  the handle store.
- **Scroll.** Scroll belongs to the navigation transaction: `tx.commit()`
  decides it, the click's update carries the decision, and
  `NavigationProvider` holds that one pending action (`pendingScrollRef`)
  until the React commit that follows. A fill hands React no update, so it
  cannot touch it. (The one update a fill can make, for an answer that is not
  the tree's, carries no scroll decision: "Failure".)

  The provider's rule stands on its own, because a fill was never the only
  update with no decision: an update that carries a transaction's decision
  sets the pending action, the commit that follows consumes it once, and an
  update with no decision (a server action, an error update) neither sets nor
  clears it. Scar tissue: the fill used to send `scroll: { enabled: false }`
  and the provider used to assign on every update, so a fill that reached the
  provider before React had committed the click cost the navigation its
  scroll (7 clicks out of 8 on a fresh page). `commit()` returns its decision
  in the shape the update carries it (`CommitResult` in
  `src/browser/navigation-transaction.ts`): a navigation always decides, and
  a commit that is not a navigation (an action's store-only refetch, a
  cache-only commit) returns none.
  `src/testing/__tests__/navigation-scroll-slot.test.tsx` pins all four sides
  through the real provider.

### No remount (R6)

The fill replaces nothing. For that the tree the click builds has to be the
tree the filled page would build, element for element, and three things make
it so:

- **The skeleton.** The prefetch sends a placeholder for every segment the
  deferred work covers, with the fields the wrapper chain is built from: id,
  type, namespace, the `loading` fallback, `transition`, a slot's name, a
  loader's id, `belongsToRoute`, the mount path. `renderSegments` wraps a
  segment's content in `StreamedLoaderErrorBoundary` only when the segment
  has loaders and takes the per-loader streams lane only then, so the loader
  placeholders matter as much as the unit's.
- **A slot with no `loading()`.** A slot's chain is built where the layout
  renders it (`renderSlotContent` in `src/client.tsx`), and it wraps a slot
  that streams with no `loading()` in a boundary of its own, by looking at
  whether the slot's `component` is a promise. A deferred slot's hole is
  pending too, but the slot it stands for was awaited: a navigation renders
  its content with no boundary around it. So a deferred slot gets none, and
  its hole stands where the content will, read by React itself (`asStream`:
  the defer's promise, or its value once fulfilled, never a router component
  the filled page would not have there). This is the one place the tree
  depends on a value and not on the skeleton.
  `src/__tests__/parallel-outlet-deferred.test.tsx` pins it.
- **Values as values.** What the prefetch did bring is awaited before the
  tree is built (`forceAwait`), and what is known is handed over as the value.

`src/__tests__/segment-system.test.tsx` ("builds a plain click's wrapper
chain from the skeleton") builds a page with a flagged layout, two slots, a
route with `loading()` and `transition()`, an orphan layout and a loader at
each level, once from placeholders with defers and once from a plain click's
segments, and compares every router element in tree order: its type, its key,
its segment and the slots it carries. In the browser,
`expectAdoptedClickBuildsThePageOnce` watches fourteen clicks from the click
to the completed page and fails if any `pf-*` test id showed as more than one
DOM node (a fallback or a layout mounted a second time), if the layout the
page keeps was detached or hidden, or if the page was blank.

What can still make the filled page differ from the skeleton is in "Failure".

### History

The click's entry is stored with its placeholders, flagged `deferred`. The
fill rewrites it in place with the filled segments (above), and back/forward
to it is then an ordinary cache restore.

An entry that history has marked stale since (an action ran, or
`invalidateClientCache()`) is shown at once and revalidated after it, as
any stale entry is: one `_rsc_stale` request, not a prefetch and not a fill,
and the revalidated tree committed in a transition (mode
`"stale-revalidation"` goes to `commitInTransition`, as on main), so no
fallback shows. The rewrite in place keeps the entry's stale flag for that.
`expectStaleFilledEntryShowsAtOnceThenRevalidates` pins it in both apps and
modes, and `src/__tests__/partial-update.test.ts` pins the lane. A
back/forward with no entry is a fetch, unchanged.

If the user leaves first, the fill is cancelled and the entry keeps its
placeholders. Both readers of the history cache treat such an entry as a miss:
`handlePopstate` falls through to the fetch path, and `navigate()` does not
offer it as `targetCacheSegments` (`hasUsableCache` in
`src/browser/navigation-bridge.ts`). The other way round holds too: while
the page on screen waits for its fill, `navigate()` never copies one of its
placeholders over the target entry's segment of the same id (it copies the
page's other shared segments, which are fresher), so the target keeps its
cache hit. So returning to the entry fetches what
is missing; it never restores a tree suspended on a defer nobody will
resolve.

A click that waits for its fill ("A unit under `transition()`") has no entry
until the fill answers. Left before that, it leaves nothing behind.

A defer is resolved by its fill or never settled at all. Resolving an
abandoned one with nothing would show up in a tree that may still be mounted
for a moment, and a defer is never rejected (see "Failure"). It is only
released: `store.loaders.releasePendingStream()` removes it from the
pending streams, so `useLoader().isLoading` and the streaming indicators do
not wait on it forever.

### Abort

The fill belongs to the navigation that adopted the prefetch, and that
navigation's signal is the one thing that cancels it. It is the signal the
transaction's handle carries (`tx.handle.signal` in
`src/browser/navigation-bridge.ts`), which the apply path receives beside
`tx`, and the fill request is sent with it. Nothing else tracks a pending
fill.

The event controller aborts that signal when a newer navigation starts
(`startNavigation`) or a back/forward does (`abortNavigation`, called first
in `handlePopstate`), as it always did for a navigation that has not
committed. A committed navigation used to drop out of its reach at
`complete()`, and the fill is work a navigation does after its commit, so the
controller now keeps the navigation that committed last abortable while its
stream is open: `complete()` records it when a streaming token is still out,
and the token's `end()` forgets it (`streamingNavigation` in
`src/browser/event-controller.ts`). A navigation whose stream has ended is
left alone. This holds for every navigation, fill or not, and it cancels no
response that has arrived (below and R9): what the abort stops is the
navigation reading it.

A page restored from the back/forward cache is not left. `handlePageShow`
(`src/browser/navigation-bridge.ts`) resets a navigation that had not
committed, as on main, and leaves the committed one alone
(`abortNavigation(true)`), so a fill in flight keeps its signal. If the
browser dropped the request while the page was frozen, the fill fails as a
navigation does and the network error boundary shows ("Failure"). Aborted
there, the failure would be dropped and the fallbacks left up for good,
whichever of the two the browser delivered first.

What an abort does depends on how far the fill got:

- **Before its response.** The request is cancelled. The navigation client
  links every partial request to its signal only until its response arrives
  (`src/browser/navigation-client.ts`, R9): aborting a Flight body mid-read
  rejects every chunk a mounted tree may be reading, and after the abort that
  tree is still the page until the newer navigation commits. Actions keep the
  same rule (`src/browser/server-action-bridge.ts`).
- **After its response.** The answer is dropped: `fillHoles` checks the
  signal before it reads anything, and the response streams to its end with
  nobody reading it.
- **While a tree of the answer's is built** ("Failure"). Nothing is handed
  over.

Either way the defers are released and the entry keeps its placeholders
("History"). The navigation then returns, and `navigate()` resolves.

What does not cancel the fill: a commit that is not a navigation's (an
action's store-only refetch, a cache-only commit), which does not start a
navigation; a shallow navigation, which starts none either; an action,
which runs beside navigations; and a page restored from the back/forward
cache (above). After an action the identity check decides.
If the action's refetch replaced the entry's segments the fill finds none of
its placeholders and drops its response; if the entry is untouched the fill
lands. An action that refetches through a navigation transaction of its own
(`refetchRoute` in `src/browser/server-action-bridge.ts`) does start one, and
cancels the fill: its request lists the placeholders as not held, so its
response renders what they stand for. A refetch that waits for a navigation
the user started (`refetchShown`) starts only once that navigation's
transaction has ended, after its own fill.

A navigation that starts cancels the fill at once, not when it commits. That
is the trade the signal makes. A navigation that starts and then ends without
replacing the page leaves the fallbacks up with nobody to fill them: one
answered with a redirect the client refuses, or an action refetch that drops
its response because segments are missing. Every other ending replaces the
page: a commit, an error boundary, a document navigation.

A click that is aborted before `tx.commit()` cancels its fill with the same
signal. One that fails before it (its render throws) leaves the request
running, and nothing reads its answer.

While a fill is in flight the click's streaming token stays open, so
`useNavigation().isStreaming` is true until the deferred work has streamed in,
and idle-time prefetching waits for it. A navigation that is left ends its
token at the abort, as every navigation does (R9).

### Failure

A fill hands React a tree in two cases, and both are the outcome of the
navigation: the page the visitor gets is not the page the tree was built for.

**The answer's segments are not the tree's.** The skeleton is exact for
everything static, and everything that shapes the tree below a unit is static
per match except the ways deferred work can fail:

- A handler the fill awaits (one with no `loading()` of its own) throws: its
  entry's segments are replaced by one `error` segment with the entry's id
  (`catchSegmentError` in `src/router/segment-resolution/helpers.ts`), and
  its loaders and slots are not in the answer.
- The same handler calls `notFound()`: one `notFound` segment, the same way.
- A handler returns or throws a `Response`: resolution rethrows it
  (`resolveWithErrorBoundary`), so the request is answered with that
  response and not with segments. The fill then ends as a redirect or as a
  response the client cannot use, below. Read from the code: no fixture has
  one.

`fillHoles` sees the first two as a placeholder with no segment of its id
and type in the answer, or a `matched` that differs. It then renders the
answer's segments as a navigation would and hands React that tree, once, with
the answer's metadata (so the provider reads its handle stream). Each place
a hole stood is handed its defer again, resolved with what the answer put
there (the `error` or `notFound` segment's node), and its reader applies the
read rule ("How a hole is read"):

- A `Suspender` that suspended on the defer while it mounted calls `use()` of
  the same promise, which React has marked, and reads the node at once.
  Handed the node itself, it would be a component that called `use()` and
  then finished without it at the same place, and React logs in development:
  "This library called use() to suspend in a previous render but did not
  call use() when it finished".
- A defer React never read (the route below a flagged layout: the layout's
  read suspended first) is its value. Handed only a resolved promise, it
  suspends that urgent update at once (R-sync), and the layout's fallback
  shows inside the layout, held React's 300 ms, where the plain click shows
  the error with the layout (`navigation-adoption-loading.test.tsx`, "a
  failed route's error": with the value path removed, "no fallback inside
  the layout: expected 1 to be +0").
- Where the answer's segment has no `loading()` (an `error` segment never
  has one), React reads the node there itself, and the defer is handed as
  its value (`asStream`): nothing below that place committed while the hole
  was pending.

Until 2026-10-11 this ending wrote `status: "fulfilled"` and `value` onto the
hole's promise itself, the client's one write of React's thenable fields. The
defer's own `status` and `read` replace it: the router decides from what it
knows, and React's fields are React's. The other defers, loaders' and those
with no segment of their id in the answer, are released: the tree that read
them is gone. The tree's `matched` array is rewritten in place first, because
the click payload's handle stream reads it on every yield. `section-throws`
and `section-missing` in the fixture are routes below the flagged layout
whose handler fails that way, and `expectDeferredHandlerFailureReplacesItsSegment` checks that the
adopted click ends on the page the plain click ends on: the layout with the
route's boundary inside it, no fallback left, nothing streaming.

Failures that are _content_ do not get here. A handler under `loading()` is
streamed, so its failure arrives inside its segment's `component` and lands
in the boundary React finds for it. A loader's error, `notFound()` or
`redirect()` rides in its `loaderData` and is decoded where the loader is
read (`StreamedLoaderErrorBoundary`), exactly as for a loader that streams
behind `loading()`. Both resolve their defer like any value:
`expectDeferredOutcomeArrivesWithTheFill` covers a loader that throws, one
that calls `notFound()` and one that redirects.

**The fill itself fails.** `fillHoles` hands the error to
`emitNavigationError` (`src/browser/network-error-handler.ts`), the emitter
the navigation bridge uses: the error replaces the page, and the router's
error boundary takes over. That covers:

- a response the client cannot use: undecodable (a 500 with a text body, say),
  not partial, or missing segments;
- a network failure, which the same emitter shows as the network error page;
- a redirect the client refuses to follow: another origin, or an external one
  whose scheme is not http. Returning quietly here left the fallback up for
  good.

The error is shown after the click's commit, because the navigation reads the
fill only then: a fill can fail while the click is still rendering, and an
error shown then would be replaced a moment later by the click's own commit,
whose fallback would wait for a fill that already failed. It is shown only on
a page that still holds this tree's placeholders, the same identity check the
routine makes first: after an action refetch rendered the missing segments, a
late failure of the fill is nobody's problem, and neither is a redirect it
answers with. And it is not shown once the
navigation's signal was aborted: the page is being left ("Abort").

A response is checked before anything of it is written, so a failure that is
in the response itself (missing segments) leaves nothing behind.

How many updates each ending hands React, beside the click's one:

| How the fill ends                                       | Updates by the fill                           |
| ------------------------------------------------------- | --------------------------------------------- |
| It settles the holes                                    | 0                                             |
| An awaited handler threw or called `notFound()`         | 1, the answer's segments                      |
| Refused (undecodable, not partial, missing segments)    | 1, the error                                  |
| Network failure                                         | 1, the network error page                     |
| A redirect the client refuses                           | 1, the error                                  |
| A redirect                                              | 0; the replace navigation it starts makes its |
| The navigation was left, or an action refetch filled it | 0                                             |

For a click that waits for its fill, every one of these is the navigation's
own ending: it throws to the navigation's caller or starts over, and the fill
as such hands over nothing. A handler that failed in that fill is part of the
one tree the click commits.

The defers are never rejected, and this is scar tissue. The first version
rejected them, so that React would throw at each reader into its nearest
error boundary. It worked on screen, and it also raised an uncaught
`Connection closed.` in the page: the tree builds aggregate promises over a
segment's loaders (`getMemoizedLoaderPromise` in
`src/segment-loader-promise.ts`), and nothing handles an aggregate when a
promise inside it rejects. A navigation answered with the same 500 raises
nothing, so the fill now takes the navigation's path. The cost is where the
error shows: at the page's error boundary, not at the one nearest the read.

A redirect for the whole response (middleware, say, because the session
expired between prefetch and click) is not a failure. On a page that still
waits for the fill it is followed as a replace navigation through
`PartialUpdateConfig.fill.redirect`; an external
redirect, or a client built without the hook, is a document navigation.

### Reuse within `prefetchCacheTTL`

A prefetch entry respawns on every adoption (`makeRespawn` in
`prefetch/fetch.ts`), so each adoption decodes its own payload, arms its own
defers and sends its own fill.

A prefetch whose render reported an error (a loader that threw among them)
ends with `PREFETCH_FAILED_ROW` and is evicted when its stream ends, never
adopted after that (#1170): the click sends its own request, as a plain click
would. Deferred loaders never ran in the prefetch, so they report nothing.

An entry that defers lives under its source page's key, which includes the
segments that page held (`buildSourceKey` in `prefetch/cache.ts`). Coming
back to a page the client still has in its history cache is a different
request: it lists that page's segments, so the key does not match and the
click is a plain navigation over the cached copy
(`expectRevisitUsesWhatTheClientHolds`).

### A click before its prefetch has answered

A visitor who clicks fast clicks before the hover's prefetch has answered.
The navigation client reuses that request instead of sending its own
(`consumeInflightPrefetch` in `navigation-client.ts`, a promise that resolves
with the prefetch's response headers), as it did before the flag. When the
answer has holes the click adopts it like any prefetch, and its fill leaves
only then. So the deferred part completes later than a plain click's would,
by up to what was left of the prefetch at the click.

That is the maintainer's call, and one of the two exceptions to "never
worse than a plain click" (the other: "A layout unit shows with everything
it holds"). The flag exists to keep expensive or slow work out of every
prefetch, so that an API that is costly to call is not called for every link
a visitor might click. A click that finds the prefetch in flight waits for
it and then fetches the deferred part; the later deferred part is the price
the app chose for that. The reuse code is unchanged.

The exception is asserted, with a bound, so it cannot grow
(`expectClickDuringThePrefetchStaysWithinItsBound`, `loader`, `unit` and
`bare`, both apps and both modes). Each case records a plain click and a
click 100 ms after its prefetch left, with the server 300 ms away for every
request, the prefetch included: a prefetch delayed on its own would be later
than the plain click's request only because the test made it so.

- The page appears no later than the plain click's, plus a margin. A
  prefetch that left before the click answers before a request sent with
  the click. `bare` has no page before its deferred part (React holds the
  page being left), so only the second bound applies to it.
- The page completes no later than the plain click's, plus what was left of
  the prefetch, plus a margin. What was left is measured on the page's clock:
  from the click to the prefetch's `responseStart` in Resource Timing, the
  moment the reused promise resolves.

The margin is the parity margin, 100 ms, and the measurement says it has
room. Over 60 pairs, 5 per case, mode and app, with what was left of the
prefetch between 45 and 382 ms:

| Measured over the pairs                                        | development     | production      |
| -------------------------------------------------------------- | --------------- | --------------- |
| Page, adopted minus plain (`loader`, `unit`)                   | -337 to -151 ms | -133 to -99 ms  |
| Completed, adopted minus plain minus what was left (all three) | -344 to +36 ms  | -223 to +10 ms  |
| Completed, adopted minus plain (`loader`, `unit`)              | -193 to +152 ms | -26 to +12 ms   |
| `bare` completed, adopted minus plain                          | +85 to +374 ms  | +190 to +214 ms |

The adopted page shows ahead of the plain one by what the prefetch had
already done. In production the deferred part of `loader` and `unit` lands
within a few milliseconds of the plain click's: the plain click's reveal
waits for React's 300 ms fallback minimum, and the fill's wait fits inside
it. In development `loader` lands 58 to 152 ms after the plain click's, at
most 13 ms past what was left. `bare` is the case that pays: with no
boundary the page waits for the fill, so it shows later than the plain
click's by what was left of the prefetch, and never more than 36 ms past
that.

### `clientUrls()` routes

A `clientUrls()` group exists so a click inside it feels instant: the browser
already has every route's component, so it renders the destination at the
click and its loader reads suspend until the server answers
(`packages/rangojs-router/docs/design/client-urls-optimistic-destination.md`).
What the browser does not have is the data, and that is all a prefetch brings
to a group click. So the flag is on `loader()` there:

```tsx
"use client";
export default clientUrls(({ path, loader, loading }) => [
  path("/product/:slug", ProductPage, { name: "product" }, () => [
    loader(PriceLoader),
    loader(ReviewsLoader, { prefetch: false }), // kept out of prefetches
    loading(<ProductSkeleton />),
  ]),
]);
```

**The adopted prefetch is the canonical response, so the click commits it
at once, holes included, and the fill settles that tree.** That is the
server-route mechanism unchanged, with the optimistic swap the group click
already makes in front of it.

The flag reaches the server through the projection. `clientUrls()` records
`prefetch: false` on the route's loader record beside `ssr` (a `layout()`'s
loader is flattened onto every route below it, flag included);
`serializeClientUrlPatterns` (`src/client-urls/server-projection.ts`) writes
the indices of the flagged loaders as `deferrableLoaderIndices`, beside
`awaitedLoaderIndices`; materialization passes `{ prefetch: false }` to the
server `loader()` of each stub. From there the stub is any flagged loader:
`resolveOwnerLoaders` emits it deferred on a segment new to the
client and never calls it. The route segment renders, because its handler is
the cheap `ClientUrlsRoot` element, so the prefetch carries the group segment
with its `clientGroup` key, the unflagged loaders' data and one placeholder
per flagged loader.

The click, from route A to route B of the same group, with B's prefetch
received on A:

| When                      | What happens                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The click                 | The optimistic swap, unchanged (`beginClientUrlNavigation`, `ClientUrlsRoot`): `useOutlet().pending` turns true, B's component renders in a transition lane, every read of B's own loaders (and of layouts it mounts anew) suspends on `PENDING_FOREVER`; a kept layout's loaders keep A's data.                                                                                             |
| A few microtasks later    | `client.fetchPartial` hands back the prefetched payload; `armHoles` gives each placeholder a defer; the fill leaves with the navigation's signal.                                                                                                                                                                                                                                            |
| Same task                 | `renderSegments` builds B's tree: unflagged loaders as values (`forceAwait`), each flagged loader's stream is its defer. `tx.commit()` moves the URL, the history entry and the store, and the tree goes to React in a transition marked `rango-optimistic-commit`: the lane the plain group click's commit takes (the content-hold branch already admits `optimisticPresented` with holes). |
| Right after the hand-over | `mode.presentation.clear()`: `pending` ends with this commit, not with the fill.                                                                                                                                                                                                                                                                                                             |
| The fill answers          | `fillHoles` resolves each defer with the loader's stream and rewrites the entry in place. React retries the boundary that reads it. No tree is handed over.                                                                                                                                                                                                                                  |

The holes live on the canonical tree. The group segment's `OutletProvider`
gets `loaderStreams` from `buildLoaderStreams`, the defer is the stream
for the flagged loader's id, and `ClientUrlsRoot`'s own provider has no
streams once `routeId` is B, so `useLoader(ReviewsLoader)` walks up to the
segment's provider. What a read of the flagged loader suspends on:

| Window                         | Promise                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Click to the commit (the swap) | `PENDING_FOREVER`, memoized per intent (`client-root.tsx`)                                                               |
| The commit to the fill         | the promise of the hole's defer: one per placeholder per adoption, stable for the tree (rule 1 of the Suspense contract) |
| After the fill                 | the fill's own stream for that loader; the history entry holds it, never the defer                                       |

The switch from the first to the second happens inside a boundary that is
already on its fallback (`loading()`'s `<Suspense>` in `ClientUrlsRoot`, or
one in the page), so React keeps the fallback and the transition commits. A
read with no boundary holds the transition on A in both clicks until the
value arrives (R11), and `pending` with it: the clear is a transition of the
same task, so React holds it with the tree.

The click sends exactly one request, the fill: its own navigation request is
answered by the adopted prefetch. The fill lists what the client holds once
B commits and skips every held segment outright (R5), so it renders no
`ClientUrlsRoot`, runs no unflagged loader and sends no client revalidation
decisions; decisions address held loaders, and a fill runs none of them. A
click into the group from a server page makes no optimistic presentation and
takes the server-route path: the urgent commit with the hole, one fill.

**`pending` ends with the commit.** The bridge used to clear the
presentation in its `finally`, after `fetchPartialUpdate` returned, and with
holes that is after `fillHoles`: `useOutlet().pending` stayed true for the
fill's round trip on a page that was committed and idle, longer than the
plain group click, whose `pending` falls with its commit. So
`UpdateMode.navigate` carries the presentation (`presentation?: { clear():
void }`, which replaced `optimisticPresented`), and `fetchPartialUpdate`
clears it right after the tree is handed to React. On a plain click that is
the moment it always cleared. `useNavigation()` reads as on a server route:
`loading` until React commits the tree, then idle with `isStreaming` until
the fill has streamed.

Production, router app, the server 300 ms away, `cu` to `cu/loader` (a
flagged loader read in its own `<Suspense>` beside an unflagged one), plain
against adopted, in ms from the click (medians of three pairs):

| What                         | plain | adopted |
| ---------------------------- | ----- | ------- |
| The URL                      | 309   | 2       |
| The unflagged loader's value | 313   | 3       |
| `useOutlet().pending` ends   | 313   | 3       |
| The flagged loader's value   | 614   | 412     |

Both clicks show the destination at the click (the plain one with the
route's `loading()`, the adopted one with the page and the flagged read's
own fallback).

Two alternatives were rejected:

- _Fill the optimistic tree and hold the canonical commit._ The URL, the
  history entry and the app's hooks would wait for the fill; the swap's
  promises are React state inside `ClientUrlsRoot`, so reaching them from the
  navigation needs a registry it writes and the component reads, a second
  source of truth (AGENTS.md Hard rule 8); and the canonical tree would
  still be handed to React when the fill answers, a second tree per click.
- _`loading(…, { prefetch: false })` in `clientUrls()`._ It would make the
  group segment a handler unit, so the canonical commit would hand React a
  promise in place of the `ClientUrlsRoot` element keyed `cg:<group>`, and
  the destination the visitor is already looking at, with whatever they
  typed into it, would be replaced by the unit's fallback or held. The
  loader flag reaches all of a group route's server work. For the same
  reason a flagged `loading()` on a server layout above a group defers
  nothing for the group's routes: inside the group that layout is held
  anyway (R14), and from outside it would put the group segment behind a
  placeholder.

Interplay, all unchanged from the server-route path: a newer navigation
cancels the fill until its response arrives and then lets it stream to its
end, ignored (R9); an action refetch renders the placeholder it does not
hold, and the fill's identity check drops its answer; scroll is decided by
`tx.commit()` with the canonical commit; the fill's reveal is a Suspense
retry, as the plain click's loader reveal is. An async include of a
`clientUrls()` module goes through the same adapter
(`clientUrlIncludePatterns`), so the projected field rides through.

`intercept()` in a group takes the flag and a server-run `revalidate()` on
its loaders, as a route does: `collectIntercepts` keeps the flag on the
intercept's loader record, and `ClientUrlProjectionIntercept` carries
`deferrableLoaderIndices` and `loaderRevalidate` (the hoisted keys), which
materialization puts on the intercept's stubs (`server-projection.ts`). An
in-group click to an intercept target takes the server-route path, since the
optimistic presentation declines for it ("Intercepts" below).

### Intercepts

An intercept's loaders are loader segments of its slot,
`${parent}.${slot}D${i}.${$$id}`, resolved by the partial lane's one funnel
(`resolveOwnerLoaders` in `segment-resolution/revalidation.ts`, with an
intercept `LoaderOwner`). Deferral, fill skipping, the `ctx.use()` delivery
(`deliverStartedLoaders`), per-loader revalidation and handle attribution
come from it as for a route's loaders.

A prefetch that resolves an intercept defers the intercept's flagged loaders
and nothing else: its plan's scope is the intercept entry's
(`resolveInterceptDeferralScope` in `prefetch-deferral.ts`), so the target
chain's layouts below the declaring entry, which such a request renders and
whose ids its `matched` leaves out, are never deferred. The click that adopts
it commits the source page with the modal at once: the modal's layout and,
while its aggregate waits on the hole, its `loading()`. Its one fill carries
the intercept source (`X-RSC-Router-Intercept-Source`) and names the source
as the page it is sent from, since from the target itself nothing
intercepts. In the fill the intercept's handler and layout do not run (the
client holds the slot), only the loaders the client lacks run, and every
target-chain entry the client does not hold is skipped. An intercept has no
middleware of its own; the target route's middleware runs on the prefetch and
the fill alike, as on every pass.

An intercept's `matched` is the client's ids without any of the slot's, then
the slot's own in declaration order (`match-result.ts`): one order for the
prefetch, its fill, an action and a revisit, so a fill's identity check
passes.

The browser folds the loader segments back onto the slot before it builds the
tree (`foldInterceptLoaders` in `segment-system.tsx`): one aggregate,
memoized on the loaders' data, read by the slot's `LoaderBoundary` as before.
Walked as loaders they would attach to the slot's parent, whose subtree (the
page under the modal) would change shape and remount. The aggregate is
settled before the commit when nothing in it is deferred and the slot has no
`loading()`, or the lane settles loaders, so a modal with no `loading()`
commits whole, as when the server awaited its loaders (it still does).

A modal with no `loading()` and a deferred loader shows an empty slot from
the click until the fill: `LoaderBoundary`'s own `<Suspense fallback={null}>`
is new in that commit. The modal then shows when a plain click's would. The
slot's loaders resolve together, as before: no per-loader streams for a
slot.

### Where it is pinned

- `src/__tests__/partial-update-fill.test.ts`: the updater with a mocked
  client and store. One `onUpdate` and one `renderSegments` per adopted click
  (a loader, a route unit, a layout unit with route, slot and loaders), every
  defer resolved with the fill's value at its first chunk, the entry
  holding the fill's own segments, a fill that answers before the commit, a
  fill its navigation's signal aborts (before its response, after it, while
  the tree of a failed answer is built), the click that waits for its fill,
  and each ending in "Failure".
- `src/testing/__tests__/navigation-adoption-loading.test.tsx`: the real
  provider, event controller, transaction and updater, with a counter on
  every update that reaches the provider, and a fill cancelled by a newer
  navigation and by a back/forward through the real event controller.
- `src/__tests__/navigation-transaction.test.ts` ("a committed navigation that
  is still streaming") and `src/__tests__/navigation-bridge-fill.test.ts`
  ("a fill in flight"): the signal a newer navigation and a back/forward
  abort after the commit. `src/__tests__/navigation-client.test.ts` ("the
  signal"): a request cancelled until its response, never after.
- `src/__tests__/browser-defer.test.tsx`: the defer and its read rule
  against real React ("How a hole is read").
- `src/__tests__/segment-system.test.tsx`,
  `src/__tests__/parallel-outlet-deferred.test.tsx`,
  `src/__tests__/segment-loader-promise.test.ts`: the tree.
- `tests/shared-e2e/src/prefetch-false.ts`: the browser bodies, run by both
  apps in a dev and a `(production)` describe. The `clientUrls()` bodies
  (titles starting `clientUrls():`) run against the fixture's group at
  `/prefetch-false/cu`.
- Intercepts: `src/testing/__tests__/prefetch-false-intercept.rsc-test.tsx`
  (a prefetch from the source, its fill, the modal open, `ctx.use()`, a
  navigation and an action inside the modal, through `serveShellRequest`
  with `partial.interceptSource`), `prefetch-false.rsc-test.tsx` ("a prefetch
  that resolves an intercept defers its flagged loader"),
  `src/router/match-middleware/__tests__/intercept-cache-hit.test.ts`,
  `src/router/__tests__/match-result.test.ts`,
  `src/__tests__/segment-system.test.tsx` (the fold),
  `src/__tests__/partial-update-fill.test.ts` ("an intercept adoption"), and
  the `intercept():` bodies of `tests/shared-e2e/src/prefetch-false.ts`
  against the fixture's `ix` pages.
- `clientUrls()` routes: `src/client-urls/__tests__/client-urls.test.ts` (the
  DSL records the flag, a `layout()`'s on every route below it, and inside
  `intercept()`),
  `src/client-urls/__tests__/server-projection.test.tsx` and
  `src/vite/discovery/__tests__/virtual-module-codegen.test.ts` (the flag
  crosses the projection and its replay),
  `src/router/segment-resolution/__tests__/prefetch-deferral.test.ts` (a
  loader's own flag defers in a group chain, no `loading()` does),
  `src/testing/__tests__/prefetch-false-client-urls.rsc-test.tsx` (the same
  through `serveShellRequest`), `src/__tests__/partial-update-fill.test.ts`
  ("a clientUrls() click that presented its destination": one commit in the
  optimistic-commit transition, `pending` cleared before the fill answers)
  and `src/client-urls/__tests__/client-root.test.tsx` (a hole keeps the
  destination instance and the read's fallback).

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

- A flagged `loading()` on a layout, entered from a page that does not hold
  the layout, is where the adopted click shows a different page from the
  plain click's, by the maintainer's choice: its skeleton with the click over
  the layout's whole area, and the layout once the fill has answered, at
  least React's 300 ms after the skeleton. A plain click in a production
  build shows the layout with its response's first chunk (#1080) and the
  fallback inside it; a development server shows the fallback alone first in
  both. A `loading()` of its own below the layout, or an app's `<Suspense>`
  in its content, shows inside the layout on both clicks, and a read with no
  boundary of its own shows the layout's own fallback there, its second
  mount on the adopted click. Content whose data lands within React's 300 ms
  of the layout's reveal, inside the layout or anywhere else on the page,
  shows up to that much later than on the plain click ("A layout unit shows
  its skeleton with the click"). The parity cases assert this expectation
  (`layoutSkeleton`).
- A deferred `loading()` entry on a page that commits in a transition (its
  own `transition()`, or one on anything its fallback covers) shows its
  fallback when its fill starts answering, not with the click ("A unit under
  `transition()` waits for its fill"). Equal to the plain click, never ahead
  of it.
- A `transition({ when })` below a deferred unit is asked for the adopted
  click, because its entry's placeholder carries it. It is asked once, before
  the fill is sent (`decideGatedOff` in `partial-update.ts`), with the
  location state of the prefetched payload: state a deferred handler sets is
  not in `to.state` for that predicate, where a plain click's has it. Read
  from the code, not measured: no fixture has that shape.
- Where React holds a click for a read with no boundary, the address bar
  moves when the router commits the navigation, before the page shows, as
  on every navigation ("A read with no boundary"). A plain click commits
  with its response and an adopted click at the click, so the adopted
  click's address bar leads the page by the fill's round trip more.
  `useNavigation()` and the URL hooks move with the page in both, and the
  page itself shows when the plain click's does. Production, router app,
  plain against adopted, how far ahead of the page:

  | click                                              | address bar    | `useNavigation().location` |
  | -------------------------------------------------- | -------------- | -------------------------- |
  | `bare`, a server answering in a few ms             | 100 and 104 ms | 1 and 0 ms                 |
  | `bare`, loaders 300 ms slower, the same server     | 402 and 406 ms | 1 and 1 ms                 |
  | `bare`, a slow loader, the same server             | 704 and 705 ms | 0 and 0 ms                 |
  | `bare`, the server 300 ms away                     | 104 and 439 ms | 1 and 1 ms                 |
  | `above`, the server 300 ms away                    | 101 and 409 ms | 0 and 0 ms                 |
  | `bare-inner`, the server 300 ms away               | 101 and 412 ms | 0 and 1 ms                 |
  | `bare`, the server 300 ms away, requests 1 s later | 99 and 1417 ms | 1 and 0 ms                 |

  Under the bar that lead is feedback at the click, not a later page, and
  the maintainer dropped the rule that compared it (2026-10-11): it used to
  be an open case (`OPEN_HELD`), with one cell while the server answered in
  a few ms and ten once it was 300 ms away. Not changed either: the three
  ways to move the address bar with the page each break a page that is not
  held ("A read with no boundary").

- A deferred unit reveals as soon as its data lands, a round trip or more
  before a plain click's reveal: its fallback has been up since the click,
  so React's 300 ms run from the click, where a plain click's run from its
  response's first chunk. A nested read that lands after that reveal shows
  a fallback of its own, which the plain click never shows, and React holds
  its content 300 ms from then, so that one value can show up to 300 ms
  after the plain click's ("When the holes resolve"). The page itself is up
  sooner. That is the bar (the maintainer's, 2026-10-11): the next page
  early, the deferred parts when React reveals them. Measured in
  production, router app, the server 300 ms away: `inner` shows its content
  at 408 ms against 614 and its late read at 711 against 614; `nested` its
  early read at 413 against 614 and its late one at 715 against 614. The
  parity cells assert it and pass, in both apps and both modes. They failed
  under the old completion rule, with the server 100 ms away (the page
  complete at 603 to 611 ms against 407 to 439).
- A page with a `<ViewTransition>` of the app's own mounted across the
  click pays a view transition the plain click does not, once the server is
  far enough that the fill answers after React's throttle has run out. The
  fill resolves each hole with its first chunk, with a node or a stream
  that is still pending. React retries the boundary at once (its fallback
  has been up since the click), the retry suspends again on the loader,
  React commits it with the fallback in place (R-throttle, second half),
  and with a `<ViewTransition>` on its path that commit starts a view
  transition that changes nothing (R-start), which the reveal then waits
  for (R-wait). It is React's behaviour, and the maintainer accepted it as
  such on 2026-10-11, as for #1078: no router change. A `transition()` route
  avoids the same mechanism by committing with its fill ("A unit under
  `transition()` waits for its fill"); here the boundary is the app's, and
  the router cannot see it. Measured in production, router app, the server
  300 ms away (`&boundary=1`), plain against adopted: `unit` starts view
  transitions at 616 against 304 and 602 ms and shows the page at 636
  against 621; with `&vtms=600`, at 616 against 305 and 949 ms, the page at
  631 against 966, 335 ms later than the plain click. A probe of React's
  commits (a devtools hook in the page) finds the commit at 308 re-rendering
  the unit's boundary, which stays on its fallback. With the server near,
  the fill and the loader land before the throttle runs out, the first
  retry has everything, and none of this shows.

  The escape hatches are the app's. Its own `<ViewTransition>` decides what
  it animates through its props, and whether it is mounted across the
  navigation at all. For the router's boundaries, `transition({ when })`
  decides per navigation whether a route's transition applies, and
  `transition({ viewTransition: false })` places no `<ViewTransition>`. The
  parity cases hold the gap to a bound (`OPEN_RETRY_TRANSITION`, "Open
  cases").

- In a `clientUrls()` group the canonical commit is a transition, and
  `useNavigation()` and its location move with the router's commit there,
  not with a page React holds: on a read with no boundary (`cu/bare`) the
  plain click's location moves about 100 ms before the page (with its
  response), the adopted click's about 400 ms before it (at the click). The
  group's own `useOutlet().pending` stays true until the page shows in both.
  The parity cases of in-group clicks (`optimistic`) do not compare the URL
  hook, as no case compares the address bar.
- A newer navigation cancels a pending fill when it starts, not when it
  commits. One that then ends without replacing the page leaves the deferred
  part's fallbacks up, unfilled, until the next navigation ("Abort"). The
  maintainer's call: the signal is the one thing that cancels a fill.
- `navigate()` resolves once the fill has answered, a round trip after the
  page committed, because the navigation that adopts the prefetch fills its
  holes itself. `useNavigation()` reads idle from the commit, with
  `isStreaming` true until the fill has streamed. The maintainer's call.
- A loader that lands within a few milliseconds of React's first reveal is
  a coin flip for a plain click too: the value either makes the throttled
  reveal or waits 300 ms for the next one. A plain click's first reveal
  comes 300 ms into its response, so the parity matrix keeps its
  mid-duration column at 400 ms into the response, 100 ms clear of it.
- A prefetch that is still unanswered when its link is clicked on its own
  page is waited for and adopted, and the fill leaves after it: the deferred
  part completes later than a plain click's by up to what was left of the
  prefetch. The maintainer's exception to parity, asserted with a bound ("A
  click before its prefetch has answered").
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
  seen: the loader runs for its reader (through its registration, `cache()`
  included), its own segment has already been emitted as deferred, and the
  fill resolves it again. Two readers can be late:
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

- A flagged `loading()` inside `intercept()`, in `urls()` and in
  `clientUrls()`, defers nothing, and neither does one on a `clientUrls()`
  route or on a server layout above a group ("Which loaders are
  deferrable").
- An intercept's loaders resolve together: its modal shows its `loading()`
  until every one has arrived, a flagged one's fill included ("Intercepts").
- A fill does not refresh a stale `cache()` record (see "Where the decisions
  are made"). The record waits for the next request that reads it.
- Values a held handler would have set with `ctx.set()` are not visible to
  deferred work (R10).
- A page restored from the back/forward cache with a fill in flight shows the
  network error boundary if the browser dropped the request: the restore
  does not abort the fill ("Abort"), so the dropped request fails as a
  navigation does. Pinned by unit tests (`navigation-bridge-fill.test.ts`,
  `partial-update-fill.test.ts`); not run in a browser.

### The parity cases

`expectAdoptedClickIsNeverWorseThanAPlainClick` in the shared suite makes
each click twice on fresh pages, once plain and once after its prefetch has
been received, and compares what a reader could see. That is 219 cases
(`PREFETCH_FALSE_PARITY_CASES`), each in both apps and both modes, and 15
on the fixture's `clientUrls()` group (`PREFETCH_FALSE_CLIENT_URLS_PARITY_CASES`:
in-group clicks to `cu/loader`, `cu/bare` and `cu/vt`, the same-route
`cu/item/a` to `cu/item/b`, and hub to `cu/loader`, each with fast, 300 ms
slower and slow loaders).

Every one runs with the server 300 ms away. The fixture's first entry is a
route middleware (`serverDelay`) that waits `&server=<ms>` before every
render pass of the include: the document, a prefetch, a navigation, a fill,
and an action's revalidation render (route middleware does not wrap an
action's body; the fixture has no action). The flag rides on every hub link,
as the others do. Why 300? It is about what one request costs a real server
before its first byte, and it is the time a prefetch saves. With a local
server answering in a few ms and the fixture's 100 ms loaders, the first
reveal of both clicks waited for React's throttle, a few ms apart, so the
cases measured React, not the prefetch.
`LATENCY_CLICKS`, nine clicks from the hub (`loader`, `unit`, `section`,
`section-own`, `vt-unit`, `inner`, `vt-inner`, `nested`, `vt-below`), run
again with the server 500 ms away and their loaders 0, 150, 300 and 600 ms
slower: 36 cells, the ones that used to run with the server 100 ms away.

That 100 ms used to be a wait in the browser (`farAway`, which holds every
RSC request of the click before it is sent). The middleware puts the same
time in front of a response's first byte and covers the document and the
prefetch as well, so those cells use it alone. The browser wait stays where
the middleware cannot stand in: `HEAD_HELD_CLICKS` hold the click's requests
a second on top of the server, far above every margin, and the in-flight
bound (`expectClickDuringThePrefetchStaysWithinItsBound`) keeps its own
300 ms for every request, the prefetch included, as its numbers were
measured.

What the cases compare, before the bar of 2026-10-11 and now:

| Compared                                                               | Before                                                                 | Now                                                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The first change                                                       | no later than the plain click's                                        | the same, and within 100 ms of the click, except where the page commits with its fill (`commitsWithFill`) or the prefetch was made on another page                 |
| The page's first content                                               | no later than the plain click's                                        | the same: the first frame with content the page did not show before the click                                                                                      |
| What shows after it                                                    | no later than the plain click's (a flagged layout's reveal aside)      | no later than the plain click's, or than React's 300 ms after the last fallback that showed or hid on the adopted click (`reactHold`), whichever is later          |
| The completed page, the last fallback gone, idle and incomplete        | no later than the plain click's (a flagged layout's reveal aside)      | bounded as what shows after the first content                                                                                                                      |
| A fallback the plain click does not show                               | a failure, unless the read's own (`ownFallback`) or a flagged layout's | allowed where it waits for deferred work: the read's own, one inside the deferred part (`deferredFallbacks`), a flagged layout's skeleton and what shows inside it |
| Content hidden, a blank page, a remount, server work, view transitions | as now                                                                 | unchanged                                                                                                                                                          |
| How far the URL is ahead of a page React holds                         | the address bar and a URL hook, against the plain click's, 50 ms       | a URL hook only: the address bar moves with the router's commit on every navigation, and the adopted click commits at the click                                    |

Where does "React's 300 ms after the last fallback change" come from?
`react-dom-client` marks the time whenever a Suspense boundary switches
between its fallback and its content, either way, and commits a retry no
sooner than 300 ms after the last mark, anywhere on the page. The page's
sampler records the same moments (`fallbackEventsAt`: the set of visible
fallback nodes changed, so a skeleton that hides as its copy inside the
layout shows counts). A value held to that bound is React's choice. A value
held past it, and past the plain click, is a wait the router added, and the
case fails. The page's first content gets no such allowance: showing it
early is what the prefetch is for.

The margins are unchanged: 100 ms for times, 50 ms for a URL hook's lead. A late
pair is recorded again, up to three pairs.

Production, router app, the server 300 ms away, adopted against plain, in
ms (the full production run; the Cloudflare app reads the same within
10 ms):

| click                          | first fallback | first content | complete      |
| ------------------------------ | -------------- | ------------- | ------------- |
| hub to `loader`                | 4 and 312      | 4 and 312     | 411 and 613   |
| hub to `inner`                 | 4 and 315      | 408 and 614   | 711 and 614   |
| hub to `nested`                | 3 and 314      | 3 and 314     | 715 and 614   |
| hub to `section-read`, `hslow` | 3 and 925      | 911 and 925   | 1213 and 1225 |

`loader` is the plain case: the page with the click, the value a response
sooner. `inner` and `nested` are the cases the old rule failed: the page up
a response sooner, the late read about 100 ms after the plain click's,
behind its own fallback, React's 300 ms after that fallback showed.
`section-read` with a 600 ms layout handler shows its skeleton at the
click, the layout with its page and the read's fallback inside it with the
fill (911 against the plain click's 925), and the value 12 ms sooner.

### Open cases

A gap that is known and not fixed is data on its parity case
(`PrefetchFalseParityCase.open`: a reason, the rules it breaks and a bound).
The case still runs. Every rule the gap does not break is asserted first, so
a regression in the same cell is a real failure, and so is the gap's bound,
so the gap cannot grow without a failure. Then the test is marked with
`test.fail` and the broken rules are asserted: the run reports an expected
failure with the reason, and an unexpected pass, which fails the suite, the
day the gap is fixed.

| Gap                     | Cells per app                                        | Rules it breaks                                        |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| `OPEN_RETRY_TRANSITION` | 4, both modes (3 fail as expected in the router app) | the view-transition count; at 600 ms, the timing rules |

`OPEN_RETRY_TRANSITION` is the app-boundary gap in "Limits" (#1078): hub to
`unit` and to `loader` with `&boundary=1`, at the default duration and at
600 ms. Its bound: one view transition more than the plain click at most,
as many that change the page, and the page complete no later than the
plain click's plus one view transition (600 ms, or 300 ms at the default
duration) plus the parity margin. The measured cells are 261 to 335 ms
past the plain click at 600 ms (the bound allows 700), and from 72 ms ahead
of it to 18 ms behind at the default duration (it allows 400). `loader` at
600 ms is marked `openWhereItShows`: in the router app the view transition
of the click's own handle push (from about 5 to 605 ms) is still running
when the fill answers, so the retry waits for it, finds the value and
reveals once, and the case passes; in the Cloudflare app it is an expected
failure. The other three cells show
the gap in both apps, so its closing shows up there.

`OPEN_HELD`, the address bar ahead of a page React holds, is gone with the
rule it broke ("A read with no boundary").

Before the fill stopped rendering a tree (`f43a4a27`) there were 35 cells.
`OPEN_NESTED` (2) closed with the held-boundary fix (#1080). 32 closed with
the one-tree click:

| Gap           | Cells | What closed it                                                                              |
| ------------- | ----- | ------------------------------------------------------------------------------------------- |
| `OPEN_QUEUED` | 10    | A click with holes commits urgently ("The click commits on the plain click's lane")         |
| `OPEN_ABOVE`  | 3     | No defer waits for React's commit, a unit's own included ("Where React holds the tree")     |
| `OPEN_HELD`   | 19    | A unit under `transition()` commits nothing at the click; the hooks move with a held commit |

The same #1080 merge opened `OPEN_LAYOUT_CHROME` and
`OPEN_LAYOUT_CHROME_AT_MARGIN`, 42 cells in production (it made the plain
click show a flagged layout with its first chunk); they were red on the
merge commit, with the fill still rendering its own tree, in both apps. The
maintainer chose the skeleton at the click over both ways to close them, and
the cells now assert that expectation in both modes ("A layout unit shows
its skeleton with the click").

Two more exceptions to the plain click are asserted, not open: a click
before its prefetch has answered ("A click before its prefetch has
answered"), and the layout unit above.

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
`animation-duration` on the view-transition pseudo-elements). `&server=<ms>`
makes every request the fixture serves wait that long before it renders,
the document and the prefetch included; `&server=300` is what the parity
cases run with, and the difference a prefetch makes is easy to see there and
hard to see without it. Without `manual=1`
the panel, the badge and the polling are not rendered, which is what the
suites see. Every link carries the flags that are set.
