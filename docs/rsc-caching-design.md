# RSC Caching Design

Research branch for exploring RSC caching with revival capabilities.

## Goals

1. Cache RSC payloads (serialized React trees) for fast responses
2. Revive cached RSC content on cache hits
3. Imperative API that allows conditional cache reads/writes
4. No "use cache" directive - explicit control over caching behavior

## Current Architecture

### RSC Flow (no cache)
```
Request → Router Match → Loaders Execute → Segments Resolve → RSC Render → Stream Response
```

### What Gets Rendered
```typescript
interface RscPayload {
  root: React.ReactNode | Promise<React.ReactNode>;
  metadata: {
    pathname: string;
    segments: ResolvedSegment[];
    isPartial?: boolean;
    matched?: string[];
    diff?: string[];
    slots?: Record<string, SlotState>;
    handles?: AsyncGenerator<HandleData>;
  };
}
```

## Cache Insertion Points

### Option A: Full Response Cache (RSC Payload)
Cache the entire serialized RSC stream after `renderToReadableStream()`.

```
Request → [Cache Check] → Cache Hit → Return Cached Stream
                        ↓ Cache Miss
         Router Match → Loaders → Render → [Cache Write] → Stream
```

**Pros:**
- Fastest possible response on cache hit
- No loader execution, no rendering
- Simple mental model

**Cons:**
- Coarse granularity (entire page or nothing)
- Cache key must include all factors that affect output
- Harder to partially invalidate

### Option B: Segment-level Cache
Cache individual resolved segments with their loader data.

```
Request → Router Match → [Per-Segment Cache Check] → Merge Cached + Fresh → Render
```

**Pros:**
- Fine-grained caching
- Partial invalidation possible
- Reuses existing partial update infrastructure

**Cons:**
- More complex implementation
- Still needs to render (just with cached data)
- Multiple cache lookups

### Option C: Loader-level Cache
Cache loader results, let segments use cached data.

```
Request → Router Match → Loaders [with cache] → Segments → Render
```

**Pros:**
- Familiar pattern (data caching)
- Easy to reason about
- Works with existing revalidation logic

**Cons:**
- Still executes rendering pipeline
- Doesn't cache RSC tree structure

## Recommended: Hybrid Approach

Combine **Option A** (full RSC cache) with **Option C** (loader cache) for flexibility:

1. **Route-level RSC cache** for static/semi-static pages
2. **Loader-level cache** for dynamic pages with cacheable data

---

## API Design

### Cache Provider (Pluggable Storage)

```typescript
interface CacheProvider {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, value: CacheEntry, options?: CacheOptions): Promise<void>;
  delete(key: string): Promise<void>;
  deleteByTag(tag: string): Promise<void>;
}

interface CacheEntry {
  value: string | Uint8Array;  // Serialized RSC or JSON
  createdAt: number;
  tags?: string[];
}

interface CacheOptions {
  ttl?: number;              // Seconds
  tags?: string[];           // For invalidation
  staleWhileRevalidate?: number;
}
```

### Route-level Cache Directive

```typescript
import { cache, route, loader } from 'rsc-router';

// Basic usage
route("products", () => [
  cache({
    ttl: 300,  // 5 minutes
  }),
  loader(ProductsLoader),
]);

// Conditional caching
route("products/:id", () => [
  cache({
    ttl: 300,
    // Skip cache read when condition returns false
    condition: (ctx) => {
      // Don't read from cache for preview mode
      if (ctx.request.headers.get('x-preview')) return false;
      // Don't read from cache for authenticated users
      if (ctx.request.headers.get('cookie')?.includes('session')) return false;
      return true;
    },
    // Custom cache key
    key: (ctx) => `product-${ctx.params.id}`,
    // Tags for invalidation
    tags: (ctx) => [`product:${ctx.params.id}`, 'products'],
  }),
  loader(ProductLoader),
]);

// Stale-while-revalidate
route("dashboard", () => [
  cache({
    ttl: 60,
    staleWhileRevalidate: 300,  // Serve stale for 5min while revalidating
  }),
  loader(DashboardLoader),
]);
```

### Imperative Cache API in Loaders

```typescript
import { loader, defineLoader } from 'rsc-router';

const ProductLoader = defineLoader(async (ctx) => {
  // Access cache directly
  const cacheKey = `product-data-${ctx.params.id}`;

  // Check if we should use cache
  const shouldUseCache = !ctx.request.headers.get('x-bypass-cache');

  if (shouldUseCache) {
    const cached = await ctx.cache.get(cacheKey);
    if (cached) {
      // Optionally trigger background revalidation
      if (cached.isStale) {
        ctx.cache.revalidateInBackground(cacheKey, () => fetchProduct(ctx.params.id));
      }
      return cached.value;
    }
  }

  // Fetch fresh data
  const product = await fetchProduct(ctx.params.id);

  // Cache the result
  await ctx.cache.set(cacheKey, product, {
    ttl: 300,
    tags: [`product:${ctx.params.id}`],
  });

  return product;
});
```

### Cache Invalidation

```typescript
import { invalidateCache } from 'rsc-router/cache';

// In a server action
async function updateProduct(formData: FormData) {
  'use server';

  const id = formData.get('id');
  await db.products.update(id, { ... });

  // Invalidate by tag
  await invalidateCache({ tags: [`product:${id}`] });

  // Or by key pattern
  await invalidateCache({ keys: [`product-*`] });
}
```

---

## RSC Revival Implementation

### Challenge
RSC streams are consumed once. To cache and revive:
1. Tee the stream during first render
2. Collect chunks into buffer
3. Store serialized buffer
4. On cache hit, create new ReadableStream from buffer

### Implementation Sketch

```typescript
// In RSC handler
async function handleRequest(request: Request): Promise<Response> {
  const cacheKey = buildCacheKey(request);
  const cacheConfig = getCacheConfig(matchedRoute);

  // Check cache
  if (cacheConfig && shouldReadCache(request, cacheConfig)) {
    const cached = await cacheProvider.get(cacheKey);

    if (cached) {
      const isStale = Date.now() - cached.createdAt > cacheConfig.ttl * 1000;

      if (!isStale || cacheConfig.staleWhileRevalidate) {
        // Trigger background revalidation if stale
        if (isStale) {
          revalidateInBackground(request, cacheKey, cacheConfig);
        }

        // Revive cached RSC stream
        return new Response(reviveRscStream(cached.value), {
          headers: {
            'Content-Type': 'text/x-component',
            'X-Cache': isStale ? 'STALE' : 'HIT',
          },
        });
      }
    }
  }

  // Cache miss - render fresh
  const payload = await renderPayload(request);
  const stream = renderToReadableStream(payload);

  // Tee stream for caching
  if (cacheConfig) {
    const [responseStream, cacheStream] = stream.tee();

    // Cache in background (don't block response)
    cacheInBackground(cacheStream, cacheKey, cacheConfig);

    return new Response(responseStream, {
      headers: {
        'Content-Type': 'text/x-component',
        'X-Cache': 'MISS',
      },
    });
  }

  return new Response(stream, {
    headers: { 'Content-Type': 'text/x-component' },
  });
}

function reviveRscStream(cached: Uint8Array): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(cached);
      controller.close();
    },
  });
}

async function cacheInBackground(
  stream: ReadableStream,
  key: string,
  config: CacheConfig
) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const buffer = concatenateChunks(chunks);
  await cacheProvider.set(key, {
    value: buffer,
    createdAt: Date.now(),
    tags: config.tags,
  }, { ttl: config.ttl + (config.staleWhileRevalidate || 0) });
}
```

---

## Cache Key Generation

Default key includes:
- Pathname
- Search params (sorted)
- Request method
- Accepted content types

```typescript
function buildCacheKey(request: Request, config?: CacheConfig): string {
  if (config?.key) {
    return config.key(extractContext(request));
  }

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);
  searchParams.sort();

  return `rsc:${url.pathname}?${searchParams.toString()}`;
}
```

---

## Considerations

### What NOT to Cache
- POST requests (server actions) - mutations shouldn't be cached
- Responses with `Set-Cookie` headers
- Error responses
- Partial updates (unless specifically handled)

### Cache Headers
```typescript
// Response headers for debugging/CDN integration
{
  'X-Cache': 'HIT' | 'MISS' | 'STALE',
  'X-Cache-Key': cacheKey,
  'X-Cache-Age': secondsSinceCreation,
  'Cache-Control': `s-maxage=${ttl}, stale-while-revalidate=${swr}`,
}
```

### Edge Caching
The RSC cache can sit at different layers:
1. **In-memory** (same process) - fastest, lost on restart
2. **Distributed cache** (Redis, Memcached) - shared across instances
3. **Edge cache** (CDN, Cloudflare) - geographically distributed

The API should be storage-agnostic via the `CacheProvider` interface.

---

## Open Questions

1. **Streaming vs buffered cache writes**
   - Buffer entire response before caching? (simpler, higher memory)
   - Stream to cache while responding? (complex, lower memory)

2. **Partial update caching**
   - Should we cache partial responses?
   - How to key them? (current segments + target)

3. **Client-side cache coordination**
   - Should server cache status affect client history cache?
   - Should `X-Cache: HIT` skip client cache updates?

4. **Authentication-aware caching**
   - Vary by user? (per-user cache = low hit rate)
   - Public vs authenticated split?

5. **Revalidation triggers**
   - Time-based only?
   - On-demand via server actions?
   - Webhook integration?

---

## Next Steps

1. Implement basic `CacheProvider` interface
2. Add `cache()` route directive with `condition` support
3. Implement RSC stream tee + revival
4. Add cache headers for debugging
5. Test with in-memory cache
6. Design loader-level cache API
