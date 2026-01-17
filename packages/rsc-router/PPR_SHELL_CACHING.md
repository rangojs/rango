# PPR Shell Caching Implementation

## Implementation Progress

### Step 1: Shell cache GET/200 checks
- [x] Add `request.method === "GET"` check
- [x] Add `response.status === 200` check via `onResponse`
- **Status**: ✅ Complete

**Changes made:**
- `src/rsc/handler.ts:879` - Added `request.method === "GET"` to shell caching condition
- `src/rsc/handler.ts:998-1003` - Added status check in `onResponse` callback, skips caching for non-200

### Step 2: Dev warning for loader/loading mismatch
- [ ] Collect segments with loader() but no loading()
- [ ] Collect segments with loader({ ssr: false })
- [ ] Single consolidated warning per request
- **Status**: Not started

### Step 3: Loader-only optimization
- [ ] Couple shell cache key with segment cache key
- [ ] Double lookup (shell + segment)
- [ ] Loader-only render path on double HIT
- [ ] Coupled caching on MISS
- **Status**: Not started

---

## Overview

PPR (Partial Pre-Rendering) Shell Caching separates the HTML shell from RSC data to achieve instant TTFB on cache hits while always serving fresh data.

**Key insight**: The HTML shell (layouts + Suspense fallbacks) is often static per route, while RSC data changes frequently. By caching only the shell, we get:
- Instant streaming of cached HTML (fast TTFB)
- Fresh RSC data injected on every request
- No stale data issues

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Request Flow                                    │
└─────────────────────────────────────────────────────────────────────────────┘

                                 ┌──────────────┐
                                 │   Request    │
                                 └──────┬───────┘
                                        │
                                        ▼
                          ┌─────────────────────────────┐
                          │  shell.enabled && !isPartial │
                          │  && hasRenderShell?          │
                          └─────────────┬───────────────┘
                                        │
                           ┌────────────┴────────────┐
                           │                         │
                      [No] ▼                    [Yes]▼
              ┌─────────────────────┐    ┌─────────────────────┐
              │  Standard SSR       │    │  shouldCache(ctx)?  │
              │  renderHTML(rsc)    │    └──────────┬──────────┘
              └─────────────────────┘               │
                                      ┌────────────┴────────────┐
                                      │                         │
                                 [No] ▼                    [Yes]▼
                         ┌─────────────────────┐   ┌─────────────────────┐
                         │  Standard SSR       │   │  Check cache        │
                         │  (no x-suspense-*   │   │  store.get(key)     │
                         │   headers)          │   └──────────┬──────────┘
                         └─────────────────────┘              │
                                               ┌──────────────┴──────────────┐
                                               │                             │
                                          [HIT]▼                       [MISS]▼
                              ┌─────────────────────────┐   ┌─────────────────────────┐
                              │  Stream cached shell    │   │  Render shell           │
                              │  + inject fresh RSC     │   │  (without RSC injection)│
                              │                         │   │                         │
                              │  Headers:               │   │  Tee streams:           │
                              │  x-suspense-cache: hit  │   │  - shellForCache        │
                              │  x-suspense-cache-age   │   │  - shellForResponse     │
                              └─────────────────────────┘   │                         │
                                                            │  Cache shell async      │
                                                            │  Inject RSC into resp   │
                                                            │                         │
                                                            │  Headers:               │
                                                            │  x-suspense-cache: miss │
                                                            └─────────────────────────┘
```

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/cache/shell-cache-store.ts` | Interface definitions for shell cache stores |
| `src/cache/memory-shell-store.ts` | In-memory implementation with TTL/SWR |
| `src/ssr/shell-cache.ts` | Utilities for capturing/streaming HTML bytes |

### Modified Files

| File | Changes |
|------|---------|
| `src/cache/index.ts` | Export shell cache types and implementations |
| `src/rsc/handler.ts` | Shell caching logic in `handleRscRendering()` |
| `src/rsc/types.ts` | `PPRShellConfig` interface, `SSRModule.renderShell` |
| `src/ssr/index.tsx` | `createSSRHandler` returns `{ renderHTML, renderShell, injectRSCPayload }` |
| `examples/.../entry.rsc.tsx` | Example configuration with header-based opt-in |
| `examples/.../entry.ssr.tsx` | Export `renderShell` and `injectRSCPayload` |

## Request Flow Details

### 1. Cache MISS (First Request)

```
Request: GET /shop/product/123?__force_ppr
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Check shouldCache(ctx) → true (has __force_ppr)                  │
│ 2. Generate cache key: "shell:v1:/shop/product/123"                 │
│ 3. store.get(key) → null (MISS)                                     │
│ 4. Render RSC payload                                               │
│ 5. Tee RSC stream: [rscForShell, rscForInjection]                   │
│ 6. renderShell(rscForShell) → HTML without RSC scripts              │
│ 7. Tee shell stream: [shellForCache, shellForResponse]              │
│ 8. Schedule async: captureHtmlBytes(shellForCache) → store.set()    │
│ 9. Pipe: shellForResponse.pipeThrough(injectRSCPayload(rscForInj))  │
│ 10. Return response with x-suspense-cache: miss                     │
└─────────────────────────────────────────────────────────────────────┘
         ▼
Response: 200 OK
          Content-Type: text/html
          x-suspense-cache: miss

          <html>...Suspense fallbacks...<script>__FLIGHT_DATA__</script></html>
```

### 2. Cache HIT (Subsequent Requests)

```
Request: GET /shop/product/123?__force_ppr
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Check shouldCache(ctx) → true                                    │
│ 2. Generate cache key: "shell:v1:/shop/product/123"                 │
│ 3. store.get(key) → { entry, status: "fresh" } (HIT)                │
│ 4. Render RSC payload (fresh data!)                                 │
│ 5. streamFromBytes(cached.entry.html) → cached HTML stream          │
│ 6. Pipe: cachedHtml.pipeThrough(injectRSCPayload(rscStream))        │
│ 7. Return response with x-suspense-cache: hit                       │
└─────────────────────────────────────────────────────────────────────┘
         ▼
Response: 200 OK
          Content-Type: text/html
          x-suspense-cache: hit
          x-suspense-cache-age: 15

          <html>...cached shell...<script>__FLIGHT_DATA__ (FRESH!)</script></html>
```

### 3. Stale-While-Revalidate (SWR)

```
Timeline:
  t=0s    → Cache set (ttl=60s, swr=300s)
  t=30s   → Cache HIT (status: fresh)
  t=90s   → Cache HIT (status: stale) - past TTL but within SWR window
  t=400s  → Cache MISS (past SWR window, entry deleted)
```

## Configuration

### Basic (Always Cache)

```typescript
// entry.rsc.tsx
export default createRSCHandler({
  router,
  shell: {
    enabled: true,
  },
});
```

### Header-Based Opt-In (Recommended for Production)

```typescript
// entry.rsc.tsx
export default createRSCHandler({
  router,
  version: VERSION,
  shell: {
    enabled: true,
    shouldCache: (ctx) =>
      ctx.request.headers.has("x-enable-ppr") ||
      ctx.url.searchParams.has("__force_ppr"),
  },
});
```

CDN configuration (e.g., Cloudflare):
```
# Add header for routes that benefit from shell caching
if (http.request.uri.path matches "^/shop/")
  set http.request.headers["x-enable-ppr"] = "1"
```

### Custom Cache Key (i18n, A/B Testing)

```typescript
shell: {
  enabled: true,
  cacheKey: (ctx) => {
    const lang = ctx.request.headers.get("Accept-Language")?.split(",")[0] || "en";
    const bucket = ctx.variables.abBucket || "control";
    return `shell:${ctx.version}:${lang}:${bucket}:${ctx.pathname}`;
  },
}
```

### Custom Store with TTL/SWR

```typescript
import { MemoryShellCacheStore } from "rsc-router/cache";

shell: {
  enabled: true,
  store: new MemoryShellCacheStore({
    defaults: { ttl: 60, swr: 300 },
    maxEntries: 500,
  }),
}
```

## Debug Parameters

| Parameter | Effect |
|-----------|--------|
| `?__force_ppr` | Force shell caching (bypasses shouldCache) |
| `?__shell_only` | Return shell HTML without RSC injection |
| `?__no_suspense_cache` | Bypass cache, always render fresh shell |

## Response Headers

| Header | Values | Description |
|--------|--------|-------------|
| `x-suspense-cache` | `hit`, `stale`, `miss` | Cache status |
| `x-suspense-cache-age` | seconds | Time since cache entry creation |
| `x-suspense-cache-key` | string | Cache key (only with `__shell_only`) |

## SSR Module Changes

`createSSRHandler` now returns an object instead of a single function:

```typescript
// Before
export const renderHTML = createSSRHandler({...});

// After
export const { renderHTML, renderShell } = createSSRHandler({...});
export { injectRSCPayload };
```

### Functions

| Function | Purpose |
|----------|---------|
| `renderHTML(rscStream)` | Full SSR: render HTML + inject RSC payload |
| `renderShell(rscStream)` | Shell only: render HTML without RSC injection |
| `injectRSCPayload(rscStream)` | TransformStream that injects RSC as `<script>` tags |

## Shell Cache Store Interface

```typescript
interface ShellCacheStore {
  get(key: string): Promise<ShellCacheResult | null>;
  set(key: string, entry: ShellCacheEntry, ttl: number, swr?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear?(): Promise<void>;
  getCacheKey?(ctx: ShellCacheContext): string;
  readonly defaults?: { ttl?: number; swr?: number };
}

interface ShellCacheEntry {
  html: Uint8Array;
  createdAt: number;
  staleAt?: number;
}

interface ShellCacheResult {
  entry: ShellCacheEntry;
  status: "fresh" | "stale";
}
```

## Stream Handling

The implementation uses stream teeing to enable parallel operations:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cache MISS Flow                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   RSC Stream                                                         │
│       │                                                              │
│       ├──tee()──┬─────────────────────────────────────────┐         │
│       │         │                                          │         │
│       ▼         ▼                                          │         │
│   rscForShell   rscForInjection                            │         │
│       │              │                                     │         │
│       ▼              │                                     │         │
│   renderShell()      │                                     │         │
│       │              │                                     │         │
│       ▼              │                                     │         │
│   Shell Stream       │                                     │         │
│       │              │                                     │         │
│       ├──tee()──┬────┼─────────────────────────────┐       │         │
│       │         │    │                              │       │         │
│       ▼         ▼    │                              │       │         │
│   shellForCache shellForResponse                    │       │         │
│       │              │                              │       │         │
│       │              └───────────────────┐          │       │         │
│       │                                  │          │       │         │
│       ▼                                  ▼          ▼       │         │
│   captureHtmlBytes()              pipeThrough(injectRSCPayload)      │
│       │                                  │                           │
│       ▼                                  ▼                           │
│   store.set(key, bytes)           Response Stream                    │
│   (async, waitUntil)                                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Performance Characteristics

| Scenario | TTFB | Total Time |
|----------|------|------------|
| No caching | ~200ms | ~500ms |
| Cache MISS | ~200ms | ~550ms (+ async cache write) |
| Cache HIT | ~10ms | ~300ms (RSC still rendered) |

The key win is TTFB on cache hit - the browser receives HTML immediately and can start parsing while RSC data streams in.

## Limitations (Current Implementation)

1. **Shell must be deterministic**: The same route/params should produce the same shell HTML
2. **No personalized shells**: Shell is shared across users (use `cacheKey` for segmentation)
3. **Memory pressure**: In-memory store grows with unique routes (use `maxEntries`)
4. **Version invalidation**: Changing `version` invalidates all cached shells
5. **RSC still rendered**: Even on shell cache HIT, full RSC rendering happens (components + loaders)
6. **Hydration risk**: Shell and RSC rendered separately could theoretically mismatch

---

## Next: Loader-Only Optimization (research/ppr-loader-only)

### Problem with Current Approach

Current shell cache HIT flow:
```
1. Shell cache HIT           → instant HTML
2. router.match()            → segment resolution (expensive)
3. renderSegments()          → create React tree
4. renderToReadableStream()  → serialize to RSC
5. Inject RSC into shell
```

Steps 2-4 still happen on every request, even with shell cache HIT. This is:
- **Wasteful**: We're re-rendering components that produced the same shell
- **Risky**: If components render differently, hydration errors occur

### Proposed: Coupled Shell + Segment Cache

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Coupled Cache Architecture                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Same Cache Key: shell:v1:/shop/product/123                          │
│                                                                      │
│  Shell Cache stores:                                                 │
│    └── HTML Shell (layouts + Suspense fallbacks)                     │
│                                                                      │
│  Segment Cache stores:                                               │
│    └── RSC Segments (serialized components, NO loader data)          │
│                                                                      │
│  Lookup requires BOTH to hit:                                        │
│    Shell HIT + Segment HIT  →  loader-only path (safe, fast)         │
│    Shell HIT + Segment MISS →  treat as MISS (avoid hydration error) │
│    Shell MISS               →  full render, cache both               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Benefits

| Benefit | Description |
|---------|-------------|
| **No hydration errors** | Shell and RSC always from same render (same cache entry) |
| **Skip component rendering** | On double HIT, only run loaders |
| **Consistent invalidation** | Both caches use same key, invalidate together |
| **Leverage existing infra** | Segment cache already separates loaders from components |

### Loader-Only Flow (Double HIT)

```
Request: GET /shop/product/123
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Check shell cache → HIT                                          │
│ 2. Check segment cache (same key) → HIT                             │
│ 3. Get cached segments (components only, no loaders)                │
│ 4. Run resolveLoadersOnly(entries) → fresh loader data              │
│ 5. Merge: cached segments + fresh loaders                           │
│ 6. Serialize merged segments → RSC stream (fast, no component work) │
│ 7. Stream cached shell                                              │
│ 8. Inject merged RSC                                                │
└─────────────────────────────────────────────────────────────────────┘
         ▼
Response: 200 OK
          x-suspense-cache: hit
          x-segment-cache: hit

          <html>...cached shell...<script>__FLIGHT_DATA__ (cached + fresh loaders)</script></html>
```

### Segment Cache Integration

The existing segment cache already provides the infrastructure we need:

**Existing APIs to reuse:**

| API | Location | Purpose |
|-----|----------|---------|
| `cacheScope.lookupRoute()` | `cache-scope.ts` | Get cached segments + staleness |
| `resolveLoadersOnly()` | `router.ts` | Run loaders without component resolution |
| `resolveLoadersOnlyWithRevalidation()` | `router.ts` | Run loaders with revalidation |
| `getCacheKeyBase()` | `cache-scope.ts` | Consistent key generation |

**Segment cache key format:**
```
[prefix]:[pathname]:[sorted_params]
prefix = "doc" | "partial" | "intercept"
```

**What segment cache stores:**
- Component RSC streams (`encoded`, `encodedLayout`, `encodedLoading`)
- Metadata (id, type, params)
- Handle data (breadcrumbs, meta)

**What segment cache does NOT store (by design):**
- Loader segments (filtered out in `cache-store.ts:449`)
- Loaders always resolved fresh

### Implementation Plan

**Phase 1: Couple cache keys**
```typescript
// Shell cache key derived from segment cache key
const segmentKey = cacheScope.getCacheKeyBase(pathname, params);
const shellKey = `shell:${version}:${segmentKey}`;
```

**Phase 2: Double lookup**
```typescript
// In handler.ts handleRscRendering()
if (shellConfig?.enabled && cacheScope?.enabled) {
  const shellCached = shellStore.get(shellKey);
  const segmentCached = cacheScope.lookupRoute(pathname, params);

  if (shellCached && segmentCached) {
    // Double HIT - loader-only path
    return handleLoaderOnlyRender(shellCached, segmentCached);
  }

  if (shellCached && !segmentCached) {
    // Shell stale (segment invalidated) - invalidate shell too
    shellStore.delete(shellKey);
  }
}
// Fall through to full render
```

**Phase 3: Loader-only render path**
```typescript
async function handleLoaderOnlyRender(
  shellCached: ShellCacheEntry,
  segmentCached: { segments: ResolvedSegment[], shouldRevalidate: boolean }
) {
  // Run only loaders (skip component resolution)
  const freshLoaders = await resolveLoadersOnly(entries, handlerContext);

  // Merge cached segments + fresh loaders
  const mergedSegments = [...segmentCached.segments, ...freshLoaders];

  // Serialize to RSC (fast - segments already resolved)
  const rscStream = renderToReadableStream({
    root: renderSegments(mergedSegments),
    metadata
  });

  // Stream cached shell + inject RSC
  return streamFromBytes(shellCached.html)
    .pipeThrough(injectRSCPayload(rscStream));
}
```

**Phase 4: Coupled caching on MISS**
```typescript
// On full render, cache both atomically
ctx.onResponse((res) => {
  if (res.status === 200) {
    ctx.waitUntil(async () => {
      // Cache shell
      const shellBytes = await captureHtmlBytes(shellForCache);
      shellStore.set(shellKey, { html: shellBytes, createdAt: Date.now() }, ttl, swr);

      // Segment cache happens automatically via cache-store middleware
      // Uses same key base, so they stay in sync
    });
  }
  return res;
});
```

### Cache Invalidation

Both caches invalidate together because:

1. **Same key base**: `shell:v1:/shop/product/123` and `doc:/shop/product/123`
2. **Same TTL/SWR**: Configure both with matching expiration
3. **Version prefix**: Changing `version` invalidates both
4. **Double-check on lookup**: If segment miss, invalidate shell

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Invalidation Scenarios                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Version change (deploy):                                            │
│    v1 → v2: All shell keys change, segment cache also refreshes      │
│                                                                      │
│  TTL expiration:                                                     │
│    Both caches configured with same TTL, expire together             │
│                                                                      │
│  Segment invalidation (revalidation rule):                           │
│    Segment cache miss → shell cache also treated as miss             │
│                                                                      │
│  Manual invalidation:                                                │
│    shellStore.delete(key) + cacheScope.delete(key)                   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Performance Comparison

| Scenario | Component Work | Loader Work | TTFB |
|----------|---------------|-------------|------|
| No caching | Full render | Full run | ~200ms |
| Shell HIT only (current) | Full render | Full run | ~10ms |
| Shell + Segment HIT (proposed) | **None** | Full run | ~10ms |

The key improvement: **zero component rendering** on double HIT. Only loaders run, which is the actual dynamic data.

### Safety: Hydration Mismatch Prevention

**The Risk Explained:**

When segment caching is enabled, component RSC output is cached. This cached output contains the **rendered data values**, not references to loaders:

```tsx
// Component renders with loader data
function ProductPrice() {
  const { price } = useLoader('product');
  return <span className="price">${price}</span>;
}

// At cache time (T1), price = $99
// Cached RSC output: ["$","span",{"className":"price","children":"$99"}]
//                                                              ^^^^
//                                                     Data baked into cache!
```

**What happens on cache HIT with stale data:**

```
Timeline:
  T1: Price is $99, component renders, RSC cached with "$99"
  T2: Price changes to $109 in database
  T3: Request comes in, segment cache HIT

      Server sends:
      ├── Cached component RSC: <span>$99</span>     (stale!)
      └── Fresh loader data: { price: 109 }          (current!)

      Client receives mismatched data:
      ├── HTML shows: $99 (from cached RSC)
      └── Hydration expects: $109 (from fresh loader)

      Result: ⚠️ Hydration mismatch error in console
              UI may flicker or show incorrect data
```

**Why Suspense boundaries fix this:**

With a `loading()` boundary, the cached content is just the fallback skeleton:

```tsx
route("product", () => [
  loader(productLoader),
  loading(<PriceSkeleton/>),  // Creates Suspense boundary
])

// Cached RSC output: ["$","PriceSkeleton",null,{}]
//                    ^^^^^^^^^^^^^^^^^^
//                    No data! Just the skeleton.

// Fresh loader data streams in separately and replaces skeleton
// No mismatch possible - skeleton has no data to conflict with
```

**When is it safe WITHOUT loading()?**

- Loader data **never changes** (truly static configuration)
- Component output **doesn't depend** on loader data (just triggers side effects)
- You're okay with **potential mismatches** during cache staleness window

If a component uses loader data without a Suspense boundary:
```typescript
route("product", () => [
  loader(productLoader),  // Has loader
  // No loading()!        // No Suspense boundary
])
```

Cached component output contains stale data, fresh loader returns new data → hydration mismatch.

**The Solution:**

Runtime warning in development when caching is enabled. One consolidated warning per request listing all problematic segments:

```typescript
// Collect all problematic segments, warn once per request
if (isDev && cacheScope?.enabled) {
  const issues: string[] = [];

  for (const segment of segments) {
    if (segment.hasLoader && !segment.hasLoading) {
      issues.push(`  - ${segment.id}: loader() without loading()`);
    }
    if (segment.hasLoader && segment.loaderSsrFalse) {
      issues.push(`  - ${segment.id}: loader() with ssr: false`);
    }
  }

  if (issues.length > 0) {
    console.warn(
      `[rsc-router] Segment caching enabled but ${issues.length} segment(s) may cause hydration mismatches:\n` +
      issues.join('\n') +
      `\n\nAdd loading() boundaries or disable caching for these segments.`
    );
  }
}
```

**Example output:**
```
⚠️ [rsc-router] Segment caching enabled but 3 segment(s) may cause hydration mismatches:
  - layout:/shop: loader() without loading()
  - route:/shop/product: loader() without loading()
  - parallel:@sidebar: loader() with ssr: false

Add loading() boundaries or disable caching for these segments.
```

**Why `ssr: false` is risky:**

```tsx
route("product", () => [
  loader(productLoader, { ssr: false }),  // Only runs on client
  loading(<Skeleton/>),
])

// Server renders: <Skeleton/> (no data)
// Cached RSC: skeleton component
// Client hydrates with skeleton, then loader runs
// But if cache serves stale skeleton state... mismatch possible
```

**Applies to all segment types:**
- `route()`
- `layout()`
- `parallel()`
- `intercept()`

**Safe pattern:**
```typescript
route("product", () => [
  loader(productLoader),    // SSR enabled (default)
  loading(<Skeleton/>),     // Suspense boundary
])
```

This warning helps developers catch potential issues during development without breaking existing code.

**Philosophy: Informed Developer Choice**

```
Developer uses loader() without loading() + caching enabled
                    ↓
        ⚠️ Warning in dev console
                    ↓
    ┌───────────────┴───────────────┐
    ↓                               ↓
Adds loading()               Ignores warning
    ↓                               ↓
Safe caching ✅            Accepts risk (their choice)
```

- **No breaking changes** - Existing code keeps working
- **Developer is informed** - Warning clearly explains the risk
- **Their choice** - They can add `loading()` or accept the risk
- **Safe by default** - Following the warning ensures safe caching

The framework's job is to warn. If a developer chooses to ignore the warning, they understand they may get hydration mismatches. This matches the philosophy: *"make the right thing easy, make the wrong thing visible."*

### Open Questions

1. **Segment cache key alignment**: Should shell use exact same key or derived key?
2. **SWR coordination**: If segment is stale, should shell also be stale?
3. **Partial navigation**: Does this apply to `_rsc_partial` requests too?
4. **Handle data**: Need to ensure handle data is replayed correctly from segment cache
