# Shell Fast Path: the shell entry as a cache() of the handler layer

Status: v1 IMPLEMENTED on `feat/shell-fast-path` (2026-07-05); the "v1 as
built" section below is the authoritative record of what shipped and why it
needed almost no new machinery. Prerequisite work (capture-time
nested-thenable masking) shipped in PR #692; the instrumentation that produced
the numbers below shipped in PR #691 and PR #693.

## Why (the measurements that motivated this)

On a consumer storefront (workerd, PPR homepage, SFCC + Builder.io + CIO
upstreams), a shell HIT commits headers at ~25ms — and then spends its entire
tail re-running the handler layer to produce a payload the capture already
produced once:

- `ctx.router.match()` on the tail re-executes middleware, segment
  resolution, and every route handler. With the app's handler data sources
  `"use cache"`'d, the re-run costs ~26-36ms — cheap, but pure waste.
- The full Flight render re-serializes the whole tree per HIT (the payload
  cannot be resumed — a React limitation), even though only the loader
  carve-outs differ from the capture's payload.
- Prefetch renders pay the full path too: each PDP prefetch off the homepage
  measured ~2.5s (cold Builder cache key + CIO), starving the interactive
  tail in the same isolate.
- The remaining tail latency was the LIVE lane (per-session upstream auth
  awaited inside chrome loader containers: 709ms fresh session → 247ms warm)
  — work this design deliberately keeps, because it is the honest floor.

So the question: why does a HIT run the handler layer at all?

## The consumer contract, in one sentence

**Only loaders are dynamic.** Middleware guards the request (live control),
loaders load the data (live data), handlers render the page (cached).
Everything else — handles, props, trees — inherits its lane from which of
those three it rides. That is the entire PPR / cache() / prerender story a
consumer has to learn, and it requires NO API change: the primitives already
mean this; the fast path just makes the runtime agree with the mental model.

## The model

**The shell entry is a cache() of the handler layer, with loader records as
the live carve-outs.**

A HIT becomes:

```
middleware  →  loaders  →  replay stored payload fragments
                           + generate fresh loader records
                           + regenerate per-request metadata rows
                           →  stream (prelude bytes + spliced payload)
```

No handler execution. No full Flight render. Prelude/payload parity holds by
construction — the payload IS the capture's payload, holes filled fresh.

What stays on the full path (one code path, entered less often): MISS,
preview/editing modes, actions and progressive enhancement, and anything the
eligibility rules below exclude.

## Eligibility is the cache purity rule — and it already shipped, piecemeal

The objection "handlers do per-request work (notFound, redirects, preview
branches), you cannot bake them" dissolves because capture eligibility
already encodes the purity contract:

- We only capture 200s. A 404/redirect decision never becomes a shell entry.
- The identity guard refuses captures whose render reads request identity
  (`cookies()`/`headers()`), so an entry never encodes a handler that
  branches on the requester.
- Per-REQUEST divergence (auth walls, entitlement) lives in middleware —
  which runs live on every HIT.
- Per-TIME divergence (a URL mapping gains a redirect mid-TTL) heals by TTL
  plus recapture — ordinary cache staleness, same blast radius as the prelude
  already has today.

No new consumer contract is required. The contract exists; this design names
it and rides it.

## v1 as built: the implicit doc-cache scope

The investigation that preceded the build collapsed the design to something
much smaller than fragment splicing: **the cache() hit lane already IS the
fast path**, end to end, in production today — for routes wrapped in
`cache()`. `withCacheLookup` (match-middleware/cache-lookup.ts) is the
innermost pipeline phase; on a hit it deserializes the stored segments,
replays handle data, and runs `resolveLoadersOnly` — loaders fresh, handlers
never executed. The doc-level entry (`doc:{host}{pathname}…`, ALL non-loader
segments in one `CachedEntryData`) is written by `cacheRoute`, and the shell
snapshot machinery (PR #691) already records segment-family writes into the
`ShellCacheEntry.snapshot` at capture and replays them through the
`SeededShellStore` on a HIT.

What was missing was only the connective tissue — the shell had no way to say
"treat the whole matched route as a cache() boundary" for routes that never
opted into `cache()`. v1 is exactly that, four small pieces:

1. **`resolveShellImplicitCacheScope`** (cache/cache-scope.ts), applied at the
   FULL MatchContext construction site (match-api.ts): when the route tree
   derived NO cache scope and the request context carries the
   `_shellImplicitCache` marker, substitute an enabled doc-level scope. A
   route-derived scope — including an explicit `cache(false)` — always wins.
2. **Capture side** (shell-capture.ts): the derived capture context sets the
   marker with a `SnapshotOnlySegmentStore` — the capture's `cacheRoute`
   write records the doc segment entry into the snapshot ONLY, never the real
   store (a passthrough write would make the NEXT capture's lookup hit the
   previous generation and never re-run handlers, breaking SWR recapture
   freshness).
3. **Serve side** (rsc-rendering.ts serveShellHit): the seeded tail context
   sets the marker when the entry is eligible; the tail's `ctx.router.match()`
   then HITs the seeded doc record and the handler layer is REPLAYED, not
   re-executed. Per-request payload metadata (initialTheme replay,
   locationState, …) is rebuilt by `buildFullPayload` exactly as before —
   there is no `root` on the wire; only `metadata.segments` content replays.
4. **Eligibility** (`ShellCacheEntry.handlerLiveHoles`): the capture's
   handle-push funnel (the PR #692 mask) now also attributes each push —
   `isInsideLoaderScope()` read synchronously at push time. A nested thenable
   in a push made OUTSIDE a DSL loader scope (handler body, handler-invoked
   `ctx.use(loader)`, defers), a handler push still pending at the putShell
   barrier, or a HANDLER-INVOKED LOADER executing during the capture (the
   consumption lane, #672 — its "fresh per serve" slot value would freeze
   under replay) sets the flag: those holes only a handler re-run can fill,
   so the serve side declines the fast path and keeps today's full tail.
   DSL-loader pushes never disqualify — loaders re-run on every HIT — and
   their captured values are filtered OUT of the snapshot's handle records
   (they would duplicate the fresh push and stall the Flight handle encode on
   their masks).

## Why the original splice framing was dropped

- **Whole-payload Flight round-trip is fragile**: `metadata.handles` is an
  AsyncGenerator (not plain Flight data), live promises hang the buffered
  `streamToString` drain, and temporary references don't survive a store
  round-trip. Per-segment records — the shipped codec — avoid all three.
- **Version coupling**: stored records are Flight wire format, coupled to the
  react-server-dom version and the client chunk graph. The buildVersion gate
  (PR #687) already invalidates shell entries on deploy; the doc record rides
  INSIDE the entry, so it dies with it. Same for cacheTag eviction: shell
  tags are unioned at the putShell barrier (#676/#680) and evict the whole
  entry, record included.
- **Deterministic carve-outs**: capture-time masking (mask-nested.ts,
  PR #692) guarantees every per-request value is a hole — never a settled
  value — in both the prelude and the recorded segments. The correctness fix
  is the prerequisite for the fast path, not an orthogonal nicety.

## Parity: why this cannot introduce hydration errors

The dynamic surface on a fast-path HIT is exactly what it is on today's HIT —
narrower, in fact:

| Layer                                        | Today's HIT (full tail)                    | Fast-path HIT                                    |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Middleware                                   | live                                       | live (unchanged — runs outside the shell branch) |
| Handlers (path/layout/parallel/intercept)    | re-executed; parity via snapshot pinning   | REPLAYED byte-identically (never executed)       |
| DSL loaders                                  | re-run; plain paths pinned by seed overlay | re-run; same overlay, same pinning               |
| `useLoader()` promise-shaped paths           | live (stream into holes)                   | live (identical funnel)                          |
| Handler-pushed handles (settled)             | re-pushed by handler re-run                | replayed from the entry                          |
| Handler-pushed handles (nested promise)      | live via handler re-run                    | **entry ineligible** → full tail                 |
| Handler-invoked `ctx.use(loader)` (#672)     | re-consumed by handler re-run              | **entry ineligible** → full tail                 |
| Loader-pushed handles                        | re-pushed by loader re-run                 | re-pushed by loader re-run (identical)           |
| Per-request metadata (theme/locationState/…) | rebuilt per request                        | rebuilt per request (buildFullPayload)           |

Plain (non-promise) loader values stay PINNED to the capture on document HITs
— the `_shellLoaderSeed` overlay's "recorded wins" rule — because the frozen
prelude already displays the capture-time value; serving fresh plain data in
the payload is precisely the hydration-mismatch class the snapshot machinery
exists to kill. The nested-promise shape is the one and only opt-in to
document-visible freshness. Partial navigations and action revalidations are
untouched and always fresh.

Replay is byte-identical by construction, which is STRONGER than the full
tail's re-render-and-pin approach: a handler that computes something the
snapshot doesn't pin (a timestamp, a random id) drifts today; replayed it
cannot.

## Unification with pre-rendering

`prerender-api-design.md`'s core principle — _pre-rendering is caching at
build time_ — stops being an analogy. One entry format, two producers, one
consumer:

- **Producer A (runtime)**: the background capture, triggered by traffic,
  TTL-bound.
- **Producer B (build time)**: SHIPPED (#699). The build's shell prerender
  phase (`vite/discovery/shell-prerender-phase.ts`, buildApp post) runs the
  SAME capture core (`deriveShellCaptureContext` + `captureAndStoreShell`,
  driven by `prerender/build-shell-capture.ts`) over the just-collected
  prerender payloads, and the serve path reads the resulting manifest through
  `rsc/shell-build-manifest.ts` on a store MISS — first request after deploy
  is a HIT. Build-time production is the SAFER producer: there is no ambient
  user identity at build, so the identity guard is trivially satisfied and
  the capture-credential defense-in-depth concern vanishes for build-time
  entries. In dev the same producer runs on demand via `/__rsc_shell`.
  Details: `packages/rangojs-router/docs/prerender-api-design.md`
  ("Build-time PPR shells").
- **Consumer**: the fast path above. The worker cannot tell whether an entry
  came from a capture or from the build — extending the existing hard rule
  ("the browser can't tell a route was pre-rendered") one layer deeper, into
  the payload.

The current two mental models — "PPR shell cache" vs "prerendered route" —
collapse into one property of the entry: when it was produced and what its
TTL is. A static marketing page is a build-time entry with infinite TTL whose
basket badge still streams live; the homepage is a runtime capture with a
300s TTL; both serve through identical code.

## What it buys (against the measurements above)

- Handler re-run + full Flight render on HITs: ~30-50ms → ~0.
- PDP prefetch renders: full Dispatcher render (~2.5s cold) → fragment
  replay + loaders. Prefetch starvation of the interactive tail mostly
  disappears.
- Tail wall-clock becomes exactly "your slowest live loader" — the honest
  floor. (The app-side lever for THAT: move session/token acquisition inside
  the nested promise so containers return instantly; see the field notes.)
- Parity bugs between prelude and payload become impossible by construction
  rather than maintained by the overlay's "recorded wins" rule.

## The five open questions, as resolved in v1

1. **Fragment granularity → per-segment, via the shipped codec.**
   `CachedEntryData` (all non-loader segments of the match in one doc-keyed
   record) — the exact shape `cache()` serves in production. Whole-payload
   was rejected: `metadata.handles` is an AsyncGenerator and live promises
   hang the buffered Flight drain.
2. **Per-request metadata rows → free.** There is no `root` on the wire; the
   payload object is rebuilt per HIT by `buildFullPayload`, so
   initialTheme/locationState/diff/redirect regenerate exactly as today. Only
   `metadata.segments` content replays.
3. **Actions/PE → untouched.** The fast path arms only inside serveShellHit
   (document GET, non-partial, non-RSC); actions and PE never reach it, and
   `withCacheLookup`/`withCacheStore` both bail on `ctx.isAction`.
4. **Eviction → inherited.** The doc record rides INSIDE the shell entry:
   TTL, SWR recapture, buildVersion gate, and cacheTag/updateTag (shell tags
   unioned at the putShell barrier) all evict prelude and record together.
   The SnapshotOnlySegmentStore guarantees no doc record ever outlives its
   entry in the real store.
5. **Failure posture → self-healing, inherited.** A corrupt record fails
   `deserializeSegments` inside `lookupRoute`, which evicts and returns null
   — a MISS — so the tail falls through to full segment resolution (handler
   re-run), never a broken splice. A missing record, a handler-live entry, or
   a route-derived cache scope degrade the same way: full tail, today's
   behavior.

## What stays out of v1 (deliberate)

- **Routes with their own `cache()` keep their semantics** — including
  `cache(false)` (opt-out respected; full tail) and nested boundaries
  (their records already fast-path the covered subtree today).
- **Prefetch renders and partial navigations** — unchanged; the fast path is
  document-HIT-tail only. The PDP-prefetch starvation lever is follow-up.
- **Prerender unification (producer B)** — shipped since as #699 (see the
  Unification section above); it was out of the v1 scope this section
  records.
- **Loader-pushed plain handle values consumed in shell content** drift on
  HITs (fresh push vs frozen prelude) exactly as they do today — the shape
  rule is the contract; not a fast-path regression.
- **Shell key vs doc key divergence**: both sides derive the doc key from the
  same request context, so a mismatch (exotic keyGenerator) just misses the
  seeded record and degrades to the full tail.
