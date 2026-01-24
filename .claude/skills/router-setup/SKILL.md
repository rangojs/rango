---
name: router-setup
description: Create and configure the RSC router with createRSCRouter
argument-hint: [option]
---

# Router Setup with createRSCRouter

## Basic Router Creation

```typescript
import { createRSCRouter } from "rsc-router/server";
import { Document } from "./document";

const router = createRSCRouter({
  document: Document,
});

export default router;
```

## Router Options

```typescript
interface RSCRouterOptions<TEnv> {
  // Document component wrapping entire app
  document?: ComponentType<{ children: ReactNode }>;

  // Enable performance metrics (console + Server-Timing header)
  debugPerformance?: boolean;

  // Default error boundary fallback
  defaultErrorBoundary?: ReactNode | ErrorBoundaryHandler;

  // Default not-found boundary (for notFound() calls)
  defaultNotFoundBoundary?: ReactNode | NotFoundBoundaryHandler;

  // Component for routes with no match (404)
  notFound?: ReactNode | ((props: { pathname: string }) => ReactNode);

  // Error logging callback
  onError?: OnErrorCallback<TEnv>;

  // Cache configuration
  cache?:
    | { store: SegmentCacheStore; enabled?: boolean }
    | ((env: TEnv) => { store: SegmentCacheStore; enabled?: boolean });
}
```

## Full Configuration Example

```typescript
import { createRSCRouter } from "rsc-router/server";
import { createMemorySegmentStore } from "rsc-router/cache";
import { Document } from "./document";

const cacheStore = createMemorySegmentStore();

const router = createRSCRouter<AppEnv>({
  document: Document,
  debugPerformance: process.env.NODE_ENV === "development",

  cache: {
    store: cacheStore,
    enabled: true,
  },

  defaultErrorBoundary: ({ error, reset }) => (
    <div className="error">
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
      <button onClick={reset}>Try again</button>
    </div>
  ),

  defaultNotFoundBoundary: ({ notFound }) => (
    <div className="not-found">
      <h2>Not Found</h2>
      <p>{notFound.message}</p>
    </div>
  ),

  notFound: ({ pathname }) => (
    <div className="404">
      <h1>404</h1>
      <p>Page not found: {pathname}</p>
    </div>
  ),

  onError: (error, ctx) => {
    console.error("Router error:", error);
    // Send to error tracking service
  },
});
```

## Environment Types

Define your app's environment type:

```typescript
import type { RouterEnv } from "rsc-router/server";

interface AppBindings {
  DB: D1Database;
  KV: KVNamespace;
  RATE_LIMITER: RateLimiter;
}

interface AppVariables {
  user?: { id: string; name: string };
  permissions?: string[];
}

type AppEnv = RouterEnv<AppBindings, AppVariables>;

const router = createRSCRouter<AppEnv>({
  document: Document,
});
```

## Registering Routes

### routes() - Register route definitions

```typescript
import { homeRoutes } from "./routes/home";
import { shopRoutes } from "./routes/shop";
import { adminRoutes } from "./routes/admin";

const router = createRSCRouter<AppEnv>({ document: Document })
  // Without prefix
  .routes(homeRoutes)
  .map(() => import("./handlers/home"))

  // With prefix
  .routes("/shop", shopRoutes)
  .map(() => import("./handlers/shop"))

  .routes("/admin", adminRoutes)
  .map(() => import("./handlers/admin"));
```

### map() - Register handlers

```typescript
// Async import (code splitting)
.routes(shopRoutes)
.map(() => import("./handlers/shop"))

// Sync definition
.routes(homeRoutes)
.map(() => [
  route("index", () => <HomePage />),
  route("about", () => <AboutPage />),
])

// With the map helper function
import { map } from "rsc-router/server";

// handlers/shop.ts
export default map<typeof shopRoutes>(({ route, layout, loader }) => [
  layout(<ShopLayout />, () => [
    route("index", ShopIndex),
    route("products", ProductList),
  ]),
]);
```

## Global Middleware

### use() - Add middleware

```typescript
const router = createRSCRouter<AppEnv>({ document: Document })
  // Global middleware (all routes)
  .use(loggerMiddleware)
  .use(corsMiddleware)

  // Pattern-based middleware
  .use("/api/*", rateLimiter)
  .use("/admin/*", adminAuthMiddleware)

  // Routes with scoped middleware
  .routes("/shop", shopRoutes)
  .use(shopMiddleware)  // Only applies to shop routes
  .map(() => import("./handlers/shop"));
```

### Middleware patterns

```typescript
"/admin/*"           // All paths under /admin
"/api/*/protected"   // Wildcard in middle
"/checkout.*"        // Routes starting with /checkout
```

## Type-Safe Links with href()

```typescript
const router = createRSCRouter<AppEnv>({ document: Document })
  .routes(homeRoutes)
  .map(() => import("./handlers/home"))
  .routes("/shop", shopRoutes)
  .map(() => import("./handlers/shop"));

// Export for use in components
export const href = router.href;

// Usage with full autocomplete
href("index");                              // "/"
href("about");                              // "/about"
href("shop.products");                      // "/shop/products"
href("shop.products.detail", { slug: "widget" }); // "/shop/products/widget"

// In components
import { href } from "./router";
<Link to={href("shop.cart")}>Cart</Link>
```

## Route Type Registration

For global type inference:

```typescript
// router.ts
const _router = createRSCRouter<AppEnv>({ document: Document })
  .routes(homeRoutes)
  .map(() => import("./handlers/home"))
  .routes("/shop", shopRoutes)
  .map(() => import("./handlers/shop"));

// Extract route types
type AppRoutes = typeof _router.routeMap;

// Augment global types
declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
    interface Env extends AppEnv {}
  }
}

export default _router;
export const href = _router.href;
```

Now handlers have type-safe context without imports.

## Cache Configuration

### Static cache

```typescript
import { createMemorySegmentStore } from "rsc-router/cache";

const cacheStore = createMemorySegmentStore();

const router = createRSCRouter<AppEnv>({
  document: Document,
  cache: {
    store: cacheStore,
    enabled: true,
  },
});
```

### Dynamic cache (per-environment)

```typescript
const router = createRSCRouter<AppEnv>({
  document: Document,
  cache: (env) => ({
    store: env.Bindings.CACHE_KV,
    enabled: env.Bindings.CACHE_ENABLED === "true",
  }),
});
```

### Cloudflare KV cache

```typescript
import { createCFKVSegmentStore } from "rsc-router/cache/cf";

const router = createRSCRouter<AppEnv>({
  document: Document,
  cache: (env) => ({
    store: createCFKVSegmentStore(env.Bindings.CACHE_KV),
    enabled: true,
  }),
});
```

## Document Component

The document wraps the entire app and persists during errors:

```typescript
// document.tsx
"use client";

export function Document({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>My App</title>
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
```

## Router Methods

### match() - Full render

```typescript
const result = await router.match(request, env);
// Returns full render tree with segments, loaders, metadata
```

### matchPartial() - Partial navigation

```typescript
const result = await router.matchPartial(request, env, {
  actionId: "addToCart",
  actionResult: { success: true },
});
// Only re-renders changed segments
```

### matchError() - Error handling

```typescript
const result = await router.matchError(request, env, error);
// Finds nearest error boundary
```

### previewMatch() - Middleware validation

```typescript
const result = await router.previewMatch(request, env);
// Executes middleware without full segment resolution
```

## Complete Router Example

```typescript
// router.ts
import { createRSCRouter } from "rsc-router/server";
import { createMemorySegmentStore } from "rsc-router/cache";
import { Document } from "./document";
import { homeRoutes } from "./routes/home";
import { shopRoutes } from "./routes/shop";
import { adminRoutes } from "./routes/admin";
import { loggerMiddleware, authMiddleware, adminMiddleware } from "./middleware";

const cacheStore = createMemorySegmentStore();

const router = createRSCRouter<AppEnv>({
  document: Document,
  debugPerformance: true,
  cache: { store: cacheStore, enabled: true },
  defaultErrorBoundary: <DefaultError />,
  notFound: ({ pathname }) => <NotFoundPage pathname={pathname} />,
})
  // Global middleware
  .use(loggerMiddleware)

  // Public routes
  .routes(homeRoutes)
  .map(() => import("./handlers/home"))

  // Shop routes (with auth)
  .routes("/shop", shopRoutes)
  .use(authMiddleware)
  .map(() => import("./handlers/shop"))

  // Admin routes (with admin auth)
  .routes("/admin", adminRoutes)
  .use(adminMiddleware)
  .map(() => import("./handlers/admin"));

export default router;
export const href = router.href;
```
