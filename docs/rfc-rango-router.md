# RFC: URL Patterns and Composable Routing for @rangojs/router

## Overview

This RFC proposes route definition refactoring inspired by Django's URL patterns for the new `@rangojs/router` package. The changes make URL patterns visible at route definition and enable composable route mounting. The existing helper functions (`layout`, `loader`, `revalidate`, etc.) remain unchanged.

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

### 2. `createRouter` - Single `.routes()` Call

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

**`.use()` still works for global middleware:**

```typescript
const router = createRouter<AppEnv>({
  document: Document,
  notFound: NotFoundPage,
})
  .use(loggerMiddleware)              // Global middleware
  .use("/api/*", rateLimitMiddleware) // Pattern-scoped middleware
  .routes(urlpatterns);               // Single .routes() call
```

**`.routes()` can only be called once.** Multiple route groups are composed via `include()`:

```typescript
export const urlpatterns = urls(({ include }) => [
  include("/blog", blogPatterns, { name: "blog" }),
  include("/shop", shopPatterns, { name: "shop" }),
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
path(pattern, component)
path(pattern, component, use)            // use is () => [...]
path(pattern, component, options)        // options is { name?, ... }
path(pattern, component, options, use)
```

Detection: if 3rd arg is function → `use`, if object → `options`.

| Param | Description |
|-------|-------------|
| `pattern` | URL pattern with Express-style params (`:param`, `:param?`, `:param(a\|b)`, `*`) |
| `component` | React component or handler function `(ctx) => ReactNode` |
| `options` | Optional: `{ name }` for route naming |
| `use` | Optional: callback returning helpers (`loader`, `loading`, `revalidate`, etc.) |

**Examples:**
```typescript
// Pattern and component only
path("/about", AboutPage)

// With use (3rd arg is function)
path("/:slug", PostPage, () => [
  loader(PostLoader),
])

// With options (3rd arg is object)
path("/:slug", PostPage, { name: "post" })

// With both options and use
path("/:slug", PostPage, { name: "post" }, () => [
  loader(PostLoader),
])
```

**Unnamed routes:**

Name is optional. Unnamed routes are accessed via path-based `href()`:

```typescript
// Unnamed route
path("/about", AboutPage)

// Access via path (type-safe)
href("/about")  // ✅ works

// Named route - both work
path("/blog", BlogPage, { name: "blog" })
href("blog")    // ✅ by name
href("/blog")   // ✅ by path
```

Path-based `href()` is an **existing type-safe feature** that must be maintained.

**URL patterns use existing Express-style syntax:**

| Pattern | Type |
|---------|------|
| `:param` | `string` |
| `:param?` | `string \| undefined` |
| `:param(a\|b)` | `"a" \| "b"` |
| `*` | `string` (catch-all) |

### 4. `include()` - Composable Route Mounting

Mount nested route patterns with optional name prefix:

```typescript
include(prefix, patterns, options?)
```

| Param | Description |
|-------|-------------|
| `prefix` | URL prefix for all routes |
| `patterns` | Nested route patterns to mount |
| `options` | Optional: `{ name }` for route name prefixing |

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

// urls/index.ts - mounts with name prefix
export const urlpatterns = urls(({ path, layout, include }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),

    // "index" becomes "blog.index", "post" becomes "blog.post"
    include("/blog", blogPatterns, { name: "blog" }),

    // Same patterns, different name prefix
    include("/news", blogPatterns, { name: "news" }),
  ]),
]);
```

**Name prefix is optional:**
```typescript
// Without name - routes keep local names
include("/blog", blogPatterns)

// With name - local names are prefixed (e.g., "index" → "blog.index")
include("/blog", blogPatterns, { name: "blog" })
```

**Name collisions:**
- TypeScript detects collisions at compile time
- At runtime, last definition wins (like Django) - no crash

```typescript
include("/blog", blogPatterns, { name: "content" })  // "content.index"
include("/news", newsPatterns, { name: "content" })  // overwrites "content.index"
// TypeScript error, but if it slips through, /news patterns win
```

**Route references are local within urlpatterns:**

All route name references (in `intercept()`, `href()`, etc.) are local to the pattern set:

```typescript
// urls/shop.ts - self-contained, doesn't know its name prefix
export const shopPatterns = urls(({ path, layout, intercept }) => [
  layout(ShopLayout, () => [
    // "product" refers to the local route below
    intercept("@modal", "product", ProductModal),

    path("/", ShopIndex, { name: "index" }),
    path("/product/:id", ProductDetail, { name: "product" }),  // ← local "product"
  ]),
]);

// urls/index.ts
include("/shop", shopPatterns, { name: "shop" })
// Globally: "product" becomes "shop.product"
// But shopPatterns doesn't need to know that
```

**Enables shared layouts across route groups:**

```typescript
urls(({ layout, include }) => [
  // SharedLayout wraps BOTH blog and shop
  layout(SharedLayout, () => [
    include("/blog", blogPatterns, { name: "blog" }),
    include("/shop", shopPatterns, { name: "shop" }),
  ]),

  // Admin doesn't get SharedLayout
  include("/admin", adminPatterns, { name: "admin" }),
])
```

### 5. `useHref()` - Context-Aware Client Href

Client-side hook for resolving route names with current name prefix:

```typescript
"use client";
import { useHref } from "@rangojs/router/client";

function BlogNav() {
  const href = useHref();

  return (
    <>
      {/* Local names - resolved with current name prefix */}
      <Link href={href("index")}>Blog Home</Link>
      <Link href={href("post", { slug: "hello" })}>Post</Link>

      {/* Absolute names - explicit prefix */}
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
3. Local name (`index`) → Prepend current name prefix, then lookup

**Global vs Scoped href:**

| Method | Scope | Usage |
|--------|-------|-------|
| `router.href` | Global | Requires full name: `router.href("blog.index")` |
| `ctx.href` | Scoped (server) | Auto-prefixes: `ctx.href("index")` → "blog.index" |
| `useHref()` | Scoped (client) | Auto-prefixes: `href("index")` → "blog.index" |

`router.href` remains for cases where you need global access outside of a scoped context.

**Implementation:**

Route map and current name prefix passed via RSC payload:

```typescript
interface RscMetadata {
  // ... existing fields
  routeMap: Record<string, string>;  // "blog.index" → "/blog"
  routeName: string;                  // Current name prefix from matched route
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
import { createRouter } from "@rangojs/router/server";
import { urlpatterns } from "./urls";

export const router = createRouter<AppEnv>({
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

    include("/blog", blogPatterns, { name: "blog" }),
    include("/shop", shopPatterns, { name: "shop" }),
  ]),
]);
```

---

## Removed (compared to rsc-router)

`@rangojs/router` is a new package. The following are **not available**:

| Removed | Replacement |
|---------|-------------|
| `route({ "name": "/pattern" })` | `path("/pattern", Component, { name })` inside `urls()` |
| `.routes(prefix, routes).map(handler)` | `.routes(urlpatterns)` with `include()` for composition |
| Chained `.routes()` calls | Single `.routes()`, use `include()` for multiple groups |
| `import { href } from ".../client"` | `useHref()` hook (scoped) or `router.href` (global) |

**No backwards compatibility** - this is a clean break from rsc-router's API.

---

## Implementation Plan

### Phase 0: Package Setup

- Copy `rsc-router` package to `packages/rangojs-router`
- Update `package.json` to `@rangojs/router`
- Update internal imports
- Verify all existing tests pass

### Phase 1: `urls()` and `path()` Functions

- Add `urls()` as replacement for `map()`
- Add `path(pattern, component, options?, children?)`
- Compiles to existing internal `RouteEntry` structures
- URL pattern stored alongside route definition
- Type inference for params from pattern

### Phase 2: `include()` Function

- Add `include(prefix, patterns, options?)`
- Name prefixing for route names (`{ name: "blog" }` → "index" becomes "blog.index")
- TypeScript collision detection

### Phase 3: `useHref()` Hook

- Add `routeMap` and `routeName` to RSC payload
- Implement `useHref()` with name prefix context
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
| `include()` | Composable mounting with name prefix |
| `useHref()` | Context-aware client href |
| Type safety | Params inferred from URL pattern |

Everything else stays the same.
