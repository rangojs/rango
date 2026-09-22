---
name: caching
description: Configure segment caching with the cache() DSL in @rangojs/router — TTL/SWR, tags and updateTag/revalidateTag, loader-level caching, and the Memory, Cloudflare (Cache API + optional KV), and Vercel Runtime Cache stores. Use when responses should be cached or revalidated, data is stale or not updating after changes, or you are wiring up a cache store.
argument-hint: "[setup]"
---

# Caching

This skill covers the route-level `cache()` DSL (segment caching), loader-level
caching, tag invalidation, and the built-in cache stores. `cache()` stores the
rendered segments of a route subtree and serves them with a TTL and an optional
stale-while-revalidate (SWR) window; loaders keep running on every request.

> SWR support is store-specific. `CFCacheStore` and `VercelCacheStore` serve a
> stale entry and revalidate it in the background for every entry family
> (segments, responses, loader and `"use cache"` items, PPR shells).
> `MemorySegmentCacheStore` does this for responses, items, and shells, but its
> route-segment entries expire at `ttl` (the `swr` window is ignored) with no
> background revalidation. Use `CFCacheStore` or `VercelCacheStore` to see
> segment SWR. See `/cache-guide`.

## Not this skill if…

- You want to cache ONE function or component's return value — that is
  `"use cache"`: see `/use-cache`.
- You want the whole HTTP response frozen, loader output included — see
  `/document-cache`.
- You want the rendered HTML shell cached and only the live holes resumed per
  request — that is the `ppr` path option: see `/ppr`.
- You want segments rendered once at build time — see `/prerender`.
- You are unsure which cache layer you need — start at `/cache-guide`.

## What cache() caches: everything except loaders

`cache()` caches **everything except loaders**. On a cache hit, the cached
segments (layouts, route components, parallels — including any resolved
Suspense content) are served from the store, and **loaders re-run fresh on every
request**, streaming their results into the same response. Loaders are the live
holes of an otherwise-cached segment tree.

A `cache()` boundary at the document root therefore gives you a cached shell
with live loader holes, in one streamed response with no extra round trip. The
browser cannot tell the segments came from cache. This is a Flight segment
cache: HTML is still rendered on every request. The `ppr` path option is a
separate layer that also caches the rendered HTML shell and resumes only the
holes — see `/ppr`, and `/cache-guide` for how the layers stack.

```typescript
cache({ ttl: 60, swr: 300 }, () => [
  layout(<RootLayout />), // cached
  path("/dashboard", Dashboard, { name: "dashboard" }, () => [
    loader(StatsLoader), // live hole — re-runs every request
  ]),
]);
```

The consumer rule: **want it cached? render it inline. Want it live? put it in a
loader and read it with `useLoader()` in a client component.** Anything read
with `cookies()`, `headers()`, or a non-cacheable variable belongs in a loader
(loaders always run fresh). Reading it directly in a cached handler throws;
awaiting a loader with `ctx.use()` and rendering the result in a cached handler
silently bakes per-request data into the shared entry (see "Cache purity &
tainted objects" below).

Pre-rendering (`/prerender`) is the build-time counterpart: it stores the same
kind of segment payload at build time instead of on first request. Both feed the
segment system identically, and loaders always run fresh at request time.

## Route-Level Caching with cache()

Use the `cache()` DSL function to cache routes:

```typescript
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, cache }) => [
  // Fresh for 60 seconds, then served stale for up to 5 more minutes
  // while it refreshes in the background
  cache({ ttl: 60, swr: 300 }, () => [
    path("/blog", BlogIndex, { name: "blog" }),
    path("/blog/:slug", BlogPost, { name: "blogPost" }),
  ]),

  // Uncached routes
  path("/account", AccountPage, { name: "account" }),
]);
```

`cache()` needs a store — the app-level one (see "Global Cache Configuration")
or a per-boundary `store` option. Without one, the boundary renders live.

## Cache Options

Every option is optional. Omitted `ttl`/`swr` fall back to the store's
`defaults`.

```typescript
cache(
  {
    ttl: 60, // seconds fresh. Default: store.defaults.ttl, else 60
    swr: 300, // seconds a stale entry is served while it refreshes.
    //           Default: store.defaults.swr, else no SWR window
    tags: ["blog"], // or (ctx) => string[]; see "Tag-Based Invalidation"
    key: (ctx) => `blog:${ctx.pathname}`, // replaces the default key entirely
    condition: (ctx) => !ctx.request.headers.has("x-preview"), // false = bypass
    store: blogStore, // per-boundary store; see "Custom Cache Store"
  },
  () => [
    // Cached routes
  ],
);
```

- **Default key**: `{doc|partial|intercept}:{host}{pathname}[:params][?search]`
  — document requests, client navigations, and intercept navigations are cached
  separately. The search part honors `cache.searchParams` (below).
- **`key`** is a full override: it bypasses the default key, the store's
  `keyGenerator`, and the search-param filter.
- **`condition`** returning `false` skips both the cache read and write for that
  request (the boundary renders live).
- `cache(() => [...])` with no options uses the store defaults.
- `cache(false, () => [...])` disables caching for a subtree (see "Nested Cache
  Boundaries").

## When cache() does not pay

A cache hit is not free: it still runs middleware, the store read, and the
document render AROUND the cached segment. The win is proportional to what
the cached render itself costs — measured on a deployed Cloudflare worker
(2026-07), a trivial page inside `cache()` served hits at p50 36 ms while
misses (render + store) served at 35 ms: indistinguishable. The same
boundary around an expensive render (slow data, big trees) is where the TTL
pays for itself.

Rule of thumb: reach for `cache()` when the segment's own render cost is
meaningfully above your latency floor — expensive render-embedded data work,
large component trees, third-party calls captured in the render. Do not wrap cheap
pages "just in case": you add store traffic and invalidation surface for no
latency win. If the data is what's expensive and it changes per-request,
prefer a loader with `cache()` on the loader DATA (see "Loader-Level
Caching") over caching the rendered segment.

## Tag-Based Invalidation

Tag cached entries, then invalidate them on demand. Tags can be attached four ways:

```typescript
import { cacheTag } from "@rangojs/router";

// 1. Static tags in the cache() DSL
cache({ ttl: 300, tags: ["products"] }, () => [path("/products", List)]);

// 2. Dynamic tags (function of ctx)
cache(
  { ttl: 300, tags: (ctx) => [`product:${ctx.params.id}`, "products"] },
  () => [path("/products/:id", Detail)],
);

// 3. Runtime tags inside a "use cache" function
async function getProduct(id: string) {
  "use cache";
  cacheTag(`product:${id}`, "products"); // variadic, additive
  return db.getProduct(id);
}

// 4. Render-callable — a plain server component (no "use cache" in its tree)
//    records onto the request's document/shell artifact.
function CampaignBanner() {
  cacheTag("campaign:spring"); // tags the ppr shell / document-cache entry
  return <aside>Spring sale</aside>;
}
```

Each tag attaches to one entry, so know which entry you are tagging:

- Forms 1 and 2 tag the `cache()` segment entry. They are the only way to tag
  it: tags recorded by a `"use cache"` function (form 3) stay on that
  function's entry and do not attach to an enclosing `cache()` segment entry.
- Form 3 tags the `"use cache"` entry (plus any profile `tags`).
- Form 4 tags the request's `ppr` shell entry (`/ppr`) or `/document-cache`
  entry, with no `"use cache"` needed. Called inside a `cache()` segment it
  still tags the document/shell, not the segment entry. On a route that is
  neither `ppr` nor document-cached, nothing reads the tag — a silent no-op, so
  do not expect a bare `cacheTag()` to tag an ordinary uncached page.

Invalidate with one of two server-only verbs (both variadic, imported from
`@rangojs/router`):

```typescript
import { updateTag, revalidateTag } from "@rangojs/router";

// Server Action — read-your-own-writes. Await it so the action's own re-render
// (and the next navigation) sees fresh data.
async function updateProduct(formData: FormData) {
  "use server";
  await db.updateProduct(formData);
  await updateTag("products");
}

// Webhook or response-route handler — background, non-blocking (waitUntil).
// Hard purge: the next read re-renders fresh (NOT stale-while-revalidate).
function onProductsChanged() {
  revalidateTag("products");
  return new Response("ok");
}
```

| API                      | Timing                      | Use in                    | Semantics                                             |
| ------------------------ | --------------------------- | ------------------------- | ----------------------------------------------------- |
| `updateTag(...tags)`     | awaitable (`Promise<void>`) | server actions            | immediate; next read is fresh                         |
| `revalidateTag(...tags)` | background (`void`)         | route handlers / webhooks | background (non-blocking); next read re-renders fresh |

Both must run inside a request (action, handler, middleware, response route).
Called from a queue consumer or cron job, there is no request context, so they
warn and invalidate nothing. `updateTag()` rejects when a store's durable write
fails, so you can retry; `revalidateTag()` reports the failure to `onError`
(phase `"cache"`, category `cache-invalidate`) instead.

All three built-in stores support tags. If no tag-capable store is configured,
`updateTag`/`revalidateTag` warn and no-op.

For `CFCacheStore`, cross-colo invalidation needs either a `kv` namespace
(marker mode — the tag-invalidation markers live in that same namespace; there
is **no** separate tag-invalidation store to wire) or `tagPurge` (purge mode,
below). With neither, invalidation logs a warning and has no effect.

By default `CFCacheStore` reads the KV marker on every tagged cache read
(strongest invalidation latency). To cut KV reads on hot tagged routes, set
`tagCacheTtl` (seconds) to cache each marker in the per-colo edge cache for that
window — the colo running `updateTag`/`revalidateTag` writes the fresh marker
into its own edge cache immediately (read-your-own-writes), while other colos
converge within `tagCacheTtl` (the **maximum extra cross-colo invalidation
latency** when no purge is wired). Keep it small (e.g. 30–60), or wire a purge
(below) and set it large. (Contrast `tagInvalidationTtl`, which must be _large_
— it bounds how long the KV marker itself lives and must exceed your max entry
TTL+SWR. Left unset there is no expiry: KV markers accumulate unbounded under
high-cardinality tags, so set it above your largest entry TTL+SWR to bound them.)

To make other colos prompt without a short `tagCacheTtl`, pass `onRevalidateTag`:
each cached marker carries a namespaced Cloudflare `Cache-Tag`, and the hook is
handed exactly those tags (batched, once per `updateTag`/`revalidateTag` call) to
feed Cloudflare's purge-by-tag API — evicting the cached lookups everywhere.
Purge-by-tag is available on all plans (since April 2025), subject to per-plan
rate limits, so the batched single call matters. With a purge wired, `tagCacheTtl`
becomes a pure read-cost reducer + fallback window.

**Purge mode (`tagPurge`).** Instead of checking a KV marker on every L1 read,
the store can evict tagged L1 entries with Cloudflare's purge-by-tag API:

```typescript
new CFCacheStore({
  ctx,
  kv: env.CACHE_KV,
  tagPurge: { zoneId: env.CF_ZONE_ID, apiToken: env.CF_PURGE_TOKEN },
});
```

The token needs the `Zone.Cache Purge` permission; keep it in a Worker secret.
You can also pass a `(cacheTags) => Promise<void>` function (for a proxy or a
test stub); `createCloudflareZonePurge({ zoneId, apiToken })` from
`@rangojs/router/cache` builds the default one. In purge mode every tagged L1
entry carries a namespaced `Cache-Tag`, `updateTag()`/`revalidateTag()` await one
batched purge call, and L1 hits skip the marker lookup. The KV tier and PPR shell
reads still use KV markers, so keep `kv` configured when you have it; without
`kv`, purge mode is the only tag invalidation and the store runs L1-only. A
failed purge makes `updateTag()` reject. Purge-by-tag clears only your zone:
`workers.dev` previews have an inert Cache API.

## Named Cache Profiles

Named profiles in `createRouter({ cacheProfiles })` are for the
`"use cache: <name>"` directive only (see `/use-cache`). `default` is built in as
`{ ttl: 900, swr: 1800 }` and can be overridden. An invalid profile name or
ttl/swr value throws when the router is created; an unknown profile name throws
on the first call of a function that uses it.

```typescript
createRouter({
  cacheProfiles: {
    default: { ttl: 900, swr: 1800 },
    short: { ttl: 60, swr: 120 },
    long: { ttl: 3600, swr: 7200 },
  },
});
```

The DSL `cache()` helper does NOT accept a profile name — pass the options
object directly:

```typescript
export const urlpatterns = urls(({ path, cache }) => [
  cache({ ttl: 3600, swr: 7200 }, () => [
    path("/blog", BlogIndex, { name: "blog" }),
  ]),

  // Orphan cache boundary: with no children callback it covers the
  // siblings that follow it
  cache({ ttl: 60, swr: 120 }),
  path("/feed", FeedPage, { name: "feed" }),
]);
```

## Loader-Level Caching

Loaders are never part of a segment entry. To cache a loader's DATA, give the
loader its own `cache()`:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  // Cache this loader's results for 5 minutes
  loader(ProductLoader, () => [cache({ ttl: 300 })]),

  // This loader is not cached
  loader(CartLoader),
]);
```

A loader `cache()` takes the same options as the DSL (`ttl`, `swr`, `tags`,
`key`, `condition`, `store`) and is stored in the store's item family, so SWR
works on every built-in store. Without options, `cache()` uses the store's
defaults (ttl 60 when the store sets none); it does **not** inherit the options
of an enclosing `cache()` boundary. Inside `loader()` only the direct form
`cache({...})` is valid — the wrapper form `cache(opts, () => [...])` throws.
See `/loader` for the full loader reference.

## Global Cache Configuration

Configure the app-level store on the router. `cache()` boundaries, cached
loaders, `"use cache"`, `ppr` shells, and `createDocumentCacheMiddleware()` all
use it.

```typescript
import { createRouter } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";

const store = new MemorySegmentCacheStore({
  // On the memory store `swr` applies to loader, "use cache", response and
  // shell entries; route segments expire at ttl.
  defaults: { ttl: 60, swr: 300 },
});

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  cache: {
    store,
    enabled: true, // false = no app store for the request: every layer above is off
  },
});
```

`cache` may also be a function `(env, ctx) => ({ store, enabled?, searchParams? })`
when the store needs runtime bindings (Cloudflare, Vercel).

### Search param key filtering (`cache.searchParams`)

By default every non-reserved query param keys the cache, so
`?utm_source=tw` and `?utm_source=ig` occupy separate slots in every tier.
The global `searchParams` option controls which params participate in default
cache-key generation:

```typescript
import { createRouter, TRACKING_SEARCH_PARAMS } from "@rangojs/router";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  cache: {
    store,
    // "all" (default) | "none" | { include: string[] } | { exclude: string[] }
    searchParams: { exclude: TRACKING_SEARCH_PARAMS },
  },
});
```

- **Key-only**: `ctx.searchParams` and the request URL are untouched — handlers
  and loaders still see the full query string.
- **Matching**: exact names plus a `*` SUFFIX wildcard (`"utm_*"`). No RegExp.
- **All tiers**: segment, document, response, PPR shell capture/lookup, the
  baked-shell manifest gate (a URL whose only params are excluded ones now
  matches the prerendered shell), and `"use cache"` ctx key normalization.
- **`cache({ key })` override wins**: a custom key bypasses the filter along
  with the rest of default key generation.
- **The footgun**: excluding a param promises the rendered output does not
  depend on it. If it does, the first variant is cached and served to everyone.
  That is why the default is `"all"`.
- `TRACKING_SEARCH_PARAMS` (also exported from `@rangojs/router/cache`) covers
  `utm_*`, `gclid`, `fbclid`, `msclkid`, `ttclid`, `mc_cid`/`mc_eid`, and the
  other common click-id params.

Global-only by design — the per-route "this page varies only by `q`" case is
already expressible with `cache({ key })`.

## Cache Stores

| Store                     | Import                  | Use for                                            |
| ------------------------- | ----------------------- | -------------------------------------------------- |
| `MemorySegmentCacheStore` | `@rangojs/router/cache` | dev, tests, single-process Node deployments        |
| `CFCacheStore`            | `@rangojs/router/cache` | Cloudflare Workers (Cache API L1 + optional KV L2) |
| `VercelCacheStore`        | `@rangojs/router/cache` | Vercel Functions (Vercel Runtime Cache)            |

### Memory Store

For development, tests, and single-instance deployments. Entries live in
process memory, so each instance has its own cache and a restart empties it.

```typescript
import { MemorySegmentCacheStore } from "@rangojs/router/cache";

const store = new MemorySegmentCacheStore({
  defaults: { ttl: 60 }, // segments ignore swr on this store
  maxEntries: 1000, // per-family FIFO cap (default 1000)
  name: "app", // optional: keep entries across Vite HMR module reloads
});
```

Each internal family (segments, responses, `"use cache"` items, PPR shells) is
capped at `maxEntries`; on insert past the cap the oldest entry is evicted FIFO
and its tag-index entries are cleaned up, so a long-lived process cannot grow
without bound. TTL expiry stays lazy on top of the cap. Two stores with the same
`name` share their backing maps.

### Cloudflare Edge Cache Store

For distributed caching on Cloudflare Workers using the Cache API:

```typescript
import { CFCacheStore } from "@rangojs/router/cache";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      ctx: ctx!, // ExecutionContext, required (non-blocking writes)
      defaults: { ttl: 60, swr: 300 },
    }),
    enabled: true,
  }),
});
```

`CFCacheStore` prefixes every key with the build version, so a deploy never
reads the previous build's entries (override with `version`). See `/cache-guide`
→ "Cross-deploy safety" and `/cloudflare` for bindings.

### With KV L2 Persistence

Add a KV namespace for global cross-colo persistence. On Cache API miss, KV is
checked and hits are promoted back to L1. Writes go to both layers.

```typescript
import { CFCacheStore } from "@rangojs/router/cache";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      ctx: ctx!,
      kv: env.CACHE_KV, // optional KV namespace binding
      defaults: { ttl: 60, swr: 300 },
    }),
    enabled: true,
  }),
});
```

**How the two layers work:**

| Scenario     | L1 (Cache API) | L2 (KV) | Result                        |
| ------------ | -------------- | ------- | ----------------------------- |
| Hot request  | HIT            | —       | Serve from L1 (fast)          |
| Cold colo    | MISS           | HIT     | Serve from KV, promote to L1  |
| First render | MISS           | MISS    | Render, write to both L1 + KV |

KV entries require `expirationTtl >= 60s`. Short-lived entries (< 60s total TTL)
are only cached in L1.

### Resilience & latency budgets

Every cache read is **fail-safe**: a degraded tier never stalls or fails the
request — it degrades to the next tier (L1 → L2 → render). Three optional latency
budgets (milliseconds) bound each tier so a slow colo or KV namespace cannot pin
a request behind it:

| Option                | Default | Bounds                              |
| --------------------- | ------- | ----------------------------------- |
| `edgeLookupTimeoutMs` | `25`    | L1 `cache.match` (the lookup)       |
| `edgeReadTimeoutMs`   | `20`    | L1 body read (CF streams it lazily) |
| `kvReadTimeoutMs`     | `170`   | L2 / KV read                        |

Set any to `0` (or a negative value) to disable that budget and always await the
read. A non-finite value (e.g. `Number(env.UNSET)`) falls back to the default.
The tag-invalidation marker reads inherit these same budgets and **fail open** on
a KV timeout — the entry is served rather than wrongly treated as invalidated.

```typescript
new CFCacheStore({
  ctx,
  kv: env.CACHE_KV,
  defaults: { ttl: 60, swr: 300 },
  // Raise a budget only if your HEALTHY reads legitimately run slower (large
  // Flight payloads, far-from-colo regions); measure the p99 first. These are
  // degradation guard-rails, not tuning levers for "slow is normal here".
  kvReadTimeoutMs: 250,
});
```

Failure handling, by kind — none of these fail the request:

| Failure                         | Behavior                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transient read error (5xx/blip) | Degrade to the next tier; entry left intact                                                                                                       |
| Read budget exceeded (timeout)  | Abandon the read, degrade to the next tier                                                                                                        |
| Corrupt / unparseable L1 entry  | Reported corrupt; degrade to L2 (served if present). The L1 entry is evicted ONLY when L2 has no copy — so the evict can't race the L2→L1 promote |
| Corrupt / unparseable KV entry  | Reported corrupt; evicted (self-heal) + render (no tier below it)                                                                                 |
| Write failure                   | No-op (entry simply not cached); never throws                                                                                                     |

Each is surfaced to the router's `onError` callback (phase `"cache"`, with
`metadata.category` one of `cache-read`, `cache-corrupt`, `cache-write`,
`cache-delete`, `cache-invalidate`, `stale-revalidation`) so you can observe
cache health without affecting users.

### Validating cache behavior with `debug`

Pass `debug` to emit one structured event per L1 read — use it to confirm on a
real deployment (via `wrangler tail`) that the store behaves as expected before
relying on it. It is intended for validation, not steady-state production.

```typescript
new CFCacheStore({
  ctx,
  kv: env.CACHE_KV,
  debug: true, // logs each CFCacheReadDebugEvent to the console
  // ...or capture programmatically:
  // debug: (event) => myTelemetry.record(event),
});
```

Each event reports which tier answered and why (`outcome`: `l1-fresh`,
`l1-stale-revalidate`, `l1-revalidating-guarded`, `match-timeout`, `match-error`,
`body-timeout`, `body-error`, `non-200`, `tag-invalidated`, `l1-miss`, `kv-fresh`,
`kv-stale`, `kv-stale-suppressed`, `kv-miss`, `kv-timeout`, `error`), the
staleness / revalidating timestamps, and the measured per-tier durations:
`matchMs` (the L1 `match`), `markerMs` (the tag-marker resolution tail for a
tagged entry, between `matchMs` and `bodyReadMs`; absent or 0 for an untagged
entry or a per-request memo hit), and `bodyReadMs` (the L1 body read). A
persistently large `markerMs` signals a degraded KV namespace; on a healthy
deployment KV keeps markers hot in its per-colo edge cache, so it stays a few
milliseconds. `match-error` (a transient `cache.match` rejection that falls
through to L2) is kept distinct from a plain `l1-miss`.

### Vercel Runtime Cache Store

For Vercel Functions. Pass the Runtime Cache handle from `@vercel/functions`;
the store adds SWR, tag invalidation, and the family split on top of it.

```typescript
import { getCache, waitUntil } from "@vercel/functions";
import { VercelCacheStore } from "@rangojs/router/cache";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  cache: () => ({
    store: new VercelCacheStore({
      // A per-deploy namespace: Vercel does not reconcile entries across deploys
      cache: getCache({ namespace: process.env.VERCEL_DEPLOYMENT_ID }),
      waitUntil,
      defaults: { ttl: 60, swr: 300 },
    }),
  }),
});
```

Writes over 2 MB (the platform limit, `maxItemBytes`) are skipped, and tags
beyond the per-item cap are dropped with a warning. The official client swallows
`expireTag` failures, so treat `updateTag()` on Vercel as best-effort. See
`/vercel` for the preset and the remaining options (`version`, `name`, `debug`).

## Cache purity & tainted objects

A `cache()` boundary caches everything except loaders, so anything read inside a
cached handler is **frozen into the shared cache entry** and served to every
subsequent visitor. To stop one user's request-scoped data from leaking to
another, request-scoped APIs are guarded inside a cache scope:

| Inside a `cache()` boundary                                                        | Behavior                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `cookies()` / `headers()` (read or write)                                          | **throws** — request-scoped, would poison the entry |
| Response writes: `ctx.headers.set()`, `setCookie()`, `setStatus()`, `onResponse()` | **throws** — response side effects lost on a hit    |
| `ctx.get(var)` where the var is `{ cache: false }`                                 | **throws** on read                                  |
| `ctx.set(var, value)` for a cacheable var                                          | allowed (children are cached too)                   |
| Any of the above **inside a registered loader** (`loader(...)`)                    | **allowed** — loaders always run fresh              |

A loader body invoked from a handler with `await ctx.use(Loader)` may read
`cookies()`/`headers()`, but its response writes still throw: on a hit the
handler is skipped, so that loader never runs.

**Tainted objects.** Request-scoped objects (`ctx`, `env`, `request`) carry an
internal taint symbol so they are excluded from `"use cache"` cache keys. The
`cache()` scope is tracked in async-local state and deliberately ends inside
loaders — which is exactly why loaders are the live holes: they may read
`cookies()`/`headers()` and re-run on every request.

The fix for "I need request data in a cached route": register a `loader()` and
**consume it with `useLoader()` in a client component**. The loader is the
live hole — its data rides the fresh (never-cached) loader segment and is
rendered in the client component, so it never lands in the cached entry.

This is NOT the same as awaiting the loader in the handler. A cached handler
that does `await ctx.use(Loader)` and renders the result bakes that per-request
data straight into the shared cached segment — the loader running "fresh" does
not help, because its output was inlined into the cached parent, and `ctx.use()`
is **not** guarded. `ctx.use()` is a server-side escape hatch for non-rendered
uses (set a ctx var, make a routing decision); never render its result inside a
cached handler.

This is the **consumption-lane rule**, and it holds identically for every
shared artifact — `cache()`, `"use cache"`, and the PPR shell (`/ppr`):
handler consumption = baked copy with identity reads permitted; client-side
`useLoader` = live. It is stated once in `/rango` → Invariants.

```typescript
// WRONG — throws: cookies() read directly in a cached handler
cache({ ttl: 60 }, () => [
  path("/me", () => <Profile id={cookies().get("uid")?.value} />, { name: "me" }),
]);

// ALSO WRONG (unguarded, but leaks) — the awaited loader data is rendered into
// the cached handler, so the user's data is frozen into the shared entry.
cache({ ttl: 60 }, () => [
  path(
    "/me",
    async (ctx) => {
      const { user } = await ctx.use(MeLoader); // runs fresh…
      return <Profile user={user} />; // …but inlined into the CACHED segment → leak
    },
    { name: "me" },
    () => [loader(MeLoader)],
  ),
]);

// RIGHT — consume the loader in a CLIENT component via useLoader(). The cached
// route segment holds only the <Profile/> reference; the user data rides the
// fresh loader segment and renders client-side.

// profile.tsx (client component)
"use client";
import { useLoader } from "@rangojs/router/client";
import { MeLoader } from "./loaders";

export function Profile() {
  const { data } = useLoader(MeLoader); // fresh per request; never cached
  return <span>{data.user.name}</span>;
}

// urls — register the loader; MeLoader reads cookies() inside the loader (allowed)
cache({ ttl: 60 }, () => [
  path("/me", () => <Profile />, { name: "me" }, () => [loader(MeLoader)]),
]);
```

See `/cache-guide` for the full decision guide and the `cache()` vs `"use cache"` comparison.

## Nested Cache Boundaries

An inner boundary overrides the settings of the outer one for its subtree;
`cache(false)` turns caching off for a subtree:

```typescript
cache({ ttl: 300 }, () => [
  path("/blog", BlogIndex, { name: "blog" }),

  // Override: shorter TTL for this section
  cache({ ttl: 30 }, () => [
    path("/blog/:slug", BlogPost, { name: "blogPost" }),
  ]),

  // Opt out: always rendered live
  cache(false, () => [path("/blog/drafts", Drafts, { name: "drafts" })]),
]);
```

## Custom Cache Store

Create a dedicated store for specific routes:

```typescript
const checkoutCache = new MemorySegmentCacheStore({
  defaults: { ttl: 10 },
});

// In urls
cache({ store: checkoutCache }, () => [
  path("/checkout", CheckoutPage, { name: "checkout" }),
]);
```

A per-boundary store becomes reachable by `updateTag()`/`revalidateTag()` only
once that boundary has been matched in the current process. For data you
invalidate by tag, prefer the app-level store.

## Complete Example

```typescript
import { urls } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import * as CartActions from "./actions/cart";

// Custom store for checkout (short TTL)
const checkoutCache = new MemorySegmentCacheStore({
  defaults: { ttl: 10 },
});

export const urlpatterns = urls(({ path, layout, cache, loader, revalidate }) => [
  // Public routes with aggressive caching
  cache({ ttl: 300, swr: 600 }, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
  ]),

  // Blog routes with moderate caching
  cache({ ttl: 60, swr: 300 }, () => [
    layout(<BlogLayout />, () => [
      path("/blog", BlogIndex, { name: "blog" }),
      path("/blog/:slug", BlogPost, { name: "blogPost" }, () => [
        // Uses the app store's defaults, not the enclosing boundary's options
        loader(BlogPostLoader, () => [cache()]),
      ]),
    ]),
  ]),

  // Shop routes with per-loader caching
  layout(<ShopLayout />, () => [
    path("/shop/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader, () => [cache({ ttl: 120 })]),
      loader(CartLoader, () => [
        revalidate((ctx) => ctx.isAction(CartActions) || undefined),
      ]),
    ]),
  ]),

  // Checkout with custom cache store
  cache({ store: checkoutCache }, () => [
    path("/checkout", CheckoutPage, { name: "checkout" }),
  ]),

  // No cache for account pages
  path("/account", AccountPage, { name: "account" }),
]);
```
