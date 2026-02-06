# Build-Time Router Access: Research Findings

## Problem

We need to access the router instance at build time to:
1. Generate route manifests automatically (no manual build step)
2. Pre-render static routes to HTML
3. Extract prefix trees for optimization
4. Validate routes (conflicts, missing handlers)

Previous attempts at static analysis via Vite plugins failed because the router
file imports TS/TSX dependencies that can't be `import()`-ed without compilation.

## Validated Approach

**Use Vite's RSC environment module runner** (`server.environments.rsc.runner.import()`)
to load the router module at build time with full TS/TSX compilation.

### Why it works

The RSC environment (set up by `@vitejs/plugin-rsc`) has:
- `react-server` export conditions (needed for RSC server code)
- Proper module boundary handling (client components become references)
- Full Vite transform pipeline (TS, TSX, path aliases, node_modules)

### Why ssrLoadModule doesn't work

`ssrLoadModule` uses the SSR environment which:
- Doesn't have `react-server` conditions -> React throws on RSC imports
- OR with `react-server` conditions -> `createContext` is undefined because
  the react-server bundle doesn't export client-only APIs like `createContext`
- The router file transitively imports client components (through route handlers
  that use `Outlet`, `Link`, `useHandle`, etc.) which need regular React

The RSC environment solves this because it treats client component imports as
references (the `"use client"` boundary), never actually evaluating client code.

### POC Results

```
environments.rsc.runner.import("./src/router.tsx")

-> Router instance loaded
-> routeMap: 2 eager routes (home.index, about.index)
-> generateManifest(): 44 total routes (evaluates lazy includes)
-> href("home.index") = "/" (works at build time)
-> Pre-render candidates: all static routes identified
-> Dynamic routes: all parameterized routes identified
-> Prefix tree: full tree generated
```

## Router Discovery

### Brand-based identification

Add a `__brand` property to router instances so the plugin can auto-discover
routers from module exports without requiring a specific export name:

```ts
// createRouter() internally
const router = {
  __brand: "rsc-router" as const,
  ...
};

// Plugin discovery
const mod = await rscEnv.runner.import(routerPath);
const routers = Object.values(mod).filter(v => v?.__brand === "rsc-router");
```

## Multi-Router Support

Users may have separate router files for different concerns:

```
src/
  app-router.tsx      -> createRouter().routes(appUrls)      // /app/*
  docs-router.tsx     -> createRouter().routes(docsUrls)     // /docs/*
  api-router.tsx      -> createRouter().routes(apiUrls)      // /api/*
```

### Design: Router Registry

Each `createRouter()` call registers into a global `RouterRegistry`:

```ts
// Internal
const RouterRegistry = new Map<string, RSCRouter>();

export function createRouter(options) {
  const id = options.id ?? generateId();
  const router = { __brand: "rsc-router", id, ... };
  RouterRegistry.set(id, router);
  return router;
}

export function getRouterRegistry() {
  return RouterRegistry;
}
```

### Plugin configuration

```ts
rscRouter({
  // Multiple router files
  routers: [
    "./src/app-router.tsx",
    "./src/docs-router.tsx",
  ],
  // OR single file (backwards compatible)
  router: "./src/router.tsx",
})
```

At build time the plugin:
1. Imports each file via `rscEnv.runner.import()`
2. Discovers routers by brand
3. Each router gets its own isolated manifest / prefix tree / pre-render set

### Isolation guarantees

- `registerRouteMap()` becomes per-router (not global)
- `generateManifest()` scoped to a single router's `urlpatterns`
- Pre-render candidates are per-router
- No route name collisions between routers (each has its own namespace)

## Static Output: Separate Files Per Router

Each router produces its own isolated static output. No shared files, no
cross-contamination. A router rebuild only regenerates its own artifacts.

### Build output structure

Static files use hashed directory names (`__<hash>`) derived from the router's
file path or id. This avoids collisions with user routes (e.g., a route literally
named `/app`) and clearly marks framework-owned files.

```
dist/
  static/
    __ec387bc704d4/                    # app-router (hash of file path / id)
      manifest.json                    # route map: name -> pattern
      prefixes.json                    # prefix tree for short-circuit matching
      routes.json                      # route name list for href() bootstrap
      pages/
        index.html                     # pre-rendered /
        about.html                     # pre-rendered /about
        shop/
          index.html
          cart.html
    __6ff6aac5e201/                    # docs-router (different hash)
      manifest.json
      prefixes.json
      routes.json
      pages/
        index.html
        getting-started.html
    __a1b2c3d4e5f6/                    # api-router (no pre-render, metadata only)
      manifest.json
      prefixes.json
      routes.json
```

The hash is deterministic — same input always produces the same directory name,
so rebuilds are stable and cache-friendly. The manifest.json contains the
human-readable `id` for debugging.

### Metadata files (per router)

These replace runtime-computed values with pre-built static files:

- **manifest.json** - full route map + generation metadata. Replaces the runtime
  `registerRouteMap()` call that evaluates lazy includes on first request.
- **prefixes.json** - pre-computed prefix tree for `findRouteMatch()` short-circuit
  optimization. Currently built on the fly at startup.
- **routes.json** - flat route name list for `href()` bootstrap. Currently populated
  incrementally as routes are visited.

Cold start goes from "evaluate all route definitions" to "read JSON files."

### Why separate static files matter

1. **Independent deployment** - docs on CDN, app on server, API on edge
2. **Incremental rebuilds** - changing docs routes doesn't rebuild app pages
3. **Runtime serving** - the server checks `dist/static/__<hash>/pages/{path}.html`
   before hitting RSC; prefix tree tells it which router owns which prefix
4. **Cache isolation** - each router's static files have their own cache headers
5. **No collisions** - hashed dirs can't clash with user routes or each other

### Manifest file format

```json
{
  "id": "app",
  "hash": "ec387bc704d4",
  "generatedAt": "2026-02-06T...",
  "routeManifest": {
    "home.index": "/",
    "about.index": "/about",
    "shop.index": "/shop"
  },
  "prefixTree": { ... },
  "preRendered": ["/", "/about", "/shop", "/shop/cart"],
  "dynamic": ["shop.products.detail.view", "blog.post"]
}
```

## Pre-rendering API (Future)

With the live router at build time:

```ts
const router = createRouter({
  id: "app",
  build: {
    // Static routes: auto-discovered from manifest
    preRender: true,

    // Dynamic routes: user provides params
    preRenderPaths: async () => [
      "/blog/hello-world",
      "/blog/getting-started",
      "/products/widget-a",
    ],
  },
}).routes(urlpatterns);
```

The plugin would:
1. Load router via RSC env
2. Call `generateManifest()` -> get all routes
3. Filter static routes (no `:params`)
4. Add user-provided paths from `preRenderPaths`
5. For each path: call `router.match(new Request(path), env)` -> get segments
6. Render segments to HTML -> write to `dist/static/__<hash>/pages/`
7. Write metadata to `dist/static/__<hash>/{manifest,prefixes,routes}.json`

### Runtime static file serving

```ts
// In the server handler (simplified)
// loadedManifests is read once at startup from dist/static/__*/manifest.json
async function handleRequest(req: Request) {
  const url = new URL(req.url);

  // Check each router's prefix tree for a pre-rendered match
  for (const manifest of loadedManifests) {
    if (url.pathname.startsWith(manifest.prefixTree.staticPrefix)) {
      const htmlPath = `dist/static/__${manifest.hash}/pages${url.pathname}.html`;
      if (existsSync(htmlPath)) {
        return new Response(readFileSync(htmlPath), {
          headers: { "content-type": "text/html" },
        });
      }
    }
  }

  // No static match -> fall through to RSC rendering
  return router.fetch(req, env);
}
```

## Implementation Path

1. Add `__brand: "rsc-router"` to `createRouter()` return value
2. Add `id` option to `createRouter()`; derive deterministic hash from id/file path
3. Create `RouterRegistry` (scoped `registerRouteMap` per router)
4. In rscRouter plugin's `buildStart` or `configureServer`:
   load router files via `server.environments.rsc.runner.import()`
5. Extract manifests, prefix trees per router
6. Write metadata to `dist/static/__<hash>/` per router
   (manifest.json, prefixes.json, routes.json)
7. Pre-render static routes via `router.match()` + RSC rendering
8. Write HTML to `dist/static/__<hash>/pages/` per router
9. At runtime, load metadata from `dist/static/__*/manifest.json` on startup
   (replaces runtime route evaluation with static file reads)
