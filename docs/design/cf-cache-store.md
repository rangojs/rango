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
const cache = await caches.open('rsc-segments');

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

### Phase 2: KV Sub-store (Future)

Add optional KV backing for persistence. Edge Cache checks first, falls back to KV on miss.

```typescript
interface CFCacheStoreOptions {
  // ... existing options ...

  /** Optional KV namespace for persistence */
  kv?: KVNamespace;
  /** KV-specific TTL (default: same as edge cache TTL) */
  kvTtl?: number;
}
```

**Layered Read Strategy:**
```
1. Check Edge Cache
   └─ HIT → return immediately
   └─ MISS → continue

2. Check KV (if configured)
   └─ HIT → populate Edge Cache, return
   └─ MISS → return null

3. (Caller handles cache miss, stores fresh data)
```

**Write Strategy:**
```
1. Write to Edge Cache (sync)
2. Write to KV (async via waitUntil if available)
```

## Usage

### Basic Setup (Edge Cache Only)

```typescript
import { createRSCHandler } from 'rsc-router/rsc';
import { CFCacheStore } from 'rsc-router/cf';

export default createRSCHandler({
  router,
  cache: {
    store: new CFCacheStore({
      defaults: { ttl: 60, swr: 300 },
    }),
  },
});
```

### With KV Persistence (Phase 2)

```typescript
import { createRSCHandler } from 'rsc-router/rsc';
import { CFCacheStore } from 'rsc-router/cf';

export default createRSCHandler({
  router,
  cache: (env) => ({
    store: new CFCacheStore({
      kv: env.CACHE_KV,
      defaults: { ttl: 60, swr: 300 },
    }),
  }),
});
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

`CacheScope.cacheEntry()` already uses `waitUntil` for non-blocking cache writes:

```typescript
// In cache-scope.ts
cacheEntry(cacheKey: string, segments: ResolvedSegment[]): void {
  // ...
  requestCtx.waitUntil(async () => {
    await handleStore.settled;
    const serialized = await serializeSegments(segments);
    await store.set(key, data, ttl);
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
  'Cache-Control': `public, max-age=${ttl + swr}`,
  'x-edge-cache-stale-at': String(Date.now() + ttl * 1000),
  'x-edge-cache-status': 'HIT',
};
```

CF Cache keeps entry for full 360s, but we know it's stale after 60s.

### Store Implementation

```typescript
const CACHE_STALE_AT_HEADER = "x-edge-cache-stale-at";
const CACHE_STATUS_HEADER = "x-edge-cache-status";

interface CacheGetResult {
  data: CachedEntryData;
  stale: boolean;
}

async get(key: string): Promise<CacheGetResult | null> {
  const cache = await caches.open(this.namespace);
  const response = await cache.match(this.keyToRequest(key));
  if (!response) return null;

  // Check staleness from header (no JSON parse needed)
  const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER));
  const stale = Date.now() > staleAt;

  // Parse body for actual data
  const data = await response.json() as CachedEntryData;

  return { data, stale };
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

When `CacheScope.restore()` gets stale data:

```typescript
async restore(entryId: string, params: Record<string, string>): Promise<ResolvedSegment[] | null> {
  const result = await store.get(key);
  if (!result) return null;

  // Serve stale data immediately
  const segments = await deserializeSegments(result.data.segments);

  // Trigger background revalidation if stale
  if (result.stale) {
    requestCtx.waitUntil(async () => {
      await this.revalidateEntry(entryId, params);
    });
  }

  return segments;
}
```

### Revalidation Implementation

Background revalidation needs to:
1. Re-resolve the segments fresh (run handlers/loaders)
2. Cache the new result

**Challenge**: Revalidation needs router context to re-render segments.

**Solution**: Store revalidation context with cached data:

```typescript
interface CachedEntryData {
  // ... existing fields ...
  revalidationContext: {
    entryId: string;
    routeKey: string;
    params: Record<string, string>;
    url: string;  // Original request URL for context
  };
}
```

The revalidation function creates a synthetic request and re-runs matching:

```typescript
async revalidateEntry(context: RevalidationContext): Promise<void> {
  // Prevent thundering herd
  if (isRevalidating(context.entryId)) return;
  markRevalidating(context.entryId);

  try {
    // Create synthetic request for re-resolution
    const request = new Request(context.url);

    // Re-resolve segments (implementation TBD - needs router access)
    const freshSegments = await router.resolveEntry(context.entryId, context.params, request);

    // Cache fresh result
    await this.cacheEntry(context.entryId, freshSegments);
  } finally {
    clearRevalidating(context.entryId);
  }
}
```

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
  hostname,           // e.g., "mydomain.com"
  "document",         // content type
  ...defaultTags,     // e.g., ["products", "catalog"]
  ...contentTags,     // e.g., ["product:123"]
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
await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${apiToken}` },
  body: JSON.stringify({ tags: ['product:123'] }),
});
```

### RSC Router Integration (Future)

```typescript
cache({
  ttl: 300,
  tags: (ctx) => [`product:${ctx.params.id}`, 'products'],
}, () => [
  route("product/:id"),
])

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
packages/rsc-router/src/cache/
├── cf-cache-store.ts      # CFCacheStore implementation
├── cf-kv-store.ts         # KV sub-store (Phase 2)
└── index.ts               # Re-export CF stores
```

## Tasks

### Phase 1: Edge Cache Store
- [ ] Implement `CFCacheStore` class
- [ ] Key-to-Request conversion with proper URL encoding
- [ ] Data-to-Response serialization with Cache-Control headers
- [ ] Response-to-Data deserialization with expiration check
- [ ] Error handling (cache failures = cache miss)
- [ ] Unit tests with mocked `caches` global
- [ ] Integration tests with Miniflare
- [ ] Documentation and examples

### Phase 1.5: SWR Support
- [ ] Update `CachedEntryData` with `createdAt`, `staleAt` fields
- [ ] Update store interface to return staleness indicator
- [ ] Implement `CacheScope` background revalidation trigger
- [ ] Add revalidation context to cached data
- [ ] Implement `revalidateEntry()` with router integration
- [ ] Thundering herd prevention (in-memory Set)
- [ ] Tests for SWR behavior (stale serving, background refresh)

### Phase 2: KV Sub-store
- [ ] Design KV schema and key structure
- [ ] Implement layered read (Edge Cache -> KV)
- [ ] Implement async write to KV (inline, wrapped by waitUntil at CacheScope)
- [ ] Handle KV-specific TTL configuration
- [ ] Tests for layered caching behavior

### Phase 3: Advanced (Future)
- [ ] Global revalidation coordination via KV/Durable Objects
- [ ] Cache tags for bulk invalidation
- [ ] Proactive sibling segment caching

## References

- [Cloudflare Cache API Docs](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [How the Cache Works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Workers KV Docs](https://developers.cloudflare.com/kv/)
- [KV Performance Improvements](https://blog.cloudflare.com/faster-workers-kv/)
