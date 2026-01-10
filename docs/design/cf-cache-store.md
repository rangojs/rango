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

### Phase 2: KV Sub-store
- [ ] Design KV schema and key structure
- [ ] Implement layered read (Edge Cache -> KV)
- [ ] Implement async write to KV via waitUntil
- [ ] Handle KV-specific TTL configuration
- [ ] Tests for layered caching behavior

## References

- [Cloudflare Cache API Docs](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [How the Cache Works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Workers KV Docs](https://developers.cloudflare.com/kv/)
- [KV Performance Improvements](https://blog.cloudflare.com/faster-workers-kv/)
