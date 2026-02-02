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

## Proposed API

### Core Functions

| Function | Purpose | Django Equivalent |
|----------|---------|-------------------|
| `path(pattern, component, options)` | Define a route | `path(route, view, name=...)` |
| `include(loader)` | Lazy-load nested URL config | `include('app.urls')` |
| `layout(component, config)` | Wrap children with layout | Template inheritance |
| `cache(options, children)` | Cache boundary | `@cache_page()` |

> **Note:** Unlike Django's `reverse()`, rsc-router's client-side `href()` uses actual path patterns, not route names. See [Client/Server Architecture](#clientserver-architecture) below.

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
import { path, include, layout } from "@ivogt/rsc-router";
import { RootLayout } from "../layouts/RootLayout";
import { HomePage } from "../pages/home";
import { AboutPage } from "../pages/about";

export const urlpatterns = layout(RootLayout, () => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),

  // Lazy-loaded nested URL configs
  path("/blog", include(() => import("./blog")), { name: "blog" }),
  path("/dashboard", include(() => import("./dashboard")), { name: "dashboard" }),
  path("/shop", include(() => import("./shop")), { name: "shop" }),
]);
```

### Blog URLs (Simple)

```typescript
// urls/blog.ts
import { path, layout, parallel } from "@ivogt/rsc-router";
import { BlogLayout } from "../layouts/BlogLayout";
import { BlogIndex, BlogPost } from "../pages/blog";
import { BlogSidebar, BlogSidebarSkeleton } from "../components/blog";
import { BlogSidebarLoader } from "../loaders/blog";

export const urlpatterns = layout(BlogLayout, {
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
]);
```

### Dashboard URLs (With Parallel Routes)

```typescript
// urls/dashboard.ts
import { path, layout, parallel } from "@ivogt/rsc-router";
import { DashboardLayout } from "../layouts/DashboardLayout";
import { DashboardHome, DashboardSettings } from "../pages/dashboard";

export const urlpatterns = layout(DashboardLayout, {
  middleware: [rateLimitMiddleware, analyticsMiddleware],  // array for multiple
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
]);
```

### Shop URLs (Complex with Nested Includes)

```typescript
// urls/shop.ts
import { path, layout, cache, include } from "@ivogt/rsc-router";
import { ShopLayout } from "../layouts/ShopLayout";
import { ShopIndex, ProductCategory, ProductDetail, Cart } from "../pages/shop";
import { UserLoader, CartLoader, CategoriesLoader } from "../loaders/shop";
import { loggerMiddleware, mockAuthMiddleware } from "../middleware/shop";

export const urlpatterns = cache({ ttl: 60 }, layout(ShopLayout, {
  middleware: [loggerMiddleware, mockAuthMiddleware],  // array for multiple
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
  path("/checkout", include(() => import("./shop/checkout")), { name: "checkout" }),
  path("/account", include(() => import("./shop/account")), { name: "account" }),
]));
```

### Checkout URLs (Separate Cache)

```typescript
// urls/shop/checkout.ts
import { path, layout, cache } from "@ivogt/rsc-router";
import { CheckoutLayout } from "../../layouts/CheckoutLayout";
import { CheckoutIndex, CheckoutPayment, CheckoutConfirm } from "../../pages/checkout";
import { requireAuthMiddleware } from "../../middleware/shop";

export const urlpatterns = cache({ ttl: 10 }, layout(CheckoutLayout, {
  middleware: requireAuthMiddleware,  // single middleware
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
]));
```

---

## Router Setup

```typescript
// router.ts
import { createRouter } from "@ivogt/rsc-router";
import { urlpatterns } from "./urls";

export const router = createRouter<AppEnv>({
  patterns: urlpatterns,
  notFound: NotFoundPage,
  errorBoundary: ErrorPage,
});

export const href = router.href;
```

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

### Future: Named Routes via Redirect

A potential future enhancement could support named routes on the client through server redirect:

```typescript
// Future possibility - client requests by name
href("blog:post", { slug: "hello" })
// → Server resolves name → redirects to /blog/hello
```

This keeps the manifest server-side while allowing named route usage. Not in current scope.

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

// revalidate - single function
revalidate: ({ actionId }) => actionId?.includes("Cart")
```

This matches patterns in Express/Hono where you don't write `middlewares`.

---

## Path Options Reference

```typescript
path(pattern, component, {
  // Required
  name: string,

  // Data fetching (singular, accepts single or array)
  loader: Loader | Loader[] | Array<Loader | { loader: Loader, revalidate?, cache? }>,
  loading: ReactNode,

  // Caching
  cache: boolean | { ttl?, staleWhileRevalidate? },
  revalidate: (ctx: RevalidateContext) => boolean,

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

| Factor | Impact |
|--------|--------|
| Cold start time | Slight - more modules to parse |
| Memory usage | Slight - more code loaded |
| Runtime performance | Minimal - unused code just sits there |
| Bundle splitting | Bundler may already split chunks |

**For RSC on Cloudflare Workers:**
- Server-side rendering means bundle size is less critical than client
- Cloudflare Workers cold starts are already fast (~50ms)
- Modern bundlers (Vite, esbuild) handle code splitting automatically
- Tree shaking eliminates unused exports

The benefit of manual lazy loading may be **marginal** compared to what bundlers already do automatically.

### Lazy Loading Options

Since client type safety comes from path patterns (not route names), lazy loading is primarily a **server performance** concern.

#### Option A: Lazy Include (Handlers loaded on match)

```typescript
// urls/index.ts
path("/blog", include(() => import("./blog")), { name: "blog" })
```

The `./blog` module (with handlers/components) only loads when `/blog/*` is requested.

**Pros:** Minimal cold start, only load what's needed
**Cons:** Slight latency on first request to each section

#### Option B: Eager Loading (Trust the Bundler)

```typescript
// urls/index.ts
import { urlpatterns as blogPatterns } from "./blog";

path("/blog", blogPatterns, { name: "blog" })
```

All modules loaded at startup.

**Pros:** Simplest mental model, no first-request latency
**Cons:** Larger initial load, longer cold start

### Recommendation

Given that:
1. RSC runs on the server (bundle size less critical than client)
2. Cloudflare Workers cold starts are already fast (~50ms)
3. Modern bundlers (Vite, esbuild) handle code splitting automatically
4. The routes themselves are tiny (just strings)

**Either approach is valid.** The performance difference is likely marginal.

- **Option A** for large apps with many route sections
- **Option B** for simplicity in smaller apps

### Benchmarking Needed

Before deciding, measure:
- Cold start time difference with eager vs lazy loading
- Memory usage difference
- Whether Vite/esbuild already splits these modules

---

## Open Questions

1. **Parameter syntax**: Django-style `<int:id>` vs current `:id`?
   - Django-style is more explicit about types
   - Current syntax is more familiar to Express/React Router users

2. **Lazy loading**: Eager vs lazy `include()`?
   - Lazy: `include(() => import("./blog"))`
   - Eager: Direct import of urlpatterns
   - Likely marginal performance difference

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
- [ ] Lazy vs eager loading preference
- [ ] Any missing features or edge cases?
