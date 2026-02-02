# RFC: URL Patterns and Composable Routing for rsc-router

## Overview

This RFC proposes minimal changes to make URL patterns visible at route definition and enable composable route mounting. The existing helper functions (`layout`, `loader`, `revalidate`, etc.) remain unchanged.

## Motivation

The current API separates URL patterns from route definitions:

```typescript
// routes.ts - URL patterns defined here
export const blogRoutes = route({
  "blog.index": "/",
  "blog.post": "/:slug",
});

// handlers.tsx - handlers defined separately
export default map<typeof blogRoutes>(({ route, layout, loader }) => [
  layout(BlogLayout, () => [
    route("blog.index", IndexPage),
    route("blog.post", PostPage, () => [
      loader(PostLoader),
    ]),
  ]),
]);
```

**Pain points:**
1. URL patterns not visible where routes are defined
2. Route names defined separately from handlers
3. Hard to compose/share layouts across route groups

## Proposed Changes

### 1. `urls()` - Replaces `map()`

The `urls()` function replaces `map()` as the entry point for defining routes:

```typescript
// Current
export default map<typeof blogRoutes>(({ route, layout, loader }) => [
  layout(BlogLayout, () => [
    route("blog.index", IndexPage),
  ]),
]);

// New
export const blogPatterns = urls(({ path, layout, loader }) => [
  layout(BlogLayout, () => [
    path("/", IndexPage, { name: "index" }),
  ]),
]);
```

**Signature:**
```typescript
urls(callback: (helpers) => RouteDefinition[])
```

The callback receives all helpers: `path`, `layout`, `loader`, `loading`, `revalidate`, `cache`, `middleware`, `errorBoundary`, `notFoundBoundary`, `intercept`, `parallel`, `include`.

### 2. `createRSCRouter` - Single `.routes()` Call

The router now accepts a single `.routes(urlpatterns)` call instead of chained `.routes().map()`:

```typescript
// Current
router
  .routes("/blog", blogRoutes)
  .map(() => import("./handlers/blog.js"))
  .routes("/shop", shopRoutes)
  .map(() => import("./handlers/shop.js"));

// New
router.routes(urlpatterns);  // Single call, use include() for composition
```

**`.routes()` can only be called once.** Multiple route groups are composed via `include()`:

```typescript
export const urlpatterns = urls(({ include }) => [
  include("/blog", blogPatterns, { namespace: "blog" }),
  include("/shop", shopPatterns, { namespace: "shop" }),
]);
```

### 3. `path()` - URL Pattern at Definition Site

Replace `route()` with `path()` that includes the URL pattern:

```typescript
// Current
route("blog.post", PostPage, () => [
  loader(PostLoader),
])

// New
path("/:slug", PostPage, { name: "post" }, () => [
  loader(PostLoader),
])
```

**Signature:**
```typescript
path(pattern, component, options?, children?)
path(pattern, handler, options?, children?)
```

| Param | Description |
|-------|-------------|
| `pattern` | URL pattern with Express-style params (`:param`, `:param?`, `:param(a\|b)`, `*`) |
| `component` | React component or handler function `(ctx) => ReactNode` |
| `options` | Optional: `{ name }` for route naming |
| `children` | Optional: existing helpers (`loader`, `loading`, `revalidate`, etc.) |

**URL patterns use existing Express-style syntax:**

| Pattern | Type |
|---------|------|
| `:param` | `string` |
| `:param?` | `string \| undefined` |
| `:param(a\|b)` | `"a" \| "b"` |
| `*` | `string` (catch-all) |

### 4. `include()` - Composable Route Mounting

Mount nested route patterns with optional namespace:

```typescript
include(prefix, patterns, options?)
```

| Param | Description |
|-------|-------------|
| `prefix` | URL prefix for all routes |
| `patterns` | Nested route patterns to mount |
| `options` | Optional: `{ namespace }` or `{ name }` (aliases) |

**Example:**

```typescript
// urls/blog.ts - uses local names
export const blogPatterns = urls(({ path, layout, loader }) => [
  layout(BlogLayout, () => [
    path("/", IndexPage, { name: "index" }),
    path("/:slug", PostPage, { name: "post" }, () => [
      loader(PostLoader),
    ]),
  ]),
]);

// urls/index.ts - mounts with namespace
export const urlpatterns = urls(({ path, layout, include }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),

    // "index" becomes "blog.index", "post" becomes "blog.post"
    include("/blog", blogPatterns, { namespace: "blog" }),

    // Same patterns, different namespace
    include("/news", blogPatterns, { namespace: "news" }),
  ]),
]);
```

**Namespace is optional:**
```typescript
// Without namespace - routes keep local names
include("/blog", blogPatterns)

// With namespace - names are prefixed
include("/blog", blogPatterns, { namespace: "blog" })
```

**Enables shared layouts across route groups:**

```typescript
urls(({ layout, include }) => [
  // SharedLayout wraps BOTH blog and shop
  layout(SharedLayout, () => [
    include("/blog", blogPatterns, { namespace: "blog" }),
    include("/shop", shopPatterns, { namespace: "shop" }),
  ]),

  // Admin doesn't get SharedLayout
  include("/admin", adminPatterns, { namespace: "admin" }),
])
```

### 5. `useHref()` - Namespace-Aware Client Href

Client-side hook for resolving route names with namespace context:

```typescript
"use client";
import { useHref } from "@ivogt/rsc-router/client";

function BlogNav() {
  const href = useHref();

  return (
    <>
      {/* Local names - resolved with current namespace */}
      <Link href={href("index")}>Blog Home</Link>
      <Link href={href("post", { slug: "hello" })}>Post</Link>

      {/* Absolute names - explicit namespace */}
      <Link href={href("shop.cart")}>Cart</Link>

      {/* Path-based - always works */}
      <Link href={href("/about")}>About</Link>
    </>
  );
}
```

**Server components use `ctx.href()`:**

```typescript
async function BlogPost({ ctx }) {
  return (
    <>
      <Link href={ctx.href("index")}>Back</Link>
      <Link href={ctx.href("post", { slug: "next" })}>Next</Link>
    </>
  );
}
```

**Resolution priority:**
1. Path-based (`/blog/:slug`) → Use directly
2. Absolute name (`shop.cart`) → Global lookup
3. Local name (`index`) → Prepend current namespace, then lookup

**Implementation:**

Route map and namespace passed via RSC payload:

```typescript
interface RscMetadata {
  // ... existing fields
  routeMap: Record<string, string>;  // "blog.index" → "/blog"
  namespace: string;                  // Current namespace from matched route
}
```

### 6. Type Safety

Params are inferred from URL pattern at compile time:

```typescript
path("/product/:id", (ctx) => {
  ctx.params.id    // ✅ string
  ctx.params.slug  // ❌ TypeScript error
})

path("/:locale?/blog/:slug", (ctx) => {
  ctx.params.locale  // string | undefined
  ctx.params.slug    // string
})

path("/:locale(en|de)/shop", (ctx) => {
  ctx.params.locale  // "en" | "de"
})
```

`useHref()` and `ctx.href()` are typed from route definitions:

```typescript
const href = useHref();
href("post", { slug: "hello" })  // ✅ requires slug
href("post")                      // ❌ missing slug param
href("post", { id: 1 })           // ❌ wrong param name
```

---

## What Stays the Same

All existing helpers work exactly as they do now:

```typescript
path("/:slug", PostPage, { name: "post" }, () => [
  // All unchanged
  loader(PostLoader),
  loading(<PostSkeleton />),
  revalidate(({ actionId }) => actionId?.includes("Post")),
  cache({ ttl: 60 }),
  middleware(authMiddleware),
  errorBoundary(<PostError />),
  notFoundBoundary(<PostNotFound />),
])

layout(DashboardLayout, () => [
  // All unchanged
  loader(UserLoader),
  middleware([authMiddleware, logMiddleware]),

  path("/", DashboardHome, { name: "index" }),

  // Intercept unchanged
  intercept("@modal", "settings", SettingsModal, () => [
    loader(SettingsLoader),
  ]),
])

// Parallel routes unchanged
path("/", Dashboard, { name: "index" }, () => [
  parallel({
    "@sidebar": Sidebar,
    "@footer": Footer,
  }),
])
```

**Unchanged:**
- `layout()` - wrapping and composition
- `loader()` - data loading
- `loading()` - suspense fallbacks
- `revalidate()` - cache invalidation logic
- `cache()` - caching configuration
- `middleware()` - request middleware
- `errorBoundary()` - error handling
- `notFoundBoundary()` - not found handling
- `intercept()` - modal/overlay patterns
- `parallel()` - parallel routes
- Handler context (`ctx`) - all properties
- Segment rendering and caching internals

---

## Router Setup

```typescript
import { createRSCRouter } from "@ivogt/rsc-router/server";
import { urlpatterns } from "./urls";

export const router = createRSCRouter<AppEnv>({
  document: Document,
  notFound: NotFoundPage,
  defaultErrorBoundary: ErrorPage,
})
  .use(globalMiddleware)
  .routes(urlpatterns);  // Single .routes() call
```

**`.routes()` can only be called once.** Use `include()` for composition.

---

## Full Example

```typescript
// urls/blog.ts
export const blogPatterns = urls(({ path, layout, loader, loading }) => [
  layout(BlogLayout, () => [
    path("/", BlogIndex, { name: "index" }),
    path("/:slug", BlogPost, { name: "post" }, () => [
      loader(PostLoader),
      loading(<PostSkeleton />),
    ]),
  ]),
]);

// urls/shop.ts
export const shopPatterns = urls(({ path, layout, loader, intercept }) => [
  layout(ShopLayout, () => [
    loader(CartLoader),

    intercept("@modal", "product", ProductModal, () => [
      loader(ProductLoader),
    ]),

    path("/", ShopIndex, { name: "index" }),
    path("/product/:id", ProductDetail, { name: "product" }, () => [
      loader(ProductLoader),
    ]),
    path("/cart", Cart, { name: "cart" }),
  ]),
]);

// urls/index.ts
export const urlpatterns = urls(({ path, layout, include }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),

    include("/blog", blogPatterns, { namespace: "blog" }),
    include("/shop", shopPatterns, { namespace: "shop" }),
  ]),
]);
```

---

## Migration

The new API can coexist with the current API for gradual migration:

```typescript
// Current API still works
router
  .routes("/blog", blogRoutes)
  .map(() => import("./handlers/blog.js"));

// New API
router.routes(urlpatterns);
```

---

## Implementation Plan

### Phase 1: `path()` Function

- Add `path(pattern, component, options?, children?)`
- Compiles to existing internal `RouteEntry` structures
- URL pattern stored alongside route definition
- Type inference for params from pattern

### Phase 2: `include()` Function

- Add `include(prefix, patterns, options?)`
- Namespace prefixing for route names
- Collision detection at startup

### Phase 3: `useHref()` Hook

- Add `routeMap` and `namespace` to RSC payload
- Implement `useHref()` with namespace context
- Server `ctx.href()` uses same resolution logic

### Phase 4: Single `.routes()` Enforcement

- Error if `.routes()` called multiple times
- All composition via `include()`

---

## Summary

| Change | Purpose |
|--------|---------|
| `urls()` | Replaces `map()` as entry point |
| `.routes(urlpatterns)` | Single call, replaces `.routes().map()` chain |
| `path()` | URL pattern visible at route definition |
| `include()` | Composable mounting with namespace |
| `useHref()` | Namespace-aware client href |
| Type safety | Params inferred from URL pattern |

Everything else stays the same.
