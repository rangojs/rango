# PPR shell caching and resume (revived streams)

If you're about to touch the PPR serve path, the SSR capture/resume
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
the postponed holes. The repo's pinned react/react-dom/vendored RSD (19.2.8)
all carry the full surface — verified by runtime probe, not just export lists.

So: cache the rendered HTML **prelude** plus the postponed state, serve those
bytes on the first read of the request, and resume fizz for just the live
holes. The browser sees one ordinary streamed document.

## Two axes

The existing render path is untouched and stays the default:

|                     | Axis 1 — HTML stream (default)     | Axis 2 — PPR (opt-in via the page route's `ppr` option) |
| ------------------- | ---------------------------------- | ------------------------------------------------------- |
| HTML production     | full fizz `renderToReadableStream` | stored prelude bytes + `resume(postponed)`              |
| Shell definition    | n/a                                | everything that did not postpone during shell capture   |
| First byte waits on | Flight render + fizz shell pass    | middleware + one shell-store lookup                     |
| Request fizz cost   | O(whole tree)                      | O(paths to holes) — resume replays only postponed paths |

Everything upstream is shared: matching, middleware, segment cache lookup and
replay, fresh loaders, and the **full** Flight render (the browser still needs
the complete payload for hydration; there is no Flight-side resume — that is a
React limitation, not ours).

### Navigation reuse is segment caching, not Flight resume

The capture snapshot contains an implicit document-keyed segment record in
addition to the HTML prelude. A partial RSC request for the same `ppr` URL may
seed that record into the ordinary `matchPartial()` cache lookup. The normal
pipeline still owns client-segment nullification, revalidation, diff selection,
parallel ordering, handles, and fresh loader resolution; the browser receives an
ordinary partial payload and has no PPR-specific branch.

Rango's navigation and prefetch clients advertise fragment expansion with
`X-Rango-Fragment-Passthrough: 1`. Replayed ReactNode fields can then carry their
stored Flight strings as `__rangoFragment` envelopes; both browser decode
chokepoints expand them before rendering or caching the decoded payload. A
fragment-only decode failure retries once without the capability header, which
restores the server's decode-and-evict path. If the corrupt record came from a
seeded shell snapshot, the successful fallback also schedules a navigation-only
recapture. Response caches key the capable wire variant separately, so a raw or
older client never receives envelopes it cannot expand. The one-shot recovery
marker skips the corrupt response-cache read, reaches segment validation, and
replaces that capable slot with the valid fallback. The current browser document
then leaves passthrough disabled so its already-populated HTTP cache cannot replay
the old bytes.

A partial request does not require a prior document capture. On a shell-snapshot
miss, the first request renders normally and schedules the existing shell
capture with `navigationOnly: true`. Capture, rather than a direct segment write,
is load-bearing: it records handler-live holes and the other eligibility flags
that decide whether replay is safe. Later navigations and prefetches consume the
snapshot when eligible. The background capture strips transport parameters and
rebinds the derived context's request identity to the target document URL; this
keeps explicit `cache()` scopes and document completeness checks on document
semantics.

Only the snapshot's segment family is visible during navigation replay. Item,
response, and loader-family pins exist to keep a document HIT byte-identical to
its frozen HTML and would incorrectly freeze loader reads on a navigation. The
implicit scope reads the canonical `doc:` identity even though the transport is
partial, avoiding one cached shell per source-segment combination. Intercepts,
handler-live holes, nonce-bearing requests, and snapshots without a segment
record decline replay and run the full partial path. Conditional transition
predicates do not: PPR hoists them before route handlers and evaluates them from
the matched manifest on every runtime-cache, prerender, and shell replay. Their
request-specific result is projected only onto the outgoing payload, never the
reusable segment record. A transition already frozen by an explicit
`cache()`/prerender hit keeps that cache tier's normal no-re-evaluation semantics.
The replay store belongs only to that implicit scope: a consumer `cache()` scope
continues to use its own store, key, TTL/SWR, tags, and condition. Segment misses,
writes, and deletes stay inside the request overlay, so a partial pipeline can
never write its output into the canonical document namespace.

Navigation uses a passive shell read and replays fresh or stale-within-SWR
runtime entries. The stale generation is already authorized by the store's hard
expiry, so the partial request may consume its canonical segment record without
claiming SWR ownership or recapturing HTML; only a later document request owns
that refresh. Hard-expired entries schedule a navigation-only capture. Production
can also read a fresh local build-manifest entry. Dev never foreground-fetches
`/__rsc_shell`; it uses the same local background capture. Custom stores opt in with
`supportsPassiveShellReads: true`; without that declaration replay declines.

The capture still produces a prelude/postponed pair — the fizz prerender is the
completeness arbiter and sanity gate — but the stored navigation-only entry
DROPS both: nothing ever serves a navigation entry's HTML (document serving
never reads that namespace, and partial replay consumes only the segment
snapshot and eligibility flags), so the document half would ride every store
write and read as dead weight at KV-value scale. `hasIntactShellPayload` is the
document-half gate a navigationOnly entry never passes; the CF/Vercel envelopes
accept the absent fields only under the `navigationOnly` marker, which is
preserved through memory, Cloudflare, and Vercel stores as defense in depth. A
late navigation capture therefore cannot downgrade a document-safe shell.
Partial replay prefers the document shell and falls back to the navigation
snapshot.
Corruption repair is the one key-placement exception: it overwrites the exact
runtime key that supplied the bad snapshot. A repair at the document key still
carries `navigationOnly`, so document serving refuses it and performs a normal
document-safe recapture instead of serving a partial-request-derived shell.

SSR setup for a cold partial (module loading plus the document `allReady` policy)
runs inside the guarded background task; the Flight response never waits for it
and setup failure cannot turn the already-rendered navigation into a 500.
Cross-key capture execution remains serialized and admits at most 32
queued/running captures per isolate; excess best-effort captures are dropped and
may retry on a later request. Waiting document-shell captures run before queued
navigation-only captures, while preserving FIFO within each class and never
interrupting the active capture. This priority is load-bearing in production:
viewport prefetch can enqueue several expensive navigation snapshots, and a
strict FIFO let them consume the document capture's entire queue budget. The
priority class and the backlog at enqueue ride the `rango.background` span
(`queue_priority`, `queue_ahead`) and the skip-queue-timeout debug event, so a
parked capture diagnoses itself. Scheduling also checks write viability first:
a store without the shell family, or one that declared it inert
(`SegmentCacheStore.shellFamilyInert` — a KV-less `CFCacheStore`), skips the
capture at the gate (`skip-inert-store`) instead of burning a background render
whose write could only no-op.
Each waiter receives a start signal and runs the capture in its own scheduling
request context. Queue handoff happens before that request's `waitUntil` promise
settles; resolving first lets workerd retire the context while the isolate lock
is still held, which permanently parks later captures.

A capture that WAITED past `CAPTURE_QUEUE_WAIT_BUDGET_MS` (15s, one attempt's
budget) behind a slow active or same-priority predecessor is dropped unrun
(`skip-queue-timeout`, no backoff) rather than starting an attempt the platform's
~30s post-response waitUntil budget can no longer cover — field-observed as a
navigation-shell capture parked ~24s and finishing only because the client's
cancel record closed late. Queue parking is visible as
`rango.background.queue_wait_ms` on the capture's span and `queue-wait=` on the
debug event.

The partial response reports the actual outcome in `x-rango-ppr-replay`:
`HIT; freshness=fresh|stale` or `BYPASS; reason=<bounded-token>`. The matching
`ppr:navigation-replay` metric uses `fresh`, `stale`, or `bypass:<reason>` as its
description. A first cold partial reports `BYPASS; reason=no-entry` while it
schedules capture; a later request reports `HIT`. This is deliberately
separate from document-only `x-rango-shell`.

### Capture-generation invalidation

The shell's `createdAt` is the start of its capture generation, before matching
or snapshot reads. Runtime stores compare tag invalidation markers against that
timestamp at the write barrier and on reads, so an `updateTag()` racing the
capture still wins even if the shell write completes later.
Built-in stores acknowledge that rejected write. The capture reports it as a
refusal and backs the key off instead of silently claiming success and
recapturing on every document request. This includes deterministic
self-invalidation: capture code that calls `updateTag()` on one of its own shell
tags prevents that generation from being cached and emits a diagnostic naming
the fix.

## Opt-in: the `ppr` path option, and integral serving

If you are adding a PPR route or touching the serve path, read this first — it
is the whole opt-in story.

PPR is a DOCUMENT-level property declared on the PAGE ROUTE:

```ts
path("/products/:id", PricePage, { name: "product", ppr: { ttl: 600, swr: 120 } }, () => [
  loader(LivePriceLoader),
  loading(<PriceSkeleton />),
]);
```

`ppr: true` uses the default policy (`DEFAULT_PPR_TTL_SECONDS` = 300);
`PartialPrerenderProps { ttl?, swr?, tags?, captureTimeout? }` sets it
explicitly (`src/urls/pattern-types.ts`; stored on the route `EntryData` by
`src/urls/path-helper.ts`; normalized by `resolvePprConfig` in
`src/rsc/shell-serve.ts`). There is NO subtree inheritance in v1 — declaring
`ppr` on a layout is not supported (a possible follow-up). A route without the
option is pure axis 1: no store read, no capture, no logs, zero cost.

The route's NAME is orthogonal to all of this (issue #714): a nameless
`path()` registers its `EntryData` under a synthesized `$path_*` manifest key
with the `ppr` option intact, so it captures and serves exactly like a named
route — pinned by the nameless-ppr e2e in both apps and the
`shell-serve-ppr-config` unit round-trip. (The issue's observed "silent
ignore" was the pre-#705 Accept rule: a document GET without `text/html` in
Accept — curl's default `*/*` — negotiated to the Flight wire format and
bypassed the shell lane for named and nameless routes alike.)

### `captureTimeout`: the capture settle budget (issue #715)

The background capture is bounded by ONE deadline — `captureShellHTML`'s
`maxWaitMs` — hard-coded to 5s until #715. Deferred shell material (a handler
pushing `ctx.use(Meta)(dataPromise.then(...))`, top-level handle pushes
carrying promises) is AWAITED by the capture and its settled values bake into
the stored shell; material that settles slower than the budget made the route
uncapturable forever (eternal MISS + backoff + the no-usable-shell warning).
`ppr.captureTimeout` (ms, default 15000 — raised from 5000, see the Cost
model below) declares the budget per route:

```ts
path("/pdp/:id", ProductPage, {
  name: "product",
  ppr: { ttl: 600, swr: 120, captureTimeout: 10_000 },
});
```

Semantics, in dependency order:

- **One knob, one deadline.** The resolved value flows
  `resolvePprConfig -> ShellCaptureDescriptor.captureTimeout ->
captureShellHTML({ maxWaitMs })`, so it bounds BOTH the fizz prerender and
  the deferred-material settle window — the `holdUntil` gate and the quiesce
  race are inputs to the same deadline. There is no second timer to drift.
- **Ordering is the contract, the budget only bounds it.** The capture gate
  never freezes while a tracked top-level push is pending
  (`gateFlightForCapture`'s `holdUntil`), and `SsrRoot` suspends at the ROOT
  until the handles snapshot fully settles (`resolvedHandleStream` yields
  once, after EVERY push — including promises chained off other pushes —
  resolves). A partial prefix of the settlement sequence is therefore
  unrepresentable in a stored shell.
- **Expiry with pushes pending REFUSES.** If the budget elapses first, the
  handles row never emitted, the prerender is still root-suspended, the
  prelude has no `<body>`, and the sanity gate returns null — no-shell, the
  existing retry/backoff/warning path. A shell with missing or unsettled head
  material is never stored, at any budget.
- **Cost model.** Capture is background work (`waitUntil`): a longer budget
  costs latency-to-HIT only, never a served response — that is why 5s (which
  spuriously refused a real storefront's ~7s meta chains) could be raised.
  The platform's `waitUntil` lifetime is the physical ceiling — on workerd,
  ~30s past response completion — so a `captureTimeout` near or past that
  ceiling gets killed by the platform, not by rango (see Platform notes).
  Ceiling math for the default: a guaranteed two-attempt envelope is
  `2 x budget + the in-place retry delay + store I/O <= ~30s`, i.e. budget
  <= ~14s. The 15s default deliberately sits just past that bound: attempt 1
  always gets its full 15s; only when it consumed the whole budget can the
  in-place retry be truncated by the platform kill on workerd, which degrades
  to the existing best-effort contract (the key stays MISS and a later
  request re-captures). Node/dev and build-time captures have no `waitUntil`
  ceiling. Canonical in-code doc: `SHELL_CAPTURE_MAX_WAIT_MS` in
  `src/rsc/shell-capture-constants.ts`.
- **Wedge containment.** The budget arms inside `captureShellHTML` — AFTER
  the capture's `router.match()`, so a handler wedged on a never-settling
  upstream await used to leave the task with no deadline at all (autobarn
  pilot: a 30s+ tarpitting fetch). Two layers now bound it:
  `SHELL_CAPTURE_TASK_HARD_CAP_MS` (25s) races the whole task — on expiry the
  task settles through the normal error path (backoff + report) and releases
  the stampede guard and the serialized queue slot; and the guard itself is
  staleness-aware with a token-guarded release, so an entry stranded by a
  killed workerd context (where no timer survives to fire) is reclaimed by
  the next schedule past the cap. The cap bounds rango's bookkeeping, not the
  wedged render itself — its awaits are never cancelled and die with the
  context. The capture's `"use cache"` leader registrations are separately
  bounded by the in-flight leader trust window (`use-cache-api-design.md`).
- **Producer B parity.** Build-time captures (Prerender+ppr,
  `src/prerender/build-shell-capture.ts`) and the dev `/__rsc_shell` endpoint
  honor the same knob (`resolveBuildPprConfig` resolves it; the dev
  read-through threads it as a query param and sizes its own fetch bound —
  `devShellFetchTimeoutMs` — to the endpoint's full sequential envelope:
  pre-flight probe + two attempts + retry margin). Build has no `waitUntil`
  bound, so there the option is the only ceiling.
- **Validation.** Non-finite or sub-1ms values normalize to undefined (the
  capture default applies); the default's single owner stays
  `SHELL_CAPTURE_MAX_WAIT_MS` in `src/rsc/shell-capture.ts`.

Deliberately unchanged: `SHELL_CAPTURE_WRITE_BARRIER_MS` (1.5s pre-render
write barrier), `SHELL_SNAPSHOT_WRITE_SETTLE_MS` (1s deferred-write settle),
the retry-in-place delay, and the refused-capture backoff windows — those
bound store I/O and scheduling, not shell-material settlement.

Serving is INTEGRAL to the router — `createShellCacheMiddleware` and
`ShellCacheOptions` were removed from the public surface entirely (pre-release
rule: removed, not deprecated). The shell store is the app-level
`createRouter({ cache })` store (`requestCtx._cacheStore`); a ppr route on a
store without the `getShell`/`putShell` family degrades to axis 1 with a
once-per-key warning (declared intent that cannot be honored deserves a
diagnostic; an undeclared route stays silent).

### The serve pipeline and the commit point

The PPR serve block lives at the top of `handleRscRenderingInner`
(`src/rsc/rsc-rendering.ts`) — the render pass that `executeRender` wraps. That
placement IS the security model:

```
request ──> global middleware chain (router.use(), onion)
              └─> route DSL middleware() (executeRender onion)
                    └─> handleRscRenderingInner        <-- THE COMMIT POINT
                          ppr config off the classified route snapshot
                          nonce check (provider OR token; warn-once + axis 1 if set)
                          store family check (warn-once + axis 1 if absent)
                          getSSRSetup (allReady => bypass, axis 1)
                          getShell(key)
                          ├─ HIT: commit composed response NOW
                          │    prelude bytes flush first; match()/Flight/resume
                          │    run BEHIND them inside the response stream
                          │    (+ SWR recapture scheduled on a stale hit)
                          └─ MISS: axis-1 serve, x-rango-shell: MISS,
                               background capture scheduled after the response
```

Both middleware layers are GUARDS, and the commit point is after all of them:
any rejection/redirect/401 returns before a single shell byte — on MISS and on
a warmed HIT alike. On a HIT the composed response is committed eagerly so the
stored prelude hides segment resolution, the fresh Flight render, and the
resume setup behind wire bytes; the tail promise is kicked off synchronously
(inside the ALS request-context frame) and the stream awaits it. Status and
headers are committed at the flush — a failing hole cannot become a
500/redirect after the first shell byte (error UI renders inline via
Suspense/error boundaries), and a near-unreachable redirecting match on a HIT
degrades to a client-side `location.replace` script.

### The per-request nonce gate reads the token, not just the provider (scar tissue)

A per-request CSP nonce pins the route to axis 1: `useNonce()` renders it into
every nonced script/style/meta, so a shell shared per host+URL cannot bake it
without freezing one request's nonce for every visitor. The gate originally
checked ONLY the `createRouter({ nonce })` provider value (threaded into
`handleRscRendering` as the `nonce` param). But a nonce can also arrive via the
`nonce` ContextVar TOKEN written in middleware (`ctx.set(nonce, value)`), and
that path left the threaded param `undefined` — so a token-set nonce sailed
through the gate, entered capture, and baked the capture request's nonce into
the shared shell (issue #656). The fix reads the token off the post-middleware
request variables AT the commit point: `nonce ?? contextGet(reqCtx._variables,
nonceToken)`. This is only sound because the commit point runs after the whole
middleware chain — the token write is already present. A declared-but-gated
route logs a once-per-key warning (`warnPprNonceActiveOnce`, mirroring
`warnShellStoreMissingOnce`) and serves pure axis 1 with no `x-rango-shell`
header; an undeclared route stays silent.

### Theme fidelity on resume (scar tissue)

This started as a user-reported bug: PPR'd blog routes rendered LIGHT for a
dark-theme visitor and the theme toggle went dead. Root cause: `initialTheme`
is per-request METADATA (`reqCtx.theme`, from the visitor's cookie) feeding
`ThemeProvider` in `SsrRoot` — it is not part of the cached segments, so the
"shell identity holds by construction" argument did not cover it. A capture
made by a light/default request froze a light-rendered prelude; a dark
visitor's resume tail then rendered a DIVERGENT tree above the holes (React
resume requires them to match), breaking stitching/hydration — wrong theme AND
dead interactivity.

The fix has four coordinated parts:

1. `ShellCacheEntry.initialTheme` records the theme the CAPTURE's payload was
   built with (`captureAndStoreShell`).
2. The serve tail (`serveShellHit`) overrides `payload.metadata.initialTheme`
   with the stored value, so the resume tree AND client hydration both match
   the frozen prelude by construction.
3. `ThemeProvider`'s state initializer NEVER reads cookie/localStorage — the
   initializer is both the server render and the client's hydration render,
   and the two must produce the same first render. Before this, the client
   initializer fell back to the visitor's stored theme whenever `initialTheme`
   was absent (exactly the replayed-capture shape), so any raw-theme text in
   the shell (a toggle label) mismatched, hydration failed, and React's client
   regeneration wiped the FOUC-applied class from `<html>`. Parts 1-2 alone
   did NOT fix the reported bug — this was the part detonating on the blog.
4. The visitor still gets THEIR theme: the FOUC script in the captured head
   applies the cookie theme pre-paint, and `ThemeProvider` re-syncs its state
   from an EXPLICITLY stored cookie/localStorage value post-mount (an explicit
   VALID value only — the defaultTheme fallback must not override a
   server-provided initialTheme for a visitor who never chose one, and an
   empty/garbage cookie value must not shadow a valid localStorage value).

Pinned by unit tests (capture stores it, tail replays it, the initializer
ignores storage — first-render parity — and the provider re-syncs) and a
dev+prod e2e whose fixture deliberately renders RAW theme text inside the
cached shell (the detonating shape): warm with no cookie, visit with a dark
cookie — dark class sticks, zero hydration errors, toggle text converges to
the visitor's theme, counter interactive.

`x-rango-shell: HIT | MISS` is the only header; the old
`x-rango-shell-resumed` marker handshake is gone — one layer now decides AND
composes, so there is nothing to hand off.

### Shell/payload parity: the capture data snapshot (scar tissue)

If you're about to touch capture or serve, start here — this is the subtlest
invariant in the whole feature.

A HIT does two things: it flushes the frozen prelude bytes, then it runs a FULL
FRESH Flight render for hydration (`serveShellHit` -> `buildFullPayload` ->
`renderToReadableStream`, then `resumeShellHTML`). React hydrates the frozen
prelude against that fresh payload. So the two MUST agree on every shell-baked
(non-hole) byte. They don't, automatically: anything in the shell whose value
DRIFTS between capture time and hit time — a `cache()` segment with a shorter
ttl than the shell, a tag-invalidated `"use cache"` item — makes the fresh
payload disagree with the prelude, and React throws "server rendered text didn't
match the client" and REGENERATES the tree on the client, wiping the FOUC theme
class and flashing content.

The live proof (theme-independent, fails with NO cookie): `tests/cloudflare-basic`
`/blog` renders a cache-info timestamp from a `cache({ ttl: 60, swr: 300 })`
ring-3 segment; the shell's own ttl is 300. After ~60s the ring-3 segment goes
stale and a background revalidation re-executes it with a new timestamp, so every
subsequent HIT's fresh payload timestamp differs from the prelude's baked one →
hydration mismatch pointing at `<p data-testid="cache-info">`. This is why the
classic `/blog` stays NON-ppr (its blog-cache suite must never depend on capture
behavior) and the PPR'd twin of the same shape lives at `/ppr-blog` — same
components, same sidebar parallel, same ring-3 `cache()` wrapping, plus the
`ppr` option.

The fix is the **capture data snapshot** — Next.js's resume-data-cache, adapted
to Rango's rings. The core invariant, which you should be able to recite:

> The snapshot is exactly the set of cache-store reads the CAPTURE render
> performed; replaying them on a HIT reproduces the shell content
> byte-identically; everything not recorded stays live.

This self-aligns with the hole doctrine. LIVE-lane loaders (behind `loading()`)
are MASKED at capture (never executed), so their reads are never recorded and
stay fresh on hits. Content that baked into the shell is, by definition,
content whose reads happened at capture. So "record what the capture read" and
"everything under a hole stays live" are the same rule seen from two sides.

The LOADER family (docs/design/loader-container-bake.md) extends the same
invariant to BAKE-lane loaders (no `loading()` on their entry): they EXECUTE
during capture (the flight gate's holdUntil covers their real latency), their
settled containers are promise-elided and recorded as
`{ family: "loader", key: <loader segment id>, value: <Flight string> }`, and
on a HIT `serveShellHit` deserializes them into `_shellLoaderSeed` so
`resolveLoaderData` overlays the recorded container onto the fresh run —
recorded paths pinned, hole-marker paths keeping the fresh run's live nested
promises. A rejected container REFUSES the capture (error UI never bakes), and
an identity read inside a bake-lane loader refuses via the guard's context
flag (`_shellCaptureGuardTripped`).

Mechanics (`src/cache/shell-snapshot.ts`):

0. **The write barrier (ordering edge, and its own scar tissue).** Before the
   capture's match/render, `attemptCapture` settles the background tasks the
   FOREGROUND request already scheduled (`settleTrackedBackgroundTasks`, over
   `reqCtx._pendingBackgroundTasks` — every `waitUntil` task is tracked there;
   the capture's own task opts out via `UNTRACKED_BACKGROUND_TASK` so the drain
   never awaits itself). Why this must be an ORDERING EDGE and not a narrower
   check: the foreground's ring-3 `cacheRoute` write is deferred, and without
   the barrier the capture's ring-3 lookup could land between the foreground
   write chain's serialization and its `store.set`, MISS, re-execute the route
   handler (bumping module-level state a consumer's shell may render — the mini
   shell-manifest seq), and then, via the synthetic `onResponse` fire below,
   OVERWRITE the foreground's entry with the capture's re-render. A
   get-before-set guard would just shrink that window. The contract the barrier
   enforces: a capture never clobbers a ring-3 entry the foreground produced —
   all foreground cache writes are scheduled before `scheduleShellCapture` runs
   (the response and its `onResponse` callbacks commit first), so settling them
   makes the capture's lookup HIT, replay the foreground's generation (handler
   skipped; the cache-store middleware's write path is gated off by
   `state.cacheHit`), and record THAT generation. Prelude, snapshot, and ring-3
   then agree by construction. The drain is iterative (a settled task can have
   scheduled a nested one — `cacheRoute` schedules its actual `store.set` in a
   second `waitUntil`) and deadline-bounded (a hung consumer `waitUntil` task
   degrades to the pre-barrier race instead of stalling the capture).
1. **Recording.** The capture render reads through a `RecordingShellStore` wrapping
   the derived context's `_cacheStore` (own property, so the shared foreground
   store is untouched). It passes every call through and RECORDS, last-write-wins
   per `(family, key)`: read-HITS (`get`/`getItem`/`getResponse` returning
   non-null — the value that fed the shell) and WRITES (`set`/`setItem`/
   `putResponse` — the value a MISS computed and baked). The shell family
   (`getShell`/`putShell`) is never recorded (the snapshot rides inside a shell
   entry — recording it would be self-referential). Reads that MISS are not
   recorded.
2. **Two write asymmetries you must know about.** An item-family `"use cache"`
   write runs INLINE during the render (cache-runtime schedules it on
   `requestCtx.waitUntil`), so it flows through the recording store naturally. A
   ring-3 SEGMENT write (`cacheScope.cacheRoute`) is registered via
   `requestCtx.onResponse(...)` and gated on a 200 — and the capture builds no
   Response, so it never fires on its own. `captureAndStoreShell` therefore FIRES
   the capture's ISOLATED `_onResponseCallbacks` with a synthetic 200 after the
   shell quiesces, so the segment write runs and is recorded. (Only capture
   match-middleware callbacks live in that array — HTTP middleware never runs for
   a capture — so firing them is safe.) Both write kinds are DEFERRED under
   `waitUntil`, so the derived context's `waitUntil` is overridden to COLLECT the
   write promises, and `settleWrites` drains them ITERATIVELY (a write can
   schedule a nested write — `cacheRoute` schedules its actual `store.set` in a
   second `waitUntil`) before the snapshot is drained. Miss this and a
   MISS-at-capture value silently drifts.
3. **Storage.** The snapshot is an optional `ShellCacheEntry.snapshot` array of
   `{ family, key, value }`, kept JSON-serializable (responses carry base64
   body + headers + status; items/segments are already JSON-able stored forms).
   It rides with the rest of the entry. NOTE: the CF and Vercel stores cherry-pick
   entry fields into a custom KV/Blob envelope, so `snapshot` (and `initialTheme`)
   are explicitly carried there (`KVShellEnvelope.sn`/`.i`,
   `VercelShellEnvelope.sn`/`.i`) — a new field on `ShellCacheEntry` that those
   envelopes forget silently no-ops on the real stores.
4. **Seeding.** `serveShellHit`'s tail runs through a `SeededShellStore` overlay
   (on a derived context, for the tail render ONLY — the shared `reqCtx` is
   untouched). A read for a snapshotted key returns the recorded value AS FRESH
   (`shouldRevalidate: false` — a pinned key must NOT kick SWR revalidation);
   every other read falls through to the real store (the holes stay live); all
   writes pass through (a live hole's loader may legitimately write); the shell
   family always passes through.

Both tail shapes — seeded and fragment-only — also wire a fresh render barrier
onto their derived context, closure-bound to that context and the request's
handle store. Matching records streaming state on the derived context. Reusing
the base context's barrier would make its resolver see a non-streaming tree,
snapshot handles before streamed pushes settle, and give `ctx.rendered()` an
empty inherited snapshot on a shell HIT.

The freshness DOCTRINE, and it is deliberate: **within a shell's lifetime, shell
regions intentionally show CAPTURE-time data.** Parity beats freshness INSIDE the
shell; freshness comes from the holes, from the shell's own ttl/swr, and from tag
invalidation of the SHELL (`cacheTag()` / `ppr.tags`). Tags are optional: an
untagged shell intentionally uses TTL/SWR-only invalidation. Ring-1/ring-3 tag
invalidation does NOT invalidate a shell — if you need that coupling, put the
same tag on the shell.

Two edges worth stating out loud:

- A key read BOTH above and below a `loading()` boundary is seeded everywhere, so
  the hole shows capture-time data for that one key. Consistent by design.
- The snapshot pins CACHED reads. UNCACHED nondeterminism in shell content — a raw
  `Date.now()`/`Math.random()`/uncached `fetch` rendered directly in a handler
  outside any cache ring — still drifts and must live under a hole. Same residual
  consumer responsibility as Next; the snapshot cannot pin what was never a cache
  read.

Pinned by unit tests (the write barrier settles foreground + nested tasks before
the capture match and is deadline-bounded; recording records hits+writes per
family and excludes the shell family; seeding serves fresh with no revalidation
kick, falls through, and passes writes through; JSON + `putShell`/`getShell`
round-trips including the CF and Vercel envelopes) and dev+prod e2e: a drift
fixture (`/shell-cache/drift`, `/ppr-drift`) whose short-ttl cached shell value
survives its ttl on a HIT with byte parity and zero hydration errors while a
live hole still updates; the `/ppr-blog` twin (realistic sidebar + ring-3 shape)
hydrating cleanly on the real KV-backed `CFCacheStore`; and the mini
shell-manifest e2e, which pins the no-clobber contract (a reload replays the
FOREGROUND's shell generation — handler seq stable — while prices stay live).

## The hole doctrine (encode verbatim)

Holes are RENDER-DEFINED. The capture is MIXED-CHAIN: it renders the page under
a derived context — `cache()`d segments replay per normal ring-3 semantics,
UNCACHED segments execute their handlers fresh. A capture render behaves like a
normal render with respect to the segment cache, with ONE addition the capture
data snapshot needs: it fires its own `onResponse` callbacks with a synthetic 200
so the ring-3 segment write runs during capture and is recorded (see "the capture
data snapshot" above). Runtime background capture does NOT re-run middleware: it
already ran for the triggering request, and the derived context inherits its
post-middleware state; guarding is serve-time (the commit point above). Build
producer B is different: it replays middleware once with `ctx.build === true`
before deriving the capture context.

> **(a) STRUCTURAL: the ENTIRE segment subtree under a `loading()`
> registration** — loaders masked at capture, the boundary postpones, the
> fallback baked in the shell as route structure.
>
> **(b) PHYSICS: any promise NESTED in handed-over data still pending at
> capture, under the consumer's own Suspense** — handler props, handle values
> (`push({ x: promise })`), loader-carried. Deterministic via the
> task-quantized quiesce (real I/O cannot win the window).
>
> **(c) SHELL: awaited handler data (the `handleStore.settled` precondition
> stays), TOP-LEVEL `push(promise)` — awaited before SSR, baked — resolved
> promises, replayed cached segments.**

### Shell invalidation is DERIVATIVE (render-recorded tags, #648)

PPR has no first-class key or tag API of its own, and it should not grow one. The
reason is the composition doctrine: PPR is execution-PRESERVING — a HIT still runs
everything underneath (middleware, holes, the worker handles every request); only
the document bytes are shortcut. That is unlike `cache()`/`"use cache"`, which are
execution-PREVENTING (a hit means the wrapped work does not run). Because the two
layers compose rather than substitute, PPR's invalidation is DERIVATIVE: the shell
is invalidated by the tags of whatever rendered into it.

The instrument is the render-callable `cacheTag()` (see `use-cache-api-design.md`).
A server component that renders into the shell calls `cacheTag("campaign:spring")`
with no `cache()`/`"use cache"` in its tree; the tag records onto the capture
context's `_requestTags`, which the capture unions with the route's static
`ppr.tags` and stores on the shell entry. `revalidateTag("campaign:spring")` then
drops that shell. The document cache reads the same set, so every document-level
artifact shares the contract.

Leaving the shell untagged is valid when TTL/SWR is the complete freshness
policy. Rango emits no warning for that choice. Operators who enable
`debugShellCapture` can observe `untaggedBake: true` on a stored attempt when a
bake-lane loader contributed material to an untagged shell.

The expiry invariant holds BY CONSTRUCTION, no filtering logic:

- **tagged bake ⇒ evicts** — a component/loader that bakes into the shell executes
  during capture, so any `cacheTag()` call records and rides onto the entry.
- **hole ⇒ fresh** — a subtree behind a renderable `loading()` is masked during
  capture (its loaders never run), so nothing under a hole can tag the shell; it
  stays live and re-renders per request regardless of tag invalidation.

Timing: the tag snapshot sits at the putShell WRITE BARRIER (`captureAndStoreShell`,
right before it builds the `ShellCacheEntry`), not at stream construction. By the
barrier the capture has already quiesced — handles settled, Flight task-quiet — and
the deferred cache writes were awaited, so any tag the render recorded onto
`_requestTags` is on the set: a `cacheTag()` in a synchronous server component (the
#648 case) AND a tag recorded only AFTER an `await` inside an async server component
(#676), plus tags propagated by async `cache()`/`"use cache"` reads at capture
(their `recordRequestTags` can post-date the render). This mirrors the document
cache, which buffers the full response body before `collectRequestTags`. The earlier
`attemptCapture` snapshot — taken right after `renderToReadableStream` returned,
before React had rendered anything past the first await — dropped those late tags
silently; moving it behind the quiesce gate closed that window (issue #676). Holes
are unaffected by the move: a masked loader never executes during capture, so
nothing under a hole records a tag regardless of when the snapshot runs — the
baked ⇒ evicts / hole ⇒ fresh invariant above still holds by construction.

### The handles contract: "nesting = liveness"

Verified against the shipped semantics (`src/handles/deferred-resolution.ts`):
the full-render payload uses `resolvedHandleStream`, whose resolution is
SHALLOW — only an entry that is ITSELF a thenable is awaited
(`isThenable`); a container that merely holds a promise passes through
verbatim. So the contract holds without new resolution code:

- `push(promise)` TOP-LEVEL: awaited server-side before the payload's handles
  row emits — baked shell material. The capture gate is HELD open for the same
  await (`gateFlightForCapture`'s `holdUntil` = `getData().then(
resolveDeferredHandleValues)`), because a pushed promise with real latency
  would otherwise lose the byte-quiet race, freeze out the handles row, and
  root-suspend the prerender. Holding the gate can never delay a hole (holes
  emit no bytes; holding only admits shell rows) and is bounded by `maxWaitMs`.
- `push({ x: promise })` NESTED: preserved by FlightSerialize, streams to the
  consumer, who must Suspense it — a hole under capture.

The one asymmetry versus loaders, stated once: a LOADER container is a hole via
`loading()` (the entire loader value is the live lane), while a HANDLE
container is shell via root consumption (the handles generator drains before
SSR). The unified rule: **a promise nested inside your data is never baked;
the container settles.** Related `cache()` fact, orthogonal to ppr: the segment
codec deep-settles promises at the ring-3 write, so nothing inside a `cache()`
boundary can stay live.

Because uncached handlers EXECUTE during capture, the `cookies()`/`headers()`
capture guard (`assertNotInsideShellCapture`, `src/server/cookie-store.ts`) is
load-bearing: identity reads throw inside a capture render. Loaders are exempt
(always fresh). And `ssr.resolveStreaming` returning `"allReady"` bypasses PPR
entirely — bots/SEO crawlers get one complete axis-1 document.

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

The serve path is integral to the RSC render pipeline (see "The serve pipeline
and the commit point" above). Capture does not re-run the pipeline; it runs as
a render-layer background task that re-derives the page via `router.match()`
under its own derived context.

```
MISS ──> axis-1 serve (x-rango-shell: MISS)
           rsc-rendering, after building the response (200 HTML only):
             scheduleShellCapture(descriptor from the ppr path option)
               runBackground: runWithRequestContext(derivedCtx, () =>
                 router.match()  [MIXED-CHAIN: cache()'d segments replay,
                                  uncached handlers execute; loaders MASKED]
                 ──> buildFullPayload ──> Flight render
                 ──> ssrModule.captureShellHTML (prerender + abort)
                 ──> store.putShell(key, { prelude, postponed, ... }))

HIT  ──> committed composed response (x-rango-shell: HIT)
           prelude bytes flushed immediately
           tail (inside the response stream, kicked off synchronously):
             router.match() ──> buildFullPayload ──> Flight render
             ──> ssrModule.resumeShellHTML(postponed)
           (+ scheduleShellCapture on a stale/SWR hit)
```

Why `router.match()` and not a pipeline re-run for runtime capture: the
middleware chain (auth, logging) must run exactly once per request. It already
ran for the triggering request; the derived context inherits the
post-middleware state (variables, cache store) while overriding the
render-scoped accumulators (a fresh handle store, request-tag set, and
transition list). No double middleware side effects, and the served response is
never blocked on the capture
(`runBackground` = `waitUntil` on workerd, fire-and-forget in Node dev).

`_shellCaptureRun` on the derived context is the single ACTIVE marker: loader
masking (`loader-mask.ts`), the `emitStreaming` guard (`fresh.ts`), and the
`cookies()`/`headers()` capture guard (`cookie-store.ts`) all key off it. The
old `_shellResume`/`_shellCapture` request-context flags are gone — the
integrated serve path builds the `ShellCaptureDescriptor` locally and passes it
to `scheduleShellCapture` directly.

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
    maxWaitMs?: number;       // guard, default 15000
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
  fixed `POST_QUIESCE_TASK_HOPS` (= 16) macrotask hops, then `controller.abort()`.
  `prerender`'s promise settles only after the abort when holes are pending —
  start it first, run the abort logic concurrently. By the time `quiesce`
  resolves the Flight input is byte-quiet AND frozen (see "Capture quiesce:
  task-based, not wall-clock" below), so the hops are deterministic and
  `maxWaitMs` is only a pathological guard that should never fire.
- Why 16 hops and not 2 (replay-only scar tissue): under replay-only the capture
  Flight render serializes ALREADY-serialized ring-3 segments, so it emits the whole
  payload in the first tick and the gate quiesces almost immediately. On the old
  fresh-execution capture the Flight dribbled out as handlers ran, so Flight-quiet
  effectively meant "the shell has rendered" and 2 hops sufficed. Under replay,
  Flight-quiet fires BEFORE the fizz side has consumed the instant payload and
  rendered the shell to `<body>`, so the fizz needs a real buffer of turns after
  quiesce — with 2 hops the abort lands on an unrendered tree (empty prelude, root
  postpone) and the sanity gate refuses (this is exactly what the cloudflare-basic CF
  store surfaced: `segs=7` replayed, `0B` prelude). Still task-based — masked loaders
  never emit, so more hops never lets a hole settle; a cold worker whose
  first attempt still under-renders heals on the in-place retry.
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
  buildVersion?: string;    // build stamp at capture time (second validity gate)
  createdAt: number;        // epoch ms
}

supportsPassiveShellReads?: true;
getShell?(key: string, options?: { claimRevalidation?: boolean }): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null>;
putShell?(key, entry, ttlSeconds?, swrSeconds?, tags?): Promise<"stored" | "invalidated" | void>;
```

One entry carries both artifacts — the pair is version- and generation-coupled
and must never mix (Next's platform guide makes this an explicit requirement).
Implementations: memory store (tests/dev), CF store (Cache API L1 with KV as
the durable cross-colo L2), Vercel store (runtime cache; respect the 2 MB item
cap — skip storage with a debug log when over).
Shell entries participate in `invalidateTags` via the same tag machinery as
their store's item family.

Stores that don't implement the family degrade a `ppr` route to axis 1 (with a
once-per-key warning, since the declared intent cannot be honored).

### Serve plumbing (`src/rsc/shell-serve.ts` + `src/server/request-context.ts`)

`shell-serve.ts` owns the config/key/store helpers the render layer uses at the
commit point: `resolvePprConfig` (normalizes the route's `ppr` option;
`DEFAULT_PPR_TTL_SECONDS` = 300), `buildShellKey`
(`${host}${pathname}${sortedSearch}:shell` — host-scoped so multi-tenant shells
never collide), `shellSearchSeed` (the key's search portion, ALSO the string
the capture and resume SSR renders seed their store with — search is part of
shell identity, so static-part `useSearchParams` reads bake what the key
names; one shared derivation is what keeps key, capture, and resume
byte-agreed), `isValidShellHit` (reactVersion + buildVersion gates — the
postponed blob encodes hole positions against one exact tree, so neither a
React upgrade nor an app redeploy may resume a stored blob),
`hasIntactShellPayload` (pre-commit integrity check: an undecodable prelude or
unparseable postponed degrades to a MISS instead of throwing after the 200 +
prelude committed), `hasShellFamily`, the
once-per-key missing-store-family warning, and `warnPprNonceActiveOnce` (the
once-per-key active-per-request-nonce warning; see the nonce-gate scar tissue
above). The route's ppr config is read
off the CLASSIFIED route snapshot (`reqCtx._classifiedRoute.manifestEntry`),
which the RSC handler stores before dispatching the render — available before
`match()` runs, which is what makes the eager HIT flush possible.

The only request-context flag left is `_shellCaptureRun` (the ACTIVE capture
marker; internal). The capture descriptor (`ShellCaptureDescriptor` in
`shell-capture.ts`: key/ttl/swr/tags/store/debug) is passed by value.

There is NO public middleware: `createShellCacheMiddleware`/`ShellCacheOptions`
were removed (see the dead-ideas ledger).

### Render orchestration (`src/rsc/rsc-rendering.ts` + `src/rsc/shell-capture.ts`)

The document branch of `handleRscRenderingInner` starts with the PPR serve
block (commit point, above). On a HIT, `serveShellHit` commits the composed
response and runs the live tail inside the stream. On a MISS the axis-1 flow is
unchanged; after building the response, a servable 200-HTML document schedules
`scheduleShellCapture` with the descriptor built from the route's ppr config,
and the response is tagged `x-rango-shell: MISS`.

`scheduleShellCapture` (in `shell-capture.ts`) is the single owner of the
stampede guard (one capture per key per isolate) and the refused-capture
backoff. It dispatches `runBackground(reqCtx, runShellCapture)`.
`runShellCapture` builds the derived context (`Object.create` of `reqCtx`
overriding a fresh handle store / request-tag set / transition list,
`_shellCaptureRun: true`, a fresh `_metricsStore`), then under
`runWithRequestContext` re-derives the page: `router.match()` (mixed-chain;
loaders masked), `buildFullPayload` (`full-payload.ts`, shared with the
foreground so the captured tree matches the served tree — the `resume`
precondition), a fresh Flight render, then the seal → holdUntil/quiesce →
`captureShellHTML` → `putShell` flow. A redirecting match aborts with no store
write; every error routes through `reportCacheError`.

Known trap — the handles generator: `SsrRoot` consumes
`payload.metadata.handles` to completion before rendering anything
(`consumeAsyncGenerator`, `src/ssr/ssr-root.tsx`). In capture the generator
completes once the pushes settle; a deferred handle whose resolver depends on a
masked loader can never resolve, so `SsrRoot` suspends at the root, the prelude
comes back trivial, and the sanity gate refuses to store — the designed
fail-safe no-op.

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
the route ever flip to HIT). Under `descriptor.debug` (INTERNAL_RANGO_DEBUG)
each attempt emits one concise breadcrumb instead of a stack dump.

### Refused-capture backoff (declaring ppr on an ineligible route)

An ineligible route — a loader route without `loading()`, or a cookie-reading
handler whose capture throws — refuses on every request. Without a memory of
that, a `ppr`-declared route in that shape would schedule a doomed background
render on EVERY request it serves. `scheduleShellCapture`
keeps a module-level negative cache (`refusedCaptures`): a key enters backoff only
after the in-place retry ALSO failed (or a genuine error), and within the window
the key is not re-probed.

The window is EXPONENTIAL in the consecutive-failure count —
`min(BASE * 2^(failures-1), ceiling)`, so 1 s, 2 s, 4 s, … up to the mode's ceiling
(`REFUSED_CAPTURE_BASE_MS`, and the ceiling below). A flat window conflated two
very different failures. A structurally ineligible route fails forever and wants a
long cap. But a cold-but-ELIGIBLE route can also fail the retry under a truly cold
graph (dev module transform, or a cold worker under parallel load), and it must
recover on the next request or two — freezing it would re-break the cold-start DX
the retry exists to fix (this is not hypothetical: a flat 60 s backoff made the
cloudflare dev PPR e2e time out, because `warmToHit`'s multi-request recovery was
blocked). Escalating from 1 s lets the eligible route re-probe almost immediately
(warm now → HIT, which clears the entry), while the doomed route ramps to the cap
within a handful of failures. Either way an app-wide mount never re-renders a
doomed route on every request. A successful capture clears the entry outright.

The ceiling is MODE-DEPENDENT (`refusedCaptureCeilingMs`): 60 s in production
(`REFUSED_CAPTURE_MAX_MS`), but only ~2 s in dev (`REFUSED_CAPTURE_DEV_MAX_MS`).
The reason is that in dev the DOMINANT no-shell cause is a cold module graph that
warms on the very attempt that failed, so a long window is pure harm — and even the
escalating window eventually climbs past ~16 s, which OUTLASTS the e2e warm window.
That was the residual cold-CI failure (#652 item 3): on a slow CI runner the first
capture races an unfinished shell, each re-probe is also cold and climbs the count,
and once the window exceeds `warmToHit`'s 20 s poll every subsequent request is
skipped as backed-off — an eternal MISS even though the modules are warm by then.
Capping the dev window at ~2 s keeps a cold-but-eligible route re-probing roughly
every 2 s across the whole warm window, so one of those warm re-probes always lands
inside it. Production keeps the full 60 s cap because there the no-shell cause is
far more likely to be a genuinely ineligible route, which should be re-probed
rarely. (This is item 3 of #652; items 1–2 — barrier narrowing and drain
unification — remain open.)

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
documented shell anti-pattern — put per-request data in a loader (masked) —
and it degrades to a hydration repair, not corruption, if it happens. Freezing also guarantees no post-quiesce byte, including an error
row from any later abort/cancel of the underlying render, can corrupt the frozen
prelude.

On the fizz side (`captureShellHTML`, `src/ssr/index.tsx`) the wall clock is gone
too: once `quiesce` resolves the input is frozen, so a fixed `POST_QUIESCE_TASK_HOPS`
(= 16) macrotask hops — enough turns for React to consume the instant replay payload,
flush the settled shell, and mark still-pending boundaries as postponed — precede
`controller.abort()`. No `Promise.race` against a clock except the `maxWaitMs` guard.
(The count rose from 2 to 16 with replay-only: the replay Flight is emitted in one
tick, so the fizz needs more post-quiesce turns to render the shell before the abort
— see "Abort ordering" above.)

**Follow-up, upstream-gated: `onPostpone` as the abort signal.** The hop count
is the LAST heuristic left in the capture gate — a counted guess at "React has
marked the expected holes postponed." React's renderers expose an `onPostpone`
callback (per postponed boundary); vite-plugin-react PR #1285 adds it to
plugin-rsc's option types. When a plugin-rsc release ships it (> 0.5.27, our
current pin), spike replacing the fixed hop count with an event-driven cutoff:
abort once every masked-loader hole has fired `onPostpone` (the hole set is
known before the render — it IS the masked loaders). Keep the hop count as the
fallback: it is proven against #702 (ready-but-queued multi-MB outlined
boundaries must never lose the race), and any `onPostpone`-driven cutoff must
beat "known-good and deterministic" before it replaces the count. Verify first
that the HTML-side `react-dom/static.edge` prerender — the pass we actually
abort — surfaces a usable `onPostpone` in the vendored build, not just the
Flight-side renderer.

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
`shell-capture.ts`). The serve path's shell lookup (`getShell`) is not
separately instrumented in v1.

## Loaders and handles under PPR

Loaders are the live lane — always fresh, never cached — and that is exactly
what makes them the holes. Capture masks them (never executed, never-resolving
values), so a loader-consuming subtree BEHIND a `loading()` boundary suspends
and postpones there (see "The hole contract" above — without `loading()` the
await happens at tree-build and there is no hole, only a refused capture).
Serve runs them fresh through the unchanged execution path; `resume` streams
their output into the frozen shell's holes. Fetchable loaders and refresh
groups are `_rsc_loader` requests and never touch the PPR serve path.

### Handler-side consumption: the consumption-lane rule

For every shared-artifact capture — `cache()`, `"use cache"`, and the PPR
shell — HOW a loader is consumed decides its lane:

- **Server-side handler consumption** (`await ctx.use(loader)`) is the BAKED
  lane. During capture the loader EXECUTES, and its identity reads
  (`cookies()`/`headers()`) are PERMITTED: the shell guard exempts
  handler-invoked loader bodies (`assertNotInsideShellCapture` consults
  `isInsideHandlerInvokedLoaderBody()`, the `handlerInvoked` flag riding the
  loader-body ALS — set by `useLoader` when the invoking ctx.use ran outside
  the DSL loader scope, the same discriminator the deadlock guard uses). The
  value freezes as a capture-time copy wherever it renders as unshielded
  shell material — a documented footgun, identical to cache()'s existing
  purity allowance for handler-consumed loader values.
- **Client-side consumption** (`useLoader` in a `"use client"` component) is
  the LIVE lane: fresh per request, per visitor.
- **DSL `loader()` segments** keep their lane machinery unchanged: renderable
  `loading()` = live (masked at the `resolveLoaderData` funnel), otherwise
  bake (executes at capture WITH the identity guard active). Corollary worth
  stating: when a handler consumes a loader that is ALSO registered live-lane
  on the same subtree (the parallel-slot shape: `loader()+loading()` plus
  `await ctx.use(...)` in the slot handler), the segment's masked
  `loaderDataPromise` still pins the slot's LoaderBoundary (segment-system),
  so the slot stays a LIVE hole — the handler's baked copy is discarded with
  the postponed subtree; the executed body's only capture-time observable is
  its side effects.

Pinned by semantic-matrix row `[PPR3]`, `e2e/shell-cache.test.ts` (slot-use
cases: the unshielded chip BAKES frozen across HITs and visitors; the
registered live-lane slot stays a fresh hole), and the cache()-tier twin in
`e2e/cache.test.ts` ("handler ctx.use value is a baked copy"). Stated once in
`docs/internal/execution-model.md` ("The consumption-lane rule").

History (scar tissue): issue #672 was first fixed by MASKING handler
consumption (priming the ctx.use memo map with never-settling promises plus a
handle-store release race). That contradicted the cache() precedent and broke
cache()-composed fixtures: masking cloudflare-basic's ring-1-cached /ppr-blog
sidebar left its slot handler pending forever, the capture's ring-3
cacheRoute write hung Flight-serializing the never-settling component, the
snapshot drained empty (settleWrites timeout), and every HIT
hydration-mismatched against the prelude (React #418). The rule replaced the
machinery outright: handler-consumed loaders settle normally, so captures
quiesce, ring-3 writes serialize, and snapshots record — no masking special
cases, no release deferreds.

The identity footgun is the accepted trade: an identity read in a
handler-consumed loader bakes the CAPTURE request's value into the shared
shell. Keep identity in client-consumed loaders (live holes) when it must
stay per-visitor.

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

## Constraints (the contract with consumers)

| Case                       | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell content              | shared per host+URL key — personalization must live in loaders/holes (the shell-manifest pattern). ENFORCED: `cookies()`/`headers()` reads throw during a capture render (`assertNotInsideShellCapture`, cookie-store.ts), making cookie-reading shells PPR-ineligible by construction                                                                                                                                             |
| Multi-tenant / host-router | the default key incorporates `url.host` so one tenant's shell can never compose into another tenant's page on a shared worker + store; custom `keyGenerator`s own host scoping themselves                                                                                                                                                                                                                                          |
| Status/headers/cookies     | committed with the live response's headers before the first shell byte; a failing hole cannot become a 500/redirect — error UI renders inline via Suspense/error boundaries. Handler/loader header WRITES on a ppr route throw — see "The header doctrine" below                                                                                                                                                                   |
| Actions / PE / formState   | always axis 1                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Partial RSC navigation     | replays the capture's canonical segment record when eligible, then applies normal `matchPartial()` diff/revalidation with fresh DSL loaders; otherwise ordinary axis 1. No HTML/Flight resume and no client-visible protocol flag                                                                                                                                                                                                  |
| Per-request nonce          | always axis 1                                                                                                                                                                                                                                                                                                                                                                                                                      |
| React/router upgrade       | shells invalidated via `reactVersion` check (treated as a miss on mismatch; recapture overwrites and TTL ages the entry out — v1 has no `deleteShell`)                                                                                                                                                                                                                                                                             |
| App redeploy (same React)  | shells invalidated via the `buildVersion` check — a persistent shared store (KV/runtime-cache) survives deploys, and resuming an old build's postponed blob against the new build's tree would tree-mismatch AFTER the 200 + prelude committed. Pre-field entries miss the same way. Corrupt entries fail `hasIntactShellPayload` pre-commit and degrade identically; a tail failure on a served HIT schedules a healing recapture |
| Dev server                 | works; shells are memory-store-scoped and cheap to recapture; HMR edits produce stale shells until TTL/recapture — documented, acceptable                                                                                                                                                                                                                                                                                          |
| Composite response         | per-request; only the shell entry is cacheable. Note ordering with the document cache: if the document-cache middleware wraps a ppr route, it may cache the composite — correct output, but it makes shell caching redundant for that route. Pick one per route.                                                                                                                                                                   |

### The header doctrine (issue #713)

**`ppr` is a document-scoped `cache()`; in any cached scenario ONLY MIDDLEWARE
writes response headers.** That is the entire rule.

Handler and loader header writes (`ctx.headers.set/append/delete`, the
RequestContext `header`/`setCookie`/`deleteCookie`/`setStatus`/`setTheme`
lane, and raw `ctx.res.headers` mutations) THROW on a ppr route — on every
render, dev and prod, MISS and HIT alike — through the same unified guard
that already refuses them inside a `cache()` boundary
(`assertCachedHeaderWriteAllowed`, `src/server/context.ts`; latched by the
segment funnels via `latchPprHeaderScopeForEntries`). Deterministic: the first
dev render fails loudly, so a MISS/HIT header divergence can never ship. Why a
guard and not replay: a handler runs on MISS/capture but is replayed on HITs,
so any header it writes silently differs between MISS and HIT (field evidence:
a storefront session bug from exactly that cookie-shaped divergence). Loaders
are live but POST-COMMIT — the response headers flush with the shell prelude
at TTFB before any loader settles, so loader writes are dead letters on HITs
by physics. Middleware is THE header lane: it wraps the commit point, runs on
every request including HITs, and its stub-response writes merge into every
response (`createResponseWithMergedHeaders` -> `applyStubHeaders`,
`src/rsc/helpers.ts`). One deliberate asymmetry survives, and it is loader-KIND
specific (#725): a DSL (registered) loader's writes inside a plain `cache()`
boundary stay ALLOWED — a registered loader re-runs on every HIT
(`runInsideLoaderScope` in `fresh.ts` -> `resolveLoadersOnly` on the cache-hit
path) and merges into every response, so no divergence exists (pinned by the
`/loader-cookie-allowed` cache-scope-guard e2e and vite-rsc-demo's shop cart).
A **handler-invoked** loader body (`await ctx.use(Loader)` from a handler,
never registered with `loader()`) does NOT get the exemption: on a HIT the
handler is skipped, so that loader never re-runs and its Set-Cookie/header
would land only on the MISS — it throws exactly like a handler write. The
discriminator is `isInsideLoaderScope()` (DSL scope only, `loaderScopeALS`),
not `isInsideAnyLoaderScope()` (which also sees the handler-invoked
`loaderBodyScopeALS`); because the DSL scope ALS survives nested `ctx.use`
bodies, a handler-invoked loader nested under a DSL loader stays exempt (its
DSL parent re-invokes it every HIT). ppr loader writes throw regardless — the
shell prelude flushes before any loader settles.

**`ctx.dynamic()` re-permits the handler write (issue #735).** A handler that
calls `ctx.dynamic()` opts this request off the shell axis — `rsc-rendering.ts`
skips both the HIT commit and the MISS capture on `_dynamic`, so the route is
ALWAYS live: every request re-runs the handler and its header write lands
identically each time. The guard's reason to forbid it (MISS/HIT divergence)
evaporates, so `ctx.dynamic()` clears the ppr latch
(`clearPprHeaderScope`, `src/server/context.ts`) and the same-handler
`ctx.headers.set()`/`cookies().set()` that would otherwise throw now lands on
every response. Ordering is a contract: call `dynamic()` BEFORE the write — a
write before it hits the still-live latch and throws (pinned dev+prod by the
`/ppr-header-guard/dynamic` e2e in both apps). `dynamic()` drops only the SHELL
axis, never the CACHE axis:

- A `cache()` boundary entered AFTER `dynamic()` re-latches `"cache"` (the field
  is undefined again, so `latchCachedHeaderScope`'s `!store.cachedHeaderScope`
  guard sets), so a handler write inside that cache() still throws.
- A ppr route NESTED under a `cache()` boundary latches `"ppr"` at the funnel
  top (`fresh.ts`, first-wins), which masks the positional `cache()` latch — but
  the handler still runs inside the cache scope (`insideCacheScope`). A
  `cache()` HIT skips that handler, so the write is still non-deterministic:
  `clearPprHeaderScope` UNMASKS to `"cache"` there instead of clearing, so the
  guard keeps throwing (accurate cache() wording). Only a pure-ppr funnel
  actually clears.

And `dynamic()` from MIDDLEWARE is a no-op for the latch: middleware runs
outside the funnel `Store.run` scope, so nothing is latched to clear — the
middleware exemption is unchanged.

The exhaustive write-site table (issue #726/#735):

| Write site                      | Pre-commit?         | Same every request? | Verdict                 |
| ------------------------------- | ------------------- | ------------------- | ----------------------- |
| Middleware                      | yes                 | yes                 | legal                   |
| Handler, shelled (ppr) route    | frozen, gone on HIT | no                  | guard throws            |
| Handler, `ctx.dynamic()` route  | yes (always live)   | yes                 | **re-permitted (#735)** |
| Loader behind `loading()`       | no (post-commit)    | —                   | forbidden               |
| Loader in plain `cache()` (DSL) | buffered, re-runs   | yes                 | existing exemption      |

Note this is a WRITE-only narrowing. The request-scoped READ guard
(`isInsideCacheScope`, `src/server/context.ts`) deliberately stays on the
BROAD predicate (`isInsideAnyLoaderScope()`): a handler-invoked loader's read
under `cache()` bakes a shared copy into the cached artifact — the accepted
consumption-lane tradeoff (#672/#674) — whereas a write has no baked-copy
semantics on a HIT, so only writes narrow to DSL scope.

Mechanics (the invariants the code comments point at):

- **One choke point, not enumerated wrappers.** Every consumer-reachable
  mutation of the stub response's Headers funnels through a guarded proxy
  shadowed onto the stub `Response` instance
  (`createRequestContext`, `src/server/request-context.ts`): `ctx.header`,
  `setCookie`/`deleteCookie` (and `cookies().set`), `ctx.setTheme`, the
  handler `ctx.headers` proxy, and raw `ctx.res.headers.set(...)` all hit the
  guard at the mutation itself. `setStatus`/`onResponse` are not Headers
  mutations and stay individually guarded. Internal serve machinery
  (`_rotateStateCookie`, `_setKeepCacheDirective`) writes to the raw Headers —
  `invalidateClientCache()`/`keepClientCache()` are documented callable from
  loaders and during capture.
- **Latch lifetime = funnel scope.** The latch is a field on the RangoContext
  ALS store; each funnel runs inside its own `Store.run` scope and
  `runWithStore` deliberately never copies `cachedHeaderScope`, so the latch
  dies when the funnel scope unwinds. That is the whole middleware exemption:
  pre-`next()` writes happen before any latch exists, post-`next()` writes
  happen after the scope died — pinned by the `/ppr-header-guard/mw-post-next`
  e2e (post-next header + cookie land on MISS and HIT). The serve/commit
  path's stub reads and Set-Cookie drain (`rsc/helpers.ts`) run outside any
  latched scope for the same reason.
- **Guard and serve share predicate AND input.** The latch checks the LEAF
  route entry (`entries[entries.length - 1]`, the `manifestEntry`) with the
  same `isPprEntry` predicate the serve path feeds `resolvePprConfig` — a ppr
  declaration on a non-leaf ancestor neither shell-serves nor latches.
- **Intercept funnels carry a defense-in-depth latch.** ppr and intercepts do
  not compose on the shell path (shells are captured/served only for document
  requests; `withInterceptResolution` skips intercepts on full matches), but a
  partial nav can render an intercept over a ppr-declared target in its own
  store scope — `resolveInterceptEntry`/`resolveInterceptLoadersOnly` latch
  off the target route's manifest entry, after intercept middleware runs.

Six-framework survey (2026-07, issue #713): the ecosystem splits by SURFACE.
Response-object endpoints (Next route handlers, Nitro, vinext handlers) replay
captured headers — with Set-Cookie as an open wound (Nitro session-fixation
issue #3468; Next silently caches Set-Cookie). Document/page surfaces — our
surface — are doctrine-B unanimously: no framework replays page-code headers
from a document cache entry (Next app pages expose no mutable header API and
`cookies().set()` throws at render; SvelteKit and Astro silently drop, a
self-acknowledged wart; React Router 7 makes it a build error when no live
lane exists). Next's derived `revalidate -> Cache-Control` does not transfer:
`ppr.ttl/swr` governs the WORKER-INTERNAL shell entry, never HTTP
cacheability — ppr responses are dynamic by design (live holes, live
middleware, per-request payload rows; the worker handles every request). The
only "special" cached header in the ecosystem is Vercel's postponed-state
transport for their CDN-split serving model — rango has no split, so no
analog exists. NO replay machinery, NO derived headers, NO exclusion
taxonomy. A someday-option (not built): RR7-style declarative per-route
`headers()` use-item on the live lane, if a request-dependent need
materializes.

## Platform notes

Cloudflare Workers: the in-worker pattern is the endgame — the worker always
runs (~5 ms cold starts); the win is skipping shell-render CPU and its
upstream reads. `waitUntil` (via `runBackground`) covers capture. The
`waitUntil` lifetime — workerd allows roughly 30s of work past response
completion — is the PHYSICAL ceiling on `ppr.captureTimeout`: a budget at or
past it gets the capture killed by the platform mid-flight (nothing stored,
same self-healing MISS as any refused capture; rango cannot warn because the
isolate is gone). Keep per-route budgets comfortably under it; build-time
captures (producer B) have no such bound. Chunked encoding and edge
compression of the composite are automatic; never store compressed bytes.

Vercel: identical in-function pattern on Fluid Compute via the Vercel store.
Build producer B ships its `__shell-manifest.js` inside the Node Function; the
preset emits no CDN prerender fallback or response chain. Vercel's open-source
Build Output parser accepts generic `chain` metadata, but production stitching
for non-Next output and the postponed-state framing are not documented
third-party contracts. More importantly, CDN-first shell delivery would commit
before Rango's global and route middleware, violating the serve path's security
boundary. `docs/design/vercel-chain-ppr.md` records the rejected design.

## Operability (issue #651)

Three surfaces make the capture pipeline observable and bounded; all are
diagnostics-only — none changes what a consumer's page renders.

**Snapshot size cap.** The capture data snapshot duplicates every pinned
cache value inside the shell entry, so a page over a large `cache()` segment
could push the stored envelope toward store value limits (Cloudflare KV caps
a value at 25 MiB) — and the failure was invisible: `kv.put` rejects deep
inside `waitUntil`. `PartialPrerenderProps.maxSnapshotBytes` (default 8 MiB,
`DEFAULT_PPR_MAX_SNAPSHOT_BYTES`) bounds the serialized snapshot; over the
cap `captureAndStoreShell` stores the shell WITHOUT it and warns once per
key. The trade is documented drift: un-pinned reads fall back to the live
store on a HIT, so content that drifted between capture and HIT
hydration-mismatches and React repairs it client-side — the pre-snapshot
behavior, and strictly better than losing the entire entry to a rejected
write. Both producers apply the cap (producer B receives it via
`BuildShellCaptureOptions` / the dev `/__rsc_shell` `maxSnapshotBytes`
param).

**Capture debug sink.** `createRouter({ debugShellCapture })` mirrors the
`CFCacheDebug` pattern: `true` logs one structured line per event, a
function receives each `ShellCaptureDebugEvent` — outcome per attempt
(`stored`/`redirect`/`no-shell`/`refused`/`error`), skip events
(`skip-in-flight`/`skip-backoff`) and backoff escalation (`backoff`), plus
attempt/barrier/write-settle durations and prelude/snapshot byte sizes.
`INTERNAL_RANGO_DEBUG` lights the console sink without the option; an
explicit `debugShellCapture: false` stays off. In dev the terminal event per
key is buffered and, when `debugPerformance` metrics are active, rides the
NEXT ppr GET's Server-Timing as `ppr-capture;dur=<attempt ms>;desc="…"`
(consumed on read — one capture, one report), alongside a `ppr:shell-read`
hit/miss metric for the serve-side store read. The capture runs AFTER its
triggering response commits, which is why its outcome can only ride a later
response's header.

**HIT-tail timing mirror.** The HIT commits its 200 + headers at the prelude
flush, so Server-Timing on the HIT response structurally cannot carry the
live tail's numbers — all of match/loaders/Flight/resume happens inside the
response body. In dev, `serveShellHit` records per-stage offsets from the
commit (`seed`/`match`/`handover`/`first-html`/`complete`, plus
prelude/tail byte counts — `ShellTailTiming`, shell-serve.ts) and buffers
the terminal timing per key; when `debugPerformance` metrics are active it
rides the NEXT ppr GET's Server-Timing as `ppr-tail;dur=<complete
ms>;desc="…"` — the same consume-on-read doctrine as the `ppr-capture`
mirror above. Production folds the collection away (`NODE_ENV` literal);
`INTERNAL_RANGO_DEBUG` remains the raw console narration of the same window.

**Cloudflare shell-tier trace.** A build made with `INTERNAL_RANGO_DEBUG=1`
also emits compact `[CFCacheStore][shell]` JSON lines for runtime shell storage
decisions: `l1-stored`, `kv-stored`, `l1-hit`, `l1-miss`, `kv-hit`,
`kv-miss`, `kv-promoted`, `marker-invalidated`, and `write-invalidated`. The
event carries the shell key, epoch timestamp, incoming `cf-ray`/colo when
available, freshness/expiry, and the bounded match/body/marker/KV timings that
apply to that decision. This is the deployed cross-colo diagnostic: tail the
Worker while sending the exact same shell URL from multiple regions. The flag
is resolved at Vite build time, so setting it only as a Worker runtime variable
does not enable the trace.

**Inert shell family.** `CFCacheStore` uses Cache API as the per-colo shell L1
and KV as the durable cross-colo L2. KV remains required: with no namespace
bound, `getShell`/`putShell` no-op and every ppr route is a permanent MISS — the
correctness-first fail-open, previously with zero diagnostics. The store warns
once per isolate, from inside `getShell`/`putShell` (only ppr routes call them,
so a KV-less store in a non-PPR app stays silent), naming the fix: bind a KV
namespace (`new CFCacheStore({ ctx, kv: env.CACHE_KV })`) or use a shell-capable
store.

The two CF tiers carry the exact same coupled envelope. A Cache API miss falls
through to KV and promotes the validated envelope back into that colo. Runtime
shell L1 entries also carry the store's namespaced `Cache-Tag`s, so purge mode
evicts them. Unlike ordinary L1 data entries, a surviving shell still checks KV
generation markers: its `taggedAt` is capture start, and an old capture can land
after the purge that invalidated it. The marker prevents that resurrection.

## Dead ideas (do not re-propose)

The design was settled after a long exploration. These alternatives were
considered (some shipped briefly on a branch) and rejected; record them so they
are not revived.

- **`createShellCacheMiddleware` as the public surface.** Opt-in belongs on the
  ROUTE (a document-level property of the page), and serving is integral to the
  render pipeline — a middleware split the decision across two layers, forced a
  marker-header handshake (`x-rango-shell-resumed`) between the layer that
  decided and the layer that composed, and made the freshness policy live far
  from the route it governed. Removed entirely (pre-release rule: remove, never
  deprecate); the `ppr` path option + integral serving replaced it.
- **`cache({ ppr: true })` as the opt-in.** A segment-granular primitive for a
  document-level property — the granularity mismatch produced inheritance
  questions (nearest-declaration-wins chains, min-ttl folding) that the path
  option simply does not have, and it coupled PPR eligibility to ring-3 caching
  when the two are orthogonal.
- **Replay-only capture** (the capture may only photograph ring-3 cached
  segments; a fresh segment aborts it). Superseded by the mixed-chain capture:
  replay-only required fully cached chains — where the cache-boundary guards
  already constrain what runs — and it DELETED the promise-hole contract
  (physics holes: a pending handler promise under Suspense) that the design
  requires. Under mixed-chain, uncached handlers execute during capture and the
  `cookies()`/`headers()` guard is load-bearing again.
- **`live()`, the userland hole primitive.** Created as the deterministic
  hole-maker for the fresh-handler capture era (the `connection()` /
  `makeHangingPromise` analogue; the thunk form elided capture work for a
  resolved-fast per-request value that would otherwise settle into the quiet
  window). Two shifts removed its habitat: the interim replay-only model made
  it unreachable (capture executed nothing), and the final mixed-chain model
  subsumes its guarantee through the loader lane —
  `loader(() => Promise.resolve(x))` + `loading()` is a hole for
  already-resolved data with zero capture cost. Removed entirely. The guards'
  reasoning stays instructive: deep-settle at the ring-3 write is why nothing
  inside `cache()` can stay live, so a "keep this live" primitive inside cached
  content was never coherent anyway. A revival (per-loader `live()` opt-in, for
  bake-lane values consumed INLINE where entry-level `loading()` is
  structurally unacceptable — e.g. per-user prices across a product grid) was
  proposed and dropped again 2026-07-04: pin-on-fast-settle is the accepted
  contract (skills/ppr: treat bake-lane fast-resolvers as PINNED), and the
  settled-marker snapshot (#669) makes the pin shape-safe for `use()`
  consumers. Do not rebuild without a concrete adopter.
- **Response-header opt-in** (a route sets a header the serve layer reads).
  Headers are not replayed on a cache hit, so the signal cannot survive the
  serve path PPR is built around. Opt-in belongs in route config, which the
  match layer reads directly.
- **A standalone `shellCache()` DSL entry.** A separate boundary declaring
  "this is a shell" duplicates what the route already declares; the `ppr` path
  option lives on the page route itself.
- **Automatic no-key capture** (capture any document the store can hold, keyed
  implicitly). Turning on caching for data must never silently change HTML
  serving; PPR requires the explicit `ppr` declaration. Silent axis 1
  otherwise.
- **Full-pipeline runtime capture dispatch** (re-run the whole middleware
  pipeline for the background capture instead of `router.match()` under a
  derived context). It would double every middleware side effect (auth,
  logging) and re-trip the single-use `next()` latch; the derived context
  inherits the post-middleware state instead, and guarding is serve-time.
  Build-time producer B is allowed to replay middleware because there is no
  live response, it exposes `ctx.build === true`, and `ctx.waitUntil()` is inert.

## Out of scope (v1)

- Build-time capture in the prerender pipeline (B segments): SHIPPED as
  producer B (#699), with middleware replay added under `ctx.build === true`.
- CF Cache-API L1 tier for shell entries: SHIPPED (KV remains the durable L2;
  shell L1 reads retain the generation-marker check for capture/purge races).
- Vercel BOA `chain` / streaming-lambda serving.
- Render-recorded shell-tag union for shell entries: SHIPPED in #648 (originally
  scoped out of v1, which had only TTL/SWR + the explicit `ppr.tags` option +
  reactVersion gate). The render-callable `cacheTag()` unions render-recorded tags
  onto the shell entry — see "Shell invalidation is DERIVATIVE (render-recorded
  tags, #648)" above.
- Flight-byte splicing for the cached portion of the payload: SHIPPED as #700
  (originally scoped out — "the full Flight render still runs per request").
  A HIT tail now emits the STORED per-segment fragment strings verbatim into
  the hydration payload (`__rangoFragment` envelopes, `src/segment-fragments.ts`;
  `fragmentSegments` in segment-codec.ts) and the SSR resume pass + browser
  hydration expand them through their own Flight deserializers — per-SEGMENT
  splicing, so the whole-payload hazards recorded above (the handles
  AsyncGenerator, live promises, row-id surgery) never apply. See
  docs/design/shell-fast-path.md ("The fragment splice, as built").
- Warm-pass two-phase capture: a second capture render that lets non-loader
  in-shell async settle (closing the last residual quiesce window — raw
  in-component I/O in the shell, above) rather than relying on the anti-pattern
  guidance. Deferred because the current mechanism (mask loaders, task-quantized
  quiesce) covers the intended shapes; the
  research on the alternatives — Flight static `prerender` with halt semantics
  (microtask retries) vs. the regular-render gate we ship, and Next's
  `runInSequentialTasks` / `makeHangingPromise` — is captured in the design
  history and revisited only if a real route needs it.

## Testing requirements (repo mandates)

- Unit: SSR strategies with an injected fake `createFromReadableStream`
  (deps-injection seam, no react-server condition needed); the integrated serve
  path (`rsc-rendering-shell-ppr.test.ts`) against a REAL memory store — MISS
  descriptor policy (default ttl 300, PartialPrerenderProps flow-through),
  HIT composition (prelude-first byte order), stale/SWR recapture, reactVersion
  gate, host-scoped keys, and the bypass set (no ppr = zero cost/logs, nonce,
  allReady, missing store family warn-once); the capture gate incl. the
  `holdUntil` handles hold; the shell store family.
- Userland dogfood: the store family through the public `@rangojs/router/cache`
  surface in the mini suite; the `/manifest` route carries the `ppr` path
  option.
- E2e dev + production in cloudflare-basic and test-app: MISS → HIT; HIT
  streaming order + TTFB under the loader delay; hydration-zero-errors;
  loader-carried three-layer streaming; the PHYSICS hole (pending handler
  promise under Suspense: fallback in prelude, value resumed); the HANDLES pair
  (top-level push(promise) baked, nested push({x: promise}) streamed);
  ppr+no-loading() negative (eternal MISS + warning); SECURITY (401 with zero
  shell bytes on a warmed route, global AND route-DSL middleware); SCOPE
  FIDELITY (middleware ctx value photographed into the prelude); the
  middleware-run counter (capture never re-runs the chain); action correctness
  (hole mutation stays HIT; updateTag drops + recaptures the shell; PE POST
  never composes); inline closure-bound action streaming while an independent
  page hole remains pending on document MISS, document HIT, and partial replay;
  client-imported module actions from Passthrough+Prerender+ppr document and
  partial paths. `(production)` describe-title bucketing rules apply.
- Semantic matrix rows `[PPR1]` (commit-after-all-middleware + capture never
  re-runs the chain + scope fidelity) and `[PPR2]` (serve-time guarding: HIT
  runs the full chain, loader hole fresh) must stay green, alongside the
  axis-1 rows (axis 1 untouched).
