---
name: document-cache
description: Cache full HTTP responses at the edge with Cache-Control headers
argument-hint: [setup]
---

# Document Cache

Caches complete HTTP responses (HTML/RSC) at the edge based on Cache-Control headers. Routes opt-in by setting `s-maxage`.

## Not this skill if…

- You want loaders to stay live while rendered segments are reused — document
  caching freezes the WHOLE response, loader output included; segment caching
  is `cache()`: see `/caching`.
- You want a cached HTML shell with per-request live holes — see `/ppr`.
- You are unsure which cache layer you need — start at `/cache-guide`.

## Setup

Document caching is a middleware. Add `createDocumentCacheMiddleware()` to the
router with `.use()`. The cache store it reads from is the app-level store you
configure on `createRouter({ cache })` (available on the request context as
`requestCtx._cacheStore`), not a store passed to the middleware.

```typescript
import { createRouter } from "@rangojs/router";
import {
  createDocumentCacheMiddleware,
  CFCacheStore,
} from "@rangojs/router/cache";
import { urlpatterns } from "./urls";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  // App-level cache store. The document cache middleware uses this store's
  // getResponse/putResponse methods.
  cache: (_env, ctx) => ({ store: new CFCacheStore({ ctx: ctx! }) }),
});

router.use(
  createDocumentCacheMiddleware({
    skipPaths: ["/api", "/admin"],
    debug: process.env.NODE_ENV === "development",
  }),
);

export default router;
```

## Route Opt-In with Cache-Control

Routes opt-in to document caching by setting a `Cache-Control` response header
with `s-maxage`. The middleware caches responses whose `Cache-Control` includes
`s-maxage`; `stale-while-revalidate` enables background revalidation (SWR).

```typescript
// Cache full page for 5 min, serve stale for 1 hour
function BlogIndexHandler(ctx) {
  ctx.headers.set("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
  return <BlogIndex />;
}

// Long cache for individual posts
function BlogPostHandler(ctx) {
  ctx.headers.set("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  return <BlogPost />;
}

// Dashboard sets no Cache-Control header, so it is never document-cached.
```

## Document Cache Options

`createDocumentCacheMiddleware(options?)` accepts:

```typescript
createDocumentCacheMiddleware({
  // Skip specific paths (matched by pathname prefix)
  skipPaths: ["/api", "/admin"],

  // Custom cache key generator
  keyGenerator: (url) => url.pathname,

  // Conditional caching, evaluated per request
  isEnabled: (ctx) => !ctx.request.headers.has("x-preview"),

  // Debug logging (HIT, MISS, STALE, REVALIDATED)
  debug: true,
});
```

The cache store is not a middleware option — it comes from the app-level
`createRouter({ cache })` store.

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
- Only 200 OK responses whose `Cache-Control` includes `s-maxage`

## What's NOT Cached

- Server actions (`_rsc_action`)
- Loader requests (`_rsc_loader`)
- Non-GET requests
- Responses without an `s-maxage` `Cache-Control` directive
- Non-200 responses

## Complete Example

```typescript
// router.tsx
import { createRouter } from "@rangojs/router";
import { createDocumentCacheMiddleware, CFCacheStore } from "@rangojs/router/cache";
import { urlpatterns } from "./urls";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (_env, ctx) => ({ store: new CFCacheStore({ ctx: ctx! }) }),
});

router.use(
  createDocumentCacheMiddleware({
    skipPaths: ["/api"],
    debug: process.env.NODE_ENV === "development",
  }),
);

export default router;

// urls.tsx
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout, loader }) => [
  // Blog pages opt into document caching via Cache-Control headers set in
  // their handlers (see BlogIndex / BlogPost below).
  layout(<BlogLayout />, () => [
    path("/blog", BlogIndex, { name: "blog" }),
    path("/blog/:slug", BlogPost, { name: "blogPost" }, () => [
      loader(BlogPostLoader),
    ]),
  ]),

  // Dashboard sets no Cache-Control header, so it is never document-cached.
  layout(<DashboardLayout />, () => [
    path("/dashboard", Dashboard, { name: "dashboard" }),
  ]),
]);

// Blog handlers set s-maxage to opt into the document cache.
function BlogIndex(ctx) {
  ctx.headers.set("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
  return <BlogIndexPage />;
}

function BlogPost(ctx) {
  ctx.headers.set("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
  return <BlogPostPage />;
}
```

## Document Cache vs Segment Cache

| Feature      | Document Cache             | Segment Cache         |
| ------------ | -------------------------- | --------------------- |
| Granularity  | Full response              | Individual segments   |
| Opt-in       | `Cache-Control` `s-maxage` | `cache({ ttl, swr })` |
| Use case     | Static pages               | Dynamic compositions  |
| Key includes | URL + segment hash         | Route params          |

Use document cache for mostly-static pages. Use segment cache when different parts of a page have different cache requirements.
