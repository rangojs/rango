---
name: document-cache
description: Cache full HTTP responses at the edge with Cache-Control headers
argument-hint: [setup]
---

# Document Cache

Caches complete HTTP responses (HTML/RSC) at the edge based on Cache-Control headers. Routes opt-in by setting `s-maxage`.

## Setup

Configure document cache in router:

```typescript
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache/cf";
import { urlpatterns } from "./urls";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  documentCache: (env, ctx) => ({
    store: new CFCacheStore({ ctx }),
    skipPaths: ["/api", "/admin"],
    debug: process.env.NODE_ENV === "development",
  }),
});

export default router;
```

## Route Opt-In with cache()

Routes opt-in to document caching using the `cache()` DSL with `documentCache` option:

```typescript
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, cache }) => [
  // Cache full page for 5 min, serve stale for 1 hour
  cache({ documentCache: { sMaxAge: 300, swr: 3600 } }, () => [
    path("/blog", BlogIndex, { name: "blog" }),
  ]),

  // Long cache for individual posts
  cache({ documentCache: { sMaxAge: 3600, swr: 86400 } }, () => [
    path("/blog/:slug", BlogPost, { name: "blogPost" }),
  ]),

  // No cache for dashboard (no documentCache option)
  path("/dashboard", Dashboard, { name: "dashboard" }),
]);
```

## Document Cache Options

```typescript
createRouter({
  // ...
  documentCache: (env, ctx) => ({
    // Cache store (required)
    store: new CFCacheStore({ ctx }),

    // Skip specific paths
    skipPaths: ["/api", "/admin"],

    // Custom cache key
    keyGenerator: (url) => url.pathname,

    // Conditional caching
    isEnabled: (ctx) => !ctx.request.headers.has("x-preview"),

    // Debug logging
    debug: true,
  }),
});
```

## How It Works

```
Request → Check Cache
           ↓
    ┌──────┴──────┐
    │             │
  HIT           MISS
    │             │
    ↓             ↓
  Fresh?      Run handler
    │             │
   Yes → Return   Has documentCache?
    │             │
   No (stale)    Yes → Cache + Return
    │             │
    ↓            No → Return (no cache)
  Return stale,
  revalidate in
  background (SWR)
```

## Cache Status Header

Response includes `x-document-cache-status`:

- `HIT` - Fresh cache hit
- `STALE` - Served stale, revalidating in background
- `MISS` - Cache miss, response was generated fresh

## Cache Key Generation

Default keys differentiate:

- HTML requests: `{pathname}:html`
- RSC partials: `{pathname}:{segmentHash}:rsc`

Segment hash ensures different cached responses for navigations from different source pages (with different layouts).

## What Gets Cached

- Full HTML responses (document requests)
- RSC payloads (client navigation)
- Only 200 OK responses with documentCache enabled

## What's NOT Cached

- Server actions (`_rsc_action`)
- Loader requests (`_rsc_loader`)
- Routes without `documentCache` option
- Non-200 responses

## Complete Example

```typescript
// router.tsx
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache/cf";
import { urlpatterns } from "./urls";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  documentCache: (env, ctx) => ({
    store: new CFCacheStore({ ctx }),
    skipPaths: ["/api"],
    debug: process.env.NODE_ENV === "development",
  }),
});

export default router;

// urls.tsx
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout, cache, loader }) => [
  // Blog with document caching
  cache({ documentCache: { sMaxAge: 300, swr: 3600 } }, () => [
    layout(<BlogLayout />, () => [
      path("/blog", BlogIndex, { name: "blog" }),
      path("/blog/:slug", BlogPost, { name: "blogPost" }, () => [
        loader(BlogPostLoader),
      ]),
    ]),
  ]),

  // Dashboard - no document cache (dynamic content)
  layout(<DashboardLayout />, () => [
    path("/dashboard", Dashboard, { name: "dashboard" }),
  ]),
]);
```

## Document Cache vs Segment Cache

| Feature      | Document Cache             | Segment Cache         |
| ------------ | -------------------------- | --------------------- |
| Granularity  | Full response              | Individual segments   |
| Opt-in       | `documentCache` in cache() | `cache({ ttl, swr })` |
| Use case     | Static pages               | Dynamic compositions  |
| Key includes | URL + segment hash         | Route params          |

Use document cache for mostly-static pages. Use segment cache when different parts of a page have different cache requirements.
