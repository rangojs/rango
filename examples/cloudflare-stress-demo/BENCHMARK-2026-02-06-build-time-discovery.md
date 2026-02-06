# Build-Time Router Discovery Plugin

- **Date**: 2026-02-06
- **Commit**: Uncommitted (on `test/extended-bundle-analysis`)
- **Deployed Version**: `1b83ba99-416f-46e5-a423-f0e90783be32`

## Problem Statement

With lazy `include()`, `href()` cannot resolve route names from unevaluated include
groups. The previous approaches had trade-offs:

1. **Runtime 3-tier cache** (`route-manifest-cache.ts`): First request per colo pays
   ~20-100ms to generate the manifest via `generateManifest()`.
2. **Manual build-time manifest**: Required a separate import of `@rangojs/router:route-manifest`
   and added ~7ms startup + 668KB to the bundle.

Neither approach was automatic. Both required manual configuration.

## Solution

Automatic build-time router discovery via a Vite plugin (`createRouterDiscoveryPlugin`).

The plugin:
1. In **build mode** (`buildStart`): Creates a temporary Vite dev server with
   `configFile: false`, imports the user's router via the RSC environment's module
   runner, extracts the `RouterRegistry`, and generates manifests for all routers.
2. Provides a **virtual module** (`virtual:rsc-router/routes-manifest`) that emits
   `setCachedManifest({...})` with the complete route map at import time.
3. In **dev mode** (`configureServer`): Same discovery but populates the manifest
   in-memory via `setCachedManifest()` directly.

Key: The manifest is available at **module evaluation time** (worker cold start),
not at first-request time. Zero request-path cost.

## Implementation Details

### Config

```typescript
// vite.config.ts
rscRouter({
  preset: "cloudflare",
  router: "./src/router.tsx",  // NEW: path to router module
})
```

### Worker entry

```typescript
// worker.rsc.tsx
import "virtual:rsc-router/routes-manifest";
```

For the default virtual RSC entry, this import is added automatically.

### Build pipeline

```
buildStart()
  -> createViteServer({ configFile: false, ... })
  -> rscEnv.runner.import(routerPath)
  -> RouterRegistry populated by createRouter()
  -> generateManifest(router.urlpatterns)
  -> mergedRouteManifest stored in plugin state
  -> tempServer.close()

load("virtual:rsc-router/routes-manifest")
  -> import { setCachedManifest } from "@rangojs/router/server";
  -> setCachedManifest({ "benchFirst": "/bench/first", ... });
```

### Static output

Build also writes per-router static files:

```
dist/static/__195d0d49bb01/
  routes.json    (684KB - name -> pattern map)
  prefixes.json  (prefix tree for routing optimization)
```

## Test Setup

- **Total routes**: 14,214 (4 root + 5,003 site + 5,002 api + 4,205 shop)
- **Manifest size**: ~684KB (in worker bundle)
- **Worker bundle**: 1,772 KB total (1,106 KB worker entry with manifest)
- **Gzip size**: 285 KB

## Results

### Deploy Output

```
Worker Startup Time: 19 ms
Total Upload: 1772.49 KiB / gzip: 285.15 KiB
```

### Route Matching (matchStats)

| Route | Entries Checked | Entries Skipped | Routes Checked |
|-------|-----------------|-----------------|----------------|
| `/bench/first` | 1 | 3 | 1 |
| `/bench/last` | 1 | 3 | 4 |
| `/api/bench/first` | 1 | 1 | 1 |
| `/api/bench/last` | 1 | 1 | 5,002 |
| `/site/en/bench/first` | 1 | 0 | 2 |
| `/site/en/bench/last` | 1 | 0 | 9,003 |

### href() Verification

Root route handler calls `ctx.href("api.benchFirst")` to test cross-include
resolution. Response includes `"testHref": "/api/bench/first"` confirming
the build-time manifest enables `href()` for routes in unevaluated lazy includes.

### TTFB (warm, 5 runs)

| Route | Min | Median | Max |
|-------|-----|--------|-----|
| `/bench/first` | 35ms | 36ms | 47ms |
| `/api/bench/first` | 75ms | 80ms | 110ms |
| `/api/bench/last` | 68ms | 89ms | 251ms |
| `/site/en/bench/first` | 91ms | 118ms | 162ms |
| `/site/en/bench/last` | 112ms | 139ms | 592ms |

## Comparison with Previous Approaches

| Approach | href() available | First-request cost | Bundle size |
|----------|-----------------|-------------------|-------------|
| Runtime 3-tier cache | After first request | ~20-100ms generation | ~1,075 KB |
| Manual build manifest | Immediately | 0ms (import-time) | ~1,743 KB |
| **Vite discovery plugin** | **Immediately** | **0ms (import-time)** | **~1,772 KB** |

| Metric | Previous (manual) | Current (plugin) |
|--------|------------------|-----------------|
| Worker Startup Time | 28ms | 19ms |
| Configuration | Manual import | `router: "./src/router.tsx"` |
| Default entries | Not automatic | Automatic |
| Static output | None | routes.json + prefixes.json |

## Architecture: Build vs Runtime Manifest

The build-time manifest and the runtime 3-tier cache serve the same purpose
(populate the route name map for `href()`) but at different times:

- **Build-time**: `setCachedManifest()` called at import time. Zero request cost.
- **Runtime**: `setCachedManifest()` called on first request. ~20-100ms cost.

When the build-time manifest is present, the runtime cache is effectively bypassed
for `href()` since `hasCachedManifest()` returns true.

Route MATCHING (request dispatch) is unaffected by the manifest. It still uses
the include() tree with lazy evaluation, which spreads the evaluation cost across
requests to different route groups.

## Files Changed

- `packages/rangojs-router/src/vite/index.ts` - `createRouterDiscoveryPlugin()`
- `packages/rangojs-router/src/vite/virtual-entries.ts` - Added routes-manifest import
- `examples/cloudflare-stress-demo/vite.config.ts` - Added `router` option
- `examples/cloudflare-stress-demo/src/worker.rsc.tsx` - Added virtual import

## Test Commands

```bash
# Build and deploy
cd examples/cloudflare-stress-demo
pnpm build && pnpm wrangler deploy

# Verify href() works from build-time manifest
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/first | jq .testHref
# Expected: "/api/bench/first"

# Verify matchStats
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/first | jq .matchStats
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/first | jq .matchStats

# Measure TTFB
curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
  https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last
```
