---
name: caching
description: Configure route/segment-subtree caching with memory, Cloudflare KV, or Vercel cache stores in @rangojs/router. Use when responses should be cached or revalidated, data is stale or not updating after code changes, or you are wiring up a cache store.
argument-hint: "[setup]"
---

# Caching

@rangojs/router supports segment-level caching with stale-while-revalidate (SWR) for optimal performance.

> SWR support is store-specific. `CFCacheStore` revalidates segment, response,
> and `"use cache"` entries in the background. `MemorySegmentCacheStore`
> supports SWR for response and `"use cache"` item entries, but its
> route-segment entries expire at TTL with no background revalidation — use
> `CFCacheStore` for real segment SWR. See `/cache-guide`.

## Not this skill if…

- You want to cache ONE function or component's return value — that is
  `"use cache"`: see `/use-cache`.
- You want the whole HTTP response frozen at the edge, loader output included —
  see `/document-cache`.
- You want the HTML shell cached while loaders stay live per request — see
  `/ppr`.
- You are unsure which cache layer you need — start at `/cache-guide`.

## cache() is Partial Prerendering (PPR)

`cache()` caches **everything except loaders**. On a cache hit, the cached
segments (layouts, route components, parallels — including any resolved
Suspense) are served from the store, and **loaders re-run fresh on every
request**, streaming their results into the same response. Loaders are the
dynamic "holes" of an otherwise-cached tree.

This means a `cache()` boundary at the document root **is** whole-document
Partial Prerendering: the static shell is cached and served instantly while
per-request/per-user data stays live — in one streamed response, no extra round
trip. The browser cannot tell the shell came from cache.

```typescript
cache({ ttl: 60, swr: 300 }, () => [
  layout(<RootLayout />), // cached shell
  path("/dashboard", Dashboard, { name: "dashboard" }, () => [
    loader(StatsLoader), // DYNAMIC HOLE — re-runs every request
  ]),
]);
```

The consumer rule: **want it cached? render it inline. want it dynamic? put it
in a loader and read it with `useLoader()` in a client component.** Anything
read with `cookies()`, `headers()`, or a non-cacheable variable belongs in a
loader (loaders always run fresh). Reading it directly in a cached handler
throws; awaiting it with `ctx.use()` and rendering the result in a cached
handler silently bakes per-request data into the shared shell (see "Cache purity
& tainted objects" below).

Pre-rendering (`/prerender`) is the build-time twin: it caches the same shell at
build time instead of on first request. Both feed the segment system
identically, and loaders always run fresh at request time.

## Route-Level Caching with cache()

Use the `cache()` DSL function to cache routes:

```typescript
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, cache }) => [
  // Cache these routes for 60 seconds, SWR for 5 minutes
  cache({ ttl: 60, swr: 300 }, () => [
    path("/blog", BlogIndex, { name: "blog" }),
    path("/blog/:slug", BlogPost, { name: "blogPost" }),
  ]),

  // Uncached routes
  path("/account", AccountPage, { name: "account" }),
]);
```

## Cache Options

```typescript
cache(
  {
    ttl: 60, // Time-to-live in seconds (default: 60)
    swr: 300, // Stale-while-revalidate window (default: 300)
  },
  () => [
    // Cached routes
  ],
);
```

## When cache() does not pay

A cache hit is not free: it still runs middleware, the store read, and the
document render AROUND the cached segment. The win is proportional to what
the cached render itself costs — measured on a deployed Cloudflare worker
(2026-07), a trivial page inside `cache()` served hits at p50 36 ms while
misses (render + store) served at 35 ms: indistinguishable. The same
boundary around an expensive render (slow data, big trees) is where the TTL
pays for itself.

Rule of thumb: reach for `cache()` when the segment's own render cost is
meaningfully above your latency floor — expensive render-embedded data work,
large component trees, third-party calls captured in the render. Do not wrap cheap
pages "just in case": you add store traffic and invalidation surface for no
latency win. If the data is what's expensive and it changes per-request,
prefer a loader with `cache()` on the loader DATA (see "Loader-Level
Caching") over caching the rendered segment.

## Tag-Based Invalidation

Tag cached entries, then invalidate them on demand. Tags can be attached three ways:

```typescript
// 1. Static tags in the cache() DSL
cache({ ttl: 300, tags: ["products"] }, () => [path("/products", List)]);

// 2. Dynamic tags (function of ctx)
cache(
  { ttl: 300, tags: (ctx) => [`product:${ctx.params.id}`, "products"] },
  () => [path("/products/:id", Detail)],
);

// 3. Runtime tags inside a "use cache" function
async function getProduct(id: string) {
  "use cache";
  cacheTag(`product:${id}`, "products"); // variadic, additive
  return db.getProduct(id);
}
```

Invalidate with one of two server-only verbs (both variadic, imported from
`@rangojs/router`):

```typescript
// Server Action — read-your-own-writes. Await it so the action's own re-render
// (and the next navigation) sees fresh data.
async function updateProduct(formData: FormData) {
  "use server";
  await db.updateProduct(formData);
  await updateTag("products");
}

// Route handler / webhook — background, non-blocking (waitUntil). Hard-purge:
// the next read re-renders fresh (NOT stale-while-revalidate).
export async function POST() {
  "use server";
  revalidateTag("products");
  return new Response("ok");
}
```

| API                      | Timing                      | Use in                    | Semantics                                             |
| ------------------------ | --------------------------- | ------------------------- | ----------------------------------------------------- |
| `updateTag(...tags)`     | awaitable (`Promise<void>`) | server actions            | immediate; next read is fresh                         |
| `revalidateTag(...tags)` | background (`void`)         | route handlers / webhooks | background (non-blocking); next read re-renders fresh |

Both built-in stores support tags. For `CFCacheStore`, distributed (cross-colo)
invalidation requires a `kv` namespace — the tag-invalidation markers live in
that same namespace; there is **no** separate tag-invalidation store to wire.
If no tag-capable store is configured, `updateTag`/`revalidateTag` warn and no-op.

By default `CFCacheStore` reads the KV marker on every tagged cache read
(strongest invalidation latency). To cut KV reads on hot tagged routes, set
`tagCacheTtl` (seconds) to cache each marker in the per-colo edge cache for that
window — the colo running `updateTag`/`revalidateTag` writes the fresh marker
into its own edge cache immediately (read-your-own-writes), while other colos
converge within `tagCacheTtl` (the **maximum extra cross-colo invalidation
latency** when no purge is wired). Keep it small (e.g. 30–60), or wire a purge
(below) and set it large. (Contrast `tagInvalidationTtl`, which must be _large_
— it bounds how long the KV marker itself lives and must exceed your max entry
TTL+SWR.)

To make other colos prompt without a short `tagCacheTtl`, pass `onRevalidateTag`:
each cached marker carries a namespaced Cloudflare `Cache-Tag`, and the hook is
handed exactly those tags (batched, once per `updateTag`/`revalidateTag` call) to
feed Cloudflare's purge-by-tag API — evicting the cached lookups everywhere.
Purge-by-tag is available on all plans (since April 2025), subject to per-plan
rate limits, so the batched single call matters. With a purge wired, `tagCacheTtl`
becomes a pure read-cost reducer + fallback window.

## Named Cache Profiles

Define named profiles in `createRouter({ cacheProfiles })` so the same TTL/SWR
values can be shared across the DSL and `"use cache"` functions without repetition.
Unknown names throw at boot time.

```typescript
// Define profiles in router
createRouter({
  cacheProfiles: {
    default: { ttl: 900, swr: 1800 },
    short: { ttl: 60, swr: 120 },
    long: { ttl: 3600, swr: 7200 },
  },
});
```

In the DSL, pass the profile's options directly to `cache()`:

```typescript
export const urlpatterns = urls(({ path, cache }) => [
  cache({ ttl: 3600, swr: 7200 }, () => [
    path("/blog", BlogIndex, { name: "blog" }),
  ]),

  // Orphan cache boundary (covers subsequent siblings)
  cache({ ttl: 60, swr: 120 }),
  path("/feed", FeedPage, { name: "feed" }),
]);
```

The DSL `cache()` helper does NOT accept a string profile name — strings are only
valid in the `"use cache: <name>"` directive inside server functions. See
`/use-cache` for function-level caching with named profiles.

## Loader-Level Caching

Cache individual loaders:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  // Cache this loader's results
  loader(ProductLoader, () => [cache({ ttl: 300 })]),

  // This loader is not cached
  loader(CartLoader),
]);
```

## Global Cache Configuration

Configure a cache store in the router:

```typescript
import { createRouter } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";

const store = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 300 },
});

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  cache: {
    store,
    enabled: true,
  },
});
```

## Cache Stores

### Memory Store

For single-instance deployments:

```typescript
import { MemorySegmentCacheStore } from "@rangojs/router/cache";

const store = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 300 },
  maxEntries: 1000, // per-family FIFO cap (default 1000)
});
```

Each internal family (segments, responses, `"use cache"` items, PPR shells) is
capped at `maxEntries`; on insert past the cap the oldest entry is evicted FIFO
and its tag-index entries are cleaned up, so a long-lived process cannot grow
without bound. TTL expiry stays lazy on top of the cap.

### Cloudflare Edge Cache Store

For distributed caching on Cloudflare Workers using the Cache API:

```typescript
import { CFCacheStore } from "@rangojs/router/cache";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      ctx,
      defaults: { ttl: 60, swr: 300 },
    }),
    enabled: true,
  }),
});
```

### With KV L2 Persistence

Add a KV namespace for global cross-colo persistence. On Cache API miss, KV is
checked and hits are promoted back to L1. Writes go to both layers.

```typescript
import { CFCacheStore } from "@rangojs/router/cache";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      ctx,
      kv: env.CACHE_KV, // optional KV namespace binding
      defaults: { ttl: 60, swr: 300 },
    }),
    enabled: true,
  }),
});
```

**How the two layers work:**

| Scenario     | L1 (Cache API) | L2 (KV) | Result                        |
| ------------ | -------------- | ------- | ----------------------------- |
| Hot request  | HIT            | —       | Serve from L1 (fast)          |
| Cold colo    | MISS           | HIT     | Serve from KV, promote to L1  |
| First render | MISS           | MISS    | Render, write to both L1 + KV |

KV entries require `expirationTtl >= 60s`. Short-lived entries (< 60s total TTL)
are only cached in L1.

### Resilience & latency budgets

Every cache read is **fail-safe**: a degraded tier never stalls or fails the
request — it degrades to the next tier (L1 → L2 → render). Three optional latency
budgets (milliseconds) bound each tier so a slow colo or KV namespace cannot pin
a request behind it:

| Option                | Default | Bounds                              |
| --------------------- | ------- | ----------------------------------- |
| `edgeLookupTimeoutMs` | `10`    | L1 `cache.match` (the lookup)       |
| `edgeReadTimeoutMs`   | `20`    | L1 body read (CF streams it lazily) |
| `kvReadTimeoutMs`     | `170`   | L2 / KV read                        |

Set any to `0` (or a negative value) to disable that budget and always await the
read. A non-finite value (e.g. `Number(env.UNSET)`) falls back to the default.
The tag-invalidation marker reads inherit these same budgets and **fail open** on
a KV timeout — the entry is served rather than wrongly treated as invalidated.

```typescript
new CFCacheStore({
  ctx,
  kv: env.CACHE_KV,
  defaults: { ttl: 60, swr: 300 },
  // Raise a budget only if your HEALTHY reads legitimately run slower (large
  // Flight payloads, far-from-colo regions); measure the p99 first. These are
  // degradation guard-rails, not tuning levers for "slow is normal here".
  kvReadTimeoutMs: 250,
});
```

Failure handling, by kind — none of these fail the request:

| Failure                         | Behavior                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transient read error (5xx/blip) | Degrade to the next tier; entry left intact                                                                                                       |
| Read budget exceeded (timeout)  | Abandon the read, degrade to the next tier                                                                                                        |
| Corrupt / unparseable L1 entry  | Reported corrupt; degrade to L2 (served if present). The L1 entry is evicted ONLY when L2 has no copy — so the evict can't race the L2→L1 promote |
| Corrupt / unparseable KV entry  | Reported corrupt; evicted (self-heal) + render (no tier below it)                                                                                 |
| Write failure                   | No-op (entry simply not cached); never throws                                                                                                     |

Each is surfaced to the router's `onError` callback (phase `"cache"`, with
`metadata.category` one of `cache-read`, `cache-corrupt`, `cache-write`,
`cache-delete`, `cache-invalidate`, `stale-revalidation`) so you can observe
cache health without affecting users.

### Validating cache behavior with `debug`

Pass `debug` to emit one structured event per L1 read — use it to confirm on a
real deployment (via `wrangler tail`) that the store behaves as expected before
relying on it. It is intended for validation, not steady-state production.

```typescript
new CFCacheStore({
  ctx,
  kv: env.CACHE_KV,
  debug: true, // logs each CFCacheReadDebugEvent to the console
  // ...or capture programmatically:
  // debug: (event) => myTelemetry.record(event),
});
```

Each event reports which tier answered and why (`outcome`: `l1-fresh`,
`l1-stale-revalidate`, `l1-revalidating-guarded`, `match-timeout`, `match-error`,
`body-timeout`, `body-error`, `non-200`, `tag-invalidated`, `l1-miss`, `kv-fresh`,
`kv-stale`, `kv-stale-suppressed`, `kv-miss`, `kv-timeout`, `error`), the
staleness / revalidating timestamps, and the measured per-tier durations:
`matchMs` (the L1 `match`), `markerMs` (the tag-marker resolution tail for a
tagged entry, between `matchMs` and `bodyReadMs`; absent or 0 for an untagged
entry or a per-request memo hit), and `bodyReadMs` (the L1 body read). A
persistently large `markerMs` signals a degraded KV namespace; on a healthy
deployment KV keeps markers hot in its per-colo edge cache, so it stays a few
milliseconds. `match-error` (a transient `cache.match` rejection that falls
through to L2) is kept distinct from a plain `l1-miss`.

## Cache purity & tainted objects

A `cache()` boundary caches everything except loaders, so anything read inside a
cached handler is **frozen into the shared cache entry** and served to every
subsequent visitor. To stop one user's request-scoped data from leaking to
another, request-scoped APIs are guarded inside a cache scope:

| Inside a `cache()` boundary                                     | Behavior                                            |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `cookies()` / `headers()` (read or write)                       | **throws** — request-scoped, would poison the entry |
| `ctx.header()` / `setCookie()` / `setStatus()` / `onResponse()` | **throws** — response side effects lost on a hit    |
| `ctx.get(var)` where the var is `{ cache: false }`              | **throws** on read                                  |
| `ctx.set(var, value)` for a cacheable var                       | allowed (children are cached too)                   |
| Any of the above **inside a loader**                            | **allowed** — loaders always run fresh              |

**Tainted objects.** Request-scoped objects (`ctx`, `env`, `request`) carry an
internal taint symbol so they are excluded from `"use cache"` cache keys, and
the cache scope is tracked via async-local state. Two flags back the guards:
`INSIDE_CACHE_EXEC` (set while a `"use cache"` function runs) and the `cache()`
DSL scope (`isInsideCacheScope()`). `isInsideCacheScope()` deliberately returns
`false` inside loaders — which is exactly why loaders are the dynamic holes:
they may read `cookies()`/`headers()` and re-run on every request.

The fix for "I need request data in a cached route": register a `loader()` and
**consume it with `useLoader()` in a client component**. The loader is the
dynamic hole — its data rides the fresh (never-cached) loader segment and is
rendered in the client component, so it never lands in the cached shell.

This is NOT the same as awaiting the loader in the handler. A cached handler
that does `await ctx.use(Loader)` and renders the result bakes that per-request
data straight into the shared cached segment — the loader running "fresh" does
not help, because its output was inlined into the cached parent, and `ctx.use()`
is **not** guarded. `ctx.use()` is a server-side escape hatch for non-rendered
uses (set a ctx var, make a routing decision); never render its result inside a
cached handler.

This is the **consumption-lane rule**, and it holds identically for every
shared artifact — `cache()`, `"use cache"`, and the PPR shell (`/ppr`):
handler consumption = baked copy with identity reads permitted; client-side
`useLoader` = live. Stated once in `/rango` → Invariants; pinned by
semantic-matrix row PPR3 and the `e2e/cache.test.ts` "baked copy" case.

```typescript
// WRONG — throws: cookies() read directly in a cached handler
cache({ ttl: 60 }, () => [
  path("/me", () => <Profile id={cookies().get("uid")?.value} />),
]);

// ALSO WRONG (unguarded, but leaks) — the awaited loader data is rendered into
// the cached handler, so the user's data is frozen into the shared shell.
cache({ ttl: 60 }, () => [
  path(
    "/me",
    async (ctx) => {
      const { user } = await ctx.use(MeLoader); // runs fresh…
      return <Profile user={user} />; // …but inlined into the CACHED segment → leak
    },
    { name: "me" },
    () => [loader(MeLoader)],
  ),
]);

// RIGHT — consume the loader in a CLIENT component via useLoader(). The cached
// route segment holds only the <Profile/> reference; the user data rides the
// fresh loader segment and renders client-side.

// profile.tsx (client component)
"use client";
import { useLoader } from "@rangojs/router/client";

export function Profile() {
  const { user } = useLoader(MeLoader); // fresh per request; never cached
  return <span>{user.name}</span>;
}

// urls — register the loader; MeLoader reads cookies() inside the loader (allowed)
cache({ ttl: 60 }, () => [
  path("/me", () => <Profile />, { name: "me" }, () => [loader(MeLoader)]),
]);
```

See `/cache-guide` for the full decision guide and the `cache()` vs `"use cache"` comparison.

## Nested Cache Boundaries

Override cache settings for specific sections:

```typescript
// Global cache
cache({ ttl: 300 }, () => [
  path("/blog", BlogIndex, { name: "blog" }),

  // Override: shorter TTL for dynamic content
  cache({ ttl: 30 }, () => [
    path("/blog/:slug", BlogPost, { name: "blogPost" }),
  ]),
]);
```

## Custom Cache Store

Create a dedicated store for specific routes:

```typescript
const checkoutCache = new MemorySegmentCacheStore({
  defaults: { ttl: 10 },
});

// In urls
cache({ store: checkoutCache }, () => [
  path("/checkout", CheckoutPage, { name: "checkout" }),
]);
```

## Complete Example

```typescript
import { urls } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import * as CartActions from "./actions/cart";

// Custom store for checkout (short TTL)
const checkoutCache = new MemorySegmentCacheStore({
  defaults: { ttl: 10 },
});

export const urlpatterns = urls(({ path, layout, cache, loader, revalidate }) => [
  // Public routes with aggressive caching
  cache({ ttl: 300, swr: 600 }, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
  ]),

  // Blog routes with moderate caching
  cache({ ttl: 60, swr: 300 }, () => [
    layout(<BlogLayout />, () => [
      path("/blog", BlogIndex, { name: "blog" }),
      path("/blog/:slug", BlogPost, { name: "blogPost" }, () => [
        loader(BlogPostLoader, () => [cache()]),  // Use boundary cache settings
      ]),
    ]),
  ]),

  // Shop routes with per-loader caching
  layout(<ShopLayout />, () => [
    path("/shop/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader, () => [cache({ ttl: 120 })]),
      loader(CartLoader, () => [
        revalidate((ctx) => ctx.isAction(CartActions) || undefined),
      ]),
    ]),
  ]),

  // Checkout with custom cache store
  cache({ store: checkoutCache }, () => [
    path("/checkout", CheckoutPage, { name: "checkout" }),
  ]),

  // No cache for account pages
  path("/account", AccountPage, { name: "account" }),
]);
```
