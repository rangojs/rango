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

`cache()` covers only its own subtree. A layout declared above the boundary is
not stored: it renders on every request, hits included, with its parallels and
loaders, so a per-request shell or a header it writes stays live. On a `ppr`
route the whole chain bakes into the shell, so there `cache()` covers the whole
chain, and a shell never outlives the route `cache()` entry it was captured
from (it is fresh and served no longer than that entry; `/ppr`).

```typescript
layout(AccountShell, () => [
  // live: runs on every request, cache hits included
  cache({ ttl: 60 }, () => [
    path("/products/:id", ProductPage, { name: "product" }), // cached
  ]),
]);
```

A `cache()` among a path's own children caches that one path: its handler and
its own layouts and parallels. Every other item in the list still attaches to
the path, and everything above the path stays live:

```typescript
layout(AccountShell, () => [
  // live
  path("/products/:id", ProductPage, { name: "product" }, () => [
    cache({ ttl: 60 }), // caches ProductPage and ProductChrome
    layout(ProductChrome),
  ]),
]);
```

A `cache()` inside a `layout()` or `middleware()` wrapper in the path does the
same: `layout(ProductChrome, () => [cache({ ttl: 60 })])` caches the whole
path, not only ProductChrome.

The consumer rule: **want it cached? render it inline. Want it live? put it in a
loader and read it with `useLoader()` in a client component.** Anything read
with `cookies()`, `headers()`, `ctx.request.headers`, or a non-cacheable
variable belongs in a loader:
a route `cache()` does not store loader values, so a loader runs on every
request. A loader bound with its own `cache()` is stored, so without a `key()`
its miss fails; any `key()` switches that check off, so it must include the
value (see `/loader` → "Cache Key"). Reading it directly in a cached handler throws;
awaiting a loader with `ctx.use()` and rendering the result in a cached handler
silently bakes per-request data into the shared entry (see "Cache purity &
tainted objects" below).

Handle pushes follow the same split. Handler pushes (`ctx.use(Meta)`,
`ctx.use(Breadcrumbs)`, custom handles) are stored with the segments and
replayed on a hit. Pushes from a `loader()` body are not stored: the loader
re-runs on the hit and pushes again, so each value appears once. A loader that
runs only because a cached handler awaited it with `ctx.use(Loader)` does not
re-run on a hit, so its pushes are stored with the handler's.

A component that throws while the entry is written is not cached. Writing
re-renders the segments, so an async server component whose fetch fails there
would otherwise be stored as an error and rendered on every hit. Instead the
write is skipped and reported to `onError` (phase `"cache"`, category
`cache-write`): the next request renders fresh, and a stale entry keeps serving.
The same applies to a stored handle push whose value fails to encode, such as a
rejected promise: the whole entry is skipped, not just its handles.

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
  `keyGenerator`, and the search-param filter. The result is stored
  namespaced (`key:` plus its URI encoding), so whatever it returns, request
  input included, never names another route's default-keyed record or a
  nested partition's. A nested `cache()` keys its records within that
  partition (see "Keys nest" under "Nested Cache Boundaries"). On a `ppr`
  route the same key (or, without one, the store's `keyGenerator`)
  partitions the PPR shell: each partition captures and serves its own shell
  (`/ppr`, "Request-partitioned shells").
- **`condition`** returning `false` skips both the cache read and write for that
  request (the boundary renders live). It gates every `cache()` nested under
  it too: an inner boundary caches only when every enclosing `condition()`
  allows it.
- **`tags`** tag this boundary's records and those of every `cache()` nested
  under it, so `updateTag()` of an outer tag evicts the inner records too.
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

- Forms 1 and 2 tag the `cache()` segment entry, and the entries of every
  `cache()` nested under it (see "Conditions and tags inherit").
- Form 3 tags the `"use cache"` entry (plus any profile `tags`), and every
  `"use cache"` entry that calls that function: the outer entry bakes the
  inner value, so it carries the inner tags.
- Form 4 tags the request's `ppr` shell entry (`/ppr`) or `/document-cache`
  entry, with no `"use cache"` needed. On a route that is neither `ppr` nor
  document-cached and has no `cache()`, nothing reads the tag — a silent
  no-op, so do not expect a bare `cacheTag()` to tag an ordinary uncached page.
- A route `cache()` entry also carries the tags its own content recorded when
  it was written: form 4 calls and form 3 reads in the handlers and server
  components it covers. `updateTag()` of such a tag drops the entry, and a HIT
  re-records the tags, so a ppr shell or document built from the HIT stays
  evictable. `loading()` subtrees count too: a HIT replays their output. A
  loader's tags reach the entry only when a handler consumes its value
  (`await ctx.use(Loader)`); a loader nobody reads on the server runs per
  request and stays off.
- A loader with its own `cache()` stores the tags its body recorded (form 4
  calls and form 3 reads, including those of the loaders it reads with
  `ctx.use()`) next to its `cache({ tags })`. They invalidate the loader's
  entry, and a HIT records them again, so a route `cache()` entry, ppr shell
  or document built over the HIT carries them.

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

The request that calls either verb reads its own writes. Before the call
returns, each built-in store marks the tags as invalidated for the rest of that
request, so an action that calls `revalidateTag()` and then renders gets fresh
`"use cache"` and `cache()` reads, as with `await updateTag()`. What
`revalidateTag()` does not wait for is the durable write (the KV marker, the
tag purge, Vercel's `expireTag`): other requests see the invalidation once it
lands.

Work that started before the invalidation, in this request or another one,
is not stored after it. A `"use cache"` call, a stale entry's background
refresh, a loader's own `cache()`, a route `cache()` render or a
document-cache render that read its data before one of its tags was
invalidated still returns what it read, but its store write is skipped:
every store stamps an entry when it is written, so the old value would be
served as newer than the invalidation. The next read runs it again. A
`"use cache"` call already running when one of its tags is invalidated is
not joined by later calls either. Its tags include those of the
`"use cache"` functions it calls. Another isolate's invalidation is caught
through the store's markers (`CFCacheStore` with KV, `VercelCacheStore`); on
a KV-less `CFCacheStore` only this isolate's invalidations are, and ttl+swr
bounds the rest.

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

In a layout's children, a `layout()` after the bare `cache()` wraps every
route of that layout, as it would without the `cache()`. It is cached only with
the routes after the `cache()`; on a route before it, it renders live:

```typescript
layout(<AppShell />, () => [
  path("/a", PageA, { name: "a" }), // PromoBanner renders live
  cache({ ttl: 60 }),
  layout(<PromoBanner />),
  path("/b", PageB, { name: "b" }), // PromoBanner cached with PageB
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
Handle pushes from the loader body (`Meta`, `Breadcrumbs`) are stored with the
value and replayed on every hit, stale included. The tags the body records
(`cacheTag()`, `"use cache"` reads, and those of the loaders it reads) are
stored with it too: `updateTag()` of one drops the entry, as `cache({ tags })`
does. See `/loader` for the full loader reference.

The entry's default key is the loader, host, path and params. It does not
inherit an enclosing `cache()` boundary's `key()` either, so it is shared
across users: a body that reads `cookies()`, `headers()`, `ctx.request.headers`
or a non-cacheable variable fails on a miss unless the loader `cache()` has a
`key()` or its store
a `keyGenerator`. Either one switches the check off, so it must itself include
the value (`/loader` → "Cache Key").

### Loaders and `prefetch: false`

A loader registered with `{ prefetch: false }` is skipped in a `<Link>`
prefetch, and its own `cache()` is not read either, even when it would hit:
the fill request that the click sends afterwards reads the loader cache and
runs the loader on a miss. A route-level `cache()` boundary is unaffected: its
stored handler output is served and written as before, hit or miss, and
`loading(fallback, { prefetch: false })` under it defers only the loaders
behind the fallback, never the cached handler. A `cache()` route below a
layout with a flagged `loading()` keeps using its record whenever the browser
already holds that layout; only a prefetch that defers the layout itself (it
is new to the page) leaves the record unread and unwritten. A response that
carries deferred work is never stored: the document cache refuses it and it
is sent `cache-control: private, no-cache`, whatever `Cache-Control` the route
set. A fill response is stored nowhere either. Every body the document cache
does hold is complete, so one entry answers a prefetch and a navigation, as
without the flag. See `/loader` → "`prefetch: false`".

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

### Filling a cache before traffic

Every cache above fills from the first request that misses. To pay that
render before a visitor does (after a deploy, after an `updateTag()`), warm
the URL: `router.prerender({ env, ctx })(url)` sends it through the router's
handler in a mode where every cache read misses and every write replaces the
entry, so the route's `ppr` shell, `cache()` records, `"use cache"` results,
loader caches and document cache entry are rewritten under the keys a
visitor reads, with the old entries serving until then. See `/prerender` →
"Warm any route before traffic".

A warm only writes to a store that is shared beyond the place the call runs.
Each store says where its entries can be read (`scope`): `CFCacheStore` with
`kv` is `"global"`, without `kv` `"local"`; `VercelCacheStore` is `"regional"`
(a warm fills the region it runs in); `MemorySegmentCacheStore` is `"local"`
(refused in production, allowed under the dev server).

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

`CFCacheStore` prefixes every key with a version computed per `createRouter()`
from that router's built code: segment entries and `fn:` items with the data
version, `doc:` responses and `shell2:` shells with the document version. A
deploy that changes a router's code reads under a new version; a deploy that does
not keeps the entries. Tag invalidation markers carry no version, so `updateTag()`
reaches entries of every version. `version` replaces both versions with one
value. See `/cache-guide` → "Cross-deploy safety" and `/cloudflare` for bindings.

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

KV entries require `expirationTtl >= 60s`. Short-lived data entries (< 60s total
TTL) are only cached in L1. A PPR shell is always written to KV, a short one
with the 60 s minimum; its reads still expire it at its own deadline.

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

A PPR shell HIT reads its entry prelude-first: the body budget (or the KV budget
on a KV read, counted from opening the value) covers only the entry's head and
prelude, the tag-marker read runs alongside the prelude read, and the capture
snapshot behind them is read off the commit path, bounded by `kvReadTimeoutMs`
(at least 1 s: the tail cannot render without it). A HIT whose snapshot read
times out, or whose snapshot is truncated or corrupt (also evicted), cannot
replay the captured segment record, so it degrades: the entry is replaced and
recaptured and the page reloads once into a cache-miss render (`/ppr`). The
snapshot holds only what a HIT reads: every HIT replays the handler layer from
the captured segment record and serves an `ssr: false` loader's baked
container, so no `"use cache"` or loader `cache()` item is stored in it. A
live hole, and any loader that runs on the HIT, reads those from the store
under their own ttl/swr and tags.

**Shell memo.** After a shell read, the same isolate serves that key's next
HITs from memory for `memo.shellMs` (default 2000; `{ shellMs: 0 }` turns it
off), with no Cache API or KV read. The tag-marker check still runs on every
HIT, and the isolate that runs `updateTag()`/`revalidateTag()` drops its own
copies, so that request and later ones on the same isolate never get the
invalidated shell. What another isolate can serve for up to one window: the
previous capture of a key another isolate just recaptured, and, without KV in
purge mode, a purged shell (the purge reaches the stored entry, not other
isolates' memos). `memo.shellMaxBytes` (default 16 MiB, shared by every
`CFCacheStore` in the isolate) caps what it holds; only fresh shells are kept.

**Tag-marker memo.** With KV, PPR shell reads check their tag markers through
a per-isolate memo, stale-while-revalidate: a marker read within
`memo.markerFreshMs` (default 1000) is used as is, one within
`memo.markerMaxStaleMs` (default 10000) is used while a background read
refreshes it, an older one waits for KV. The isolate also remembers each
shell's tag names and starts those marker reads with the Cache API match
(`ppr.tags` are known up front). `cache()`, `"use cache"` and response entries
keep reading their markers. `{ markerFreshMs: 0 }` turns the value memo off.

**The fresh-reads cookie.** A response whose request ran `updateTag()` or
`revalidateTag()` sets `<state cookie prefix>-fresh` (`rango-state-fresh` by
default, shared by every router on the host with that prefix; `HttpOnly`,
`SameSite=Lax`, `Path=/`, `Secure` on https, `Max-Age` 11 s with KV and 3 s
without at the defaults: the longest memo staleness plus 1 s). It is strictly
functional: its value is `1`, it identifies no one, and it only sends that
browser's reads past the memos. The same user's requests that carry it skip
both memos on every isolate, so a mutating user never sees a memoized shell or
marker from before their write. What they read past the memos is the store's
own consistency. `VercelCacheStore`: `expireTag` is global (about 300 ms), so
they read fresh in any region. `CFCacheStore` with KV: the shell's tag check
reads that colo's marker (its Cache API copy when `tagCacheTtl` is set, then
KV), so in the colo that ran the mutation they read fresh, while a request
another colo serves can still get the old shell until KV propagates the
marker there (up to about 60 s) and that colo's cached marker (`tagCacheTtl`)
expires. `CFCacheStore` without KV in purge mode (`tagPurge`) has no markers:
the purge is what removes the shell, and they see it once it has reached the
colo serving them. Other users can see a memoized shell or marker for up to
`markerMaxStaleMs` (with KV) or the shell window (`VercelCacheStore` in
another region, `CFCacheStore` in KV-less purge mode, where another isolate's
memo can keep serving the purged shell). Set `{ shellMs: 0, markerFreshMs: 0 }` where every user's next
request must see an invalidation (with KV, `{ shellMs: 0 }` alone still leaves
the marker memo); that also means no cookie. The cookie is not set when the
invalidation runs after the response headers were sent (a streaming loader or
render; dev warns): invalidate in a server action, route handler or
middleware. Any client can send it, which only makes its own requests read
the store.

```typescript
new CFCacheStore({
  ctx,
  kv: env.CACHE_KV,
  memo: { shellMs: 5000, markerFreshMs: 500 },
});
```

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

// No deployment id in the namespace: the store versions its keys itself, so a
// deploy that does not change a router keeps that router's entries.
// One handle per process: the store keeps its PPR shell and tag-marker
// memos per handle.
const runtimeCache = getCache();

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  cache: () => ({
    store: new VercelCacheStore({
      cache: runtimeCache,
      waitUntil,
      defaults: { ttl: 60, swr: 300 },
    }),
  }),
});
```

The store keeps the same PPR shell memo as `CFCacheStore` (`memo.shellMs`,
default 2000; `memo.shellMaxBytes`, default 16 MiB) and the same tag-marker
memo (`memo.markerFreshMs`, default 300; `memo.markerMaxStaleMs`, default
2000), one per `cache` handle: create the handle once, as above, or the memos
never hit. The request that runs `updateTag()`/`revalidateTag()` misses on
the entries carrying those tags before `expireTag` lands. A shell read's
marker check sees the invalidation in the process that ran it once its
markers are written, and in the rest of the region once their marker memo
refreshes. The tag markers are a regional `cache.set` (only
`expireTag` is global), so another region serves a shell it memoized before
the invalidation until its window passes, where without the memo `expireTag`
removes it within about 300 ms; a platform `expireTag` issued outside rango is
likewise seen when the window passes. The fresh-reads cookie (`Max-Age` 3 s)
sends the mutating user's next requests past both memos, and `expireTag` is
global, so they read fresh in any region.

Writes over 2 MB (the platform limit, `maxItemBytes`) are skipped, and tags
beyond the per-item cap are dropped with a warning. The official client swallows
`expireTag` failures, so treat `updateTag()` on Vercel as best-effort. See
`/vercel` for the preset and the remaining options (`version`, `name`, `debug`).

`VercelCacheStore` versions its keys by default: families `s` and `i` take the
router's data version, `r` and `h` its document version, and tag markers
(`rg:tm:{tag}`) take none. `version` replaces both. To clear the cache on every
deploy, set `version` to a per-deploy value or keep a deployment-scoped
`getCache({ namespace: process.env.VERCEL_DEPLOYMENT_ID })`.

## Cache purity & tainted objects

A `cache()` boundary caches everything except loaders, so anything read inside a
cached handler is **frozen into the shared cache entry** and served to every
subsequent visitor. To stop one user's request-scoped data from leaking to
another, request-scoped APIs are guarded inside a cache scope:

| Inside a `cache()` boundary                                                        | Behavior                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `cookies()` / `headers()` (read or write)                                          | **throws** — request-scoped, would poison the entry        |
| `ctx.request.headers`, `getRequestContext().cookie()` / `.cookies()`               | **throws** on read, like `headers()` / `cookies()`         |
| Response writes: `ctx.headers.set()`, `setCookie()`, `setStatus()`, `onResponse()` | **throws** — response side effects lost on a hit           |
| `ctx.get(var)` where the var is `{ cache: false }`                                 | **throws** on read                                         |
| `ctx.theme`, `getRequestContext().theme`                                           | **throws** — the theme is the visitor's cookie             |
| `ctx.set(var, value)` for a cacheable var                                          | allowed (children are cached too)                          |
| Any of the above **inside a registered loader** (`loader(...)`)                    | **allowed** — loaders always run fresh                     |
| Any read in the boundary's own `key()`, `keyGenerator`, `condition()` or `tags()`  | **allowed** — it picks or labels the entry, never rendered |

A loader body invoked from a handler with `await ctx.use(Loader)` may read
`cookies()`/`headers()`/`ctx.request.headers`, but its response writes still throw: on a hit the
handler is skipped, so that loader never runs.

`ctx.request.clone()` is guarded the same way. `fetch(ctx.request)` and
`new Request(ctx.request)` don't throw, but the guard can't see through them:
a fetch forwards the visitor's `Cookie` and `Authorization`, so its response
is per visitor and must not be rendered inside the boundary. A handler that
must render a header its `key()` partitions by reads a copy middleware set:

```tsx
const Tier = createVar<string>();
const tierOf = (ctx: { request: Request }) =>
  ctx.request.headers.get("x-tier") === "gold" ? "gold" : "silver";

middleware(
  async (ctx, next) => {
    ctx.set(Tier, tierOf(ctx)); // middleware runs outside the boundary
    return next();
  },
  () => [
    cache({ ttl: 300, key: (ctx) => `tier:${tierOf(ctx)}` }, () => [
      path("/pricing", (ctx) => <Pricing tier={ctx.get(Tier)} />),
    ]),
  ],
);
```

A loader bound with its **own** `cache()` (`loader(Def, () => [cache({...})])`)
stores its value, and its key does not inherit the route's. A miss whose body
read `cookies()`, `headers()`, `ctx.request.headers` or a non-cacheable
`ctx.get()` fails unless the
binding has a `key()` or its store a `keyGenerator`, which must then include
the value (`/loader` → "Cache Key").

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

This is the **consumption-lane rule**, and it holds for every shared
artifact — `cache()`, `"use cache"`, and the PPR shell (`/ppr`): handler
consumption = baked copy; client-side `useLoader` = live. The tiers differ on
identity reads inside a handler-consumed loader: `cache()` permits them (the
leak above); `"use cache"` throws, because the loader's value is part of the
result: inside the loader body when the cached function starts it, and at
`ctx.use()` when a handler or a `loader()` binding started it first and its
run made such a read; a PPR shell capture
refuses them and the route stays uncached. It is stated once in `/rango` → Invariants.

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

An inner boundary overrides `ttl`, `swr` and `store` for its subtree;
`cache(false)` turns caching off for a subtree. The options that decide
whether and where a record may be shared build up instead: `key` composes
(see below), every enclosing `condition()` must allow the inner boundary, and
the inner records carry the enclosing `tags` too:

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

On a `ppr` route the opt-out also means no shell: `cache(false)`, or a
`condition()` that returns false, renders that route (or that request) like a
cache miss, with no shell served and none captured. A `ppr` route under a
layout's `cache()` therefore cannot opt out of that `cache()` and still get a
shell (`/ppr`).

### Conditions and tags inherit

```typescript
cache(
  {
    condition: (ctx) => !ctx.request.headers.has("x-preview"),
    tags: ["catalog"],
  },
  () => [
    cache({ ttl: 60, tags: ["prices"] }, () => [
      path("/prices", PricesPage, { name: "prices" }),
    ]),
  ],
);
```

- A preview request renders the prices page live: the outer `condition()` bypasses
  the inner record's read and write, and a `ppr` route's shell. Conditions
  combine with AND, through a `cache(false)` with a `cache()` re-enabled
  below it too.
- The prices record carries `catalog` and `prices` (static and function
  `tags` alike), so `updateTag("catalog")` evicts it, and the `ppr` shells
  and documents built from it.
- `cache(false)` is unchanged: it caches nothing below it until a `cache()`
  re-enables caching.
- A loader's own `cache()` and `"use cache"` are separate layers: they take
  neither the route's `condition()` nor its `tags`, nor its `key()`
  partition.

Before issue #974, only the innermost boundary's `condition` and `tags`
applied: a request an outer `condition()` refused still read and wrote the
inner record, and `updateTag()` of an outer tag left it in place.

### Keys nest: a partition covers the whole subtree

A `key()` partitions every record under its `cache()`. A nested `cache()`
keys its records within that partition, so a request in one partition never
HITs another partition's inner record:

```typescript
const tier = (ctx) =>
  ctx.request.headers.get("x-tier") === "gold" ? "gold" : "silver";

cache({ ttl: 300, key: (ctx) => `tier:${tier(ctx)}` }, () => [
  layout(TierLayout, () => [
    // No key() of its own: the outer key() result, then this boundary's own
    // default key ("key:tier%3Agold|doc%3Aexample.com%2Fpricing"), so
    // /pricing and /faq keep their own records
    cache({ ttl: 60 }, () => [
      path("/pricing", PricingPage, { name: "pricing" }),
      path("/faq", FaqPage, { name: "faq" }),
    ]),

    // Its own key() composes with the outer one ("key:tier%3Agold|key:v%3Ab")
    cache(
      { ttl: 60, key: (ctx) => `v:${ctx.searchParams.get("v") ?? "a"}` },
      () => [path("/plans", PlansPage, { name: "plans" })],
    ),
  ]),
]);
```

Every `key()` result is stored as `key:` plus its URI encoding; a default
key in a composed key is URI-encoded. The parts are joined by `|`, `key()`
results first, outermost first:

| Boundary the route sits in                    | Record key                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a single keyed `cache()`                      | Its `key()` result, namespaced (`tier:gold` is stored as `key:tier%3Agold`)                                                                                  |
| `cache({ ttl })`, no `key`, under a keyed one | The chain's `key()` results, then this boundary's default key (its store's `keyGenerator` result, else the default key), encoded                             |
| `cache({ key })` under a keyed one            | The chain's `key()` results                                                                                                                                  |
| deeper nesting                                | Composes the same way; only the innermost boundary's missing `key` adds its default key                                                                      |
| under a `cache({ store })` on another store   | Also that store's `keyGenerator` result, one part per store: empty for a store that returns the default key while another's differs, none when all return it |
| `cache(false)`                                | No caching, as before; a `cache()` re-enabled below it stays in the partition                                                                                |
| no `key` anywhere                             | The default key, or the store's `keyGenerator` result, as before                                                                                             |

- No `key()` result, whatever it returns, equals a default key or a
  composed key, and no two composed keys are equal: a namespaced result
  starts with `key:` and holds no `|`, a default key never starts with
  `key:`, and each part of a composed key is encoded, so the parts and their
  kinds are recoverable. Returning request input from `key()` cannot name
  another route's record (before issue #975 a header value
  `doc:example.com/pricing` returned raw named the pricing page's default-keyed
  record). A prefix (`tier:${value}`) is still worth it for readable keys,
  and normalizing to the values you serve keeps the partition count bounded.
- An inner boundary without `key` keeps everything its default key tells
  apart (path, params, search, document vs navigation), so its routes never
  share a record, even when the outer `key()` names no route.
- A boundary with its own `key()` skips the store's `keyGenerator`, as a
  single `key()` does.
- Each `key()` runs once per request, however many boundaries and lookups use
  it.
- A store's `keyGenerator` partitions the records of a `cache()` on that
  store without a `key()` of its own. A `cache({ store })` on another store
  nested under it keys its records by that `keyGenerator` result too, so a
  locale-partitioned outer boundary never shares an inner record across
  locales. With several such stores each keeps its position: one that
  returns the default key for a request adds an empty part while another's
  differs, and when all return it the key is unchanged. A `keyGenerator` must
  return the default key, not `""`, to leave a request unpartitioned: an
  empty result there fails key resolution, so the request renders uncached,
  and the router warns once naming the store. On the same store the inner
  boundary's own default key already carries it (or its own `key()`
  overrides it).
- A response route's entry (`path.json()` and the other response routes) is
  keyed the same way, behind a `response:` prefix. A `ppr` route's shell is
  partitioned by the chain's `key()` results, namespaced the same way, since
  the shell key already carries the URL (plus the `keyGenerator` results
  above, and the store's for an inner boundary without `key`).
- To share an inner cache across partitions, move it outside the keyed
  `cache()`.

Before issue #970, the innermost boundary alone decided the key: an inner
`cache()` without `key` wrote under the default key and an inner `key()`
dropped the outer partition, so a silver visitor could HIT what a gold
visitor's request had cached. Before issue #974 an outer `cache({ store })`'s
`keyGenerator` did not reach an inner boundary on another store.

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

A store you implement declares where its entries can be read, or
`router.prerender()` refuses to warm into it (a store that declares nothing is
treated as `"local"`):

```typescript
const store: SegmentCacheStore = {
  scope: "global", // every location reads the same entries; or "regional"
  // get, set, delete, ...
};
```

If you implement `SegmentCacheStore` yourself, `invalidateTags(tags)` is called
synchronously inside the invalidating request, and `revalidateTag()` does not
await it. For that request to read its own writes, record the tags and the
time as invalidated in request-scoped state your reads check (a `WeakMap`
keyed by the object `getRequestContext()` returns) before the first `await`,
then start the durable write. Only let that state turn hits into misses, and
only for entries written at or before that time. A store that skips this
still works, but the request that ran `revalidateTag()` can read invalidated
entries until the durable write lands.

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
        // after an action, re-run only for cart actions; on navigation, keep the default
        revalidate((ctx) =>
          ctx.isAction() ? ctx.isAction(CartActions) : undefined,
        ),
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
