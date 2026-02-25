---
name: router-setup
description: Create and configure the RSC router with createRouter
argument-hint: [option]
---

# Router Setup with createRouter

## Basic Router Creation

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "./document";
import { urlpatterns } from "./urls";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
});

export default router;
```

## URL Patterns (Django-style)

```typescript
// src/urls.tsx
import { urls } from "@rangojs/router";
import { HomePage } from "./pages/home";
import { AboutPage } from "./pages/about";
import { ProductPage } from "./pages/product";
import { RootLayout } from "./layouts/RootLayout";

export const urlpatterns = urls(({ path, layout, loader, loading }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),

  layout(<RootLayout />, () => [
    path("/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader),
      loading(<ProductSkeleton />),
    ]),
  ]),
]);
```

## The urls() DSL

The `urls()` function provides a callback with all available DSL functions:

```typescript
urls(
  ({
    path, // Define a route
    layout, // Wrap routes in a layout
    parallel, // Define parallel routes (slots)
    loader, // Add data loader
    loading, // Add loading skeleton
    cache, // Configure caching
    middleware, // Add middleware
    revalidate, // Control revalidation
    intercept, // Intercept routes for modals
    when, // Conditional rendering
  }) => [
    // Route definitions here
  ],
);
```

## Router Options

```typescript
interface RSCRouterOptions<TEnv> {
  // URL patterns from urls() function
  urls: UrlPatterns;

  // Document component wrapping entire app
  document?: ComponentType<{ children: ReactNode }>;

  // Enable performance metrics
  debugPerformance?: boolean;

  // Default error boundary
  defaultErrorBoundary?: ReactNode | ErrorBoundaryHandler;

  // Default not-found boundary
  defaultNotFoundBoundary?: ReactNode | NotFoundBoundaryHandler;

  // Component for 404 routes
  notFound?: ReactNode | ((props: { pathname: string }) => ReactNode);

  // Error logging callback
  onError?: OnErrorCallback<TEnv>;

  // Global cache configuration
  cache?: CacheConfig<TEnv>;

  // Theme configuration
  theme?: ThemeConfig | true;

  // Connection warmup (default: true)
  warmup?: boolean;

  // CSP nonce provider (for router.fetch)
  nonce?: (
    request: Request,
    env: TEnv,
  ) => string | true | Promise<string | true>;

  // RSC version string (for router.fetch)
  version?: string;
}
```

## Using the Request Handler

The router provides a `fetch` method to handle RSC requests:

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "./document";
import { urlpatterns } from "./urls";

export const router = createRouter({
  document: Document,
  urls: urlpatterns,
  nonce: () => true, // Auto-generate nonce for CSP
});

// src/worker.tsx (Cloudflare Workers)
import { router } from "./router";

export default { fetch: router.fetch };
```

## Document Component

```typescript
// src/document.tsx
import type { ReactNode } from "react";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>My App</title>
      </head>
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}
```

## Using with Cloudflare Workers

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "./document";
import { urlpatterns } from "./urls";

export const router = createRouter<AppEnv>({
  document: Document,
  urls: urlpatterns,
});

// src/worker.tsx
import { router } from "./router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.fetch(request, { Bindings: env, Variables: {}, ctx });
  },
};
```

### With Dynamic Cache Configuration

For per-request cache configuration (e.g., Cloudflare Workers with ExecutionContext):

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";

export const router = createRouter<AppEnv>({
  document: Document,
  urls: urlpatterns,
  // Cache config receives env with ctx for ExecutionContext access
  cache: (env) => ({
    store: new CFCacheStore({ ctx: env.ctx, defaults: { ttl: 60 } }),
  }),
});

// src/worker.tsx
import { router } from "./router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.fetch(request, { Bindings: env, Variables: {}, ctx });
  },
};
```

## Complete Example

```typescript
// src/urls.tsx
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

// Pages
import { HomePage } from "./pages/home";
import { AboutPage } from "./pages/about";
import { BlogIndexPage, BlogPostPage } from "./pages/blog";

// Layouts
import { RootLayout } from "./layouts/RootLayout";
import { BlogLayout } from "./layouts/BlogLayout";

// Loaders
import { BlogPostLoader, BlogSidebarLoader } from "./loaders/blog";

export const urlpatterns = urls(({ path, layout, parallel, loader, loading, cache }) => [
  // Simple routes
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),

  // Blog with layout and loaders
  layout(<BlogLayout />, () => [
    // Sidebar as parallel route
    parallel({ "@sidebar": () => <BlogSidebar /> }, () => [
      loader(BlogSidebarLoader),
    ]),

    // Cached blog routes
    cache({ ttl: 60 }, () => [
      path("/blog", BlogIndexPage, { name: "blog" }),
      path("/blog/:slug", BlogPostPage, { name: "blogPost" }, () => [
        loader(BlogPostLoader),
        loading(<BlogPostSkeleton />),
      ]),
    ]),
  ]),
]);
```

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "./document";
import { urlpatterns } from "./urls";

const router = createRouter({
  document: Document,
  urls: urlpatterns,

  defaultErrorBoundary: ({ error, reset }) => (
    <div>
      <h1>Something went wrong</h1>
      <button onClick={reset}>Try again</button>
    </div>
  ),

  notFound: ({ pathname }) => (
    <div>
      <h1>404</h1>
      <p>Page not found: {pathname}</p>
    </div>
  ),
});

export default router;
```

## Including Sub-patterns

```typescript
// src/urls/shop.tsx
import { urls } from "@rangojs/router";

export const shopPatterns = urls(({ path, layout }) => [
  path("/", ShopIndex, { name: "index" }),
  path("/product/:slug", ProductPage, { name: "product" }),
]);

// src/urls.tsx
import { urls, include } from "@rangojs/router";
import { shopPatterns } from "./urls/shop";

export const urlpatterns = urls(({ path }) => [
  path("/", HomePage, { name: "home" }),
  include("/shop", shopPatterns, { name: "shop" }),
]);
```

## Environment Types

```typescript
import type { RouterEnv } from "@rangojs/router";

interface AppBindings {
  DB: D1Database;
  KV: KVNamespace;
}

interface AppVariables {
  user?: { id: string; name: string };
}

type AppEnv = RouterEnv<AppBindings, AppVariables>;

const router = createRouter<AppEnv>({
  document: Document,
  urls: urlpatterns,
});
```

## Connection Warmup

Enabled by default. Keeps TCP+TLS connections alive so navigations after idle periods
don't pay handshake costs.

After 60s of no user interaction, the connection is marked cold. When the user returns
(tab becomes visible or first mouse/touch), a `HEAD ?_rsc_warmup` request re-establishes
the TLS connection before the next navigation. The server responds with 204 No Content
before any middleware or routing runs.

```typescript
// Enabled by default
const router = createRouter({
  document: Document,
  urls: urlpatterns,
});

// Disable warmup
const router = createRouter({
  document: Document,
  urls: urlpatterns,
  warmup: false,
});
```

The warmup request is relative to the current page path, so it works correctly
with subpath deployments (reverse proxy, base path).
