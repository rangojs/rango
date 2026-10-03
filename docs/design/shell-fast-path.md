# Shell Fast Path: the shell entry as a cache() of the handler layer

Status: **shipped** on main (v1 2026-07-05; fragment splice closed #700 / PR
#706). The "v1 as built" section below is the authoritative record of what
shipped and why it needed almost no new machinery. Prerequisite work
(capture-time nested-thenable masking) shipped in PR #692; the instrumentation
that produced the numbers below shipped in PR #691 and PR #693. The FRAGMENT
SPLICE that v1 deferred (the per-request Flight re-serialization of replayed
segments) shipped as issue #700 — see "The fragment splice, as built" below.

**The fast path is now the only HIT path** (the handlers-baked change). Until
then an entry could decline it and a HIT re-ran the handler layer behind the
committed prelude. Now every document HIT replays the handler layer from the
entry's own doc record, and no handler runs on a HIT. "Everything a handler
produces is baked" below says what that took and what was removed.

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
  — work this design deliberately keeps, because it is the real floor.

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
preview/editing modes, actions and progressive enhancement, and a request the
route's own `cache()` refuses (`cache(false)`, or a `condition()` that returns
false for it). That last one is decided before the commit (`shellServePlan` in
`rsc-rendering.ts`), so it renders like a cache miss: axis 1, no
`x-rango-shell` header, no capture. A HIT never falls back to running
handlers.

## Eligibility is the cache purity rule — and it already shipped, piecemeal

The objection "handlers do per-request work (notFound, redirects, preview
branches), you cannot bake them" dissolves because capture eligibility
already encodes the purity contract:

- We only capture 200s. A 404/redirect decision never becomes a shell entry.
- We only capture renders that reported no error. A shell component that
  throws inside a Suspense boundary does not fail the capture render: Flight
  writes an error row, Fizz leaves the boundary errored in the prelude, and
  both report through `onError`. Those reports land on the capture context's
  own `_renderErrors` list (`deriveShellCaptureContext`), and
  `captureAndStoreShell` throws the first one before `putShell`, the same
  outcome as a fatal shell error: `reportCacheError` (`cache-write`), no
  retry, key backed off (issue #915). The loader drain's Flight encode of
  each bake-lane container for the snapshot pushes to the same list, so a
  container that encodes with an error row (a server component that throws
  when the encode runs it again, a rejected promise inside a `Map`, a
  function, a class instance) refuses the capture the same way (issue #927).
  At runtime the capture's own Flight render already reports a value that
  fails every time, since the container rides the payload; the encode check
  catches a server component that fails only on the second run, and the
  build-time producer, whose Flight render errors do not refuse (only its
  Fizz errors do) but which calls the same `captureAndStoreShell`. The
  document cache applies the same rule to a whole response.
- The capture guard refuses captures that read request-scoped data
  (`cookies()`, `headers()`, `ctx.request.headers`,
  `getRequestContext().cookie()` / `.cookies()`, `ctx.get` of a
  `createVar({ cache: false })` variable) or call `ctx.dynamic()`, anywhere
  the capture waits: a handler, a
  promise it passes or pushes, an async server component, a bake-lane loader,
  and a loader a handler awaits (`guardIdentityRead`,
  `src/server/context.ts`; `refuseOnCaptureGuard`, `src/rsc/shell-capture.ts`).
  So an entry never encodes a handler that branches on the requester. A
  normal `ctx.get()` value is not guarded: it bakes, and shell material is
  shared per host+URL and request partition (the route's `cache({ key })` or
  the store's `keyGenerator`, which read the request freely at capture too,
  `runIdentityExempt`).
- The handler layer must settle within `ppr.captureTimeout` (default 15s). A
  capture whose handler output is still pending at the deadline stores nothing.
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
opted into `cache()`. v1 was exactly that, four small pieces. The
handlers-baked change reshaped three of them (see "Everything a handler
produces is baked" below):

1. **`resolveShellImplicitCacheScope`** (cache/cache-scope.ts), applied at the
   FULL MatchContext construction site (match-api.ts): when the request
   context carries the `_shellImplicitCache` marker, substitute an enabled
   doc-level scope (`createShellImplicitDocScope`). For a capture and for
   partial navigation replay, a route-derived scope — including an explicit
   `cache(false)` — still wins. A document HIT tail's marker carries
   `docTail`, and there the implicit scope wins over a route-derived one: the
   tail replays the shell's own record, and the route scope's opt-outs were
   evaluated before the commit (`shellServePlan`).
2. **Capture side** (shell-capture.ts): the derived capture context sets the
   marker with a `SnapshotOnlySegmentStore` — the capture's `cacheRoute`
   write records the doc segment entry into the snapshot ONLY, never the real
   store (a passthrough write would make the NEXT capture's lookup hit the
   previous generation and never re-run handlers, breaking SWR recapture
   freshness). A route with its own `cache()` scope keeps that scope at
   capture, and `recordShellCaptureDocRecord`
   (match-middleware/cache-store.ts) writes the same doc record for it. The
   capture writes the record FIRST and renders its prelude from it
   (`settleCaptureRecord`).
3. **Serve side** (rsc-rendering.ts serveShellHit): the seeded tail context
   always sets the marker, with `docTail: true` and `fixedDocKey` set to
   `entry.docKey`. The tail's `ctx.router.match()` then HITs the seeded doc
   record and the handler layer is REPLAYED, not re-executed. `fixedDocKey`
   makes the scope look the record up by the key the capture wrote, so a
   store `keyGenerator` that folds request data, or a build-time capture's
   synthetic host, cannot send the lookup to a key the snapshot lacks.
   Per-request payload metadata (initialTheme replay, locationState, …) is
   rebuilt by `buildFullPayload` exactly as before — there is no `root` on the
   wire; only `metadata.segments` content replays. Because the handlers never
   run here, the capture stores no `"use cache"` items at all: the snapshot is
   the doc record plus the bake-lane loader pins, and a hole or a bake-lane
   loader body that runs on the HIT reads the store (`shell-entry-layout.md`
   §2). A record that does not hit (it failed to
   decode, or the entry lost it) never falls through to handler resolution:
   `withCacheLookup` throws `ShellRecordUnavailableError`
   (`cache/shell-snapshot.ts`) and `serveShellHit` degrades the response
   ("Failure posture" under the open questions below).
4. **Handle pushes** (the capture's push funnel in
   `deriveShellCaptureContext`, built on the PR #692 mask): each push is
   attributed by `isInsideLoaderScope()`, read synchronously at push time. A
   push made OUTSIDE a DSL loader scope (handler body, handler-invoked
   `ctx.use(loader)` bodies, defers) is handler output: it passes through
   unmasked, and `settleNestedThenables`
   (`segment-resolution/mask-nested.ts`) tracks it, so the record waits for
   its promises, top-level and nested in plain objects and arrays, before it
   encodes the handles every HIT restores. (In v1 such a push with a nested
   promise made the entry decline the fast path instead.) A promise inside a
   `Map`, `Set`, or class instance is not walked, so it is not awaited before
   the encode; if the handle encode times out on it, the capture is refused
   with a message that says so.
   DSL-loader pushes are filtered OUT of the snapshot's handle records
   (loaders re-run on every HIT: a recorded copy would duplicate the fresh
   push, and a masked one would stall the Flight handle encode). Unflagged loaders never execute at capture, so
   these pushes come from a loader an `ssr: false` loader awaits via
   `ctx.use` and from loader-cache replays. The filter is the store's
   positional tag, the same one `cache()` records use: `HandleStore.push`
   tags a loader-scope push by array index and `captureHandles` reads with
   `getDataForSegment(id, true)`. It was an identity `WeakSet` until issue
   #888, and a string or number cannot enter a `WeakSet`, so a primitive
   pushed by an awaited loader was recorded and showed twice on a HIT. The
   capture's push wrapper passes `loaderPush: false` for a bake-lane loader's
   own settled, thenable-free pushes, so they are kept, because the prelude
   rendered them. A run of the loader on a HIT would push them again, so the
   wrapper also passes the loader's id as `owner` (the innermost loader body
   the push was made in, else the loader a replay names). The record carries
   the owners in `CachedEntryData.handleOwners`. On a replay,
   `restoreHandles` decides each owner's values by where the request takes
   that loader's data from, and the answer comes from the loader seed, the
   same thing `resolveLoaderData` serves the data from (`servedPins` and
   `loaderPins` in `router/segment-resolution/loader-cache.ts`). A loader the
   replay serves from its pin gets its values back through
   `HandleStore.pushRestored`, and they stand: its run on the replay reads
   the store, so its settled pushes, and those made anywhere inside its body
   (a `"use cache"` hit replaying a dependency's push), are dropped, and only
   its thenable pushes are added. Every other owner is a hole, and its values
   are placeholders that go back through `pushReplayed` (the mechanism a
   loader's own `cache()` replay uses): its run's first push removes them and
   takes the first one's position, so each value appears once and the run's
   value wins, even when a restored loader running on the replay awaits it.
   A loader the route runs on the live lane is always a hole. An `ssr: false`
   loader is one exactly when the entry has no pin for it: a navigation-only
   entry, an entry whose pins `maxSnapshotBytes` dropped, a pin that failed
   to decode. A dependency the route registers on neither lane is credited
   at capture to the first registered loader around it: under a live-lane
   loader its pushes are that hole's and stay live; run only under a
   bake-lane loader, they are recorded under its own id, and stand while
   every `ssr: false` loader of the route is pinned.

   A document HIT, a client navigation and a prefetch that replay the record
   therefore agree, because none of them is asked. Until issues #1001 and
   #1003 the request's type decided: a document tail restored every
   bake-lane owner and a navigation replayed and claimed every owner, so a
   navigation showed pinned data next to the push of the run it made and
   lost the deferred push of the loader's own `cache()` entry, and a document
   HIT of an entry without pins showed fresh data next to the capture's push
   (`docs/design/handle-push-ownership.md`). Until issue #929 owned values
   were restored as plain values and showed twice unless the handle deduped
   by key. A push that lands after the document's handle snapshot reaches
   the client after hydration (the late channel). A record written before
   `handleOwners` existed restores as a plain replay.

## Everything a handler produces is baked

v1 left one class of entry on the old full tail, and it is worth knowing why
that class went away. A handler could hand the page something still pending:
a promise it passed to a component under the consumer's own `<Suspense>`, an
async server component, a promise nested in a handle it pushed, or a loader
it awaited (`await ctx.use(Loader)`, the consumption lane of #672). The
capture treated such a value as a hole when it was pending at the capture's
quiet window and marked the entry (`ShellCacheEntry.handlerLiveHoles`, or
`transitionWhen` for an unevaluated `transition({ when })`). A marked entry
declined the fast path: every HIT re-ran the handlers behind the committed
prelude, so the hole had a live promise to fill. That re-run needed snapshot
pins for every item a handler read, plus a set of pruning exceptions to keep
them (`shell-entry-layout.md` §2), and it made "is this a hole" a race: the
same promise baked on a fast capture and stayed live on a slow one.

It also hid a parity bug. The capture rendered its Flight payload from the
match's elements, and the doc record's encode (`serializeSegments`) ran the
same server components a second time. An uncached async server component
rendered twice per capture, so the prelude showed one value and every HIT's
replayed record another (measured: `quick-2` in the prelude's input, `quick-3`
on every HIT), and hydration repaired it client-side on every request.

The shell entry is now a `cache()` of the handler layer with no exceptions,
the contract `cache()` has always had:

- **Handler output is baked.** Promises a handler passes, async server
  components (with or without `<Suspense>` above them), nested promises in
  handler handle pushes, top-level pushed promises, and loaders a handler
  awaits all settle before the shell freezes. None of them is a hole.
- **Record-first capture** (`settleCaptureRecord`,
  `src/rsc/shell-capture.ts`). After the capture's `router.match()`, it waits
  for top-level handle promises, the handler pushes' nested promises, and the
  bake-lane loader containers. Then it fires its `onResponse` callbacks so the
  doc record is written: `CacheScope.cacheRoute` Flight-serializes every
  non-loader segment, which runs the async server components and waits for
  every promise in the handler output. Then it renders its OWN Flight payload
  from the record's fragments (`fragmentSegments`, the function a HIT tail
  uses) and freezes the prelude from that. The record is both the settle
  signal and the parity source: server components render once per capture,
  and the prelude and every HIT come from the same bytes.
- **One deadline.** The match (the handlers and the loaders they await), the
  wait, and the prerender share `ppr.captureTimeout` (default 15s): each gets
  what is left of it. Handler output that does not
  settle in time stores nothing, and after the in-place retry the
  once-per-key warning names the cause ("did not settle within
  ppr.captureTimeout"). The capture debug event reports the wait as
  `recordSettleMs` (`record=` in the debug line).
- **No doc record, no shell.** A capture that produced no doc record is
  refused ("the capture produced no doc segment record"), because a HIT could
  not replay it. Only a prerender-served capture (the prerender store
  supplies the handler layer) and a navigation-only entry may lack one. On
  the serve side, a document entry without `docKey` is a MISS (and is
  recaptured), except for a Prerender route (`matched.pr`), whose tail takes
  the handler layer from the prerender store.
- **Live data is a loader's job.** Live-lane loaders (no `ssr: false`) are
  still masked at capture and run per request on a HIT; that is the only
  per-request data a HIT renders. Inside an `ssr: false` loader, a nested
  promise stays a hole by shape.
- **The capture guard covers everything the capture waits for.**
  `cookies()`, `headers()`, a `{ cache: false }` variable, and
  `ctx.dynamic()` refuse the capture from a handler promise, an async
  component, a handle push, or a loader a handler awaits. The guard flags the
  capture context (`_shellCaptureGuardTripped`) before it throws, so code
  that catches the throw still refuses the capture. The handler-invoked
  loader used to be exempt: its identity reads rendered per visitor on the
  re-running HIT. With no re-run, the exemption would bake the capturing
  request's cookie into every visitor's page, so it is gone for PPR captures.
  The `cache()` purity guards keep it (`isInsideCacheScope`), because a
  `cache()` hit is a separate tier.

Removed with it: `ShellCacheEntry.handlerLiveHoles` and
`ShellCacheEntry.transitionWhen` (with the CF frame head keys `lh`/`tw` and
the Vercel envelope's `lh`/`tw`), and the `x-rango-ppr-replay` bypass tokens
`handler-live-holes` and `transition-when` (gone from `PprReplayBypassReason`
in `@rangojs/router/testing`). `transition({ when })` itself is unaffected:
it is a browser predicate the server never evaluates (a HIT carries it as a
client reference, attached from the route definition), so the entry flag had
no reader left.

Pinned by `src/rsc/__tests__/shell-handlers-baked.rsc-test.tsx` (settle,
parity, a live hole, `rendered()` on replayed handles, the deadline, no
re-run for a route `cache()` whose explicit tier missed, a custom `key()`, or
a store `keyGenerator`, `cache(false)` staying axis 1, and the capture-guard
cases) and `src/rsc/__tests__/shell-snapshot-prune.rsc-test.tsx` (a
handler-invoked loader baked and replayed, a `condition()` that refuses the
HIT as a genuine MISS, the corrupt-record degrade).

## What a HIT reads before its first byte

The fast path above is about the tail. The first byte has its own budget: the
store read, parse, and decode that happen before the prelude is enqueued, which
issue #941 measured at 90-140 ms behind a hand-rolled shell server on
Cloudflare. `shell-entry-layout.md` covers that path: the prelude is decoded
once (natively where the runtime can) and enqueued in 32 KB chunks, and
`CFCacheStore` stores a prelude-first entry, so a HIT commits after reading
the head and the prelude while the capture snapshot is still arriving; only
the tail waits for it.

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
  PR #692) guarantees every per-request LOADER value is a hole — never a
  settled value — in both the prelude and the recorded segments: live-lane
  loader data, and the nested promises of an `ssr: false` loader's data or
  handle pushes. Handler output is the other side of the line: it is always
  settled and baked (see "Everything a handler produces is baked"). The
  correctness fix is the prerequisite for the fast path, not an orthogonal
  nicety.

## The fragment splice, as built (issue #700)

v1 killed handler re-EXECUTION on a HIT but kept re-SERIALIZATION: the tail
deserialized the stored segment records into element trees and
`renderToReadableStream` re-encoded the whole payload per request — measured
1.09MB of entry-constant `__FLIGHT_DATA` bytes per request on a 3.77MB
storefront homepage, ~200-300ms of workerd CPU at the measured ~5MB/s
stream-generation throughput. The splice removes BOTH halves of that round
trip. Per-SEGMENT, not whole-payload (the section below records why
whole-payload was and stays rejected; the same reasoning rejects the
vinext-style stored-payload-bytes splice — Rango's HIT payload interleaves
live loader rows, the handles generator, and per-request metadata in the SAME
Flight document, and the capture's stream is frozen mid-document with
never-emitting masked-loader rows, so raw byte reuse means row-id surgery):

- **Producer side**: `serveShellHit` runs every HIT tail under a derived
  context flagged `_shellFragmentPayload` (rsc-rendering.ts). Under that flag,
  the tail's segment sources — `CacheScope.lookupRoute` (the seeded doc
  record / any route-scoped cache() hit) and the prerender-store path
  (`yieldFromStore` in cache-lookup.ts, the Prerender+ppr / producer B lane)
  — build segments via `fragmentSegments` (segment-codec.ts): the STORED
  per-segment Flight strings ride the `ResolvedSegment` ReactNode fields
  verbatim as `{ __rangoFragment: 1, f }` envelopes; nothing is decoded.
  Loader data fields are never enveloped (consumer data of any shape — decode
  as before; absent on these records in practice).
- **Wire**: the outer Flight render serializes each envelope as a plain
  object whose big string rides a raw `T`-row text chunk — a byte copy, not a
  tree encode. Fresh serialization covers only what is genuinely live: loader
  rows, handle records, per-request metadata rows.
- **Consumer side**: BOTH payload consumers expand envelopes through their own
  Flight deserializer before anything reads the segments — the SSR resume
  pass inside `createSsrRootComponent` (payload promise chains the expansion,
  so `onPayloadSettled` includes fragment module loads) and browser hydration
  in `initBrowserApp` (before the store seed / renderSegments). Each fragment
  is its own row space, decoded independently — the exact per-record decode
  the codec has always done, just moved to the consumer — so there is no
  row-id collision or shared-row dedupe hazard, and hydration sees the same
  trees the double round trip produced.
- **Scope**: the flag has two arming sites, each bounded to a render/match
  window and never left on the shared request context as an own property.
  Document HITs: `serveShellHit` arms a DERIVED tail context. Partial
  navigations: `matchPartialWithPprReplay` arms the SHARED reqCtx with
  mutate-restore around each `matchPartial` execution
  (`matchPartialForReplay`) — a derived context is NOT usable there because
  the match pipeline writes ambient state that must land on reqCtx
  (`_pprReplayPostMatchReason`, location state, `_treeHasStreaming` read by
  the render-barrier closure). Only GET navigation lanes carrying
  `X-Rango-Fragment-Passthrough: 1` arm (past the
  method/dynamic/nonce/store/navigation-context gates). The explicit capability
  signal keeps older clients and raw probes on decoded elements; it also gives
  fragment recovery an unfragmented retry lane. Actions, `ctx.dynamic()`
  requests, nonce'd requests, and context-less probes keep decoded elements. A
  capture render must never see the flag: a capture
  serializes segments into records, and an envelope reaching
  `serializeSegments` would store a double-encoded fragment —
  `deriveShellCaptureContext` resets `_shellFragmentPayload` as an own
  property (defense-in-depth; the arming windows already close before any
  capture is scheduled). Non-HIT payloads carry no envelopes and pay one
  field scan on the client.
- **Partial-navigation consumers** (#700 extension): the client expands
  envelopes at its two decode chokepoints — `navigation-client.ts` at the
  single payload await all three sources flow through (fresh fetch, warm
  prefetch, adopted inflight), and the prefetch decoder wrapper in
  `rsc-router.tsx` (BEFORE the payload enters the prefetch cache, so cached
  entries only ever resolve expanded). Expansion is idempotent — an expanded
  field no longer matches the envelope marker. On an armed partial match,
  every cached segment source envelopes: the seeded doc record, an explicit
  route `cache()` tier hit, and the prerender store (`Prerender()+ppr`
  partials) — all covered by the same client expansion.
- **Failure posture**: the splice skips the tail-side decode that used to
  validate a record server-side. A fragment the SSR consumer cannot expand
  still rejects the tail and `serveShellHit` schedules a healing recapture; a
  doc record the tail's lookup cannot use at all takes the degrade described
  under the open questions (question 5). A partial-navigation consumer
  retries once without the capability header, forcing the existing server
  decode-and-evict path; an invalid explicit-cache entry is deleted, while an
  invalid seeded document record additionally schedules a navigation-only
  recapture to replace its enclosing shell snapshot. Fragment-capable and
  legacy/context-less partial responses occupy separate document-cache slots,
  matching the response's `Vary` contract. The recovery marker bypasses the
  corrupt slot's read and overwrites it with the valid unfragmented fallback;
  the current document disables further passthrough so its local HTTP cache
  cannot replay bytes cached before recovery. A corrupt runtime shell is
  repaired at the exact key that supplied it. A document-key repair remains
  marked `navigationOnly`, so partial replay sees the repair immediately while
  the next document request ignores it and restores a document-safe shell.

## Parity: why this cannot introduce hydration errors

The dynamic surface on a HIT is narrower than on the full tail it replaced
(the old full-tail column is history: no HIT takes it any more):

| Layer                                        | Old full tail (removed)                    | HIT                                              |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Middleware                                   | live                                       | live (unchanged — runs outside the shell branch) |
| Handlers (path/layout/parallel/intercept)    | re-executed; parity via snapshot pinning   | REPLAYED byte-identically (never executed)       |
| Handler promises, async server components    | re-rendered by the re-run                  | settled at capture, replayed from the entry      |
| DSL loaders                                  | re-run; plain paths pinned by seed overlay | re-run; same overlay, same pinning               |
| `useLoader()` promise-shaped paths           | live (stream into holes)                   | live (identical funnel)                          |
| Handler-pushed handles (settled)             | re-pushed by handler re-run                | replayed from the entry                          |
| Handler-pushed handles (nested promise)      | live via handler re-run                    | settled at capture, replayed from the entry      |
| Handler-invoked `ctx.use(loader)` (#672)     | re-consumed by handler re-run              | baked at capture, replayed from the entry        |
| Loader-pushed handles (bake lane, settled)   | re-pushed by loader re-run                 | replayed from the entry; re-run replaces it      |
| Loader-pushed handles (all others)           | re-pushed by loader re-run                 | re-pushed by loader re-run (identical)           |
| Per-request metadata (theme/locationState/…) | rebuilt per request                        | rebuilt per request (buildFullPayload)           |

Plain (non-promise) loader values stay PINNED to the capture on document HITs
— the `_shellLoaderSeed` overlay's "recorded wins" rule — because the frozen
prelude already displays the capture-time value; serving fresh plain data in
the payload is precisely the hydration-mismatch class the snapshot machinery
exists to kill. The nested-promise shape is the one and only opt-in to
document-visible freshness. Partial navigations keep loaders fresh while
replaying an eligibility-checked shell snapshot; a cold partial can schedule a
navigation-only capture to produce one. Action revalidations remain untouched.

A route's own `cache()` records written outside a capture carry no loader
pushes at all (`captureHandles` drops every DSL-loader push, bake lane
included), so on a plain `cache()` HIT every loader-pushed handle comes only
from the re-run. The bake-lane replay in the table is capture-only.

Replay is byte-identical by construction, which is STRONGER than the full
tail's re-render-and-pin approach: a handler that computes something the
snapshot doesn't pin (a timestamp, a random id) drifted under the re-run;
replayed it cannot. Since the capture renders its own prelude from the same
record (`settleCaptureRecord`), the capture cannot disagree with itself
either: an uncached async server component renders once per capture, not
once for the prelude and once more for the record.

There is one browser-observable transition that is not a parity failure. Flight
can hydrate a postponed boundary before fizz finishes its `$RC`/`$RV` reveal
cleanup. For that short window the visible client-rendered node and fizz's
`<div hidden id="S:n">` copy coexist with identical data; `$RV` removes the
hidden container on its scheduled animation frame or timer. E2e assertions
must wait for the global locator count to return to one before reading content.
Scoping a locator to the visible page container hides a genuinely stuck
`S:n` copy and therefore weakens the regression guard.

## Unification with pre-rendering

`prerender-api-design.md`'s core principle — _pre-rendering is caching at
build time_ — stops being an analogy. One entry format, two producers, one
consumer:

- **Producer A (runtime)**: the background capture, triggered by traffic,
  TTL-bound.
- **Producer B (build time)**: SHIPPED (#699). The build's shell prerender
  phase (`vite/discovery/shell-prerender-phase.ts`, buildApp post) replays
  middleware with `ctx.build === true` and then runs the SAME capture core
  (`deriveShellCaptureContext` + `settleCaptureRecord` +
  `captureAndStoreShell`, driven by `prerender/build-shell-capture.ts`) over
  the just-collected prerender payloads. A prerendered URL's match comes from
  the prerender store (no handler runs, no doc record), and its HIT tail
  takes the handler layer from the prerender store as well. Middleware can call `ctx.dynamic()` to leave that URL for runtime.
  The serve path reads the resulting manifest through
  `rsc/shell-build-manifest.ts` on a store MISS — first request after deploy is
  a HIT. Build-time production is the SAFER producer: there is no ambient user
  identity at build, so the identity guard is trivially satisfied and the
  capture-credential defense-in-depth concern vanishes for build-time entries.
  In dev the same producer runs on demand via `/__rsc_shell`.
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
- Tail wall-clock becomes exactly "your slowest live loader" — the real
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
5. **Failure posture → degrade to a real MISS, never a handler run.** v1
   let a corrupt record fall through to full segment resolution, which ran
   the handlers behind the committed prelude; so did a missing record, a
   handler-live entry, and a route-derived cache scope. That is gone. A
   record that fails its decode inside `lookupRoute` is reported
   (`cache-corrupt`), the lookup misses, and `withCacheLookup`
   throws `ShellRecordUnavailableError` instead of resolving segments (the
   match pipeline's catch in `match-handlers.ts` rethrows it untouched, so no
   `onError` report). `serveShellHit` catches it and calls
   `degradeUnreplayableShell`: it overwrites the entry with a tombstone (a
   `navigationOnly` entry with no document half and no snapshot, which
   document serving treats as a MISS; the store has no shell delete), drops
   the isolate's memo of the key (`dropShellMemo`), and schedules a
   recapture. A snapshot read that was only slow
   (`snapshotFailure: "unavailable"`) skips those three: the entry is sound.
   Either way the response ends with a script that reloads once with the
   forced-MISS marker (`_rsc_shell=miss`, `shellReloadScript`), which the
   serve gate renders on axis 1 without a shell read or a capture. The
   prelude already committed a 200, so a reload is the one way left to get
   the visitor a page that matches its payload. Pinned by
   `shell-snapshot-prune.rsc-test.tsx` ("a doc record that fails to decode on
   a HIT") and `rsc-rendering-shell-ppr.test.ts`.

## What stays out of v1 (deliberate)

- **Routes with their own `cache()` kept their semantics on a HIT** in v1:
  the tail consulted the route scope, and an explicit-tier miss, a
  `condition()` bypass, or a request-dependent `key()` re-ran the handlers.
  No longer: a document HIT tail replays the shell's own doc record
  (`docTail`), whatever the route scope would have done. The route scope's
  opt-out is decided before the commit instead: `cache(false)`, or a
  `condition()` that returns false for THIS request, makes `shellServePlan`
  serve the request like a cache miss (axis 1, no `x-rango-shell`, no
  capture). Captures and partial navigation replay still honor the route
  scope.
- **Prefetch renders and partial navigations** — the fragment splice was
  document-HIT-tail only in v1; partial navigation replay (and with it the
  prefetch-warm path) gained the splice since — see "The fragment splice, as
  built". The PDP-prefetch starvation lever remains follow-up.
- **Prerender unification (producer B)** — shipped since as #699 (see the
  Unification section above); it was out of the v1 scope this section
  records.
- **Loader-pushed plain handle values consumed in shell content** drift on
  HITs (fresh push vs frozen prelude) exactly as they do today — the shape
  rule is the contract; not a fast-path regression.
- **Shell key vs doc key divergence** was a v1 limit: both sides derived the
  doc key from their own request context, so a store `keyGenerator` that
  folded request data missed the seeded record and degraded to the full
  tail. The HIT tail now looks the record up by the entry's own `docKey`
  (`fixedDocKey`), so the key cannot diverge.
