---
name: caching
description: Configure segment caching with memory or Cloudflare KV stores in @rangojs/router
argument-hint: [setup]
---

# Caching

@rangojs/router supports segment-level caching with stale-while-revalidate (SWR) for optimal performance.

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

## Named Profile Shorthand

Use a named cache profile string instead of an options object. The profile must be
defined in `createRouter({ cacheProfiles })`. Unknown names throw at boot time.

```typescript
// Define profiles in router
createRouter({
  cacheProfiles: {
    default: { ttl: 900, swr: 1800 },
    short: { ttl: 60, swr: 120 },
    long: { ttl: 3600, swr: 7200 },
  },
});

// Use by name in urls
export const urlpatterns = urls(({ path, cache }) => [
  cache("long", () => [path("/blog", BlogIndex, { name: "blog" })]),

  // Also works without children (orphan cache boundary)
  cache("short"),
  path("/feed", FeedPage, { name: "feed" }),
]);
```

These profile names are shared with the `"use cache: <name>"` directive. See
`/use-cache` for function-level caching.

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
  maxSize: 1000, // Max entries
});
```

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
        revalidate(({ actionId }) => actionId?.includes("Cart") || undefined),
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
