---
name: ppr
description: PPR shell caching — opt a page route in with the `ppr` path option; the router serves the cached HTML shell instantly and resumes the live holes. Use when a page should render instantly from a cached shell while specific parts stay live, or asking about partial prerendering in Rango.
argument-hint: "[setup]"
---

# PPR Shell Caching

Caches the rendered HTML **shell** of a page route (React `prerender` prelude
bytes plus `postponed` state) and, on a later request, flushes those bytes after
route classification and the complete middleware chain, but before downstream
tail rendering. It then resumes React's HTML renderer for just the live holes.
The browser sees one ordinary streamed document; live loaders (no `ssr: false`)
stay fresh on every request. A normal render (no shell) is untouched, and every
request the shell cannot serve falls open to it.

Use it when a page has a stable layout that should reach the browser instantly
(the first byte comes from cache) while specific regions stay per-request:
prices, a basket, recommendations. Opt in per page route with the `ppr` path
option; the holes are decided by the shape of your tree (see "The hole
doctrine").

Compare `/document-cache`, which freezes the WHOLE response including loader
output, and the `cache()` DSL (`/caching`), which caches Flight segments but
still renders HTML on every request. Shell caching is for pages that mix a
stable shell with live data: the shell is shared per host+URL (and per request
partition, when the route's `cache({ key })` or the store's `keyGenerator`
partitions its record), the holes are per request.

This is in-function PPR on every deployment. The worker/function serves the
prelude; it is not a CDN static file. See `/deployment-caching` before combining
PPR with HTTP shared-cache headers.

## Not this skill if…

- You want the WHOLE response frozen, loader output included — see
  `/document-cache`.
- You want build-time Flight segment payloads from `Static()`/`Prerender()` —
  see `/prerender`. A `Prerender` page may also declare `ppr`; then the
  build-time shell capture bakes the HTML shell while loaders without
  `ssr: false` stay live.
- You want cached segments with live loaders but no cached HTML — that is the
  `cache()` DSL: see `/caching`.
- You are unsure which cache layer you need — start at `/cache-guide`.

## Setup: one path option, no PPR middleware to mount

PPR is a DOCUMENT-level property declared on the page route via the `ppr` path
option. Serving is **integral to the router** — there is nothing to mount. The
only prerequisite is an app-level `createRouter({ cache })` store that
implements the shell family (`getShell`/`putShell`): `MemorySegmentCacheStore`
(dev/tests), `CFCacheStore` (Cache API L1 + optional KV L2), or
`VercelCacheStore` (Vercel Runtime Cache). A ppr route on a store without the
family renders normally (no shell) with a once-per-key warning. A custom store
returns each `ShellCacheEntry` field as `putShell` received it, including
`buildVersion` and `snapshot` (both required; the snapshot can be empty).

```typescript
import { createRouter, urls } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";

export const urlpatterns = urls(({ path, layout, loader, loading }) => [
  layout(ProductShell, () => [
    path(
      "/products/:id",
      PricePage,
      // `ppr` is the whole opt-in AND the policy. `ppr: true` uses the default
      // ttl (300s); an object sets ttl/swr/tags (PartialPrerenderProps).
      { name: "product", ppr: { ttl: 600, swr: 120 } },
      () => [
        loader(LivePriceLoader),
        loading(<PriceSkeleton />), // structural hole: the loader subtree stays live
      ],
    ),
  ]),
]);

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({ kv: env.CACHE_KV, ctx: ctx! }),
  }),
});
```

The live price above is a hole because it is LOADER data read under a
boundary. Everything the handler layer produces is shell material, the way it
is under `cache()`:

### Handler output always bakes, promises included

A promise a handler passes to a component under `<Suspense>` is NOT a hole. The
capture waits for it, bakes the settled value into the prelude, and serves that
value for the shell's lifetime:

```typescript
// Handler: the fetch is not awaited here, but the capture awaits it.
function ProductPage(ctx: HandlerContext) {
  const reviews = fetchReviews(ctx.params.id); // Promise<Review[]>
  return (
    <main>
      <h1>Product {ctx.params.id}</h1> {/* shell */}
      <ReviewsSection promise={reviews} /> {/* shell too: the capture waits for
                                               `reviews`, and every HIT shows
                                               the capture's reviews */}
    </main>
  );
}
```

The same holds for an async server component (with or without a `<Suspense>`
above it), a promise nested in a handle the handler pushes
(`ctx.use(Handle)({ x: promise })`), and a loader the handler awaits
(`await ctx.use(Loader)`). The capture waits for all of it, bounded by ONE
deadline, `ppr.captureTimeout` (15s by default); handler output that has not
settled by then stores no shell (the once-per-key warning names the cause: "did
not settle within ppr.captureTimeout"). A shell HIT never runs a handler: it
replays the handler layer the capture recorded.

To keep a region fresh per request, load it in a loader WITHOUT `ssr: false`
and read it with `useLoader` under `loading()` or an inline `<Suspense>` (a live
hole, see "The hole doctrine"); inside a `loader(Def, { ssr: false })`, return
the live part as a nested promise.

A route WITHOUT the `ppr` option renders normally (no shell): no store read, no
capture, no logs, zero cost. `ppr` is per page route — declaring it on a layout
is not supported (subtree inheritance is a possible follow-up).

### Migration from the old promise-hole model

Earlier versions treated a pending handler promise under `<Suspense>` as a hole
and re-ran handlers on some HITs. That is gone:

Everything a handler produces is shell material, as it is under `cache()`: a
promise it passes to a component under `<Suspense>`, an async server component,
a nested promise in a handle it pushes, and a loader it awaits are all awaited
at capture (bounded by `ppr.captureTimeout`) and served frozen for the shell's
lifetime. A HIT never runs a handler. To keep a value fresh per request, load
it in a loader without `ssr: false` and read it with `useLoader` under
`loading()` or an inline `<Suspense>`; inside an `ssr: false` loader, return
that part as a nested promise. Request-scoped reads the capture now waits for
refuse it: `cookies()`, `headers()`, `ctx.request.headers`, a
`{ cache: false }` variable, and
`ctx.dynamic()` inside a handler promise, an async component, a handle push, or
a loader a handler awaits. A normal `ctx.get()` value is not guarded: shell
material is shared per host+URL and request partition. `cache(false)`, or a
`condition()` that returns false, on a ppr route now renders the request like a
cache miss (no shell).

### Request-partitioned shells

A route whose `cache()` record is partitioned by the request partitions its
shell the same way: the route's `cache({ key })`, or the store's
`keyGenerator`, decides which shell a request reads, captures and replays.
Each partition captures its own on its first request and never serves
another's:

```tsx
cache(
  { ttl: 300, key: (ctx) => `tier:${ctx.request.headers.get("x-tier")}` },
  () => [path("/pricing", PricingPage, { ppr: true })],
);
// gold and silver visitors each get their own /pricing shell.
```

The partition follows nested scopes (issue #970): a `ppr` route under a
`cache()` nested in a keyed one is partitioned by the outer `key()` when the
inner boundary has none, and by both composed (outermost first, joined by
`|`) when it has its own. Each `key()` result is namespaced as `key:` plus
its URI encoding (issue #975), exactly as in the record key, so the shell of
`key: () => "tier:gold"` is `<host><path>:shell|key%3Atier%253Agold`. The
route's record adds the inner boundary's own default key when it has no
`key`; the shell partition does not, since the shell key already carries the
URL (a store `keyGenerator`'s result is kept when it adds anything, an
enclosing `cache({ store })`'s on another store included, issue #974). An
enclosing `condition()` that refuses the request means no shell, as the
route's own does. See `/caching`, "Keys nest" and "Conditions and tags
inherit".

```tsx
cache({ ttl: 300, key: (ctx) => `tier:${tierOf(ctx)}` }, () => [
  layout(TierLayout, () => [
    cache({ ttl: 60 }, () => [path("/pricing", PricingPage, { ppr: true })]),
  ]),
]);
// gold and silver still get their own /pricing shell and record.
```

This is the sanctioned way to vary shell material by request: the capture
guards still refuse `cookies()`/`headers()`/`ctx.request.headers` in handler
work, while the key function, a store `keyGenerator`, a `condition()` and a `tags()` function read
what they need (`cookies()` and `ctx.request.headers` included, at capture
too). To render the partition value, copy it in middleware with `ctx.set()`
and read `ctx.get()` in the handler (see `/middleware`). A `key()` runs once per
request: the shell read, the record lookup and the capture share its result
(each `key()` of a nested chain once).
One that throws serves no shell (like the record path renders uncached); a
store `keyGenerator` that returns the default key unchanged partitions
nothing. A partitioned route never serves a build-time shell (the build
captured one partition): each partition captures at runtime, and when the
route has a build shell a once-per-route warning says so. A `keyGenerator`
that returns the default key unchanged keeps the build shell.

Keep partition values to a small, known set: normalize what the key reads
(a tier, a locale) to the values you serve before returning it. Every
distinct value is a full capture and a stored shell, so a key that returns
raw header or cookie text lets any client mint new shells.

Query strings multiply shells the same way: the shell key includes the sorted
search, so a PDP reached as `/products/1?color=red&size=m` and
`?color=blue&size=m` has one shell per distinct query, and every appended
tracking param (`utm_*`, a click id) mints another. The router's
`cache.searchParams` option (`createRouter({ cache: { store, searchParams } })`)
drops params from the key, shell included
(`{ exclude: TRACKING_SEARCH_PARAMS }`, or an `{ include: [...] }` allowlist;
see `/caching`, "Search param key filtering"). Exclude only a param the shell
does not render from: otherwise the first variant captured is served for every
value of it.

In tests, `serveShellRequest` reports the key the serve path resolved
(`result.key`, partition included); `shellCacheKey(url, searchParams,
partition)` builds the same key from the `key()` result, namespacing it as
production does. Under nested keyed scopes, pass the `key()` results as an
array, outermost first (`shellCacheKey(url, undefined, ["tier:gold",
"v:a"])`); for a store `keyGenerator` partition pass
`{ keys, generated }` (`/testing`, `cache-prerender.md`).

## Where PPR sits: the cache onion

Rango's caches layer like an onion — each layer stores a progressively more
"cooked" representation of the same page. From innermost (raw values) to
outermost (final bytes):

| Layer                   | Primitive                                | What is stored                                     | What stays live on a hit               |
| ----------------------- | ---------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| 1. Function values      | `"use cache"`                            | a function's return value                          | everything around the call             |
| 2. Loader values        | `loader(Fn, () => [cache({...})])`       | one loader's result (opt-in; loaders default live) | all other loaders, handlers, rendering |
| 3. Segments (Flight)    | `cache()` route / build-time `Prerender` | serialized rendered segments + replayed handles    | loaders, HTML render                   |
| 4. **HTML shell (PPR)** | `ppr` path option                        | rendered prelude bytes + React postponed state     | the holes, hydration payload           |
| 5. Whole response       | `/document-cache`                        | final response bytes, headers included             | nothing — all-or-nothing               |

PPR is ORTHOGONAL to `cache()` (the segments layer): a ppr route may be
uncached (its handlers run on a MISS and during capture), fully `cache()`d
(the capture replays its segments), or mixed. Either way a HIT runs no
handler: the shell entry is itself a `cache()` of the handler layer, recorded
by the capture and replayed on every HIT. That is why handler promises cannot stay live under ppr:
the segment codec **deep-settles promises** when it writes a segment record,
under `cache()` and under the shell alike.

Invalidation crosses layers: `updateTag()`/`revalidateTag()` reach segment,
shell, loader, and item entries in the same store, and shell entries
additionally self-invalidate on `React.version` change.

## The serve pipeline: commit after ALL middleware

On a document GET to a ppr route the router runs:

1. **match** — route identified, `ppr` config read from the matched route;
2. **the WHOLE middleware chain** — the global `router.use()` chain AND route
   DSL `middleware()`; both are guards, and the COMMIT POINT is after all of
   them: any rejection/redirect/401 wins before a single shell byte, on MISS
   and on a warmed HIT alike;
3. **shell lookup** — `getShell(key)` on the app store (key =
   host+pathname+sorted search). `CFCacheStore` stores the entry prelude-first
   and the serve path reads only its head and prelude here, with the tag-marker
   read running alongside; the capture snapshot is read off the commit path.
   `CFCacheStore` and `VercelCacheStore` keep the last fresh read of each shell
   in a memo for `memo.shellMs` (default 2 s): a warm isolate's next HITs skip
   the store read, but never the tag-marker check, which reads its markers
   through a per-isolate stale-while-revalidate memo (`memo.markerFreshMs`,
   `memo.markerMaxStaleMs`). The user whose request ran `updateTag()` /
   `revalidateTag()` gets a fresh-reads cookie that skips both memos; past
   them each store's own consistency applies (`VercelCacheStore`: fresh in
   any region, `expireTag` is global; `CFCacheStore` with KV: fresh in the
   colo that ran it, other colos once KV propagates the marker and
   `tagCacheTtl` expires; KV-less purge mode: once the purge reaches the colo).
   Other users see the invalidation once the marker memo refreshes (KV-less
   purge mode and another Vercel region: once the shell window passes; see the
   caching skill);
4. **HIT** — the composed response is committed immediately: the stored prelude
   bytes flush first (in 32 KB chunks), while segment resolution, the Flight
   render (the full hydration payload — there is no Flight-side resume), and
   the fizz `resume` of just the holes run BEHIND them inside the response
   stream, starting a macrotask after the commit so they cannot delay the
   prelude's write. Segment resolution replays the handler layer from the
   shell's own recorded segments — NO handler runs on a HIT — and runs the
   live loaders fresh (a promise-free bake-lane loader is served from the
   shell, see "On a shell HIT");
5. **MISS** — a normal render (no shell), tagged `x-rango-shell: MISS`, plus a
   background capture (stampede-guarded, retry-in-place, exponential backoff).

`x-rango-shell: HIT | MISS` is the observability header. Because the commit
point is after the chain, an unauthorized request NEVER sees shell bytes — put
auth middleware anywhere (global or route DSL) and it guards PPR for free.

A route whose own `cache()` scope refuses THIS request — `cache(false)`, or a
`condition()` that returns false — skips steps 3-5: the document renders like a
cache miss (a normal render, no shell), with no `x-rango-shell` header and no
capture scheduled.

If a HIT cannot read the shell's recorded segments, it never falls back to
running handlers behind the committed prelude: it ends the response with a
small script that reloads the page once with a `_rsc_shell=miss` query marker,
and a request carrying the marker renders like a cache miss (no shell, no
capture), so the reload cannot repeat. The router drops the marker from the
request before anything reads it (middleware, handlers, loaders, cache keys
and `useSearchParams` see the clean URL), and the browser drops it from the
address bar before the page hydrates. When the stored value is corrupt it
also replaces the entry with a placeholder the next request treats as a MISS
and schedules a recapture that heals the key; a snapshot read that was only
slow leaves the entry alone.

### Soft navigation caches and reuses the handler layer

In short: client-side (soft) navigations to a `ppr` route reuse the handler
segments captured with the shell, while loaders without `ssr: false` stay live.
Nothing needs configuring; the rest of this section explains the
`x-rango-ppr-replay` header for when you are debugging replay behavior.

Ordinary partial RSC navigations to a `ppr` URL use the same handler-layer cache
contract even when no document request has captured an HTML shell yet. When a
shell snapshot exists, the server replays the page's recorded segments from it.
On a cold partial request, normal matching renders the response and schedules a
background navigation-only shell capture; later navigations and prefetches
replay its eligible snapshot. In both cases `matchPartial()`:

- preserves client-owned shared layouts by segment id;
- returns only new or revalidating destination segments;
- runs live DSL loaders fresh with their normal `loading()` streaming
  behavior, and serves bake-lane loaders from the pins of a shell captured by a
  document request; a snapshot captured by a navigation alone carries no pins,
  and its replay runs them fresh (see below);
- keeps the existing prefetch key, source scope, and in-flight lock unchanged.

This is deliberately invisible to the browser: the response is the same
`RscPayload` shape as any other partial navigation. A shell snapshot holds no
`"use cache"` or loader `cache()` values. Bake-lane loader pins are, when the replayed
snapshot is a shell a document request captured, as on a document HIT: a
promise-free `ssr: false` loader is served from its pin without running
(unless the capture marked it to run: see "On a shell HIT"), and one whose
return holds promises runs with its baked parts overlaid. A snapshot captured
by a navigation alone carries no pins, and its replay runs them fresh. Loaders
without `ssr: false` stay live.

A route's own `cache()` scope — including one inherited from an ancestor, the
common app-wide storefront shape — COMPOSES with replay instead of disabling
it. The explicit tier stays authoritative: its lookup runs first with its
normal store, key, TTL, SWR, tags, and condition, and when it supplies the
match the response reports `BYPASS; reason=explicit-cache-hit` (never a false
replay `HIT`). Only when the explicit tier misses do the page's recorded
segments in the shell snapshot supply the match and report `HIT`. To make that
possible, a capture of such a route records the page's segments into the
shell snapshot IN ADDITION to the scope's normal store write; that record rides
only inside the shell entry, never the real store. Two opt-outs stay absolute:
`cache(false)` and a `condition()` returning false mean "do not serve this
request's segments from any cache" — no segments are recorded for them and
the seeded fallback never rescues a refused read. `cache(false)` is static, so
replay reports `BYPASS; reason=cache-disabled` before performing a single
shell read; a `condition()` refusal is request-time state, decided at the
lookup itself and reported as the same `cache-disabled` post-match (the gate
must not pre-decide a predicate that could flap between the two evaluations).
An errored explicit read — a throwing `key()`, or a built-in store's swallowed
backend failure (`CACHE_READ_ERROR`) — also never falls back: it renders
uncached, exactly as without ppr. (Document requests treat the same two
opt-outs as a cache miss before any shell read: see the serve pipeline above.)

`transition({ when })` is a browser predicate: the server never evaluates
it, so a shell, a replay and a cache entry never hold a decision. The route
carries it as a client reference (attached right before Flight on every
match, never stored), and the browser decides each navigation from
`{ kind, from, to }`. Location state middleware sets reaches `to.state` on a
replay `HIT` (middleware runs on every HIT); a handler's does not (a HIT runs
no handler). The decision gates only how the browser commits; it never makes
a replay send a segment. A replay `HIT`
makes the same segment decision as the live partial path: a segment the client
holds that the navigation does not re-send (`revalidate()` false, or a layout
the default keeps) is omitted from the response, so the client keeps its tree
(a list the client built up, "Load more" style, stays as it is). Intercepts, an active nonce, and an
absent/corrupt segment snapshot fall open to the ordinary partial path when
encountered by the shell capture.

Two more decisions are made before any shell-store read, so probes and
prerendered routes never spend passive `getShell` I/O:

- A partial request carrying neither `X-RSC-Router-Client-Path` nor a
  same-origin `Referer` (a curl probe, a synthetic monitor) can never produce
  a partial match; it reports `BYPASS; reason=no-navigation-context`. A
  `Referer` on another origin counts as absent: only its pathname would be
  matched, as if it were a route of this app. Alert on replay hit-rate with
  this in mind — such probes are not cache misses.
- A `Prerender()` route's partial is served from the build-time prerender
  store inside matching (a better-than-HIT outcome); it reports
  `BYPASS; reason=prerender-store`. Its captures never record the page's
  segments (the prerender store short-circuits the cache write), so replay
  seeding would be impossible anyway.

Fresh and stale-within-SWR runtime shells replay. The stale read is passive: it
uses `getShell(key, { claimRevalidation: false })`, does not claim SWR ownership,
and cannot recapture HTML. A later document request owns the background
recapture; hard-expired entries schedule a navigation-only capture. Production
may also use a fresh local build manifest. Development does not probe
`/__rsc_shell`; it schedules the same local background capture instead. Custom `SegmentCacheStore`
implementations must set `supportsPassiveShellReads: true` and honor the
non-claiming read option.

The first cold partial request reports `BYPASS; reason=no-entry` because no
artifact could supply that response; its successful render schedules
`scheduleShellCapture` with a navigation-only marker. The next request reports
`HIT` when the capture produced an eligible snapshot. Navigation snapshots use
a separate shell key, so they cannot overwrite or be served as a document shell.
The capture runs with the stripped target document URL and loads SSR support in
the bounded background queue, outside the triggering partial response's latency.
An `allReady` decision still declines capture.

Partial responses expose the actual decision as `x-rango-ppr-replay`:
`HIT; freshness=fresh|stale` or `BYPASS; reason=<bounded-token>`. With
performance metrics enabled, the same decision appears as
`ppr-navigation-replay` in `Server-Timing`. `HIT` means matching consumed the
seeded segment record, not merely that a snapshot existed. Fragment-capable
clients decode its stored ReactNode fields after the response arrives; if that
decode fails, the client retries once through the server decode-and-evict path
and disables further passthrough for that browser document. The retry replaces
the fragment-capable response-cache slot, and a corrupt seeded snapshot is
recaptured at the key that supplied it. An explicit `cache()` scope that supplies
the match cannot produce a
false HIT — it reports `explicit-cache-hit`. There is still no Flight resume
API; this is segment replay followed by normal Flight streaming, not reuse of
the HTML `prelude`/`postponed` bytes. Replayed segments do ride the partial
payload as verbatim `__rangoFragment` envelopes (#700 fragment splice — the
stored per-segment Flight strings are string-copied instead of
deserialize→re-serialize per request); the client expands them at its
navigation/prefetch decode chokepoints before anything renders, so they are
consumer-invisible.

The bounded bypass tokens, grouped by when they are decided:

| Token                                                                         | Decided           | Meaning                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`, `dynamic`, `nonce`, `store-unavailable`, `passive-read-unsupported` | pre-read          | request/route/store ineligible for replay                                                                                                                                                                            |
| `no-navigation-context`                                                       | pre-read          | no `X-RSC-Router-Client-Path` and no same-origin `Referer`; a partial match is impossible                                                                                                                            |
| `prerender-store`                                                             | pre-read or match | `Prerender()` route served by its baked artifact (pre-read probe of the normal variant; reclassified post-match when the store actually served, either variant)                                                      |
| `intercept`                                                                   | match             | the navigation resolved to an intercept — replay is never armed for intercepts (they keep their normal cache path); no heal capture                                                                                  |
| `cache-disabled`                                                              | pre-read or match | `cache(false)` (pre-read, static) or `condition()` false (decided at the lookup); consumer opt-out is absolute                                                                                                       |
| `read-error`, `no-entry`, `invalid-version`, `corrupt-entry`                  | shell read        | no usable shell entry (`no-entry`/`invalid-version`/`corrupt-entry` schedule the navigation-only heal capture)                                                                                                       |
| `no-segment-snapshot`                                                         | eligibility       | entry exists but its snapshot has no recorded segments for the page; on a route with an enabled `cache()` scope, it heals when the lookup did not refuse (a `condition()` false-at-capture entry becomes replayable) |
| `explicit-cache-hit`                                                          | match             | the route's own `cache()` tier supplied the match                                                                                                                                                                    |
| `snapshot-miss`                                                               | match             | an eligible snapshot was seeded but matching did not consume it                                                                                                                                                      |

### Capture-generation invalidation

If handler or bake-lane code calls `updateTag()` on one of the shell's own tags
while capture is running, that generation is rejected. Built-in stores report it;
Rango warns with the shell key and backs capture off instead of rendering the
same doomed generation on every request. Move a deterministic self-invalidation
out of render code if you want the shell to persist.

### Opting out per request with `ctx.dynamic()`

Middleware and handlers can call `ctx.dynamic()` to force this request onto a
normal render (no shell). In middleware it runs before the PPR commit point, so
the router skips shell lookup, HIT serving, and MISS capture for that request.
In handlers it is
too late to prevent a MISS render from already happening, but it still prevents
the follow-up shell capture. A `ctx.dynamic()` call that only happens during the
capture itself (for example inside a handler promise, after an await) refuses
that capture: a dynamic render has no shell.

During `Prerender` + `ppr` build-shell capture, middleware is replayed with
`ctx.build === true`, `ctx.waitUntil()` inert, and the same `ctx.dynamic()`
opt-out. Use that for routes where the shell depends on runtime-only auth,
cookies, or side-effectful SDK calls. A skipped build shell can still be owned
later by runtime capture when runtime middleware does not call `ctx.dynamic()`.

`ctx.dynamic()` also **re-permits handler header/cookie writes** (issue #735).
The header doctrine below forbids handler writes on a ppr route because they
ride MISSes and vanish on HITs — but a `dynamic()` render never HITs, so its
write is deterministic. Calling `ctx.dynamic()` clears the header latch for the
rest of the render, so the SAME handler can write its control-flow header
directly (no middleware relay). Ordering is a contract: call `dynamic()` BEFORE
the write — a write before it still throws.

```ts
function catalogPage(ctx) {
  ctx.dynamic(); // declare live -> refuses capture AND clears the header latch
  ctx.headers.set("x-catalog-mode", "live");
  return <Catalog />;
}
```

## Verifying it works

The header exists on DOCUMENT responses only. A bare `curl` gets the HTML
document (Flight is explicit-opt-in via `Accept: text/x-component`), so it
sees the header directly; only an explicit Flight request shape lacks it:

```
curl -s -D - -o /dev/null https://app.example.com/products/1 | grep -i x-rango-shell
```

- Runtime-captured route: first document GET is `MISS`, plus a background
  capture; a later request becomes a `HIT`.
- `Prerender + ppr` route: the shell is produced during `vite build`, so the
  first production document request can already be a `HIT`. In dev, the
  build-time shell capture runs on demand and can return a `HIT`; if capture
  outlasts the bounded foreground wait, the request falls open to `MISS` and
  runtime capture.
- Production (workerd/node): the SECOND request is a `HIT`.
- Dev: expect a few extra MISSes — cold module transforms abort the capture
  window (per-attempt breadcrumbs: start the server with
  `INTERNAL_RANGO_DEBUG=1`). This self-heals; only a route that NEVER flips
  has a real hole/eligibility problem (the once-per-key warning tells the two
  apart).
- A HIT is one ordinary document: the frozen prelude first (view-source shows
  your baked shell, with hole fallbacks in place), then
  `<div hidden id="S:0">…` segments as the holes resume, per request.
- A ppr-declared route that CANNOT be honored (missing shell store family,
  per-request nonce) serves a normal render (no shell) with NO header and
  warns once per key — no header + a declared `ppr` means look for that
  warning.
- On Cloudflare, `CFCacheStore` reads PPR shells from the per-colo Cache API,
  falls through to KV on a miss, and promotes the KV hit back into that colo.
  WITHOUT a KV namespace the family runs L1-only (edge-only ppr): every colo
  captures and serves its own shell from the Cache API. What changes KV-less
  is tag eviction — with `tagPurge` the purge-by-tag evicts shell L1 entries;
  without it a TAGGED shell warns once that `updateTag()` cannot reach it
  (ttl/swr-only freshness). Untagged edge-only ppr is warning-free. Tagged
  BUILD-manifest shells decline on a KV-less store (`tagHistoryInert` — the
  immutable asset could never be evicted), and an over-limit tag set is
  acknowledged `"uncacheable"` so the capture backs off instead of
  re-rendering per MISS. A custom store can still declare `shellFamilyInert`
  to stop captures at the gate (`skip-inert-store` on the debug event); the
  built-in stores never do.
- Structured capture diagnostics: `createRouter({ debugShellCapture: true })`
  logs one line per capture attempt/skip (outcome, durations, prelude and
  snapshot bytes, backoff state); pass a function to receive each
  `ShellCaptureDebugEvent` instead. `skip-capacity` means the isolate already
  has 32 queued/running captures; the dropped best-effort capture can retry on a
  later request. `skip-queue-timeout` means this capture waited 15s behind the
  active or same-priority work and was dropped before rendering; document-shell
  captures outrank queued navigation-only snapshots, but never interrupt the
  active capture — the skip event and the `rango.background` span carry
  `queuePriority`/`queueAhead` (class and backlog at enqueue) so a parked
  capture diagnoses itself. A stored attempt reports `recordSettleMs`
  (`record=` in the log line): how long the capture waited for the handler
  layer to settle (promises it passes or pushes, async server components,
  loaders it awaits, top-level pushed handle promises and bake-lane loader
  containers) and its segment record to encode; and `entryBytes` (`entry=`):
  the stored entry's size. In dev, past 2s, the settle is also
  named once per key in a console warning with the remedies (`cache()` the
  work / move it into a live loader / return it as a nested promise or drop
  `ssr: false` in a bake-lane loader). In dev, with
  `debugPerformance` on, the last capture outcome for a key also rides the
  next document GET's `Server-Timing` as `ppr-capture;desc="…"`.
- For deployed Cloudflare tier diagnostics, build with
  `INTERNAL_RANGO_DEBUG=1` and run `wrangler tail`. `[CFCacheStore][shell]`
  JSON events distinguish memo hits, L1 hit/miss, KV fallback/promotion, tier
  writes, and marker rejection, with `cf-ray`/colo and read timings. The flag is baked at
  build time; setting only a Worker runtime variable is too late.

### Unit / integration testing (public primitives)

Import from `@rangojs/router/testing` (Vitest) or `@rangojs/router/testing/e2e`
(Playwright); `serveShellRequest` from `@rangojs/router/testing/flight`:

| Helper                                            | Use for                                                      |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `assertShellStatus(res, "HIT" \| "MISS")`         | Document Response from a real RSC serve / e2e `page.request` |
| `assertPprReplayStatus(res, expected)`            | Partial response fresh/stale replay or bounded bypass        |
| `parsePprReplayStatus(res)`                       | Read structured replay/bypass status or null                 |
| `shellCacheKey(url)`                              | Production store key for `store.getShell` / custom stores    |
| `MemorySegmentCacheStore` + `getShell`/`putShell` | Custom store contract / tag eviction (no faked HIT)          |
| `serveShellRequest(router, url, opts)`            | A real MISS → capture → HIT (react-server Vitest)            |

```ts
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { assertShellStatus, shellCacheKey } from "@rangojs/router/testing";

// Unit: store + key (after a real putShell / capture flush in e2e)
const store = new MemorySegmentCacheStore();
const key = shellCacheKey("http://localhost/products/1");
// ... after production putShell ...
expect(await store.getShell(key)).not.toBeNull();

// E2E: header on a real document GET
assertShellStatus({ headers: new Headers(res.headers()) }, "HIT");
```

**Out of unit scope** (stay e2e): real HTML (the prelude bytes and the fizz
resume), browser resume of holes, the build-time shell capture. A MISS →
capture → HIT runs in a unit test through `serveShellRequest` from
`@rangojs/router/testing/flight`: the shell as captured is `result.prelude`,
the live tail is `result.flight`. "A HIT runs no handler and shows the
capture's handler output" is assertable there: count handler runs or render a
per-run stamp, then compare the MISS and a later HIT. `dispatch` never runs
PPR. `renderHandler` only exposes `ctx.dynamic()` / `build` for the opt-out
path. Do not invent a HIT Response in unit tests. Full recipe: `/testing`
skill → `serve-shell-request.md` and `cache-prerender.md` (PPR shell section).

## The hole doctrine (encode this in your head)

Holes are **render-defined**, decided by the shape of the tree. There are two
classes, and the handler layer is always on the SHELL side:

| Class          | What decides it                                                                                                                                                                                                                                                                                                                           | At capture                                                                                                | At serve (HIT)                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **STRUCTURAL** | a LIVE-lane loader (no `ssr: false`) read under a boundary: `loading()` (the whole segment subtree under it) or an inline `<Suspense>` above the reader                                                                                                                                                                                   | live loaders masked; the boundary postpones; its fallback bakes in as route structure                     | loaders run fresh; resume fills the hole        |
| **SHELL**      | everything the handler layer produces — awaited data, a promise it passes as a prop (even under the consumer's `<Suspense>`), an async server component, handle pushes at any depth, a loader it awaits (`await ctx.use(Loader)`) — plus replayed `cache()` segments and the settled non-promise data of BAKE-lane (`ssr: false`) loaders | awaited (one deadline, `ppr.captureTimeout`) and baked into the prelude and the shell's recorded segments | served from the frozen prelude; no handler runs |

One hole lives INSIDE loader data, decided by shape: a promise nested in a
bake-lane loader's return value, or in a handle container a loader pushes, is
masked at capture however fast it settles, and postpones at the consumer's own
`<Suspense>`. Such a loader still runs on every HIT, so that promise streams in
fresh (a promise-free bake-lane loader does not run on a HIT; see "On a shell
HIT").

The promise rule, by producer: **a promise a handler produces bakes, at any
depth; a promise nested in loader data stays live.** A
`loader(Def, { ssr: false })` is the BAKE lane (see the lane rule below): its
settled non-promise data is shell material, exactly like handler output, while
its nested promises are holes. A live-lane loader is a hole as a whole.
`ssr: false` on a loader is the same knob as `loading(fallback, { ssr: false })`:
the document does not stream a fallback for it but resolves the loader before
the first flush, so under `ppr` its value lands in the prelude and bakes into
the shell. Delivery details: `/loader` → "`ssr: false` — Guarantee a Loader in
the Document".

An async server component that never settles inside `ppr.captureTimeout`
(with or without `<Suspense>` above it) stores no shell; the warning names the
deadline. Make it cheaper (`cache()`/`"use cache"`), raise the budget, or move
its data into a live loader read under a boundary.

### The loader lane rule

**Only `loader(Def, { ssr: false })` bakes into the shell, and only the parts
of its returned data that are NOT promises.** The loader runs at capture; its
settled non-promise values are frozen into the shell (snapshot-pinned per
shell). Any promise inside the returned data is masked at capture and stays a
live hole, streamed fresh on every request at the consumer's own `<Suspense>`,
however fast it settles. The shape of the return value declares what is live:
a plain value bakes, a promise stays live. (The lane rule is about loaders the
route registers. A loader a HANDLER awaits with `ctx.use()` is handler output:
the handler's copy bakes whatever the flag says, even while the same loader's
registered read stays a live hole.)

- **Any depth, plain containers and JSX props.** The mask walks plain objects
  (prototype `Object.prototype` or `null`), arrays and the props of React
  elements at any depth — `{ items: [{ stock: fetchStock(sku) }] }` keeps
  every `stock` live, and so does `{ reviews: <Reviews data={fetchReviews(id)} /> }`
  for `data`. JSX without promises bakes like any plain value. A promise in
  the props of a host element (`<p>`, `<div>`), `<Suspense>`/`<Fragment>` or a
  client component is the hole and nothing else: the element's other props
  bake and stay pinned on every HIT. That includes client components in JSX
  the loader read back from `cache()` or `"use cache"`, which come back
  wrapped in `lazy`. A server component (a function component, `memo` or
  `forwardRef` around one, or a `lazy` that resolves to one) with a promise
  anywhere in its props is the exception: the whole element is the hole and
  renders from the
  fresh loader run on a HIT, so the props it renders into the shell must come
  out the same on every run. A `Map`, `Set`, class instance, or any other
  non-plain object is a LEAF: a promise inside it is NOT masked and does NOT
  become a live hole. Keep live promises in plain objects, arrays and JSX
  props.
- **The consumer's `<Suspense>` is the hole.** A client component reads the
  live property with `use(data.price)` inside its own `<Suspense>`; that
  boundary postpones at capture and resumes with the fresh value.
- **Loader handle pushes follow the same shape rule.** The capture applies the
  same mask to handle containers a loader pushes, so
  `ctx.use(Handle)({ ..., x: promise })` inside a loader keeps `x` live. The
  same push from a HANDLER bakes `x` (see "Handles").

**Every loader without `ssr: false` is entirely live**, whether or not it has
`loading()`: masked at capture with a never-resolving promise, postponed at its
boundary, and streamed fresh on every request. It needs a boundary —
`loading()` or an inline `<Suspense>` above the reader — or the shell is
refused: a masked read with no boundary above it root-postpones, the `<body>`
sanity gate refuses the capture, and the route stays an eternal MISS (warned
once per key). A route whose loaders are ALL `ssr: false` needs no
`loading()`: nothing masks, and the shell captures complete.

```typescript
export const ProductLoader = createLoader(async (ctx) => {
  const product = await getProduct(ctx.params.id);
  return {
    name: product.name, // plain value: bakes
    description: product.description, // plain value: bakes
    price: fetchPrice(ctx.params.id), // promise: masked at capture, live hole
  };
});

path("/products/:id", ProductPage, { name: "product", ppr: true }, () => [
  loader(ProductLoader, { ssr: false }), // BAKE lane
  loader(StockLoader), // LIVE lane: ProductPage reads it under an inline <Suspense>
]);
```

```tsx
// ProductDetails.tsx — the consumer of the live nested property.
"use client";

import { Suspense, use } from "react";
import { useLoader } from "@rangojs/router/client";

function Price({ price }: { price: Promise<number> }) {
  return <PriceTag amount={use(price)} />;
}

export function ProductDetails() {
  const { data } = useLoader(ProductLoader);
  return (
    <article>
      <h1>{data.name}</h1> {/* baked */}
      <p>{data.description}</p> {/* baked */}
      <Suspense fallback={<PriceSkeleton />}>
        <Price price={data.price} /> {/* hole — fresh on every request */}
      </Suspense>
    </article>
  );
}
```

`name` and `description` are frozen into the shell; `price` is a hole under
the consumer's `<Suspense>`, fresh on every request. `StockLoader` is masked at
capture and postpones at the inline `<Suspense>` around its reader. A
`loading()` on this entry would also be a valid boundary, but its fallback
wraps the entry's whole subtree: a live read with no inline `<Suspense>` of its
own takes the entire entry — baked `name`/`description` included — into that
hole.

**`loading()` is NOT the lane switch and NOT the gate for holes** — it is one
of the two boundary kinds a live loader postpones at; an inline `<Suspense>`
above the reader is the other. A route with no loader has no holes: its whole
page is shell, which is a valid ppr route (the shell is served instantly and
recaptured on TTL/SWR or tag invalidation).

The promise positions, side by side:

```typescript
async function Handler(ctx: HandlerContext) {
  const push = ctx.use(MyHandle);

  push(fetchBadge());                      // top-level handler push: awaited at capture → BAKED
  push({ label: "x", stat: fetchStat() }); // nested in a handler push: awaited at capture → BAKED

  const data = await fetchHeader(ctx);     // awaited by the handler → BAKED

  return (
    <section>
      <Header data={data} />                   {/* shell */}
      <StatsPanel promise={fetchStats(ctx)} /> {/* un-awaited prop under the consumer's
                                                   <Suspense>: awaited at capture → BAKED */}
      <LiveStats />                            {/* "use client": useLoader(StatsLoader)
                                                   under <Suspense>, StatsLoader registered
                                                   without ssr: false → HOLE */}
    </section>
  );
}
```

### Choosing the hole mechanism

| Your live region is…                            | Use                                                                                                            | Why                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| data that must be fresh EVERY serve             | `loader()` (the live lane) + `useLoader` under `loading()` or an inline `<Suspense>`                           | the guaranteed hole — masked at capture, fresh every serve, immune to fast resolution              |
| loader data, shell container + live parts       | `loader(Def, { ssr: false })` (the bake lane): `{ static, dynamic: promise }`                                  | plain values bake (snapshot-pinned per shell); nested promises hole at the consumer's `<Suspense>` |
| handler-fetched data (db, fetch)                | nothing to choose: it bakes, whether the handler awaits it or passes the promise down                          | handler output is shell material; move the fetch into a live-lane loader to make it live           |
| handle metadata that must be live               | push it from a loader: a live-lane loader pushes per request; a bake-lane loader's nested promise stays a hole | handler pushes bake at any depth; loader pushes keep "nesting = liveness"                          |
| already-resolved / instant / synchronous values | `loader(() => Promise.resolve(x))` (no `ssr: false`) + a boundary                                              | live-lane loaders are masked at capture no matter how fast they settle                             |
| none of the above                               | nothing                                                                                                        | it bakes — that is what the shell is for                                                           |

Why a handler promise cannot be a hole: every HIT replays the handler layer the
capture recorded, and no handler runs, so nothing on the HIT could produce a
fresh value for it. The capture therefore waits for it and bakes it, exactly as
`cache()` does. Loader-side holes do not depend on timing either: the capture
MASKS every promise nested in a bake-lane container regardless of how fast it
settles (`maskNestedContainerThenables`), so the consuming boundary always
postpones and every HIT streams the FRESH value — the promise SHAPE is the
liveness declaration, not a bet on latency. (Before the mask, a nested promise
that settled inside the capture window pinned its capture-time value into the
shared shell; found live as a storefront basket — with the capturing session's
identifiers — served to anonymous visitors.)

### Handles: handler pushes bake; loader pushes keep "nesting = liveness"

- `ctx.use(H)(promise)` from a handler — a TOP-LEVEL pushed promise is awaited
  at capture and BAKED into the shell (bounded by `ppr.captureTimeout`, 15s by
  default).
- `ctx.use(H)({ x: promise })` from a HANDLER — also baked. The capture waits
  for every promise nested in a handler's push, at any depth of plain objects,
  arrays and JSX props, before it records the handles every HIT replays. Keep
  promises in plain objects, arrays and JSX props: one inside a `Map`, `Set`,
  or class instance is not waited for, and if it has not settled when the handles are encoded the
  capture is refused.
- `ctx.use(H)({ x: promise })` from a LOADER — nesting = liveness. A bake-lane
  (`ssr: false`) loader's container settles and bakes, while the nested promise
  is masked at capture regardless of settle timing and streams fresh to the
  consumer's `<Suspense>` on every HIT (the same mask as bake-lane loader data,
  at any depth of plain objects, arrays and JSX props; a promise inside a
  `Map`, `Set`, or class instance is not masked). A live-lane
  loader never runs at capture unless a handler or an `ssr: false` loader
  awaits it; either
  way its pushes, and those of the loaders it awaits, are live on every HIT.

### Want a hole for already-resolved data?

Put it in a loader without `ssr: false`: `loader(() => Promise.resolve(x))`
under `loading()` or an inline `<Suspense>`. Live-lane loaders are masked at
capture and fresh on every serve, no matter how fast the value settles.

### The bake lane: `loader(Def, { ssr: false })`

A loader registered with `{ ssr: false }` EXECUTES during capture (the capture
gate holds open for its real latency, bounded by `ppr.captureTimeout`, 15s by
default). The flag's document promise — "this loader's data is in the HTML
before first flush" — maps to the frozen prelude under ppr. Its settled
non-promise data bakes into the prelude; every promise nested in it is masked
at capture (regardless of how fast it settles) and postpones at the consumer's
own `<Suspense>` — a hole. The capture records the container into the shell
snapshot's loader family so every HIT payload matches the frozen prelude
outside the holes (see "On a shell HIT" below; a server component holding a
promise is the one element that is a hole as a whole, see "Any depth" above).
The return shape is the declaration:

```typescript
export const StorefrontContextLoader = createLoader(async (ctx) => {
  const config = await loadSiteConfig(ctx.params.locale); // bakes (pinned per shell)
  return {
    config, // shell material
    basket: fetchBasket(ctx), // hole — consumer <Suspense>s it, fresh per request
  };
});

layout(StoreLayout, () => [
  loader(StorefrontContextLoader, { ssr: false }), // the flag selects the bake lane
  path("/", HomePage, { name: "home", ppr: true }),
]);
```

The lane is decided PER LOADER, by its own `ssr: false` flag — `loading()` on
the same entry, a parent, or a child never changes it. `loading()` only decides
where a live loader's hole sits, and it IS valid on layout and parallel
entries, not just routes.

#### On a shell HIT

What a bake-lane loader does on a HIT depends on whether its recorded
container carried holes. A client navigation that replays a shell captured by
a document request (`x-rango-ppr-replay: HIT`) does the same, for every
`ssr: false` loader, including one on an entry with `loading()` (before, a
navigation ran every loader and served its fresh values). A snapshot captured
by a navigation alone carries no pins, and its replay runs these loaders fresh.

- **Hole-free record (the return had no promises): served from the shell.**
  The response uses the pinned container immediately and the loader body does
  NOT run (unless the capture marked it to run: see the handle pushes note
  below): a HIT is rendered from the shell, like the handlers it replays, so
  the loader costs nothing per HIT. Side effects in its body happen once per
  capture, not per request. The output changes only when the shell is
  recaptured (TTL/SWR expiry or tag invalidation).
- **Hole-carrying record (the return had promises).** The loader runs on every
  HIT, ON the critical path — only the body can create the live promises that
  fill the holes — and the recorded baked paths are overlaid onto the fresh
  result, so the payload matches the prelude while the nested promises stream
  fresh. A fresh rejection skips the overlay and goes to the loader's error
  boundary. Give it its own cache,
  `loader(Def, { ssr: false }, () => [cache({ ttl })])`, so that run reads
  through the loader cache.

Whether a return "has promises" is decided ONCE, at capture, by the shape of
the value, never by timing: `maskNestedContainerThenables`
(`router/segment-resolution/mask-nested.ts`) walks the returned data through
plain objects, arrays and JSX element props and turns every thenable into a
hole; the drain stores the result as the record's `holes` bit. A promise that
resolves in 1 ms is still a hole, so `{ product: await getProduct() }` bakes
and does not run on a HIT, while `{ product: getProduct() }` is a hole and
runs on every HIT. A promise inside a `Map`, `Set` or class instance is not
walked and is not a hole: the capture's record encode waits for it and bakes
its settled value, and a HIT serves that value without running the loader.

The granularity is the WHOLE loader: a bake-lane loader returning
`{ product, reviews: promise }` runs its entire body on every HIT, the product
fetch included, even though the captured product overlays its result. Split
it into a promise-free `ssr: false` loader plus a live loader for the
per-request part, or give it its own `cache()` so that run reads through it:

```tsx
loader(ProductLoader, { ssr: false }), // promise-free: baked, not run on a HIT
loader(ReviewsLoader),                 // live: the hole, under loading()
```

**A hole never reads the shell's copy of a value.** The shell stores its
recorded segments and the `ssr: false` loaders' baked containers, and no
`"use cache"` or loader `cache()` value. Every cache read on a HIT goes to
the store: a live loader's, a nested promise's, and the body of an
`ssr: false` loader that runs on the HIT. So a live loader that reads the
same `"use cache"` key as an `ssr: false` loader shows the store's current
value once it refreshes, while the baked container keeps the capture's. If a
hole needs a stable value, give it its own cache (`"use cache"` with a
profile, or a loader `cache()`); the shell never provides one.

**Handle pushes from a bake-lane loader appear once, and they match its
data.** A loader's title, meta or breadcrumb describes the data next to it,
so both come from the same run on every way a shell can be replayed: a
document HIT, a client navigation, a prefetch. The capture records the
settled, thenable-free handle pushes of every loader body it runs (the
prelude rendered them): the `ssr: false` loader's own, those of the loaders
it awaits with `ctx.use()`, and those its own `cache()` entry replays. What
a replay does with a loader's recorded pushes follows what it does with that
loader's data:

| The replay serves the loader's data from                                    | Its settled pushes are                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the shell (its pinned container)                                            | the shell's: restored with the handler layer, and they stand. A loader that does run on the replay (a hole-carrying one) reads the store, and the settled pushes that run makes are dropped |
| a run on this request (a live-lane loader, or one the shell has no pin for) | that run's: they replace the shell's copies in place; a run that throws or makes no push shows none                                                                                         |
| the loader's own `cache()` entry                                            | that entry's: the pushes it recorded, none if it recorded none                                                                                                                              |

So any handle, deduping or not, shows each value once. A pinned loader's
pushes are the values the prelude rendered, also for the pushes a `"use
cache"` hit inside its body replays. A loader the route also registers on
the live lane is a hole: its live run replaces its restored pushes, and those
of the loaders it awaits, so they show its live value, even when a bake-lane
loader running on the replay awaits it; a hole slower than the handler
barrier shows the shell's copy in the first snapshot until its run ends. An
`ssr: false` loader is served from the shell only while the entry holds its
pin: a snapshot captured by a navigation alone carries none, and a shell over
`ppr.maxSnapshotBytes` drops them. There the loader runs fresh, and its
pushes are that run's, like its data.

A dependency the route does not register, which an `ssr: false` loader
awaited at capture outside any live loader, is on neither lane: its settled
pushes stay as the prelude rendered them, even where a live loader also
awaits it, while its data is fresh. (They follow the run instead once the
entry has lost a pin, because the loader that awaits it then runs.) To keep
its pushes live, declare it as its own `loader()` on the route. A push the
capture cannot record (a deferred push, or one holding a promise) marks every
loader record of the page to run: those bodies then still run on each replay,
in the background, and that push reaches the page (from the loader's own
`cache()` entry when it hits) with the run's value, on a document HIT and on
a client navigation alike; a push that lands after the document's handle
snapshot reaches the client after hydration.

Two arrangements still mix sources, and both are tracked in
`docs/design/handle-push-ownership.md`. A loader that reads a `cache()`-bound
loader with `ctx.use()` before that binding starts (a loader declared ahead
of it, a parent layout) runs it live while the binding serves its entry
(#1002): declare the cached loader first, or read it from the handler. And
an `ssr: false` loader that pushed nothing at capture but pushes on a replay
shows that push next to its pinned data: push from every run, or from none.

Four hard edges (each e2e/unit-pinned):

- **Header writes throw (issue #713).** ppr is a document-scoped `cache()`:
  in any cached scenario ONLY MIDDLEWARE writes response headers. A handler
  or loader on a ppr route calling `ctx.headers.set()`, `cookies().set()`,
  `ctx.setTheme()`, or the request-context `header()`/`setStatus()` throws on
  EVERY render — dev and prod, first render, same guard family as the
  `cache()` boundary guard. Handler output is replayed on HITs and no handler
  runs there (the write would silently differ between MISS and HIT); loaders
  are live but settle AFTER the response headers flushed with the shell (dead
  letters). Move the write into route middleware — it runs
  on every request, including HITs, and its headers/cookies merge into every
  response. The one exception: a handler that calls `ctx.dynamic()` FIRST
  re-permits its own header/cookie write (#735) — a dynamic() render never
  HITs, so the write is deterministic (see "Opting out per request").
- **Identity refuses.** `cookies()`/`headers()`/`ctx.request.headers` inside a bake-lane loader
  throws during capture and the capture REFUSES (deterministic, once-per-key
  warned) — identity can never bake into the shared shell. Drop the loader's
  `ssr: false` flag (the live lane is exempt; give it a boundary) or move the
  identity-dependent part into a separate loader without `ssr: false`. A
  nested promise does not help here: its body still runs during capture and
  trips the guard. The same refusal covers everything else the capture waits
  for (a handler, a promise it passes or pushes, an async server component, a
  loader a handler awaits), a `{ cache: false }` variable
  (`createVar({ cache: false })` or `ctx.set(..., { cache: false })`) read
  there, and the visitor's theme (`ctx.theme`, `getRequestContext().theme`,
  #971); see "Security". Read the theme with `useTheme()` in a client
  component, or in a live loader with `cookies().get("theme")`; the shell's
  `initialTheme` is the no-cookie default. Per-user state read from a NORMAL
  middleware-provided variable (`ctx.get("session")`) does NOT refuse — it
  bakes silently as the capturing user's data (see Pitfalls: the
  session-object bake trap).
- **A rejecting bake-lane loader refuses.** Error UI never bakes. So does a
  value that fails to encode: a function, a class instance, a promise inside a
  `Map` that rejects, or a server component in the value that throws. The
  capture stores nothing, logs the error, reports `cache-write` and backs the
  key off, the same as a shell component that throws (below). The capture
  encodes the value a second time to pin it for HITs, so a server component
  that throws only on that run refuses it too. A build-time capture skips the
  shell (`SHELL SKIP`) and the route keeps runtime capture.
- **Baked containers show CAPTURE-time data** for the shell's lifetime on
  document GETs, and on soft navigations that replay a shell captured by a
  document request (`x-rango-ppr-replay: HIT`). Live loaders and their
  `"use cache"` reads remain fresh. That IS the bake lane's meaning; if a value
  must be fresh on every serve, it belongs on the live lane (no `ssr: false`) or
  in a nested promise.

### The layout-with-loaders playbook (the storefront case)

The most common real-app shape: an app-wide layout registers per-user loaders
(session context, basket, wishlist) and the page under it declares `ppr`.
Unflagged, those loaders are on the LIVE lane: masked at capture, so every
read needs a boundary (`loading()` or an inline `<Suspense>`) or the capture
refuses and the page stays an eternal MISS. The question is which parts of
their data should bake vs stay live. Your levers, in order of preference:

1. **Flag the loader and shape the return value.**
   `loader(SessionContextLoader, { ssr: false })` puts it on the bake lane:
   shared/config data returns as plain values (bakes, pinned per shell);
   per-request data returns as NESTED promises consumed under the widget's own
   `<Suspense>` (live holes). No `loading()`, no restructuring. One wall: a
   bake-lane loader that reads `cookies()`/`headers()`/`ctx.request.headers`
   refuses the capture —
   identity belongs on the live lane (a separate unflagged loader); a nested
   promise inside the flagged loader still runs during capture and trips the
   guard.
2. **Do NOT use `loading()` on the layout itself as the live loaders'
   boundary** — any live read without an inline `<Suspense>` of its own
   suspends to it, and the LoaderBoundary fallback wraps the layout's ENTIRE
   subtree: chrome (header, nav, footer) falls out of the shell into the
   skeleton. Technically PPR, practically pointless.
3. **Guaranteed-fresh widgets: live loaders with a widget-sized boundary.**
   An unflagged loader read under an inline `<Suspense>` in the widget is
   enough. Alternatively, a parallel slot with its OWN `loading()`:
   parallel-owned loaders get their own per-slot boundary (`fresh.ts` tags
   them with the slot's loading; `segment-system.tsx` builds a per-slot
   LoaderBoundary), so the chrome bakes into the shell and each widget is an
   independent, widget-sized hole:

   ```typescript
   layout(StoreChrome, () => [
     // chrome renders NO loader data itself — it bakes into the shell
     parallel({ "@basket": BasketBadge }, () => [
       loader(BasketLoader),
       loading(<BadgeSkeleton />), // hole the size of a badge, not a page
     ]),
     // Descriptor form when the slot handler needs ctx (annotate it —
     // StaticHandlerDefinition in the union blocks inference there):
     parallel({
       "@wishlist": {
         handler: (ctx: HandlerContext) => (
           <WishlistBadge listUrl={ctx.reverse("wishlist")} />
         ),
         use: () => [loader(WishlistLoader), loading(<BadgeSkeleton />)],
       },
     }),
     path("/", HomePage, { name: "home", ppr: true }),
   ]),
   ```

   Slot-owned loaders without `ssr: false` are masked at capture and
   GUARANTEED fresh per serve — use this where the bake lane's pinning
   (capture-time data for the shell's lifetime) is not acceptable, at the cost
   of a widget-sized fallback in the shell. The slot handler must hand the
   loader to a CLIENT component (`useLoader` in a `"use client"` component):
   that client-side read is the hole. A server-side
   `await ctx.use(WishlistLoader)` in the slot handler is handler output: it
   runs at capture, its value bakes into the shell for every visitor, and if
   the loader reads `cookies()`/`headers()` (the usual case for a per-user
   loader) the capture is REFUSED and the page stays on MISS.

4. **Shared layout data does not need a loader at all**: render it from the
   handler (awaited, passed down as a promise, or pushed — it all bakes) and
   wrap the expensive part in `cache()`/`"use cache"` so captures stay cheap
   and the shell is tag-invalidatable.

The identity rule, stated once: per-user data on a PPR page lives in a
live-lane loader (no `ssr: false`) consumed CLIENT-side with `useLoader` under
`loading()` or an inline `<Suspense>`, or in a NESTED promise inside a
bake-lane loader (a hole, fresh per request). A nested promise's body still
runs at capture, so it must not call `cookies()`/`headers()` or read
`ctx.request.headers` itself — identity reads belong in the live-lane loader.
Reading `cookies()`, `headers()`, `ctx.request.headers`, or a
`{ cache: false }` variable anywhere the capture waits for refuses the capture
by construction: handler/render code, a promise the handler passes or pushes,
an async server component, a bake-lane loader, and a loader a handler awaits
(`await ctx.use(Loader)`). There is no exemption for handler-invoked loaders:
every HIT replays the capture's copy of their value, so an identity read there
would show the capturing request's user to every visitor.

### Designing routes for cheap captures (the cost model)

The hole doctrine has a cost corollary that bites silently: **everything that
bakes is awaited at capture, and that wait recurs on EVERY capture of the
route**. That now includes every promise a handler produces: a prop promise, an
async server component's data, a nested value in a handle push, a loader the
handler awaits. A handler pushing a handle promise that takes 5s and a Meta
promise chained 2s further make every capture occupy the per-isolate serialized
queue for ~7s — while the served response still reads 13ms TTFB, because
captures are detached. You will not see this cost in any request timing; you
see it as slow MISS→HIT flips, `skip-queue-timeout` under prefetch pressure,
and (in dev, past 2s) the bake-cost warning naming the source.

Three levers, in preference order:

1. **Make it live**: move the value into a live-lane loader (no `ssr: false`)
   read with `useLoader` under `loading()` or an inline `<Suspense>` — a hole,
   per request, zero capture cost. Inside a bake-lane loader, return the slow
   part as a nested promise instead. Nesting a promise inside a HANDLER's push
   or props no longer does this: handler output is always awaited.
2. **`cache()` the work inside it**: the value stays baked (shell material,
   tag-invalidatable), but the capture replays the cached value instead of
   re-executing the expensive body (mixed-chain). Choose this for shared,
   expensive-to-compute shell content.
3. **Drop `ssr: false`** (loaders only): moves the loader to the live lane —
   masked at capture, fresh per serve — at the cost of a fallback in the shell
   (a live loader needs `loading()` or an inline `<Suspense>` above its
   reader).

Head material (Meta) pushed by HANDLERS cannot be a hole — the head is shell —
so those promises bake by design; make them cheap with lever 2.
`recordSettleMs` on the capture debug event tells you what each capture
actually paid. A
Meta pushed by a LIVE-lane loader is different: those loaders are masked at
capture, so the push happens at request time and applies client-side
(`metadata.handlesLate`) — it is never in the cached shell's head, by
construction. A bake-lane (`ssr: false`) loader executes at capture, so its
settled pushes are shell material like a handler's.

`loader(Def, { ssr: false })` (the document-render await, `/loader`) is the
bake-lane switch under PPR, not a knob for normal renders only: the capture
render awaits the flagged loader too, so its settled non-promise data — handle
pushes included — freezes into the stored shell and recurs as capture cost on
every capture (levers 1 and 2 apply to it). On a MISS the flag keeps its
normal-render meaning: document renders await it before first flush, client
navigations stream it. A shell HIT, and a navigation that replays a shell
captured by a document request, serve a promise-free one from the shell
without running it (unless the capture marked it to run: see "On a shell
HIT"); a snapshot captured by a navigation alone carries no pins, and its
replay runs it fresh.

## Execution matrix

| Phase            | MISS (foreground)      | Background capture                                                                                                                                                                                    | HIT (foreground)                                                                 |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Middleware chain | runs (full)            | **NOT re-run** — inherits the request's post-middleware context                                                                                                                                       | runs (full) — commit point is after it                                           |
| `router.match`   | runs                   | re-runs under a derived context                                                                                                                                                                       | runs (behind the flushed prelude)                                                |
| Handlers         | run                    | run on UNCACHED segments (`cache()`d segments replay); everything they produce — promises, async server components, handle pushes, awaited loaders — settles before the freeze (`ppr.captureTimeout`) | **never run** — the handler layer is replayed from the shell's recorded segments |
| Loaders          | run **fresh**          | LIVE lane (no `ssr: false`): MASKED; BAKE lane (`ssr: false`): execute + snapshot-pin                                                                                                                 | live: run **fresh**; bake: pinned, runs only if its record has holes             |
| Flight render    | full                   | full, from the capture's own recorded segments (the same bytes every HIT replays)                                                                                                                     | full (hydration needs the whole payload — no Flight resume)                      |
| HTML production  | full fizz              | `prerender` + abort → prelude + postponed                                                                                                                                                             | `resume` only the holes — O(paths to holes)                                      |
| Shell store      | schedules a bg capture | `putShell(key, …)`                                                                                                                                                                                    | `getShell(key)`; a stale/SWR hit also schedules a recapture                      |
| Prelude bytes    | —                      | —                                                                                                                                                                                                     | flushed FIRST, before segment resolution starts                                  |

Middleware is not re-run during capture because it already ran for the
triggering request — the capture's derived context inherits the
post-middleware state (`ctx` variables included, which is what makes
middleware-derived shell content photograph correctly). Guarding is
serve-time: the commit point runs the full chain on EVERY serve.

Because handlers on uncached segments EXECUTE during capture — along with
everything they produce and every BAKE-lane loader — the capture guard is
load-bearing: `cookies()`, `headers()`, `ctx.request.headers`,
`getRequestContext().cookie()` / `.cookies()`, a theme read, and a
`{ cache: false }` variable read THROW during a capture render, and the capture
is refused even when the code catches that throw, so identity can never leak
into a shared shell through them. Live-lane loaders (every loader without
`ssr: false`) are exempt when only a client component reads them: masked at
capture, they never run there. One a handler or an `ssr: false` loader awaits
runs at capture, and its identity reads refuse it.

## allReady: the SEO/bot story

`ssr: { resolveStreaming: ... }` returning `"allReady"` (e.g. for bot user
agents) bypasses PPR entirely — the request gets one complete, fully-buffered
document (a normal render, no shell). Crawlers that dislike streamed shells
get a finished page; regular users get the streamed shell. No configuration
interaction: allReady wins.

## Security

Shell caching shares one shell per host+URL (and request partition, see
"Request-partitioned shells") across all users:

**(a) Access control is sound by construction.** The commit point is after ALL
middleware on every serve. A 401/redirect short-circuit returns before any
shell byte.

**(b) Request-scoped reads refuse the capture.** During the background capture
render, `cookies()`, `headers()`, the raw reads `ctx.request.headers` and
`getRequestContext().cookie()` / `.cookies()`, the visitor's theme (`ctx.theme`,
`getRequestContext().theme`), and `ctx.get()` of a `{ cache: false }` variable
(`createVar({ cache: false })`, or a value written with
`ctx.set(..., { cache: false })`) THROW, wherever the capture waits for them:
a handler, a promise it passes or pushes, an async server component, a
bake-lane loader, and a loader a handler awaits (`await ctx.use(Loader)`). The
capture is refused even if your code catches the throw, and the route keeps
serving MISSes with a once-per-key warning. `ctx.dynamic()` called there
refuses it too. The live lane (no `ssr: false`) stays exempt when only a client
component reads it; one a handler or an `ssr: false` loader awaits runs at
capture, and its identity reads refuse it.

**(c) Residual hazard — middleware-derived per-user state.** A NORMAL `ctx`
variable (no `cache: false`) set by an upstream auth middleware and rendered by
shell material is photographed into the SHARED shell (the capture inherits
post-middleware state). The guard cannot see it. That is scope fidelity
working as designed — for shared
values. It reaches handlers and BAKE-LANE LOADERS alike: a loader reading a
middleware-provided session object (`ctx.get("session")`) never calls
`cookies()` itself, so whatever it returns as settled container data is
photographed as the CAPTURING user's state. If the value is per-user:
shell-cache only public/shared pages, keep per-user content in live-lane
loaders (no `ssr: false`) or nested promises in bake-lane loader data — NOT in
handler output or plain bake-lane container data — mark the variable
`{ cache: false }` so a stray shell read refuses the capture, or key per
variant at the CDN tier.

## What always renders without a shell

Non-GET, non-partial RSC/action/loader fetches, partial requests without an
eligible captured segment snapshot, per-request CSP nonce, `streamMode:
"allReady"`, redirects, 404s, error renders, routes without `ppr`, a document
request the route's own `cache()` scope refuses (`cache(false)`, or a
`condition()` returning false for it), and any store without the shell family.
A stored shell is invalidated when
`React.version` changes (postponed state is build-coupled), so deploys
self-heal via recapture.

The per-request CSP nonce guarantee covers BOTH ways a nonce arrives — the
`createRouter({ nonce })` provider AND a direct `ctx.set(nonce, value)` token
write in middleware (the `nonce` token from `@rangojs/router`). Either way the
nonce ends up rendered into the document (`useNonce()` puts the provider nonce
on every nonced script/style/meta; a token nonce is rendered by whatever app
code reads `ctx.get(nonce)`), so a shell shared per host+URL cannot bake it
without freezing one request's nonce for every visitor (the browser's CSP
would then reject the frozen nonce for all but the capture request). The serve
gate reads the token off the post-middleware request variables at the commit
point (which runs after the whole middleware chain), so a middleware-set nonce
blocks capture the same as a provider one. Because the route DECLARED `ppr`
but cannot be honored, it logs a once-per-key worker warning (same
declared-intent-cannot-be-honored doctrine as the missing-store warning) and
serves a normal render (no shell) with no `x-rango-shell` header. An
undeclared route stays silent.

### The proper way to supply a nonce

`createRouter({ nonce })` is the canonical path — supply the nonce THERE, not
via a token write. The provider value is threaded into the router's own SSR
machinery: `NonceContext`/`useNonce()`, automatic nonce attributes on
`<Html.Scripts />` and `<Html.Meta />` output, and the inlined Flight payload
scripts. It ALSO sets the `nonce` token, so `ctx.get(nonce)` works in
middleware and handlers for the CSP response header. A direct
`ctx.set(nonce, value)` write in middleware is app-managed only: the router
resolves its SSR nonce BEFORE middleware runs, so a token-set value is
readable via `ctx.get(nonce)` and gates PPR (this section), but the router
will NOT apply it to its own scripts — `useNonce()` stays undefined and the
Flight payload scripts carry no nonce, which a nonce-only `script-src` policy
would then block. If you need a per-request nonce, use the provider; reserve
the token for READING the value.

## Options: PartialPrerenderProps

```typescript
path("/products/:id", Page, { name: "product", ppr: true }, use);
path(
  "/products/:id",
  Page,
  { name: "product", ppr: { ttl: 600, swr: 120, tags: ["catalog"] } },
  use,
);
```

| Field              | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttl`              | `300`   | shell freshness window in seconds (`ppr: true` uses the default)                                                                                                                                                                                                                                                                                                                                            |
| `swr`              | —       | stale window: serve the stale shell + background recapture                                                                                                                                                                                                                                                                                                                                                  |
| `tags`             | —       | operational tags UNIONED with the tags the capture collects — see "Invalidation" below                                                                                                                                                                                                                                                                                                                      |
| `maxSnapshotBytes` | 8 MiB   | cap on the loader pins in the entry's snapshot (the bake-lane loader records). The recorded handler layer is exempt. Over the cap the pins are dropped and the shell is stored with its handler layer (warned once per key); bake-lane loaders then run on every replay and read the live store, their handle pushes come from that run like their data, and drift from the prelude is repaired client-side |
| `captureTimeout`   | 15000ms | ONE capture deadline: the handler layer settling (promises it passes or pushes, async server components, loaders it awaits), bake-lane loaders, and the prerender; a capture that misses it stores nothing rather than a partial shell                                                                                                                                                                      |

A shell never outlives the route `cache()` entry it was captured from: under
a route `cache()`, the shell is fresh no longer than that entry is (at most
`ppr.ttl`) and served no longer than that entry can be (at most `ppr.ttl` +
`ppr.swr`), so a document HIT and a client navigation (which reads the
`cache()` entry first) show the same handler output. An entry already in its
`swr` window gives a shell that is stale from the start, served while it
recaptures. Each isolate recaptures a stale shell at most once per second
(`SHELL_MIN_RECAPTURE_INTERVAL_MS`): a HIT within a second of the shell's
capture serves it without starting another. When the entry a capture read
runs out before the store (it was near its end), the capture retries once on
a fresh match. Nothing is stored when the retry's entry runs out too, when
the capture budget leaves no time to retry, or when the capture wrote the
entry itself and it ran out before the store (its `ttl` + `swr` is no longer
than the rest of the capture): the URL backs off, and a warning names the
route and the entry's `ttl`/`swr`, once per route (dev and production). In dev an explicit `ppr.ttl`/`ppr.swr` the entry reduces
warns once per route, stating what the shell is stored with; with no `ppr`
window set, the cap applies silently.

Separately from `maxSnapshotBytes`, the whole entry (prelude, postponed state,
and snapshot) must fit the store's value limit — 25 MiB by default, Cloudflare
KV's; `VercelCacheStore` derives its own from its item cap. A bigger entry
refuses the capture (warned once per key) instead of failing the store write:
shrink what the shell bakes or move large regions under a live loader's
boundary.

The shell store is always the app-level `createRouter({ cache })` store; the
default key is `${host}${pathname}${sortedSearch}:shell` (host-scoped so
multi-tenant shells never collide).

These options control the in-function shell entry only. They do not emit HTTP
`Cache-Control`. Adding `s-maxage` separately allows a platform CDN to cache the
completed response, including the live-hole output, and CDN hits bypass Rango
middleware entirely. Only do that for a fully public response whose complete
output is shared; see `/deployment-caching`.

## Invalidation: tags vs revalidate()

`updateTag()`/`revalidateTag()` is the ONLY lever that changes the frozen shell
HTML; `revalidate()` is a DATA lever that never touches it.

A captured shell carries the tags of what renders into it: its segment
record's tags — every `cacheTag(...)` the handler layer ran as shell material,
whether from a `"use cache"` function, a `cache()` segment, or a
render-callable `cacheTag()` in a plain server component (no
`"use cache"`/`cache()` in its tree) — plus the tags of loaders on the BAKE
lane (they execute during capture and their data is in the shell). A tag
recorded outside what the shell renders is not on it. A live-lane loader's tags (every loader without `ssr: false`)
attach only when a handler or an `ssr: false` loader consumes its value with
`ctx.use()`, which bakes it; one read only by the client stays off, since it is masked at capture and
its hole is already live. `ppr.tags` adds
operational tags the render cannot know (a tenant id, a deploy marker).

When the route has its own `cache()`, the capture replays that record instead
of re-rendering, so nothing it covers runs at capture. The record stores the
tags its content recorded when the foreground wrote it and re-records them on
the HIT, so the shell carries the same union. That includes a `loading()`
slot's handler output (a HIT replays it from the record) and any loader a
handler consumes with `ctx.use()`; a loader read only by `useLoader()` under
`loading()` stays off. `updateTag()` of such a tag drops the record together
with the shell, so the recapture renders fresh.

| Lever                                                   | Reaches the frozen shell?                                     | Reaches the holes?                                  |
| ------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| `updateTag` / `revalidateTag` on a SHELL tag            | YES — drops the shell → MISS → recapture                      | n/a (holes are already live)                        |
| `updateTag` / `revalidateTag` on a live-lane LOADER tag | only if a handler consumes the loader (`ctx.use()`)           | drops that loader's cached value (if it `cache()`s) |
| `revalidate()` (named revalidation contract)            | **no** — re-runs segments/loaders for the PAYLOAD, never HTML | yes — the hole re-renders with fresh data           |

A server action's automatic invalidation refreshes the CLIENT only — it re-runs
the holes and streams a fresh payload, but does NOT evict the server shell.
Shell-baked data stays stale until the shell's TTL unless you tag-invalidate it
(`updateTag` on a shell tag). Data baked into the shell WITHOUT a tag cannot be
evicted by tag at all — move always-fresh data into a live-lane loader (no
`ssr: false`) or a nested promise in bake-lane loader data.

## Pitfalls

- **A bake-lane loader that reads `cookies()`/`headers()`/`ctx.request.headers`**: the capture is
  REFUSED (deterministic, once-per-key warned) — the route keeps serving
  MISSes. Move identity onto the live lane (drop `ssr: false`, or split the read into
  a separate unflagged loader; give the reader a boundary). A nested promise
  does not help here: its body still runs during capture.
- **A bake-lane container that must be fresh per document GET**: it is
  snapshot-pinned for the shell's lifetime by design. Use the live lane
  (no `ssr: false`) or a nested promise instead.
- **Handler output or a bake-lane loader slower than `ppr.captureTimeout`
  (15s by default)**: the capture stores nothing rather than a partial shell
  (the warning says the output "did not settle within ppr.captureTimeout").
  Make the slow part cheaper (`cache()`/`"use cache"`), move it into a live
  loader, or increase the route's budget only when the deployment can keep the
  background/build work alive.
- **A pending handler promise expected to be a hole**: it is not. A promise
  the handler passes under `<Suspense>`, an async server component, or a
  promise nested in a handler's handle push is awaited at capture and served
  frozen on every HIT. Move per-request data into a live-lane loader read with
  `useLoader` under `loading()` or an inline `<Suspense>` (see "Migration from
  the old promise-hole model").
- **`cache(false)` or a false `condition()` on a ppr route**: the document
  request renders like a cache miss — a normal render, no `x-rango-shell`
  header, no capture. A `condition()` that is false only for some requests
  renders those requests normally (no shell) while the others keep serving the
  shell.
- **Per-user value in shell material**: baked into the shared shell —
  deterministically, not by race (handler output, promises included, is
  awaited at capture; awaited/resolved values bake everywhere). Put per-user
  data in a live-lane loader (no `ssr: false`) or a nested promise in
  bake-lane loader data — plain BAKE-lane loader data bakes just like handler
  material.
- **The session-object bake trap (the guard cannot save you here)**: the
  capture guard sees `cookies()`, `headers()`, `ctx.request.headers`, the theme
  and `{ cache: false }` variable reads ONLY. A handler or bake-lane loader
  reading a NORMAL middleware-provided
  session object (`ctx.get("session")`) refuses nothing. Inside a bake-lane
  loader, per-user data survives ONLY behind a nested promise — the shape is
  the declaration, and it holds for BOTH branches regardless of settle timing
  (nested thenables are masked at capture). In a handler nothing survives: a
  handler's output bakes, promises included.

  ```typescript
  const CartLoader = createLoader(async (ctx) => {
    const basketId = ctx.get("session")!.get("basketId");
    if (!basketId) return { cart: Promise.resolve(null) }; // nested thenable → masked → hole, fresh per HIT
    return { cart: fetchBasket(basketId) }; // nested thenable → masked → hole, fresh per HIT
  });
  ```

  The remaining trap is returning per-user data as PLAIN container material:
  `return { user: session.user }` bakes it into the shared shell like any
  other settled value — deterministically, not by race. Wrap it in a promise
  (even an already-resolved one) or put the loader on the live lane (drop
  `ssr: false`).

- **Theme on a HIT is default-then-corrected**: the shell's `initialTheme` is
  the no-cookie default (`defaultTheme`), whoever captured it, and the resume
  tree replays it (resume requires it to match the frozen prelude). A visitor
  with a stored theme gets it pre-paint from the FOUC script and in
  `useTheme()` after ThemeProvider re-syncs post-mount. Nothing to configure —
  but a themed component in the shell may briefly render the default theme's
  markup before the post-mount re-sync.
- **Shell shows CAPTURE-time data for the shell's lifetime**: a
  `cache()`/`"use cache"` value baked into the shell is PINNED at capture (the
  capture data snapshot) and replayed on every HIT, so the shell stays
  byte-identical to the frozen prelude even after that cache entry expires or
  is recomputed. This is deliberate — parity beats freshness inside the shell.
  Tags are the link back: every tag a `cache()`/`"use cache"` entry carried when
  the capture read it also rides the shell, so `updateTag` on that tag drops the
  shell too (next request MISSes and recaptures). An untagged entry has no such
  link. If a shell region needs to be fresh, put it under a hole — a live-lane
  loader (no `ssr: false`) behind `loading()` or an inline `<Suspense>`, or a
  nested promise in bake-lane loader data (holes are never pinned) — or make
  the SHELL itself invalidatable by tagging
  it: tag the cached read, call `cacheTag(...)` from the shell-material render
  code (the render-time lever), or add the tag to `ppr.tags` (operational tags
  the render cannot know — a tenant id, a deploy marker). Tags are optional: if
  TTL/SWR is the complete freshness policy, leave the shell untagged. Rango does not warn for that choice; with
  `debugShellCapture` enabled, a stored event reports `untaggedBake: true` when
  bake-lane loader material uses TTL/SWR-only invalidation.
- **A `"use cache"` value the shell and a live hole both read comes from the
  cache store in the hole**: the shell keeps the capture-time value, and a
  live-lane loader under `loading()` or an inline `<Suspense>` that reads the
  same `"use cache"` entry reads it from the store on every HIT. It is still
  cached under its own profile; once the entry expires or is invalidated and
  refreshes, the hole shows the refreshed value next to the shell's old one. The
  shell stores no `"use cache"` value, only its recorded handler output and the
  `ssr: false` loaders' baked containers. A hole reads the store even when a
  bake-lane loader read the same entry at capture: the baked container keeps
  the capture's value, and the hole shows the current entry.
- **Uncached nondeterminism in server output is frozen, not drifting**: a raw
  `Date.now()` / `Math.random()` / uncached `fetch` in a handler or server
  component renders once per capture, and the prelude and every HIT show that
  same value for the shell's lifetime (an uncached async server component used
  to render twice per capture, so the prelude and the HIT payload disagreed).
  If the value must change per request, move it under a hole (a live-lane
  loader read under `loading()` or an inline `<Suspense>`). A CLIENT component
  that renders such a value during SSR still mismatches on hydration, as on
  any SSR page.
- **Stacking with `/document-cache` or HTTP CDN caching**: both cache the
  completed composite, including live-hole output, so PPR becomes redundant on
  a hit. A platform CDN also bypasses every Rango middleware. Restrict this to
  fully public, shared responses; see `/deployment-caching`.
- **Dev + HMR**: works, but edits produce stale shells until TTL/recapture.
- **Dev cold-start cadence**: expect `MISS -> (in-place retry) -> HIT`. A
  refused capture is negatively cached with an exponential window (1s doubling
  to a 60s cap), so declaring `ppr` on an ineligible route never re-renders it
  on every request.
- **HIT status is committed at the flush**: a failing hole cannot become a
  500/redirect after the first shell byte — error UI renders inline via
  Suspense/error boundaries (the same property any streamed SSR page has after
  its shell flushes).
- **A shell component that throws during capture refuses it**: an async
  server component (or a client component during SSR) inside a Suspense
  boundary that throws does not fail the capture render, so its errored
  boundary would bake into the shared prelude. The capture stores nothing
  instead, logs `[ShellCache] capture` with the error (it goes to `onError`
  as `cache-write` unless the router already reported that same error during
  the render), and backs the key off like any refused capture; the next
  capture after the window stores normally. The request that triggered the
  capture is served as before. Only a throw during the capture counts: a
  component that failed in the live render and succeeds when captured is
  stored.

## Related

- `/defer-hydration` — keep the full body HTML in the shell while moving a
  heavy subtree's hydration off the initial main-thread task (gated boundary,
  content-as-fallback)
- `/document-cache` — store-backed whole-response caching (no live holes)
- `/caching` — `cache()` segment caching and stores; `/use-cache` — function caching
- `/shell-manifest` — replayed handles as cache metadata read by live loaders
- `/prerender` — `Prerender` + `ppr` bakes the shell at build time
- `/cache-guide` — where the shell layer sits among the other cache layers
- `/deployment-caching` — why this is in-function PPR, not a CDN shell
- Design doc: `docs/design/ppr-shell-resume.md` in the router repository (not
  shipped in the npm package)
