# RFC: Django-Style Routing DSL for rsc-router

## Overview

This RFC proposes an alternative routing DSL inspired by Django's URL patterns. The goal is to create a more declarative, readable routing configuration that co-locates route definitions with their handlers and options.

## Motivation

The current rsc-router API separates concerns across multiple files and uses method chaining:

```typescript
// routes.ts - route definitions
export const blogRoutes = route({
  "blog.index": "/",
  "blog.post": "/:slug",
});

// router.tsx - connect routes to handlers
router
  .routes("/blog", blogRoutes)
  .map(() => import("./handlers/blog.js"));

// handlers/blog.tsx - define handlers with nested config
export default map<typeof blogRoutes>(({ route, layout, loader, loading }) => [
  layout(<BlogLayout />, () => [
    route("blog.index", IndexRoute),
    route("blog.post", PostRoute, () => [
      loader(PostLoader),
      loading(<PostSkeleton />),
    ]),
  ]),
]);
```

**Pain points:**
1. Route names defined separately from handlers
2. Three files to trace for one route group
3. Nested callback syntax can be hard to follow
4. URL patterns not visible at router level
5. **Layouts cannot be shared across route groups** (see below)

## Composability Improvements

A key limitation of the current `.routes().map()` pattern is that **layouts are defined inside each handler**, making it difficult to share layouts across route groups.

### Current Limitation

```typescript
// router.tsx
router
  .routes("/blog", blogRoutes)
  .map(() => import("./handlers/blog.js"))  // BlogLayout defined inside

  .routes("/shop", shopRoutes)
  .map(() => import("./handlers/shop.js"))  // ShopLayout defined inside
```

If you want a shared layout across both blog AND shop, you must duplicate it:

```typescript
// handlers/blog.tsx
map(({ layout }) => [
  layout(SharedLayout, () => [     // ❌ Duplicated
    layout(BlogLayout, () => [...])
  ])
])

// handlers/shop.tsx
map(({ layout }) => [
  layout(SharedLayout, () => [     // ❌ Duplicated
    layout(ShopLayout, () => [...])
  ])
])
```

### Django-Style Solution

Layouts are defined **at the URL structure level**, enabling natural composition:

```typescript
urls(({ layout, include }) => [
  layout(SharedLayout, () => [
    // SharedLayout wraps BOTH blog and shop
    include("/blog", () => import("./blog")),
    include("/shop", () => import("./shop")),
  ]),

  // Admin doesn't get SharedLayout
  include("/admin", () => import("./admin")),
])
```

### Real-World Example: Marketing vs App Sections

```typescript
urls(({ layout, include }) => [
  // Marketing pages - public, different layout
  layout(MarketingLayout, () => [
    include("/", () => import("./marketing/home")),
    include("/pricing", () => import("./marketing/pricing")),
    include("/about", () => import("./marketing/about")),
  ]),

  // App pages - authenticated, shared app chrome
  layout(AppLayout, {
    middleware: authMiddleware,
    loader: UserLoader,
  }, () => [
    include("/dashboard", () => import("./app/dashboard")),
    include("/settings", () => import("./app/settings")),
    include("/projects", () => import("./app/projects")),
  ]),
])
```

This structure is **impossible** to express cleanly with the current API.

### What This Enables

| Pattern | Current API | Django-style |
|---------|-------------|--------------|
| Shared layout across route groups | Duplicate in each handler | Wrap includes with layout |
| Shared middleware across groups | Global only or duplicate | Wrap at any level |
| Shared loaders across groups | Hard to achieve | Attach at any level |
| Partial shared config | Very difficult | Natural nesting |
| Cross-cutting orphan layouts | Works but scattered | Explicit and visible |

---

## Proposed API

### Core Functions

| Function | Purpose | Django Equivalent |
|----------|---------|-------------------|
| `urls(callback)` | Create urlpatterns with helpers in scope | `urlpatterns = [...]` |
| `path(pattern, component, options)` | Define a route | `path(route, view, name=...)` |
| `include(prefix, loader)` | Lazy-load nested URL config | `include('app.urls')` |
| `layout(component, options?, children?)` | Wrap children with layout | Template inheritance |
| `cache(options, children)` | Cache boundary | `@cache_page()` |

> **Note:** Unlike Django's `reverse()`, rsc-router's client-side `href()` uses actual path patterns, not route names. See [Client/Server Architecture](#clientserver-architecture) below.

### The `urls()` Helper

Provides type-safe helpers in scope (similar to current `map()`):

```typescript
export const urlpatterns = urls(({ path, layout, include, cache, parallel }) => [
  // All helpers available without imports
  path("/", HomePage, { name: "home" }),

  layout(BlogLayout, () => [
    path("/blog", BlogIndex, { name: "blog.index" }),
  ]),
])
```

### Parameter Syntax

Django-style type converters:

| Pattern | Example | Type |
|---------|---------|------|
| `<str:name>` | `/users/<str:name>` | `string` |
| `<int:id>` | `/products/<int:id>` | `number` |
| `<slug:slug>` | `/blog/<slug:slug>` | `string` (validated) |
| `<uuid:id>` | `/items/<uuid:id>` | `string` (UUID) |
| `<path:rest>` | `/files/<path:rest>` | `string` (with slashes) |

**Alternative:** Keep current syntax (`:id`, `:slug?`, `:locale(en|de)`)

---

## Full Example

### Main URL Configuration

```typescript
// urls/index.ts
import { urls } from "@ivogt/rsc-router";
import { RootLayout } from "../layouts/RootLayout";
import { HomePage } from "../pages/home";
import { AboutPage } from "../pages/about";

export const urlpatterns = urls(({ path, layout, include }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),

    // Lazy-loaded nested URL configs
    include("/blog", () => import("./blog"), { name: "blog" }),
    include("/dashboard", () => import("./dashboard"), { name: "dashboard" }),
    include("/shop", () => import("./shop"), { name: "shop" }),
  ]),
]);
```

### Blog URLs (Simple)

```typescript
// urls/blog.ts
import { urls } from "@ivogt/rsc-router";
import { BlogLayout } from "../layouts/BlogLayout";
import { BlogIndex, BlogPost } from "../pages/blog";
import { BlogSidebar, BlogSidebarSkeleton } from "../components/blog";
import { BlogSidebarLoader } from "../loaders/blog";

export const urlpatterns = urls(({ path, layout }) => [
  layout(BlogLayout, {
    middleware: loggerMiddleware,
    cache: { ttl: 3600 },

    parallel: {
      "@sidebar": {
        component: BlogSidebar,
        loader: BlogSidebarLoader,
        loading: BlogSidebarSkeleton,
      },
    },
  }, () => [
    path("/", BlogIndex, { name: "index" }),

    path("/<slug:slug>", BlogPost, {
      name: "post",
      revalidate: postRevalidation,
    }),
  ]),
]);
```

### Dashboard URLs (With Parallel Routes)

```typescript
// urls/dashboard.ts
import { urls } from "@ivogt/rsc-router";
import { DashboardLayout } from "../layouts/DashboardLayout";
import { DashboardHome, DashboardSettings } from "../pages/dashboard";

export const urlpatterns = urls(({ path, layout }) => [
  layout(DashboardLayout, {
    middleware: [rateLimitMiddleware, analyticsMiddleware],
    revalidate: ({ currentUrl, nextUrl }) => currentUrl.search !== nextUrl.search,
  }, () => [
    path("/", DashboardHome, {
      name: "index",
      parallel: {
        "@sidebar": DashboardSidebar,
        "@footer": DashboardFooter,
      },
    }),

    path("/settings", DashboardSettings, {
      name: "settings",
    }),
  ]),
]);
```

### Shop URLs (Complex with Nested Includes)

```typescript
// urls/shop.ts
import { urls } from "@ivogt/rsc-router";
import { ShopLayout } from "../layouts/ShopLayout";
import { ShopIndex, ProductCategory, ProductDetail, Cart } from "../pages/shop";
import { UserLoader, CartLoader, CategoriesLoader } from "../loaders/shop";
import { loggerMiddleware, mockAuthMiddleware } from "../middleware/shop";

export const urlpatterns = urls(({ path, layout, cache, include }) => [
  cache({ ttl: 60 }, layout(ShopLayout, {
    middleware: [loggerMiddleware, mockAuthMiddleware],
    revalidate: globalRevalidation,

    // Global loaders for entire shop section
    loader: [
      UserLoader,
      { loader: CartLoader, revalidate: ({ actionId }) => actionId?.includes("Cart") },
      CategoriesLoader,
    ],

    parallel: {
      "@promoBanner": PromoBanner,
      "@notification": CartNotification,
    },

    // Intercept for modal
    intercept: {
      "@modal": {
        route: "products.detail",
        component: ProductModalContent,
        layout: ModalWrapper,
        when: ({ from }) => !from.pathname.startsWith("/shop/products/"),
      },
    },
  }, () => [
    path("/", ShopIndex, {
      name: "index",
      parallel: { "@sidebar": CategorySidebar },
    }),

    path("/products/<str:category>", ProductCategory, {
      name: "products.category",
    }),

    path("/product/<slug:slug>", ProductDetail, {
      name: "products.detail",
      loading: ProductDetailSkeleton,
      loader: [
        { loader: ProductLoader, cache: true },
        RelatedProductsLoader,
      ],
      parallel: { "@related": RelatedProducts },
    }),

    path("/cart", Cart, {
      name: "cart",
      loading: CartSkeleton,
      parallel: { "@summary": OrderSummary },
    }),

    // Nested URL configs with separate cache
    include("/checkout", () => import("./shop/checkout"), { name: "checkout" }),
    include("/account", () => import("./shop/account"), { name: "account" }),
  ])),
]);
```

### Checkout URLs (Separate Cache)

```typescript
// urls/shop/checkout.ts
import { urls } from "@ivogt/rsc-router";
import { CheckoutLayout } from "../../layouts/CheckoutLayout";
import { CheckoutIndex, CheckoutPayment, CheckoutConfirm } from "../../pages/checkout";
import { requireAuthMiddleware } from "../../middleware/shop";

export const urlpatterns = urls(({ path, layout, cache }) => [
  cache({ ttl: 10 }, layout(CheckoutLayout, {
    middleware: requireAuthMiddleware,
    loading: CheckoutSkeleton,
  }, () => [
    path("/", CheckoutIndex, {
      name: "index",
      parallel: { "@summary": () => <OrderSummary variant="checkout" /> },
    }),

    path("/payment", CheckoutPayment, {
      name: "payment",
    }),

    path("/confirm", CheckoutConfirm, {
      name: "confirm",
    }),
  ])),
]);
```

---

## Router Setup

The `createRSCRouter` API keeps the existing `.use()` chain for global middleware, with a single `.routes(urlpatterns)` call for route definitions. Composition happens via `include()` within the patterns.

```typescript
// router.ts
import { createRSCRouter } from "@ivogt/rsc-router/server";
import { createDocumentCacheMiddleware } from "@ivogt/rsc-router/cache";
import { urlpatterns } from "./urls";
import { Document } from "./document";
import { NotFound } from "./components/NotFound";
import { ErrorFallback } from "./components/ErrorFallback";
import type { AppEnv } from "./env";

export const router = createRSCRouter<AppEnv>({
  document: Document,
  notFound: ({ pathname }) => <NotFound pathname={pathname} />,
  defaultErrorBoundary: ({ error }) => <ErrorFallback error={error} />,
  theme: true,
})
  // Global middleware - applied to all routes
  .use(createDocumentCacheMiddleware())
  .use(loggerMiddleware)
  .use("/api/*", rateLimitMiddleware)  // Pattern-scoped global middleware

  // Single .routes() call with Django-style patterns
  // Composition happens via include() within urlpatterns
  .routes(urlpatterns);

export const href = router.href;
```

### Key Differences from Current API

| Aspect | Current API | Django-style |
|--------|-------------|--------------|
| Multiple route groups | Chain `.routes().map().routes().map()` | Single `.routes()`, use `include()` |
| Handler connection | `.map(() => import(...))` | Direct in `path()` |
| Scoped middleware | Between `.routes()` and `.map()` | In `layout()` or `path()` options |
| Global middleware | `.use()` before `.routes()` | Same - `.use()` before `.routes()` |

### Why Single `.routes()`?

With Django-style, handlers are embedded in patterns - no `.map()` needed. Multiple route groups are composed via `include()`:

```typescript
// urls/index.ts
export const urlpatterns = urls(({ path, layout, include }) => [
  // Global layout wraps everything
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),

    // Mount route groups via include
    include("/blog", blogPatterns),
    include("/shop", shopPatterns),
    include("/admin", adminPatterns),
  ]),
]);
```

This is more declarative than chaining - the URL structure is visible in one place.

---

## Client/Server Architecture

### Key Design Decision: No Route Manifest on Client

Unlike Django's `reverse()` which resolves route names to URLs at runtime, rsc-router deliberately keeps the route manifest **server-side only**.

**Why?**
- Smaller client bundle (no manifest to ship)
- Client components are decoupled from route naming
- Type safety comes from path patterns, not names

### Client-Side `href`

On the client, `href()` uses **actual path patterns** with type-safe parameters:

```typescript
// Client-side href - path-based, type-safe params
import { href } from "@ivogt/rsc-router/client";

href("/blog/:slug", { slug: "hello-world" })     // → "/blog/hello-world"
href("/products/:id", { id: 123 })               // → "/products/123"
href("/shop/checkout/payment")                   // → "/shop/checkout/payment"

// Type error if params don't match pattern
href("/blog/:slug", { id: 123 })                 // ❌ TypeScript error
```

### Server-Side Route Names

The `name` property in `path()` is purely for **server-side organization**:

```typescript
path("/blog/<slug:slug>", BlogPost, { name: "post" })
//                                         ↑ Server-only
```

**Used for:**
- Route matching and organization
- Server-side redirects
- Logging and debugging
- Internal server references
- Future: Named route resolution via redirect

**NOT used for:**
- Client-side `href()` calls
- Type generation for client

### Named Routes on Client via RSC Payload

rsc-router already passes metadata from server to client via the RSC payload (e.g., `themeConfig`, `initialTheme`). The same pattern can be used for route maps.

**Server includes route map in metadata:**

```typescript
// RscMetadata (existing pattern)
interface RscMetadata {
  pathname: string;
  segments: ResolvedSegment[];
  themeConfig?: ResolvedThemeConfig;
  initialTheme?: Theme;
  // NEW: Route map for client href
  routeMap?: Record<string, string>;  // name → pattern
}
```

**Server populates during SSR:**

```typescript
// During render, track used routes (or send all)
metadata.routeMap = {
  "blog:post": "/blog/:slug",
  "shop:product": "/shop/product/:id",
  // Only routes used in this render, or full map
};
```

**Client reads from payload:**

```typescript
// initBrowserApp already does this for theme
const routeMap = initialPayload.metadata?.routeMap ?? {};

// href checks for named route
function href(pathOrName, params) {
  const pattern = pathOrName.startsWith("/")
    ? pathOrName
    : routeMap[pathOrName];

  if (!pattern) {
    throw new Error(`Unknown route: ${pathOrName}`);
  }

  return interpolate(pattern, params);
}
```

**Benefits of this approach:**

| Benefit | Description |
|---------|-------------|
| Follows existing pattern | Same as `themeConfig` injection |
| No static bundle cost | Route map comes via RSC payload |
| Can be scoped | Only send routes used on page |
| Fresh per request | Routes can change without redeploy |
| Works with lazy includes | Server resolves all routes by SSR time |

**Client `href` supports both:**

```typescript
// Path-based (always works, no lookup needed)
href("/blog/:slug", { slug: "hello" })

// Named (looks up from injected routeMap)
href("blog:post", { slug: "hello" })
```

Both are type-safe; named routes resolve at runtime from the SSR-injected map.

### Global `href()` with Unique Names

Route names must be **globally unique** across the entire app. The `href()` function is a simple global lookup - no context needed.

```typescript
// urls/blog.ts - globally unique names
export const urlpatterns = urls(({ path }) => [
  path("/", BlogIndex, { name: "blog.index" }),
  path("/:slug", BlogPost, { name: "blog.post" }),
]);
```

```typescript
// components/BlogPost.tsx - uses global href
import { href } from "@ivogt/rsc-router/client";

function BlogPost({ nextSlug }) {
  return (
    <>
      <Link href={href("blog.index")}>Back to list</Link>
      <Link href={href("blog.post", { slug: nextSlug })}>Next Post</Link>

      {/* Path-based also works */}
      <Link href={href("/blog/:slug", { slug: nextSlug })}>Next Post</Link>
    </>
  );
}
```

**How it works:**

1. Server includes `routeMap` in RSC payload (all name → pattern mappings)
2. Client `href()` is a simple lookup: `routeMap[name]` → interpolate params
3. No context needed - names are globally unique

### Reusable Modules with Factory Pattern

For modules that need to be mounted multiple times, use a factory function:

```typescript
// urls/blog.ts - factory accepts name prefix
export const createBlogUrls = (prefix: string) => urls(({ path }) => [
  path("/", BlogIndex, { name: `${prefix}.index` }),
  path("/:slug", BlogPost, { name: `${prefix}.post` }),
]);

// Helper for components
export const createBlogHref = (prefix: string) => ({
  index: () => href(`${prefix}.index`),
  post: (params: { slug: string }) => href(`${prefix}.post`, params),
});
```

```typescript
// urls/index.ts - mount same module twice
import { createBlogUrls } from "./blog";

urls(({ include }) => [
  include("/blog", createBlogUrls("blog")),
  include("/news", createBlogUrls("news")),  // Same module, different prefix!
])
```

```typescript
// components/BlogPost.tsx - reusable with prefix
import { createBlogHref } from "../urls/blog";

function BlogPost({ namePrefix, nextSlug }) {
  const blogHref = createBlogHref(namePrefix);

  return (
    <>
      <Link href={blogHref.index()}>Back to list</Link>
      <Link href={blogHref.post({ slug: nextSlug })}>Next Post</Link>
    </>
  );
}

// Usage:
<BlogPost namePrefix="blog" nextSlug="hello" />  // → /blog/hello
<BlogPost namePrefix="news" nextSlug="hello" />  // → /news/hello
```

**Summary:**

| Use Case | Pattern |
|----------|---------|
| Single-use module | Hardcode names: `name: "blog.post"` |
| Reusable module | Factory: `createBlogUrls(prefix)` |
| Component in reusable module | Receive prefix via props or helper |

**Benefits:**
- Simple global `href()` - no context overhead
- Globally unique names - no conflicts
- Reusable when needed - factory pattern
- Path-based always works as fallback

### Route Name Collision Detection

Route names must be globally unique. The `urls()` helper must detect collisions at both **compile-time** (TypeScript) and **runtime** (startup error).

**Current rsc-router approach (compile-time):**

```typescript
// Type-level detection of conflicting route keys
type ConflictingKeys<TExisting, TNew> = {
  [K in keyof TExisting & keyof TNew]: TExisting[K] extends TNew[K]
    ? never  // Same value, no conflict
    : K;     // Different values, conflict
}[keyof TExisting & keyof TNew];

// Error type that makes TypeScript complain at call site
type RouteConflictError<TConflicts extends string> = {
  __error: `Route key conflict! Key "${TConflicts}" already exists.`;
  hint: "Use prefixed names like 'blog.index' instead of 'index'.";
};
```

**Django-style must preserve this:**

```typescript
// urls/blog.ts
export const blogPatterns = urls(({ path }) => [
  path("/", BlogIndex, { name: "index" }),  // name: "index"
]);

// urls/shop.ts
export const shopPatterns = urls(({ path }) => [
  path("/", ShopIndex, { name: "index" }),  // name: "index" - CONFLICT!
]);

// urls/index.ts
urls(({ include }) => [
  include("/blog", blogPatterns),
  include("/shop", shopPatterns),  // ❌ TypeScript error: "index" already defined
])
```

**Runtime check (startup):**

```typescript
function buildRouteMap(patterns) {
  const routeMap = {};

  for (const { name, pattern } of flattenPatterns(patterns)) {
    if (routeMap[name] && routeMap[name] !== pattern) {
      throw new Error(
        `Route name collision: "${name}" is defined multiple times with different patterns.\n` +
        `  Existing: ${routeMap[name]}\n` +
        `  New: ${pattern}\n` +
        `Use unique names like "blog.index" and "shop.index".`
      );
    }
    routeMap[name] = pattern;
  }

  return routeMap;
}
```

**Valid patterns:**

```typescript
// ✅ Unique names
path("/", BlogIndex, { name: "blog.index" })
path("/", ShopIndex, { name: "shop.index" })

// ✅ Factory with prefix
createBlogUrls("blog")  // → "blog.index", "blog.post"
createBlogUrls("news")  // → "news.index", "news.post"

// ❌ Collision
path("/", BlogIndex, { name: "index" })
path("/", ShopIndex, { name: "index" })  // Error!
```

---

## Singular Options Pattern

Options that can accept multiple values use **singular names** that accept either a single value or an array:

```typescript
// middleware - single or array
middleware: authMiddleware
middleware: [authMiddleware, loggerMiddleware]

// loader - single or array
loader: ProductLoader
loader: [ProductLoader, RelatedLoader]
loader: [
  ProductLoader,
  { loader: CartLoader, revalidate: fn },
]

// revalidate - single or array (any returning true triggers revalidation)
revalidate: ({ actionId }) => actionId?.includes("Cart")
revalidate: [
  ({ actionId }) => actionId?.includes("Cart"),
  ({ currentUrl, nextUrl }) => currentUrl.search !== nextUrl.search,
]
```

This matches patterns in Express/Hono where you don't write `middlewares`.

---

## Path Options Reference

```typescript
path(pattern, component, {
  // Optional name (server-side only)
  name?: string,

  // Route-level layout
  layout?: Component,

  // Data fetching (singular, accepts single or array)
  loader: Loader | Loader[] | Array<Loader | { loader: Loader, revalidate?, cache? }>,
  loading: ReactNode,

  // Caching
  cache: boolean | { ttl?, staleWhileRevalidate? },
  revalidate: RevalidateFn | RevalidateFn[],  // Array: any true triggers revalidation

  // Middleware (singular, accepts single or array)
  middleware: Middleware | Middleware[],

  // Error handling
  errorBoundary: ReactNode,
  notFoundBoundary: ReactNode,

  // Parallel routes
  parallel: {
    [slot: string]: Component | {
      component: Component,
      loader?: Loader,
      loading?: ReactNode,
      revalidate?: RevalidateFn,
    },
  },
})
```

---

## Layout Options Reference

```typescript
// Simple form - no options, just children
layout(Component, () => [
  path(...),
  path(...),
])

// With options - options object, then children callback
layout(Component, {
  // All path options (middleware, loader, cache, etc.), plus:

  // Intercept routes for modal/overlay patterns
  intercept: {
    [slot: string]: {
      route: string,
      component: Component,
      layout?: Component,
      when?: (ctx) => boolean,
      loader?: Loader,
      loading?: ReactNode,
    },
  },
}, () => [
  path(...),
  path(...),
])

// Orphan layout - no children, extends parent scope
layout(Component, { middleware: authMiddleware })
// Equivalent to current: layout(Component, () => [middleware(authMiddleware)])
```

### Orphan Layouts

Layouts without children extend the parent scope (apply config without nesting):

```typescript
export const urlpatterns = urls(({ path, layout }) => [
  // Orphan layouts - apply config to parent scope
  layout(DummyLayout, { revalidate: () => false }),
  layout(AnotherLayout, { middleware: loggerMiddleware }),

  // Regular layout with children
  layout(ShopLayout, () => [
    path("/", ShopIndex, { name: "index" }),
  ]),
]);
```

### Route-Level Layouts

Routes can have their own layout via the `layout` option:

```typescript
path("/product/<slug:slug>", ProductDetail, {
  name: "products.detail",
  layout: ProductLayout,  // Wraps just this route
  loader: ProductLoader,
})
```

---

## Comparison

| Aspect | Current API | Django-style |
|--------|-------------|--------------|
| Route definition | Separate `routes.ts` | Inline in `path()` |
| Handler mapping | `.routes().map()` chain | Direct component reference |
| Layouts | Nested callbacks | `layout()` wrapper |
| Options | `() => [loader(), loading()]` | Options object |
| Modularity | `.map(() => import())` | `include(() => import())` |
| URL visibility | Hidden in route objects | Visible in path patterns |
| Client href | Path-based | Path-based (unchanged) |
| Route names | Required | Optional (server-only) |

---

## Type Safety & Lazy Loading Analysis

### Client-Side Type Safety

Since client-side `href()` uses actual path patterns (not route names), type safety is straightforward:

```typescript
// Path patterns are known at compile time
href("/blog/:slug", { slug: "hello" })  // ✅ Type-safe from path pattern
```

The route manifest and naming is server-side only, so there's no type safety concern for client `href()`.

### Server-Side Route Organization

Route names in `path()` are for server organization. With lazy `include()`:

```typescript
path("/blog", include(() => import("./blog")), { name: "blog" })
```

The server doesn't need compile-time knowledge of nested routes for client type safety - it only needs to match incoming requests at runtime.

### What Current Lazy Loading Actually Does

```typescript
.routes("/blog", blogRoutes)
.map(() => import("./handlers/blog.js"))
```

The dynamic import is **only called when the route matches**. Until then:
- Module is not parsed
- Module dependencies not loaded
- Module-level code not executed

### With Direct Component Imports

```typescript
import { BlogPost } from "../pages/blog";  // Eager - loaded at startup

path("/<slug:slug>", BlogPost, { name: "post" })
```

The component is imported **at module load time**, even if that route never matches.

### Does Lazy Loading Actually Matter?

**No. Benchmarking shows lazy loading is actually worse on Cloudflare Workers.**

#### Benchmark Results (100 route modules)

| Metric | Eager | Lazy |
|--------|-------|------|
| Bundle size | **171 KB** | 229 KB |
| Build time | **~17s** | ~46s |
| Output files | 1 | 1 |

#### Key Finding

**The Vite build process bundles ALL server code into a single file.** Dynamic imports do NOT create separate chunks - they're resolved at build time.

The lazy bundle is 58 KB larger because esbuild (used by Vite) adds `__esm()` wrapper machinery to simulate dynamic imports, but all code is still bundled together:

```javascript
// Lazy bundle adds this overhead for each "dynamic" import
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
```

#### Why Lazy Loading Doesn't Work

1. **No code splitting** - Vite bundles all server modules into one file
2. **Larger bundle** - Dynamic import machinery adds ~58 KB overhead
3. **Slower builds** - Bundler does more work to handle dynamic imports
4. **Same cold start** - All code is parsed at startup anyway

### Recommendation: Use Eager Loading

Based on benchmarking, **eager loading is recommended** for Cloudflare Workers:

```typescript
// ✅ Recommended: Eager imports
import { blogPatterns } from "./blog";

urls(({ include }) => [
  include("/blog", blogPatterns),
])

// ❌ Not recommended: Lazy imports (no benefit on Workers)
urls(({ include }) => [
  include("/blog", () => import("./blog")),
])
```

**Eager loading advantages:**
- Smaller bundle (no dynamic import overhead)
- Faster builds
- Simpler mental model
- No first-request latency

### Why Not Support Lazy Loading?

Since rsc-router uses Vite for all builds (regardless of deployment target), the bundled output is always a single file. Dynamic imports are resolved at build time, not runtime.

This means:
- **Same bundle** whether targeting Workers, Node, Bun, or Deno
- **No code splitting** in the server bundle
- **Lazy syntax adds overhead** with no benefit

The `include()` API should **only support eager patterns**:

```typescript
// The only supported syntax
include("/blog", blogPatterns)

// NOT supported - no benefit, just overhead
include("/blog", () => import("./blog"))
```

---

## Open Questions

1. **Parameter syntax**: Django-style `<int:id>` vs current `:id`?
   - Django-style is more explicit about types
   - Current syntax is more familiar to Express/React Router users

2. ~~**Lazy loading**: Eager vs lazy `include()`?~~ **RESOLVED: Use eager loading.**
   - Benchmarking shows lazy loading provides no benefit on Cloudflare Workers
   - Lazy bundles are larger due to dynamic import overhead
   - All code is bundled into a single file regardless

3. **Loader array syntax**: Mixed array vs always objects?
   ```typescript
   // Option A: Mixed array (simpler for basic cases)
   loader: [SimpleLoader, { loader: ComplexLoader, revalidate: fn }]

   // Option B: Always objects (more consistent)
   loader: [
     { loader: SimpleLoader },
     { loader: ComplexLoader, revalidate: fn },
   ]
   ```

4. **Cache wrapper**: Function or option?
   ```typescript
   // Function wrapper
   cache({ ttl: 60 }, layout(...))

   // Option on layout
   layout(Component, { cache: { ttl: 60 } }, () => [...])
   ```

5. **Parallel route syntax**: Inline component vs object?
   ```typescript
   // Simple (component only)
   parallel: { "@sidebar": Sidebar }

   // Full (with options)
   parallel: { "@sidebar": { component: Sidebar, loader: SidebarLoader } }
   ```

6. **Route names**: Are they needed at all?
   - Currently for server organization only
   - Could be optional if not using server-side named references

---

## Migration Path

The Django-style API could coexist with the current API:

```typescript
// Current API still works
router
  .routes("/blog", blogRoutes)
  .map(() => import("./handlers/blog.js"));

// New API available
router.patterns(urlpatterns);
```

This allows gradual migration without breaking changes.

---

## Feedback Requested

- [ ] Overall direction: Is Django-style the right inspiration?
- [ ] Parameter syntax preference (`<int:id>` vs `:id`)
- [ ] Client/server split: Does path-based client `href` make sense?
- [ ] Are route names needed, or just paths?
- [x] ~~Lazy vs eager loading preference~~ → **Eager (benchmarked)**
- [ ] Any missing features or edge cases?
