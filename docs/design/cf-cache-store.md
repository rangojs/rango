# Cloudflare Cache Store Design

## Overview

Production cache store implementation for Cloudflare Workers using the Edge Cache API as the primary storage layer, with optional Workers KV for persistence.

## Storage Options

### Edge Cache (Cache API) - Default

The Cloudflare Cache API provides per-datacenter ephemeral caching with sub-millisecond reads for hot data.

**Characteristics:**

- Per-datacenter (no cross-DC replication)
- Ephemeral (can be evicted anytime)
- Very fast for hot reads
- Uses Request/Response as key/value
- No tiered caching with `cache.put`

**API:**

```typescript
const cache = caches.default;
// or custom namespace
const cache = await caches.open("rsc-segments");

await cache.put(request, response);
const response = await cache.match(request);
await cache.delete(request);
```

### Workers KV - Optional Sub-store

Global persistent key-value storage with edge caching. Higher latency for cold reads but guarantees persistence.

**Characteristics:**

- Global, persistent storage
- Centralized with edge caching
- Cold reads: 300-500ms (can be higher)
- Hot reads: sub-millisecond (recently improved 3x)
- Good for data needing global consistency

**When to use KV:**

- Critical cached data that must survive cache eviction
- Global consistency across all datacenters
- Long-lived cache entries (hours/days)

## Implementation Plan

### Phase 1: Edge Cache Store

Implement `CFCacheStore` using the Cache API as the primary storage.

```typescript
interface CFCacheStoreOptions<TEnv = unknown> {
  ctx: ExecutionContext;
  namespace?: string;
  baseUrl?: string;
  defaults?: CacheDefaults;
  version?: string;
  keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;
  onRevalidateTag?: (tags: string[]) => Promise<void>;
  tagInvalidationStore?: CFTagInvalidationStore;
}

class CFCacheStore implements SegmentCacheStore {
  readonly defaults?: CacheDefaults;

  constructor(options: CFCacheStoreOptions);

  get(key: string): Promise<CacheGetResult | null>;
  set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void>;
  delete(key: string): Promise<boolean>;
  getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null>;
  putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void>;
  getItem(key: string): Promise<CacheItemResult | null>;
  setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void>;
  revalidateTag(tag: string): Promise<void>;
}
```

**Key Implementation Details:**

1. **Key to Request Conversion**

   ```typescript
   private keyToRequest(key: string): Request {
     // Encode key to be URL-safe
     const encodedKey = encodeURIComponent(key);
     return new Request(`${this.baseUrl}${encodedKey}`);
   }
   ```

2. **Data to Response Conversion**

   ```typescript
   private dataToResponse(data: CachedEntryData, ttl: number): Response {
     return new Response(JSON.stringify(data), {
       headers: {
         'Content-Type': 'application/json',
         'Cache-Control': `public, max-age=${ttl}`,
       },
     });
   }
   ```

3. **Response to Data Conversion**
   ```typescript
   private async responseToData(response: Response): Promise<CachedEntryData | null> {
     try {
       const data = await response.json();
       // Check expiration (Cache API respects Cache-Control but we double-check)
       if (data.expiresAt && Date.now() > data.expiresAt) {
         return null;
       }
       return data as CachedEntryData;
     } catch {
       return null;
     }
   }
   ```

### Phase 2: KV Sub-store (CFEdgeKVCacheStore)

`CFEdgeKVCacheStore` is a hybrid store with Cache API as L1 and Workers KV as L2.

```typescript
interface CFEdgeKVCacheStoreOptions {
  ctx: ExecutionContext;
  kv: KVNamespaceLike;
  defaults?: CacheDefaults;
  dataPrefix?: string; // default: "__rango_data__:"
  tagInvalidationStore?: CFTagInvalidationStore; // default: CFKVTagInvalidationStore over same KV
  tagInvalidationOptions?: CFKVTagInvalidationStoreOptions;
  // ... inherits CFCacheStoreOptions (namespace, baseUrl, version, keyGenerator, onRevalidateTag)
}
```

**Layered Read Strategy:**

```
1. Check Edge Cache (Cache API)
   └─ HIT → check taggedAt vs tag invalidation store → return or treat as miss
   └─ MISS → continue

2. Check KV
   └─ HIT → check taggedAt vs tag invalidation store
           → populate Edge Cache with remaining TTL → return
   └─ MISS → return null

3. (Caller handles cache miss, stores fresh data to both tiers)
```

**Write Strategy:**

```
1. Write to Edge Cache and KV in parallel
2. KV entries include staleAt/expiresAt for SWR on fallback reads
3. Tagged entries include taggedAt timestamp in both tiers
```

**KV Key Structure:**

```
{dataPrefix}v/{version}/{kind}:{key}
  kind = "seg" (segments), "doc" (responses), "fn" (function results)
```

**KV Entry Formats:**

- Segments: `{ data: CachedEntryData, staleAt, expiresAt }`
- Responses: `{ bodyBase64, status, statusText, headers, tags?, taggedAt?, staleAt, expiresAt }`
- Functions: `{ value, handles?, tags?, taggedAt?, staleAt, expiresAt }`

## Usage

### Basic Setup (Edge Cache Only)

```typescript
import { CFCacheStore } from "@rangojs/router/rsc";

const router = createRouter<Env>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      ctx,
      defaults: { ttl: 60, swr: 300 },
    }),
  }),
});
```

### With KV Persistence

```typescript
import { CFEdgeKVCacheStore } from "@rangojs/router/rsc";

const router = createRouter<Env>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFEdgeKVCacheStore({
      ctx,
      kv: env.CACHE_KV,
      defaults: { ttl: 60, swr: 300 },
    }),
  }),
});
```

## Route-Level Caching Architecture

### Single Cache Per Request

The cache uses a **single cache entry per route** pattern rather than per-segment caching:

- One cache lookup per route request
- Cache key is based on pathname (not entry ID)
- Document and partial requests are cached separately

### Cache Key Structure

```typescript
function getRouteCacheKey(
  pathname: string,
  params?: Record<string, string>,
): string {
  // Prefix distinguishes request type
  const prefix = isPartial ? "partial" : "doc";

  // Sort params for consistent keys
  const paramStr = params
    ? Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";

  const baseKey = paramStr ? `${pathname}:${paramStr}` : pathname;
  return `${prefix}:${baseKey}`;
}

// Examples:
// Document request to /products/123 → "doc:/products/123"
// Partial request to /products/123  → "partial:/products/123"
// With params: "doc:/products:id=123&category=electronics"
```

### Loader Caching Behavior

**Loaders are NOT cached by default**, even when under a parent `cache()` boundary:

```typescript
// Layout with cache - loaders are still fresh on each request
cache({ ttl: 60 }, () => [
  layout(<AppLayout />),
  loader(fetchUser),  // Always fresh - NOT cached
])

// Loader can opt-in to caching with its own cache() config
loader(fetchProducts, () => [
  cache({ ttl: 300 })  // This loader IS cached
])
```

**Rationale:**

- Loaders often contain user-specific or time-sensitive data
- Caching loaders by default could serve stale data unexpectedly
- Explicit opt-in gives developers control over loader caching

### Partial Request Caching

For navigation (partial) requests:

- Segments with `component: null` are expected (client already has them)
- These are cached normally - the cache stores what was resolved
- On cache hit, loaders are resolved fresh with revalidation logic

```typescript
// In matchPartial cache hit:
const cachedSegments = cacheResult.segments;  // May have null components
const loaderResult = await resolveLoadersOnlyWithRevalidation(entries, ...);
result = {
  segments: [...cachedSegments, ...loaderResult.segments],
  matchedIds: [...cachedMatchedIds, ...loaderResult.matchedIds],
};
```

## waitUntil Integration

The `RequestContext` already provides `waitUntil()` for background work:

```typescript
// In request-context.ts
waitUntil(fn: () => Promise<void>): void {
  if (executionContext?.waitUntil) {
    // Cloudflare Workers: use native waitUntil
    executionContext.waitUntil(fn());
  } else {
    // Node.js: fire-and-forget
    fn().catch((err) => console.error("[waitUntil]", err));
  }
}
```

### How Cache Uses waitUntil

`CacheScope.cacheRoute()` uses `waitUntil` for non-blocking cache writes:

```typescript
// In cache-scope.ts
cacheRoute(pathname: string, params: Record<string, string>, segments: ResolvedSegment[]): void {
  // Loaders are NOT cached by default
  const nonLoaderSegments = segments.filter((s) => s.type !== "loader");

  requestCtx.waitUntil(async () => {
    await handleStore.settled;

    // For document requests: only cache if all segments have components
    // For partial requests: null components are expected
    if (!isPartial) {
      const hasAllComponents = nonLoaderSegments.every((s) => s.component !== null);
      if (!hasAllComponents) return;
    }

    const serialized = await serializeSegments(nonLoaderSegments);
    await store.set(key, data, ttl, swr);
  });
}
```

The CF store itself doesn't need direct `waitUntil` access - it's handled at the `CacheScope` level.

### KV Async Writes

`CFEdgeKVCacheStore` writes to both Cache API and KV in parallel. The store
receives `ctx` (ExecutionContext) and uses `ctx.waitUntil()` for non-blocking
cache writes via the internal `CFCacheStore`. KV writes happen inline within
the same `waitUntil` scope managed by `CacheScope`.

---

## Stale-While-Revalidate (SWR)

SWR allows serving stale cached content immediately while refreshing in the background.

### Cache States

```
TTL: 60s, SWR: 300s

Time:     0s -------- 60s ----------- 360s --------->
State:    |  FRESH   |    STALE      |  EXPIRED    |
Action:   |  serve   | serve+reval   |  miss       |
```

### Key Insight: Use Headers, Not JSON Parsing

Response headers track staleness and tag metadata:

- `x-edge-cache-stale-at`: Timestamp (ms) when entry becomes stale
- `Cache-Tag`: Comma-separated cache tags
- `x-edge-cache-tagged-at`: Timestamp (ms) when tags were attached

Staleness is determined by comparing `Date.now()` against `x-edge-cache-stale-at`.

### Extended Cache TTL

Store response with extended TTL covering SWR window:

```typescript
// TTL: 60s, SWR: 300s
// Cache-Control uses: ttl + swr = 360s
// staleAt header tracks: ttl = 60s

const headers = {
  "Cache-Control": `public, max-age=${ttl + swr}`,
  "x-edge-cache-stale-at": String(Date.now() + ttl * 1000),
  "x-edge-cache-status": "HIT",
};
```

CF Cache keeps entry for full 360s, but we know it's stale after 60s.

### Store Implementation

```typescript
const CACHE_STALE_AT_HEADER = "x-edge-cache-stale-at";
const CACHE_TAGS_HEADER = "Cache-Tag";
const CACHE_TAGGED_AT_HEADER = "x-edge-cache-tagged-at";

interface CacheGetResult {
  data: CachedEntryData;
  shouldRevalidate: boolean;  // true if entry is stale and needs background refresh
}

async get(key: string): Promise<CacheGetResult | null> {
  const cache = await this.getCache();
  const response = await cache.match(this.keyToRequest(key));
  if (!response) return null;

  // Parse body and check tag invalidation
  const data = await response.json() as CachedEntryData;
  if (await isGloballyInvalidated(this.tagInvalidationStore, data.tags, data.taggedAt)) {
    await cache.delete(request).catch(() => false);
    return null;
  }

  // Check staleness
  const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER) ?? "0");
  const isStale = staleAt > 0 && Date.now() > staleAt;

  if (!isStale) return { data, shouldRevalidate: false };

  // Stale: check revalidation lock before claiming
  if (await this.isRevalidating(cache, key)) {
    return { data, shouldRevalidate: false };
  }
  await this.markRevalidating(cache, key);
  return { data, shouldRevalidate: true };
}

async set(key: string, data: CachedEntryData, ttl: number, swr?: number): Promise<void> {
  const cache = await this.getCache();
  const totalTtl = ttl + (swr ?? 0);
  const taggedAt = data.taggedAt ?? getTaggedAt(data.tags);

  const response = new Response(JSON.stringify(taggedAt ? { ...data, taggedAt } : data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${totalTtl}`,
      [CACHE_STALE_AT_HEADER]: String(Date.now() + ttl * 1000),
      ...(data.tags?.length ? { [CACHE_TAGS_HEADER]: data.tags.join(",") } : {}),
      ...(taggedAt ? { [CACHE_TAGGED_AT_HEADER]: String(taggedAt) } : {}),
    },
  });

  await cache.put(this.keyToRequest(key), response);
}
```

### CacheScope Handles Revalidation

The `CacheScope` uses route-level caching with `lookupRoute()` and `cacheRoute()` methods:

```typescript
// Single cache lookup for entire route
async lookupRoute(
  pathname: string,
  params: Record<string, string>
): Promise<{ segments: ResolvedSegment[]; shouldRevalidate: boolean } | null> {
  const result = await store.get(key);
  if (!result) return null;

  // Deserialize and replay handles
  const segments = await deserializeSegments(result.data.segments);
  handleStore.replaySegmentData(cached.handles);

  return { segments, shouldRevalidate: result.shouldRevalidate };
}

// Cache route segments (excludes loaders by default)
cacheRoute(
  pathname: string,
  params: Record<string, string>,
  segments: ResolvedSegment[]
): void {
  // Loaders are NOT cached by default - they're always fresh
  const nonLoaderSegments = segments.filter((s) => s.type !== "loader");

  requestCtx.waitUntil(async () => {
    await handleStore.settled;
    const serialized = await serializeSegments(nonLoaderSegments);
    await store.set(key, data, ttl, swr);
  });
}
```

The router then handles revalidation at the route level:

```typescript
// In router.match()
const cacheResult = await cacheScope.lookupRoute(pathname, params);

if (cacheResult) {
  // Use cached non-loader segments
  const cachedSegments = cacheResult.segments;

  // Resolve loaders fresh (loaders are NOT cached by default)
  const loaderSegments = await resolveLoadersOnly(entries, context);

  segments = [...cachedSegments, ...loaderSegments];

  // Trigger background revalidation if stale (SWR)
  if (cacheResult.shouldRevalidate) {
    requestCtx.waitUntil(async () => {
      const freshSegments = await resolveAllSegments(entries, ...);
      cacheScope.cacheRoute(pathname, params, freshSegments);
    });
  }
}
```

### Revalidation Implementation

Background revalidation is handled at the router level using `waitUntil`:

```typescript
// In router.match() on cache hit
if (cacheResult.shouldRevalidate && cacheScope) {
  requestCtx.waitUntil(async () => {
    console.log(`[Router.match] Revalidating stale route: ${pathname}`);
    try {
      // Re-resolve all segments fresh
      const freshSegments = await resolveAllSegments(
        entries,
        matched.routeKey,
        matched.params,
        handlerContext,
        loaderPromises,
      );
      // Cache the fresh result
      cacheScope.cacheRoute(pathname, matched.params, freshSegments);
    } catch (error) {
      console.error(`[Router.match] Revalidation failed:`, error);
    }
  });
}
```

The router already has all the context needed for revalidation - no need to store extra context in cached data.

### Thundering Herd Prevention

Uses a separate **revalidation lock key** in the Cache API:

```
__revalidation:{key}     — for segment entries
__revalidation:fn:{key}  — for function entries
```

**How it works:**

1. First request sees stale entry → checks for lock key via `isRevalidating()`
2. No lock (or lock expired > 30s) → writes lock via `markRevalidating()` → returns `shouldRevalidate: true`
3. Subsequent requests see lock exists → return `shouldRevalidate: false`, serve stale
4. Background refresh completes → writes fresh data → deletes lock key

**Benefits:**

- Works across all workers in same datacenter (shared edge cache)
- No separate in-memory state needed
- Self-healing: lock has a 30s TTL (`REVALIDATION_LOCK_TTL`)
- Lock is cleaned up on successful cache write

**Note**: Multiple CF datacenters may still revalidate simultaneously (edge cache is per-DC).

---

## Cache Tags (Phase 3)

Tag-based invalidation uses a distributed timestamp approach: tagged entries
carry a `taggedAt` timestamp, and a `CFTagInvalidationStore` records when each
tag was last invalidated. On read, if `invalidatedAt > taggedAt` for any of the
entry's tags, the entry is treated as a miss and lazily deleted from cache.

### Headers

```typescript
const CACHE_TAGS_HEADER = "Cache-Tag"; // comma-separated tags
const CACHE_TAGGED_AT_HEADER = "x-edge-cache-tagged-at"; // ms since epoch
```

### Distributed Tag Invalidation Store

```typescript
interface CFTagInvalidationStore {
  getLatestInvalidation(tags: string[]): Promise<number | null>;
  revalidateTag(tag: string, invalidatedAt: number): Promise<void>;
}
```

Built-in KV implementation:

```typescript
import { CFKVTagInvalidationStore } from "@rangojs/router/rsc";

const tagStore = new CFKVTagInvalidationStore(env.CACHE_KV, {
  prefix: "__rango_tag__:", // default
  ttl: undefined, // keep indefinitely by default
});
```

### CFCacheStore with Tag Invalidation

```typescript
new CFCacheStore({
  ctx,
  tagInvalidationStore: new CFKVTagInvalidationStore(env.CACHE_KV),
  onRevalidateTag: async (tags) => {
    // Optional: also purge via CF API for immediate local eviction
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ tags }),
      },
    );
  },
});
```

`CFEdgeKVCacheStore` creates a `CFKVTagInvalidationStore` automatically
from the same KV namespace, so tag invalidation works out of the box.

### How It Works

1. **Write**: Tagged entries store `taggedAt = Date.now()` in both the cached
   response body/headers and the KV payload.
2. **Invalidation**: `revalidateTag("products")` writes `invalidatedAt` to the
   tag store (via `waitUntil`), optionally calls `onRevalidateTag`.
3. **Read**: Before returning a hit, `isGloballyInvalidated()` checks
   `tagInvalidationStore.getLatestInvalidation(tags)`. If the result is newer
   than `taggedAt`, the entry is treated as a miss and lazily deleted.

This avoids the impossible task of enumerating Cache API keys across colos.
Stale entries remain until natural TTL expiry but are never served.

### RSC Router Integration

```typescript
// Tag routes in urls
cache({ ttl: 300, tags: ["products"] }, () => [
  path("/products", ProductList, { name: "products" }),
  path("/products/:id", ProductDetail, { name: "product" }),
]);

// Invalidate from server actions
import { revalidateTag } from "@rangojs/router";

async function updateProduct(formData: FormData) {
  "use server";
  await db.products.update(formData);
  revalidateTag("products");
}
```

`revalidateTag()` invalidates across the app-level store and any explicit
per-scope stores (`cache({ store })`) registered by the current handler.

---

## Considerations

### Cache Eviction

Edge Cache can evict entries at any time. The store should:

- Not assume cached data persists
- Handle cache misses gracefully
- Consider KV backing for critical data

### Datacenter Isolation

Edge Cache is per-datacenter. A user in Europe won't see cache entries from US datacenters. This means:

- Cold starts in new datacenters
- No global cache warming
- KV provides global consistency when needed

### TTL Handling

TTL is enforced via:

1. `Cache-Control: max-age=N` header on Response
2. `expiresAt` timestamp in cached data (double-check)

The Cache API respects `Cache-Control` but we store `expiresAt` for explicit verification.

### Error Handling

Cache operations should never fail the request:

```typescript
async get(key: string): Promise<CachedEntryData | null> {
  try {
    const cache = await caches.open(this.namespace);
    const response = await cache.match(this.keyToRequest(key));
    if (!response) return null;
    return this.responseToData(response);
  } catch (error) {
    // Log but don't throw - treat as cache miss
    console.error('Cache get failed:', error);
    return null;
  }
}
```

### Size Limits

Cloudflare Cache API limits:

- Maximum cached response size: 512MB (Enterprise), 25MB (Free/Pro/Business)
- Consider chunking large entries or excluding oversized data

## Testing Strategy

1. **Unit Tests**: Mock `caches` global, test serialization/deserialization
2. **Integration Tests**: Use Miniflare for local CF environment simulation
3. **E2E Tests**: Deploy to CF Workers and verify cache behavior

## File Structure

```
packages/rsc-router/src/cache/
├── cache-scope.ts         # CacheScope with lookupRoute/cacheRoute
├── types.ts               # SegmentCacheStore, CacheGetResult interfaces
├── memory-segment-store.ts # In-memory store for development
├── cf/
│   ├── cf-cache-store.ts  # CFCacheStore implementation
│   ├── index.ts           # Re-export CF stores
│   └── __tests__/         # CF store tests
└── index.ts               # Re-export all cache modules
```

## Tasks

### Phase 1: Edge Cache Store

- [x] Implement `CFCacheStore` class
- [x] Key-to-Request conversion with proper URL encoding
- [x] Data-to-Response serialization with Cache-Control headers
- [x] Response-to-Data deserialization with expiration check
- [x] Error handling (cache failures = cache miss)
- [x] Unit tests with mocked `caches` global
- [ ] Integration tests with Miniflare
- [x] Documentation and examples

### Phase 1.5: SWR Support

- [x] Update store interface to return `shouldRevalidate` indicator
- [x] Implement `CacheScope` background revalidation trigger
- [x] Route-level caching with `lookupRoute()` and `cacheRoute()`
- [x] Loaders excluded from cache by default (opt-in with own `cache()`)
- [x] Partial request caching with null component support
- [x] Thundering herd prevention via revalidation lock keys
- [x] Tests for SWR behavior (stale serving, background refresh)

### Phase 2: KV Sub-store (CFEdgeKVCacheStore)

- [x] Design KV schema and key structure (versioned, kind-prefixed)
- [x] Implement layered read (Edge Cache -> KV -> repopulate edge)
- [x] Implement parallel write to Edge Cache + KV
- [x] Handle KV-specific TTL and SWR (staleAt/expiresAt in KV payload)
- [x] Response serialization/deserialization (base64 body encoding)
- [x] Tests for layered caching behavior

### Phase 3: Tag-based Invalidation

- [x] Distributed tag invalidation via taggedAt timestamps
- [x] CFTagInvalidationStore interface
- [x] CFKVTagInvalidationStore (KV-backed implementation)
- [x] isGloballyInvalidated() check on all read paths (segments, responses, functions)
- [x] Lazy cache deletion on invalidated hits
- [x] revalidateTag() support on both CFCacheStore and CFEdgeKVCacheStore
- [x] onRevalidateTag callback for CF Cache Purge API integration
- [x] Handler-scoped tag store registry for multi-router isolation
- [x] Tests for distributed invalidation across all entry types
- [ ] Proactive sibling segment caching

## References

- [Cloudflare Cache API Docs](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [How the Cache Works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Workers KV Docs](https://developers.cloudflare.com/kv/)
- [KV Performance Improvements](https://blog.cloudflare.com/faster-workers-kv/)
