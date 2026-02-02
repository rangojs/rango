---
name: document-cache
description: Cache full HTTP responses at the edge with Cache-Control headers
argument-hint: [setup]
---

# Document Cache

Caches complete HTTP responses (HTML/RSC) at the edge based on Cache-Control headers. Routes opt-in by setting `s-maxage`.

## Setup

Add middleware to router:

```typescript
import { createRSCRouter, createDocumentCacheMiddleware } from "@rangojs/router/server";
import { CFCacheStore } from "@rangojs/router/cache/cf";

const router = createRSCRouter<AppEnv>({
  document: Document,
  cache: (env) => ({
    store: new CFCacheStore({ ctx: env.ctx }),
  }),
})
  .use(createDocumentCacheMiddleware())
  .routes(routes);
```

## Route Opt-In

Routes opt-in by setting `Cache-Control` with `s-maxage`:

```typescript
route("home", (ctx) => {
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  return <HomePage />;
});
```

## Middleware Options

```typescript
createDocumentCacheMiddleware({
  // Skip specific paths
  skipPaths: ["/api", "/admin"],

  // Custom cache key
  keyGenerator: (url) => url.pathname,

  // Conditional caching
  isEnabled: (ctx) => !ctx.request.headers.has("x-preview"),

  // Debug logging
  debug: true,
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
   Yes → Return   Has s-maxage?
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
- Only 200 OK responses with `s-maxage`

## What's NOT Cached

- Server actions (`_rsc_action`)
- Loader requests (`_rsc_loader`)
- Responses without `s-maxage`
- Non-200 responses

## Complete Example

```typescript
// router.tsx
const router = createRSCRouter<AppEnv>({
  document: Document,
  cache: (env) => ({
    store: new CFCacheStore({ ctx: env.ctx }),
  }),
})
  .use(createDocumentCacheMiddleware({
    skipPaths: ["/api"],
    debug: process.env.NODE_ENV === "development",
  }))
  .routes(routes);

// handlers.tsx
route("blog", (ctx) => {
  // Cache for 5 min, serve stale for 1 hour while revalidating
  ctx.headers.set("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
  return <BlogIndex />;
});

route("blog.post", (ctx) => {
  // Long cache for individual posts
  ctx.headers.set("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  return <BlogPost slug={ctx.params.slug} />;
});

route("dashboard", (ctx) => {
  // No cache header = not cached
  return <Dashboard />;
});
```

## Document Cache vs Segment Cache

| Feature | Document Cache | Segment Cache |
|---------|---------------|---------------|
| Granularity | Full response | Individual segments |
| Opt-in | `s-maxage` header | `cache()` DSL |
| Use case | Static pages | Dynamic compositions |
| Key includes | URL + segment hash | Route params |

Use document cache for mostly-static pages. Use segment cache when different parts of a page have different cache requirements.
