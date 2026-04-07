---
name: caching
description: Configure segment caching, tag-based invalidation, and cache stores in @rangojs/router
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

## Tag-Based Invalidation

Tag cache entries for on-demand invalidation with `cacheTag()` and `revalidateTag()`.

### Runtime Tags with "use cache"

```typescript
import { cacheTag } from "@rangojs/router";

async function getProduct(ctx) {
  "use cache";
  cacheTag(`product:${ctx.params.id}`, "products");
  return db.getProduct(ctx.params.id);
}
```

### Static Tags with cache() DSL

```typescript
cache({ ttl: 600, tags: ["products"] }, () => [
  path("/products", ProductList, { name: "products" }),
  path("/products/:id", ProductDetail, { name: "productDetail" }),
]);
```

Tags can also be a function of the request context:

```typescript
cache({ ttl: 600, tags: (ctx) => [`tenant:${ctx.params.tenantId}`] }, () => [
  path("/:tenantId/dashboard", Dashboard, { name: "dashboard" }),
]);
```

### Invalidating Tags

Call `revalidateTag()` from server actions after mutations:

```typescript
"use server";
import { revalidateTag } from "@rangojs/router";

export async function updateProduct(formData: FormData) {
  const id = formData.get("id") as string;
  await db.updateProduct(id, formData);
  revalidateTag(`product:${id}`); // invalidate this product
  revalidateTag("products");       // invalidate the list
}
```

`revalidateTag()` invalidates across the app-level store and any explicit
per-scope stores from `cache({ store })`. Runs via `waitUntil()` so it
does not block the response.

### Tag Validation

- Tags must not contain commas (breaks Cloudflare `Cache-Tag` header format)
- Empty and whitespace-only tags are silently dropped
- In dev, comma tags throw; in production they are silently skipped

### Cloudflare Distributed Invalidation

For multi-colo invalidation, configure a `CFTagInvalidationStore` backed by KV:

```typescript
import { CFCacheStore, CFKVTagInvalidationStore } from "@rangojs/router/cache";

const tagStore = new CFKVTagInvalidationStore(env.CACHE_TAGS_KV);

const store = new CFCacheStore({
  ctx,
  tagInvalidationStore: tagStore,
  defaults: { ttl: 60, swr: 300 },
});
```

Tagged entries store a `taggedAt` timestamp. On read, if any tag was invalidated
after `taggedAt`, the entry is treated as a miss. This provides lazy global
invalidation without requiring immediate key enumeration.

## Context Variables Inside Cache Boundaries

Context variables (`createVar`) are cacheable by default and can be read and
written inside `cache()` scopes. Variables marked with `{ cache: false }` (at
the var level or write level) throw when read inside a cache scope. Response
side effects (`ctx.header()`, `ctx.cookie()`) always throw inside cache
boundaries. See `/cache-guide` for the full cache safety table.

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
