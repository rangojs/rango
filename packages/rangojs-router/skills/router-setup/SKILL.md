---
name: router-setup
description: Create and configure a Rango app with createRouter() and the rango() Vite plugin. Use when bootstrapping a new app, wiring vite.config, writing the Document or worker entry, or setting top-level router options (basename, cache store, prefetch, timeouts, origin check, telemetry, SSR streaming).
argument-hint: [option]
---

# Router Setup with createRouter

This skill covers the app skeleton: the Vite plugin, the router module, the
Document, the request entry, and every top-level `createRouter()` and `rango()`
option. Route-level features (loaders, caching, middleware, intercepts) have
their own skills; start at `/rango` for the map.

## Minimal app

On the default Node preset an app needs a Vite config, a router module, and a
`urls()` module (plus your page components). `rango()` finds the router by
scanning for the single `createRouter()` call and generates the client, SSR,
and RSC entries, so there is no `index.html` and no entry file to write. The
`document` option is optional (see [Document component](#document-component)).

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig(({ command }) => ({
  plugins: [rango()],
  // Node preset only: fold NODE_ENV so SSR/RSC ship only React's production
  // build. The cloudflare and vercel presets do this for you (see /bundle-analysis).
  define:
    command === "build"
      ? { "process.env.NODE_ENV": JSON.stringify("production") }
      : undefined,
}));
```

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "./document";
import { urlpatterns } from "./urls";

// Node and Vercel presets import the NAMED `router` export from this module.
// A default-only export is not picked up.
export const router = createRouter({
  document: Document,
  urls: urlpatterns,
});
```

```typescript
// src/urls.tsx
import { urls } from "@rangojs/router";
import { HomePage } from "./pages/home";
import { AboutPage } from "./pages/about";

export const urlpatterns = urls(({ path }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
]);
```

`@vitejs/plugin-react` is optional: `rango()` works on its own. Add
`react()` before `rango()` when you want its features, such as the React
Compiler (`/react-compiler`). For Workers use `/cloudflare`; for Vercel
Functions use `/vercel`.

## URL patterns (Django-style)

```typescript
// src/urls.tsx
import { urls } from "@rangojs/router";
import { HomePage } from "./pages/home";
import { AboutPage } from "./pages/about";
import { ProductPage } from "./pages/product";
import { ProductSkeleton } from "./pages/product-skeleton";
import { RootLayout } from "./layouts/RootLayout";
import { ProductLoader } from "./loaders/product";

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

`urls()` passes every DSL helper to its callback. Destructure the ones you use:

```typescript
urls(
  ({
    path, // Define a route; also path.json/.text/.html/.xml/.md/.image/.stream/.any (/response-routes)
    layout, // Wrap routes in a layout (/layout)
    include, // Mount another urls() module under a prefix (/composability)
    parallel, // Named slots rendered alongside the outlet (/parallel)
    intercept, // Soft-navigation overlays such as modals (/intercept)
    loader, // Attach a data loader (/loader)
    loading, // Loading fallback for a segment
    cache, // Segment caching (/caching)
    middleware, // Route middleware (/middleware)
    revalidate, // Choose which segments re-render after navigation/actions
    errorBoundary, // Error fallback for a segment
    notFoundBoundary, // Fallback for notFound() thrown below it
    transition, // startTransition driving + view transitions (/view-transitions)
  }) => [
    // Route definitions here
  ],
);
```

## Router options

Every `createRouter()` option, grouped by concern. All are optional.

```typescript
interface RangoOptions<TEnv> {
  // --- Structure ---
  urls?: UrlPatterns | UrlBuilder; // urls() result, or the builder fn directly
  document?: ComponentType<{ children: ReactNode }>; // "use client" Document; a default is used when omitted
  basename?: string; // Sub-path prefix, e.g. "/admin" (see Basename)
  id?: string; // Router id; namespaces build output and route maps. Auto-generated.

  // --- Fallbacks and errors ---
  defaultErrorBoundary?: ReactNode | ErrorBoundaryHandler; // When no errorBoundary() matches
  defaultNotFoundBoundary?: ReactNode | NotFoundBoundaryHandler; // When no notFoundBoundary() matches
  notFound?: ReactNode | ((props: { pathname: string }) => ReactNode); // 404 page
  onError?: OnErrorCallback<TEnv>; // Logging/reporting hook; cannot change the response

  // --- Caching ---
  cache?:
    | {
        store: SegmentCacheStore;
        enabled?: boolean;
        searchParams?: CacheSearchParams;
      }
    | ((
        env: TEnv,
        ctx?: ExecutionContext,
      ) => {
        store: SegmentCacheStore;
        enabled?: boolean;
        searchParams?: CacheSearchParams;
      });
  cacheProfiles?: Record<
    string,
    { ttl: number; swr?: number; tags?: string[] }
  >; // "use cache: <name>" (/use-cache)

  // --- Client navigation and prefetch ---
  defaultPrefetch?: "hover" | "viewport" | "render" | "adaptive" | "none"; // dev: "none", prod: "viewport"
  prefetchCacheTTL?: number | false; // Seconds (default 300). false disables all prefetching.
  prefetchCacheSize?: number; // Max cached prefetch payloads, FIFO (default 100)
  prefetchConcurrency?: number; // Max concurrent viewport/render prefetches (default 2)
  viewTransition?: "auto" | false; // Router-placed <ViewTransition> default (/view-transitions)
  warmup?: boolean; // Connection warmup after idle (default true)
  strictMode?: boolean; // Hydrate inside <React.StrictMode> (default true)
  stateCookiePrefix?: string; // Prefix of the state cookie `{prefix}_{routerId}` (default "rango-state")

  // --- Request handling ---
  nonce?: (
    request: Request,
    env: TEnv,
  ) => string | boolean | Promise<string | boolean>;
  version?: string; // Client/server version string; defaults to the build VERSION
  originCheck?:
    | boolean
    | ((
        ctx: OriginCheckContext<TEnv>,
      ) => boolean | Response | Promise<boolean | Response>); // default true
  timeout?: number; // ms; shorthand for timeouts.actionMs + timeouts.renderStartMs
  timeouts?: {
    actionMs?: number;
    renderStartMs?: number;
    streamIdleMs?: number;
  };
  onTimeout?: (ctx: TimeoutContext<TEnv>) => Response | Promise<Response>;
  ssr?: {
    resolveStreaming?: (
      ctx: ResolveStreamingContext<TEnv>,
    ) => SSRStreamMode | Promise<SSRStreamMode>;
  };
  theme?: ThemeConfig | true; // Light/dark theme support (/theme)

  // --- Observability and debugging ---
  debugPerformance?: boolean; // Console waterfall + Server-Timing (/observability)
  telemetry?: TelemetrySink; // Structured lifecycle events (/observability)
  tracing?: RouterTracingConfig; // Phase spans: createOTelTracing / createCloudflareTracing / createVercelTracing
  debugCacheSignal?: boolean; // Dev/test only: X-Rango-Cache header for cache assertions (/testing)
  debugShellCapture?: boolean | ((event: ShellCaptureDebugEvent) => void); // PPR capture diagnostics (/ppr)
}
```

## Vite plugin options

`rango()` takes one options object. `preset` picks the deployment target; the
options below apply to every preset. Values shown are the defaults unless
noted.

```typescript
import { rango } from "@rangojs/router/vite";

rango({
  preset: "node", // "node" | "cloudflare" | "vercel"
  banner: true, // Print the startup banner
  clientChunks: true, // Per-route client chunk splitting; false, or a function
  headScripts: "preinit", // "preinit" (executing head module scripts) | "preload" (modulepreload hints only)
  prerender: { onError: "fail" }, // "fail" | "warn" when a Prerender/Static render throws (/prerender)
  buildEnv: false, // Build-time ctx.env for Prerender/Static handlers (/prerender)
});
```

Preset-specific options:

- `buildEnv`: an object, or a factory `({ root, mode, command, preset }) =>
({ env, dispose? })`, on every preset; `"auto"` (Wrangler platform proxy)
  on `cloudflare` only.
- `hostRouter` (`node`, `vercel`): path to a module that exports a
  `createHostRouter()` instance, for multi-app hosts (`/host-router`). Without
  it, rango auto-detects a single `createHostRouter()` file when it finds
  several `createRouter()` files.
- `vercel` (`vercel`): `{ runtime, maxDuration, memory, regions, functionName }`
  for the generated function (`/vercel`).

Notes:

- `clientChunks` default groups app client components by the directory after a
  route root (`routes/`, `app/`, `pages/`, `features/`, `handlers/`, ...), so
  `routes/dashboard/**` becomes chunk `app-dashboard`. Flat folders such as
  `src/components/` stay in the shared chunk. `false` restores
  `@vitejs/plugin-rsc`'s grouping (one client chunk per router). A function
  `(meta) => string | undefined` names the group per module (`undefined` keeps
  the default); `directoryClientChunks(meta)`, the default strategy, is
  exported from `@rangojs/router/vite` to fall back to.
- `discovery: { include?, exclude? }` filters which files the route-discovery
  scan reads, as root-relative globs (e.g. `include: ["src/routes/**"]`).
  `exclude` replaces the default excludes (`__tests__`, `__mocks__`, `dist`,
  `coverage`, `*.test.*`, `*.spec.*`) rather than adding to them.
- `progressiveChunkSize` sets React's Fizz `progressiveChunkSize` for document
  renders and PPR shell capture. Unset, documents whose route has a
  `loader(Def, { ssr: false })` raise it automatically so that content stays
  in place; see `/loader`.
- `@rangojs/router/vite` also exports `poke()`, a dev-server plugin: type `e`
  then Enter (or Ctrl+R where the terminal passes it through) to full-reload
  the browser.

## Document component

The Document renders `<html>`, `<head>`, and `<body>` around every page and
every error state. It must be a client component. Include `<MetaTags />` (it
emits the default `charset`/`viewport` tags, `Meta` handle output, and the
theme script) and `<Scripts />` (the `Script` handle, see `/scripts`):

```tsx
// src/document.tsx
"use client";

import type { ReactNode } from "react";
import { MetaTags, Scripts } from "@rangojs/router/client";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <MetaTags />
        <Scripts />
      </head>
      <body>
        <Scripts position="body" />
        {children}
      </body>
    </html>
  );
}
```

When `document` is omitted, the router uses exactly this default. Page titles
and other per-route tags come from the `Meta` handle, not from the Document.
Stylesheets and fonts: `/css`, `/tailwind`, `/fonts`.

## Serving requests

`router.fetch(request, input?)` is the request handler. `input` is
`{ env?, ctx?, vars? }`: bindings, the platform `ExecutionContext` (used for
`waitUntil`, `CFCacheStore`, and Cloudflare tracing), and optional initial
context variables.

- **Node and Vercel presets:** rango owns the server entry. It imports the
  named `router` export and calls it for you. Write no entry file.
- **Cloudflare preset:** you own the Worker entry. Pass `env` and `ctx`
  explicitly:

```typescript
// src/worker.rsc.tsx
import { router } from "./router";
import type { AppBindings } from "./env";

export default {
  fetch(request, env, ctx) {
    return router.fetch(request, { env, ctx });
  },
} satisfies ExportedHandler<AppBindings>;
```

Do not write `export default { fetch: router.fetch }` on Workers. The runtime
calls `fetch(request, env, ctx)`, so the bindings object would land in the
`input` slot: handlers see an empty `ctx.env`, and the `ExecutionContext` is
lost. See `/cloudflare` for
the full Workers setup.

## Basename (sub-path deployment)

When the app is served under a sub-path (e.g. `/admin` or `/v2`), set `basename`:

```typescript
export const router = createRouter({
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

`href()` is a raw path helper and does **not** add the basename. Use
`reverse()` or `<Link>` for basename-aware URLs.

## Cache store configuration

Pass a static config, or a factory when the store needs per-request bindings.
The factory receives `(env, ctx)`; `ctx` is typed optional, so assert it where
the platform always provides it:

```typescript
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (_env, ctx) => ({
    store: new CFCacheStore({ ctx: ctx!, defaults: { ttl: 60 } }),
  }),
});
```

`searchParams` controls which query params key the cache (`"all"` by default,
`"none"`, `{ include: [...] }`, or `{ exclude: [...] }`).
`TRACKING_SEARCH_PARAMS` from `@rangojs/router` is a ready-made exclude list
for utm/click-id params. See `/caching` and `/cache-guide`.

## Complete example

```typescript
// src/urls.tsx
import { urls } from "@rangojs/router";

// Pages
import { HomePage } from "./pages/home";
import { AboutPage } from "./pages/about";
import { BlogIndexPage, BlogPostPage, BlogPostSkeleton } from "./pages/blog";

// Layouts and slots
import { BlogLayout } from "./layouts/BlogLayout";
import { BlogSidebar } from "./components/BlogSidebar";

// Loaders
import { BlogPostLoader, BlogSidebarLoader } from "./loaders/blog";

export const urlpatterns = urls(({ path, layout, parallel, loader, loading, cache }) => [
  // Simple routes
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),

  // Blog with layout and loaders
  layout(<BlogLayout />, () => [
    // Sidebar as a parallel slot (the layout renders <ParallelOutlet name="@sidebar" />)
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

export const router = createRouter({
  document: Document,
  urls: urlpatterns,

  // Server-rendered fallback: receives { error } only. There is no reset()
  // for server-side errors, so offer a link or a reload instead.
  defaultErrorBoundary: ({ error }) => (
    <div>
      <h1>Something went wrong</h1>
      <p>{error.message}</p>
      <a href="/">Go home</a>
    </div>
  ),

  notFound: ({ pathname }) => (
    <div>
      <h1>404</h1>
      <p>Page not found: {pathname}</p>
    </div>
  ),
});
```

## Not found handling

Two distinct 404 scenarios:

**1. No route matches the URL.** The router renders the `notFound` option from
`createRouter()` (or `<h1>Not Found</h1>` when unset) with status 404.

**2. A handler or loader calls `notFound()`.** The route matched but the data
does not exist (e.g. an unknown product id).

```typescript
import { createLoader, notFound } from "@rangojs/router";

// In a handler
path("/product/:slug", async (ctx) => {
  const product = await db.getProduct(ctx.params.slug);
  if (!product) notFound("Product not found");
  return <ProductPage product={product} />;
});

// In a loader: data-dependent authority lives with the data
export const ProductLoader = createLoader(async (ctx) => {
  if (!(await exists(ctx.params.slug))) notFound("Product not found");
  return getProduct(ctx.params.slug);
});
```

### Fallback chain for `notFound()`

When `notFound()` is thrown, the router uses the first of:

1. **`notFoundBoundary()`**: nearest boundary in the route tree
2. **`defaultNotFoundBoundary`**: from `createRouter()`
3. **`notFound`**: from `createRouter()` (the same page used for no-route-match)
4. **`<h1>Not Found</h1>`**: built-in fallback

Handler-thrown and no-match 404s always set HTTP status 404. A loader-thrown
`notFound()` on a document request always renders the not-found UI, but the
404 status is set only if the loader rejects before the document Response is
constructed (loaders stream). Register the loader as `loader(Def, { ssr: false })` to
make the 404 status deterministic. On client navigations the 404 UI swaps in
with the URL preserved and the payload stays 200. See `/loader` → "Loader
Authority".

### notFoundBoundary

Wrap routes with `notFoundBoundary()` for route-specific not-found UI:

```typescript
urls(({ path, layout, notFoundBoundary }) => [
  layout(ShopLayout, () => [
    notFoundBoundary(({ notFound: info }) => (
      <div>
        <h1>Not Found</h1>
        <p>{info.message}</p>
      </div>
    )),
    path("/product/:slug", ProductPage, { name: "product" }),
  ]),
]);
```

The handler receives `{ notFound: NotFoundInfo }`: `message`, `segmentId`,
`segmentType`, and `pathname` (optional).

## Including sub-patterns

```typescript
// src/urls/shop.tsx
import { urls } from "@rangojs/router";

export const shopPatterns = urls(({ path }) => [
  path("/", ShopIndex, { name: "index" }),
  path("/product/:slug", ProductPage, { name: "product" }),
]);

// src/urls.tsx
import { urls } from "@rangojs/router";
import { shopPatterns } from "./urls/shop";

export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/shop", shopPatterns, { name: "shop" }), // "shop.index", "shop.product"
]);
```

`include()` also accepts an async provider that code-splits the group into its
own chunk, imported on the first request that reaches the prefix instead of at
startup:

```typescript
// urls/shop.tsx: `export default shopPatterns`
include("/shop", () => import("./urls/shop"), { name: "shop" }),
```

Build-time discovery still awaits the provider, so route types, `href()`, and
prerender see every route in the split group. Reach for it when a group is a
large, independently loadable unit. See `/composability`.

## Environment types

```typescript
// Bindings passed as TEnv to createRouter<TEnv>()
interface AppBindings {
  DB: D1Database;
  KV: KVNamespace;
}

// Context variables set by middleware via ctx.set()
interface AppVariables {
  user?: { id: string; name: string };
}

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
});

// Register once so ctx.env and ctx.get() are typed everywhere
declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}
```

See `/typesafety` for route-name and search-param typing.

## Connection warmup

Enabled by default. It keeps the TCP+TLS connection warm so the first
navigation after an idle period does not pay the handshake.

After 60s without user interaction the connection is marked cold. When the user
returns (tab becomes visible, or first mouse move/touch), the client sends
`HEAD /?_rsc_warmup` to the page's origin. The router answers `204 No Content`
before middleware, nonce resolution, or routing runs. The request only needs to
reach the origin to warm the connection, so it works with `basename` too.

```typescript
// Disable warmup
export const router = createRouter({
  document: Document,
  urls: urlpatterns,
  warmup: false,
});
```

## Telemetry and tracing

Two independent slots. `telemetry` receives discrete lifecycle events;
`tracing` wraps router phases in spans. Both cost nothing when unset.

```typescript
import { createRouter, createConsoleSink } from "@rangojs/router";

export const router = createRouter({
  document: Document,
  urls: urlpatterns,
  telemetry: createConsoleSink(),
});
```

```typescript
// OpenTelemetry: phase spans via tracing, discrete-fact spans via telemetry.
import {
  createRouter,
  createOTelTracing,
  createOTelSink,
} from "@rangojs/router";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("my-app");

export const router = createRouter({
  document: Document,
  urls: urlpatterns,
  tracing: createOTelTracing(tracer),
  telemetry: createOTelSink(tracer),
});
```

```typescript
// Cloudflare Workers: native custom spans, no @opentelemetry/api dependency.
// On Vercel (Node runtime) use createVercelTracing() from @rangojs/router/vercel.
import { createCloudflareTracing } from "@rangojs/router/cloudflare";

export const router = createRouter({
  document: Document,
  urls: urlpatterns,
  tracing: createCloudflareTracing(), // { spans: { ssr: false } } to turn phases off
});
```

```typescript
// Custom sink
export const router = createRouter({
  telemetry: {
    emit(event) {
      myMetrics.record(event);
    },
  },
});
```

Events: `request.start/end/error`, `loader.start/end/error`, `handler.error`,
`cache.decision`, `revalidation.decision`, `request.timeout`, and
`request.origin-rejected`. Span names, attributes, and debugging recipes are in
`/observability`.

## SSR streaming policy

HTML responses stream by default. `ssr.resolveStreaming` picks, per request,
whether to stream or wait for the whole page:

```typescript
import { createRouter, type SSRStreamMode } from "@rangojs/router";

export const router = createRouter({
  ssr: {
    resolveStreaming: ({ request }): SSRStreamMode => {
      const ua = request.headers.get("user-agent") ?? "";
      // Crawlers that cannot process streamed HTML get a fully resolved page
      if (/Googlebot|bingbot/i.test(ua)) return "allReady";
      return "stream";
    },
  },
});
```

`SSRStreamMode` is `"stream" | "allReady"`:

- `"stream"` (default): flush HTML as React renders. Suspense fallbacks appear
  first, then resolved content streams in. Fastest TTFB for real users.
- `"allReady"`: wait for every Suspense boundary (`stream.allReady`) before
  sending bytes. The full page arrives at once.

The resolver receives `{ request, env, url }` and may be async. It runs only
for HTML document responses; RSC payloads (navigations, prefetches, `__rsc`
requests) and response routes are unaffected.

## Timeouts

Off by default. A timed-out action or render start returns a `504` (with an
`X-Rango-Timeout-Phase` header) unless `onTimeout` returns its own response.

```typescript
export const router = createRouter({
  timeout: 10_000, // actionMs + renderStartMs
  timeouts: {
    renderStartMs: 8_000, // overrides the shorthand
    streamIdleMs: 30_000, // opt-in; not covered by `timeout`
  },
  onTimeout: ({ phase }) =>
    Response.json({ error: "timeout", phase }, { status: 504 }),
});
```

- `actionMs`: server action execution.
- `renderStartMs`: time until the response is produced.
- `streamIdleMs`: after handoff, no chunk reached the client for this long.
  The stream is errored and the render canceled; `onTimeout` does not run (the
  response has already started). It is reported via `onError` and the
  `request.timeout` event. A slow client counts as idle too, so use generous
  budgets.

`0` disables a phase. `RouterTimeoutError` is exported from `@rangojs/router`.

## Origin check

On by default. Before running a server action, a fetchable loader, or a
progressive-enhancement form post, the router compares the `Origin` header (or
`Referer`) with `Host` and the request protocol. Requests with neither header
are allowed. `X-Forwarded-*` headers are not trusted.

```typescript
export const router = createRouter<AppBindings>({
  // Behind a proxy that rewrites Host, supply your own rule:
  originCheck: ({ request, url, env, defaultCheck }) => {
    if (!env.TRUST_PROXY) return defaultCheck();
    const origin = request.headers.get("origin");
    if (!origin) return true;
    const host = request.headers.get("x-forwarded-host") ?? url.host;
    return origin === `${url.protocol}//${host}`;
  },
});
```

Return `true` to allow, `false` for the default 403, or a `Response` to reject
with your own. `phase` is `"action" | "loader" | "pe-form"`. `false` disables
the check.

## Other options

- `defaultPrefetch`: strategy for Links without a `prefetch` prop (`/links`).
  Production default `"viewport"` renders every visible Link's route on the
  server; choose `"hover"`, `"adaptive"`, or `"none"` when that cost matters.
- `prefetchCacheTTL`, `prefetchCacheSize`, `prefetchConcurrency`: lifetime,
  entry count, and parallelism of the client prefetch cache.
  `prefetchCacheTTL: false` turns prefetching off entirely, including per-Link
  opt-ins and `useRouter().prefetch()`.
- `strictMode: false`: hydrate without `<React.StrictMode>`, e.g. to get exact
  render counts in development. Production behavior is unchanged.
- `stateCookiePrefix`: rename the state cookie that keys the client caches. The
  `_{routerId}` suffix is always kept so sibling apps on one origin do not
  collide.
- `nonce: () => true`: generate a CSP nonce per request and apply it to the
  router's inline scripts. Return a string to supply your own, or
  `false`/`""` to skip it for one request. Middleware reads it with
  `ctx.get(nonce)` (`nonce` token from `@rangojs/router`).
