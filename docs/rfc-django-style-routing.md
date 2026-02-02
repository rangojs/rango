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
| `href(name, params)` | Generate URL from name | `reverse()` |

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

## URL Generation (href)

Namespacing follows `include()` structure:

```typescript
// Direct routes
href("home")                                    // "/"
href("about")                                   // "/about"

// Included routes use colon separator
href("blog:index")                              // "/blog"
href("blog:post", { slug: "hello-world" })      // "/blog/hello-world"

// Deeply nested
href("shop:index")                              // "/shop"
href("shop:products.detail", { slug: "laptop" }) // "/shop/product/laptop"
href("shop:checkout:payment")                   // "/shop/checkout/payment"
href("shop:account:orderDetail", { id: 123 })   // "/shop/account/orders/123"
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
| Namespacing | Manual `blog.post` | Auto from include: `blog:post` |

---

## Type Safety & Lazy Loading Analysis

### The Fundamental Tension

The current rsc-router achieves type-safe `href()` by knowing all routes at compile time:

```typescript
// routes.ts - ALL routes defined upfront
export const blogRoutes = route({
  "blog.index": "/",
  "blog.post": "/:slug",
});

// Router knows all routes → type-safe href()
href("blog.post", { slug: "hello" })  // ✅ Fully typed at compile time
```

With Django-style lazy `include()`:

```typescript
path("/blog", include(() => import("./blog")), { name: "blog" })

// Router doesn't know blog's internal routes until module loads
href("blog:post", { slug: "hello" })  // ❓ How to type this?
```

Django doesn't have this problem because Python's `reverse()` is runtime-based, not compile-time type-safe.

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

### Options to Preserve Type Safety

#### Option A: Separate Route Definitions (Current Approach)

Keep routes in separate files, import eagerly for types:

```typescript
// urls/blog.ts
export const routes = {
  index: "/",
  post: "/<slug:slug>",
} as const;

export const urlpatterns = layout(BlogLayout, () => [
  path(routes.index, BlogIndex, { name: "index" }),
  path(routes.post, BlogPost, { name: "post" }),
]);
```

```typescript
// urls/index.ts
import { routes as blogRoutes } from "./blog";  // Tiny - just route strings

path("/blog", include(blogRoutes, () => import("./blog")), { name: "blog" })
//                     ↑ types known        ↑ handlers lazy
```

**Pros:** Best type safety, handlers still lazy
**Cons:** Two exports per URL module, more verbose

#### Option B: Type-Only Imports

Use TypeScript's `import type` which is erased at runtime:

```typescript
// urls/index.ts
import type { urlpatterns as BlogPatterns } from "./blog";

path("/blog", include<BlogPatterns>(() => import("./blog")), { name: "blog" })
```

**Pros:** Types available, no runtime import
**Cons:** Requires explicit type annotation, can drift from implementation

#### Option C: Eager Loading (Trust the Bundler)

Just import everything eagerly:

```typescript
// urls/index.ts
import { urlpatterns as blogPatterns } from "./blog";

path("/blog", blogPatterns, { name: "blog" })
```

**Pros:** Simplest mental model, full type safety
**Cons:** All modules loaded at startup

#### Option D: Build-Time Route Extraction

A Vite plugin that:
1. Scans all `urls/*.ts` files at build time
2. Extracts route patterns and names
3. Generates a `routes.d.ts` type manifest

```typescript
// Auto-generated: routes.d.ts
declare module "@ivogt/rsc-router" {
  interface RouteMap {
    "home": "/";
    "about": "/about";
    "blog:index": "/blog";
    "blog:post": "/blog/:slug";
    // ...
  }
}
```

**Pros:** Full type safety with true lazy loading
**Cons:** Build tooling complexity, requires plugin

### Recommendation

Given that:
1. RSC runs on the server (bundle size less critical)
2. Cloudflare Workers cold starts are already fast
3. Bundlers are smart about code splitting
4. Type safety provides significant DX value
5. The routes themselves are tiny (just strings)

**Recommended approach: Option A or Option C**

- **Option A** if lazy loading proves measurably beneficial
- **Option C** for simplicity, let the bundler optimize

The complexity of manual lazy loading may not be worth the marginal performance gain, especially if it compromises type safety or developer experience.

### Benchmarking Needed

Before deciding, we should measure:
- Cold start time difference with eager vs lazy loading
- Memory usage difference
- Whether Vite/esbuild already splits these modules

---

## Open Questions

1. **Parameter syntax**: Django-style `<int:id>` vs current `:id`?

2. **Colon vs dot for namespacing**: `blog:post` vs `blog.post`?

3. **Lazy loading strategy**: Which option?
   - **Option A**: Separate route definitions (best types, more verbose)
   - **Option B**: Type-only imports (good balance, can drift)
   - **Option C**: Eager loading (simplest, trust bundler)
   - **Option D**: Build-time extraction (best of both, most complex)

4. **Loader array syntax**: Mixed array vs always objects?
   ```typescript
   // Option A: Mixed array (simpler for basic cases)
   loader: [SimpleLoader, { loader: ComplexLoader, revalidate: fn }]

   // Option B: Always objects (more consistent)
   loader: [
     { loader: SimpleLoader },
     { loader: ComplexLoader, revalidate: fn },
   ]
   ```

5. **Cache wrapper**: Function or option?
   ```typescript
   // Function wrapper
   cache({ ttl: 60 }, layout(...))

   // Option on layout
   layout(Component, { cache: { ttl: 60 } }, () => [...])
   ```

6. **Parallel route syntax**: Inline component vs object?
   ```typescript
   // Simple (component only)
   parallel: { "@sidebar": Sidebar }

   // Full (with options)
   parallel: { "@sidebar": { component: Sidebar, loader: SidebarLoader } }
   ```

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
- [ ] Namespacing separator preference (`:` vs `.`)
- [ ] Lazy loading strategy (Option A, B, C, or D)
- [ ] Options object vs callback API
- [ ] Any missing features or edge cases?
