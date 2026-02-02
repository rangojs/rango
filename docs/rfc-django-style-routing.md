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
    include("/blog", blogPatterns, { namespace: "blog" }),
    include("/shop", shopPatterns, { namespace: "shop" }),
  ]),

  // Admin doesn't get SharedLayout
  include("/admin", adminPatterns, { namespace: "admin" }),
])
```

### Real-World Example: Marketing vs App Sections

```typescript
urls(({ layout, include }) => [
  // Marketing pages - public, different layout
  layout(MarketingLayout, () => [
    include("/", homePatterns, { namespace: "marketing" }),
    include("/pricing", pricingPatterns, { namespace: "pricing" }),
    include("/about", aboutPatterns, { namespace: "about" }),
  ]),

  // App pages - authenticated, shared app chrome
  layout(AppLayout, {
    middleware: authMiddleware,
    loader: UserLoader,
  }, () => [
    include("/dashboard", dashboardPatterns, { namespace: "dashboard" }),
    include("/settings", settingsPatterns, { namespace: "settings" }),
    include("/projects", projectsPatterns, { namespace: "projects" }),
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
| `include(prefix, patterns, options?)` | Mount nested URL config | `include('app.urls')` |
| `layout(component, options?, children?)` | Wrap children with layout | Template inheritance |
| `intercept(slot, route, component, children?)` | Intercept route for modal/overlay | - |
| `cache(options, children)` | Cache boundary | `@cache_page()` |

### The `include()` Function

```typescript
include(prefix, patterns, options?)
```

| Param | Description |
|-------|-------------|
| `prefix` | URL prefix for all routes in patterns |
| `patterns` | Nested urlpatterns to mount |
| `options` | Optional: `{ namespace }` or `{ name }` (aliases) |

Namespace is optional. When provided, route names are auto-prefixed:

```typescript
// Without namespace - routes keep their local names
include("/blog", blogPatterns)

// With namespace - "index" becomes "blog.index"
include("/blog", blogPatterns, { namespace: "blog" })
// Or equivalently:
include("/blog", blogPatterns, { name: "blog" })
```

> **Note:** Like Django's `reverse()`, rsc-router resolves route names to URLs via `ctx.href()` (server) and `useHref()` (client). Local names are auto-prefixed with the current namespace. See [Client/Server Architecture](#clientserver-architecture) below.

### The `urls()` Helper

Provides type-safe helpers in scope (similar to current `map()`):

```typescript
export const urlpatterns = urls(({ path, layout, include, cache, parallel, intercept, loader, revalidate }) => [
  // All helpers available without imports
  path("/", HomePage, { name: "home" }),

  layout(BlogLayout, () => [
    path("/blog", BlogIndex, { name: "blog.index" }),
  ]),
])
```

### Parameter Syntax

Express-style parameters (same as current rsc-router):

| Pattern | Example | Type |
|---------|---------|------|
| `:param` | `/users/:name` | `string` |
| `:param?` | `/blog/:slug?` | `string \| undefined` |
| `:param(a\|b)` | `/:locale(en\|de)/blog` | `"en" \| "de"` |
| `:param(a\|b)?` | `/:locale(en\|de)?/blog` | `"en" \| "de" \| undefined` |
| `*` | `/files/*` | `string` (catch-all, with slashes) |

This maintains consistency with existing pattern matching and type inference.

---

## Full Example

### Main URL Configuration

```typescript
// urls/index.ts
import { urls } from "@ivogt/rsc-router";
import { RootLayout } from "../layouts/RootLayout";
import { HomePage } from "../pages/home";
import { AboutPage } from "../pages/about";
import { blogPatterns } from "./blog";
import { dashboardPatterns } from "./dashboard";
import { shopPatterns } from "./shop";

export const urlpatterns = urls(({ path, layout, include }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),

    // Nested URL configs with namespaces
    include("/blog", blogPatterns, { namespace: "blog" }),
    include("/dashboard", dashboardPatterns, { namespace: "dashboard" }),
    include("/shop", shopPatterns, { namespace: "shop" }),
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

    path("/:slug", BlogPost, {
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
  }, () => [
    // Intercept for modal - renders ProductModalContent in @modal slot on soft nav
    intercept("@modal", "products.detail", ProductModalContent, () => [
      layout(ModalWrapper),
      revalidate(({ from }) => !from.pathname.startsWith("/shop/products/")),
    ]),

    path("/", ShopIndex, {
      name: "index",
      parallel: { "@sidebar": CategorySidebar },
    }),

    path("/products/:category", ProductCategory, {
      name: "products.category",
    }),

    path("/product/:slug", ProductDetail, {
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
    include("/checkout", checkoutPatterns, { namespace: "shop.checkout" }),
    include("/account", accountPatterns, { namespace: "shop.account" }),
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

**`.routes()` can only be called once.** Calling it multiple times throws an error:

```typescript
// ❌ Error: .routes() can only be called once
router
  .routes(blogPatterns)
  .routes(shopPatterns)  // Throws!

// ✅ Correct: Use include() for composition
router.routes(urls(({ include }) => [
  include("/blog", blogPatterns),
  include("/shop", shopPatterns),
]))
```

**Why this constraint?**

1. **Single source of truth** - All routes visible in one `urlpatterns` structure
2. **Explicit composition** - `include()` makes mounting points clear
3. **No hidden routes** - Can't accidentally add routes in multiple places
4. **Matches Django** - Django has one `urlpatterns` list per module

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

### Key Design Decision: Route Manifest via RSC Payload

Like Django's `reverse()`, rsc-router resolves route names to URLs at runtime. The route manifest is passed from server to client via the RSC payload.

**Why RSC payload instead of static bundle?**
- No static bundle cost (manifest comes with page data)
- Fresh per request (routes can change without redeploy)
- Namespace context from matched route

### Server Components: `ctx.href()`

In RSC, the route context provides a namespace-aware `href()` function with full type inference:

```typescript
// Server Component
async function BlogPost({ ctx }: { ctx: RouteContext }) {
  const posts = await ctx.use(PostsLoader);

  return (
    <>
      {/* Local names - resolved with current namespace */}
      <Link href={ctx.href("index")}>Back to list</Link>
      <Link href={ctx.href("post", { slug: "next" })}>Next</Link>

      {/* Absolute names - explicit namespace */}
      <Link href={ctx.href("shop.cart")}>Cart</Link>

      {/* Path-based - always works */}
      <Link href={ctx.href("/about")}>About</Link>
    </>
  );
}
```

**Type inference:**

```typescript
interface RouteContext {
  href: {
    // Local names (inferred from current namespace's routes)
    (name: "index"): string;
    (name: "post", params: { slug: string }): string;

    // Absolute names (all routes in app)
    (name: "shop.cart"): string;
    (name: "shop.product", params: { id: number }): string;

    // Path-based fallback
    (path: `/${string}`, params?: Record<string, unknown>): string;
  };
}
```

### Client Components: `useHref()`

On the client, `useHref()` provides the same API via React context:

```typescript
"use client";
import { useHref } from "@ivogt/rsc-router/client";

function AddToCartButton({ productId }: { productId: number }) {
  const href = useHref();

  return (
    <Link href={href("shop.cart")}>
      View Cart
    </Link>
  );
}
```

### Summary

| Environment | API | Namespace Source |
|-------------|-----|------------------|
| Server Component | `ctx.href()` | From route context (injected) |
| Client Component | `useHref()` | From RSC payload via React context |

Same behavior, appropriate API for each environment.

### Route Names

The `name` property in `path()` defines a local route name:

```typescript
path("/blog/:slug", BlogPost, { name: "post" })
//                                         ↑ Local name
```

Local names are automatically prefixed with the namespace when mounted via `include()`:

```typescript
include("/blog", blogPatterns, { namespace: "blog" })
// "post" becomes "blog.post"
```

**Used for:**
- `ctx.href()` in server components
- `useHref()` in client components
- Server-side redirects
- Logging and debugging

### Route Context via RSC Payload

rsc-router passes metadata from server to client via the RSC payload. This includes the route map and current namespace:

```typescript
// RscMetadata
interface RscMetadata {
  pathname: string;
  segments: ResolvedSegment[];
  // Route context for client href
  routeMap: Record<string, string>;  // "blog.index" → "/blog"
  namespace: string;                  // Current namespace from matched route
}
```

**Server populates during SSR:**

```typescript
metadata.routeMap = {
  "blog.index": "/blog",
  "blog.post": "/blog/:slug",
  "shop.index": "/shop",
  "shop.product": "/shop/product/:id",
};
metadata.namespace = "blog";  // From matched route's namespace
```

**Benefits:**

| Benefit | Description |
|---------|-------------|
| Follows existing pattern | Same as `themeConfig` injection |
| No static bundle cost | Route map comes via RSC payload |
| Namespace context | Components know their current namespace |
| Fresh per request | Routes can change without redeploy |

### Auto-Namespacing via `include()`

Like Django's `app_name`, namespaces are set at mount time - the mounted module doesn't need to know its namespace:

```typescript
// urls/blog.ts - uses LOCAL names (no prefix)
export const urlpatterns = urls(({ path }) => [
  path("/", BlogIndex, { name: "index" }),
  path("/:slug", BlogPost, { name: "post" }),
]);
```

```typescript
// urls/index.ts - namespace set at mount time
urls(({ include }) => [
  include("/blog", blogPatterns, { namespace: "blog" }),
  include("/news", blogPatterns, { namespace: "news" }),  // Same module, different namespace!
])
```

The router automatically prefixes route names:
- `include("/blog", ..., { namespace: "blog" })` → `"index"` becomes `"blog.index"`
- `include("/news", ..., { namespace: "news" })` → `"index"` becomes `"news.index"`

### How Namespace Resolution Works

The router provides namespace context based on the matched route:

1. Server knows current namespace from matched route
2. `ctx.href()` (RSC) and `useHref()` (client) both resolve names the same way
3. Local names (no dot) are prefixed with current namespace
4. Absolute names (with dot) or paths are used as-is

```typescript
// When mounted at /blog (namespace: "blog")
href("index")      // → resolves "blog.index" → "/blog"
href("post", ...)  // → resolves "blog.post" → "/blog/:slug"

// When mounted at /news (namespace: "news")
href("index")      // → resolves "news.index" → "/news"
href("post", ...)  // → resolves "news.post" → "/news/:slug"
```

**Resolution priority:**

1. Path-based (`/blog/:slug`) → Use directly
2. Absolute name (`shop.cart`) → Global lookup in routeMap
3. Local name (`index`) → Prepend current namespace, then lookup

### Implementation

```typescript
// Shared resolution logic (used by both ctx.href and useHref)
function createHref(routeMap: RouteMap, namespace: string) {
  return (nameOrPath: string, params?: object) => {
    // Path-based
    if (nameOrPath.startsWith("/")) {
      return interpolate(nameOrPath, params);
    }

    // Absolute name (has dot) or local name (no dot)
    const fullName = nameOrPath.includes(".")
      ? nameOrPath
      : `${namespace}.${nameOrPath}`;

    const pattern = routeMap[fullName];
    if (!pattern) {
      throw new Error(`Unknown route: ${fullName}`);
    }

    return interpolate(pattern, params);
  };
}

// Server: ctx.href is created when building route context
const ctx = {
  href: createHref(routeMap, matchedNamespace),
  // ...other context
};

// Client: useHref reads from React context (populated via RSC payload)
function useHref() {
  const { routeMap, namespace } = useRouteContext();
  return createHref(routeMap, namespace);
}
```

**Benefits:**
- Django-style: mounted module doesn't know its namespace
- Same API on server (`ctx.href`) and client (`useHref`)
- Full type inference for all routes
- Reusable modules work without factories or prop drilling
- Local names are short and readable
- Path-based always works as fallback

### Route Name Collision Detection

With auto-namespacing, collisions only occur if you:
1. Use the same namespace twice
2. Have duplicate local names within a module

**Namespaces prevent most collisions:**

```typescript
// urls/blog.ts - local name "index"
export const blogPatterns = urls(({ path }) => [
  path("/", BlogIndex, { name: "index" }),
]);

// urls/shop.ts - also local name "index"
export const shopPatterns = urls(({ path }) => [
  path("/", ShopIndex, { name: "index" }),
]);

// urls/index.ts - different namespaces, no collision!
urls(({ include }) => [
  include("/blog", blogPatterns, { namespace: "blog" }),  // → "blog.index"
  include("/shop", shopPatterns, { namespace: "shop" }),  // → "shop.index" ✅
])
```

**Collision when namespaces conflict:**

```typescript
urls(({ include }) => [
  include("/blog", blogPatterns, { namespace: "content" }),
  include("/news", newsPatterns, { namespace: "content" }),  // ❌ Same namespace!
])
// Both have "content.index" - collision!
```

**Runtime check (startup):**

```typescript
function buildRouteMap(patterns, namespace?: string) {
  const routeMap = {};

  for (const { name, pattern } of flattenPatterns(patterns)) {
    const fullName = namespace ? `${namespace}.${name}` : name;

    if (routeMap[fullName]) {
      throw new Error(
        `Route name collision: "${fullName}" is defined multiple times.\n` +
        `  Existing: ${routeMap[fullName]}\n` +
        `  New: ${pattern}\n` +
        `Use different namespaces for each include().`
      );
    }
    routeMap[fullName] = pattern;
  }

  return routeMap;
}
```

**Valid patterns:**

```typescript
// ✅ Different namespaces - no collision
include("/blog", blogPatterns, { namespace: "blog" })  // → "blog.index"
include("/news", blogPatterns, { namespace: "news" })  // → "news.index"

// ✅ Same module mounted twice with different namespaces
include("/en/blog", blogPatterns, { namespace: "en.blog" })
include("/de/blog", blogPatterns, { namespace: "de.blog" })

// ❌ Same namespace - collision
include("/blog", blogPatterns, { namespace: "content" })
include("/news", newsPatterns, { namespace: "content" })  // Error!
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

## Handlers & Handler Context

Route handlers are functions that receive a type-safe context (`ctx`) with route params, request data, and platform bindings.

### Handler Types

**Static component** - No context, no params:
```typescript
path("/about", <AboutPage />)
```
Static components are rendered as-is. They **do not receive route params**. Use a handler function if you need params.

**Handler function** - Receives typed context with params:
```typescript
path("/product/:slug", async (ctx) => {
  const product = await ctx.use(ProductLoader);
  return <ProductPage product={product} slug={ctx.params.slug} />;
})
```
Handler functions receive `ctx` with type-safe access to route params extracted from the URL pattern.

**Layout handler** - Same context, wraps children:
```typescript
layout(async (ctx) => {
  const user = ctx.get("user");
  return <DashboardShell user={user} />;
}, () => [
  path("/", DashboardIndex, { name: "index" }),
])
```

### Accessing Params in Static Components

If you need route params in a component without using a handler function, use `getServerContext()`:

```typescript
import { getServerContext } from "@ivogt/rsc-router/server";

// Static component that needs params
async function BlogPost() {
  const ctx = getServerContext();
  const slug = ctx.params.slug;  // Access params via context
  // ...
}

path("/blog/:slug", <BlogPost />)  // Works, but handler function is cleaner
```

**Recommendation:** Prefer handler functions when you need params. They're more explicit and type-safe:

```typescript
// Preferred: explicit params in handler
path("/blog/:slug", (ctx) => <BlogPost slug={ctx.params.slug} />)
```

### Handler Context (`ctx`)

Handlers receive a Hono-inspired context with type-safe access to:

```typescript
path("/product/:slug", async (ctx) => {
  // Route params - type-safe from pattern
  ctx.params.slug              // string (from :slug)

  // Request data
  ctx.request                  // Request object
  ctx.searchParams             // URLSearchParams (filtered)
  ctx.pathname                 // "/product/widget"
  ctx.url                      // URL object

  // Platform bindings (Cloudflare, etc.)
  ctx.env.DB                   // D1Database
  ctx.env.KV                   // KVNamespace
  ctx.env.SECRETS              // Secret bindings

  // Middleware variables (type-safe via global augmentation)
  ctx.var.user                 // User | undefined
  ctx.get("user")              // Alternative getter
  ctx.set("user", newUser)     // Setter

  // Response headers
  ctx.res.headers.set("Cache-Control", "s-maxage=60")
  ctx.headers.set("X-Custom", "value")  // Shorthand

  // Loader data
  const product = await ctx.use(ProductLoader)
  const cart = await ctx.use(CartLoader)

  // Handle data (push pattern)
  const push = ctx.use(Breadcrumbs)
  push({ label: "Product", href: ctx.url.pathname })

  // Theme (when enabled)
  ctx.theme                    // "light" | "dark" | "system"
  ctx.setTheme?.("dark")       // Set theme cookie

  return <ProductPage product={product} />
})
```

### Type-Safe Params

Route params are extracted from the URL pattern at compile time:

| Pattern | Params Type |
|---------|-------------|
| `/products/:id` | `{ id: string }` |
| `/:locale?/blog/:slug` | `{ locale?: string; slug: string }` |
| `/:locale(en\|gb)/blog` | `{ locale: "en" \| "gb" }` |
| `/:locale(en\|gb)?/:slug` | `{ locale?: "en" \| "gb"; slug: string }` |

```typescript
// Params are inferred from the path pattern
path("/product/:slug", (ctx) => {
  ctx.params.slug  // ✅ string
  ctx.params.id    // ❌ TypeScript error - doesn't exist
})

// Optional params
path("/:locale?/blog/:slug", (ctx) => {
  ctx.params.locale  // string | undefined
  ctx.params.slug    // string
})

// Constrained params
path("/:locale(en|gb)/shop", (ctx) => {
  ctx.params.locale  // "en" | "gb"
})
```

### Type-Safe Variables via Global Augmentation

Middleware variables (`ctx.var`, `ctx.get`, `ctx.set`) are typed via module augmentation:

```typescript
// env.ts
export interface AppEnv {
  Bindings: {
    DB: D1Database;
    KV: KVNamespace;
    AUTH_SECRET: string;
  };
  Variables: {
    user: User | undefined;
    requestId: string;
    permissions: string[];
  };
}

declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}
```

Now `ctx.var.user` and `ctx.get("user")` are fully typed:

```typescript
path("/dashboard", (ctx) => {
  const user = ctx.get("user")  // User | undefined
  if (!user) return redirect("/login")

  ctx.set("requestId", crypto.randomUUID())  // ✅ Type-safe
  ctx.set("invalid", 123)  // ❌ TypeScript error

  return <DashboardPage user={user} />
})
```

### Mapping from Current API

**Current** - handler as first arg to `route()`:
```typescript
route("product", async (ctx) => {
  const product = await ctx.use(ProductLoader);
  return <ProductPage product={product} />;
}, () => [
  loader(ProductLoader),
])
```

**Django-style** - handler as second arg to `path()`:
```typescript
path("/product/:slug", async (ctx) => {
  const product = await ctx.use(ProductLoader);
  return <ProductPage product={product} />;
}, {
  name: "product",
  loader: ProductLoader,
})
```

The handler context (`ctx`) is identical - same properties, same type safety.

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

  // Error handling (see Error Boundaries section below)
  errorBoundary: ReactNode | ErrorBoundaryHandler,
  notFoundBoundary: ReactNode | NotFoundBoundaryHandler,

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
  // All path options (middleware, loader, cache, etc.)
}, () => [
  path(...),
  path(...),

  // Intercept routes for modal/overlay patterns (function, not option)
  intercept(slotName, routeName, Component, () => [
    // Optional children: loader, revalidate, layout, etc.
  ]),
])

// Orphan layout - no children, extends parent scope
layout(Component, { middleware: authMiddleware })
// Equivalent to current: layout(Component, () => [middleware(authMiddleware)])
```

### Intercept Function

```typescript
intercept(slotName, routeName, component, children?)
```

| Param | Description |
|-------|-------------|
| `slotName` | Named slot (e.g., `"@modal"`) |
| `routeName` | Route key to intercept |
| `component` | React element to render on soft navigation |
| `children` | Optional - loader, revalidate, layout, middleware |

Intercepts render alternative content in a named slot during soft navigation. Hard navigation (direct URL) renders the normal route.

```typescript
layout(KanbanLayout, () => [
  loader(KanbanLoader),

  // Intercept card route - renders CardModal in @modal slot on soft nav
  intercept("@modal", "card", CardModal, () => [
    loader(CardDetailLoader),
    revalidate(() => false),
  ]),
]),

// Hard navigation to /card renders this instead
route("card", CardDetailPage),
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
path("/product/:slug", ProductDetail, {
  name: "products.detail",
  layout: ProductLayout,  // Wraps just this route
  loader: ProductLoader,
})
```

---

## Error Boundaries & Not Found Handling

rsc-router has **two different "not found" concepts** that map differently to the Django-style API:

### Concept Overview

| Concept | Where Defined | When Triggered | Example |
|---------|---------------|----------------|---------|
| **Route not matched** | `createRSCRouter({ notFound })` | No route matches URL | `/nonexistent-page` → 404 |
| **Data not found** | `path({ notFoundBoundary })` | `notFound()` called in loader | Product ID 999 doesn't exist |

### Router-Level Options (Unchanged)

These stay on `createRSCRouter()` options - they're app-wide defaults:

```typescript
createRSCRouter<AppEnv>({
  document: Document,

  // 404 page when NO route matches the URL
  // Rendered inside document shell with 404 status
  notFound: ({ pathname }) => (
    <div>
      <h1>Page Not Found</h1>
      <p>Nothing exists at {pathname}</p>
    </div>
  ),

  // Default fallback for unhandled errors in route tree
  // Used when no errorBoundary defined closer to the error
  defaultErrorBoundary: ({ error, reset }) => (
    <div>
      <h1>Something went wrong</h1>
      <button onClick={reset}>Try again</button>
    </div>
  ),

  // Default fallback for unhandled notFound() calls
  // Used when no notFoundBoundary defined closer to the call
  defaultNotFoundBoundary: ({ notFound }) => (
    <div>
      <h1>Not Found</h1>
      <p>{notFound.message}</p>
    </div>
  ),
})
```

### Route-Level Boundaries (Current vs Django-style)

**Current API** - boundaries are helper functions inside `map()`:

```typescript
route("product", ProductPage, () => [
  loader(ProductLoader),
  errorBoundary(<ProductError />),
  notFoundBoundary(<ProductNotFound />),
])
```

**Django-style** - boundaries are options on `path()` or `layout()`:

```typescript
path("/product/:id", ProductPage, {
  name: "product",
  loader: ProductLoader,

  // Catches errors in this segment and children
  errorBoundary: <ProductError />,
  // Or with handler for dynamic error UI:
  errorBoundary: ({ error, reset }) => (
    <div>
      <h2>Product failed to load</h2>
      <p>{error.message}</p>
      <button onClick={reset}>Retry</button>
    </div>
  ),

  // Catches notFound() calls in this segment and children
  notFoundBoundary: <ProductNotFound />,
  // Or with handler:
  notFoundBoundary: ({ notFound }) => (
    <div>
      <h2>{notFound.message}</h2>
      <a href="/products">Browse all products</a>
    </div>
  ),
})
```

### Layout-Level Boundaries

Boundaries on layouts catch errors/notFound from all children:

```typescript
layout(ShopLayout, {
  // Catches errors from ANY route inside this layout
  errorBoundary: <ShopError />,

  // Catches notFound() from ANY loader inside this layout
  notFoundBoundary: <ShopNotFound />,
}, () => [
  path("/", ShopIndex, { name: "index" }),
  path("/product/:id", ProductDetail, {
    name: "product",
    // Route-specific boundary takes precedence
    notFoundBoundary: <ProductNotFound />,
  }),
])
```

### Boundary Resolution Order

When an error or `notFound()` is thrown:

1. **Route-level boundary** - Closest boundary on the route itself
2. **Layout-level boundary** - Walk up layout tree looking for boundary
3. **Default boundary** - `defaultErrorBoundary` / `defaultNotFoundBoundary` from router
4. **Crash** - If no default, error propagates and crashes request

```typescript
layout(AppLayout, {
  errorBoundary: <AppError />,  // 3rd: app-wide fallback
}, () => [
  layout(ShopLayout, {
    errorBoundary: <ShopError />,  // 2nd: shop section fallback
  }, () => [
    path("/product/:id", ProductPage, {
      errorBoundary: <ProductError />,  // 1st: product-specific
      loader: ProductLoader,  // If this throws, ProductError catches it
    }),
  ]),
])
```

### Summary

| Level | Option | Purpose |
|-------|--------|---------|
| Router | `notFound` | 404 page when no route matches |
| Router | `defaultErrorBoundary` | App-wide error fallback |
| Router | `defaultNotFoundBoundary` | App-wide notFound() fallback |
| Route/Layout | `errorBoundary` | Segment-specific error handling |
| Route/Layout | `notFoundBoundary` | Segment-specific notFound() handling |

---

## Comparison

| Aspect | Current API | Django-style |
|--------|-------------|--------------|
| Route definition | Separate `routes.ts` | Inline in `path()` |
| Handler mapping | `.routes().map()` chain | Direct component reference |
| Layouts | Nested callbacks | `layout()` wrapper |
| Options | `() => [loader(), loading()]` | Options object |
| Modularity | `.map(() => import())` | `include(path, patterns)` |
| URL visibility | Hidden in route objects | Visible in path patterns |
| href | Path-based | `ctx.href()` / `useHref()` with namespaces |
| Route names | Required, globally unique | Local names, auto-namespaced |

---

## Type Safety & Lazy Loading Analysis

### Client-Side Type Safety

Both `ctx.href()` (server) and `useHref()` (client) use the same namespace-aware resolution:

```typescript
// In client component
const href = useHref();

// Local names - resolved with current namespace
href("index")                    // ✅ Type-safe: resolves "blog.index" when in blog namespace
href("post", { slug: "hello" })  // ✅ Type-safe: requires slug param

// Absolute names - explicit namespace
href("shop.cart")                // ✅ Type-safe: global lookup

// Path-based - always works
href("/blog/:slug", { slug: "hello" })  // ✅ Type-safe from path pattern
```

Type inference comes from the route map passed via RSC payload. Route names and their required params are known at compile time from the `urls()` definitions.

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

path("/:slug", BlogPost, { name: "post" })
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

1. ~~**Parameter syntax**: Django-style `<int:id>` vs current `:id`?~~ **RESOLVED: Use Express-style.**
   - Keep current `:param`, `:param?`, `:param(a|b)`, `*` syntax
   - Maintains consistency with existing pattern matching
   - Familiar to Express/React Router users

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

6. ~~**Route names**: Are they needed at all?~~ **RESOLVED: Yes, with auto-namespacing.**
   - Local names in modules, auto-prefixed via `include({ namespace })`
   - `useHref()` resolves local names using namespace context
   - Django-style: mounted module doesn't know its namespace

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
- [x] ~~Parameter syntax preference~~ → **Express-style (`:param`, `:param?`, `:param(a|b)`, `*`)**
- [x] ~~Client/server split: Does path-based client `href` make sense?~~ → **`useHref()` with namespaces**
- [x] ~~Are route names needed, or just paths?~~ → **Local names with auto-namespacing**
- [x] ~~Lazy vs eager loading preference~~ → **Eager (benchmarked)**
- [ ] Any missing features or edge cases?

---

## Implementation Plan

### Git Workflow

```
main
  └── rfc/django-style-routing (base branch for all work)
        ├── rfc/django-style-routing-phase-1  → PR to rfc/django-style-routing
        ├── rfc/django-style-routing-phase-2  → PR to rfc/django-style-routing
        ├── rfc/django-style-routing-phase-3  → PR to rfc/django-style-routing
        └── ...
```

Each phase gets its own branch, PR'd back to `rfc/django-style-routing`. Once all phases complete, merge to `main`.

### Phase 1: Foundation - Package & Basic DSL

**Branch:** `rfc/django-style-routing-phase-1`

**Goal:** New `@rangojs/router` package with `urls()` / `path()` DSL that compiles to existing internal structures.

**Tasks:**
- [ ] Copy `rsc-router` to `rangojs-router` package
- [ ] Update package.json (`@rangojs/router`)
- [ ] Add `urls-dsl.ts` with `urls()` and `path()` functions
- [ ] `path()` produces same internal `RouteEntry` structures
- [ ] Add `.routes(urlpatterns)` overload to `createRSCRouter`
- [ ] Add unit tests: `src/__tests__/urls-dsl.test.ts`
- [ ] Verify existing unit tests pass
- [ ] Verify E2E tests pass (test-app unchanged)

**Tests to run:**
```bash
pnpm test:unit  # All unit tests green
pnpm test       # E2E tests green (unchanged test-app)
```

### Phase 2: Layout DSL

**Branch:** `rfc/django-style-routing-phase-2`

**Goal:** Add `layout()` helper that wraps children.

**Tasks:**
- [ ] Implement `layout(Component, () => [...])` syntax
- [ ] Implement `layout(Component, options, () => [...])` with options
- [ ] Support orphan layouts (no children)
- [ ] Add unit tests for layout compositions
- [ ] Verify existing tests pass

### Phase 3: Include & Namespace

**Branch:** `rfc/django-style-routing-phase-3`

**Goal:** Add `include()` with namespace support for composability.

**Tasks:**
- [ ] Implement `include(prefix, patterns, { namespace })`
- [ ] Auto-prefix route names with namespace
- [ ] Namespace collision detection (compile-time + runtime)
- [ ] Add unit tests for namespace prefixing
- [ ] Add collision detection tests

### Phase 4: Options Object Migration

**Branch:** `rfc/django-style-routing-phase-4`

**Goal:** Move from callback helpers to options object on `path()` and `layout()`.

**Tasks:**
- [ ] Add options: `loader`, `loading`, `middleware`, `revalidate`
- [ ] Add options: `errorBoundary`, `notFoundBoundary`
- [ ] Add options: `parallel`, `intercept`, `cache`
- [ ] Convert options to internal structures
- [ ] Add unit tests for each option type
- [ ] Create new E2E test-app using Django-style syntax
- [ ] All E2E tests pass with new syntax

### Phase 5: Single `.routes()` Enforcement

**Branch:** `rfc/django-style-routing-phase-5`

**Goal:** Enforce single `.routes()` call, all composition via `include()`.

**Tasks:**
- [ ] Add runtime error if `.routes()` called twice
- [ ] Update test-app to use single `.routes()` with `include()`
- [ ] All tests pass

### Phase 6: Client `useHref()` (Last)

**Branch:** `rfc/django-style-routing-phase-6`

**Goal:** Namespace-aware `useHref()` hook via RSC payload.

**Tasks:**
- [ ] Add `routeMap` and `namespace` to `RscMetadata`
- [ ] Server populates route map during SSR
- [ ] Implement `useHref()` hook with namespace context
- [ ] Local names resolve with current namespace
- [ ] Absolute names and paths work as fallback
- [ ] Add unit tests for href resolution
- [ ] Add E2E tests for client navigation with named routes

---

## Progress Tracking

### Current Phase: Not Started

### Completed Phases

_None yet_

### Test Status

| Test Suite | Status | Notes |
|------------|--------|-------|
| Unit tests (`pnpm test:unit`) | ⬜ Not run | |
| E2E tests (`pnpm test`) | ⬜ Not run | |

**Legend:** ✅ Green | 🟡 Partial (expected) | ❌ Failing (unexpected) | ⬜ Not run

---

## Test Strategy

### Principle: Tests Follow Implementation

1. **After each phase**, run tests for covered functionality
2. **Suite can be red** for features not yet migrated
3. **Eventually all green** - existing + new tests pass
4. **New tests required** for each new feature

### Test Categories

**Unit Tests** (`src/**/__tests__/`):
- `urls-dsl.test.ts` - New DSL produces correct structures
- `pattern-matching.test.ts` - URL matching (unchanged)
- `route-definition.test.ts` - Existing `route()` function
- Middleware, cache, theme tests (unchanged)

**E2E Tests** (`e2e/`):
- Existing test-app uses current API initially
- Phase 4+: New test-app or migrated test-app with Django-style
- All navigation, loader, action tests must pass

### Running Tests

```bash
# Unit tests only
pnpm test:unit

# E2E tests (requires test-app)
pnpm test

# Specific test file
pnpm test:unit src/__tests__/urls-dsl.test.ts

# E2E with UI
pnpm test:ui
```

---

## Changelog

_Updated after each phase completion._

### [Unreleased]

#### Phase 1: Foundation
- _Not started_

#### Phase 2: Layout DSL
- _Not started_

#### Phase 3: Include & Namespace
- _Not started_

#### Phase 4: Options Object Migration
- _Not started_

#### Phase 5: Single `.routes()` Enforcement
- _Not started_

#### Phase 6: Client `useHref()`
- _Not started_
