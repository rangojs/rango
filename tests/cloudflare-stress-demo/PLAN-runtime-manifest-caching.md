# Runtime Route Manifest Caching

## Goal

Replace build-time manifest generation with runtime caching. First request evaluates the full route tree, then caches in memory + Cloudflare cache.default. Accept small cold boot overhead (~100ms) for simpler architecture.

**Phase 2 (future)**: Partial/incremental named route manifest - not in scope for this change.

---

## Current State

**Build-time (to remove)**:

- `src/build/vite-plugin.ts` - Vite plugin generates manifest
- `src/vite/index.ts:300-384` - `createRouteManifestPlugin()` provides virtual module
- `routeManifest` option in vite config loads JSON file
- `route-manifest.json` - 768KB file bundled into worker

**Runtime (already exists, to enhance)**:

- `src/server/route-manifest-cache.ts` - 3-tier caching (memory → store → generate)
- `src/build/generate-manifest.ts` - `generateManifest(urlpatterns)` function
- `src/route-map-builder.ts` - `setCachedManifest()` for href() support

---

## Implementation

### Step 1: Simplify route-manifest-cache.ts

Make store optional (memory-only mode for non-Cloudflare or when no store configured).

```typescript
// Add overload for memory-only mode
export async function getRouteManifestData(
  generateFn: () => GeneratedManifest,
  version: string,
  options?: {
    store?: CacheStore;
    waitUntil?: (promise: Promise<void>) => void;
  },
): Promise<CachedRouteData>;
```

**File**: `packages/rangojs-router/src/server/route-manifest-cache.ts`

### Step 2: Add manifest loading to RSC handler

Integrate manifest loading at request time when `urlpatterns` is provided.

```typescript
// In createRSCHandler or router.fetch():
if (options.urlpatterns && !hasCachedManifest()) {
  await getRouteManifestData(
    () => generateManifest(options.urlpatterns),
    VERSION,
    { store: cacheStore, waitUntil: ctx?.waitUntil },
  );
}
```

**Files**:

- `packages/rangojs-router/src/rsc/handler.ts`
- `packages/rangojs-router/src/router.ts` (add `urlpatterns` option)

### Step 3: Remove build-time manifest plugin

Remove or disable manifest generation from vite plugins.

**Changes**:

- `src/vite/index.ts` - Remove `createRouteManifestPlugin()`, remove `routeManifest` option
- `src/vite/virtual-entries.ts` - Remove route-manifest virtual module import
- Keep `src/build/generate-manifest.ts` - still needed for runtime generation

### Step 4: Update stress demo to use runtime caching

```typescript
// worker.rsc.tsx - pass store for caching
import { CFCacheStore } from "@rangojs/router/cache/cf";

export default {
  async fetch(request, env, ctx) {
    // Router configured with urlpatterns, cache store comes from env
    return router.fetch(request, {
      Bindings: env,
      ctx,
      // Cache store for manifest caching
      manifestCache: env.caches?.default
        ? new CFCacheStore(env.caches.default)
        : undefined,
    });
  },
};
```

**File**: `examples/cloudflare-stress-demo/src/worker.rsc.tsx`

### Step 5: Add benchmark for runtime caching

Test with stress demo:

1. Cold start (no cache) - measure generation time (~100ms expected)
2. Warm start (memory hit) - instant
3. New isolate (cache.default hit) - ~1-2ms

---

## Files to Modify

| File                                                         | Change                                     |
| ------------------------------------------------------------ | ------------------------------------------ |
| `packages/rangojs-router/src/server/route-manifest-cache.ts` | Make store optional                        |
| `packages/rangojs-router/src/router.ts`                      | Add urlpatterns option to RSCRouterOptions |
| `packages/rangojs-router/src/rsc/handler.ts`                 | Load manifest on first request             |
| `packages/rangojs-router/src/vite/index.ts`                  | Remove createRouteManifestPlugin           |
| `packages/rangojs-router/src/vite/virtual-entries.ts`        | Remove route-manifest import               |
| `examples/cloudflare-stress-demo/src/worker.rsc.tsx`         | Use runtime manifest loading               |
| `examples/cloudflare-stress-demo/vite.config.ts`             | Remove routeManifest option                |

## Files to Keep (for runtime use)

- `src/build/generate-manifest.ts` - Used at runtime for generation
- `src/server/route-manifest-cache.ts` - Core caching logic

## Files to Potentially Remove

- `src/build/vite-plugin.ts` - Only if no longer needed for anything else
- `examples/cloudflare-stress-demo/route-manifest.json` - No longer needed

---

## Verification

1. **Build stress demo** - should work without routeManifest option
2. **First request** - should generate manifest (~100ms overhead)
3. **Second request (same isolate)** - instant (memory hit)
4. **Benchmark routes** - verify matchStats unchanged
5. **href() calls** - should work after manifest is loaded (if app uses them)

```bash
# Deploy and test
cd examples/cloudflare-stress-demo
pnpm build && pnpm wrangler deploy

# Test cold start
curl -w "@curl-format.txt" -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/first

# Check manifest loaded
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/first | jq .matchStats
```

---

## Expected Performance

| Scenario                            | Time                       |
| ----------------------------------- | -------------------------- |
| Cold start (first request per colo) | ~100ms generation overhead |
| Warm start (same isolate)           | 0ms (memory)               |
| New isolate (cache hit)             | ~1-2ms                     |
| Bundle size reduction               | -768KB                     |
