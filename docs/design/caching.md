# RSC Router Caching Design

If you want the _reasoning_ behind segment-level caching — why it caches at the
segment level, how SWR and proactive caching fit, what the cache key carries —
this is where it's written down. Just go in knowing it's the original design
narrative, not an API reference; the note below tells you where the shipped API
lives.

> **Historical design context.** This document captures the original design and POC narrative for segment caching. Some examples below predate the shipped API surface and are kept for the reasoning they record, not as copy-paste references. For the current, shipped API see the skills: `skills/caching`, `skills/cache-guide`, `skills/use-cache`, and `skills/document-cache`. The package is `@rangojs/router`; cache stores and the document-cache middleware are imported from `@rangojs/router/cache`.

## Implementation Status

### ✅ Completed

- **Router-level cache integration** - Cache check before handler execution in `match()` and `matchPartial()`
- **Cache provider in request context** - `CacheScope` via AsyncLocalStorage
- **Handle data caching** - Handles cached with segments, replayed on cache hit
- **Parallel segment support** - All segments per entry (main + parallels) cached together
- **In-memory store** - `MemorySegmentCacheStore` with TTL, survives HMR via `globalThis`
- **Cache bypass** - `?__no_cache` query param disables caching per-request
- **Pluggable store API** - `SegmentCacheStore` interface with handler-level configuration
- **Per-route cache configuration** - `cache({ ttl, swr, store })` DSL for route definitions
- **Store-level defaults** - `MemorySegmentCacheStore({ defaults: { ttl, swr } })`
- **Per-section stores** - `cache({ store })` for dedicated stores per route section
- **Production storage backends** - `CFCacheStore` (Cloudflare Cache API L1 + KV L2) and `VercelCacheStore` (Vercel Runtime Cache via `getCache`) from `@rangojs/router/cache`
- **Cache invalidation API** - `cache()` / cache profiles accept `tags`, and `cacheTag(...tags)` tags entries at runtime inside `"use cache"`. Built-in stores index by tag and invalidate via store-level `invalidateTags()`. Consumers call `updateTag(...tags)` (awaitable) or `revalidateTag(...tags)` (background). Both hard-purge.
- **Proactive caching** - Background re-resolve of null-component segments via `waitUntil` (`src/router/match-middleware/cache-store.ts`) so partial navigations get complete cache entries
- **Search param filtering** - global `cache.searchParams` (`"all" | "none" | { include } | { exclude }`, `*` suffix wildcards, `TRACKING_SEARCH_PARAMS` constant) controls which query params key the cache across every tier (see "Search param filtering" under Cache Key Structure)

### 🚧 Remaining

- **Redis (and other adapters)** - no first-party Redis `SegmentCacheStore` yet
- **Manual whole-store purge API** - store-level wipe-all is still future work (`clear()` is optional / test-only on most backends)
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
  layout(<BlogLayout />),       // cached individually
  path("post/:slug"),          // cached individually
  path("list"),                // cached individually
  path("sidebar"),             // cached individually
])
```

### Nested Cache Boundaries

Override TTL or opt out:

```typescript
cache({ ttl: 60 }, () => [
  layout(<BlogLayout />),

  path("post/:slug"),

  path("admin", () => [
    cache(false),  // opt out of caching
  ]),

  cache({ ttl: 300 }, () => [
    path("static-page"),  // longer TTL
  ]),
])
```

### Loader Caching

Loaders can have their own cache configuration:

```typescript
path("post/:slug", () => [
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
  path("about"),
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
  path("post/:slug", () => [
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
path("post/:slug", () => [loader(PostLoader, () => [cache({ ttl: 30 })])]);
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
  path("post/:id", ...),         // Proactive caching applies
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

Cache keys combine request type prefix, pathname, sorted route params, and sorted user-facing search params:

```
{prefix}:{pathname}:{sortedParams}?{sortedSearchParams}
```

- **Prefix**: `doc` (full page), `partial` (navigation), or `intercept` (modal/overlay).
- **Search params**: User-facing params are included (sorted, URL-encoded). Router-internal params are excluded: `_rsc*` by prefix, plus an exact allowlist of `__`-prefixed params (`__no_cache`, `__rsc`, `__html`, `__prerender_collect`) — deliberately not a blanket `__*` filter, so consumer params like `__variant` still key the cache (see `src/cache/cache-key-utils.ts`).
- **Partial response capability**: document-cache entries append a fragment-capable variant when `X-Rango-Fragment-Passthrough: 1` is present. The middleware can return before route matching, so its key must mirror the RSC response's `Vary` contract and never serve fragment envelopes to a legacy or context-less client. `X-Rango-Fragment-Recovery: 1` skips that variant's read so the failed fragment retry reaches segment decode and eviction, then the ordinary write path replaces the corrupt response bytes with the valid fallback.
- **Determinism**: Both route params and search params are sorted alphabetically for stable keys regardless of insertion order.

```typescript
// Examples:
// "doc:/products"
// "partial:/products:slug=shoes"
// "partial:/products:slug=shoes?page=2&sort=asc"
// "intercept:/products:slug=shoes"
```

For `"use cache"` functions, cache keys follow the format `use-cache:{functionId}:{serializedArgs}` where tainted ctx arguments contribute `pathname`, `params`, `_responseType`, and normalized search params to the key.

### Search param filtering (`cache.searchParams`) — shipped

By default every non-reserved query param produces a distinct cache slot. That
hurts twice: `/products?utm_source=tw` and `/products?utm_source=ig` occupy
separate entries in every tier (fragmentation), and a `?fbclid=…` URL skips the
prerendered shell entirely (the build-shell manifest only matches URLs whose
filtered search string is empty) — ad-click traffic is exactly the traffic you
prerendered for.

One global option on the `createRouter` cache config controls which params key
the cache:

```typescript
import { createRouter, TRACKING_SEARCH_PARAMS } from "@rangojs/router";

type CacheSearchParams =
  | "all" // default — every non-reserved param keys the cache
  | "none" // query params never key the cache
  | { include: string[] } // allowlist: only these key the cache
  | { exclude: string[] }; // denylist: all except these

createRouter({
  document: Document,
  cache: {
    store: cacheStore,
    searchParams: { exclude: TRACKING_SEARCH_PARAMS },
  },
});
```

`TRACKING_SEARCH_PARAMS` (exported from `@rangojs/router` and
`@rangojs/router/cache`) covers `utm_*`, `gclid`, `fbclid`, `msclkid`,
`ttclid`, `mc_eid`, … so the common case is one line without changing the
default for anyone.

Semantics:

| Aspect                 | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope of effect        | Cache key only. `ctx.searchParams` and the request URL are untouched — handlers and loaders still see the full query string.                                                                                                                                                                                                                                                                                                                                                                                    |
| Matching               | Exact names plus `*` suffix wildcard (`utm_*`). No RegExp: keeps the config serializable and deterministic.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `include` + `exclude`  | Unrepresentable — the union type forces exactly one mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Router-internal params | The reserved exclusion (`_rsc*` prefix + the `__` allowlist) applies BEFORE this filter; `include: ["__no_cache"]` cannot re-key on them.                                                                                                                                                                                                                                                                                                                                                                       |
| Ordering               | Filtering happens inside `sortedSearchString` before the existing codepoint sort — surviving params stay order-insensitive exactly as before.                                                                                                                                                                                                                                                                                                                                                                   |
| `key:` override        | Unchanged — a custom `key` on `cache()` still bypasses all default key generation, including this filter.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Tiers covered          | Segment (`cache-scope.ts`), document (`document-cache.ts`), response (`response-cache-serve.ts`), PPR shell capture/lookup (`shell-serve.ts` `buildShellKey`), build-shell manifest matching (`shell-build-manifest.ts`), `"use cache"` ctx normalization (`cache-runtime.ts`), testing `shellCacheKey`/`dispatch`. One compiled filter (`src/cache/search-params-filter.ts`) rides the request context (`_searchParamsFilter`) and threads through `cacheKeyBase`/`sortedSearchString`, so tiers cannot drift. |
| Byte-stability         | A URL containing no filtered params produces the same key as before, so existing persisted entries stay valid; only previously-fragmented variants collapse.                                                                                                                                                                                                                                                                                                                                                    |
| Shell manifest         | A URL whose only params are excluded ones matches the prerendered shell — filtering happens before the emptiness check.                                                                                                                                                                                                                                                                                                                                                                                         |

The footgun to document loudly: excluding a param is a promise that rendered
output does not depend on it. If it does, the first variant gets cached and
served to everyone (the classic CDN cache-key mistake). That is why the default
stays `"all"` — correct by default, opt into collapsing.

Deliberately global-only, no per-`cache()` override. The per-route "search page
varies only by `q`/`page`/`sort`" case is already reachable through the
existing `key:` override, and a static global config means the filter compiles
once per request from a plain data shape — no `defaults`-style inheritance and
no per-request ambiguity for the build-shell manifest gate.

## Storage Backend

Pluggable `SegmentCacheStore` interface configured at handler level. The
shapes sketched in this historical narrative predate the shipped types; for the
authoritative, copy-pasteable definitions see `src/cache/types.ts`
(`SegmentCacheStore`, `CacheGetResult`, `CachedEntryData`). In brief, the
shipped store returns a `CacheGetResult` (data + `shouldRevalidate`) from
`get()`, takes an optional `swr` on `set()`, and carries a larger optional
surface (`getResponse`/`putResponse`, `getItem`/`setItem`, `invalidateTags`,
`keyGenerator`, `defaults`); the shipped `CachedEntryData` is
`{ segments, handles: string, expiresAt, tags?, taggedAt? }` (`handles` is a
single Flight-encoded string, not a per-segment record).

### Handler Configuration

```typescript
import { createRouter } from "@rangojs/router";
import { MemorySegmentCacheStore, CFCacheStore } from "@rangojs/router/cache";

// Store with defaults - TTL/SWR inherited by all cache() boundaries
const cacheStore = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 300 },
});

export const router = createRouter({
  document: Document,
  cache: { store: cacheStore },
});

// Dynamic config with env + ctx (for Cloudflare bindings)
export const router = createRouter({
  document: Document,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      defaults: { ttl: 60, swr: 300 },
      ctx: ctx!, // Always provided in Cloudflare Workers
      kv: env.KV, // KV L2 for global persistence
    }),
  }),
});
```

### Implementations

**Available** (from `@rangojs/router/cache`):

- `MemorySegmentCacheStore` - In-memory Map; named stores survive HMR via `globalThis`
- `CFCacheStore` - Cloudflare edge store (Cache API L1 + optional KV L2 for cross-colo persistence), full SWR support

`CFCacheStore` bounds each read tier with a latency budget so a degraded colo or
KV namespace degrades to the next tier instead of stalling the request:
`edgeLookupTimeoutMs` (default 25ms, L1 `cache.match`), `edgeReadTimeoutMs`
(default 20ms, L1 body read), `kvReadTimeoutMs` (default 170ms, L2). A timed-out
lookup logs `[CFCacheStore] ... exceeded <n>ms; treating as miss` and falls
through; `<= 0` disables a budget. Raise a budget only when HEALTHY reads
legitimately run slower — measure the p99 first. Full table and fail-open
semantics: `skills/caching/SKILL.md` (Latency budgets); canonical defaults:
`src/cache/cf/cf-cache-constants.ts`.

KV keys of any length are safe: composed keys over Cloudflare KV's 512-byte
limit are normalized at the `toKVKey` chokepoint (preserved 400-byte prefix +
128-bit SHA-256 digest of the full key) for every family — segments, `"use
cache"` items, shells, documents, and tag markers — so oversized keys persist
to L2 instead of silently failing with a KV 414.

**Planned:**

- Redis adapter
- Other distributed backends

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

This POC sketch carried `createdAt`/`staleAt`/`revalidationContext` and a
per-segment `handles` record. The shipped `CachedEntryData`
(`src/cache/types.ts`) is leaner — `{ segments, handles: string, expiresAt,
tags?, taggedAt? }` — and staleness/revalidation is decided by the store
(`CacheGetResult.shouldRevalidate`) rather than by fields on the entry. Treat
the snippet below as the original reasoning, not the current type.

```typescript
// Historical POC shape (see src/cache/types.ts for the shipped type)
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

  path("post/:slug", () => [
    loader(PostLoader),        // ❌ NOT cached (runs fresh)
    loader(ViewCount),         // ❌ NOT cached (runs fresh)
  ]),
])
```

### Opt-In Loader Caching

Use `cache()` wrapper to explicitly cache loader results:

```typescript
path("post/:slug", () => [
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

  path("blog", () => [
    layout(<BlogLayout />),         // ttl: 60 (inherited)
    path("post/:slug"),             // ttl: 60 (inherited)
  ]),

  // Override for specific section
  cache({ ttl: 300 }, () => [
    path("static-page"),            // ttl: 300 (overridden)
  ]),

  // Opt out of caching
  cache(false, () => [
    path("admin"),                  // ❌ Not cached
  ]),
])
```

### API Signature

```typescript
// All signatures supported:
function cache(children: () => RouteChildren[]): RouteChild;
function cache(
  options: CacheOptions | false,
  children?: () => RouteChildren[],
): RouteChild;
// Named profiles are applied via the "use cache: <profile>" directive,
// not a cache("profileName") form in the route tree.

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

  // get() returns a CacheGetResult ({ data, shouldRevalidate }), not the raw
  // entry; set() takes an optional swr window. See src/cache/types.ts for the
  // full shipped interface, including the optional response-cache
  // (getResponse/putResponse), "use cache" item (getItem/setItem),
  // invalidateTags, and keyGenerator surface.
  get(key: string): Promise<CacheGetResult | null>;
  set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void>;
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

export const router = createRouter({
  document: Document,
  cache: { store: appStore },
});

// In route definition (inside urls()):
cache(() => [                               // Uses appStore (ttl: 60)
  layout(<ShopLayout />),
  path("products/:id"),

  cache({ store: checkoutStore }, () => [   // Uses checkoutStore (ttl: 10)
    layout(<CheckoutLayout />),
    path("checkout"),
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
      if (cookies().get("session")) return false;
      return true;
    },
  },
  () => [path("product/:id")],
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
  () => [path("product/:id")],
);
```

### Tags for Invalidation

> Flow diagrams (write / read / invalidate) for human review: [cache-tags-flow.md](./cache-tags-flow.md).

```typescript
cache(
  {
    ttl: 300,
    tags: (ctx) => [`product:${ctx.params.id}`, "products", "catalog"],
  },
  () => [path("product/:id")],
);
```

Tags can be attached three ways: statically via `cache({ tags: [...] })`, dynamically via `cache({ tags: (ctx) => [...] })`, or at runtime inside a `"use cache"` function via `cacheTag(...tags)`. The built-in `MemorySegmentCacheStore` and `CFCacheStore` index by tag and invalidate them.

To invalidate on demand, call one of (both variadic, server-only, exported from `@rangojs/router`):

- `updateTag(...tags): Promise<void>` - **read-your-own-writes**. Resolves once in-process invalidation across every configured store completes, so awaiting it inside a server action makes the action's own re-render fresh.
- `revalidateTag(...tags): void` - **background (non-blocking)**. Runs invalidation in the background (`waitUntil`); use it in route handlers / webhooks. NOT stale-while-revalidate: like `updateTag` it hard-purges, so the next read after the invalidation lands is a fresh miss. The only difference from `updateTag` is awaitability.

Both fan out across the app-level store (`ctx._cacheStore`) and any explicit `cache({ store })` stores the handler resolved, calling the store-level `invalidateTags()` primitive (passing the whole tag batch in one call). The CF store records tag-invalidation markers in its own KV namespace and compares each entry's `taggedAt` against them on read - there is no separate tag-invalidation store. Note that the separate `revalidate()` export is a client-update axis (which segments re-render on a navigation or action), not a cache bust.

The CF store also has an opt-in **purge mode** (`tagPurge: { zoneId, apiToken }`, or a custom purge function — `createCloudflareZonePurge` is the underlying client): tagged L1 entries carry namespaced `Cache-Tag` headers, `invalidateTags()` awaits one batched Cloudflare purge-by-tag call, and ordinary L1 data hits skip the per-read marker lookup. KV reads and PPR shell reads retain the marker check; runtime shell L1 entries are purgeable, but an older capture can finish after its invalidation purge, so the generation marker still prevents resurrection. Semantics, credentials setup, trade-offs, and the environments/previews zone-scoping guide: [cache-tags-flow.md](./cache-tags-flow.md) "Purge mode".

---

## Open Problems

### Invalidation

Shipped invalidation mechanisms:

- TTL-based expiration (shipped)
- Tag-based invalidation - shipped; built-in stores index by tag, invalidated via `updateTag()` / `revalidateTag()` (see "Tags for Invalidation" above)
- Server action integration - shipped; `await updateTag(...)` inside a server action gives read-your-own-writes

Still future work:

- Manual whole-store purge API (not shipped)

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

Cache logging is gated behind the `INTERNAL_RANGO_DEBUG` flag (see `src/internal-debug.ts`); cache modules such as `cache-scope.ts` and `loader-cache.ts` wrap their `console.log` calls in that check (e.g. `debugCacheLog()`), so production runs are silent by default. Performance traces are similarly gated behind `debugPerformance`. There are no longer unconditional `console.log` statements in the cache path. Possible future refinements:

- Structured logging for production
- Log levels (debug/info/warn/error)
