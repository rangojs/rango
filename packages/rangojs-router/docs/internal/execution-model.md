# Execution Model

This is the canonical runtime contract for `@rangojs/router`.

Use this document as the source of truth for request flow, middleware scope,
segment recomputation, and context visibility.

Guarantees are tagged with the `e2e/semantic-matrix.test.ts` row id that
pins them (`[S1]`...`[W1]`). A semantic change must update the guarantee,
its row, and this pairing together.

## Terminology

- Full render pass: a complete render of the active tree (initial request,
  full HTML rerender, prerender build pass).
- Partial revalidation: action-driven recomputation of only selected segments.
- Global middleware: `router.use(...)` middleware.
- Route middleware: `middleware(...)` defined in `urls()` trees.
- Action execution phase: server action runs and may mutate cookies/headers/context.
- Revalidation phase: render step after action execution.
- Orphan layout: `layout(...)` nested under a `path(...)` use callback.
- Parallel slot: `parallel({ "@slot": ... })` segment rendered in a named outlet.

## Flow Overview

### 1) Normal request (no action)

```text
global middleware
  -> route middleware
    -> layout / handler / orphan / parallel / loaders
```

### 2) JS action request

```text
global middleware
  -> action executes
  -> route middleware wraps revalidation render
    -> revalidated layout / handler / orphan / parallel / loaders
```

### 3) PE form POST (no JS)

```text
global middleware
  -> action executes
  -> route middleware wraps full rerender
    -> HTML response
```

A progressive-enhancement action returns a full HTML document response, not a
Flight stream. Pinned by the `[P1]` semantic matrix row.

### 4) Intercept request

```text
global middleware
  -> route middleware
  -> intercept middleware
  -> intercept handler / intercept loaders
```

### 5) Prefetch, then fill (`prefetch: false`)

A prefetch is a partial request sent early (`X-Rango-Prefetch`). Without the
flag it runs everything flow 1 runs. With
`loader(Def, { prefetch: false })` or `loading(fallback, { prefetch: false })`
somewhere in the matched tree, it leaves the flagged work out, and the click
that adopts the prefetch sends a second request for it:

```text
prefetch request (X-Rango-Prefetch)
  global middleware
    -> route middleware
      -> layout / handler / orphan / parallel / loaders,
         minus the flagged work, which is marked deferred

fill request (_rsc_fill), sent when the click adopts that payload
  global middleware
    -> route middleware
      -> only the segments the client does not hold: the deferred work
```

"Flagged work" is a flagged loader, or everything behind a flagged
`loading()`: the entry's handler, its loaders, its orphan layouts and slots
and, for a layout, every deeper entry. An entry whose handler output is
stored (`cache()`, `ppr`, `Prerender`/`Static`) is served as usual and only
its loaders are left out.

Three things to keep in mind, because each looks like a bug the first time:

- **The flag applies only to a segment the client does not have yet.** "New"
  is the segment's id being absent from `_rsc_segments`. A segment the client
  holds is never deferred, whether or not its `revalidate()` returns true: a
  held flagged layout or route renders in the prefetch as it does without the
  flag, a flagged loader on a held segment runs when it revalidates, and
  nothing below a held segment is deferred because of it. A new route with its
  own flagged `loading()` under a held layout is still its own unit. The
  invariant: a click that adopts a prefetch with deferred units is never worse
  than the same click with no prefetch at all. It never covers more of the
  page with a fallback than that plain navigation does, and never for longer,
  it waits only where the plain navigation would wait, and content on screen
  is never replaced by a fallback, blanked or remounted while a fill is
  pending. What a prefetch defers depends on what its source page holds, so a
  response that defers is used only on that page (`x-rsc-prefetch-scope:
source`) and is never reused by the document cache or a shared cache.
- **Deferral replaces execution; it never adds a skip.** A new segment always
  renders, so the flag only ever turns work that would have run into deferred
  work. Revalidation of held segments is untouched.
- **The fill is not a revalidation.** In a fill a segment the client holds is
  skipped outright: no `revalidate()` predicate is called, no handler runs,
  nothing is emitted for it. What renders is exactly the set of ids missing
  from `_rsc_segments`, which is the first-render guarantee below doing the
  work.

Every other request kind is untouched by the flag: a document request, a
navigation with no prefetch to adopt, an action revalidation, back/forward, a
no-JS form post, a shell capture, a warm request, an on-demand prerender and
the `_rsc_loader` lane all run the flagged work as flow 1 to 4 describe.

The decisions live in `router/segment-resolution/revalidation.ts` and ask
`router/segment-resolution/prefetch-deferral.ts`; the design is
`docs/design/prefetch-false.md`.

## Guarantees

- Global middleware wraps the entire request lifecycle.
- Route middleware wraps render passes, including:
  - normal renders
  - post-action revalidation renders
  - PE full rerenders
- Route middleware does not wrap action execution itself.
- Handler-first ordering is guaranteed within a full render pass:
  route handler runs before its child/orphan layouts and parallel children.
- `ctx.set()` values flow downward through structural scope boundaries only.
- Loaders are live by default unless explicitly cached via `cache()` in their
  use params: `loader(Fn, () => [cache({ ttl })])`. Pinned by the `[C1]`/`[C2]`
  semantic matrix rows.
- A loader-cache HIT skips only the cached body. It replays the handle pushes
  of that body and of the loaders it awaited via `ctx.use` on the MISS, each
  loader's pushes at most once per request: a dependency that a sibling loader
  or the handler already ran keeps its live pushes, and a dependency that
  runs after the replay replaces its replayed values with its live pushes,
  in their position (handle output stays live like the data). The order is
  the push order of the run that produced the value, whether an entry
  replays it or a run replaces copies: a loader that pushes, awaits a
  dependency that pushes, and pushes again shows `[own, dependency, own]`
  on both. A stale hit's
  background refresh runs on its own loader executor, so it never takes the
  page's run of a dependency. Source: `replayLoaderHandles` in
  `loader-cache.ts`, `appendHandles` in `handle-snapshot.ts`,
  `_claimLoaderPushes` in `loader-resolution.ts`
  (`setupLoaderAccess`), `pushReplayed` in `handle-store.ts`; pinned by
  `loader-cache-handles.test.ts` and `handle-store.test.ts`.
- One value per loader per request: once a loader's `cache()` binding
  started (`overrides.set` at kickoff in `executeLoaderData`), every
  `ctx.use` of it, from a handler or from another loader's body, gets the
  binding's value, a HIT included; the bound body never runs a second time
  for a reader. A reader that ran before the binding started got the value
  of its own run, as it does on main. A stale refresh reads its loaders on
  its own executor, never through the page's bindings, so it is not rebuilt
  from another stale entry. Source: `_loaderCacheOverrides` in
  `loader-cache.ts` (the handler interceptor), `useLoader` and
  `_runLoaderIsolated` in `loader-resolution.ts`; pinned by
  `loader-cache-tags.test.ts` and `loader-cache-handles.test.ts` (#964).
- A loader's own `cache()` is keyed only by what the binding declares
  (`key()`, else the store `keyGenerator`, else loader id, host, path and
  params); it does not inherit an enclosing route `cache()` key (#974). With
  no declared identity, a fill whose execution read `cookies()`, `headers()`
  or a non-cacheable `ctx.get()`, in the body or in a loader value it read via
  `ctx.use` (a keyed cached loader's HIT included, through its entry's
  identity mark), fails and stores nothing: on the MISS, on its stale refresh,
  and when a reader (a parent layout's handler) started the loader before the
  binding and the MISS reused that run. A read that settles after the value
  only refuses the write. A live loader running beside it is
  unaffected. Source: `executeLoaderData` in `loader-cache.ts`,
  `recordLoaderIdentityRead` in `server/context.ts`, `recordedIdentityRead`
  in `cache/cache-tag.ts`; pinned by `loader-cache-identity-guard.test.ts`
  (#972).
- A loader's data and the settled handle values it pushed come from one
  source on every replay of a PPR shell: the entry's pin, the loader's own
  `cache()` entry, or a run in this request. The shell record holds the
  settled pushes of each loader body the capture ran (an `ssr: false`
  loader's own and those of the loaders it awaits), and a replay restores
  them by where it takes each loader's data from, which the loader seed
  answers for both (`servedPins` / `loaderPins` in `loader-cache.ts`, the
  seed keyed by loader id), not the request's type:
  - A loader served from its pin: its pushes go through `pushRestored` and
    stand, unclaimed. A promise-free `ssr: false` loader does not run on the
    replay, so they are the only copy; a loader that does run (a
    hole-carrying `ssr: false` loader) reads the store, and its settled
    pushes, and those made anywhere inside its body (a `"use cache"` hit
    replaying a dependency's push), are dropped, while its deferred ones are
    added; its own `cache()` HIT replays the same way. The record is the
    whole of that loader's settled pushes, so this holds when it has no copy
    too: a push the capture's run did not make is not shown next to the
    pinned data. This holds on a
    document HIT, a client navigation and a prefetch that replay the shell,
    and on the seeded fallback after an explicit route `cache()` miss (#1001,
    #1003).
  - Any other loader is a hole: one the route runs on the live lane, or an
    `ssr: false` loader the entry has no pin for (a navigation-only entry,
    pins dropped by `maxSnapshotBytes`). Its pushes are restored through
    `pushPlaceholder`, unclaimed. Its run replaces them in place
    (#936), even when a running pinned loader awaits it (a hole's body ends
    the search for an enclosing restored loader); a run that settles without
    a push drops them (`settleLoaderRun`); and its own `cache()` HIT delivers
    the pushes the entry recorded, none when it recorded none, in their
    place, for itself and for the dependencies the entry recorded
    (`replacePlaceholders`).
  - A dependency the route registers on neither lane is credited at capture
    to the first registered loader around it: under a live-lane loader its
    pushes are that hole's; run only under a bake-lane loader, they are
    recorded under its own id and stand while every `ssr: false` loader of
    the route is pinned (the record does not name the loader that ran it).

  A route `cache()` record a capture wrote has no pins, so every owner in it
  is a placeholder: the loader's run or its own `cache()` entry replaces the
  copy. Owned values a capture restores from such a record keep their owner
  in the shell record too. A PPR partial replay whose doc record hits serves
  the same loader pins as the document HIT, by each loader's own `ssr: false`
  flag (`LoaderEntry.bake`), whatever `loading()` sits on its entry. Not
  covered: a reader that starts a cached loader before its binding (by
  design: the reader runs it live while the binding serves its entry, so the
  loader's data and its push can come from different runs on that request;
  declare the cached loader first or read it from the handler), and a pinned
  loader whose capture pushed nothing
  (`docs/design/handle-push-ownership.md`). Source: `restoreHandles` in
  `handle-snapshot.ts` (`CachedEntryData.handleOwners`, written from the
  capture's push wrapper in `shell-capture.ts`), `withCacheLookup` in
  `cache-lookup.ts`, `matchPartialWithPprReplay` in `rsc-rendering.ts`;
  pinned by `serve-shell-request-push-ownership.rsc-test.tsx`,
  `cache-lookup-owned-pushes.test.ts`, `cache-record-loader-pushes.test.ts`
  and `serve-shell-request.rsc-test.tsx`.

- Under PPR shell capture, of the DSL `loader()` registrations only
  `loader(Def, { ssr: false })` executes and bakes; every other registration
  is masked and live, whatever its `loading()`
  ([`/ppr` → The loader lane rule](../../skills/ppr/SKILL.md#the-loader-lane-rule);
  source: `resolveLoaderData` in `loader-cache.ts`). A loader a handler
  awaits (`await ctx.use(Loader)`) is handler output, whatever its
  registration: it executes at capture and bakes. Identity reads inside a
  bake-lane loader or a handler-awaited loader refuse the capture. Axis 1 is
  unchanged in both lanes.
- A `"use cache"` HIT appends the function's own pushes to the calling
  segment, and replays the pushes of loaders it read via `ctx.use` under the
  loader-cache HIT rule above: skipped when the loader already ran or was
  replayed in this request, replaced in place when it runs after the replay.
  Its stale refresh reads loaders on its own executor and does not claim.
  Records written before owner keys replay in full. Source: `appendHandles` in
  `handle-snapshot.ts`, `useCacheRecordKey` in `handle-capture.ts`,
  `refreshView` in `cache-runtime.ts`; pinned by
  `use-cache-handle-capture.test.ts` (#928).
- Route-level `cache()` does not cache loader segments; loaders remain live.
- Route-level `cache()` stores only its boundary's subtree. The entries above
  the outermost enabled `cache()` entry of the chain are never written to the
  entry, and a hit (document or partial) resolves them as an uncached render
  would: their handlers, parallels and loaders run, their `ctx.set()` values
  reach the loaders below, and their header writes land (`CacheScope.covers`,
  `withCacheLookup`). A `ppr` route is the exception: its scope covers the whole
  chain, which bakes into the shell. Pinned by
  `match-middleware/__tests__/cache-outer-layout.test.ts` and
  `e2e/cache-outer-live.test.ts` (test-app and cloudflare-basic).
- A `cache()` among a path's children sets that route entry's own `cache`
  config (`cache()` in `dsl-helpers.ts`), so the route is its boundary: the
  route segment and its own layouts and parallels are stored and replayed, and
  every entry above the route stays live. The header and non-cacheable-var
  guards latch at the route (`entry.cache` in `resolveAllSegments` and
  `resolveAllSegmentsWithRevalidation`). Pinned by
  `match-middleware/__tests__/cache-path-children.test.ts` and
  `e2e/cache-path-children.test.ts`. A `cache()` inside a routeless
  `layout()`/`middleware()`/`transition()` wrapper in a path configures that
  path the same way (`enclosingRoute()` in `dsl-helpers.ts`).
- An orphan renders the routeless entries in its own `layout[]` after its
  handler and parallels (`resolveOrphanLayout`,
  `resolveOrphanLayoutWithRevalidation`), so a `layout()` after a bare
  `cache()` marker wraps every route of the enclosing layout. The marker is
  also the chain parent of the routes after it; for those routes it is
  resolved and its middleware collected once, at its chain position, never as
  its layout's orphan (`ResolveSegmentOptions.chain`, `collectRouteMiddleware`).
  A hit's live pass gets the full chain, so the marker's subtree comes only
  from the record. Pinned by
  `match-middleware/__tests__/orphan-nested-layouts.test.ts` and
  `e2e/cache-orphan-nested.test.ts`.
- A response route wrapped in `cache()` returns the same payload on a
  follow-up request; an uncached response route re-executes on every request
  and its payload changes. Pinned by the `[RC1]`/`[RC2]` semantic matrix rows.
- A response-route handler can return or throw a `Response`; both forms are
  response control flow. Request-context headers/cookies merge, `onError` is
  skipped, and status-200 responses use the normal response-cache policy.
  Pinned by the `[RR1]` semantic matrix row.
- After a cached entry's SWR TTL expires, a request is served the stale value
  while a background refresh recomputes the entry; a later request sees the
  fresh value. Pinned by the `[SWR1]` semantic matrix row.
- Prerendered handlers can be frozen while loaders remain live. Pinned by the
  `[PR1]` semantic matrix row.
- Parallel slots with `loading()` are independent streaming units. Their
  loaders run concurrently without blocking the parent layout or sibling
  routes — on SSR (skeleton renders immediately, data streams), on SPA
  navigation (existing slot UI stays visible, data refreshes in background),
  and on cache-hit paths (loaders are reconstructed fresh).
  Without `loading()`, parallel loaders block the parent.
- Slot override: when multiple `parallel()` calls define the same `@slot` name,
  the last definition wins. Earlier definitions of that slot are removed.
- **PPR commits after the whole middleware chain.** The shell serve path (opt-in
  per page route via the `ppr` path option; integral, no middleware to mount)
  lives at the top of the render pass that `executeRender` wraps — strictly
  after the global `router.use()` chain AND route DSL `middleware()`. Any
  middleware rejection/redirect/401 returns before a single shell byte, on MISS
  and on a warmed HIT alike. On a HIT the composed response is committed there:
  prelude bytes flush first, and match/Flight/resume run behind them inside the
  response stream. Pinned by the `[PPR1]` semantic matrix row and
  `e2e/shell-secure.test.ts`.
  - **A shell HIT tail owns its render barrier.** `serveShellHit` runs both seeded
    and fragment-only tails under a derived request context with a freshly wired
    barrier over the request's handle store. This keeps `_treeHasStreaming`, the
    segment order, waiter/deadlock state, and the post-settle handle snapshot in
    the same context as tail matching. Otherwise `ctx.rendered()` can inherit a
    premature non-streaming snapshot and miss handles pushed behind `loading()`.
  - **A shell HIT hydrates with its record's handle data.** The prelude was
    rendered at capture from the handle pushes the record keeps (a capture's
    payload carries no other: `resolvedHandleStream` `recordedOnly`), so the
    document's pre-hydration snapshot (`metadata.handles`) is the record as
    restored, standing copies and placeholders alike. `serveShellHit` freezes
    the handle store's document lane when the tail's render barrier resolves
    (`HandleStore.freezeDocumentSnapshot`): the record is replayed and no
    loader has run. Everything the request's loaders then push, replace or
    drop (a live-lane push, a placeholder's replacement, a deferred push, a
    `cache()` entry's replay) rides `metadata.handlesLate`, whether or not it
    beat the handler barrier, and the client applies it after the root
    hydrates. A document MISS, a route without `ppr` and a navigation replay
    are unchanged: there the snapshot is the store at the handler barrier.
    Pinned by "a shell HIT hydrates from its record" in
    `serve-shell-request-push-ownership.rsc-test.tsx`,
    `handle-store.test.ts`, and `expectShellHitHydratesFromRecord` in both
    apps (#1035).
  - **A `useHandle` reader hydrates with the document's handle data, on
    every document.** "After hydration" above is after the ROOT hydrates.
    A reader in a boundary that hydrates later (a live loader's `loading()`,
    a streamed `<Suspense>`) reads, in its hydrating render, the handle state
    `initBrowserApp` froze before `hydrateRoot`
    (`EventController.freezeHydrationHandleState` /
    `getHydrationHandleState`), and its mount effect moves it on to the live
    state. `useHandle` gets it as `useSyncExternalStore`'s server snapshot;
    it is `undefined` while the live state is still the frozen one, and the
    client snapshot is a constant `undefined`, so a reader that hydrated
    with nothing late renders once and no handle update is a store change to
    React. Before, the reader took the live state, late updates included, and
    mismatched its HTML: a loader push after an `await` on any document.
    Pinned by `use-handle-hydration.test.tsx`,
    `render-route-hydrate.test.tsx` (`lateHandles`), and
    `expectLateBoundaryHandleReaderHydratesClean` in both apps (#1035).
  - **`ctx.dynamic()` is the request-level opt-out on this axis.** Runtime
    middleware calls it BEFORE the commit point, so it forces the request onto
    axis 1 — the shell lookup/HIT/MISS-capture is skipped even when a valid
    shell exists (`!reqCtx._dynamic` guards both the serve gate and the MISS
    capture-schedule in `rsc-rendering.ts`). A handler runs AFTER the commit, so
    it can only suppress the follow-up capture on a MISS. It gates the PPR SHELL
    axis only — a `Prerender()` route's build-baked B-segments still replay.
- **Runtime PPR capture is mixed-chain and never re-runs middleware.** The
  background capture renders the page under a derived context that INHERITS the
  triggering request's post-middleware state (so middleware-derived ctx values
  photograph into the shell — scope fidelity) while the chain itself runs
  exactly once per HTTP request (pinned by the middleware-run counter in
  `[PPR1]`). Build-time producer B is the exception: it replays middleware
  during shell capture with `ctx.build === true` (and `ctx.waitUntil()` inert,
  so build replay fires no background work), before deriving the capture
  context; middleware may `ctx.dynamic()` there to skip baking a URL's shell.
  Within the
  capture, `cache()`d segments replay from the segment cache and UNCACHED
  segments execute their handlers fresh. Everything the handler layer
  produces is shell material, exactly as under `cache()`: promises a handler
  passes to a component under `<Suspense>`, async server components (with or
  without a boundary above them), promises nested in a handler's handle push,
  top-level pushed promises, and loaders a handler awaits. The capture waits
  for all of it before it freezes anything (`settleCaptureRecord` in
  `src/rsc/shell-capture.ts`), bounded by the one `ppr.captureTimeout`
  deadline; output that does not settle in time stores no shell. The capture
  guard (the first step of `guardIdentityRead` in `src/server/context.ts`,
  the one guard every identity read goes through: `cookies()`, `headers()`, a
  `{ cache: false }` variable read, the theme reads `ctx.theme` /
  `getRequestContext().theme` through `readGuardedTheme`, #971, and the raw
  reads `ctx.request.headers` / `getRequestContext().cookie()` / `.cookies()`
  through `guardRequestHeaders` / `guardRawCookieRead`, #976; a cache's own
  `key()`, `keyGenerator`, `condition()` and `tags()`, and `onError`, run
  exempt under `runIdentityExempt`, and a cached body, loader body or funnel
  they start is guarded again) covers
  everything the
  capture waits for — handler and render code, bake-lane segment loaders, and
  handler-invoked loader bodies (no exemption on this tier; the
  consumption-lane rule below). `ctx.dynamic()` called anywhere the capture
  waits refuses it too. Live-lane segment loaders are
  masked — they are the structural holes. Holes come from loaders only:
  `loading()` or inline-Suspense subtrees over a live-lane loader read
  (structural), and promises nested in an `ssr: false` loader's return value
  (masked by shape). Everything else is shell.
- **Serve-time guarding is guaranteed on every serve.** Every serve — MISS and
  HIT — runs the full middleware chain and the live loaders. A MISS renders
  like axis 1, handlers included; a HIT replays the handler layer from the
  shell's own doc record and never runs a handler (see "PPR HIT: no handler
  runs" below). `transition({ when })` never runs on the server, on a PPR
  route or any other: the predicate is a browser function the payload carries
  as a client reference (attached from the route definition right before
  Flight, `rsc/attach-transition-when.ts`, so no stored record holds it), and
  the browser decides at the navigation's first commit. Pinned by the
  `[PPR2]` row ("a HIT runs the full middleware chain and live loaders; no
  handler runs") and the `[PPR4]` row (a HIT carries the predicate, handlers
  replay). Location state middleware sets still reaches the predicate's
  `to.state` on a partial replay HIT: `attachLocationStateIfPresent` runs
  after the replayed match (`requestRenderPlan` in `rsc/rsc-rendering.ts`),
  pinned by the cloudflare-basic exec-matrix navigation e2e (`ppr-shell.test.ts`,
  dev + production). A handler's location state is absent there, because the
  HIT runs no handler.
- **Partial navigations cache and reuse the PPR handler layer without changing
  the Flight payload or client runtime.** A normal-route partial request first
  tries to seed the snapshot's canonical
  `doc:` segment record into `matchPartial()`. Existing client segment ids,
  revalidation rules, and diff collection decide what is returned; captured
  item pins are excluded. Live loaders run fresh. When the doc record hits in a
  shell a document request captured, the replay arms the bake-lane loader seed
  (`matchPartialWithPprReplay`'s `onHit`), so `ssr: false` loaders are served
  from their pins as on a document HIT; a navigation-only capture carries no
  loader pins, and its replay runs them fresh. The overlay is the
  implicit scope's explicit store, not the request's app store, so route-authored
  `cache()` scopes retain their freshness semantics and request effects stay on
  the original render-barrier context. Overlay segment misses and mutations are
  isolated from the real `doc:` namespace. Without a usable snapshot, a cold
  partial renders normally and schedules a navigation-only shell capture. The
  capture settles the handler output and runs the capture guards before it
  writes the doc record, so a request-scoped read refuses the snapshot instead
  of recording it; a direct segment write from the partial pipeline cannot
  safely replace it. The capture rebinds its request identity to the stripped
  target document URL, so route-authored `cache()` scopes use `doc:` keys and
  document completeness guards remain armed.
  Intercepts remain source-resolved. A replay HIT carries each segment's
  `transition({ when })` reference exactly as the live path does; the browser
  decides over every committed segment, kept ones included (#989), so no
  segment is re-sent to carry a decision: a segment the client holds that its
  `revalidate()` (or the default) does not re-render is omitted on a replay
  HIT exactly as on the live path, `transition({ when })` or not (#986;
  `keepClientSegment` in `match-middleware/cache-lookup.ts`, pinned by
  `serve-shell-request-replay-revalidate.rsc-test.tsx` and the dev+production
  load-more e2e in both apps). Production may use
  a fresh local build manifest; dev never blocks navigation on `/__rsc_shell`. Fresh
  and stale-within-SWR runtime generations replay via a non-claiming passive
  read; those usable reads never schedule recapture. Missing, invalid-version,
  corrupt, stale-build, and hard-expired artifacts schedule a navigation-only
  capture. Navigation snapshots use a separate shell key, so they cannot replace
  a document-safe shell when captures finish out of order. Document serving
  never reads the navigation namespace, and navigation entries store no
  document half (prelude/postponed dropped at putShell — replay consumes only
  the segment snapshot). The cross-key capture queue remains
  serialized, but waiting document-shell captures run before queued
  navigation-only captures (the active capture is never preempted), so viewport
  prefetch cannot starve a cold document through its 15-second queue budget.
  `x-rango-ppr-replay` distinguishes an actually consumed fresh/stale
  record from a bounded bypass reason. HIT is reported only after the seeded
  segment decodes and supplies the match; an explicit route `cache()` scope that
  wins does not produce a false HIT. The browser and prefetch lock see the same
  partial payload as before. Pinned by `[PPR4]` and in both apps by the fresh
  replay, fresh transition-decision, and `stale SWR navigation replays the
captured handler promise, top-level handles, and Meta` dev+production e2e
  cases, plus `[PPR5]` for cold partial capture and prefetch replay.
- **Replay composes with route-derived `cache()` scopes, explicit tier first.**
  A ppr route under a `cache()` scope (including one inherited from an
  ancestor — the app-wide storefront shape) still replays. The consumer's tier
  is ALWAYS consulted first and serves under its own key/ttl/swr/tags/condition
  semantics, reported as `BYPASS; reason=explicit-cache-hit`; ONLY a true miss
  of that tier lets the shell snapshot's canonical doc segment record supply
  the match (the replay HIT). A `bypass` (cache(false), a false `condition()`,
  no store) or `error` outcome of the explicit lookup never falls back —
  opt-outs are absolute, and an errored read (throwing consumer `key()`, a
  store failure, or a built-in store's internally swallowed backend error,
  signaled via `CACHE_READ_ERROR`) keeps its render-uncached contract instead
  of serving across a key partition the tier never resolved
  (`CacheScope.lookupRouteDetailed` outcomes). To make composition
  possible, a capture of such a route records the canonical doc segment record
  into the shell snapshot IN ADDITION to the scope's normal store write
  (snapshot-only — never the real store), and stamps its key on the entry
  (`ShellCacheEntry.docKey`); replay eligibility requires that exact record.
  Three decisions bypass before any shell-store read: a partial without
  navigation context (`no-navigation-context`: no `X-RSC-Router-Client-Path`
  and no same-origin `Referer`, the predicate `getNavigationContextHeader`
  shares with `resolveNavigation`), a route whose baked prerender
  artifact EXISTS (`prerender-store` — probed through the memoized prerender
  store, because the trie's `pr` flag alone is not a serve guarantee for
  `Passthrough(Prerender())` params that render live), and a STATICALLY
  disabled scope (`cache(false)` → `cache-disabled`). The probe is a fast
  path, not the truth: it reads only the non-intercept artifact, and whether
  the navigation IS an intercept — and therefore which artifact variant the
  middleware reads — is resolved DURING the match (`findInterceptForRoute`;
  the `X-RSC-Router-Intercept-Source` header proves nothing in either
  direction). The match pipeline stamps one ordered post-match reason on the
  request context (`_pprReplayPostMatchReason`): the match context supplies
  `intercept`, then an actual prerender serve overwrites it with
  `prerender-store` because that is the response source. Every BYPASS is
  reclassified from it (`reclassifyReplayStatus`): a prerender
  serve reports `prerender-store`, an intercept resolution reports
  `intercept`, and both suppress the heal capture (a prerender capture
  records no doc record; an intercept never consults replay). A `condition()`
  predicate is deliberately NOT pre-decided — evaluating it at the gate and
  again at the lookup would let a false-then-true flap report cache-disabled
  while the explicit tier serves; the lookup's own refusal is reported
  post-match as the same `cache-disabled` (marker `onExplicitBypass`).
  The reverse flap heals: an entry captured while `condition()` was false
  legitimately lacks a snapshot (`no-segment-snapshot`), and a later request
  whose lookup did NOT refuse schedules the navigation-only heal capture —
  the capture derives from that request's context, so its doc record records
  and replay becomes available without waiting for a document recapture. Pinned
  by `[PPR6]`, the storefront-shape dev+production e2e cases in both apps
  (`shell-cache`, `ppr-shell`), the passthrough existence-probe cases in
  `prerender-ppr` and `ppr-shell`, and the
  `cache-lookup-shell-replay-fallback` / `cache-store-shell-doc-record` units.
- **Capture-generation invalidation is observable.** Built-in shell stores return
  `invalidated` when a tag marker rejects a capture that started before the
  invalidation. The capture emits a `refused` event with
  `storeWrite: "invalidated"`, warns once, and enters normal refused-capture
  backoff. A render that deterministically invalidates its own shell tag therefore
  stays uncached, but it no longer fails silently or recaptures on every request.
- **The consumption-lane rule.** For every shared-artifact capture — `cache()`,
  `"use cache"`, and the PPR shell — HOW a loader is consumed decides its lane:
  - Server-side handler consumption (`await ctx.use(loader)`) is the BAKED
    lane: the loader executes during capture and its value freezes as a
    capture-time copy, like the rest of the handler output. That holds even
    for a loader also registered live-lane on the route: the handler's own
    read bakes, and only the registration's `useLoader` read stays a hole.
  - The tiers split on identity reads (`cookies()`, `headers()`, a
    `{ cache: false }` variable) inside that loader. `cache()` still PERMITS
    them (`isInsideCacheScope` exempts any loader body): the value bakes as a
    shared copy — a documented footgun. `"use cache"` REFUSES them: a loader
    body entered inside the cached function runs in its exec scope, and its
    value is part of what the function returns. The order does not matter
    (#1011): when a handler or a `loader()` binding started the loader
    first, the cached function's `ctx.use` (or `getRequestContext().use`)
    read of the memo rejects once the
    value settles if that run (or a run it read) recorded an identity read
    (`LoaderRunIdentity`, `readStartedLoaderValue` in `cache/cache-tag.ts`),
    and a read that settles after the value fails the entry's write
    (`assertLoaderReadsClean`). A PPR capture REFUSES them
    too (`guardIdentityRead` trips the capture before any loader-body
    exemption), so nothing is stored and the route serves axis 1. Why the
    split: while a PPR HIT re-ran handlers, a slot handler's `ctx.use` of an
    identity loader rendered per visitor on the HIT, so exempting it was safe.
    Every HIT now replays the capture's copy, and the exemption would bake the
    capturing request's cookie into every visitor's page. A `cache()` HIT is a
    separate tier and keeps its old contract.
  - Client-side consumption (`useLoader` in a `"use client"` component) is the
    LIVE lane: fresh per request, per visitor. A slot-owned identity loader
    under PPR is registered live-lane (`loader()` without `ssr: false`, the
    slot's `loading()` as its boundary) and read client-side.
  - DSL `loader()` segments follow their PPR lane (lane rule above; the bake
    lane runs WITH the identity guard active).
    Pinned by the `[PPR3]` semantic matrix row ("handler consumption of a
    loader bakes; an identity read in it refuses the capture; a registered
    live-lane slot loader read client-side stays a live hole") and
    `src/rsc/__tests__/shell-handlers-baked.rsc-test.tsx` ("cookies() in a
    loader the handler awaits") and `e2e/shell-cache.test.ts` ("handler
    ctx.use of a loader (...): the handler's copy is frozen, the slot's
    useLoader read stays live"; "a handler-awaited loader reading cookies()
    refuses the capture"); cache()-tier precedent pinned by the blog-cache
    suites (frozen sidebar on ring-3 hits).

### PPR HIT: no handler runs

A PPR document HIT commits the stored prelude and then renders a tail behind
it. The invariant: that tail never runs a route handler, layout handler, or
parallel-slot handler. The handler layer comes from the shell entry's own doc
segment record — the same record the capture rendered its prelude from — so
the prelude and the hydration payload cannot disagree, and nothing that
depends on handler timing can drift between them. What still runs on a HIT:
the full middleware chain (before the commit) and the loaders (live-lane
holes, and `ssr: false` loaders re-running against their pinned reads).

How the tail is held to it: `serveShellHit` (`src/rsc/rsc-rendering.ts`) arms
the `_shellImplicitCache` marker with `docTail: true` and
`fixedDocKey: entry.docKey`. `resolveShellImplicitCacheScope`
(`src/cache/cache-scope.ts`) then returns the implicit doc scope even for a
route with its own `cache()` scope, and that scope looks the record up by the
entry's key, so a store `keyGenerator`, a route `key()`, or a build-time
capture host cannot send the lookup elsewhere. When the lookup does not hit,
`withCacheLookup` (`src/router/match-middleware/cache-lookup.ts`) throws
`ShellRecordUnavailableError` instead of resolving segments, and the match
pipeline's catch (`src/router/match-handlers.ts`) rethrows it without an
`onError` report.

The gate before the commit (`shellServePlan`) decides the cases a replay could
not honor:

| Case                                                                                               | Outcome                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The route's own `cache()` refuses this request: `cache(false)`, or a `condition()` returning false | Axis 1 like a cache miss: no `x-rango-shell` header, no capture scheduled |
| Document entry without `docKey`, non-Prerender route                                               | MISS, recaptured                                                          |
| Document entry without `docKey`, Prerender route (`matched.pr`)                                    | HIT; the tail takes the handler layer from the prerender store            |
| Entry with `docKey`                                                                                | HIT; the tail replays the doc record                                      |

The degrade, when the record fails anyway (it did not decode, or the entry
lost it): `serveShellHit` catches `ShellRecordUnavailableError` and calls
`degradeUnreplayableShell` for a broken entry. It overwrites the entry with a
tombstone (a `navigationOnly` entry with no document half and no snapshot,
which document serving treats as a MISS; the store has no shell delete),
drops the isolate's memo (`dropShellMemo`), and schedules a recapture. A
snapshot read that was only slow (`snapshotFailure: "unavailable"`) leaves
the entry alone. Either way the response ends with a script that reloads once
with the forced-MISS marker `_rsc_shell=miss`. The handler strips the marker
from the request on entry (`withoutShellMissMarker`) and keeps only the flag
(`RequestContext._shellForcedMiss`), which the serve gate renders on axis 1
(no shell read, no capture), so the reload cannot degrade again and nothing
downstream reads the marker. No
handler runs behind the committed prelude at any point.

Pinned by `src/rsc/__tests__/shell-handlers-baked.rsc-test.tsx` (`PPR handlers
baked: no HIT runs a handler`: a route `cache()` whose explicit tier lost its
record, a route `key()` resolving another key, a store `keyGenerator`, and
`cache(false)` rendering axis 1), `src/rsc/__tests__/shell-snapshot-prune.rsc-test.tsx`
(the `condition()` genuine MISS, the corrupt-record degrade and its tombstone),
and `src/rsc/__tests__/rsc-rendering-shell-ppr.test.ts` (the degrade through
the sentinel).

## Handler Loading Contract

Route handlers support two loading strategies: **sync** (default) and **lazy**
(deferred to first matching request).

### Supported handler shapes on `RouteEntry`

| Shape                            | When produced                  | Example                                 |
| -------------------------------- | ------------------------------ | --------------------------------------- |
| `() => Array`                    | `urls()` — sync DSL evaluation | `urls(({ path }) => [path("/", Page)])` |
| `() => Promise<{ default: fn }>` | Dynamic import wrapper         | `{ handler: () => import('./urls') }`   |
| `() => Promise<fn>`              | Lazy function wrapper          | `{ handler: () => loadUrls() }`         |

**Unsupported**: `() => Promise<Array>` (async route-tree construction).
Rejected at runtime with a diagnostic error. TypeScript structural compatibility
cannot catch this statically, so a runtime guard is essential.

### Lazy includes vs async handlers

These are two distinct code paths in `loadManifest()`:

1. **Lazy includes** (`entry.lazy && entry.lazyPatterns` branch): All `include()`
   calls are lazy by default — patterns are evaluated on first matching request
   via `evaluateLazyEntry()`. This is the primary user-facing lazy-loading
   mechanism, exercised by every included route in the e2e test suite.

2. **Async handler results** (the `result instanceof Promise` branch): Handles
   `Promise<{ default: fn }>` and `Promise<fn>` shapes on `RouteEntry.handler`.
   This is an **internal-only** mechanism — the public API (`urls()`, `include()`)
   always produces sync handlers. Coverage is at the unit/integration level
   (`router/__tests__/debug-manifest.test.ts`), not semantic e2e, because the
   async handler branch is not reachable through the public API surface.

### Policy: lazy loading yes, async construction no

Lazy **module loading** is supported — defer evaluation until first request.
Async **route-tree construction** is not — the DSL handler itself must be
synchronous once resolved. The handler receives route helpers and must call
them synchronously so that the ALS (AsyncLocalStorage) context captures all
side effects in the correct store.

### Contract change requirements

Any change to handler loading shapes must update:

1. Runtime enforcement in `manifest.ts` and `debug-manifest.ts`
2. Type definition in `types/route-entry.ts`
3. Type-level tests in `__tests__/route-entry-handler-types.check.ts`
4. Unit tests in `router/__tests__/debug-manifest.test.ts`

### Limitation: a Response from an async handler under `loading()` is not a redirect

On a route **without** `loading()`, a handler that returns or throws a `Response`
(e.g. `redirect()`) short-circuits to an HTTP redirect: the handler is awaited at
the resolution boundary, so the thrown `Response` propagates out to `match()`
and becomes a 302/308.

On a route that declares `loading()`, the handler result is **streamed** — it is
not awaited at the resolution boundary (`segment-resolution/fresh.ts`). So an
**async** handler that returns a `Response` has that `Response` surface only
during RSC serialization, where it is rendered into the stream via React's
error boundary instead of becoming an HTTP redirect. A **synchronous** `Response`
return on a `loading()` route still throws synchronously and redirects correctly;
only the async/Promise sub-branch is affected. Parallel slots with `loading()`
share this behavior.

To redirect from a `loading()` route, issue the redirect from middleware, a
loader, or a synchronous handler return. In development, `warnOnStreamedResponse`
(`segment-resolution/helpers.ts`) logs a warning when a streamed handler resolves
or rejects with a `Response`, so the swallowed-redirect failure mode is visible.

## Loader Context: params vs routeParams

Loaders receive two param fields:

- `ctx.params` — merged route params + explicit loader params. When a fetchable
  loader is called with `load(Loader, { params: { ... } })`, the explicit params
  override route-matched params.
- `ctx.routeParams` — server-trusted route params extracted from URL pattern
  matching. These cannot be overridden by client-provided loader params.

Use `ctx.routeParams` when the loader needs trusted route identity for
authorization or resource scoping (e.g., verifying the user owns the resource
at the matched URL). Use `ctx.params` for general data fetching where
client-provided params are acceptable.

### URL params: absent optionals are `undefined`

Absent optional segments (`:locale?`) are **omitted from the params record**
at runtime — `ctx.params.locale` reads as `undefined`, not `""`. This
matches the `RouteParams<"name">` type (`{ locale?: string }`) and the
public `useParams()` default (`Record<string, string | undefined>`).

| Pattern             | URL    | `ctx.params`         |
| ------------------- | ------ | -------------------- |
| `/:locale?`         | `/`    | `{}` (locale absent) |
| `/:locale?`         | `/en`  | `{ locale: "en" }`   |
| `/:locale?/c/:slug` | `/c/x` | `{ slug: "x" }`      |

Internal consumers tolerate both forms — `satisfiesConstraints` and
`reverse()` treat missing/undefined and `""` identically — so caller code
or `getParams()` shapes that pass `""` explicitly continue to work.

## Async Context Propagation

The router uses `AsyncLocalStorage` to maintain request context across all
execution phases. This context is established once per request and remains
readable through async/streaming boundaries.

### Request scope (`router.use(...)`)

Bindings set by global middleware are request-scoped. They are visible to:

- global middleware (subsequent `.use()` handlers)
- route middleware
- route handlers, layouts, orphan layouts, and parallel slots
- loaders (via `getRequestContext()`)
- server actions
- intercept handlers
- async server components, including after `await`
- streamed components behind `loading()` boundaries

### Render scope (`middleware(...)` in `urls()`)

Bindings set by route middleware are render-scoped. They are visible to:

- route handlers, layouts, orphan layouts, and parallel slots
- loaders (via `getRequestContext()`)
- async server components during the render pass
- post-action revalidation renders (route middleware wraps revalidation) —
  pinned by the `[A1]` semantic matrix row
- PE full rerenders (route middleware wraps the rerender) — pinned by the
  `[A2]` semantic matrix row

Initial-render visibility of middleware context vars and cookies to layouts
and loaders — request scope and render scope alike — is pinned by the `[MW1]`
semantic matrix row.

Route middleware does **not** wrap action execution. Actions see only
request-scoped bindings from `router.use(...)`. This is a hard contract
boundary, not an accident.

Route middleware has two placement modes:

- **Sibling mode** — `middleware(fn)` or `middleware([fn1, fn2])` attaches
  middleware to the parent entry (layout, path, etc.).
- **Wrapping mode** — `middleware(fn, () => [...])` or
  `middleware([fn1, fn2], () => [...])` creates a transparent layout that
  scopes the middleware to its children only.

The variadic form `middleware(fn1, fn2, fn3)` is not supported. Use
`middleware([fn1, fn2, fn3])` to pass multiple middleware.

### Intercept scope

Bindings set by intercept middleware are visible only to the intercept
render path. Direct navigation to the same target route does not execute
intercept middleware. Pinned by the `[I2]` semantic matrix row.

Soft navigation triggers the intercept only when the route's `when()`
selector returns true for the navigation's `from`/`to` locations
(`{ url, params, routeName }`); when it returns false, the
soft navigation renders the full target page with no intercept. Pinned by the
`[I1]`/`[W1]` semantic matrix rows.

### Async and streaming limits

Async server components inherit the request ALS through render and streaming.
`getRequestContext()` remains readable after `await` and inside streamed
children behind `loading()` boundaries.

However, late streaming may hit separate feature-specific mutation limits.
Handle data (`ctx.use(handle)`) is accumulated into a `HandleStore` that
settles independently. Read probes (reading context variables) are safe
throughout streaming; mutation APIs (like handle pushes) have their own
deadlines documented in `server/handle-store.ts`.

## Fetchable Loader Middleware

Fetchable loaders accept per-loader middleware via the object form:

```ts
createLoader(fn, { middleware: [authMw, rateLimitMw] });
```

This middleware runs **only** on `_rsc_loader` fetch requests (client-initiated
`load()` / `useFetchLoader()` calls). It does **not** run during:

- SSR render-time `ctx.use(loader)` execution
- Navigation-triggered loader resolution
- Build-time pre-rendering

The execution path is:

```text
_rsc_loader request
  -> global middleware (router.use)
  -> fetchable loader middleware (per-loader)
    -> loader function
```

This is intentional: during SSR, the loader runs inside the route middleware
scope and inherits its protections. The per-loader middleware exists to guard
the standalone fetch endpoint, which bypasses route middleware entirely.

## Client Refresh Fan-out

This is a **client-only** contract: which mounted `useLoader` / `useFetchLoader`
reads observe the result of a `load()`. It is independent of the server
execution model above and of `cache()` / `revalidate()`; it never changes the
request sent to the server. Owned by `src/use-loader.tsx` + `src/loader-store.ts`
(the per-tab module-level `loaderStore`). The store is partitioned into buckets;
each bucket key is `loader.$$id`, or `loader.$$id + key` when the hook is given
an explicit client refresh `key`. Buckets of one loader form a family (indexed
by `$$id`) so a route-context reset can clear them together.

| `load(...)` call                     | No `key`                                        | With `key`                         |
| ------------------------------------ | ----------------------------------------------- | ---------------------------------- |
| `load()` (or GET, no params/body)    | shared by `$$id` iff loader is in route context | shared by `$$id + key`             |
| `load({ params })`                   | local to the calling hook                       | shared by `$$id + key`             |
| `load({ method: non-GET })` / `body` | local to the calling hook                       | local to the calling hook          |
| loader not in route context          | local to the calling hook                       | shared by `$$id + key` (ephemeral) |

`isLoading` and `error` follow the bucket, with one navigation-driven addition:
a route-context reader whose content is HELD on screen by a transition commit
(browser/partial-update.ts) while its loader is still streaming reports
`isLoading: true` until that commit lands. Every transition commit goes through
`commitInTransition` (browser/partial-update.ts; `renderRoute`'s navigate() in
testing/render-route.tsx reuses it for a `transition()` chain), which calls
`loaderStore.announcePendingStreams(segments)` INSIDE its `startTransition`:
that registers each loader segment whose data is still a pending promise
(settled Flight chunks — cached/reused segments, forceAwait lanes — are skipped
via `unwrapsSynchronously`, thenable-status.ts) and fires each route-context
subscriber's `onStreamPending`; the hook answers with a `useOptimistic` pin —
React renders it urgently and reverts it in the commit that brings the new
data, so the flag never flashes `false` on the old data (the stream settles a
beat before React commits, and a suspended navigation lane is excluded from a
transition batch, which rules out a timed release). Urgent commits (cold nav
mounting new segments) skip the announce: nothing is held there. Ephemeral
readers subscribe without `onStreamPending` and are never pinned.
`throwOnError: true` render-throws are
scoped to the **originating** hook: a shared error is thrown only by the hook
whose `load()` produced it (matched on the bucket's `requestId`); co-bucket
siblings expose it via `error` without throwing. A successful follow-up `load()`
clears the shared error.

Bucket reset has two boundaries:

- **Sticky buckets** (any route-registered reader subscribed) reset on
  route-context change via `clearFamily(loaderId)` — navigation / action
  revalidation re-seeds them from fresh `loaderData`.
- **Ephemeral buckets** (only ever read by hooks with no route context — keyed
  `useFetchLoader` of an unregistered loader) have no route-context trigger, so
  they are reference-counted: dropped once the last subscriber unsubscribes
  (deferred a microtask, cancelled on resubscribe, held until any in-flight load
  settles). A persistent reader outside the outlet keeps its value across a
  navigation; a route-scoped reader's value is reclaimed on unmount.

**Cross-loader refresh groups.** `key` partitions readers of one loader; the
`refreshGroup` option + `useRefreshLoaders()` refresh **different** loaders
together. A read may be tagged with one group name or several (`refreshGroup` is
`string | string[]`), and the inverted hook takes the group(s) at call time:
`useRefreshLoaders()` returns `refresh(groups: string | string[])`. The store
keeps a `groups: Map<name, Set<bucketKey>>` index, with membership refcounted per
subscriber on each entry (`entry.groups: Map<name, count>`) so a bucket can belong
to several groups at once — whether from one read carrying multiple tags or
different reads tagging the same keyed bucket — and leaves a group only when that
group's last subscriber unmounts, independent of subscribe/unsubscribe order.
`refreshGroups(names)` unions the member buckets across every named group (deduped
by bucket key, so a bucket in two of the named groups fetches once), runs each
member's registered plain-GET thunk (current route URL, no params/body),
`Promise.allSettled`s them, and rejects with an `AggregateError` on any failure.
Group refresh never render-throws — failures surface via each member's `error` and
the returned promise; handle them at the await site. It is GET-only by design: a
group spans heterogeneous loaders, so there is no coherent params or aggregate
return type.

A grouped reader with **no explicit `key`** is given a private per-hook bucket
(`loader.$$id::<private>`) rather than the bare `loader.$$id` bucket. Otherwise a
group refresh would write the shared loader-id bucket and leak into unrelated
unkeyed reads of the same loader, which the fan-out table keeps local. Sharing a
value within a group is therefore opt-in via a common `key`.

## Non-Guarantees

- Route middleware is not an action guard.
- Partial revalidation does not implicitly recompute non-revalidated ancestors.
- A fill request (`prefetch: false`) does not recompute the handlers the
  prefetch already rendered: `ctx.set()` values from outside the deferred unit
  are not visible to deferred work, and no `revalidate()` contract changes
  that.
- `ctx.set()` values do not cross arbitrary sibling boundaries.
- Parallel slots do not share a single global context; visibility is structural.

## Context Scope Rules

Context visibility follows tree location, not component appearance.

Example shape:

```text
layout
  |- path("/")
  |    |- orphan layout
  |         |- parallel("@sub-panel")
  |- orphan layout (sibling of path)
  |    |- parallel("@orphan-panel")
  |- parallel("@panel")
```

Expected visibility pattern:

- `@sub-panel` can see path-local handler data and outer layout data.
  Pinned by the `[S1]`/`[S4]` semantic matrix rows.
- `@orphan-panel` can see outer layout data, not path-local handler data.
  Pinned by the `[S2]`/`[S5]` semantic matrix rows.
- layout-level `@panel` can see layout data (handler-first), not path-local handler data.
  Pinned by the `[S3]`/`[S6]` semantic matrix rows.

### Cache-safety contract for context variables

Context variables have a cache-safety flag controlled at two levels:

- **Var-level**: `createVar<T>({ cache: false })` — all values are non-cacheable.
- **Write-level**: `ctx.set(var, value, { cache: false })` — this specific value
  is non-cacheable, even if the var itself is cacheable.

"Least cacheable wins": if either the var or the write says `cache: false`, the
stored value is non-cacheable.

**Enforcement is at read time, not write time.** `ctx.set()` stores the
cache-safety metadata alongside the value but does not throw. When `ctx.get()`
is called inside a cache scope (detected via ALS — same mechanism as the
existing `"use cache"` guards), it checks the stored metadata and throws if
the value is non-cacheable. The guard is `assertNonCacheableReadAllowed` in
`server/context.ts`, a one-line wrapper over `guardIdentityRead`, the same
guard `cookies()`, `headers()` and the theme reads go through, so a
non-cacheable read refuses in exactly the places they do. The request,
handler, loader and response-route `ctx.get()` call it once `isNonCacheable()`
matches (a middleware `ctx.get()` only inside a `"use cache"` body). In order:

- During a PPR shell capture it flags the capture context (read from the
  ambient request context) and throws, so a caught throw still refuses the
  capture. A non-cacheable read anywhere the capture waits — a handler, a
  promise it passes or pushes, an async server component, a bake-lane loader,
  a loader a handler awaits — refuses the capture. There is no loader-body
  exemption here.
- Inside a `"use cache"` body (the exec scope in `cache/cache-exec-scope.ts`)
  it throws, and that includes a loader body entered inside the cached
  function (`await ctx.use(Loader)` there): the loader's value is part of
  what the function returns, and the cache key does not include its value.
  Before, that loader body was exempt while `cookies()` threw there, and the
  entry stored the first request's value.
- Inside a `cache()` boundary (`isInsideCacheScope()`) it throws, except
  inside a loader body: a route `cache()` never stores loader values.

A cacheable (normal) variable is not guarded at capture and bakes with the
capturing request's value: shell
material is shared per host+URL and request partition (the route's
`cache({ key })` or the store's `keyGenerator`, `resolveShellPartition`).

- `ctx.get(cacheableVar)` inside cache scope: allowed.
- `ctx.get(nonCacheableVar)` inside cache scope: throws.
- `ctx.set(var, value)` inside cache scope: allowed for cacheable vars (children
  are also inside the cache boundary).
- Response-level side effects throw inside cache scope regardless of cache-safety
  flag: from a handler, `ctx.headers.set/append/delete()` (the guarded Headers
  proxy) and `cookies().set/delete()` (the cookie-store guard); from middleware
  wrapping the cached render, `ctx.header()` / `ctx.headers.*`. (`setStatus()` /
  `setCookie()` / `onResponse()` live on the full request context, not the handler
  or middleware `ctx`.) DSL loaders are exempt — see below.

### Loader access paths and cache safety

DSL loaders (registered with `loader()`) and handler-called loaders
(`ctx.use(Loader)`) have different cache-safety guarantees:

- **DSL `loader()` + client `useLoader()`** — the recommended path. A
  segment `cache()` never stores DSL loader data: DSL loaders re-execute on
  every request, even inside `cache()` boundaries. The one opt-in is the
  binding's own `cache()`, `loader(Def, () => [cache({ ttl })])`, which reads
  through the loader store (`executeLoaderData` in
  `segment-resolution/loader-cache.ts`). A hit skips the loader body and
  replays its recorded handle pushes. It applies on every DSL loader path —
  fresh, revalidation and intercept (#884) — and never to a handler's
  `ctx.use(Loader)` read. Because a segment cache never captures them:
  - `ctx.get()` bypasses non-cacheable read guards (unguarded context).
  - Global helpers that touch the response (`cookies().set()`,
    `cookies().delete()`, `headers()`) are allowed inside loader
    functions. `LoaderContext` itself does not expose `setCookie` or
    `header` — loaders access these through the module-level helpers
    imported from `@rangojs/router`, which delegate to the request
    context. The cache-scope guard is bypassed via a dedicated
    `loaderScopeALS` that tracks loader execution separately from the
    `insideCacheScope` flag on `RangoContext`.
  - This applies to all DSL loader resolution paths: fresh, revalidation,
    and intercept.

- **`ctx.use(Loader)` in handlers** — escape hatch for reading loader
  data in handlers. The loader function itself runs fresh, but the
  handler embeds the result in JSX that is cached with the segment. On
  cache hit the handler does not re-execute, so the embedded value is
  served from the stored shell. For request-scoped data (a loader that
  reads `cookies()`/`headers()`) this is not merely stale — it is a
  **cross-user leak**: one visitor's value, baked into the shared shell,
  is served to later visitors until the entry expires. The cache-purity
  guard does **not** catch this, because the request-scoped read happens
  inside the (exempt) loader body, not in the handler. **Do not embed a
  request-reading loader's result via `ctx.use()` in a cached handler —
  consume it with `useLoader()` in a client component instead** (a fresh,
  never-cached segment). Non-cacheable variable reads in the handler
  itself still throw via the normal read guard. Response-level side
  effects in handler code throw normally. A PPR shell capture and a
  `"use cache"` body are stricter than `cache()` here: `guardIdentityRead`
  has no loader-body exemption in either, so the request-scoped read inside
  the handler-awaited loader throws instead of baking the leak. A capture
  refuses (the route serves axis 1); a `"use cache"` function stores
  nothing.
  Note: when a loader is registered via both DSL `loader()` and called
  via `ctx.use()` in the same route, the DSL registration starts the
  loader in loader scope before the handler runs. The handler's
  `ctx.use()` call returns the memoized promise — it does not re-execute
  the loader function. The loader scope bypass applies because the
  function originally started under `runInsideLoaderScope`.

This is a deliberate design decision: DSL loaders are the semantically
strong path for request-specific data. `ctx.use(Loader)` is supported
for convenience (e.g., setting context variables from loader data) but
should not be treated as equivalent.

## Revalidation Contract

- Revalidation is segment-scoped and opt-in by rules (`revalidate(...)`).
- Default decisions during action revalidation (no `revalidate()` configured;
  seeds for user predicates — see `evaluateRevalidation` in
  `router/revalidation.ts`):

  | Segment                                                | Default | Trace reason               |
  | ------------------------------------------------------ | ------- | -------------------------- |
  | route segment                                          | `true`  | `action:route-segment`     |
  | loader segment                                         | `true`  | `action:loader-segment`    |
  | `belongsToRoute` child (orphan layout, entry parallel) | `true`  | `action:belongs-to-route`  |
  | parent-chain segment (outer layout, its parallels)     | `false` | `action:parent-chain-skip` |

  Consequence: a route entry re-runs as a unit on actions (handler-first
  preserved), so handler `ctx.set()` data consumed by the entry's own
  children needs no contract. Producer/consumer contracts are required only
  when narrowing with a hard `false` predicate or when the producer is an
  outer entry. The consumer-facing ladder is documented in
  `skills/rango/SKILL.md` ("Passing data down the tree").

- **First-render guarantee (client-knowledge seed).** A segment absent from the
  request's client-segment set (`_rsc_segments`) always renders. The client has
  no cached copy of it, so a `false` decision would emit `component: null` and
  leave a hole rather than keep anything on screen. Predicates may raise that
  decision, never lower it. All four resolvers in
  `router/segment-resolution/revalidation.ts` honour it, in two shapes:

  | Resolver                                                   | Shape                                                        |
  | ---------------------------------------------------------- | ------------------------------------------------------------ |
  | loaders, layout/route entries, orphan-layout entries       | early return `true`; user predicates never run               |
  | parallel slots (`resolveParallelSegmentsWithRevalidation`) | `defaultOverride.floor` — predicates run, but can only raise |

  The parallel path differs deliberately. PR #482 made it consult predicates
  even for an unknown slot, so a `skip-parent-chain` seed (`false`) could still
  be raised to `true`, and so a predicate that throws a `Response`
  (`throw redirect(...)`) still performs control flow. Flooring instead of
  early-returning keeps both of those while restoring the guarantee. Regressing
  it blanks the slot on the navigation that first introduces it while a direct
  load looks fine — pinned by `parallel-revalidate-fns-invocation.test.ts`
  ("new-segment floor") and three dev+production e2e specs.

- During partial action revalidation:
  - only revalidated segments recompute
  - non-revalidated ancestors do not rerun just to rebuild `ctx.set()` state
  - downstream `ctx.get()` calls therefore see missing/`undefined` upstream
    values unless the producer reruns; the router does not preserve a prior-pass
    ancestor snapshot for you — pinned by the `[R1]` semantic matrix row
- If a child depends on data set by an outer segment:
  - revalidate that outer segment too, or
  - load/guard the data in the child independently.

- **A fill request (`prefetch: false`) is the same rule with no way out.**
  Deferred work runs in the fill, after the prefetch already rendered the
  rest. Middleware runs there as on any render pass, so what middleware puts
  in context is there. Handlers outside the deferred unit do not run: the
  client holds their segments, and a fill skips a held segment without asking
  its `revalidate()`. So a value a held handler would have set with
  `ctx.set()` is `undefined` to the deferred work, exactly like the `[R1]`
  case above.

  The difference from an action revalidation is that you cannot fix it with a
  `revalidate()` contract: predicates are not consulted in a fill. A flagged
  loader that needs a value from a layout above it has three options: read it
  from middleware context instead, compute it in the loader, or move the
  `loading(fallback, { prefetch: false })` up to the entry that produces the
  value so the producer is deferred with its consumer (inside one deferred
  unit the handler-first order holds as usual).

  The same reasoning is why a deferrable loader cannot call `ctx.rendered()`:
  the barrier waits for handlers that a fill does not run. That one is a hard
  error rather than a silent `undefined`
  (`docs/internal/rendered-barrier.md`, "Guard Rules").

### Revalidation Contracts Pattern

For shared `ctx.set()` data, prefer named revalidation contracts and reuse
them on both producer and consumer segments.

```ts
// revalidation-contracts.ts
export const revalidateCartData = ({ actionId }: { actionId?: string }) =>
  actionId?.includes("src/actions/cart.ts#addToCart") ?? false;
```

```ts
layout(CartLayout, () => [
  revalidate(revalidateCartData), // producer reruns
  path("/cart", CartPage, { name: "cart" }, () => [
    revalidate(revalidateCartData), // consumer reruns
  ]),
]);
```

Multiple dependency domains can coexist. Compose multiple contracts in the same
segment when it depends on multiple upstream data sources.

```ts
layout(ShellLayout, () => [
  revalidate(revalidateAuthData),
  revalidate(revalidateCartData),
  path("/checkout", CheckoutPage, { name: "checkout" }, () => [
    revalidate(revalidateAuthData),
    revalidate(revalidateCartData),
  ]),
]);
```

### Contract Handoff Helpers

To avoid repeating `revalidate(contract)` at each callsite, package contracts
as reusable DSL helpers that can be imported and spread into any segment.

```ts
// revalidation-contracts.ts
import { revalidate } from "@rangojs/router";

export const revalidateAuthData = ({ actionId }) =>
  actionId?.includes("src/actions/auth.ts#") ?? false;

export const revalidateCartData = ({ actionId }) =>
  actionId?.includes("src/actions/cart.ts#") ?? false;

export const revalidateAuth = () => [revalidate(revalidateAuthData)];

export const revalidateCart = () => [revalidate(revalidateCartData)];
```

```ts
import { revalidateAuth, revalidateCart } from "./revalidation-contracts";

urls(({ path, layout }) => [
  layout(ShellLayout, () => [
    revalidateAuth(),
    revalidateCart(),
    path("/checkout", CheckoutPage, { name: "checkout" }, () => [
      revalidateAuth(),
      revalidateCart(),
    ]),
  ]),
]);
```

## Prerender Contract

- Prerender build passes are full render passes.
- Child layouts/parallels inside the prerendered path can read handler-set data
  in that same build render pass. Pinned by the `[PR1]` semantic matrix row.
- Runtime passthrough and action revalidation still follow partial revalidation
  rules. Pinned by the `[PT1]` semantic matrix row.

## Middleware Placement Guidance

- Use global middleware for request-level concerns:
  auth guards, request ownership, coarse policy checks.
- Use route middleware for render-level concerns:
  context shaping for handlers/layouts, render headers, route-scoped cookies.
- Use wrapping middleware to scope middleware to a subset of routes
  without introducing a visible layout:
  `middleware(authMw, () => [path("/admin", AdminPage)])`.
  This creates a transparent layout (renders `<Outlet />`) that carries
  the middleware only for its children.

## PE vs JS Parity Expectations

For equivalent action intents, JS and PE paths should match on:

- render visibility of route middleware effects
- cookie/header propagation in responses
- segment data expectations for revalidated/rerendered scopes

When behavior diverges, treat it as a contract bug unless explicitly documented.

## Contract Change Process

Any semantic change to this model must include:

1. updates to this document
2. updates to affected skill docs
3. semantic e2e coverage for dev + production
4. review against the semantic checklist:
   [semantic-change-checklist.md](./semantic-change-checklist.md)
