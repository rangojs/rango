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
- A component that is still a promise (a route, parallel slot or intercept handler streamed under `loading()`) is awaited before encoding (`serializeSegments` in `src/cache/segment-codec.ts`); if it rejects, the serialize step throws and `cacheRoute` writes nothing, so a handler that fails after the 200 has gone out, which the MISS gate's `response.status !== 200` check in `withCacheStore` cannot see, never replaces an entry
- A component that throws while a segment is encoded (an async server component in a handler's tree) does not reject the encode: Flight reports it through `onError` and completes normally with an error row (`1:E{"digest":""}`) that throws wherever the decoded tree renders. `cacheRoute` passes an `onError` to `serializeSegments` (`src/cache/segment-codec.ts`) and, if it fires, writes nothing and reports the error as `cache-write`, so the next request is a MISS and a stale entry keeps serving. The encode re-runs the tree, so only a throw during the encode blocks the write. Prerender passes an `onError` the same way and hands the first error to the build's `prerender.onError` policy (see Render Errors in `packages/rangojs-router/docs/prerender-api-design.md`)
- The item writers and handle values follow the same rule. Besides an async component that throws, Flight reports a rejected promise, a function, a class instance and a local symbol through `onError` and writes an error row, so `serializeResult`'s `null` never fires for them. `serializeResult` (`src/cache/segment-codec.ts`) and `encodeHandles` / `encodeHandleValue` (`src/cache/handle-snapshot.ts`) take the same optional `onError`, and each writer passes one collector to its value encode and its handle encode: `"use cache"` (`src/cache/cache-runtime.ts`, the miss leader and the stale-hit refresh), a loader's own `cache()` (`src/router/segment-resolution/loader-cache.ts`, whose `setItem` throws into `readThroughItem`'s report) and `cacheRoute`. If it fires, nothing is written and the error is reported as `cache-write` (miss) or `stale-revalidation` (background refresh), so the next call re-runs and a stale entry keeps serving. A handle value that fails to encode refuses the whole entry rather than dropping only the handle blob: a hit replays the blob in place of the body's pushes, so an entry without it would serve a page missing its title or breadcrumbs until expiry. The blob is still dropped, entry kept, when its encode passes the 5 s `HANDLE_ENCODE_TIMEOUT_MS`. Prerender passes the same collector and hands the first error to its `prerender.onError` policy. The PPR shell capture passes one to its encode of each bake-lane loader container for the snapshot (`captureAndStoreShell` in `src/rsc/shell-capture.ts`); if it fires, the capture stores nothing, reports `cache-write` and backs the key off, like a render error (issue #927)

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

Override TTL or opt out. A `key()` is the exception to "the inner boundary
overrides": it composes, so nested records stay in the enclosing partition
(see "Nested keys compose" under Cache Key Customization):

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

This layer is independent of the route's segment cache: its key is only what
the binding declares (see "Opt-In Loader Caching" → "Identity"), and it does
not inherit an enclosing route `cache()` key.

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

**Isolation:** the background render, and the stale-route refresh, run through
`rerenderAndCacheRoute` (`match-middleware/background-revalidation.ts`) on a
derived request context (`Object.create(requestCtx)`) with its own handle
store. Neither swaps the request's shared `_handleStore` field. The foreground
is still producing the page when they run (the response body streams, and a
stale HIT re-runs its loaders), and a loader push reads that field at push
time, so a swap sent live pushes into the background render and they went
missing from the page. The derived context also owns an empty
`_transitionWhen`: a stale HIT replays its stored transition, so the
foreground's post-match gate must never evaluate the refresh's
`transition({ when })` predicates. It has no `_metricsStore`, and the render
runs under a derived DSL store with `metrics` unset, so neither `track()` nor
loader phase metrics reach the foreground's perf timeline. Its response writes
(headers, cookies, status, `onResponse()` callbacks) go to a throwaway context
and are dropped, not stored with the segments, because they would otherwise
reach the live response: a layout above the `cache()` boundary is outside the
header guard (the refresh would repeat the writes the HIT made itself, and
proactive caching would add writes the partial navigation skipped), and an
error boundary sets a 500.

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

That holds on a hit too. The route's entry stores only the boundary's subtree:
`cacheRoute` drops every segment whose id does not extend the boundary entry's
shortCode (`CacheScope.covers`; shortCodes are hierarchical). On a hit,
`withCacheLookup` resolves the entries above the boundary as an uncached render
would (`resolveAllSegments`, or `resolveAllSegmentsWithRevalidation` for a
partial), then replays the record and runs the loaders below the boundary. So
an outer layout's header write lands on every response, and the `ctx.set()`
values it produces reach the loaders inside the boundary. Nested enabled
`cache()` entries share the outermost one's boundary. The exception is a `ppr`
route: it is a document-scoped `cache()`, its whole chain bakes into the shell,
and the shell HIT tail must replay that chain to match the prelude, so its scope
covers the whole chain.

Before issue #906 the entry held the whole matched chain, so a hit replayed the
layouts above the boundary too: they ran 0 times and a header they wrote was
missing from every hit.

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
- **Search params**: User-facing params are included (sorted, URL-encoded). Router-internal params are excluded: `_rsc*` by prefix, plus an exact allowlist of `__`-prefixed params (`__no_cache`, `__rsc`, `__html`) — deliberately not a blanket `__*` filter, so consumer params like `__variant` still key the cache (see `src/cache/cache-key-utils.ts`).
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

Request data the key does not see must not reach the stored value, so the non-cacheable variable guard applies in both scopes. A `ctx.get()` of a `createVar({ cache: false })` variable (or a value written with `{ cache: false }`) throws inside a `cache()` boundary and inside a `"use cache"` body, whether it reads through `getRequestContext()`, a handler ctx, or a response-route ctx. The fix at the call site is to read the value outside and pass it in as an argument, which puts it in the key. The guard is `assertNonCacheableReadAllowed` (`src/server/context.ts`), called only after `isNonCacheable()` matches, so ordinary reads skip it. Loader bodies stay exempt in both scopes, but under `"use cache"` the exemption covers a loader body entered inside the cached function (`await ctx.use(Loader)`), not a cached function a loader calls: the loader re-runs on every request, the cached body does not. Each loader body scope records the exec scope it was entered in (`runInsideLoaderBodyScope`), and the exemption holds only while that exec scope is still the innermost one.

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

**Loader pushes are not recorded.** A DSL loader body can push handles too, and
its pushes land in the owning route/layout segment's bucket. A HIT runs
loaders exactly as an uncached render of the same request would (after the
replay), so a recorded copy would show up twice for any handle that does not
dedupe by key. The store tags each push made inside a DSL
loader scope (`isInsideLoaderScope()` at push time, by array position so
primitive values are covered), and `captureHandles` reads with
`getDataForSegment(id, true)` to leave them out. A loader that only a handler
consumed (`await ctx.use(Loader)` from the handler body) is skipped with its
handler on a HIT, so its pushes stay in the record. PPR shell captures use
the same tag: the capture's push wrapper passes `loaderPush: false` to
`HandleStore.push` for an `ssr: false` loader's own settled pushes, which its
record keeps, with the loader's id as `owner`. The record carries those owners
in `CachedEntryData.handleOwners`, and `restoreHandles` replays an owned value
through `HandleStore.pushReplayed`, so the loader's re-run on the HIT replaces
it instead of appending a second copy. A record without `handleOwners`
restores as a plain replay (see `docs/design/shell-fast-path.md`).

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

A route refresh that resolves an error or notFound boundary is not written, the same way the MISS gate in `cache-store.ts` skips a non-200 response, so the stale entry keeps serving until a later refresh succeeds or the entry expires (`rerenderAndCacheRoute` in `match-middleware/background-revalidation.ts`; proactive caching goes through the same gate).

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

#### Identity: keyed only by what the binding declares (#972, #974)

You might expect a loader's `cache()` inside a keyed route `cache()` to pick
up the route's partition. It doesn't. A loader's own `cache()` and `"use
cache"` are independent layers, keyed only by what they declare: the loader
entry by `key()`, else the store's `keyGenerator`, else the default
`loader:{id}:{host}{pathname}:{sortedParams}`
(`resolveLoaderKey` in `src/router/segment-resolution/loader-cache.ts`); a
`"use cache"` entry by its id and arguments. The default loader key names no
user, so one entry serves everyone.

That made the loader-body exemption a leak. `isInsideCacheScope()`
(`src/server/context.ts`) returns false in every loader body because a route
`cache()` never stores loader values. A loader with its own `cache()` does
store its value: `cookies()` in its body put the first visitor's session in the
entry and served it to everyone for the TTL, with nothing thrown or logged
(#972, reproduced on 0.17.0).

So an unkeyed fill now refuses an execution that read request identity. The
read surfaces record the read instead of throwing: `cookies()`'s read methods
(`get`/`getAll`/`has`; a write alone is not a read), the read methods of the
`headers()` view (its Proxy's `get` trap: reading `view.get(...)` or iterating
inside a loader counts even when the view was taken outside it, but a method
pulled off the view beforehand, `const get = headers().get`, is not seen; both
in `src/server/cookie-store.ts`) and
non-cacheable `ctx.get()` (`assertNonCacheableReadAllowed`) and the theme getters
(`assertThemeReadAllowed`, after #971's refusals) call
`recordLoaderIdentityRead` (`src/server/context.ts`), which marks the current
execution's recorded-tag set (`src/cache/cache-tag.ts`). Those are the #964
sets, so the read travels the same links the tags do: a loader read with
`ctx.use` links the reader's set to its value's set, whoever started that
loader. When the binding has no `key()` and its store no `keyGenerator`,
`executeLoaderData` walks its execution's links after the value settles
(`recordedIdentityRead`). A read fails the fill with
`loaderCacheIdentityError`, which names the loader and gives the fix: a `key()`
that includes the value, or no `cache()`. Note what "declared" means: the check
tests only that a `key()` or `keyGenerator` is there
(`declared: Boolean(options.key || store.keyGenerator)` in `resolveLoaderKey`),
not what it contains. A store-wide `keyGenerator` that adds a region prefix
switches the check off for every loader in that store.

Why record instead of throwing at the read, as `"use cache"` does? The first
version threw at the read, from an AsyncLocalStorage scope around the fill. It
missed the case where a reader starts the loader before its binding does, such
as a parent layout's handler calling `ctx.use` on a route's cached loader. The
MISS then reuses that run's memoized promise (`useLoader` in
`src/router/loader-resolution.ts`), which ran outside any fill, and the second
user still got the first user's session. Recording on the execution makes both
orders fail the same way, with the same error, and store nothing.

A HIT skips the body, so it records nothing. That would let an unkeyed loader
read a keyed cached loader on the keyed loader's HIT and store another user's
value. So a declared-key entry whose MISS recorded a read stores that read with
the value: an identity mark (`~identity:{read}\n`) ahead of the Flight payload
(`markIdentity`/`unmarkIdentity` in `loader-cache.ts`). A HIT or stale hit puts
the read back on the value's set (`markIdentityRead`), and an unkeyed reader
fails as it would have on the MISS. The value string is loader-cache's own:
the store only holds it, and the PPR shell snapshot copies it unchanged
(`src/cache/shell-snapshot.ts`), so the mark needs no change to the store
contract. A keyed dependency that read no identity carries no mark. Entries
written before the mark existed carry none: on a store that does not version
its keys per deploy (`VercelCacheStore` without `version`, a pinned
`version`), an unkeyed loader reading such an entry on a HIT or stale hit fills
without error until the entry is rewritten (its refresh stores the mark), so
the upgrade note says to bump `version` or `updateTag()` the affected tags.

On a foreground MISS with a declared key, the read also marks this loader's
own value set, as its readers see it: when another loader made the read, the
mark carries `via` (this loader), and an unkeyed reader's error says it reads
the value "through another loader". The HIT restores the same mark, so both
give the same error. A stale refresh does not mark the value set: the page is
served the stale entry, which its own mark (or its lack) describes, and an
unkeyed reader of that stale value fills normally. The refreshed entry carries
the refresh's read, so the next HIT marks its readers.

The write-side check runs after the handle encode (`encodeHandles`), which
waits for pending pushes: a pushed promise that reads `cookies()` settles only
there, and a check before it stored the first user's handle values. The encode
waits up to its timeout (5 s, `HANDLE_ENCODE_TIMEOUT_MS`); a push still pending
then drops the entry's handle blob and the value is stored without it, so a
read it makes later is not checked and has nothing to leak into.

The capture scope and the recorded reads live on `globalThis`
(`Symbol.for("rangojs-router:recorded-tag-capture")`,
`"rangojs-router:identity-reads"`), like the loader scopes in `context.ts`. The
recorder is installed there too, and a second evaluated copy of `cache-tag.ts`
(a duplicated package, a dev re-evaluation) replaced it with one that wrote
where no fill looked, which switched the check off.

| Execution                                                                                           | Refused       | Why                                                           |
| --------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------- |
| The MISS body                                                                                       | yes           | its value is stored under a user-free key                     |
| A run a reader started before the binding                                                           | yes           | the MISS reuses it; its set carries the read                  |
| The stale refresh (`_runLoaderIsolated`)                                                            | yes           | same entry; the refresh fails, the stale entry keeps serving  |
| A loader value the body reads via `ctx.use`                                                         | yes           | the value lands in the entry; the read link carries it        |
| A keyed cached loader's HIT the body reads via `ctx.use`                                            | yes           | its entry's identity mark                                     |
| A read that settles after the value (nested promise, pending handle push within the encode timeout) | write only    | the value is already served; the write is refused, `onError`  |
| A live loader running beside the fill                                                               | no            | its set is not linked to the fill                             |
| A loader under a route `cache()` with no `cache()` of its own                                       | no            | not stored; re-runs on every HIT                              |
| A bake-lane loader during a PPR shell capture                                                       | capture guard | `assertNotInsideShellCapture` still throws at the read, first |

Response directives (`invalidateClientCache()`, `keepClientCache()`) and cookie
writes record nothing: a `key()` cannot make a skipped body's side effect
reach a HIT.

What stays out of reach, the same as for `"use cache"`: raw reads
(`ctx.request.headers`, `getRequestContext().cookie()`), and a value computed
outside any loader execution and handed in, such as a per-request memo a
handler filled from `cookies()` before the loader awaited it. The read ran in
no loader's set, so nothing links it to the fill.

### Implementation Notes

When serving cached segments:

1. Deserialize cached component tree
2. Run loaders fresh (unless loader has its own cache())
3. Inject fresh loader data into cached component structure

This requires separating:

- **Segment cache**: Component structure, layouts, handles
- **Loader cache**: Individual loader results (opt-in), plus the handle pushes
  the loader body made. A hit skips the body, so `loader-cache.ts` records the
  pushes of the body and of the loaders it awaits via `ctx.use` on the miss
  (`startHandleCapture` with an `accept` predicate on the loader body scope,
  `isInsideLoaderBody` — the handler and sibling loaders push into the same
  store concurrently) into the item's `handles` blob, and every hit, stale
  included, appends them to the current owning segment. A stale hit's
  background revalidation diverts its fresh pushes into the refreshed entry
  only, so the live response carries each push once.

  **A dependency's pushes reach the page once per request.** The dependency
  is memoized per request and shared with live readers: a sibling DSL loader
  or the handler can read it on the same request as the cached loader's hit,
  and loaders stay live, so it runs. The record is therefore grouped by the
  loader body that pushed (the capture's `key` option, `recordOwnerKey`:
  run-length `${seq}:${loaderId}` groups, which keep push order across
  bodies), and the hit replay asks `ctx._claimLoaderPushes(loaderId)`
  (installed by `setupLoaderAccess`) for each group:

  | When the replay reaches the group                      | Result                                                                           |
  | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
  | The loader already ran in this request (a live reader) | Group skipped; the live run's pushes stand                                       |
  | Another cached loader's replay already delivered it    | Group skipped                                                                    |
  | Neither                                                | Group replayed; a later run of that loader in this request replaces those values |

  **A live run after the replay replaces the replayed values.** Loaders stay
  live, so their handle output does too. The replay pushes each value through
  `HandleStore.pushReplayed(handleName, segmentId, value, loaderId)`, which
  tags the slot with its loader. When that loader's live run pushes (the
  store reads the innermost loader body, `getCurrentLoaderBodyId()`), its
  first push removes every slot replayed for it and takes the first one's
  position in that handle/segment array, and its later pushes follow the
  previous one. A live push to another segment (the dependency's owning
  segment is its kickoff's `_currentSegmentId`) removes the replayed slots
  and lands where it is pushed.

  Why the position and not an append: the common shape is a cached loader
  that pushes its own crumb after awaiting the dependency. On the miss the
  dependency's crumb comes first; an append would put the live crumb after
  the cached loader's replayed crumb and reorder the trail on every hit.

  Why it can be replaced at all: every consumer receives full per-segment
  arrays, never deltas. `stream()` and `streamLate()` yield
  `cloneHandleData(data)`; the client's `setHandleData` replaces the whole
  state on a document or late update and assigns each segment's array on a
  partial one (an emptied array is sent as `[]`). A replacement after the
  handler barrier reaches the document through `metadata.handlesLate`, so the
  SSR HTML shows the replayed value and the client swaps in the live one after
  hydration, like any late loader push. The render-barrier snapshot that
  `ctx.rendered()` readers see is taken once and keeps whichever value was
  there.

  The live pushes go through `push()`, so a capture that accepts them sees
  them: another cached loader whose miss reads the same dependency records
  them. A live run that pushes nothing leaves the replayed values in place.

  The stale revalidation runs on its own loader executor
  (`ctx._runLoaderIsolated`, a fresh memo map). Sharing the request's
  executor made a diverted refresh take the dependency's only run: the live
  reader got the memoized result and the page lost the push (#896). The
  refresh's pushes are diverted before they reach the store, so they never
  replace anything on the page. The cost is one extra dependency run on a
  stale hit when a live reader also reads it.

  **`"use cache"` uses the same machinery for the loaders it reads (#928).**
  A cached function that reads a loader with `ctx.use(Loader)` records that
  loader's pushes, and until #928 its hit appended them while the handler or
  a DSL loader ran the same loader live, so the push showed twice. Its record
  now groups by owner too (`useCacheRecordKey`, `src/cache/handle-capture.ts`):
  `${seq}:${loaderId}` for a loader body entered inside the function, `${seq}:`
  for the function's own pushes, which still append to the calling segment
  with nested cached functions rolling up. `appendHandles`
  (`src/cache/handle-snapshot.ts`) claims each loader group through the
  caller ctx's `_claimLoaderPushes` and replays it through
  `HandleStore.pushReplayed`, so the table above applies unchanged. The stale
  refresh reads loaders through `ctx._runLoaderIsolated` and never claims
  (`refreshView`, `src/cache/cache-runtime.ts`). Entries written before owner
  keys carry segment-id keys (no `:`) and replay in full, as before.

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

#### Nested keys compose (issue #970)

A `key()` is a partition of the whole subtree, not of one boundary. You might
expect "the nearest `cache()` wins" to be harmless here, since it is how
`ttl` and `swr` behave. It is not, and that was the bug: the innermost scope's
config alone decided the record key, so an inner `cache()` without `key`
wrote under the default key and an inner `key()` dropped the outer one. With
the outer scope partitioning by tier, a silver visitor HIT the record a gold
visitor's request wrote under the inner scope, and once PR #969 made the PPR
shell partition follow the record key, the shell shared it too.

So `CacheScope` carries the chain of `key()` functions from the outermost
`cache()` down to itself (`keyFns`, built in the constructor from
`parent.keyFns`; `cache(false)` adds none and does not cut the chain), and
`resolveKeyFrom` resolves the record key from it. The parts are the chain's
`key()` results, outermost first; a scope whose own config sets no `key()`
appends its own default key (`resolveDefaultKey`: its store's
`keyGenerator(ctx, defaultKey)` result, else the default key). Two or more
parts are joined by `composeCacheKeys`, each URI-encoded:

| The route's scope                                     | Record key                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| no `key()` on the chain                               | its default key (unchanged)                                        |
| a single keyed scope (`key()` of its own, none above) | its raw `key()` result (byte-identical to before)                  |
| no `key()` of its own, under a keyed scope            | `compose(outer key() results..., its default key)`                 |
| its own `key()`, under a keyed scope                  | `compose(outer key() results..., its key() result)`                |
| `cache(false)` innermost                              | no read, no write (unchanged)                                      |
| `cache()` re-enabled under `cache(false)`             | still in the partition: `compose(outer key() results..., default)` |

Why the default key in the inherit case: a first cut reused the outer
`key()` result verbatim, and that made a new collision. A `key()` replaces
the whole default key, so with ``key: (ctx) => `tier:${tier}` `` every
route under an inner `cache()` without `key`, and every route directly under
the outer one, wrote under the one store key `tier:gold`. The store key
carries no scope or route discriminator (`lookupRouteDetailed` reads
`store.get(key)`, `cacheRoute` writes `store.set(key, ...)`), and nested
enabled scopes share the outermost boundary (`createCacheScope`), so the
boundary filter in `lookupRouteDetailed` keeps the other route's segments
and `/b` rendered `/a`'s record. Composing the inner scope's own default key
keeps what it told apart before (path, params, search, document vs
navigation) and adds the partition.

Why URI-encode: raw, `("a|b", "c")` and `("a", "b|c")` both join to
`a|b|c`, and a partition is request-derived. An encoded part holds no `|`, so
every tuple maps to its own key and the number of parts is recoverable from
the key. The same trick keeps the PPR shell key unambiguous
(`partitionShellKey` in `src/rsc/shell-capture-constants.ts` encodes the
partition again). The collision probe in
`src/cache/__tests__/nested-cache-key.test.ts` pins it.

That guarantee holds among composed keys, not against a single raw one. A
single keyed scope stores its `key()` result as is (byte-identical to before
#970), and nothing stops that string from equalling a composed key: a
`key()` returning the header value `gold|doc%3Alocalhost%2Fpricing` raw
names gold's inner `/pricing` record, which is cross-route poisoning when
the value is untrusted. The class is older than #970, since a raw `key()`
could always name a `doc:` default key. The defence is at the call site:
never return raw request input from `key()`; normalize, prefix or encode
it. A composed key holds no `:` (`encodeURIComponent` escapes it in every
part), so a prefixed result like `tier:${value}` never equals one; the
probe pins that too.

A scope with its own `key()` skips the store's `keyGenerator`, as a single
`key()` always did. Each `key()` is memoized on the request context by
function (`_resolvedCacheKeys`), so it runs once per request however many
scopes and lookups use it (sibling routes under one keyed `cache()`, the
document, partial and shell keys), and a shell capture, whose context is
`Object.create` of the request's, reuses the foreground's results instead of
running `key()` under the capture guard. A keyGenerator result is memoized
per default key, as before.

The response-route entry (`response-cache-serve.ts`) keys the same way: it
reads the scope's `resolveKeyFrom` instead of the innermost `config.key`. The
PPR shell partition does not take the default key:
`CacheScope.resolvePartition` (called by `resolveShellPartition`) composes
the chain's `key()` results alone, because the shell key already carries
host, path and search. A scope without its own `key()` whose store has a `keyGenerator`
adds that result when it differs from the `doc` default key, as an unkeyed
scope's partition always did: the record is split by it, so the shell must
be too.

To share an inner cache across partitions on purpose, declare it outside
the keyed `cache()`.

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

- `updateTag(...tags): Promise<void>` - **read-your-own-writes, confirmed**. Resolves once every configured store's invalidation completes, durable write included, and rejects when one fails, so awaiting it inside a server action makes the action's own re-render fresh and tells the action the invalidation was stored.
- `revalidateTag(...tags): void` - **background (non-blocking)**. The durable write runs in the background (`waitUntil`); use it in route handlers / webhooks. NOT stale-while-revalidate: like `updateTag` it hard-purges, so the next read after the invalidation lands is a fresh miss. The request that calls it also reads its own writes (below). The only difference from `updateTag` is awaitability: a failed durable write goes to `onError` instead of rejecting.

Both fan out across the app-level store (`ctx._cacheStore`) and any explicit `cache({ store })` stores the handler resolved, calling the store-level `invalidateTags()` primitive (passing the whole tag batch in one call). The CF store records tag-invalidation markers in its own KV namespace and compares each entry's `taggedAt` against them on read - there is no separate tag-invalidation store. Note that the separate `revalidate()` export is a client-update axis (which segments re-render on a navigation or action), not a cache bust.

**Read-your-own-writes in the invalidating request (#973).** Both verbs call `invalidateTags()` synchronously, inside the request. Each built-in store masks the tags for the rest of that request before its first await, and only then starts the durable write (KV marker put, tag purge, `expireTag`), which `revalidateTag()` hands to `waitUntil` without waiting. Before #973, `revalidateTag()` deferred the whole call to `waitUntil`, and `CFCacheStore` with KV wrote its per-request marker memo only after the KV put: a server action that called `revalidateTag("x")` and then rendered read the pre-invalidation `"use cache"` and `cache()` entries tagged `x`, and memoized the absent marker for the rest of the request. The mask per store:

| Store                     | Request-local step (before the first await)                                                                                                                                         | Durable step                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemorySegmentCacheStore` | the whole invalidation: markers set, tagged entries deleted                                                                                                                         | none                                                                                                                                                            |
| `CFCacheStore`            | the per-request tag-marker memo takes the new marker (`maskTagsForRequest`), with KV or `tagPurge`; data reads, purge-mode L1 hits and shell reads consult it                       | KV marker puts; for each confirmed put, the isolate marker memo and L1 write-through; then the purge and hooks for the whole batch, whether or not a put failed |
| `VercelCacheStore`        | a per-request tag map (`requestInvalidations`); segment, item and response hits carrying a tag, written at or before the invalidation (envelope `ta`), miss, and so do shell checks | `tm` marker writes, the process marker memo, `expireTag`                                                                                                        |

The invariant: the mask only turns the invalidating request's hits into misses. If the durable write then fails, that request paid extra misses, never a stale read, and every other request reads the durable state. That is why a `CFCacheStore` marker read still in flight when the mask is set resolves to the mask for this request but publishes nothing: it skips the L1 marker populate and the isolate marker memo, which only the confirmed put writes (`fetchTagMarker`'s `fromRequest`, set only for a tag this request masked, `isRequestMasked`). A reviewer's probe caught the earlier version doing both, so a failed put made other requests miss for `tagCacheTtl` or `markerFreshMs`. A KV-less purge-mode L1 hit without entry Cache-Tags (written before the store stamped them) reads the per-request memo too; before, it went to the marker check, which KV-less never masks.

The mask belongs to the request, not to the context object that set it. A PPR HIT tail, a shell capture and a background revalidation render run on `Object.create(reqCtx)`, and a mask keyed by that object started empty: a GET whose middleware invalidated and then served a HIT read the tail's holes unmasked. `createRequestContext` now sets `RequestContext._requestRoot`, which derived contexts inherit. `VercelCacheStore` keys its mask by it, and `CFCacheStore` keeps a root-keyed `requestMasks` record that a derived context's memo starts from (`cf-tag-marker-memo.ts`), while each context keeps its own memo for the marker values it reads.

The mask lives in the stores, so three more paths needed the request itself; all are `"use cache"` executions (`cache-runtime.ts`). Both verbs record the invalidated tags on the request root (`RequestContext._tagInvalidations`) with their position in a module-level order (`currentCacheSeq` in `tag-invalidation.ts`), and each execution records the position it started at. A counter, not `Date.now()`: Workers advance the clock only on I/O, so an execution started right after the call would share its millisecond, count as older, and never fill. An execution counts as predating the call only when one of its own tags was invalidated after it started (`invalidatedSince`), so an execution with other tags still fills. Its own tags are its profile's `tags` and the `cacheTag()` calls in its body. A nested `"use cache"` function records its tags on the request (`recordRequestTags`), not into the enclosing execution's tag scope, so they reach neither the enclosing entry nor this gate: after `updateTag("inner")`, an outer execution that started earlier is still joined and written, and the outer entry is not evicted either ([#980](https://github.com/rangojs/rango/issues/980)). Such an execution is:

- not joined. A call made earlier in the request whose result is still being serialized for its store write sits in the isolate's in-flight executions (`inFlightExecutions`); the same call after the invalidation used to join it and got `["beer #1", "beer #1"]`. A caller that declines it joins a newer execution registered meanwhile rather than starting one more, so five concurrent calls after the invalidation run the body once, not five times.
- not written. With `await updateTag()`, the first call's write landed after the invalidation and the second call read it back.
- not written by a stale refresh either. A stale hit's background refresh that started before the call read the data from before it; its write used to land after the call and serve `"old"` to the rest of the request and to later requests.

What stays open ([#977](https://github.com/rangojs/rango/issues/977)): an execution in another request that started before this invalidation still writes when it finishes, and every built-in store accepts that write as newer than the invalidation, so the invalidating request or a later one can read it (`CFCacheStore.setItem` stamps `taggedAt` at write time, `MemorySegmentCacheStore.setItem` checks no marker, `VercelCacheStore` stamps `ta` at write time). The same holds for a loader's own `cache()` entry (`read-through-swr.ts`), whose executions and refreshes the request order does not gate at all. That write-after-invalidate race is older than #973; the PPR shell write gate (`isTagsInvalidatedSince` against the capture start) is the shape a fix would take.

A custom store gets the same behavior by recording its invalidation in request-scoped state its reads consult before the first await of its `invalidateTags()` (the contract is on `SegmentCacheStore.invalidateTags` in `src/cache/types.ts`). One that does not still works; the request that ran `revalidateTag()` can then read entries the invalidation covers until the durable write lands.

The CF store also has an opt-in **purge mode** (`tagPurge: { zoneId, apiToken }`, or a custom purge function — `createCloudflareZonePurge` is the underlying client): tagged L1 entries carry namespaced `Cache-Tag` headers, `invalidateTags()` awaits one batched Cloudflare purge-by-tag call, and ordinary L1 data hits skip the per-read marker lookup. KV reads and KV-backed PPR shell reads retain the marker check; runtime shell L1 entries are purgeable, but an older capture can finish after its invalidation purge, so the generation marker still prevents resurrection while KV is bound. A KV-less store runs shells L1-only (edge-only ppr) with the purge-trust read + per-request memo instead; its per-isolate PPR shell memo is not purged, so another isolate serves a purged shell for up to `memo.shellMs` (default 2000) to every user but the mutating one, whose fresh-reads cookie skips the memo (`{ shellMs: 0 }` where every user's next request must see the purge). Semantics, credentials setup, trade-offs, and the environments/previews zone-scoping guide: [cache-tags-flow.md](./cache-tags-flow.md) "Purge mode".

---

## Open Problems

### Invalidation

Shipped invalidation mechanisms:

- TTL-based expiration (shipped)
- Tag-based invalidation - shipped; built-in stores index by tag, invalidated via `updateTag()` / `revalidateTag()` (see "Tags for Invalidation" above)
- Server action integration - shipped; `await updateTag(...)` and `revalidateTag(...)` inside a server action both give read-your-own-writes for the action's own render (#973)

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
