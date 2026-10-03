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

Override TTL or opt out. `key`, `condition`, `tags` and a store
`keyGenerator` are the exceptions to "the inner boundary overrides": a
`key()` composes, so nested records stay in the enclosing partition, every
enclosing `condition()` must allow a nested read or write, nested records
carry the enclosing `tags`, and an enclosing store's `keyGenerator`
partitions a nested scope on another store (see "Nested keys compose" and
"Conditions and tags inherit" under Cache Key Customization):

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

The shipped whole-response tier is the store-backed `createDocumentCacheMiddleware`
(`src/cache/document-cache.ts`, `skills/document-cache`): it stores a response
whose `Cache-Control` carries `s-maxage` and serves it to every visitor on that
key. So nothing in the stored bytes may belong to the visitor who happened to
render them. The router adds one such value itself: `metadata.initialTheme`,
the theme `useTheme()` starts at. Before #978 it was the rendering visitor's
theme cookie. A dark visitor who warmed the entry handed `"dark"` to every later
visitor with no stored theme, for the page's lifetime, because `ThemeProvider`
re-syncs only from an explicitly stored theme. The `<html>` class stayed right,
because the theme script reads `document.cookie`; only `useTheme()` readers
(a toggle label, an icon) showed the other visitor's theme.

The rule now matches the PPR shell capture: a render whose response opted in
to the document cache before `next()` carries the no-cookie default. The
middleware marks the render it may store (`_documentCacheRender`, set after the
store lookup, so it covers the MISS and the stale refresh), and
`payloadInitialTheme` (`src/rsc/full-payload.ts`) returns `defaultTheme` when
that mark is set and the response stub already opts in
(`documentCacheStoresRender`, the same `shouldCacheResponse` predicate the
write uses). Any other render keeps the visitor's theme. That includes the
unmatched-route 404 (`src/rsc/handler.ts`): middleware can opt a URL in before
`next()` while the stub is still a 200, so the 404 reads `_readTheme()`
directly instead of going through `payloadInitialTheme`. A 404 is never stored,
so the default would only have cost that visitor their own theme.

You might ask why the render trusts the stub rather than the final response.
The payload is built before `next()` returns, so a `Cache-Control` written
after `await next()` or in `onResponse` is invisible to it. That case gets a
write-side check instead: `payloadInitialTheme` marks `_payloadVisitorTheme`
whenever it emits a theme other than the default, and `shouldCacheResponse`
refuses to store a response carrying the mark. A late opt-in therefore stores
only a default-theme render; it fills more slowly, but never leaks a theme.

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
missing from the page. (`transition({ when })` needs no isolation here:
the server never evaluates it, and a stored segment never holds it; the
foreground attaches the predicate from its own match right before Flight.)
The derived context has no `_metricsStore`, and the render
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

Request data the key does not see must not reach the stored value, so the non-cacheable variable guard applies in both scopes. A `ctx.get()` of a `createVar({ cache: false })` variable (or a value written with `{ cache: false }`) throws inside a `cache()` boundary and inside a `"use cache"` body, whether it reads through `getRequestContext()`, a handler ctx, or a response-route ctx. The fix at the call site is to read the value outside and pass it in as an argument, which puts it in the key. The guard is `assertNonCacheableReadAllowed` (`src/server/context.ts`), called only after `isNonCacheable()` matches, so ordinary reads skip it. It is a wrapper over `guardIdentityRead`, the one guard `cookies()`, `headers()` and the theme reads go through too, so all four refuse in the same places: a PPR capture first, then a `"use cache"` body, then a `cache()` boundary. Loader bodies stay exempt under `cache()` (a route `cache()` never stores a loader's value). Under `"use cache"` nothing is exempt: a loader body entered inside the cached function (`await ctx.use(Loader)`) runs as part of that body, and its value is part of what the function returns and stores. Before, a non-cacheable `ctx.get()` there was exempt while `cookies()` threw, and the entry kept the first request's value under a key that did not include it.

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
in `CachedEntryData.handleOwners`.

**An owned value follows its loader's value.** A copy of a loader's push in a
record is only right next to the loader data of the same run, so
`restoreHandles` asks where this request takes that loader's value from
before it decides what the copy is. The answer is one function per record
hit, `OwnedPushDelivery = (loaderId) => RecordAuthority`, built by
`loaderPins` in `src/router/segment-resolution/loader-cache.ts` over the pins
`resolveLoaderData` reads the value from (`servedPins`; the seed is keyed by
loader id, so both look a loader up the same way). `CacheScope` hands the
same function to the store (`HandleStore.setRecordAuthority`), with or
without a handles blob in the record:

| The request serves the loader from                                         | Authority | Its copy in the record is                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the pin stored with this record (a shell replay that kept its loader pins) | `"pin"`   | restored (`HandleStore.pushRestored`): it stands. A run of the loader on the replay reads the store, so its settled pushes, anywhere inside its body, are dropped, with or without a copy in the record; its thenable pushes are added |
| anything else: a run, or the loader's own `cache()` entry                  | `"hole"`  | a placeholder (`pushPlaceholder`, unclaimed): the run's pushes replace it, a run that makes none drops it, and the loader's entry delivers its recorded pushes in its place                                                            |

Two more answers cover what the record cannot say. `"copies"`: the copies
stand and nothing is claimed about the loader's other pushes (a pin stored
before captures recorded every push, v0.17, whose record may hold none of
them; a dependency of pinned loaders). `"placeholders"`: the copies are
placeholders and the loader is no hole in itself (a dependency while a pin is
missing).

The first row is a document HIT, a navigation replay, a prefetch replay and
the seeded fallback after an explicit route `cache()` miss, all alike. The
second is every live-lane loader, and every loader of a record without
pins: a shell entry that lost them (a navigation-only entry,
`ppr.maxSnapshotBytes`), a route `cache()` record a capture wrote, and any
record restored during a capture. Only a ppr route gets a delivery at all
(`isPprEntry`, in `withCacheLookup`): no other route's records hold a loader
push, so they restore as a plain replay. Until #1001 and #1003 the request's type
decided instead (`docTail` restored, a navigation replayed and claimed): a
navigation showed pinned data next to a live push and lost the deferred push
of the loader's `cache()` entry, and a document HIT of an entry without pins
showed fresh data next to the capture's push. The design, and what is still
open, is in `docs/design/handle-push-ownership.md`.

A hole's body also ends the search for a restored loader around a push (a
`"hole"` loader, or one with placeholders), so a live loader that a running
bake-lane loader awaits keeps its live pushes. A dependency the route
registers on neither lane is credited at capture to the first registered loader around it: under
a live-lane loader its pushes are that hole's and stay live; run only under
a bake-lane loader, its pushes are recorded under its own id. Such a
dependency has no pin of its own, and the record does not name the loader
that ran it, so its copies stand while every `ssr: false` loader of the route
is pinned, even where a live loader runs it on the HIT, and are placeholders
otherwise. A record without `handleOwners` restores
as a plain replay (see `docs/design/shell-fast-path.md`).

A bake-lane loader that runs on a HIT (a promise-carrying one, or every
promise-free one on a page whose capture saw a loader push it could not
record, since `runs` is capture-wide) reads the real store for its
`"use cache"` and `cache()` values, not the snapshot: on `CFCacheStore` that
is a Cache API or KV read per HIT, and a stale entry can start a background
refresh.

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
entry by `key()` (stored as `loader:{id}:key:{encoded result}`, see "Loader
key results are namespaced" below), else the store's `keyGenerator`, else
the default `loader:{id}:{host}{pathname}:{sortedParams}`
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
(`readGuardedTheme`), both through `guardIdentityRead` after its refusals, call
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
fails as it would have on the MISS. The value string is loader-cache's own
and the store only holds it, so the mark needs no change to the store
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

| Execution                                                                                           | Refused       | Why                                                                 |
| --------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------- |
| The MISS body                                                                                       | yes           | its value is stored under a user-free key                           |
| A run a reader started before the binding                                                           | yes           | the MISS reuses it; its set carries the read                        |
| The stale refresh (`_runLoaderIsolated`)                                                            | yes           | same entry; the refresh fails, the stale entry keeps serving        |
| A loader value the body reads via `ctx.use`                                                         | yes           | the value lands in the entry; the read link carries it              |
| A keyed cached loader's HIT the body reads via `ctx.use`                                            | yes           | its entry's identity mark                                           |
| A read that settles after the value (nested promise, pending handle push within the encode timeout) | write only    | the value is already served; the write is refused, `onError`        |
| A live loader running beside the fill                                                               | no            | its set is not linked to the fill                                   |
| A loader under a route `cache()` with no `cache()` of its own                                       | no            | not stored; re-runs on every HIT                                    |
| A bake-lane loader during a PPR shell capture                                                       | capture guard | `guardIdentityRead` trips the capture and throws at the read, first |

Response directives (`invalidateClientCache()`, `keepClientCache()`) and cookie
writes record nothing: a `key()` cannot make a skipped body's side effect
reach a HIT.

The raw reads record too (#976): `ctx.request.headers` is an own getter on
the request every ctx exposes (`guardRequestHeaders`,
`src/server/cookie-store.ts`, over `shadowRequestHeaders`,
`src/server/request-headers.ts`), and `getRequestContext().cookie()` /
`.cookies()` call `guardRawCookieRead`; both go through `guardIdentityRead`
and record at the access. The router's own header reads go through
`requestHeaders()`, and the cookies() store through the unguarded
`_readCookie()` / `_readCookies()`, so neither records.

A cache's own callbacks record nothing and refuse nothing
(`runIdentityExempt`, `src/cache/cache-exec-scope.ts`): `key()`, a store
`keyGenerator` (`resolveCacheKey`, `src/cache/cache-policy.ts`),
`condition()` and a `tags()` function (`resolveTagsOption`) pick or label
the entry; their reads are never rendered. So does `onError`
(`invokeOnError`), which only observes. The exemption is async-local, so a
`"use cache"` body (`runWithCacheExecScope`), a loader body
(`runInsideLoaderBodyScope`) and a funnel (`runWithStore`) end it on entry:
a `key()` that awaited a cached function reading `cookies()` stored the
first visitor's cookie and served it to the next.

What stays out of reach, the same as for `"use cache"`: a value computed
outside any loader execution and handed in, such as a per-request memo a
handler filled from `cookies()` before the loader awaited it. The read ran in
no loader's set, so nothing links it to the fill.

#### `"use cache"` reading a loader something else started (#1011)

`"use cache"` throws at the read: a loader body entered inside the cached
function runs in its `runWithCacheExecScope` chain, so `guardIdentityRead`
refuses `cookies()` there. That only works when the cached function is the
loader's first reader. When a handler's `ctx.use`, the route's `loader()`
binding or a parent layout's binding started the loader first, the cached
function's `ctx.use` got the request memo (`useLoader`'s memo hit in
`src/router/loader-resolution.ts`, or a loader-cache binding's value through
`loader-cache.ts`'s `ctx.use` override). The body had already run outside the
scope, nothing was checked, and the entry (keyed by route, URL and args, not
the cookie) stored the first visitor's value and served it to the next. This
is the same ordering problem #972 solved for a loader `cache()` fill, and it
predates 0.19.

The #972 recorded-tag sets could not carry it: they are allocated only in a
request that binds a loader `cache()` (`armLoaderTagSets`), and that is not
where a `"use cache"` function usually reads a loader. So every loader
execution now carries a small `LoaderRunIdentity` (`src/server/context.ts`),
entered around the loader function with `runInsideLoaderRun`:
`recordLoaderIdentityRead` stores the first read there too, and a read inside
a run links the reader's record to the value's (`trackLoaderRun` and
`readStartedLoaderValue`, `src/cache/cache-tag.ts`). The cost is one object
per execution (the async-local store itself, so it cannot be allocated lazily)
and one link per loader-to-loader read.

There are two loader runners, and both enter it. `createLoaderExecutor`
(`src/router/loader-resolution.ts`) serves the handler and loader `ctx.use`.
`createUseFunction` (`src/server/request-context.ts`) serves
`getRequestContext().use(Loader)`, which server actions and code without a
handler ctx reach for; it has its own memo and runs no loader body scope. It
gets its own async-local scope rather than a `LoaderBodyScope` field for that
reason: a body scope would also hand it the `cache()` read exemption, which
it never had. Covering only the first runner leaves the hole open: a handler
that reads the loader with `getRequestContext().use()` before a cached
function does the same stores visitor a's value for visitor b.

Every memo path returns through `readStartedLoaderValue`: both runners' memo
hits and the loader-cache binding override. Outside a `"use cache"` scope (or
inside a cache's own `key()`/`tags()`) it returns the memo itself. Inside one,
it returns the memo chained with a check that runs
when the value settles: if the run, or any run it read, recorded an identity
read, or the value's recorded-tag set does (a loader-cache binding's MISS, or
its HIT through the identity mark), it throws `useCacheLoaderIdentityError`.
The message starts like the first-reader error (`cookies() cannot be called
inside a "use cache" function.`) and names the loader that read and the loader
the function consumed. Checking at settle instead of at the call covers a
pending memo whose body reads after an `await`. The checked promise carries a
no-op `catch`: a cached function that calls `ctx.use(Loader)` without
awaiting it would otherwise leave an unhandled rejection, which crashes a Node
process running with the default `--unhandled-rejections=throw`. The write
check below still refuses that entry.

Two consequences that fail closed. The read refuses even when the function
never uses the value: it cannot know, and the first-reader path throws there
too. And a refusal inside a nested `"use cache"` reaches every enclosing
execution (each one notes the value, `CacheExecScope.loaderReads`, keyed by
value so a repeated read is noted once), so an outer function that catches the
inner rejection still has its write refused.

A read the run makes after its value settled (a nested promise in the value,
the `/late` shape of #972) is not on the record yet when the check runs. Each
enclosing exec scope notes the value (`CacheExecScope.loaderReads`), and
`registerCachedFunction`'s `finalizeAndWrite` (and the stale refresh) calls
`assertLoaderReadsClean` after `serializeResult` and `encodeHandles`, which
awaited the nested promises. A recorded read then fails the write: the caller
already rendered its own value, followers of the in-flight envelope run
fresh, nothing is stored, and `onError` gets the error (`cache-write`). A read
recorded after the encode cannot be in the stored bytes. One cost of that
check: it cannot tell which value a late read feeds, so a loader that pushes a
handle whose promise reads `cookies()` after the value settled (a handle the
cached function does not store) also fails the write when the read lands
before the encode finishes. That fails closed, and the result is timing
dependent; read the loader outside and pass the value in instead.

| A `"use cache"` body reads a loader with `ctx.use`                      | Result                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| The function starts it; its body reads `cookies()`                      | throws at the read (`guardIdentityRead`, unchanged)       |
| A handler, the route's or a layout's `loader()` started it; it read     | the read rejects when the value settles                   |
| `getRequestContext().use()` started it, and the function reads it so    | the same                                                  |
| The function calls `ctx.use()` and never awaits it                      | no unhandled rejection; the write is refused              |
| It read a loader that read (`ctx.use` chain)                            | rejects, naming both loaders                              |
| A loader `cache()` binding's value with a `key()`; its MISS or HIT read | rejects (the value's recorded-tag set or identity mark)   |
| The read settles after the value (nested promise)                       | write only: served to its own caller, stored nowhere      |
| The run read no identity                                                | value returned and stored, as before                      |
| A handler reads the memo under a route `cache()` (no `"use cache"`)     | allowed, as before (loader bodies are exempt there)       |
| PPR capture                                                             | unchanged: the capture's own run throws at the read first |
| A ppr route's foreground render                                         | rejects like any route, so no capture is scheduled        |

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
  position in that handle/segment array, and the pushes of that run follow
  in push order: a dependency's push made inside the run counts toward the
  loader's position too (`SlotTag.under`), so a loader that pushes, awaits
  a dependency that pushes, and pushes again ends as
  `[own, dependency, own]`, the order its entry's HIT replays. A live push
  to another segment (the dependency's owning segment is its kickoff's
  `_currentSegmentId`) removes the replayed slots and lands where it is
  pushed.

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
  them. A live run that pushes nothing leaves the replayed values in place,
  unless the loader is a hole (a loader a restored record does not serve
  from a pin, see "An owned value follows its loader's value" above): a
  hole's run ending without a push drops them (`settleLoaderRun`). A
  record's placeholders always go when their loader's run ends without a
  push.

  **A HIT takes the place of a record's placeholders.** A record restored
  before the loaders resolve can hold placeholders for the loaders this
  entry is about to deliver: the cached loader itself and the dependencies
  its entry recorded. `restoreHandles` leaves them unclaimed for that reason.
  The replay (`appendHandles`, the one replay for a loader entry and a
  `"use cache"` entry) claims each of those loaders and hands the claimed
  ones to `HandleStore.replacePlaceholders`, which removes their
  placeholders and puts the entry's pushes at the first one's position in
  each array, in recorded order, none when the entry recorded none. So the
  page shows the pushes of the run that produced the entry's data, each
  once. A loader that already ran in this request is not claimed and
  replaces its placeholders itself. An entry stored without handles (a MISS
  a reader started first, #1002, or a handle encode that timed out) is taken
  as it is: the cached loader's placeholder goes and no push shows for it.
  An entry that always holds its pushes belongs to the #1002 change.

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
  `HandleStore.pushReplayed`, so the table above applies unchanged, and a
  claimed loader's record placeholders give way to the entry's copy through
  `replacePlaceholders`. A loader's own entry goes through the same function
  with the cached loader as `unitLoader`. The stale refresh reads loaders
  through `ctx._runLoaderIsolated` and never claims (`refreshView`,
  `src/cache/cache-runtime.ts`). No claim means exactly that: the caller's
  pushes are diverted off the page, so every group is delivered (into the
  diverting capture) and no placeholder is touched, or the page would lose
  the push. A group without an owner (`${seq}:`, or a segment-id key from an
  entry written before owner keys) is the unit's own: the cached loader's
  for a loader entry, a plain push for a function.

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

A `condition()` gates every `cache()` nested under it too (issue #974); see
"Conditions and tags inherit" below.

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
`keyGenerator(ctx, defaultKey)` result, else the default key). The parts are
joined by `composeCacheKeys` (every `key()` result namespaced since #975, see
"Key results are namespaced" below):

| The route's scope                                     | Record key                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| no `key()` on the chain                               | its default key (unchanged)                                        |
| a single keyed scope (`key()` of its own, none above) | `compose(its key() result)`: `key:` + its URI encoding             |
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

#### Key results are namespaced (issue #975)

You might think the composition above settled collisions. It settled them
among composed keys, and #970 left a hole it could see but not close: a
single keyed scope stored its `key()` result raw, byte-identical to before.
A record key carries no route or scope discriminator (`store.get(key)`), and
a `key()` result is often request input, so a raw result could name any
other record. The header value `doc:localhost/pricing` returned by a
`key()` on `/other` wrote `/other`'s content under `/pricing`'s default-keyed
record, and `gold|doc%3Alocalhost%2Fpricing` named gold's inner `/pricing`
record. On a response route (`response:` + the raw result) the header
`json:localhost/api/b` named `/api/b`'s default entry, and `/api/b` then
served `/api/a`'s body. The old defence was call-site advice ("prefix or
encode request input"), which is easy to miss.

So every `key()` result is namespaced now, by the one scheme in
`composeCacheKeys` (`src/cache/cache-key-utils.ts`, whose JSDoc carries the
invariant):

- a `key()` part is `key:` + `encodeURIComponent(result)`;
- a default part (a default key or a keyGenerator result inside a composed
  key) is `encodeURIComponent(value)`;
- one `key()` part is the key; two or more parts join with `|`, `key()`
  parts first; a lone default part stays raw, so a chain without `key()`
  keeps its default key or keyGenerator result byte for byte.

Why nothing collides: the router's default keys (`doc:`, `partial:`,
`intercept:`, `response:<type>:`) never start with `key:` and always hold a
`:`. A namespaced result starts with `key:` and holds no `|`. A composed key
holds a `|` and either starts with `key:` or, with no `key()` part, holds no
`:` at all. Among composed keys, splitting on `|` recovers each part, its
kind (a `key:` prefix, or no `:`) and its value. The probe in
`src/cache/__tests__/cache-scope-chain.test.ts` checks raw results against
default keys (`doc:...`), raw against composed (`gold|doc%3A...` and the new
`key:gold|doc%3A...`), and composed against composed.

Every key site uses it: route records and response routes
(`resolveKeyFrom`, the response family behind `response:`), the ppr shell
partition (`resolvePartition`, which `partitionShellKey` encodes once more),
and with it partial navigation replay, which reads the same partitioned shell
key and its `:navigation` sibling. The testing helper `shellCacheKey` calls
`composeCacheKeys` too, so a test builds the production key. The implicit doc
scope of a document HIT tail used to pin the shell entry's `docKey` through a
`key()`; namespacing would have missed the record, so it pins it directly
(`FIXED_KEYS` in `cache-scope.ts`).

The cost is one change of stored key strings. `CFCacheStore` keys every
family under a per-build version and shells are gated on `buildVersion`, so
a deploy is already cold; `MemorySegmentCacheStore` is cold after a restart.
Only `VercelCacheStore` without `version` sees a one-time miss for existing
keyed entries.

#### Loader key results are namespaced (issue #1009)

#975 left one key site raw: a loader's own `cache({ key })`. Its result was
the entry key verbatim (`resolveCacheKey`, `src/cache/cache-policy.ts`).
Loader entries live in the store's item family (`getItem`/`setItem`), which
they share with `"use cache"` entries (`use-cache:<id>:...`,
`src/cache/cache-runtime.ts`); route records use `get`/`set`. An item key
has no other discriminator, so a `key()` returning request input could name
another loader's entry: the header value
`loader:<otherId>:localhost/account` read and overwrote that loader's
default-keyed entry, and two loaders whose `key()` returned the same value
shared one entry. It could name a `"use cache"` entry the same way.

So a loader's `key()` result is now `loader:{id}:key:` plus
`encodeURIComponent(result)` (`loaderKeyFromResult` in `loader-cache.ts`),
the route scheme's `key:` part (`KEY_PART_PREFIX`) behind the loader's own
`loader:{id}:` prefix. Why nothing collides:

- It starts with `loader:`, which no `"use cache"` key does, so the
  `"use cache"` case is closed outright.
- An encoded result holds no `:`, so a namespaced key reads unambiguously
  from the right: the result, then `key:`, then the loader id. Two
  namespaced keys are equal only for the same loader and the same result.
- A default key `loader:{id}:{host}{pathname}...` holds a `/` past its id,
  and an encoded result holds none. So a namespaced key equals a default key
  only if one loader's id is literally `<other id>:<host>/<path>...`.

You might expect the argument to rest on loader ids holding no `:`. It
can't: a dev id is a root-relative path plus `#<export>`, and on Windows a
path can be absolute (`D:/...`). Build ids are hashes. A store `keyGenerator`
result stays raw, as #975 decided for routes: it is the store's own
namespace, gets the default key to build on, and is configured by the app
rather than chosen per request by a single binding. The `declared` flag
(#972) is unchanged: any `key()` or `keyGenerator` still declares identity.

Nothing else reads loader keys back. Tag invalidation finds entries through
the store's tag index, the ppr snapshot's loader pins are keyed by segment
(`bakeSegmentKey`), and the testing helpers (`runLoader`'s `cache` option)
run the same `resolveLoaderKey`. The cost is the same one-time miss as
#975, for keyed loader entries only. The e2e pin is the `loader-key` pair in
`cache-nested-scope.test.ts` of the router test-app and cloudflare-basic:
the header spells the victim loader's default key with its real (in build,
hashed) id, through `CFCacheStore` in the latter.

#### Conditions and tags inherit; stores partition across stores (issue #974)

`ttl`, `swr` and `store` are "the nearest `cache()` wins" settings, and that
is right for them: they describe how the inner record lives. Three options
answer a different question, whether and where a record may be shared, and
innermost-wins broke each of them:

- **`condition` (AND).** Only the innermost config's predicate ran
  (`conditionAllows`), so a request an outer `condition()` refused (a
  preview, a signed-in visitor) still read and wrote the nested record, and
  a `ppr` route under it served and captured a shell. `CacheScope.conditions`
  now carries every predicate on the chain, outermost first; a read or write
  needs all of them (the first false or throwing one decides). The write
  decision is still memoized once per scope and request. The response-route
  path uses the same `allowsCache("read")` instead of reading
  `config.condition`. `cache(false)` stays as is, and a `cache()` re-enabled
  under it is still gated by the conditions above it.
- **`tags` (union).** Records carried only their own scope's `tags`
  (`resolveCacheTags(config)`), so `updateTag(outerTag)` left nested records
  and the shells built from them. `CacheScope.tagOptions` carries the chain's
  `tags` options, static and function forms, and `resolveTags` unions them;
  the record write (`cacheRoute`), the synchronous request-tag record
  (`recordTags`), the capture's doc record (`recordShellCaptureDocRecord`)
  and the response entry all read it, so the shell takes the tags through the
  existing flow.
- **Cross-store `keyGenerator`.** `getStore()` is the innermost store, so an
  outer `cache({ store: A })` whose `A.keyGenerator` split records by locale
  did nothing for an inner `cache({ store: B })`: B's records, and a `ppr`
  shell under them, were shared across locales. `CacheScope.storeScopes` lists
  the enclosing enabled scopes without a `key()` whose `store` option differs;
  `resolvePartitionParts` adds each distinct store's keyGenerator result as a
  default part, following the #970 rule for a keyGenerator in the shell
  partition: a result equal to the default key partitions nothing. The parts
  keep their positions (`positionalParts`): when every result is the default
  key they are all dropped and the key is unchanged, and otherwise a default
  one is an empty part. A first cut dropped only the defaults, and a review
  probe showed why that is wrong: with a locale store that returns the default
  key for `en` and a region store that does for `us`, `{ en, de }` and
  `{ de, us }` both kept one part `…|de`, so the `de`-locale visitor was served
  the `en` shell. That makes an empty keyGenerator result ambiguous with a
  default one, so `generatedPart` rejects it: the request renders uncached (as
  for a throwing keyGenerator) and a once-per-keyGenerator warning names the
  store. The stores are deduplicated by `keyGenerator` function, not by store
  object: a shell capture wraps the app store (`RecordingShellStore` in
  `shell-capture.ts`) but not an explicit one, and the wrapper returns the
  inner store's `keyGenerator`, so a chain naming the app store explicitly
  added it twice in the capture and resolved a record key the request never
  wrote. On the same store nothing changes: the inner scope's own
  default key already carries the keyGenerator result, or its own `key()`
  overrides it. The app-level store counts as a store here: a
  `cache({ store })` under a plain `cache()` on an app store with a
  `keyGenerator` is split by its result.

What does not inherit, by decision: a loader's own `cache()` and
`"use cache"` are independent layers keyed only by what they declare (their
`key()` or arguments); see "Identity: keyed only by what the binding
declares" under Loader Caching Policy.

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

Tags can be attached three ways: statically via `cache({ tags: [...] })`, dynamically via `cache({ tags: (ctx) => [...] })`, or at runtime inside a `"use cache"` function via `cacheTag(...tags)`. The built-in `MemorySegmentCacheStore` and `CFCacheStore` index by tag and invalidate them. A `cache({ tags })` tags the records of every `cache()` nested under it too (issue #974, `CacheScope.resolveTags`).

To invalidate on demand, call one of (both variadic, server-only, exported from `@rangojs/router`):

- `updateTag(...tags): Promise<void>` - **read-your-own-writes, confirmed**. Resolves once every configured store's invalidation completes, durable write included, and rejects when one fails, so awaiting it inside a server action makes the action's own re-render fresh and tells the action the invalidation was stored.
- `revalidateTag(...tags): void` - **background (non-blocking)**. The durable write runs in the background (`waitUntil`); use it in route handlers / webhooks. NOT stale-while-revalidate: like `updateTag` it hard-purges, so the next read after the invalidation lands is a fresh miss. The request that calls it also reads its own writes (below). The only difference from `updateTag` is awaitability: a failed durable write goes to `onError` instead of rejecting.

Both fan out across the app-level store (`ctx._cacheStore`) and any explicit `cache({ store })` stores the handler resolved, calling the store-level `invalidateTags()` primitive (passing the whole tag batch in one call). The CF store records tag-invalidation markers in its own KV namespace and compares each entry's `taggedAt` against them on read - there is no separate tag-invalidation store. Note that the separate `revalidate()` export is a client-update axis (which segments re-render on a navigation or action), not a cache bust.

**Read-your-own-writes in the invalidating request (#973).** Both verbs call `invalidateTags()` synchronously, inside the request. Each built-in store masks the tags for the rest of that request before its first await, and only then starts the durable write (KV marker put, tag purge, `expireTag`), which `revalidateTag()` hands to `waitUntil` without waiting. Before #973, `revalidateTag()` deferred the whole call to `waitUntil`, and `CFCacheStore` with KV wrote its per-request marker memo only after the KV put: a server action that called `revalidateTag("x")` and then rendered read the pre-invalidation `"use cache"` and `cache()` entries tagged `x`, and memoized the absent marker for the rest of the request. The mask per store:

| Store                     | Request-local step (before the first await)                                                                                                                                                                                        | Durable step                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemorySegmentCacheStore` | the whole invalidation: markers set, tagged entries deleted                                                                                                                                                                        | none                                                                                                                                                            |
| `CFCacheStore`            | the request masks the tags (`maskTagsForRequest`, `request-tag-mask.ts`), with KV or `tagPurge`; data reads, purge-mode L1 hits and shell reads consult the mask before and after their marker reads                               | KV marker puts; for each confirmed put, the isolate marker memo and L1 write-through; then the purge and hooks for the whole batch, whether or not a put failed |
| `VercelCacheStore`        | the request masks the tags (`request-tag-mask.ts`); segment, item and response hits carrying a tag, written at or before the invalidation (envelope `ta`), miss; shell checks consult the mask before and after their marker reads | `tm` marker writes, the process marker memo, `expireTag`                                                                                                        |

The invariant: the mask only turns the invalidating request's hits into misses. If the durable write then fails, that request paid extra misses, never a stale read, and every other request reads the durable state. That is why a `CFCacheStore` marker read still in flight when the mask is set resolves to the invalidation for this request (the check consults the mask again once the reads resolve) but publishes nothing: a marker read for a tag this request masked skips the L1 marker populate and the isolate marker memo, which only the confirmed put writes (`fetchTagMarker`'s `masked`). A reviewer's probe caught an earlier version doing both, so a failed put made other requests miss for `tagCacheTtl` or `markerFreshMs`. The mask never enters the per-request marker memo, which holds only L1 and KV reads. A KV-less purge-mode L1 hit without entry Cache-Tags (written before the store stamped them) reads the per-request mask too; before, it went to the marker check, which KV-less never masks.

The mask belongs to the request, not to the context object that set it. A PPR HIT tail, a shell capture and a background revalidation render run on `Object.create(reqCtx)`, and a mask keyed by that object started empty: a GET whose middleware invalidated and then served a HIT read the tail's holes unmasked. `createRequestContext` now sets `RequestContext._requestRoot`, which derived contexts inherit. Both built-in stores key the mask by it (`request-tag-mask.ts`, shared), while each `CFCacheStore` context keeps its own memo for the marker values it reads (`cf-tag-marker-memo.ts`).

The mask lives in the stores, so three more paths needed the request itself; all are `"use cache"` executions (`cache-runtime.ts`). Both verbs record the invalidated tags in a module-level order before any store sees them (`markInvalidated` in `tag-invalidation.ts`, since #977 for every request of the isolate, not only the calling one), and each execution records where it started (`executionStart`). A counter, not `Date.now()`: Workers advance the clock only on I/O, so an execution started right after the call would share its millisecond, count as older, and never fill. An execution counts as predating the call only when one of its tags was invalidated after it started (`invalidatedSince`), so an execution with other tags still fills. Its tags are its profile's `tags`, the `cacheTag()` calls in its body, and the tags of the `"use cache"` calls it makes (#980, below). Such an execution is:

- not joined. A call made earlier in the request whose result is still being serialized for its store write sits in the isolate's in-flight executions (`inFlightExecutions`); the same call after the invalidation used to join it and got `["beer #1", "beer #1"]`. A caller that declines it joins a newer execution registered meanwhile rather than starting one more, so five concurrent calls after the invalidation run the body once, not five times.
- not written. With `await updateTag()`, the first call's write landed after the invalidation and the second call read it back.
- not written by a stale refresh either. A stale hit's background refresh that started before the call read the data from before it; its write used to land after the call and serve `"old"` to the rest of the request and to later requests.

**Nested `"use cache"` ([#980](https://github.com/rangojs/rango/issues/980)).** A `"use cache"` function that calls another bakes the inner value into its own entry, so the entry answers to the inner tags. You might expect the ALS to handle that already, since `cacheTag()` inside the inner body goes to the innermost `runWithCacheTagScope`. It does, and that is the problem: the inner scope closes with the inner body, and the inner wrapper then records its merged tags onto the request (`recordRequestTags`: a miss's tags, a hit's stored tags, a joined execution's envelope tags), which fed `_requestTags`, the #957 segment owner and the #964 loader set, but not the enclosing `"use cache"` scope. `updateTag("stock")` dropped the inner entry and left the outer one serving the old stock until it expired, and the gate above did not see the outer execution as tagged `stock`. `recordOwnedTags` (`cache-tag.ts`) now also adds the tags to the `"use cache"` scope current when they are recorded, which for the inner wrapper is the caller's. The outer entry, its eviction and the gate follow with no further change, as a route `cache()` record (#965) and a loader's own `cache()` entry (#968) already did for the `"use cache"` reads inside them. A `"use cache"` component makes some of its nested calls later still: Flight renders the server components in its value when it encodes the value for the write, after the body returned and its scope closed, so those tags went to whatever scope the caller had. The encode now runs back inside the execution's tag scope (`inTagScope` in `cache-runtime.ts`), and the entry's tags are read after it. One level further, an intermediate call can return a value that holds a nested call still running (`{ stock: getStock(sku) }`, or a promise prop): that call records its tags after the intermediate one already reported its own to its caller. So each scope remembers the scope it opened under (`scopeParents`), and a tag recorded in a scope goes to every scope above it; the outermost encode awaits the same promise, so the tags are in before it reads its own. The other direction is closed too: a stale inner entry's background refresh is scheduled outside the caller's scope (`outsideCacheTagScope`), since the outer entry bakes the stale value, not the refreshed one. An entry written before this carries only its own tags until it expires or is rewritten.

**The write gate: work that started before another request's invalidation ([#977](https://github.com/rangojs/rango/issues/977)).** The request order above only covered the invalidating request. An execution in another request that started before the invalidation still wrote when it finished, and every built-in store accepted that write as newer than the invalidation: `CFCacheStore` stamps `taggedAt` at write time, `VercelCacheStore` stamps `ta` at write time, and `MemorySegmentCacheStore` checks no marker on write (it deletes eagerly on invalidation, so a late write simply repopulates). So the invalidating request, or any later one, read the old value until it expired. Every writer now asks one question before its store write, `predatesInvalidation(store, tags, start)` in `tag-invalidation.ts`: was one of the entry's tags invalidated after the execution started? Either answer skips the write:

- **This isolate's order** (`invalidatedSince`): `markInvalidated` keeps tag → the `seq` of its latest invalidation for every request, bounded at 1024 tags, on a `globalThis` slot so a second evaluated copy of the module reads it too. Dropping the oldest raises a floor, and an execution that started before a forgotten invalidation counts as invalidated whatever its tags: a miss, never a stale read. It lives in `invalidation-order.ts`, which imports nothing, so `createRequestContext` can take each request's start there (`RequestContext._requestStart`). It is keyed by tag name alone: two routers in one isolate that share a tag name skip each other's writes started before an invalidation, which costs them a miss.
- **The store's markers** (`isTagsInvalidatedSince`), for another isolate's invalidation, as far as the store can tell: KV markers on `CFCacheStore`, `tm` markers on `VercelCacheStore`, the process markers on `MemorySegmentCacheStore`. It is asked about the milliseconds after the start's (`start.at + 1`): this isolate's own invalidation that preceded the start usually shares its millisecond on Workers, and `>=` would skip every write started right after it (the #973 same-millisecond case). Another isolate's invalidation within the start's own millisecond is not caught. `CFCacheStore` never answers here from a marker the request read earlier: a stale hit reads its entry's markers before its refresh runs, and answered from the memo, an invalidation that landed during the refresh let it write. A tag the request masked answers from the mask, checked again when the reads are back. Each other tag is read through `gateMarkerRead` (`request-tag-mask.ts`, shared with `VercelCacheStore`'s `tm` reads): a page's writes finish together and share tags, and a read per tag per write cost a cold page with a 40-tag document, a 40-tag record and ten 3-tag `"use cache"` misses 110 KV reads. Gates that ask while a read is in flight share it, if it was issued at or after their execution started; the read is dropped when it settles. A read answers only for invalidations before it was issued, and the first version reused settled reads: a capture's `putShell` could be answered by a `"use cache"` write's read from the start of the capture, missing another instance's `expireTag()` in between, and a timed-out read's fail-open `null` answered every later gate of the request. Sharing only in-flight reads keeps the window to one marker round-trip. The read returns its own KV or L1 value, not one an older read of the tag memoized while it was in flight, and it fills the per-request memo only when the memo holds nothing, so a build shell's check still serves the request's later reads. It publishes to L1 unless the request masked the tag, and never without a request context (a detached `waitUntil` task), where a mask cannot be told apart. The gate asks fail-closed (`isTagsInvalidatedSince(tags, since, { failClosed: true })`): a marker read that fails or times out answers "invalidated", since a skipped write costs a miss. Other callers, a build shell's read-through among them, keep the store's fail-open answer.

One more race, found in review: the isolate order is read before the store's marker read, and that read can be in flight while this isolate invalidates. An action awaits a `"use cache"` miss (its write runs in `waitUntil`), updates its data, then awaits `updateTag()`; the write's gate had passed the order check and its KV read answered with the marker from before, so the write landed after the invalidation and served `"old"` to the action's own render and the next request (#973's read-your-own-writes, broken). `predatesInvalidation` reads the order again once the store answers; `markInvalidated` is synchronous, so the second look sees every invalidation made before the answer. The shell-store wrapper a capture runs on (`RecordingShellStore`) forwards the method, or the writes it passes through would skip this half. A HIT tail reads and writes through the request's own store, and the implicit doc scope's `SeededShellStore` keeps its segment writes local.

The writers and where each takes its start:

| Writer                                    | Start                                                                                  | Gate                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `"use cache"` miss / stale refresh        | before the body runs (`cache-runtime.ts`)                                              | after the encode, before followers get the value and before `setItem` |
| a loader's own `cache()` miss / refresh   | the earliest of `execute` and the loader runs its value read (`earliestRecordedStart`) | the `setItem` wrapper, with the flattened tags                        |
| route `cache()` record (MISS)             | `withCacheStore`, before the lookup and the handlers                                   | `CacheScope.cacheRoute`, with the record's tags                       |
| route `cache()` record (stale, proactive) | `rerenderAndCacheRoute`                                                                | `CacheScope.cacheRoute`                                               |
| route `cache()` response-route entry      | before the handler (`response-cache-serve.ts`)                                         | before `putResponse`                                                  |
| document cache (MISS, stale)              | the request's, `RequestContext._requestStart` (`document-cache.ts`)                    | before `putResponse`, with the request's tags                         |

Why the loader-cache start is not simply `execute`: the value the binding stores can be a run of the loader that a reader started earlier (a parent layout's handler reading a child route's bound loader runs before the child's bindings, and the binding's `ctx.use` returns that memoized run), and the values its body reads can be runs started earlier still. Every loader execution in a request that binds a loader `cache()` records its start on its recorded-tag set (`markTagSetStart` in `createLoaderExecutor`), a binding's value records its kickoff, and the write takes the earliest start across the links `flattenRecordedTags` follows. Gated on `execute` alone, an invalidation between the layout's run and the binding's lookup would go through.

A PPR shell already had its gate (`putShell` against the capture start), and a shell capture's doc record is written into the shell entry only, so `cacheRoute` gets no start there (`withCacheStore` passes none for the implicit doc scope; skipped, the capture would report a render with no record and back off). The join check in `cache-runtime.ts` reads the same isolate order, and a leader asks the store before it hands its value to the calls waiting on it (`CacheEnvelope.predates`): a follower that served it would bake a value from before another isolate's invalidation into its own entries, whose own gates start after the invalidation and pass. So a `"use cache"` call no longer joins an in-flight execution that started before another request's, or another isolate's, invalidation of its tags.

The document cache takes the request's start, not its own: a middleware ahead of it can read tagged data the document bakes, and a stale refresh re-runs the handler over what those middleware set. A route `cache()` record takes the match pipeline's start, so data a global middleware read before the match and a handler bakes into the record is not covered.

The cost: an untagged write checks nothing, and a tagged one reads its markers before the put (KV or the L1 marker cache on `CFCacheStore`, the `tm` entries on `VercelCacheStore`), once per tag for the gates of a request that ask while the read is in flight. The read runs in the write's `waitUntil` task, but two callers do wait on it: a `"use cache"` call that joined an in-flight execution waits for the leader's gate before it gets the value, and where the request context has no `waitUntil` (`runBackground` then runs the task inline) the leader itself awaits its write, gate included.

The invariant: a skipped write only costs a later miss, never a stale read, and the execution still returns the value it computed. What stays open: a KV-less `CFCacheStore` has no marker to read, so another isolate's late write lands and ttl+swr bounds it (purge mode purges before it); KV itself is eventually consistent across colos, so a marker written in another colo that this colo's KV read does not see yet lets the write through; with `tagCacheTtl` the read can come from this colo's L1 marker cache, up to `tagCacheTtl` behind another colo's invalidation; and a check-then-write window remains on `CFCacheStore`/`VercelCacheStore` between the marker read and the put, which a shared read in flight widens by at most one marker round-trip (the shell family closes it by stamping the capture start as `taggedAt`; the data families stamp write time). One consequence to know: an entry whose tag is invalidated more often than its execution takes never fills, since every write started before the latest invalidation. Nested tags (#980) make that likelier, because an outer entry now answers to every tag of the calls inside it.

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
