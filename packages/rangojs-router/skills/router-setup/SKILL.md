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
    intercept, // Intercept routes for modals (conditional via intercept(..., { when }))
    errorBoundary, // Add an error boundary
    notFoundBoundary, // Add a not-found boundary
    transition, // Configure view transitions
  }) => [
    // Route definitions here
  ],
);
```

## Router Options

```typescript
interface RangoOptions<TEnv> {
  // URL patterns from urls() function
  urls: UrlPatterns;

  // Document component wrapping entire app
  document?: ComponentType<{ children: ReactNode }>;

  // URL prefix for sub-path deployments (e.g. "/admin")
  // All routes, reverse(), href(), Link, redirect(), and router.use()
  // patterns are automatically prefixed. Route names stay unprefixed.
  basename?: string;

  // Enable per-request performance timeline (console waterfall + Server-Timing header)
  debugPerformance?: boolean;

  // Default error boundary
  defaultErrorBoundary?: ReactNode | ErrorBoundaryHandler;

  // Default not-found boundary for notFound() thrown in handlers/loaders
  defaultNotFoundBoundary?: ReactNode | NotFoundBoundaryHandler;

  // Component for 404 (no route match, or notFound() without a boundary)
  notFound?: ReactNode | ((props: { pathname: string }) => ReactNode);

  // Error logging callback
  onError?: OnErrorCallback<TEnv>;

  // Global cache configuration
  cache?: CacheConfig<TEnv>;

  // Theme configuration
  theme?: ThemeConfig | true;

  // SSR options (streaming policy)
  ssr?: SSROptions<TEnv>;

  // Telemetry sink for structured lifecycle events
  telemetry?: TelemetrySink;

  // Connection warmup (default: true)
  warmup?: boolean;

  // Prefetch cache TTL in seconds (default: 300)
  // Controls in-memory cache duration and Cache-Control max-age for prefetch responses.
  // Set to false to disable prefetch caching.
  prefetchCacheTTL?: number | false;

  // CSP nonce provider (for router.fetch)
  nonce?: (
    request: Request,
    env: TEnv,
  ) => string | true | Promise<string | true>;

  // RSC version string (for router.fetch)
  version?: string;
}
```

## Basename (Sub-Path Deployment)

When your app is served under a sub-path (e.g. `/admin` or `/v2`), set `basename`:

```typescript
const router = createRouter({
  basename: "/admin",
  document: Document,
}).routes(({ path, include }) => [
  path("/", Dashboard, { name: "home" }), // matches /admin
  path("/users", Users, { name: "users" }), // matches /admin/users
  include("/api", apiPatterns, { name: "api" }), // matches /admin/api/*
]);

router.reverse("home"); // "/admin"
router.reverse("users"); // "/admin/users"
```

Router-owned APIs are basename-aware:

- `reverse()` returns prefixed paths
- `<Link to="/users">` renders `<a href="/admin/users">`
- `redirect("/login")` redirects to `"/admin/login"`
- `router.use("/users/*", mw)` matches `/admin/users/*`
- `useRouter().push("/users")` navigates to `/admin/users`
- Route names stay unprefixed (`"home"`, not `"admin.home"`)

Note: `href()` is a raw path helper and does **not** auto-prefix with basename.
Use `reverse()` or `<Link>` for basename-aware URLs.

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

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
});

// src/worker.tsx
import { router } from "./router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.fetch(request, { env, ctx });
  },
};
```

### With Dynamic Cache Configuration

For per-request cache configuration (e.g., Cloudflare Workers with ExecutionContext):

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  // Cache config receives (env, ctx) separately
  cache: (_env, ctx) => ({
    store: new CFCacheStore({ ctx: ctx!, defaults: { ttl: 60 } }),
  }),
});

// src/worker.tsx
import { router } from "./router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.fetch(request, { env, ctx });
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

## Not Found Handling

Two distinct 404 scenarios:

**1. No route matches the URL** — the router renders the `notFound` component from `createRouter()` config. This is automatic.

**2. A handler/loader calls `notFound()`** — signals that the route matched but the data doesn't exist (e.g., invalid product ID).

```typescript
import { notFound } from "@rangojs/router";

// In a handler or loader
path("/product/:slug", async (ctx) => {
  const product = await db.getProduct(ctx.params.slug);
  if (!product) notFound("Product not found");
  return <ProductPage product={product} />;
});
```

### Fallback chain for `notFound()`

When `notFound()` is thrown, the router looks for a fallback in this order:

1. **`notFoundBoundary()`** — nearest boundary in the route tree (route-level)
2. **`defaultNotFoundBoundary`** — from `createRouter()` config (app-level)
3. **`notFound`** — from `createRouter()` config (same component used for no-route-match)
4. **Default `<h1>Not Found</h1>`** — built-in fallback

All cases set HTTP 404 status.

### notFoundBoundary

Wrap routes with `notFoundBoundary()` for route-specific not-found UI:

```typescript
urls(({ path, layout }) => [
  layout(ShopLayout, () => [
    notFoundBoundary(({ notFound: info }) => (
      <div>
        <h1>Not Found</h1>
        <p>{info.message}</p>
      </div>
    )),
    path("/product/:slug", ProductPage),
  ]),
]);
```

`notFoundBoundary` receives `{ notFound: NotFoundInfo }` where `NotFoundInfo` contains `message`, `segmentId`, `segmentType`, and `pathname`.

## Including Sub-patterns

```typescript
// src/urls/shop.tsx
import { urls } from "@rangojs/router";

export const shopPatterns = urls(({ path, layout }) => [
  path("/", ShopIndex, { name: "index" }),
  path("/product/:slug", ProductPage, { name: "product" }),
]);

// src/urls.tsx
import { urls } from "@rangojs/router";
import { shopPatterns } from "./urls/shop";

export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/shop", shopPatterns, { name: "shop" }),
]);
```

`include()` also accepts an async provider to code-split that group into its own
chunk, imported on the first request reaching the prefix instead of at startup:

```typescript
// urls/shop.tsx: `export default shopPatterns`
include("/shop", () => import("./urls/shop"), { name: "shop" }),
```

Build-time discovery still `await`s the provider, so route types, `href()`, and
prerender see every route in the split group. Reach for it when a group is a
large, independently-loadable unit — see `/composability`.

## Environment Types

```typescript
// Bindings passed as TEnv to createRouter<TEnv>()
interface AppBindings {
  DB: D1Database;
  KV: KVNamespace;
}

// Variables declared via global namespace augmentation
interface AppVariables {
  user?: { id: string; name: string };
}

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
});

// Register types globally for implicit typing
declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
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

## Telemetry

The router emits structured lifecycle events through a pluggable telemetry sink.
Zero overhead when not configured.

```typescript
// Console sink for development
import { createRouter, createConsoleSink } from "@rangojs/router";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  telemetry: createConsoleSink(),
});
```

```typescript
// OpenTelemetry for production: phase spans via the tracing slot,
// discrete-fact spans via the telemetry sink.
import {
  createRouter,
  createOTelTracing,
  createOTelSink,
} from "@rangojs/router";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("my-app");

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  tracing: createOTelTracing(tracer),
  telemetry: createOTelSink(tracer),
});
```

```typescript
// On Cloudflare Workers, swap the tracing factory for native custom spans
// (no @opentelemetry/api dependency); the telemetry slot is unchanged.
import { createCloudflareTracing } from "@rangojs/router/cloudflare";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  tracing: createCloudflareTracing(), // { spans: { ssr: false } } to toggle phases
});
```

```typescript
// Custom sink
const router = createRouter({
  telemetry: {
    emit(event) {
      // Send to any observability backend
      myTracer.record(event);
    },
  },
});
```

Events emitted: `request.start/end/error`, `loader.start/end/error`,
`handler.error`, `cache.decision`, `revalidation.decision`.

## SSR Streaming Policy

Control whether HTML SSR responses stream progressively or wait for all content:

```typescript
import { createRouter, type SSRStreamMode } from "@rangojs/router";

const router = createRouter({
  ssr: {
    resolveStreaming: ({ request }) => {
      const ua = request.headers.get("user-agent") ?? "";
      // Bots that can't process streamed HTML get a fully resolved page
      if (/Googlebot|bingbot/i.test(ua)) return "allReady";
      return "stream";
    },
  },
});
```

`SSRStreamMode` is `"stream" | "allReady"`:

- `"stream"` (default) — flush HTML as React renders. Suspense fallbacks appear first, then resolved content streams in. Best for real users (fastest TTFB).
- `"allReady"` — await `stream.allReady` before flushing. The full page arrives in one shot. Use for bots that cannot execute JavaScript or process chunked HTML.

The resolver receives `{ request, env, url }` and may be sync or async. It only runs on HTML SSR paths — RSC partials, `__rsc` requests, and response routes are unaffected.

When `resolveStreaming` is not configured, the default is `"stream"`.
