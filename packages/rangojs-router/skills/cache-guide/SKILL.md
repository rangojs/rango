---
name: cache-guide
description: When to use cache() DSL vs "use cache" directive — key differences and decision guide. Use when unsure which caching mechanism fits a given problem, comparing route/segment caching, function-level caching, and document-level caching, or asking "which cache API should I use".
argument-hint:
---

# cache() vs "use cache" — When to Use Which

Both mechanisms share the same backing store and cache profiles, and both accept
an optional `tags` field (honored by the built-in stores — invalidate with
`updateTag`/`revalidateTag`; see "Two axes" below). They differ in scope, cache
key, execution model, and runtime control.

## Two axes — do not conflate

Everything on this page is **axis 1: stored-value freshness** — _is a cached
value still good?_ There is a second, orthogonal axis it is easy to mistake for
caching:

1. **Stored-value freshness** — _is a cached value still good?_
   → `"use cache"` (fn/component), `cache()` (segment), loader `cache()` (loader data).
   Entries expire by **TTL/SWR** and can be tagged (`cache({ tags })` or runtime
   `cacheTag(...tags)` — inside `"use cache"` it tags that entry; called during a
   request render outside `"use cache"` it tags the document/shell artifact).
   Built-in stores (`MemorySegmentCacheStore`, `CFCacheStore`)
   index by tag; invalidate on demand with `updateTag(...tags)` (awaitable,
   read-your-own-writes) or `revalidateTag(...tags)` (background, non-blocking).
   Both hard-purge; the difference is awaitability, not stale-serving.
2. **Client-update selection** — _should this segment re-run and stream to the
   client on this navigation/action?_
   → `revalidate()`. Covered in `/loader` and `/route`, **not here**.

They are orthogonal and compose: a segment selected by `revalidate()` still
consults its cache (hit → no recompute); a cache bust does **not** force a client
update, and `revalidate()` never reads, writes, or expires a cached value. If you
know React Router, `revalidate()` is `shouldRevalidate`, not `Cache-Control`. See
`/rango` → "Coming from another framework" for the cross-framework mapping.

## Fast choice

Read this first; use the rest of the page when the choice has edge cases.

1. Do you want to cache an entire route or group of routes?
   **Yes** -> `cache()`
2. Do you need runtime conditions, such as skip for authed users or key by
   locale?
   **Yes** -> `cache()` with `condition` / `key`
3. Do you want to cache a data fetch or helper shared across routes?
   **Yes** -> `"use cache"`
4. Do you need different cache entries for different function arguments?
   **Yes** -> `"use cache"` (keyed by args)
5. Is the expensive part rendering a subtree?
   **Yes** -> `cache()` (caches rendered segments)
6. Is the expensive part one query inside a larger live handler?
   **Yes** -> `"use cache"` on the query function

## Correctness & invalidation

rango's caches are built so a hit can't serve wrong or stale-shaped data. These
guarantees are mostly automatic — worth knowing so you don't reimplement
protection the framework already gives you (or assume one it deliberately
doesn't).

There are two guard models to keep separate. Both block response side effects
(`ctx.header()`, cookie writes) that would be lost on a hit; they differ in what
else they allow:

- **`cache()` boundary guard** (route-level) — fires while the handler runs on a
  miss. `cookies()` and `headers()` throw (request-scoped data would be baked into
  the shared cached shell), `ctx.get(nonCacheableVar)` throws (a tainted value
  would be baked in), and response side effects (`ctx.header()`, `ctx.setCookie()`,
  `ctx.setStatus()`, `ctx.onResponse()`) throw. `ctx.set()` of a cacheable var is
  **allowed** — children are cached too and can read it. **Loaders are exempt**
  (they always run fresh) — read request data inside a loader.
- **`"use cache"` exec-guard** (function-level) — the same request-scoped APIs
  throw inside the cached function (`cookies()`, `headers()`, `ctx.set()`,
  `ctx.header()`); additionally, tainted `ctx`/`env`/`req` args are excluded from
  the cache key.

### Cross-deploy safety: version-segmented store keys

`CFCacheStore` prefixes every **physical** store key (the CF Cache API URL and
the KV key) with the build version — auto-generated from the
`@rangojs/router:version` virtual module, overridable via the store's `version`
option. A new deploy reads under a new prefix, so it can **never** read a
previous build's entries: no cross-deploy shape drift, and no dead client-chunk
references baked into cached RSC.

The tradeoff to know: **loader/data caches use the same store**, so they're
version-segmented too. Every deploy is therefore a _cold data cache_ — SWR can't
soften it, because no stale entry exists under the new key. For high-traffic,
frequently-deploying, data-bound apps that's a deploy-time origin warm-up. Decide
deliberately: accept it (correctness over hit-rate), or split the policy — let
the render/edge cache auto-version while a separate data store gets a stable
`version` so its entries survive deploys. (Per-process stores like
`MemorySegmentCacheStore` are cold on every restart anyway; this matters for
persistent stores.) See `/caching` for store setup.

### Client cache: forward/back is mutation-aware

The browser keeps a history (forward/back) cache of rendered segments. Any
client-side mutation (a server action) marks those entries **stale** and
broadcasts it to other tabs. On back/forward (popstate) the router looks up the
entry, sees it's stale, and revalidates — so your `revalidate()` predicates re-run
and the segment refreshes (SWR: the stale view paints instantly, fresh data
streams in). It's the client-side analog of the server-cache correctness problem,
solved on the partial-render axis.

### Request-scoped data: the `cache: false` taint

`createVar({ cache: false })` (or a `ctx.set(var, v, { cache: false })` write)
taints a value as request-scoped; reading it **directly** with `ctx.get()` inside
a `cache()` boundary throws — the guard against the catastrophic "serve user A's
data to user B" bug. The guarantee is precise and intentionally narrow — see
"Context Variable Cache Safety" below for exactly what it does and does not catch.

## Stale-while-revalidate

SWR is a first-class cache behavior when the backing store supports it: while an
entry is within its SWR window the cache serves the **stale value instantly** and
refreshes it in the **background** (`waitUntil`), so users never wait on a
recompute for a merely-aging entry.

- **`"use cache"`** resolves to the `default` profile `{ ttl: 900, swr: 1800 }`,
  so function/component caching gets a 30-minute SWR window **out of the box**.
  Tune or add profiles via `createRouter({ cacheProfiles: { … } })`
  (`"use cache: short"` → the `short` profile).
- **`cache()` DSL and loader caches** take an explicit `swr` in seconds (or
  inherit `store.defaults.swr`): `cache({ ttl: 60, swr: 300 })` → fresh ≤60s,
  stale-served 60–360s, miss after 360s in stores that implement SWR for that
  layer.
- **Client forward/back** is SWR after a mutation — see "Correctness &
  invalidation" → Client cache.
- **Store-backed document layer** uses the HTTP `stale-while-revalidate`
  directive as policy for `createDocumentCacheMiddleware`; see
  `/document-cache`. A platform CDN may independently consume the same header
  and bypass the function on hits; see `/deployment-caching`.

SWR softens normal TTL expiry, **not** a cross-deploy cold cache — a new build
has no stale entry to serve (see version-segmented store keys above).

Store support is layer-specific. `CFCacheStore` supports SWR for segment,
document/response, and `"use cache"` item entries. `MemorySegmentCacheStore`
supports SWR for response and `"use cache"` item entries, but its route-segment
entries expire at TTL and never background-revalidate. Use the memory store for
local/dev behavior, not as proof that segment SWR is active.

## Key Differences

|                      | `cache()` DSL                                         | `"use cache"` directive                            |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| **Scope**            | Route segment tree (handler + children + parallels)   | Single function return value                       |
| **Defined at**       | Route definition site (`urls.ts`)                     | Inside function body or at file top                |
| **Cache key**        | Request type + pathname + params (+ optional custom)  | Function identity + serialized non-tainted args    |
| **Execution on hit** | All-or-nothing: entire handler skipped                | Partial: function body skipped, calling code runs  |
| **Runtime control**  | `condition` to disable, custom `key` function         | None — if the directive is present, it caches      |
| **Side effects**     | Response side effects throw inside the boundary       | `ctx.header()`, `ctx.set()`, etc. throw at runtime |
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

### Nesting rule: the outer window bounds the inner

A cache's window bounds everything rendered inside it (loaders excepted). An
inner shorter TTL only takes effect when the **enclosing** cache recomputes — it
does **not** keep a value fresher than its parent:

- Outer `cache()` **fresh hit** → the subtree is served from stored RSC, so inner
  `"use cache"` functions are **not consulted** (frozen at the outer's age — no
  code inside the boundary runs on a hit).
- Outer **miss / SWR revalidation** → inner caches are consulted, each per its own
  ttl/swr. With SWR on the outer, a stale subtree serves instantly and refreshes
  in the background, so under traffic it keeps refreshing rather than rotting to
  the worst case.
- **Loaders are the exception** — excluded from the segment cache, re-resolved
  live even on an outer hit.

So `"use cache: short"` (60s) inside `cache({ ttl: 600 })` yields ~600s freshness
on hits, **not** 60s. This is not a bug: setting `cache({ ttl: 600 })` declares
"this subtree may be ~600s stale." **If a value must be fresher than its
enclosing segment, put it in a loader** (always live). `debugPerformance` prints
cache hits per layer, so the actual per-request behavior is observable.

## Headers and Cookies

Neither mechanism caches response headers or cookies.

- **cache()**: Response-level side effects throw inside the cache boundary even
  on a miss: `ctx.header()`, `ctx.setCookie()`, `ctx.deleteCookie()`,
  `ctx.setStatus()`, `ctx.onResponse()`, and direct `ctx.headers` mutation. On a
  hit the handler would be skipped, so allowing the write on a miss would produce
  inconsistent responses. If you need headers or cookies on every response, set
  them in middleware or a live segment outside the cache boundary.
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
be read freely inside cached scopes. A non-cacheable var throws when read
**directly** with `ctx.get()` inside a `cache()` boundary — where the value would
otherwise be serialized into the stored segment.

There are two ways to mark a value as non-cacheable:

```typescript
// Var-level policy — inherently request-specific data
const Session = createVar<SessionData>({ cache: false });

// Write-level escalation — this specific write is non-cacheable
ctx.set(Theme, derivedTheme, { cache: false });
```

"Least cacheable wins": if either the var definition or the `ctx.set()` call
specifies `cache: false`, the value is non-cacheable.

**Behavior inside a `cache()` boundary:**

| Operation                                 | Inside a `cache()` boundary                            |
| ----------------------------------------- | ------------------------------------------------------ |
| `cookies()` / `headers()` (read or write) | Throws (request-scoped, would poison the shared entry) |
| `ctx.get(cacheableVar)`                   | Allowed                                                |
| `ctx.get(nonCacheableVar)`                | Throws (would be baked in)                             |
| `ctx.set(var, value)` (cacheable)         | Allowed                                                |
| `ctx.header()` / cookie writes            | Throws (response side effect would be lost on hit)     |
| Any of the above **inside a loader**      | Allowed (loaders always run fresh)                     |

(Both scopes block the same request-scoped APIs — `cookies()`, `headers()`,
response side effects, and non-cacheable `ctx.get()` — because each would leak
per-request data into a shared cache entry. The `cache()` boundary tracks the
scope via `isInsideCacheScope()`; `"use cache"` uses the exec guard and also
excludes tainted `ctx`/`env`/`req` args from the cache key. Loaders are exempt in
both — see "Headers and Cookies" and the precise guarantee below.)

Write is dumb — `ctx.set()` stores the cache metadata but does not enforce.
Enforcement happens at read time (`ctx.get()`), where ALS detects the cache
scope and rejects non-cacheable reads.

### The guarantee is precise — a direct read inside `cache()`, not propagating

The guard fires on a **direct** `ctx.get(taintedVar)` **inside a `cache()`
boundary** (the scope `isInsideCacheScope` detects). The taint lives on the
variable; a value **derived** from it and read **outside** the boundary is not
tracked:

```typescript
// CAUGHT — direct read of a tainted var inside a cache() boundary
cache({ ttl: 60 }, () => [
  path("/dashboard", (ctx) => {
    const user = ctx.get(User); // throws: non-cacheable read inside cache()
    return <Dashboard user={user} />;
  }, { name: "dashboard" }),
]);

// NOT CAUGHT — read outside the boundary, derived value cached
layout((ctx) => {
  const name = ctx.get(User).name; // allowed — this layout is not cached
  ctx.set(UserName, name); // now a plain (cacheable) string
  return <Outlet />;
}, () => [
  cache({ ttl: 60 }, () => [
    // a child reads ctx.get(UserName) and silently caches user-derived data
  ]),
]);
```

So do **not** read this as "you can't cache user data" — that overstates it and
breeds the false confidence that makes the derived leak _more_ likely. The guard
is deliberately non-propagating (propagation would cost a wrapper per derivation
on the hot path), and it is scoped to the `cache()` segment boundary. `"use
cache"` functions block the same request-scoped reads (`cookies()` / `headers()`
throw inside them) and additionally exclude tainted `ctx`/`env`/`req` args from
the cache key. The pattern that stays safe is also the natural one:
**read tainted context at the point of use, in the path that needs it (a loader or
live segment) — never extract user data into a plain value and cache that.**
Loaders are exempt because they run outside the cache scope and resolve fresh
every request.

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
  cache({ ttl: 300 }),
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
    cache({ ttl: 300 }),
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

## See Also

- `/caching` — cache() DSL setup, stores, nested boundaries
- `/use-cache` — "use cache" directive details, profiles, transforms, guards
- `/document-cache` — store-backed complete-response middleware
- `/deployment-caching` — in-function versus external CDN cache boundaries
- `/ppr` — PPR shell caching: cached HTML shell + live loader holes (different layer)
