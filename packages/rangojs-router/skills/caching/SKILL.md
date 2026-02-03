---
name: caching
description: Configure segment caching with memory or Cloudflare KV stores in @rangojs/router
argument-hint: [setup]
---

# Caching

@rangojs/router supports segment-level caching with stale-while-revalidate (SWR) for optimal performance.

## Router Cache Configuration

Configure caching in `createRSCRouter`:

```typescript
import { createRSCRouter } from "@rangojs/router/server";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";

const store = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 300 }
});

const router = createRSCRouter<AppEnv>({
  document: Document,
  cache: {
    store,
    enabled: true,
  },
});
```

### Dynamic Cache Configuration

Use a factory function for environment-based config:

```typescript
const router = createRSCRouter<AppEnv>({
  document: Document,
  cache: (env) => ({
    store: new CFCacheStore({
      baseUrl: env.Bindings.CACHE_URL,
      waitUntil: (fn) => env.ctx.waitUntil(fn),
    }),
    enabled: env.Bindings.CACHE_ENABLED === "true",
  }),
});
```

## Cache Stores

### Memory Store (Development)

```typescript
import { MemorySegmentCacheStore } from "@rangojs/router/cache";

const store = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 300 }
});

// Debug cache stats
console.log(store.getStats());
```

Features:
- Survives HMR in development
- No true SWR (entries expire at TTL)
- Good for development and single-instance deployments

### Cloudflare Cache Store (Production)

```typescript
import { CFCacheStore } from "@rangojs/router/cache/cf";

const store = new CFCacheStore({
  namespace: "rsc-cache",              // Optional, uses caches.default
  baseUrl: "https://cache.example.com/",
  defaults: { ttl: 3600, swr: 7200 },
  waitUntil: (fn) => ctx.waitUntil(fn),
  version: "1.0.0",                    // For cache invalidation on deploy
});
```

Features:
- Cloudflare Cache API integration
- True SWR with atomic revalidation (prevents thundering herd)
- Non-blocking writes via `waitUntil`
- Version-based cache invalidation

## Cache Options

```typescript
interface CacheOptions {
  // Time-to-live in seconds
  ttl: number;

  // Stale-while-revalidate window (seconds after TTL)
  swr?: number;

  // Override cache store for this boundary
  store?: SegmentCacheStore;

  // Conditional caching
  condition?: (ctx) => boolean;

  // Custom cache key
  key?: (ctx) => string | Promise<string>;

  // Tags for invalidation
  tags?: string[] | ((ctx) => string[]);
}
```

## Route-Level Caching

Use `cache()` in handlers to set cache boundaries:

```typescript
import { map } from "@rangojs/router/server";

export default map<typeof routes>(({ route, layout, cache }) => [
  // Cache entire layout and children
  cache({ ttl: 3600, swr: 7200 }, () => [
    layout(<StaticLayout />, () => [
      route("about", AboutPage),
      route("contact", ContactPage),
    ]),
  ]),

  // Different cache settings per route
  cache({ ttl: 60 }, () => [
    route("dashboard", DashboardPage),
  ]),

  // No caching (default)
  route("checkout", CheckoutPage),
]);
```

## Conditional Caching

Skip cache based on request context:

```typescript
cache({
  ttl: 3600,
  condition: (ctx) => {
    // Don't cache for authenticated users
    const hasAuth = ctx.request.headers.has("Authorization");
    return !hasAuth;
  },
}, () => [
  route("products", ProductList),
])
```

## Custom Cache Keys

Override the default cache key:

```typescript
cache({
  ttl: 3600,
  key: (ctx) => {
    // Include user segment in cache key
    const segment = ctx.request.headers.get("x-user-segment") || "default";
    return `${segment}:products:${ctx.params.category}`;
  },
}, () => [
  route("products.category", CategoryPage),
])
```

Store-level key modification:

```typescript
const store = new CFCacheStore({
  keyGenerator: (ctx, defaultKey) => {
    const region = ctx.request.cf?.colo || "unknown";
    return `${region}:${defaultKey}`;
  },
});
```

## Stale-While-Revalidate (SWR)

SWR serves stale content while fetching fresh data in the background:

```
Timeline:
├─ 0 to TTL ─────────┤ Fresh content served
├─ TTL to TTL+SWR ───┤ Stale content served, revalidation in background
├─ After TTL+SWR ────┤ Cache expired, new fetch required
```

```typescript
cache({
  ttl: 60,      // Fresh for 60 seconds
  swr: 300,     // Stale-but-usable for 5 more minutes
}, () => [
  route("feed", FeedPage),
])
```

## Multi-Store Setup

Use different stores for different data patterns:

```typescript
const hotStore = new MemorySegmentCacheStore({
  defaults: { ttl: 10 }
});

const coldStore = new CFCacheStore({
  defaults: { ttl: 3600, swr: 7200 }
});

export default map<typeof routes>(({ route, cache }) => [
  // Frequently changing data - short TTL, memory
  cache({ store: hotStore, ttl: 10 }, () => [
    route("dashboard", DashboardPage),
    route("notifications", NotificationsPage),
  ]),

  // Rarely changing data - long TTL, edge cache
  cache({ store: coldStore, ttl: 3600 }, () => [
    route("archive", ArchivePage),
    route("docs", DocsPage),
  ]),
]);
```

## Cache Invalidation

### Version-Based (Cloudflare)

```typescript
import packageJson from "./package.json";

const store = new CFCacheStore({
  version: packageJson.version,  // All cache invalidated on deploy
});
```

### Tag-Based (Future)

```typescript
cache({
  tags: (ctx) => [`product:${ctx.params.id}`, "products"],
}, () => [
  route("products.detail", ProductDetail),
])

// Invalidate by tag
await store.invalidateTag("products");
```

## Complete Production Example

```typescript
// router.tsx
import { createRSCRouter } from "@rangojs/router/server";
import { CFCacheStore } from "@rangojs/router/cache/cf";
import packageJson from "./package.json";

const router = createRSCRouter<AppEnv>({
  document: Document,
  cache: (env) => ({
    store: new CFCacheStore({
      baseUrl: "https://rsc-cache.internal/",
      defaults: { ttl: 300, swr: 3600 },
      waitUntil: (fn) => env.ctx.waitUntil(fn),
      version: packageJson.version,
    }),
    enabled: env.Bindings.NODE_ENV === "production",
  }),
});

// handlers/shop.tsx
export default map<typeof shopRoutes>(({ route, layout, cache }) => [
  // Static pages - aggressive caching
  cache({ ttl: 86400, swr: 604800 }, () => [
    route("shop.about", AboutPage),
    route("shop.terms", TermsPage),
  ]),

  // Product listing - moderate caching
  cache({ ttl: 300, swr: 3600 }, () => [
    route("shop.products", ProductList),
  ]),

  // Product detail - cache with product-specific key
  cache({
    ttl: 600,
    swr: 3600,
    key: (ctx) => `product:${ctx.params.slug}`,
  }, () => [
    route("shop.product", ProductDetail),
  ]),

  // User-specific pages - no caching
  route("shop.cart", CartPage),
  route("shop.checkout", CheckoutPage),
]);
```

## Cache Headers (Cloudflare)

CFCacheStore sets these headers for debugging:

- `x-edge-cache-status`: `HIT` or `REVALIDATING`
- `x-edge-cache-stale-at`: Timestamp when entry becomes stale

## What Gets Cached

- Route segments (components, layouts, loading states)
- Handle data (breadcrumbs, metadata)
- **Not cached by default**: Loader data (fetched fresh each request)

To cache loader results, use loader-level caching or external caching strategies.
