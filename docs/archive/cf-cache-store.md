> **Archived.** Historical design; the Cloudflare cache store shipped. Canonical reference is the cache skills and `@rangojs/router/cache`.

# Cloudflare Cache Store Design

> **Historical design document.** This captures the original design narrative for
> `CFCacheStore`. For the shipped API and current usage, see the `caching` and
> `cache-guide` skills (`packages/rangojs-router/skills/caching`,
> `packages/rangojs-router/skills/cache-guide`).

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
interface CFCacheStoreOptions {
  /** Cache namespace (default: 'rsc-segments') */
  namespace?: string;
  /** Base URL for cache keys (default: 'https://cache.internal/') */
  baseUrl?: string;
  /** Default cache options */
  defaults?: CacheDefaults;
}

class CFCacheStore implements SegmentCacheStore {
  readonly defaults?: CacheDefaults;

  constructor(options?: CFCacheStoreOptions);

  get(key: string): Promise<CachedEntryData | null>;
  set(key: string, data: CachedEntryData, ttl: number): Promise<void>;
  delete(key: string): Promise<boolean>;
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

### Phase 2: KV Sub-store (Implemented)

Optional KV backing for cross-colo persistence. Edge Cache checks first, falls back to KV on miss, promotes KV hits back to L1.

```typescript
interface CFCacheStoreOptions {
  // ... existing options ...

  /** Optional KV namespace for L2 persistence */
  kv?: KVNamespace;
}

// Usage
new CFCacheStore({ ctx, kv: env.CACHE_KV, defaults: { ttl: 60, swr: 300 } });
```

**Layered Read Strategy:**

```
1. Check Edge Cache (L1)
   └─ HIT → return immediately
   └─ MISS → continue

2. Check KV (L2, if configured)
   └─ HIT → serve + promote to L1 via waitUntil
   └─ MISS → return null (caller renders fresh)
```

**Write Strategy:**

```
1. Write to Edge Cache (L1, via waitUntil)
2. Write to KV (L2, via separate waitUntil — only if totalTtl >= 60s)
```

**KV envelopes** store staleness metadata (staleAt, expiresAt) alongside the data. Document cache bodies are base64-encoded for binary safety. SWR stampede protection stays on L1 only (KV can't do atomic compare-and-swap).

## Usage

### Basic Setup (Edge Cache Only)

```typescript
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      ctx,
      defaults: { ttl: 60, swr: 300 },
    }),
    enabled: true,
  }),
});
```

### With KV Persistence (Phase 2)

```typescript
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      ctx,
      kv: env.CACHE_KV,
      defaults: { ttl: 60, swr: 300 },
    }),
    enabled: true,
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

### KV Async Writes (Phase 2)

For Phase 2 with KV persistence, we have two options:

**Option A: Store receives waitUntil (more complex)**

```typescript
interface CFCacheStoreOptions {
  kv?: KVNamespace;
  waitUntil?: (fn: () => Promise<void>) => void;
}
```

**Option B: KV writes inline, caller uses waitUntil (simpler)**

```typescript
// CacheScope already wraps set() in waitUntil
// Store just does both writes synchronously
async set(key: string, data: CachedEntryData, ttl: number): Promise<void> {
  await this.edgeCache.put(request, response);
  if (this.kv) {
    await this.kv.put(key, JSON.stringify(data), { expirationTtl: ttl });
  }
}
```

**Recommendation**: Option B - keep the store simple. The `CacheScope` already handles `waitUntil`, so KV writes happen in the background naturally.

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

Reference implementation (`cache/cf/cache.ts`) uses response headers for staleness:

- `x-edge-cache-stale-at`: Timestamp when entry becomes stale
- `x-edge-cache-status`: HIT | MISS | REVALIDATING

**Benefits:**

- No JSON parsing needed to check staleness
- Can check headers before reading body
- Matches CF Cache API patterns

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
const CACHE_STATUS_HEADER = "x-edge-cache-status";

interface CacheGetResult {
  data: CachedEntryData;
  shouldRevalidate: boolean;  // true if entry is stale and needs background refresh
}

async get(key: string): Promise<CacheGetResult | null> {
  const cache = await caches.open(this.namespace);
  const response = await cache.match(this.keyToRequest(key));
  if (!response) return null;

  // Check staleness from header (no JSON parse needed)
  const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER));
  const shouldRevalidate = Date.now() > staleAt;

  // Parse body for actual data
  const data = await response.json() as CachedEntryData;

  return { data, shouldRevalidate };
}

async set(key: string, data: CachedEntryData, ttl: number, swr?: number): Promise<void> {
  const cache = await caches.open(this.namespace);
  const totalTtl = ttl + (swr ?? 0);

  const response = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${totalTtl}`,
      [CACHE_STALE_AT_HEADER]: String(Date.now() + ttl * 1000),
      [CACHE_STATUS_HEADER]: 'HIT',
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

Reference implementation uses a clever approach: **store REVALIDATING status in the cache itself**.

```typescript
const shouldRevalidate = (response: Response): boolean => {
  const status = response.headers.get(CACHE_STATUS_HEADER);
  const age = Number(response.headers.get("age") ?? "0");

  // Already revalidating and recent - skip
  if (status === "REVALIDATING" && age < MAX_REVALIDATION_INTERVAL) {
    return false;
  }

  // Check if stale
  const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER));
  return Date.now() > staleAt;
};

// Before triggering revalidation, mark entry as REVALIDATING
async markRevalidating(key: string, response: Response): Promise<void> {
  const [b1, b2] = response.body!.tee();
  const cache = await caches.open(this.namespace);

  // Update cache with REVALIDATING status
  await cache.put(
    this.keyToRequest(key),
    new Response(b1, {
      headers: {
        ...Object.fromEntries(response.headers),
        [CACHE_STATUS_HEADER]: "REVALIDATING",
      },
    })
  );

  // Return b2 for reading data
  return b2;
}
```

**How it works:**

1. First request sees stale entry → marks it REVALIDATING → triggers background refresh
2. Subsequent requests see REVALIDATING status → skip revalidation, serve stale
3. Background refresh completes → updates cache with fresh data + HIT status

**Benefits:**

- Works across all workers in same datacenter (shared edge cache)
- No separate in-memory state needed
- Self-healing: if revalidation fails, age eventually exceeds threshold

**Note**: Multiple CF datacenters may still revalidate simultaneously (edge cache is per-DC). For true global coordination, use KV or Durable Objects (Phase 3).

---

## Cache Tags (Phase 3)

Reference implementation supports cache tags for bulk invalidation.

### Headers

```typescript
const CACHE_TAGS_HEADER = "Cache-Tag";
const MAX_CACHE_TAGS = 30;
const MAX_CACHE_TAG_LENGTH_HEADER = 10000; // 10kb max
```

### Storing Tags

```typescript
const tagsHeader = sanitizeCacheTags([
  hostname, // e.g., "mydomain.com"
  "document", // content type
  ...defaultTags, // e.g., ["products", "catalog"]
  ...contentTags, // e.g., ["product:123"]
]).join(",");

const response = new Response(body, {
  headers: {
    [CACHE_TAGS_HEADER]: tagsHeader,
  },
});
```

### Integration with Cloudflare Cache Purge API

```typescript
// Purge by tag via CF API
await fetch(
  `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ tags: ["product:123"] }),
  },
);
```

### RSC Router Integration (Future)

```typescript
cache(
  {
    ttl: 300,
    tags: (ctx) => [`product:${ctx.params.id}`, "products"],
  },
  () => [route("product/:id")],
);

// Server action
async function updateProduct(id: string) {
  await db.products.update(id, data);
  await invalidateTags([`product:${id}`]);
}
```

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
packages/rangojs-router/src/cache/
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
- [x] Thundering herd prevention via cache status headers
- [x] Tests for SWR behavior (stale serving, background refresh)

### Phase 2: KV Sub-store

- [x] Design KV schema and key structure (envelope types: KVSegmentEnvelope, KVItemEnvelope, KVResponseEnvelope)
- [x] Implement layered read (Edge Cache -> KV -> promote to L1 via waitUntil)
- [x] Implement async write to KV (parallel waitUntil alongside L1 write)
- [x] Handle KV-specific TTL configuration (expirationTtl >= 60s guard, version-keyed)
- [x] Binary-safe response body encoding (base64 for document cache)
- [x] Tests for layered caching behavior (28 tests covering all three cache levels)

### Phase 3: Advanced (Future)

- [ ] Global revalidation coordination via KV/Durable Objects
- [ ] Cache tags for bulk invalidation
- [ ] Proactive sibling segment caching

## References

- [Cloudflare Cache API Docs](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [How the Cache Works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Workers KV Docs](https://developers.cloudflare.com/kv/)
- [KV Performance Improvements](https://blog.cloudflare.com/faster-workers-kv/)
