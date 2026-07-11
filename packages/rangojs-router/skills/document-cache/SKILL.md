---
name: document-cache
description: Cache complete HTTP responses in Rango's configured app store with createDocumentCacheMiddleware, using Cache-Control s-maxage as policy. Use when reusing a whole HTML/RSC response, comparing the store-backed middleware with a platform CDN cache, or deciding whether full-response caching is safe.
argument-hint: [setup]
---

# Store-backed Document Cache

Caches complete HTTP responses (HTML/RSC) in the app-level cache store based on
`Cache-Control`. Routes opt in by setting `s-maxage`.

This middleware runs **inside** the worker/function. It is not itself a platform
CDN cache. With `CFCacheStore` the response family can use Cloudflare's edge/KV
tiers; with `VercelCacheStore` it uses Vercel Runtime Cache. The request still
reaches Rango before the middleware can return a store hit.

## Not this skill if…

- You want loaders to stay live while rendered segments are reused — document
  caching freezes the WHOLE response, loader output included; segment caching
  is `cache()`: see `/caching`.
- You want a cached HTML shell with per-request live holes — see `/ppr`.
- You are unsure which cache layer you need — start at `/cache-guide`.
- You mean a platform CDN that serves a complete response without invoking the
  app — see `/deployment-caching` first.

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

The deployment platform may independently interpret the same `s-maxage` header
and cache the completed response at its CDN. A CDN hit bypasses the function,
all Rango middleware, handlers, and loaders. Therefore these headers are safe
only when the **complete** response is public and identical for every request
sharing the cache key. The middleware's `skipPaths`, `isEnabled`, and
`keyGenerator` cannot protect a response once an outer CDN serves it.

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

This diagram starts after the request reaches the Rango middleware. A store hit
short-circuits the middleware's downstream pipeline; global middleware that
wraps it can still run. Route middleware, handlers, and loaders below it do not.
An external CDN hit is different: the function never runs at all.

## Cache Status Header

Response includes `x-document-cache-status`:

- `HIT` - Fresh cache hit
- `STALE` - Served stale, revalidating in background
- `MISS` - Cache miss, response was generated fresh

This header reports the Rango store-backed middleware, not the platform CDN. A
CDN may replay a previously cached status header, so use the platform's cache
header or logs to identify an actual CDN hit.

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

See `/deployment-caching` for the full in-function versus CDN execution matrix,
middleware implications, and the shared-response safety checklist.
