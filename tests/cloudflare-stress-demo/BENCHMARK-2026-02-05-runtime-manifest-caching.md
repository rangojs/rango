# Runtime Route Manifest Caching

- **Date**: 2026-02-05
- **Commit**: Uncommitted (pending)
- **Deployed Version**: `5426406c-d7d3-4684-9df9-f5074f8a9c3f`

## Problem Statement

Build-time manifest generation required a separate build step and bundled a ~768KB manifest into the worker code. This increased bundle size and added complexity to the build process.

## Solution

Implement runtime manifest caching with a three-tier strategy:

1. **Memory cache** (same isolate) - instant
2. **Edge cache** (Cloudflare caches.default) - ~1-9ms
3. **Generate on-demand** (cache miss) - ~20-100ms

The manifest is generated on first request (cold start) and cached for subsequent requests. This removes the need for build-time manifest generation while maintaining fast `href()` lookups for all routes including lazy includes.

## Implementation Details

### New `manifestCache` Option

```typescript
// router.tsx
export const router = createRouter<AppEnv>({
  document: Document,
  cache: (env) => ({
    store: new CFCacheStore({ ctx: env.ctx! }),
  }),
  manifestCache: true, // Enables runtime manifest caching
}).routes(urlpatterns);
```

### Three-Tier Caching Flow

```typescript
// route-manifest-cache.ts
export async function getRouteManifestData(
  generateFn: () => GeneratedManifest,
  version: string,
  options?: {
    store?: SegmentCacheStore;
    waitUntil?: (p: Promise<void>) => void;
  },
): Promise<CachedRouteData> {
  // 1. Memory check (instant)
  if (memoryManifest?.version === version) {
    console.log("[route-manifest] HIT memory (same isolate)");
    return memoryManifest;
  }

  // 2. Edge cache check (~1-9ms)
  if (store) {
    const cached = await store.get(cacheKey);
    if (cached?.manifest?.version === version) {
      console.log(
        `[route-manifest] HIT edge cache (${duration}ms, ${routes} routes)`,
      );
      return cached.manifest;
    }
  }

  // 3. Generate on miss (~20-100ms)
  const generated = generateFn();
  console.log(
    `[route-manifest] MISS - generated fresh (${duration}ms, ${routes} routes)`,
  );

  // Write to edge cache via waitUntil (non-blocking)
  if (store && waitUntil) {
    waitUntil(store.set(cacheKey, data, 31536000));
  }

  return memoryManifest;
}
```

### Handler Integration

```typescript
// handler.ts
if (options.manifestCache && router.urlpatterns) {
  if (hasCachedManifest()) {
    console.log("[route-manifest] HIT memory (same isolate)");
  } else {
    await getRouteManifestData(
      () => generateManifest(router.urlpatterns!),
      version,
      { store: cacheStore, waitUntil: env.ctx?.waitUntil.bind(env.ctx) },
    );
  }
}
```

## Test Setup

- **Total routes**: 14,213
  - Root: 3 routes
  - Site (`/site/:locale/*`): 9,003 routes
  - API (`/api/*`): 5,002 routes
  - Shop (`/shop/*`): 205 routes (nested includes)
- **Benchmark handlers**: Return JSON with `matchStats` and `testHref`

## Testing Methodology

```bash
# Deploy
pnpm build && pnpm wrangler deploy

# Test endpoints
curl -s https://cloudflare-stress-demo.example.workers.dev/bench/first | jq .
curl -s https://cloudflare-stress-demo.example.workers.dev/api/bench/first | jq .

# Watch logs for cache hits/misses
pnpm wrangler tail --format json | jq '.logs[] | select(.message[0] | contains("route-manifest")) | .message[0]'
```

## Results

### Cache Performance

| Scenario               | Time    | Log Message                                      |
| ---------------------- | ------- | ------------------------------------------------ |
| Cold start (generate)  | ~20ms   | `MISS - generated fresh (20.00ms, 14213 routes)` |
| New isolate (edge hit) | ~9ms    | `HIT edge cache (9.00ms, 14213 routes)`          |
| Same isolate (memory)  | instant | `HIT memory (same isolate)`                      |

### Route Matching (unchanged)

| Route              | Entries Checked | Entries Skipped | Routes Checked |
| ------------------ | --------------- | --------------- | -------------- |
| `/bench/first`     | 1               | 0               | 1              |
| `/api/bench/first` | 2               | 1               | 4              |
| `/api/bench/last`  | 2               | 1               | 5,005          |

### href() Support

The `testHref` field confirms `href()` works for routes from lazy includes:

```json
{
  "route": "/bench/first",
  "testHref": "/api/bench/first" // Route from lazy include works!
}
```

## Log Examples

### Cold Start (First Request After Deploy)

```
[route-manifest] MISS - generated fresh (20.00ms, 14213 routes)
[route-manifest] Writing to edge cache (via waitUntil)...
[route-manifest] Edge cache write complete
```

### Warm Request (Same Isolate)

```
[route-manifest] HIT memory (same isolate)
```

### New Isolate (Edge Cache Hit)

```
[route-manifest] HIT edge cache (9.00ms, 14213 routes)
```

## Benefits

1. **No build step required** - Manifest generated at runtime
2. **Reduced bundle size** - No 768KB manifest in worker code
3. **Fast warm starts** - Memory cache is instant
4. **Cross-isolate caching** - Edge cache shared across isolates in same colo
5. **Non-blocking writes** - Cache writes via `waitUntil` don't block response

## Files Changed

| File                                                         | Change                                        |
| ------------------------------------------------------------ | --------------------------------------------- |
| `packages/rangojs-router/src/server/route-manifest-cache.ts` | New three-tier caching module                 |
| `packages/rangojs-router/src/rsc/handler.ts`                 | Manifest loading on first request             |
| `packages/rangojs-router/src/router.ts`                      | Use `getGlobalRouteMap()` for handler context |
| `packages/rangojs-router/src/rsc/types.ts`                   | Add `manifestCache` option type               |
| `packages/rangojs-router/src/route-map-builder.ts`           | Add `setCachedManifest`, `hasCachedManifest`  |
| `examples/cloudflare-stress-demo/src/router.tsx`             | Enable `manifestCache: true`                  |
| `examples/cloudflare-stress-demo/wrangler.json`              | Enable observability and tracing              |

## Test Commands

```bash
# Deploy and test
cd examples/cloudflare-stress-demo
pnpm build && pnpm wrangler deploy

# Verify href() works for lazy includes
curl -s https://cloudflare-stress-demo.example.workers.dev/bench/first | jq .testHref
# Output: "/api/bench/first"

# Watch cache logs
pnpm wrangler tail --format json | jq -r '.logs[] | select(.message[0] | contains("route-manifest")) | .message[0]'

# Expected logs:
# [route-manifest] MISS - generated fresh (20.00ms, 14213 routes)
# [route-manifest] Writing to edge cache (via waitUntil)...
# [route-manifest] Edge cache write complete
# [route-manifest] HIT memory (same isolate)
```
