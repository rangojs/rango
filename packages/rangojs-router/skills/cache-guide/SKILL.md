---
name: cache-guide
description: When to use cache() DSL vs "use cache" directive — key differences and decision guide
argument-hint:
---

# cache() vs "use cache" — When to Use Which

Both mechanisms share the same backing store, cache profiles, and tag-based
invalidation. They differ in scope, cache key, execution model, and runtime control.

## Two axes — do not conflate

Everything on this page is **axis 1: stored-value freshness** — _is a cached
value still good?_ There is a second, orthogonal axis it is easy to mistake for
caching:

1. **Stored-value freshness** — _is a cached value still good?_
   → `"use cache"` (fn/component), `cache()` (segment), loader `cache()` (loader data).
   Entries are coupled across the one store by **tags** (`revalidateTag`).
2. **Client-update selection** — _should this segment re-run and stream to the
   client on this navigation/action?_
   → `revalidate()`. Covered in `/loader` and `/route`, **not here**.

They are orthogonal and compose: a segment selected by `revalidate()` still
consults its cache (hit → no recompute); a cache bust does **not** force a client
update, and `revalidate()` never reads, writes, or expires a cached value. If you
know React Router, `revalidate()` is `shouldRevalidate`, not `Cache-Control`. See
`/rango` → "Coming from another framework" for the cross-framework mapping.

## Key Differences

|                      | `cache()` DSL                                         | `"use cache"` directive                            |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| **Scope**            | Route segment tree (handler + children + parallels)   | Single function return value                       |
| **Defined at**       | Route definition site (`urls.ts`)                     | Inside function body or at file top                |
| **Cache key**        | Request type + pathname + params (+ optional custom)  | Function identity + serialized non-tainted args    |
| **Execution on hit** | All-or-nothing: entire handler skipped                | Partial: function body skipped, calling code runs  |
| **Runtime control**  | `condition` to disable, custom `key` function         | None — if the directive is present, it caches      |
| **Side effects**     | No guards needed — handler doesn't run on hit         | `ctx.header()`, `ctx.set()`, etc. throw at runtime |
| **Handle data**      | Captured and replayed                                 | Captured and replayed                              |
| **Loaders**          | Always fresh — excluded from cache, opt-in per loader | Can be used inside loaders                         |
| **Nesting**          | Nest `cache()` boundaries with different TTLs         | Compose by calling cached functions from uncached  |

### cache() Cache Key

The key is `{requestType}:{pathname}:{params}` where requestType is one of
`doc:`, `partial:`, or `intercept:`. This means the same URL cached separately
for full document loads, client navigations, and intercept navigations.

Custom `key` functions can segment the cache further (e.g., by user role or locale).
`condition` can disable caching entirely at runtime (e.g., skip for authenticated users).

### "use cache" Cache Key

The key is `use-cache:{functionId}:{serializedArgs}` where functionId is a stable
ID from the Vite transform (module path + export name) and args are serialized via
RSC `encodeReply()`. Tainted arguments (ctx, env, req) are excluded.

## Execution Model

This is the most important distinction.

### cache() — all-or-nothing

On cache hit, the cache-lookup middleware short-circuits the entire pipeline.
No handler code runs. On miss, all handlers execute normally and segments are
stored.

```
HIT  → cached segments served, loaders resolved fresh, no handler runs
MISS → all handlers run, segments cached, response built normally
```

Headers, cookies, and ctx.set() calls inside handlers naturally don't execute on
hit. There is no partial execution, so no runtime guards are needed.

### "use cache" — partial execution

Only the wrapped function body is skipped on hit. The code that calls the
cached function still runs. This means ctx side effects inside the cached body
would silently disappear on hit.

```
HIT  → function body skipped, calling code runs, handle data replayed
MISS → function body runs, return value + handle data cached
```

Runtime guards throw if you call cookies(), headers(), ctx.header(), ctx.set(),
ctx.onResponse(), ctx.setTheme(), or ctx.setLocationState() inside a "use cache"
function. cookies() and headers() are blocked because per-request data is not in the
cache key. Side-effect methods are blocked because their effects are lost on hit.
Use ctx.use(Handle) instead for data — handle data is captured and replayed.

## When to Use cache()

Use the route-level `cache()` DSL when:

- **Caching entire routes or sections** — wrap a set of paths with one TTL.
- **You need runtime control** — disable caching for authenticated users with
  `condition`, or segment cache keys by user/locale with `key`.
- **UI rendering is expensive** — the cached segments include the rendered
  component tree, skipping RSC rendering on hit.
- **You want one cache entry per URL** — keyed on pathname + params, not on
  function arguments.

```typescript
export const urlpatterns = urls(({ path, cache }) => [
  cache({ ttl: 300, condition: (ctx) => !ctx.get("user") }, () => [
    path("/blog", BlogIndex, { name: "blog" }),
    path("/blog/:slug", BlogPost, { name: "blogPost" }),
  ]),
]);
```

## When to Use "use cache"

Use the `"use cache"` directive when:

- **Caching a specific data fetch** — one database query used across multiple
  routes or components.
- **Different call sites need different cache entries** — the cache key includes
  all non-tainted arguments, so `getProduct("a")` and `getProduct("b")` cache
  separately.
- **Fine-grained caching within a handler** — cache the expensive part, keep
  ctx side effects outside.
- **Caching an RSC component** — a component that fetches its own data can cache
  its entire render.

```typescript
async function getProductData(slug: string) {
  "use cache: short";
  return await db.query("SELECT * FROM products WHERE slug = ?", [slug]);
}

// Handler calls cached function, sets headers outside
async function ProductPage(ctx) {
  const data = await getProductData(ctx.params.slug);
  ctx.header("X-Product", data.id);
  return <Product data={data} />;
}
```

## Combining Both

They compose naturally. Use `cache()` for the route boundary and `"use cache"`
for shared data functions:

```typescript
// urls.tsx — route-level cache for the rendered segment tree
cache({ ttl: 60 }, () => [
  path("/product/:slug", ProductPage, { name: "product" }),
]);

// data.ts — function-level cache for the database query
export async function getProductData(slug: string) {
  "use cache: long";
  return await db.query("SELECT * FROM products WHERE slug = ?", [slug]);
}
```

On cache hit for the route, the handler doesn't run and `getProductData` is never
called. On cache miss, the handler runs and `getProductData` may itself return a
cached value from a previous call with the same slug.

## Headers and Cookies

Neither mechanism caches response headers or cookies.

- **cache()**: Headers set by handlers are naturally absent on hit because no
  handler runs. If you need headers on every response, set them in middleware
  (which runs before cache lookup).
- **"use cache"**: cookies() and headers() throw inside the cached function
  (both reads and writes). ctx.header() also throws. Move them outside.

```typescript
// Set headers that must appear on every response in middleware
middleware(async (ctx, next) => {
  ctx.header("X-Frame-Options", "DENY");
  await next();
});
```

## Context Variable Cache Safety

Context variables created with `createVar()` are cacheable by default and can
be read freely inside `cache()` and `"use cache"` scopes. Non-cacheable vars
throw at read time to prevent request-specific data from being captured.

There are two ways to mark a value as non-cacheable:

```typescript
// Var-level policy — inherently request-specific data
const Session = createVar<SessionData>({ cache: false });

// Write-level escalation — this specific write is non-cacheable
ctx.set(Theme, derivedTheme, { cache: false });
```

"Least cacheable wins": if either the var definition or the `ctx.set()` call
specifies `cache: false`, the value is non-cacheable.

**Behavior inside cache scopes:**

| Operation                           | Inside `cache()` / `"use cache"` |
| ----------------------------------- | -------------------------------- |
| `ctx.get(cacheableVar)`             | Allowed                          |
| `ctx.get(nonCacheableVar)`          | Throws                           |
| `ctx.set(var, value)` (cacheable)   | Allowed                          |
| `ctx.header()`, `ctx.cookie()`, etc | Throws (response side effects)   |

Write is dumb — `ctx.set()` stores the cache metadata but does not enforce.
Enforcement happens at read time (`ctx.get()`), where ALS detects the cache
scope and rejects non-cacheable reads.

## Loaders Are Always Fresh

Loaders are **never cached** by route-level `cache()`. Even on a full cache hit
where all UI segments are served from cache, loaders are re-resolved fresh on
every request. This is enforced at two levels:

1. **Storage**: `cacheRoute()` filters out loader segments before serialization
   (`segments.filter(s => s.type !== "loader")`).
2. **Retrieval**: On cache hit, `resolveLoadersOnly()` runs after yielding cached
   UI segments, ensuring fresh data regardless of cache state.

This means `cache()` gives you cached UI + fresh data by default. To also cache
a loader's data, explicitly opt in with `loader(Fn, () => [cache({...})])`.

## cache() Placement Patterns

### Wrapping children of a path

An orphan `cache()` inside a path's children becomes the parent for all
subsequent siblings. Everything below the cache boundary is cached as one unit:

```typescript
path("/dashboard", DashboardPage, { name: "dashboard" }, () => [
  cache("long"),
  layout(DashboardSidebar, () => [
    parallel("@stats", StatsPanel),
    parallel("@activity", ActivityFeed),
  ]),
]),
```

On hit: DashboardPage, DashboardSidebar, StatsPanel, and ActivityFeed are all
served from cache. On miss: all handlers run, all segments cached together.

### Uncached layout with cached children

The cache boundary only covers what's inside it. Parent segments above the
boundary are not cached and always re-render:

```typescript
layout(RootLayout, () => [
  // RootLayout is NOT cached — runs every request
  path("/products/:slug", ProductPage, { name: "product" }, () => [
    cache("long"),
    layout(ProductSidebar),
    parallel("@reviews", ReviewsPanel),
    parallel("@related", RelatedProducts),
  ]),
]),
```

RootLayout renders fresh every request. ProductPage, ProductSidebar,
ReviewsPanel, and RelatedProducts are all inside the cache boundary and
served from cache on hit. This is useful when the root layout depends on
request-specific data (user session, theme) but the product content is
cacheable.

### Loader-level caching

Loaders are excluded from route-level `cache()` by default — they always
resolve fresh. To opt a specific loader into caching, give it its own
`cache()` child:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  // This loader is cached for 5 minutes
  loader(ProductLoader, () => [cache({ ttl: 300 })]),

  // This loader is always fresh
  loader(CartLoader),
]),
```

This attaches the cache config directly to the loader entry. The loader's
data is cached independently from the route's segment cache. Loader caching
supports custom keys, tags, SWR, conditional bypass, and per-loader store
overrides — see `/loader` for the full reference.

## Decision Flowchart

1. Do you want to cache an entire route or group of routes?
   **Yes** -> `cache()`
2. Do you need runtime conditions (skip for auth users, key by locale)?
   **Yes** -> `cache()` with `condition` / `key`
3. Do you want to cache a data fetch shared across routes?
   **Yes** -> `"use cache"`
4. Do you need different cache entries for different arguments?
   **Yes** -> `"use cache"` (keyed by args)
5. Is the expensive part rendering, not data fetching?
   **Yes** -> `cache()` (caches rendered segments)
6. Is the expensive part a single query inside a larger handler?
   **Yes** -> `"use cache"` on the query function

## See Also

- `/caching` — cache() DSL setup, stores, nested boundaries
- `/use-cache` — "use cache" directive details, profiles, transforms, guards
- `/document-cache` — Edge caching with Cache-Control headers (different layer)
