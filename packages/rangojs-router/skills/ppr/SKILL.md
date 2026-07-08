---
name: ppr
description: PPR shell caching — opt a page route in with the `ppr` path option; the router serves the cached HTML shell instantly and resumes the live holes. Use when a page should render instantly from a cached shell while specific parts stay live, or asking about partial prerendering in Rango.
argument-hint: "[setup]"
---

# PPR Shell Caching

Caches the rendered HTML **shell** of a page route (React `prerender` prelude
bytes plus `postponed` state) and, on a later request, flushes those bytes
before any render work happens, then resumes fizz for just the live holes. The
browser sees one ordinary streamed document; loaders stay fresh on every
request. This is the second render axis — the default axis-1 path is untouched,
and every ineligible request falls open to it.

Compare `/document-cache`, which freezes the WHOLE response including loader
output. Shell caching is for pages that mix a stable shell with live data: the
shell is shared per host+URL, the holes are per request.

## Not this skill if…

- You want the WHOLE response frozen, loader output included — see
  `/document-cache`.
- You want build-time Flight segment payloads from `Static()`/`Prerender()` —
  see `/prerender`. A `Prerender` page may also declare `ppr`; then producer B
  can bake the HTML shell at build time while loaders stay live.
- You are unsure which cache layer you need — start at `/cache-guide`.

## Setup: one path option, no PPR middleware to mount

PPR is a DOCUMENT-level property declared on the page route via the `ppr` path
option. Serving is **integral to the router** — there is nothing to mount. The
only prerequisite is an app-level `createRouter({ cache })` store that
implements the shell family (`getShell`/`putShell`): `MemorySegmentCacheStore`
(dev/tests), `CFCacheStore` (Cloudflare KV), or `VercelCacheStore` (runtime
cache). A ppr route on a store without the family stays on axis 1 with a
once-per-key warning.

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

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({ kv: env.CACHE_KV, ctx: ctx! }),
  }),
});
export default router;
```

That is ONE of two hole mechanisms — the loader one. Do not conclude PPR
requires a loader:

### The same opt-in with NO loader and NO loading() — promise holes

A route (or its layouts) whose live regions are pending promises under
`<Suspense>` PPRs with no `loader()` and no `loading()` anywhere. Hand the
un-awaited promise over as a prop; the consumer suspends under its OWN
boundary; the boundary postpones at capture and becomes the hole:

```typescript
// Handler: kick off the fetch, do NOT await it.
function ProductPage(ctx: HandlerContext) {
  const reviews = fetchReviews(ctx.params.id); // Promise<Review[]> — pending
  return (
    <main>
      <h1>Product {ctx.params.id}</h1> {/* shell — baked into the prelude */}
      <ReviewsSection promise={reviews} /> {/* hole — resumes per request */}
    </main>
  );
}
```

```tsx
// ReviewsSection.tsx — the consumer owns its Suspense boundary.
"use client";

import { Suspense, use } from "react";

function Inner({ promise }: { promise: Promise<Review[]> }) {
  return <ReviewList reviews={use(promise)} />;
}
export function ReviewsSection({ promise }: { promise: Promise<Review[]> }) {
  return (
    <Suspense fallback={<ReviewsSkeleton />}>
      <Inner promise={promise} />
    </Suspense>
  );
}
```

```typescript
path("/products/:id", ProductPage, { name: "product", ppr: true });
// No use() list at all: no loader, no loading, still a shell + live hole.
```

At capture the pending fetch cannot win the task-quantized quiet window, so
the boundary postpones — fallback in the frozen prelude, value resumed fresh
on every HIT. This is the PHYSICS class from the hole doctrine below, and it
is exactly how an existing Suspense-shaped tree (e.g. migrated from Next.js
PPR) works with zero restructuring. The e2e proof is
`e2e/test-app/src/components/ShellPhysicsValue.tsx` — a promise hole living in
a LAYOUT with no loader registration at all.

A route WITHOUT the `ppr` option is pure axis 1: no store read, no capture, no
logs, zero cost. `ppr` is per page route — declaring it on a layout is not
supported (subtree inheritance is a possible follow-up).

## Where PPR sits: the cache onion

Rango's caches layer like an onion — each ring stores a progressively more
"cooked" representation of the same page. From innermost (raw values) to
outermost (final bytes):

| Ring                    | Primitive                                | What is stored                                     | What stays live on a hit               |
| ----------------------- | ---------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| 1. Function values      | `"use cache"`                            | a function's return value                          | everything around the call             |
| 2. Loader values        | `loader(Fn, () => [cache({...})])`       | one loader's result (opt-in; loaders default live) | all other loaders, handlers, rendering |
| 3. Segments (Flight)    | `cache()` route / build-time `prerender` | serialized rendered segments + replayed handles    | loaders, HTML render                   |
| 4. **HTML shell (PPR)** | `ppr` path option                        | rendered prelude bytes + React postponed state     | the holes, hydration payload           |
| 5. Whole response       | `/document-cache`                        | final response bytes, headers included             | nothing — all-or-nothing               |

PPR is ORTHOGONAL to `cache()` (ring 3): a ppr route may be uncached (its
handlers run fresh on every serve and during capture), fully `cache()`d (its
segments replay), or mixed. One useful cache() property to know: the segment
codec **deep-settles promises at the ring-3 write**, so nothing inside a
`cache()` boundary can stay live — that is a cache() fact, not a ppr one.

Invalidation crosses rings: `updateTag()`/`revalidateTag()` reach segment,
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
   host+pathname+sorted search);
4. **HIT** — the composed response is committed immediately: the stored prelude
   bytes flush first, while segment resolution, the fresh Flight render (the
   full hydration payload — there is no Flight-side resume), and the fizz
   `resume` of just the holes run BEHIND them inside the response stream;
5. **MISS** — plain axis-1 serve, tagged `x-rango-shell: MISS`, plus a
   background capture (stampede-guarded, retry-in-place, exponential backoff).

`x-rango-shell: HIT | MISS` is the observability header. Because the commit
point is after the chain, an unauthorized request NEVER sees shell bytes — put
auth middleware anywhere (global or route DSL) and it guards PPR for free.

### Opting out per request with `ctx.dynamic()`

Middleware and handlers can call `ctx.dynamic()` to force this request back to
axis 1. In middleware it runs before the PPR commit point, so the router skips
shell lookup, HIT serving, and MISS capture for that request. In handlers it is
too late to prevent a MISS render from already happening, but it still prevents
the follow-up shell capture.

During `Prerender` + `ppr` build-shell capture, middleware is replayed with
`ctx.build === true`, `ctx.waitUntil()` inert, and the same `ctx.dynamic()`
opt-out. Use that for routes where the shell depends on runtime-only auth,
cookies, or side-effectful SDK calls. A skipped build shell can still be owned
later by runtime capture when runtime middleware does not call `ctx.dynamic()`.

## Verifying it works

The header exists on DOCUMENT responses only. A bare `curl` gets the HTML
document (Flight is explicit-opt-in via `Accept: text/x-component`), so it
sees the header directly; only an explicit Flight request shape lacks it:

```
curl -s -D - -o /dev/null https://app.example.com/products/1 | grep -i x-rango-shell
```

- First document GET: `MISS`, plus a background capture.
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
  per-request nonce) serves plain axis 1 with NO header and warns once per
  key — no header + a declared `ppr` means look for that warning.
- On Cloudflare, `CFCacheStore` WITHOUT a KV namespace has an inert shell
  family (the shell tier is KV-only): every ppr route stays `MISS` forever.
  The store warns once per isolate — bind KV
  (`new CFCacheStore({ ctx, kv: env.CACHE_KV })`) or use another store.
- Structured capture diagnostics: `createRouter({ debugShellCapture: true })`
  logs one line per capture attempt/skip (outcome, durations, prelude and
  snapshot bytes, backoff state); pass a function to receive each
  `ShellCaptureDebugEvent` instead. In dev, with `debugPerformance` on, the
  last capture outcome for a key also rides the next document GET's
  `Server-Timing` as `ppr-capture;desc="…"`.

## The hole doctrine (encode this in your head)

Holes are **render-defined**, decided by the shape of the tree, on three rules:

| Class          | What makes the hole                                                                                                                                                                | At capture                                                                             | At serve                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| **STRUCTURAL** | the ENTIRE segment subtree under a `loading()` registration — the loader LIVE lane                                                                                                 | loaders masked; the LoaderBoundary postpones; the fallback bakes in as route structure | loaders run fresh; resume fills it |
| **PHYSICS**    | any promise NESTED in handed-over data still pending at capture, under the consumer's own `<Suspense>` — handler props, handle containers (`push({ x: promise })`), loader-carried | real I/O cannot win the task-quantized quiet window; the boundary postpones            | the promise settles and streams in |
| **SHELL**      | awaited handler data, TOP-LEVEL `push(promise)` (awaited before SSR), resolved promises, replayed `cache()` segments, BAKE-lane loader containers                                  | baked into the prelude                                                                 | served from the frozen prelude     |

ONE rule for promises, every lane — handlers, handles, AND loaders: **a promise
nested inside your data is never baked; the container settles.** A loader
without `loading()` is the BAKE lane (see below): its settled container is
shell material, exactly like awaited handler data and top-level handle pushes.

**`loading()` is NOT the gate for holes — it is the LANE SELECTOR for loader
data.** A pending promise under any plain `<Suspense>` postpones and is a hole
at whatever level it suspends — the PHYSICS row needs no `loading()` anywhere
(the e2e fixture's physics and nested-handle holes sit in a layout with none).
A route without a loader PPRs on pure promise/Suspense holes. For loaders,
`loading()` picks the lane: present = the GUARANTEED live lane (masked at
capture, fresh every serve, immune to fast resolution); absent = the bake lane
(the container is shell material, nested promises stay live).

The three promise positions, side by side:

```typescript
async function Handler(ctx: HandlerContext) {
  const push = ctx.use(MyHandle);

  push(fetchBadge());                    // TOP-LEVEL push: awaited pre-SSR → BAKED
  push({ label: "x", stat: fetchStat() }); // NESTED in container → container baked,
                                           //   stat streams → HOLE (consumer Suspends it)

  const data = await fetchHeader(ctx);   // awaited by the handler → BAKED

  return (
    <section>
      <Header data={data} />                       {/* shell */}
      <StatsPanel promise={fetchStats(ctx)} />     {/* un-awaited prop + own
                                                       <Suspense> + use() → HOLE */}
    </section>
  );
}
```

### Choosing the hole mechanism

| Your live region is…                            | Use                                                               | Why                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| loader data, must be fresh EVERY serve          | `loader()` + `loading()` (the live lane)                          | the guaranteed structural hole — masked at capture, fresh every serve, immune to fast resolution |
| loader data, shell container + live parts       | bake-lane loader (no `loading()`): `{ static, dynamic: promise }` | container bakes (snapshot-pinned per shell); nested promises hole at the consumer's `<Suspense>` |
| handler-fetched real I/O (db, fetch)            | un-awaited promise prop + consumer `<Suspense>` + `use()`         | no loader needed; real latency postpones by physics                                              |
| per-segment metadata consumed elsewhere         | handle container with a NESTED promise + consumer `<Suspense>`    | container is shell, nested value streams — "nesting = liveness"                                  |
| already-resolved / instant / synchronous values | `loader(() => Promise.resolve(x))` + `loading()`                  | a raw promise that settles inside the quiet window BAKES; only the live lane guarantees live     |
| none of the above                               | nothing                                                           | it bakes — that is what the shell is for                                                         |

The physics caveat in one line: HANDLER-created promise props are holes only
because the I/O is genuinely pending at capture — if the value can resolve
near-instantly (memory read, warmed cache), it may bake into the shell; when
liveness must be guaranteed rather than probable, use a loader. BAKE-LANE
NESTED promises are exempt from that race: the capture MASKS every thenable
nested in a bake-lane container regardless of settle timing
(`maskNestedContainerThenables`, loader-cache.ts), so the consuming boundary
always postpones as a hole and every HIT streams the FRESH value — the
promise SHAPE is the liveness declaration, not a bet on latency. (Before the
mask, a nested promise that settled inside the window pinned its capture-time
value into the shared shell; found live as a storefront basket — with the
capturing session's identifiers — served to anonymous visitors.)

### Handles: "nesting = liveness"

- `ctx.use(H)(promise)` — a TOP-LEVEL pushed promise is awaited server-side
  before SSR (`resolvedHandleStream`) and BAKED into the shell. The capture
  gate is held open for the same await, so real latency here is safe (bounded
  by the capture's 5s guard).
- `ctx.use(H)({ x: promise })` — the container passes through verbatim
  (resolution is shallow); the nested promise streams to the consumer, who must
  `<Suspense>` it. Under capture that boundary postpones — a hole — REGARDLESS
  of settle timing: the capture masks nested thenables in pushed handle
  containers (the capture store's push wrap, shell-capture.ts), so even an
  already-resolved nested promise holes instead of baking its value into the
  shared shell. Same shape-is-the-declaration rule as bake-lane loaders.

### Want a hole for already-resolved data?

Put it in a loader: `loader(() => Promise.resolve(x))` + `loading()`. Loaders
are always the live lane — masked at capture, fresh on every serve — no matter
how fast the value settles.

### The bake lane: loaders without loading() on THEIR entry

A loader on an entry with no renderable `loading()` EXECUTES during capture
(the capture gate holds open for its real latency, bounded by the 5s guard).
Its settled container bakes into the prelude; every promise nested in it is
masked at capture (regardless of how fast it settles) and postpones at the
consumer's own `<Suspense>` — a hole. On every HIT the
capture snapshot's loader family overlays the recorded container onto the
fresh run, so the payload matches the frozen prelude byte-for-byte while the
nested promises run fresh. The return shape is the declaration:

```typescript
export const StorefrontContextLoader = createLoader(async (ctx) => {
  const config = await loadSiteConfig(ctx.params.locale); // bakes (pinned per shell)
  return {
    config, // shell material
    basket: fetchBasket(ctx), // hole — consumer <Suspense>s it, fresh per request
  };
});
```

The lane is decided PER TREE NODE, at the entry that REGISTERS the loaders —
`loading()` on a CHILD route does not change a parent layout's lane, and
`loading()` IS valid on layout and parallel entries, not just routes.

Four hard edges (each e2e/unit-pinned):

- **Header writes throw (issue #713).** ppr is a document-scoped `cache()`:
  in any cached scenario ONLY MIDDLEWARE writes response headers. A handler
  or loader on a ppr route calling `ctx.headers.set()`, `cookies().set()`,
  `ctx.header()`, `ctx.setTheme()`, or `setStatus()` throws on EVERY render —
  dev and prod,
  first render, same guard family as the `cache()` boundary guard. Handlers
  are replayed on HITs (the write would silently differ between MISS and
  HIT); loaders are live but settle AFTER the response headers flushed with
  the shell (dead letters). Move the write into route middleware — it runs
  on every request, including HITs, and its headers/cookies merge into every
  response.
- **Identity refuses.** `cookies()`/`headers()` inside a bake-lane loader
  throws during capture and the capture REFUSES (deterministic, once-per-key
  warned) — identity can never bake into the shared shell. Give that loader's
  entry `loading()` (the live lane is exempt) or move the identity-dependent
  part into a nested promise. The guard's scope is EXACTLY those two calls:
  per-user state read from a middleware-provided object (`ctx.get("session")`)
  does NOT refuse — it bakes silently as the capturing user's data (see
  Pitfalls: the session-object bake trap).
- **A rejecting bake-lane loader refuses.** Error UI never bakes.
- **Baked containers show CAPTURE-time data** for the shell's lifetime on
  document GETs (client navigations stay fresh — axis 1). That IS the bake
  lane's meaning; if a value must be fresh on every serve, it belongs on the
  live lane (`loading()`) or in a nested promise.

### The layout-with-loaders playbook (the storefront case)

The most common real-app shape: an app-wide layout registers per-user loaders
(session context, basket, wishlist) and the page under it declares `ppr`.
Those loaders are on the BAKE lane (no `loading()` on the layout), so the page
captures and HITs — the question is which parts of their data should bake vs
stay live. Your levers, in order of preference:

1. **Shape the return value.** Shared/config data returns as plain values
   (bakes, pinned per shell); per-request data returns as NESTED promises
   consumed under the widget's own `<Suspense>` (live holes). No `loading()`,
   no restructuring. One wall: a bake-lane loader that reads
   `cookies()`/`headers()` refuses the capture — identity belongs in a nested
   promise or on the live lane.
2. **Do NOT put `loading()` on the layout itself** — that flips the WHOLE
   layout to the live lane and the LoaderBoundary fallback wraps the layout's
   ENTIRE subtree: chrome (header, nav, footer) falls out of the shell into
   the skeleton. Technically PPR, practically pointless.
3. **Guaranteed-fresh widgets: a parallel slot with its OWN `loading()`.**
   Parallel-owned loaders get their own per-slot boundary (`fresh.ts` tags
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

   Slot-owned loaders are masked at capture and GUARANTEED fresh per serve —
   use this where the bake lane's physics (a fast resolve bakes) or pinning
   (capture-time data for the shell's lifetime) is not acceptable, at the cost
   of a widget-sized fallback in the shell. The slot handler must hand the
   loader to a CLIENT component (`useLoader` in a `"use client"` component)
   for the freshness guarantee to reach the rendered value: server-side
   `await ctx.use(...)` in the handler is the BAKED lane (the consumption-lane
   rule, `/rango` → Invariants) — it executes at capture with identity reads
   permitted, but the value it renders is a capture-time copy wherever it is
   not shielded by the slot's masked LoaderBoundary.

4. **Shared layout data can also leave the loader lane entirely**: an
   un-awaited handler promise under the consumer's `<Suspense>` (a physics
   hole) or `cache()`/`"use cache"` to bake it with tag-invalidation.

The identity rule, stated once: per-user data on a PPR page lives in a NESTED
promise (a hole, fresh per request) or behind `loading()` with CLIENT-side
consumption (the live lane). Reading `cookies()`/`headers()` where the value
would bake as SEGMENT material — handler/render code or a bake-lane loader
container — refuses the capture by construction. The one exemption is
handler-INVOKED loader bodies (`await ctx.use(loader)`): they execute at
capture with identity reads permitted, and the value bakes as a shared
capture-time copy — mirroring `cache()` semantics (the consumption-lane
rule; semantic-matrix row PPR3).

## Execution matrix

| Phase            | MISS (foreground)      | Background capture                                                 | HIT (foreground)                                            |
| ---------------- | ---------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| Middleware chain | runs (full)            | **NOT re-run** — inherits the request's post-middleware context    | runs (full) — commit point is after it                      |
| `router.match`   | runs                   | re-runs under a derived context                                    | runs (behind the flushed prelude)                           |
| Handlers         | run                    | run on UNCACHED segments; `cache()`d segments replay (mixed-chain) | run (same mixed-chain rules as any render)                  |
| Loaders          | run **fresh**          | LIVE lane (`loading()`): MASKED; BAKE lane: execute + snapshot-pin | run **fresh** (bake containers overlaid from the snapshot)  |
| Flight render    | full                   | full                                                               | full (hydration needs the whole payload — no Flight resume) |
| HTML production  | full fizz              | `prerender` + abort → prelude + postponed                          | `resume` only the holes — O(paths to holes)                 |
| Shell store      | schedules a bg capture | `putShell(key, …)`                                                 | `getShell(key)`; a stale/SWR hit also schedules a recapture |
| Prelude bytes    | —                      | —                                                                  | flushed FIRST, before segment resolution starts             |

Middleware is not re-run during capture because it already ran for the
triggering request — the capture's derived context inherits the
post-middleware state (`ctx` variables included, which is what makes
middleware-derived shell content photograph correctly). Guarding is
serve-time: the commit point runs the full chain on EVERY serve.

Because handlers on uncached segments EXECUTE during capture — and BAKE-lane
loaders now do too — the `cookies()`/`headers()` capture guard is load-bearing:
those reads THROW during a capture render (`assertNotInsideShellCapture`), so
identity can never leak into a shared shell through them. Live-lane loaders
(behind `loading()`) are exempt: masked at capture, they never run there.

## allReady: the SEO/bot story

`ssr: { resolveStreaming: ... }` returning `"allReady"` (e.g. for bot user
agents) bypasses PPR entirely — the request gets one complete, fully-buffered
axis-1 document. Crawlers that dislike streamed shells get a finished page;
regular users get the streamed shell. No configuration interaction: allReady
wins.

## Security

Shell caching shares one shell per host+URL across all users:

**(a) Access control is sound by construction.** The commit point is after ALL
middleware on every serve. A 401/redirect short-circuit returns before any
shell byte.

**(b) Identity can't leak via cookies/headers.** `cookies()` and `headers()`
THROW during the background capture render — in handlers AND in bake-lane
loaders (whose containers would bake). A shell that reads them is
PPR-ineligible by construction; the live lane (`loading()`) stays exempt.

**(c) Residual hazard — middleware-derived per-user state.** A `ctx` variable
set by an upstream auth middleware and rendered by shell material is
photographed into the SHARED shell (the capture inherits post-middleware
state). That is scope fidelity working as designed — for shared values. The
same hazard reaches BAKE-LANE LOADERS: a loader reading a middleware-provided
session object (`ctx.get("session")`) never calls `cookies()` itself, so the
guard cannot see it — whatever it returns as settled container data is
photographed as the CAPTURING user's state. If the
value is per-user: shell-cache only public/shared pages, keep per-user content
in nested pending promises or live-lane (`loading()`) loaders — NOT in a
bake-lane container — or key per variant at the CDN tier.

## What always stays on axis 1

Non-GET, RSC/partial/action/loader fetches, per-request CSP nonce,
`streamMode: "allReady"`, redirects, 404s, error renders, routes without `ppr`,
and any store without the shell family. A stored shell is invalidated when
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
serves pure axis 1 with no `x-rango-shell` header. An undeclared route stays
silent.

### The proper way to supply a nonce

`createRouter({ nonce })` is the canonical path — supply the nonce THERE, not
via a token write. The provider value is threaded into the router's own SSR
machinery: `NonceContext`/`useNonce()`, automatic nonce attributes on
`<Scripts />` and `<MetaTags />` output, and the inlined Flight payload
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

| Field              | Default | Notes                                                                                                                                                     |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttl`              | `300`   | shell freshness window in seconds (`ppr: true` uses the default)                                                                                          |
| `swr`              | —       | stale window: serve the stale shell + background recapture                                                                                                |
| `tags`             | —       | operational tags UNIONED with the tags the capture render auto-collects — see "Invalidation" below                                                        |
| `maxSnapshotBytes` | 8 MiB   | cap on the entry's capture data snapshot; over it the snapshot is skipped (shell still stored, warned once per key) so the entry stays under store limits |

The shell store is always the app-level `createRouter({ cache })` store; the
default key is `${host}${pathname}${sortedSearch}:shell` (host-scoped so
multi-tenant shells never collide).

## Invalidation: tags vs revalidate()

`updateTag()`/`revalidateTag()` is the ONLY lever that changes the frozen shell
HTML; `revalidate()` is a DATA lever that never touches it.

A captured shell auto-carries the UNION of the non-loader tags recorded during
the capture render — every `cacheTag(...)` that ran as shell material, whether
from a `"use cache"` function, a `cache()` segment, or a render-callable
`cacheTag()` in a plain server component (no `"use cache"`/`cache()` in its
tree). Loader tags never attach (the holes are already live). `ppr.tags` adds
operational tags the render cannot know (a tenant id, a deploy marker).

| Lever                                         | Reaches the frozen shell?                                     | Reaches the holes?                                  |
| --------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| `updateTag` / `revalidateTag` on a SHELL tag  | YES — drops the shell → MISS → recapture                      | n/a (holes are already live)                        |
| `updateTag` / `revalidateTag` on a LOADER tag | no — loader tags never attach to a shell                      | drops that loader's cached value (if it `cache()`s) |
| `revalidate()` (named revalidation contract)  | **no** — re-runs segments/loaders for the PAYLOAD, never HTML | yes — the hole re-renders with fresh data           |

A server action's automatic invalidation refreshes the CLIENT only — it re-runs
the holes and streams a fresh payload, but does NOT evict the server shell.
Shell-baked data stays stale until the shell's TTL unless you tag-invalidate it
(`updateTag` on a shell tag). Data baked into the shell WITHOUT a tag cannot be
evicted by tag at all — move always-fresh data under a `loading()` hole.

## Pitfalls

- **A bake-lane loader that reads `cookies()`/`headers()`**: the capture is
  REFUSED (deterministic, once-per-key warned) — the route stays on axis 1.
  Move identity into a nested promise or behind `loading()`.
- **A bake-lane container that must be fresh per document GET**: it is
  snapshot-pinned for the shell's lifetime by design. Use the live lane
  (`loading()`) or a nested promise instead.
- **A bake-lane loader slower than the capture guard (~5s)**: the capture
  cannot hold for it — eternal MISS with the once-per-key warning.
- **Per-user value in shell material**: baked into the shared shell —
  deterministically, not by race (handler promises deep-settle at the ring-3
  write on cached chains; awaited/resolved values bake everywhere). Put
  per-user data in a nested pending promise or a live-lane (`loading()`)
  loader — a BAKE-lane loader container bakes just like handler material.
- **The session-object bake trap (the guard cannot save you here)**: the
  capture guard sees `cookies()`/`headers()` calls ONLY. A bake-lane loader
  reading a middleware-provided session object (`ctx.get("session")`) refuses
  nothing. Per-user data survives ONLY behind a nested promise — the shape is
  the declaration, and it holds for BOTH branches regardless of settle timing
  (nested thenables are masked at capture):

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
  (even an already-resolved one) or put the loader on the live lane.

- **Theme on a HIT is capture-then-corrected**: the resume tree replays the
  CAPTURE's `initialTheme` (resume requires it to match the frozen prelude);
  the visitor's cookie theme is applied pre-paint by the FOUC script and
  re-synced post-mount by ThemeProvider. Nothing to configure — but a themed
  component in the shell may briefly render the captured theme's markup before
  the post-mount re-sync.
- **Shell shows CAPTURE-time data for the shell's lifetime**: a `cache()`/`"use
cache"` value baked into the shell is PINNED at capture (the capture data
  snapshot) and replayed on every HIT, so the shell stays byte-identical to the
  frozen prelude even after that cache entry expires, gets recomputed, or is
  tag-invalidated. This is deliberate — parity beats freshness inside the shell.
  If a shell region needs to be fresh, put it under a hole — `loading()` for
  loader data, or an un-awaited promise under the consumer's `<Suspense>`
  (holes are never pinned) — or make the SHELL itself invalidatable by tagging
  it: call `cacheTag(...)` from the shell-material render code (the render-time
  lever), or add the tag to `ppr.tags` (operational tags the render cannot know —
  a tenant id, a deploy marker). Ring-1/ring-3 tag invalidation does NOT drop the
  shell.
- **Uncached nondeterminism in the shell is a hydration hazard**: a raw
  `Date.now()` / `Math.random()` / uncached `fetch` rendered directly in shell
  material (outside any cache ring) drifts between capture and hit and the
  snapshot CANNOT pin it — it was never a cache read. It will mismatch the frozen
  prelude and detonate hydration. Wrap it in `cache()`/`"use cache"` (then it is
  pinned) or move it under a hole (`loading()`, or a pending-promise
  `<Suspense>` region).
- **Stacking with `/document-cache`**: pick one per route — the document cache
  would cache the composite.
- **Dev + HMR**: works, but edits produce stale shells until TTL/recapture.
- **Dev cold-start cadence**: expect `MISS -> (in-place retry) -> HIT`. A
  refused capture is negatively cached with an exponential window (1s doubling
  to a 60s cap), so declaring `ppr` on an ineligible route never re-renders it
  on every request.
- **HIT status is committed at the flush**: a failing hole cannot become a
  500/redirect after the first shell byte — error UI renders inline via
  Suspense/error boundaries (the same property any streamed SSR page has after
  its shell flushes).

## Related

- `/defer-hydration` — keep the full body HTML in the shell while moving a
  heavy subtree's hydration off the initial main-thread task (gated boundary,
  content-as-fallback)
- `/document-cache` — whole-response edge caching (no live holes)
- `/caching` and `/cache-guide` — segment/function caching (axis 1 data)
- `/shell-manifest` — replayed handles as cache metadata read by live loaders
- Design doc: `docs/design/ppr-shell-resume.md` in the package
