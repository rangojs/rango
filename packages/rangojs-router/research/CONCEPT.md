# Build-Time Router Access

## Core Insight

Instead of complex Vite plugin static analysis to understand routes, we use
Vite's RSC environment module runner to import the user's router file at
dev/build time. This gives us a live, fully-constructed router instance --
the same one that handles requests at runtime -- with zero extra configuration.

The RSC environment has full TS/TSX compilation, `react-server` export conditions,
and treats `"use client"` imports as references (never evaluating client code).
This is why `ssrLoadModule` fails but the RSC runner succeeds.

## What Works Today

### Router Registry & Brand Discovery

Every `createRouter()` call:
1. Assigns a `__brand: "__rsc_router__"` for identification
2. Assigns an `id` (user-provided or auto-generated `router_0`, `router_1`, ...)
3. Registers itself in the global `RouterRegistry` (Map keyed by id)

```ts
// User code
export const router = createRouter({ id: "app" }).routes(urlpatterns);

// Plugin discovery (via RSC env)
const serverMod = await rscEnv.runner.import("@rangojs/router/server");
const registry = serverMod.RouterRegistry;
// => Map { "app" => RSCRouter }
```

### Dev-Time Discovery Plugin

The `createRouterDiscoveryPlugin` runs in `configureServer`:

1. Imports the user's router file via `server.environments.rsc.runner.import()`
2. This triggers `createRouter()` which populates `RouterRegistry`
3. For each router, calls `generateManifest(router.urlpatterns)` to extract all routes
   (including lazy includes -- 44 routes in demo vs 2 eagerly-registered)
4. Calls `setCachedManifest()` so `href()` works immediately without first-request penalty

Output at dev startup:
```
[rsc-router] Discovered router: "router_0"
[rsc-router]   44 routes (32 static, 12 dynamic)
```

### What the Manifest Contains

`generateManifest(urlpatterns)` returns:

```ts
{
  prefixTree: {
    // Nested prefix tree for short-circuit route matching
    "": { staticPrefix: "/", routes: ["home.index", "about.index", ...], children: {
      "shop/": { staticPrefix: "/shop/", routes: ["shop.index", ...], children: { ... } },
      "blog/": { ... },
    }},
  },
  routeManifest: {
    // Complete route name -> URL pattern mapping
    "home.index": "/",
    "about.index": "/about",
    "shop.index": "/shop",
    "shop.products.list": "/shop/products",
    "shop.products.detail.view": "/shop/products/:productId",
    // ... all 44 routes
  },
  generatedAt: "2026-02-06T..."
}
```

## Current Runtime Behavior (What We Want to Replace)

### Route Map

At runtime, the route map (`routeName -> pattern`) is built in two ways:

1. **Eager registration**: `registerRouteMap()` is called during URL pattern evaluation.
   Only catches top-level routes, not lazy includes. (2 routes in demo)
2. **Lazy manifest**: On first request, `route-manifest-cache.ts` calls `generateManifest()`
   which evaluates all includes. This takes ~98ms and is cached in memory / edge cache.

The discovery plugin eliminates the first-request penalty by eagerly generating
the manifest at dev startup. For production builds, we can write it to a static file.

### Prefix Tree

The prefix tree enables short-circuit route matching -- if a request URL doesn't
match any prefix, the router can skip that entire subtree. Currently built at
runtime alongside the manifest.

## Next Steps: Static File Output

### Route Names Map (`routes.json`)

A flat map of route name to URL pattern, consumed by `href()` at runtime:

```json
{
  "home.index": "/",
  "about.index": "/about",
  "shop.index": "/shop",
  "shop.products.list": "/shop/products",
  "shop.products.detail.view": "/shop/products/:productId"
}
```

**What this replaces**: The runtime `registerRouteMap()` + lazy `generateManifest()` flow.
At startup, the server reads `routes.json` and calls `setCachedManifest()` once.
Cold start goes from "evaluate all route definitions" to "read one JSON file".

### Prefix Tree (`prefixes.json`)

The pre-computed prefix tree for `findRouteMatch()` optimization:

```json
{
  "": {
    "staticPrefix": "/",
    "fullPrefix": "",
    "routes": ["home.index", "about.index"],
    "children": {
      "shop/": {
        "staticPrefix": "/shop/",
        "fullPrefix": "shop/",
        "routes": ["shop.index", "shop.cart"],
        "children": { ... }
      }
    }
  }
}
```

**What this replaces**: Runtime prefix tree construction during manifest generation.

### Per-Router Isolation

Each router's static files live in a hashed directory:

```
dist/static/
  __ec387bc704d4/     # hash of router id or file path
    routes.json       # route name -> pattern
    prefixes.json     # prefix tree
    manifest.json     # combined metadata (future)
```

Multiple routers get separate directories, no collisions, independent cache headers,
incremental rebuilds.

## Dev Mode vs Build Mode

### Dev Mode (current)

The discovery plugin runs in `configureServer`. The RSC environment is available
because `@vitejs/plugin-rsc` sets it up. Discovery is fire-and-forget --
it runs asynchronously after the server starts, populating the manifest in memory
via `setCachedManifest()`. No files are written to disk.

This follows the same pattern as `createLoader` and `createHandle`:
- Module evaluation triggers registration (at import time in RSC env)
- A module-level registry stores the instances
- The Vite plugin triggers the import and reads the registry

### Build Mode (future)

Will use a similar mechanism but in `buildStart` or a custom build hook:
1. Create a temporary Vite server with `createServer({ server: { middlewareMode: true } })`
2. Use `server.environments.rsc.runner.import()` to load the router
3. Generate manifests per router
4. Write static files to `dist/static/__<hash>/`
5. Close the temporary server

The build output replaces runtime computation with static file reads.

## Architecture Decisions

### Why RSC Environment (not SSR, not raw import)

| Approach | Result |
|----------|--------|
| `import()` | Fails - TS/TSX not compiled |
| `ssrLoadModule()` | Fails - no `react-server` conditions |
| `ssrLoadModule()` + react-server | Fails - `createContext` undefined (client APIs missing) |
| `rscEnv.runner.import()` | Works - full pipeline, client refs, react-server conditions |

The RSC environment treats `"use client"` imports as references, never evaluating
client code. This solves the chicken-and-egg problem: the router file transitively
imports client components (Outlet, Link, useHandle) through route handlers, but
those are replaced with module references in the RSC environment.

### Why Registry (not module export scanning)

Brand-based discovery (`__brand === "__rsc_router__"`) from module exports works
for single-file routers. But with multi-router setups (app, docs, api in separate
files), the `RouterRegistry` provides a single source of truth regardless of how
many files are imported or what the exports are named.

### Why Eager Manifest (not lazy)

The current lazy approach (generate on first request, cache) adds ~98ms to the
first request. In serverless environments (Cloudflare Workers, AWS Lambda),
every cold start pays this cost. Eagerly generating the manifest at dev/build time
eliminates this entirely.

## Implementation Status

- [x] `RSC_ROUTER_BRAND` constant
- [x] `RouterRegistry` global Map
- [x] `id` option on `createRouter()`
- [x] `__brand` and `id` on `RSCRouter` interface
- [x] Auto-registration in `RouterRegistry` at creation time
- [x] `createRouterDiscoveryPlugin` in Vite plugin
- [x] Dev-time discovery via `configureServer`
- [x] Manifest generation + `setCachedManifest()` for eager `href()`
- [x] Validated with demo app (44 routes, 32 static, 12 dynamic)
- [ ] Write `routes.json` static file
- [ ] Write `prefixes.json` static file
- [ ] Hashed directory creation (`dist/static/__<hash>/`)
- [ ] Build-mode discovery (`buildStart`)
- [ ] Runtime static file loading (replace lazy evaluation)
- [ ] Pre-rendering static routes to HTML
- [ ] Multi-router plugin configuration (`routers: [...]`)
