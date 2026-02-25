# RSC Router Caching Design

## Implementation Status

### ✅ Completed

- **Router-level cache integration** - Cache check before handler execution in `match()` and `matchPartial()`
- **Cache provider in request context** - `SegmentCacheProvider` interface via AsyncLocalStorage
- **Handle data caching** - Handles cached with segments, replayed on cache hit
- **Parallel segment support** - All segments per entry (main + parallels) cached together
- **In-memory store** - `MemorySegmentCacheStore` with TTL, survives HMR via `globalThis`
- **Cache bypass** - `?__no_cache` query param disables caching per-request
- **Pluggable store API** - `SegmentCacheStore` interface with handler-level configuration
- **Per-route cache configuration** - `cache({ ttl, swr, store })` DSL for route definitions
- **Store-level defaults** - `MemorySegmentCacheStore({ defaults: { ttl, swr } })`
- **Per-section stores** - `cache({ store })` for dedicated stores per route section

### 🚧 Remaining

- **Production storage backends** - Cloudflare KV, Redis adapters
- **Cache invalidation API** - Tag-based invalidation, manual purge
- **Proactive caching** - Render null-component segments in background for complete cache entries
- **RSC stream caching** - Cache serialized stream directly (avoid deserialize/reserialize)

### Performance (Dev)

- Cache HIT: ~12ms server time (3 entries × ~4ms deserialization each)
- Browser sees: ~50-60ms (includes Vite dev server overhead)
- Cache MISS: Handler execution time (e.g., 5500ms with slow loader)

---

## Overview

Server-side/edge caching for RSC Router, leveraging the existing segment-based streaming architecture.

## Core Concept

Segments are already discrete units in the RSC stream. Caching operates at the segment level:

- **Store**: Individual segments by `segmentId + params`
- **Serve**: Check cache per segment, serve cached or render fresh
- **Proactive**: Use `waitUntil` to cache sibling segments for future navigations

### Matched Segments

When a route is visited, only the **matched segments** are rendered (e.g., layout + route for that path). These are cached individually:

```
Visit /blog/1:
  Matched: [BlogLayout, post/1]
  Cached:  BlogLayout (segment), post/1 (segment)

Visit /blog/2:
  Matched: [BlogLayout, post/2]
  Server renders: post/2 only (client keeps BlogLayout)
  Cached: post/2 (segment)

Visit /blog/list (from /shop):
  Matched: [BlogLayout, list]
  Cache check:
    BlogLayout → HIT (cached earlier)
    list → HIT (if proactively cached) or MISS → render
```

### RSC Element Caching

RSC elements are serialized using React's flight protocol and can be cached at the edge (Cloudflare Cache API, KV, etc.).

#### RSC Serialization Implementation

The POC uses React's RSC APIs from `@vitejs/plugin-rsc/rsc`:

**Serialization (cache write):**

```typescript
import {
  renderToReadableStream,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";

const temporaryReferences = createTemporaryReferenceSet();
const stream = renderToReadableStream(segment.component, {
  temporaryReferences,
});
const encoded = await streamToString(stream);
// Store `encoded` string in cache
```

**Revival (cache read):**

```typescript
import {
  createFromReadableStream,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";

const temporaryReferences = createTemporaryReferenceSet();
const stream = stringToStream(encoded);
const component = await createFromReadableStream(stream, {
  temporaryReferences,
});
// `component` is now a valid React element that can be rendered
```

Key points:

- `temporaryReferences` handles client references (client components, server actions)
- The encoded string is the RSC flight format (text-based, streamable)
- Revival produces a React element identical to the original
- Cached elements render correctly in both RSC stream and HTML output

## API

### Cache Boundary

`cache()` wraps route definitions, defining which segments participate in caching:

```typescript
cache({ ttl: 60 }, () => [
  layout(<BlogLayout />),      // cached individually
  route("post/:slug"),         // cached individually
  route("list"),               // cached individually
  route("sidebar"),            // cached individually
])
```

### Nested Cache Boundaries

Override TTL or opt out:

```typescript
cache({ ttl: 60 }, () => [
  layout(<BlogLayout />),

  route("post/:slug"),

  route("admin", () => [
    cache(false),  // opt out of caching
  ]),

  cache({ ttl: 300 }, () => [
    route("static-page"),  // longer TTL
  ]),
])
```

### Loader Caching

Loaders can have their own cache configuration:

```typescript
route("post/:slug", () => [
  loader(PostLoader), // inherits cache from boundary

  loader(ViewCount, () => [
    cache({ ttl: 10 }), // shorter TTL
  ]),

  loader(UserSpecific, () => [
    cache(false), // always fresh
  ]),
]);
```

## Caching Layers

### Layer 1: Full Document Cache

Cache complete RSC response for a route:

```typescript
cache({ ttl: 3600 }, () => [
  layout(<StaticLayout />),
  route("about"),
])
```

### Layer 2: Shell Cache + Fresh Streaming

Cache synchronous shell, stream fresh data through Suspense boundaries.

Similar to Next.js 16's PPR (Partial Prerendering) with `use cache`:

- Components outside `<Suspense>` = cached shell
- Components inside `<Suspense>` = stream fresh

```typescript
cache({ ttl: 60 }, () => [
  layout(<BlogLayout />),  // shell - cached
  route("post/:slug", () => [
    loader(PostLoader),    // streams fresh through Suspense
  ]),
])
```

Shell boundary detection:

- Everything resolved within ~10ms / 1 event loop = shell (cacheable)
- Pending Suspense boundaries = streaming (fresh each request)

The `<Suspense>` boundaries in your components naturally define what's shell vs what streams fresh. No additional API needed for this distinction.

### Layer 3: Segment Cache

Individual segments cached, composed on request:

```
Request for /blog/1 (navigating from /shop)

Client needs: [BlogLayout, post/1]

Cache check:
  BlogLayout → HIT (cached from earlier request)
  post/1     → HIT (cached from earlier request)

Response: composed from cached segments
```

### Layer 4: Loader Data Cache

Loader results cached independently:

```typescript
loader(PostLoader, () => [cache({ ttl: 30 })]);
```

Allows same loader data to be reused across different segments/routes.

## Proactive Caching (waitUntil)

When a partial request results in some cached segments having `component: null` (because the client already has them), proactively render those segments in the background and cache the complete set.

**The Problem:**

```
Client A: /blog/1 → /blog/2 (partial)
  - Server renders only route segment (client has BlogLayout)
  - Cache stores partial:/blog/2 with null BlogLayout component

Client B: /shop → /blog/2 (partial)
  - Cache HIT on partial:/blog/2
  - But BlogLayout component is null!
  - Client B doesn't have BlogLayout → broken render
```

**The Solution:**

```
Client A: /blog/1 → /blog/2 (partial)

1. Respond immediately:
   - Route segment (what client needs)
   - BlogLayout = null (client has it)

2. waitUntil (background):
   - Identify segments with null components within cache() boundary
   - Render those segments fresh (BlogLayout handler)
   - Cache complete segment set: [BlogLayout ✓, route ✓]

Client B: /shop → /blog/2 (partial)
  - Cache HIT on partial:/blog/2
  - BlogLayout component is present ✓
  - Complete render works
```

**Scope:**

Proactive caching only applies to segments within a `cache()` boundary:

```typescript
layout(<RootLayout />),  // NOT cached - always fresh

cache({ ttl: 60 }, () => [
  layout(<BlogLayout />),        // Proactive caching applies
  parallel({ "@sidebar": ... }), // Proactive caching applies
  route("post/:id", ...),        // Proactive caching applies
]),
```

Segments outside cache boundaries are not affected - they render fresh on every request.

## Partial Request Handling

Existing partial rendering (`_rsc_partial`, `_rsc_segments`) integrates with caching:

```
Partial request: _rsc_segments=BlogLayout,post/1

For each segment:
  1. Check cache
  2. HIT → use cached
  3. MISS → render fresh, cache result

Compose cached + fresh segments into single RSC stream
```

## Cache Key Structure

Cache keys combine entry namespace with sorted route params:

```typescript
function getSegmentCacheKey(
  entryId: string,
  params?: Record<string, string>,
): string {
  const paramStr = params
    ? Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";
  return paramStr ? `${entryId}:${paramStr}` : entryId;
}

// Examples:
// "#router.$root.$layout.0" (no params)
// "#router.$root.$layout.0.$route.1.post:slug=react-server-components"
```

Key uses `entry.namespace` (not `segment.id`) to ensure cache lookups match storage.

## Storage Backend

Pluggable `SegmentCacheStore` interface configured at handler level:

```typescript
interface SegmentCacheStore {
  get(key: string): Promise<CachedEntryData | null>;
  set(key: string, data: CachedEntryData, ttl: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear?(): Promise<void>;
}

interface CachedEntryData {
  segments: SerializedSegmentData[]; // RSC-encoded components
  handles: Record<string, SegmentHandleData>;
  expiresAt: number;
}
```

### Handler Configuration

```typescript
import { createRSCHandler, MemorySegmentCacheStore } from "rsc-router/rsc";

// Store with defaults - TTL/SWR inherited by all cache() boundaries
const cacheStore = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 300 },
});

export default createRSCHandler({
  router,
  cache: { store: cacheStore },
});

// Dynamic config with env (for Cloudflare bindings)
export default createRSCHandler({
  router,
  cache: (env) => ({
    store: new KVSegmentCacheStore(env.Bindings.CACHE_KV, {
      defaults: { ttl: 60 },
    }),
  }),
});
```

### Implementations

**Available:**

- `MemorySegmentCacheStore` - In-memory Map, survives HMR via `globalThis`

**Planned:**

- Cloudflare KV adapter
- Redis adapter

## Handle Data Caching

**Problem**: When serving cached segments, route handlers don't run. Handlers are what populate handle data via `ctx.use(Handle)` and `push()`. Without handlers running, handles have no data.

Handle data flow (normal):

```
1. router.match() runs route handlers
2. Handler calls: const push = ctx.use(Breadcrumbs)
3. Handler pushes: push({ label: "Shop", href: "/shop" })
4. HandleStore collects: { breadcrumbs: { segmentId: [data...] } }
5. RSC payload includes: handles: handleStore.stream()
```

With cached segments (without handle caching):

```
1. Cache HIT - skip router.match()
2. Handlers never run
3. No push() calls
4. HandleStore is empty
5. Client expects handle data but gets nothing
```

### Solution: Cache Handle Data with Segments

Store handle data alongside each cached segment. When serving from cache, replay handle data into the handleStore.

**Data structures:**

```typescript
// Per-segment handle data (inverted from HandleStore's structure)
type SegmentHandleData = Record<string, unknown[]>;
// { handleName: [values...] }

// Cache entry includes both component and handles
interface CacheEntry {
  encoded: string;           // RSC-serialized component
  expiresAt: number;
  metadata: { ... };
  handles: SegmentHandleData;  // Handle data for this segment
}
```

**HandleStore additions:**

```typescript
interface HandleStore {
  // ... existing methods ...

  // Extract handle data for a specific segment (for caching)
  getDataForSegment(segmentId: string): Record<string, unknown[]>;

  // Replay cached handle data back into the store (for cache hits)
  replaySegmentData(
    segmentId: string,
    segmentHandles: Record<string, unknown[]>,
  ): void;
}
```

**Cache flow:**

On cache MISS:

```
1. router.match() runs handlers
2. Handlers push handle data to handleStore
3. Wait for handleStore.settled
4. Extract: handleStore.getDataForSegment(segmentId)
5. Cache segment + handles together
```

On cache HIT:

```
1. Retrieve cached segment + handles
2. handleStore.replaySegmentData(segmentId, cachedHandles)
3. Use cached segment component
4. handleStore.stream() emits replayed data to client
```

## Stale-While-Revalidate (SWR)

### Design Goals

1. **Immediate response** - Always serve cached content instantly (fresh or stale)
2. **Background revalidation** - Use `waitUntil` to refresh stale content
3. **No user waits** - Stale content is better than waiting for fresh

### Cache States

```
TTL: 60s, SWR: 300s

Time:     0s -------- 60s ----------- 360s --------->
State:    |  FRESH   |    STALE      |  EXPIRED    |
Action:   |  serve   | serve+reval   |  miss       |
```

### Data Structures

```typescript
interface CachedEntryData {
  segments: SerializedSegmentData[];
  handles: Record<string, SegmentHandleData>;
  createdAt: number; // When cached
  staleAt: number; // TTL boundary (serve but trigger revalidation)
  expiresAt: number; // Hard expiration (cache miss)
  // For background revalidation
  revalidationContext: {
    entryId: string;
    routeKey: string;
    params: Record<string, string>;
  };
}
```

### Background Revalidation Strategy

**Challenge**: Re-rendering segments requires full context (router, request, handlers).

**Solution**: Store minimal revalidation context, use synthetic internal request.

```typescript
// On stale cache hit
async function handleStaleCacheHit(
  cached: CachedEntryData,
  requestCtx: RequestContext,
) {
  // 1. Serve stale immediately
  const segments = await deserializeSegments(cached.segments);

  // 2. Trigger background revalidation (non-blocking)
  if (!isRevalidating(cached.revalidationContext.entryId)) {
    requestCtx.waitUntil(async () => {
      await revalidateEntry(cached.revalidationContext);
    });
  }

  return segments;
}

async function revalidateEntry(ctx: RevalidationContext) {
  markRevalidating(ctx.entryId);
  try {
    // Re-resolve segment with fresh data
    const freshSegments = await resolveSegmentFresh(ctx);
    await cacheSegments(ctx.entryId, freshSegments);
  } finally {
    clearRevalidating(ctx.entryId);
  }
}
```

### Thundering Herd Prevention

In-memory Set to track active revalidations:

```typescript
const revalidatingKeys = new Set<string>();

function isRevalidating(key: string): boolean {
  return revalidatingKeys.has(key);
}

function markRevalidating(key: string): void {
  revalidatingKeys.add(key);
}

function clearRevalidating(key: string): void {
  revalidatingKeys.delete(key);
}
```

For distributed systems, consider Redis-based locking.

---

## Loader Caching Policy

### Design Principle: Loaders NOT Cached by Default

Loaders fetch dynamic data and should run fresh by default. Only the component structure (layouts, routes) is cached.

**Rationale:**

- Loader data is often user-specific or time-sensitive
- Caching loaders requires explicit opt-in for safety
- Matches mental model: "cache the shell, fetch fresh data"

### How It Works

```typescript
cache({ ttl: 60 }, () => [
  layout(<BlogLayout />),      // ✅ Cached (component)

  route("post/:slug", () => [
    loader(PostLoader),        // ❌ NOT cached (runs fresh)
    loader(ViewCount),         // ❌ NOT cached (runs fresh)
  ]),
])
```

### Opt-In Loader Caching

Use `cache()` wrapper to explicitly cache loader results:

```typescript
route("post/:slug", () => [
  // Fresh loader (default)
  loader(PostLoader),

  // Cached loader (explicit opt-in)
  loader(StaticMetadata, () => [
    cache({ ttl: 3600 }), // ✅ Cached for 1 hour
  ]),

  // Short-lived cache with SWR
  loader(ViewCount, () => [cache({ ttl: 10, swr: 60 })]),
]);
```

### Implementation Notes

When serving cached segments:

1. Deserialize cached component tree
2. Run loaders fresh (unless loader has its own cache())
3. Inject fresh loader data into cached component structure

This requires separating:

- **Segment cache**: Component structure, layouts, handles
- **Loader cache**: Individual loader results (opt-in)

---

## cache() DSL Design

### Middleware-Style Wrapping

`cache()` works like middleware - wraps content, applies to everything inside unless overridden.

```typescript
// Outer cache applies to all nested segments
cache({ ttl: 60 }, () => [
  layout(<RootLayout />),           // ttl: 60

  route("blog", () => [
    layout(<BlogLayout />),         // ttl: 60 (inherited)
    route("post/:slug"),            // ttl: 60 (inherited)
  ]),

  // Override for specific section
  cache({ ttl: 300 }, () => [
    route("static-page"),           // ttl: 300 (overridden)
  ]),

  // Opt out of caching
  cache(false, () => [
    route("admin"),                 // ❌ Not cached
  ]),
])
```

### API Signature

```typescript
// Both signatures supported:
function cache(children: () => RouteChildren[]): RouteChild;
function cache(
  options: CacheOptions | false,
  children?: () => RouteChildren[],
): RouteChild;

interface CacheOptions {
  // Time-to-live in seconds (optional if store has defaults)
  ttl?: number;

  // Stale-while-revalidate window (seconds after TTL)
  swr?: number;

  // Explicit store for this cache boundary (overrides app-level store)
  store?: SegmentCacheStore;

  // Conditional cache read
  condition?: (ctx: CacheConditionContext) => boolean;

  // Custom cache key
  key?: (ctx: CacheKeyContext) => string;

  // Tags for invalidation
  tags?: string[] | ((ctx: CacheTagContext) => string[]);
}

interface SegmentCacheStore {
  // Store-level defaults inherited by cache() boundaries
  readonly defaults?: { ttl?: number; swr?: number };

  get(key: string): Promise<CachedEntryData | null>;
  set(key: string, data: CachedEntryData, ttl: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear?(): Promise<void>;
}
```

### Per-Section Cache Store

Different sections can use different cache stores with their own defaults:

```typescript
// Checkout-specific store with shorter TTL
const checkoutStore = new MemorySegmentCacheStore({
  defaults: { ttl: 10 },  // 10s for checkout (data changes frequently)
});

// Main app store
const appStore = new MemorySegmentCacheStore({
  defaults: { ttl: 60 },  // 60s default
});

export default createRSCHandler({
  router,
  cache: { store: appStore },
});

// In route definition:
cache(() => [                               // Uses appStore (ttl: 60)
  layout(<ShopLayout />),
  route("products/:id"),

  cache({ store: checkoutStore }, () => [   // Uses checkoutStore (ttl: 10)
    layout(<CheckoutLayout />),
    route("checkout"),
  ]),
])
```

**Store resolution priority:**

1. Explicit store in `cache({ store })` → use it
2. App-level store from handler config → fallback

**TTL resolution priority:**

1. Explicit TTL in `cache({ ttl })` → use it
2. Resolved store's defaults → inherit
3. Hardcoded fallback (60s)

### Conditional Caching

```typescript
cache(
  {
    ttl: 300,
    // Skip cache for preview mode or authenticated users
    condition: (ctx) => {
      if (ctx.request.headers.get("x-preview")) return false;
      if (ctx.cookies.get("session")) return false;
      return true;
    },
  },
  () => [route("product/:id")],
);
```

### Cache Key Customization

```typescript
cache(
  {
    ttl: 300,
    // Include query params in cache key
    key: (ctx) => `product-${ctx.params.id}-${ctx.searchParams.get("variant")}`,
  },
  () => [route("product/:id")],
);
```

### Tags for Invalidation

```typescript
cache(
  {
    ttl: 300,
    tags: (ctx) => [`product:${ctx.params.id}`, "products", "catalog"],
  },
  () => [route("product/:id")],
);

// Later, in a server action:
await invalidateCache({ tags: ["products"] });
```

---

## Open Problems

### Invalidation

TBD - to be determined.

Options under consideration:

- TTL-based expiration
- Tag-based invalidation
- Manual purge API
- Server action integration

### Handle Data with Promises

Current implementation caches handle data after `handleStore.settled`. If handles push promises that resolve later, those resolved values aren't captured. Need to investigate:

- Should we await promise resolution before caching?
- Or cache the promise and accept it resolves immediately on replay?

### Dynamic Handle Data

Handle data may depend on request context (cookies, headers, user state). Cached handle data won't reflect per-request variations. Consider:

- Exclude dynamic handles from caching
- Cache key variations based on context
- Hybrid approach: cache static handles, fresh dynamic handles

### ~~Handler Execution Order~~ ✅ SOLVED

~~Current POC limitation: `router.match()` runs handlers BEFORE cache check.~~

**Implemented**: Cache check now happens INSIDE `router.match()` and `router.matchPartial()`, before handler execution:

```typescript
// In router.ts segment resolution loop
for (const entry of traverseBack(manifestEntry)) {
  // Check cache BEFORE running handler
  if (cacheProvider?.enabled) {
    const cached = await cacheProvider.get(entry.id, params);
    if (cached) {
      // Use cached segments, replay handles, skip handler
      handleStore.replaySegmentData(segId, segHandles);
      segs.push(...cached.segments);
      continue;
    }
  }
  // Cache miss - run handler normally
  const resolved = await resolveSegment(...);
  // Queue for caching after handlers settle
}
```

Key implementation details:

- Cache check via `ctx._cacheProvider` from request context
- Each entry caches all its segments (main + parallels) together
- Handle data keyed by segment ID for proper replay
- `?__no_cache` query param disables caching per-request
- Uses `globalThis` for in-memory cache to survive HMR in dev

---

## Implementation Review Notes

### Status Summary (Jan 2026)

| Area                 | Status  | Notes                                              |
| -------------------- | ------- | -------------------------------------------------- |
| Cache key generation | ✅ Good | Clear prefix strategy (doc/partial/intercept)      |
| Serialization        | ✅ Good | RSC serialize/deserialize works correctly          |
| Proactive caching    | ✅ Good | Background rendering of null-component segments    |
| SWR handling         | ✅ Good | CFCacheStore handles atomicity for thundering herd |
| Revalidation         | ✅ Good | Soft/hard decision pattern is solid                |
| Handle data replay   | ✅ Good | Breadcrumbs/meta properly cached and replayed      |

### Known Issues & Considerations

#### 1. Proactive Caching Cache Key Prefix (Resolved)

**Design Decision**: Proactive caching writes to `partial:` key, which is correct.

**Rationale:**

- Document requests always render ALL segments (no null components possible)
- Only partial requests can have null components (client already has some segments)
- Proactive caching exists to ensure future partial requests get complete segments
- Therefore, proactive caching should populate `partial:` entries, not `doc:` entries

**Simplification Applied:**
Removed the `hasCompleteDocEntry()` cache lookup check. The runtime `hasNullComponents` check is sufficient:

- If cache already has complete segments → cache HIT → `hasNullComponents` is false → no proactive caching
- If segments have nulls → proactive caching triggers

The cache lookup was only useful for a minor race condition (concurrent requests). Not worth the complexity.

#### 2. Loading Skeleton Not Deserialized (Intentional)

In `cache-scope.ts:237`, loading skeletons are intentionally NOT deserialized from cache:

```typescript
// We only preserve the "null" marker to maintain tree structure consistency.
const loading = item.encodedLoading === "null" ? null : undefined;
```

**Rationale**: Cached content should render immediately without showing loading states. The loading skeleton is only useful during initial render when data is being fetched.

#### 3. Race Condition in Proactive Caching (Accepted)

Concurrent partial requests with null components could both trigger proactive caching for the same route.

**Impact**: Minor - just causes extra background work, no correctness issues. Both will write the same complete segments.

**Decision**: Accepted as-is. Adding locks (in-memory or distributed) adds complexity not worth the minor optimization.

#### 4. Intercept Route Cache Namespace

When `isIntercept` is true, cache operations use the `intercept:` prefix. Intercept requests have their own cache namespace separate from `doc:` and `partial:`.

**Note**: Proactive caching for intercept routes follows the same pattern - it populates the appropriate intercept cache entry when null components are detected.

#### 5. MemorySegmentCacheStore SWR Limitation

The in-memory store doesn't support SWR - it always returns `shouldRevalidate: false`:

```typescript
// Memory store doesn't support SWR - never triggers revalidation
return { data: cached, shouldRevalidate: false };
```

**Impact**: Tests using memory store won't exercise SWR revalidation paths. Use `CFCacheStore` in production for full SWR support.

#### 6. Request Object Capture in Proactive Caching

The proactive caching closure captures the original `request` object. If the request body was consumed or if the original context has large objects, they'll be retained until proactive caching completes.

**Recommendation**: Consider capturing only the minimal data needed (URL, headers) rather than the full request object.

### Console Logging

The caching system has extensive `console.log` statements for debugging. Consider:

- Adding a debug flag to control verbosity
- Using structured logging for production
- Log levels (debug/info/warn/error)
