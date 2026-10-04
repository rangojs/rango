---
name: cache-guide
description: Decision guide for Rango's cache layers — "use cache", loader cache(), segment cache(), Prerender/Static, the ppr HTML shell, and document/CDN caching — with the cache() vs "use cache" comparison (keys, guards, SWR, nesting). Use when unsure which caching mechanism fits a problem, comparing layers, or asking "which cache API should I use".
argument-hint:
---

# Choosing a cache layer

Start here when you are not sure which cache to use. The first section maps
every layer; the rest of the page compares the two you will reach for most,
the `cache()` DSL and the `"use cache"` directive.

## The layers at a glance

Each layer stores a more "cooked" artifact than the one above it, and keeps less
of the request live on a hit. The runtime layers share the app-level store
(`createRouter({ cache })`) and one tag system (`cacheTag` / `updateTag` /
`revalidateTag`); `Prerender()`/`Static()` output is built into the server
bundle instead.

| Layer                | Declared with                                  | Stores                                                   | Still runs on a hit                                    | Skill                 |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ | --------------------- |
| Function / component | `"use cache"`                                  | one function's return value                              | everything around the call                             | `/use-cache`          |
| Loader data          | `loader(L, () => [cache({...})])`              | one loader's result                                      | other loaders, handlers, rendering                     | `/caching`, `/loader` |
| Segments, runtime    | `cache({...}, () => [...])`                    | rendered Flight segments of a subtree                    | middleware, segments above it, loaders, HTML render    | `/caching`            |
| Segments, build time | `Prerender()` / `Static()`                     | Flight segments rendered at build                        | middleware, loaders, HTML render                       | `/prerender`          |
| HTML shell           | `ppr` path option                              | HTML prelude + React postponed state + the handler layer | middleware and live loaders (no handler); holes resume | `/ppr`                |
| Whole response (app) | `createDocumentCacheMiddleware()` + `s-maxage` | final response in the app store                          | middleware above it; nothing below                     | `/document-cache`     |
| Whole response (CDN) | `Cache-Control: s-maxage` read by the platform | final response outside the app                           | nothing — the app is not invoked                       | `/deployment-caching` |

Quick rules:

- Expensive **data** used in several places → `"use cache"` on the fetch.
- Expensive **rendering** of a route subtree → `cache()`.
- Content fixed at **build time** (known params, files on disk) → `Prerender()`.
- **Instant first byte** of HTML while parts stay per-request → `ppr`.
- **Whole response** public and identical for everyone → `/document-cache` or
  CDN caching (`/deployment-caching`).
- A value that must be fresh on **every** request → a loader (never cached
  unless you opt in), read with `useLoader()`; on a `ppr` route, keep it off
  `ssr: false`. A handler inside a `cache()` or `ppr` boundary that awaits
  `ctx.use(Loader)` renders the value it got on the miss, and every hit
  replays that output.

The layers compose: `"use cache"` inside a `cache()` subtree, a cached loader
under a `cache()` boundary, `cache()` segments replayed inside a `ppr` shell
capture, or `Prerender()` + `ppr` for a shell baked at build time.

## cache() vs "use cache"

Both mechanisms use the same app-level store, and both can be tagged
(`cache({ tags })`; profile `tags` or runtime `cacheTag()` for `"use cache"`) and
invalidated with `updateTag`/`revalidateTag` — see "Two axes" below. Named
cache profiles apply to `"use cache"` only. They differ in scope, cache key,
execution model, and runtime control.

## Two axes — do not conflate

Everything on this page is **stored-value freshness** — _is a cached value
still good?_ There is a second, orthogonal concern it is easy to mistake for
caching:

1. **Stored-value freshness** — _is a cached value still good?_ → `"use cache"`
   (fn/component), `cache()` (segment), loader `cache()` (loader data). Entries
   expire by **TTL/SWR** and can be tagged (`cache({ tags })` or runtime
   `cacheTag(...tags)` — inside `"use cache"` it tags that entry; called during
   a request render outside `"use cache"` it tags what the render stores: the
   enclosing route `cache()` entry, a cached loader's own entry when called in
   its body, and the `ppr` shell or document-cache entry built from them; on a
   `ppr` route it tags the shell only when shell material calls it). All
   built-in stores (`MemorySegmentCacheStore`, `CFCacheStore`,
   `VercelCacheStore`) index by tag; invalidate on demand with
   `updateTag(...tags)` (awaitable) or `revalidateTag(...tags)` (background,
   non-blocking). Both evict rather than mark stale, and the request that calls
   either reads its own writes; `updateTag()` also waits for the durable write,
   `revalidateTag()` leaves it in the background. `CFCacheStore` and
   `VercelCacheStore` serve PPR shell reads through per-isolate memos: the
   invalidating user skips them via the fresh-reads cookie, other users see the
   invalidation once the memo refreshes and, on `CFCacheStore` with KV, once KV
   propagates the marker to their colo (`/caching` → "Tag-Based Invalidation"
   and "The fresh-reads cookie").
2. **Client-update selection** — _should this segment re-run and stream to the
   client on this navigation/action?_
   → `revalidate()`. Covered in `/loader` and `/route`, **not here**.

They are orthogonal and compose: a segment selected by `revalidate()` still
consults its cache (hit → no recompute), except that a server action's
revalidation render skips the route `cache()` lookup and re-renders those
segments fresh (a loader's own `cache()` and `"use cache"` are still read); a
cache bust does **not** force a client
update, and `revalidate()` never reads, writes, or expires a cached value. If you
know React Router, `revalidate()` is `shouldRevalidate`, not `Cache-Control`. See
`/rango` → "Coming from another framework" for the cross-framework mapping.

## Fast choice: cache() or "use cache"

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
(`ctx.headers.set()`, cookie writes) that would be lost on a hit; they differ in what
else they allow:

- **`cache()` boundary guard** (route-level) — fires while the handler runs on a
  miss. `cookies()` and `headers()` throw (request-scoped data would be baked into
  the shared cached shell), and so do the raw reads `ctx.request.headers` and
  `getRequestContext().cookie()` / `.cookies()` (#976);
  `ctx.get(nonCacheableVar)` throws (a tainted value
  would be baked in), and response side effects (`ctx.headers.set()`,
  `setCookie()`, `setStatus()`, `onResponse()`) throw. `ctx.set()` of a cacheable var is
  **allowed** — children are cached too and can read it. **Loaders are exempt**
  (a route `cache()` does not store their values) — read request data inside a
  loader.
- **Loader `cache()` guard** (a loader bound with its own `cache()`) — its value
  is stored under a key that names no user, so a miss whose body read
  `cookies()`, `headers()`, `ctx.request.headers`, the theme or a
  non-cacheable `ctx.get()` fails
  unless the binding has a `key()` or its store a `keyGenerator`. Either one
  switches the check off, so put what the body reads in it (`/loader` →
  "Cache Key").
- **`"use cache"` exec-guard** (function-level) — the same request-scoped APIs
  throw inside the cached function (`cookies()`, `headers()`,
  `ctx.request.headers`, `ctx.set()`, `ctx.headers.set()` and other response
  writes); additionally, tainted `ctx`/`env`/`req` args are excluded from the
  cache key (a `Request` argument keys by its URL only). The guard runs only
  on the cached path: with no item-capable store configured the function runs
  uncached and nothing throws.

All three guards leave a cache's own callbacks alone: a `key()`, a store
`keyGenerator`, a `condition()` and a `tags()` function may read `cookies()`,
`headers()` or `ctx.request.headers`, because the value picks or labels the
entry rather than being rendered into it. So does `onError`, which only
observes. A `"use cache"` function or loader they call is guarded as usual.

`ctx.request.clone()` is guarded like `ctx.request.headers`. The remaining gap:
`fetch(ctx.request)` and `new Request(ctx.request)` don't throw and aren't
guarded. A fetch forwards the visitor's `Cookie` and `Authorization`, so its
response is per visitor; don't make one in a cached body.

The `ppr` shell capture has its own, stricter guard: `cookies()`, `headers()`,
`ctx.request.headers`, a theme read, a `{ cache: false }` variable read, and
`ctx.dynamic()` refuse the
capture anywhere it waits — handlers, promises they pass or push, async server
components, `ssr: false` loaders, and loaders a handler awaits (no loader
exemption there). The route then serves uncached; see `/ppr`.

### Cross-deploy safety: version-segmented store keys

`CFCacheStore` and `VercelCacheStore` prefix every **physical** store key with a
version, so a build only reads entries that code like its own wrote. The version
is a hash of the code, computed per `createRouter()` by `vite build`, not the
build time. Each router has two:

- The **data version** (a hash of the router's server code) keys cached RSC
  data: segment entries from `cache()`, `"use cache"` values, loader data.
- The **document version** (the data version plus the SSR output, the client
  asset file names, `base`, and the router's `Prerender` payloads) keys stored
  HTML (PPR shells, document-cache responses). It is also sent to the browser,
  and a mismatch with the tab's `_rsc_v` reloads the tab.

Same code builds to the same versions, so a rebuild or redeploy of unchanged
code keeps the cache, and a deploy that changes app A keeps app B's cache.

| Deploy                                | Cached data         | Stored HTML           | Open tabs               |
| ------------------------------------- | ------------------- | --------------------- | ----------------------- |
| Rebuild, no code change               | kept                | kept                  | untouched               |
| Server code of app A changes          | cleared for A only  | cleared for A only    | A's tabs reload         |
| Client code of any app changes        | kept for every app  | cleared for every app | every app's tabs reload |
| Server code shared by A and B changes | cleared for A and B | cleared for A and B   | A's and B's tabs reload |

"Server code" is everything the app's server can run: its own modules, the
dependencies it imports (bundled, or on the node preset left external and
resolved from `node_modules`), and a stylesheet its server code links
(`import "./x.css"` in a server component, or `import href from "./x.css?url"`
for a document `<link>`): the stylesheet's hashed URL is in what the server
renders, so a change to the compiled CSS clears that app's cached data. A
`clientUrls()` module is client code that also tells the server what to run:
changing which loaders a route declares, its `loading` or its transition
counts as a server change; changing the components it renders does not. Under
a host router, apps are independent when the host mounts them lazily
(`.lazy(() => import(...))`); routers one module imports statically share
that module's code.

The key families: `CFCacheStore` keys segment entries and `fn:` items with the
data version and `doc:` responses and `shell2:` shells with the document
version. `VercelCacheStore` does the same by default (families `s`, `i` data;
`r`, `h` document). `MemorySegmentCacheStore` has no version; the process is its
scope.

Tag invalidation markers are stored without a version, so `updateTag()` and
`revalidateTag()` apply to entries of every version, including a version that
comes back in a rollback.

- **Force a clear:** change `version` (`createRouter({ version })`,
  `createRSCHandler({ version })`, `new CFCacheStore({ version })` or
  `new VercelCacheStore({ version })` all use that exact value for both
  versions), or invalidate tags.
- **Keep the old "every deploy clears the cache" behavior:** set `version` to a
  per-deploy value (a build id), or on Vercel keep a deployment-scoped
  `getCache({ namespace: process.env.VERCEL_DEPLOYMENT_ID })`.
- **Separate environments:** two deployments built from the same code have the
  same versions. If they share a store (the same KV namespace), they share
  entries. Give each environment its own KV namespace or cache namespace, or its
  own `version`.

Two things give a router a new version on every build, and with it a cold
cache on every deploy:

- **No stable encryption key.** The key that encrypts inline server-action
  bound arguments is part of the version of every router whose code encrypts
  with it. Pass `rango({ encryptionKey: process.env.RANGO_ENCRYPTION_KEY })`
  (see `/use-cache`); the build prints a note when a router needs it.
- **A `Prerender` or `Static()` handler whose output differs per build**: a
  timestamp, a random id, or an inline action with bound arguments rendered at
  build time (its arguments are encrypted with a random IV, stable key or not).
- **An import the server build leaves external and cannot read**: a package
  that is not in `node_modules` at build time, a path that does not resolve, a
  URL. The build names it.

Every build prints each router's versions and writes what they were computed
from to `node_modules/.rangojs-router-build/cache-versions.json`. Diff that
file between two builds to see which chunk or payload moved a version; its
`unownedFiles` lists the server files in no router's version (the host entry
of lazily mounted apps), where a change keeps every app's cache.

A custom persistent store keys the same way with `getCacheVersions()` from
`@rangojs/router/cache`, called per operation inside the request: `data` for
segment entries and items, `document` for responses and shells, no version on
its tag-invalidation records. See `/caching` for store setup.

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
a `cache()` boundary or a `"use cache"` function throws — the guard against the
catastrophic "serve user A's data to user B" bug. The guarantee is precise and
intentionally narrow — see "Context Variable Cache Safety" below for exactly
what it does and does not catch.

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

SWR softens normal TTL expiry, **not** a version change — a deploy that changes
a router's code reads under a new version and has no stale entry to serve (see
version-segmented store keys above).

Store support is layer-specific. `CFCacheStore` and `VercelCacheStore` support
SWR for segment, document/response, item (`"use cache"` and cached loaders), and
PPR shell entries. `MemorySegmentCacheStore` supports SWR for response, item,
and shell entries, but its route-segment entries expire at `ttl` (the `swr`
window is dropped) and never background-revalidate. Use the memory store for
local/dev behavior, not as proof that segment SWR is active.

## Key Differences

|                      | `cache()` DSL                                         | `"use cache"` directive                                                             |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Scope**            | Route segment tree (handler + children + parallels)   | Single function return value                                                        |
| **Defined at**       | Route definition site (`urls.ts`)                     | Inside function body or at file top                                                 |
| **Cache key**        | Request type + host + pathname + params + search      | Function identity + serialized non-tainted args                                     |
| **Execution on hit** | All-or-nothing: entire handler skipped                | Partial: function body skipped, calling code runs                                   |
| **Runtime control**  | `condition` to disable, custom `key` function         | None — if the directive is present, it caches                                       |
| **Side effects**     | Response side effects throw inside the boundary       | `ctx.headers.set()`, `ctx.set()`, etc. throw                                        |
| **Handle data**      | Handler pushes replayed; loader pushes re-run live    | Captured and replayed when it receives `ctx`                                        |
| **Loaders**          | Always fresh — excluded from cache, opt-in per loader | Can be used inside loaders                                                          |
| **Nesting**          | Inner TTLs override; `key()` partitions compose       | Compose by calling cached functions from uncached; inner tags reach the outer entry |

### cache() Cache Key

The default key is `{requestType}:{host}{pathname}[:params][?search]`, where
requestType is `doc`, `partial`, or `intercept`. The same URL is therefore cached
separately for full document loads, client navigations, and intercept
navigations. The host keeps tenants apart when one deployment serves several
domains; the search part is sorted, excludes the router's internal params, and
honors `createRouter({ cache: { searchParams } })`.

A custom `key` function replaces the whole default key (e.g., to key by user role
or locale); it also bypasses the store's `keyGenerator` and the search-param
filter. It runs once per request and may read `cookies()`. Its result is
stored namespaced (`key:` plus its URI encoding), so no value it returns, raw
request input included, names another route's record. A nested `cache()`
keys its records within the enclosing `key()` partition (`/caching` → "Keys
nest"). Normalize the result to the values you serve: each distinct value is
a record. On a `ppr` route, `key()` (and a store `keyGenerator` that returns
a non-default key) also partitions the shell: one shell per value, and a
partitioned request never reads a build-time shell. Keep the values to a
small set. `condition` can disable caching entirely at runtime (e.g., skip
for authenticated users), for every `cache()` nested under it too, and an
outer `cache()`'s `tags` tag the nested records (`/caching` → "Conditions
and tags inherit").

### "use cache" Cache Key

The key is `use-cache:{functionId}:{serializedArgs}` where functionId is a stable
ID from the Vite transform (module path + export name) and args are serialized
(stable JSON when every arg is JSON-safe, RSC `encodeReply()` otherwise).
Request-scoped arguments are excluded: route fields read off `ctx` (handler,
loader or middleware: host, route name, pathname, params, search) and a
`Request`'s URL are folded in, and `env`
is left out. React element slots stay out of the key; any other argument that
cannot be serialized (a function, a class instance) runs the call uncached. See
`/use-cache`.

## Execution Model

This is the most important distinction.

### cache() — all-or-nothing

On cache hit, the cache-lookup middleware short-circuits segment resolution for
the boundary: no handler inside it runs. Segments above the boundary are not in
the entry and resolve as on an uncached render. On miss, all handlers execute
normally and the boundary's segments are stored.

```
HIT  → segments above the boundary resolved, cached segments served, loaders resolved fresh, no handler in the boundary runs
MISS → all handlers run, the boundary's segments cached, response built normally
```

`ctx.set()` calls are safe: every handler that could read the value is inside the
same cached unit, so a hit replays a consistent subtree. Response side effects
and request-scoped reads are not safe — a write would reach only MISS responses
and a `cookies()` read would be baked into the shared entry — so the boundary
guard throws on them even on a miss (see "Correctness & invalidation" above and
"Headers and Cookies" below).

### "use cache" — partial execution

Only the wrapped function body is skipped on hit. The code that calls the
cached function still runs. This means ctx side effects inside the cached body
would silently disappear on hit.

```
HIT  → function body skipped, calling code runs, handle data replayed
MISS → function body runs, return value + handle data cached
```

Runtime guards throw if you call `cookies()`, `headers()`, `ctx.set()`,
`ctx.headers.set()` (or any response write: cookie writes, `setStatus()`,
`onResponse()`), `ctx.setTheme()`, or `ctx.setLocationState()`, or read
`ctx.request.headers`, inside a `"use cache"` function. `cookies()`,
`headers()` and `ctx.request.headers` are blocked because
per-request data is not in the cache key. Side-effect methods are blocked because
their effects are lost on hit. Use `ctx.use(Handle)` instead for data — handle
data is captured and replayed.

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

On a `ppr` route, `cache(false)` or a `condition()` that returns false also
means no shell: that route (or that request) renders like a cache miss, with
no shell served or captured. A `ppr` route cannot opt out of a layout's
`cache()` and still get a shell.

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

// Handler calls cached function, sets headers outside it
// (this route is not inside a cache() boundary or a ppr route)
async function ProductPage(ctx) {
  const data = await getProductData(ctx.params.slug);
  ctx.headers.set("X-Product", data.id);
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
enclosing segment, put it in a loader** read with `useLoader()` (without
`ssr: false` on a `ppr` route). `debugPerformance` prints cache hits per
layer, so the actual per-request behavior is observable.

Keys and tags cross the nesting too:

- An inner `cache()` without `key` keys its records within the outer `key()`
  partition; one with its own `key` composes both (`/caching` → "Keys nest").
- Tags that `cacheTag()` calls and `"use cache"` reads record inside a
  `cache()` subtree are stored on that `cache()` entry, so `updateTag()` of one
  of them evicts it (and a `ppr` shell or document built from it) instead of
  waiting for it to expire.
- A `ppr` shell never outlives the route `cache()` entry it was captured
  from: its ttl and ttl + swr are capped to what that entry has left.

## Headers and Cookies

Neither mechanism caches response headers or cookies.

- **cache()**: Response-level side effects throw inside the cache boundary even
  on a miss: `ctx.headers` mutation (`ctx.headers.set()` etc.), `cookies()`
  (read or write), and the request-context writers `header()`, `setCookie()`,
  `deleteCookie()`, `setStatus()`, `onResponse()`. On a hit the handler would be
  skipped, so allowing the write on a miss would produce inconsistent responses.
  Registered loaders are exempt (they run on every request, hits included). If
  you need headers or cookies on every response, set them in middleware, a live
  segment outside the cache boundary, or a loader.
- **"use cache"**: `cookies()` and `headers()` throw inside the cached function
  (both reads and writes), and so do `ctx.request.headers` reads and
  `ctx.headers` mutations. Move them outside.
- **`ctx.theme`** (handler and middleware) and **`getRequestContext().theme`**
  are the visitor's theme cookie, so a read throws in both scopes, like
  `cookies()`. Read it with `useTheme()` in a client component, or in a
  loader (see the `/theme` skill).

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
**directly** with `ctx.get()` inside a `cache()` boundary or a `"use cache"`
function — where the value would otherwise be serialized into the stored
segment or entry without being part of its key.

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

| Operation                                                            | Inside a `cache()` boundary                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `cookies()` / `headers()` (read or write)                            | Throws (request-scoped, would poison the shared entry)                             |
| `ctx.request.headers`, `getRequestContext().cookie()` / `.cookies()` | Throws, like `headers()` / `cookies()` (#976)                                      |
| `ctx.theme`, `getRequestContext().theme`                             | Throws, like `cookies()` (#971)                                                    |
| `ctx.get(cacheableVar)`                                              | Allowed                                                                            |
| `ctx.get(nonCacheableVar)`                                           | Throws (would be baked in)                                                         |
| `ctx.set(var, value)` (cacheable)                                    | Allowed                                                                            |
| `ctx.headers.set()` / cookie writes                                  | Throws (response side effect would be lost on hit)                                 |
| Any of the above **inside a loader**                                 | Allowed (loaders always run fresh)                                                 |
| The reads above in a loader with its own `cache()`                   | The miss fails without a `key()`; any `key()` allows them, so it must include them |

(Both scopes block the same request-scoped APIs — `cookies()`, `headers()`,
response side effects, and non-cacheable `ctx.get()` — because each would leak
per-request data into a shared cache entry. The `cache()` boundary tracks the
scope via `isInsideCacheScope()`; `"use cache"` uses the exec guard and also
excludes tainted `ctx`/`env`/`req` args from the cache key. Loaders are exempt
under `cache()` — see "Headers and Cookies" and the precise guarantee below.
Under `"use cache"` nothing is exempt: a loader body the cached function
consumes (`await ctx.use(Loader)`) is part of the cached result, and a cached
function a loader calls does not re-run with the loader.)

Write is dumb — `ctx.set()` stores the cache metadata but does not enforce.
Enforcement happens at read time (`ctx.get()`), where ALS detects the cache
scope and rejects non-cacheable reads.

### The guarantee is precise — a direct read inside a cache scope, not propagating

The guard fires on a **direct** `ctx.get(taintedVar)` **inside a `cache()`
boundary** (the scope `isInsideCacheScope` detects) **or a `"use cache"`
function body**. The taint lives on the
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
on the hot path), and it is scoped to the `cache()` segment boundary and the
`"use cache"` body. `"use cache"` functions block the same request-scoped reads
(`cookies()` / `headers()`, `ctx.request.headers` and non-cacheable `ctx.get()` throw inside them) and
additionally exclude tainted `ctx`/`env`/`req` args from the cache key — pass a
non-cacheable value in as an argument so it becomes part of the key. The pattern that stays safe is also the natural one:
**read tainted context at the point of use, in the path that needs it (a loader or
live segment) — never extract user data into a plain value and cache that.**
Loaders are exempt from the `cache()` guard because they run outside the cache
scope and resolve fresh every request. A loader with its own `cache()` does not:
its value is stored, so it falls under the loader `cache()` guard above. Nor
does a loader awaited inside a `"use cache"` body: its value is part of what the
function returns, so the same reads throw there, whether the cached function
starts the loader or reads a value a handler or a `loader()` binding already
started.

## Loaders Are Always Fresh

Loaders are **never cached** by route-level `cache()`. Even on a cache hit
where the boundary's UI segments are served from cache, loaders are re-resolved
fresh on every request. This is enforced at two levels:

1. **Storage**: `cacheRoute()` filters out loader segments before serialization.
2. **Retrieval**: On cache hit, `resolveLoadersOnly()` runs the boundary's
   loaders after yielding its cached UI segments (the loaders above the boundary
   run with their live segments), ensuring fresh data regardless of cache state.

This means `cache()` gives you cached UI + fresh data by default, where the
data is read outside the cached output: `useLoader()` in a client component.
A handler inside the boundary that awaits `ctx.use(Loader)` renders the value
it got on the miss, and every hit replays that output. On a `ppr` route an
`ssr: false` loader is the other exception: it bakes into the shell (`/ppr`).
To also cache a loader's data, explicitly opt in with
`loader(Fn, () => [cache({...})])`.
That entry is keyed by loader, host, path and params, not by the route's
`key()`, so give it a `key()` that includes any request data its body reads;
without one the miss fails.

## cache() Placement Patterns

### cache() among a path's children

A `cache()` among a path's children caches that path. The path's handler and
its own layouts and parallels are one cached unit, wherever the `cache()` sits
in the list. Every other item still attaches to the path, and the segments
above the path stay live:

```typescript
path("/dashboard", DashboardPage, { name: "dashboard" }, () => [
  cache({ ttl: 300 }),
  layout(DashboardSidebar, () => [
    parallel("@stats", StatsPanel),
    parallel("@activity", ActivityFeed),
  ]),
  loader(DashboardLoader),
]),
```

On hit: DashboardPage, DashboardSidebar, StatsPanel, and ActivityFeed are all
served from cache, and DashboardLoader runs fresh. On miss: all handlers run and
the path's segments are cached together. DashboardPage runs inside the boundary,
so the guards apply to it: a header write there throws. The wrapper form
`cache({ ttl: 300 }, () => [layout(DashboardSidebar)])` inside a path does the
same, and `cache(false)` there opts the path out of an enclosing `cache()` (on a
`ppr` route, out of the shell too). The same form caches a response route:
`path.json("/api/feed", handler, { name: "feed" }, () => [cache({ ttl: 60 })])`.
A `cache()` inside a `layout()` or `middleware()` wrapper in the path caches the
path too: `layout(DashboardSidebar, () => [cache({ ttl: 300 })])` is the same
unit as the example above, not the sidebar alone.

### Bare cache() among a layout's children

A `cache()` with no children callback covers the routes after it. The
`layout()`, `parallel()`, `loader()` and `middleware()` items after it still
wrap every route of the layout, including the routes before the `cache()`;
they are cached only with the routes after it:

```typescript
layout(<AppShell />, () => [
  path("/a", PageA, { name: "a" }), // PromoBanner renders live on /a
  cache({ ttl: 60 }),
  layout(<PromoBanner />),
  path("/b", PageB, { name: "b" }), // PromoBanner cached with /b
]),
```

With no route after the `cache()`, nothing is cached. To cache
`<PromoBanner />` with PageA too, put the `cache()` before PageA's `path()`.
A `cache()` among PageA's own children does not cover it: the banner belongs
to the layout, above that path's boundary.

### Uncached layout with cached children

The cache boundary only covers what's inside it. Parent segments above the
boundary are not cached and always re-render, cache hits included:

```typescript
layout(RootLayout, () => [
  // RootLayout is NOT cached — runs every request
  cache({ ttl: 300 }, () => [
    path("/products/:slug", ProductPage, { name: "product" }, () => [
      parallel("@reviews", ReviewsPanel),
      parallel("@related", RelatedProducts),
    ]),
  ]),
]),
```

RootLayout renders fresh every request, and a header it writes lands on every
response. ProductPage, ReviewsPanel, and RelatedProducts are inside the cache
boundary and served from cache on hit. This is useful when the root layout
depends on request-specific data (user session, theme) but the product content
is cacheable. On a `ppr` route the shell bakes RootLayout too: a shell HIT runs
no layout, and the shell expires no later than this `cache()` entry.

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
data is cached independently from the route's segment cache, together with
the handle pushes its body made (replayed on every hit). Loader caching
supports custom keys, tags, SWR, conditional bypass, and per-loader store
overrides — see `/loader` for the full reference. A body that reads
`cookies()`, `headers()`, `ctx.request.headers` or a non-cacheable variable needs a `key()`, which
must include the value: without one the miss fails, and any `key()` switches
that check off. The entry also carries the tags its body recorded
(`cacheTag()` calls, `"use cache"` reads, and those of the loaders it reads
with `ctx.use()`), so `updateTag()` of any of them drops it.

## See Also

- `/caching` — cache() DSL setup, stores, tags, nested boundaries
- `/use-cache` — "use cache" directive details, profiles, transforms, guards
- `/loader` — loader-level caching and the loader context
- `/prerender` — build-time segments with `Prerender()`/`Static()`
- `/ppr` — PPR shell caching: cached HTML shell + live holes (different layer)
- `/document-cache` — store-backed complete-response middleware
- `/deployment-caching` — in-function versus external CDN cache boundaries
