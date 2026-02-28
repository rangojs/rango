---
name: caching
description: Configure segment caching with memory or Cloudflare KV stores in @rangojs/router
argument-hint: [setup]
---

# Caching

@rangojs/router supports segment-level caching with stale-while-revalidate (SWR) for optimal performance.

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
import { MemorySegmentCacheStore } from "@rangojs/router/rsc";

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
import { MemorySegmentCacheStore } from "@rangojs/router/rsc";

const store = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 300 },
  maxSize: 1000, // Max entries
});
```

### Cloudflare KV Store

For distributed caching on Cloudflare Workers:

```typescript
import { CFCacheStore } from "@rangojs/router/cache/cf";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      kv: env.CACHE_KV,
      waitUntil: (fn) => ctx.waitUntil(fn),
    }),
    enabled: true,
  }),
});
```

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
import { MemorySegmentCacheStore } from "@rangojs/router/rsc";

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
        revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
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
