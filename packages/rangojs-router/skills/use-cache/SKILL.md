---
name: use-cache
description: Function-level caching with the "use cache" directive for RSC data functions and components in @rangojs/router. Use when a single function or component should memoize its own output, not a whole route/segment subtree or HTTP response.
argument-hint: [profile-name]
---

# "use cache" Directive

Function-level caching for async server functions and RSC components. Put the
directive in a function (or at the top of a module) and its return value is
cached with a TTL and a stale-while-revalidate window, keyed by its arguments.
Use it when one data fetch or one component is expensive and is reused across
routes or requests; the code around the call keeps running.

It complements the route-level `cache()` DSL (a whole segment subtree) and
build-time `Static()`/`Prerender()`. `"use cache"` needs an app-level store
(`createRouter({ cache })`); without one the function runs uncached.

## Not this skill if…

- You want to cache a whole route or a rendered subtree of segments — that is
  the segment-level `cache()` DSL: see `/caching`.
- You want a value fresh on every request — use a loader (see `/loader`).
- You are unsure which cache layer you need — start at `/cache-guide`.

## Basic Usage

### File-level (all exports cached with default profile)

```typescript
"use cache";

export async function getProducts() {
  return await db.query("SELECT * FROM products");
}

export async function getCategories() {
  return await db.query("SELECT * FROM categories");
}
```

### Function-level (per-function profile)

```typescript
export async function getProducts() {
  "use cache: short";
  return await db.query("SELECT * FROM products");
}

export async function getCategories() {
  "use cache: long";
  return await db.query("SELECT * FROM categories");
}
```

### RSC component

```typescript
export async function ProductCard({ id }: { id: string }) {
  "use cache: products"
  const product = await db.query('SELECT * FROM products WHERE id = ?', [id]);
  return <div>{product.name}</div>;
}
```

### Results that are not cached

A result Flight cannot encode cleanly is not cached: an async child component
that throws, a promise in the result or in a handle push that rejects, a
function or a class instance. Storing it would bake the failure into every hit
until expiry. Instead the write is skipped and reported to `onError` (phase
`"cache"`, category `cache-write`, or `stale-revalidation` for a background
refresh): a miss still returns the live result, the next call runs the
function again, and a stale entry keeps serving.

## Named Cache Profiles

Define profiles in createRouter. Profile names map to `"use cache: <name>"` in
the directive. The DSL `cache()` does not accept a string profile name; use an
options object (`cache({ ttl: 60 })`) or the `"use cache: <name>"` directive.

```typescript
createRouter({
  cacheProfiles: {
    default: { ttl: 900, swr: 1800 },
    short: { ttl: 60, swr: 120 },
    long: { ttl: 3600, swr: 7200 },
    products: { ttl: 300, swr: 600, tags: ["products"] },
    // Opt-in: a stale entry re-executes in the foreground during a server
    // action's revalidation render (fresh action response), instead of SWR.
    cms: { ttl: 300, swr: 600, foregroundOnAction: true },
  },
});
```

- `"use cache"` (no name) resolves to `default`.
- `"use cache: short"` resolves to the `short` profile.
- `foregroundOnAction: true` (default false): a stale entry serves stale +
  revalidates in the background on a plain navigation (SWR), but re-executes in
  the FOREGROUND during a server action's revalidation render so the action
  response reflects a fresh value (only the store write is deferred). Use it for
  mutation-related cached data; incidental TTL staleness on an ordinary action
  stays SWR so the action is not turned into a synchronous cache-refresh barrier.
  For strong read-your-own-writes after a mutation, prefer `updateTag()` (a hard
  purge, so the action's own re-render is a fresh foreground miss). Only
  `"use cache"` honors this flag; `cache()` boundaries and cached loaders ignore
  it.
- `default` is built in as `{ ttl: 900, swr: 1800 }`; defining `default`
  overrides it.
- Profile names must match `[a-zA-Z0-9_-]+`, and `ttl`/`swr` must be finite and
  non-negative; `createRouter()` throws otherwise.
- Unknown profile names throw at runtime, on the first invocation of the cached
  function (the Vite transform does not validate names at build/boot). The error
  names the missing profile and shows the `createRouter({ cacheProfiles })` entry
  to add.

## Cache Key

```
use-cache:{functionId}:{serializedArgs}
```

- `functionId` -- stable ID from Vite transform (module path + export name in
  dev, a hash of both in production builds).
- `serializedArgs` -- key-generating arguments: a stable JSON encoding when every
  argument is JSON-safe, otherwise serialized via RSC `encodeReply()`.

React elements (`header`, `children` slots) and client or server references
are left out of the key: the first call's rendered slot is part of the cached
output, and a hit returns it for any slot passed.

If any other argument cannot be serialized, top-level or nested (a function, a
class instance such as a database client, a symbol), the call runs uncached and
warns once per function in dev. Flight's encoder writes the same placeholder
for every such value, so keying on it would serve one caller's result to every
other caller. Pass the serializable values the function needs.

When there are no key-generating arguments, the key has no trailing colon -- it is
just `use-cache:{functionId}`.

Different functions always produce different cache keys, even for the same route.
This is important for intercepted routes -- the path handler and intercept handler
each have their own `functionId` and therefore their own cache entries.

The key is only what the function declares: its id and arguments. A call made
inside a route `cache()` with a `key()` does not inherit that key, so a value
the route partitions by (a tier header, a session) must be passed in as an
argument. The same holds for a loader's own `cache()` (`/loader` → "Cache Key").

### Route context is folded into the key

The tainted `ctx` object is excluded from arg serialization (see below), but
route-identifying fields read off it are extracted into `serializedArgs`:
the serving router's id and `url.host` (`{routerId}@{host}`), route name
(`_routeName`), `pathname`, `params`, response type (`_responseType`), and the
user-facing sorted search params (internal `_rsc*`/`__` params excluded). The
same cached function called with `ctx` on different routes, param combinations,
hosts, response types, or query variants therefore produces distinct cache
entries -- not one shared entry. Two routers that call it on one host and path
keep two entries as well: a `ctx` is one router's (`/host-router`, "Shared
cache store"). A bare `Request` argument folds in its URL only, so it names no
router.

## Request-Scoped Arguments (ctx, Request, env)

Three request-scoped arguments are kept out of the serialized arguments:

- **`ctx`** is branded with `Symbol.for('rango:nocache')` at creation. Its route
  fields are folded into the key, and its handle pushes are captured and
  replayed (below). Every ctx is branded: handler, loader, middleware,
  response-route and the request context. A loader ctx keys exactly like the
  handler ctx of the same request. A middleware ctx keys by host, pathname,
  its params and search, plus the route name once the route is matched (a
  global middleware before `next()` has none yet). A ctx carrying a request
  body (a fetchable loader called with `method: "POST"` and a `body` or form
  data) runs the call uncached and warns in dev: the body is not in the key.
  The method is not in the key either.
- **A `Request`** (such as `ctx.request`) keys by its URL: host, pathname and
  the user-facing sorted search params, with the same internal-param exclusion
  and `cache.searchParams` filter as the URL-keyed tiers. Headers, cookies and
  the method are not in the key; read what you need outside and pass the values.
- **The request's `env`** (the object `ctx.env` returns) is left out of the key:
  it is fixed per deployment. A binding passed on its own (`env.DB`) is a class
  instance and runs uncached; pass `env` instead.

When a `ctx` is detected:

1. **Excluded from cache key** -- request-scoped, not meaningful for keying.
   (The route-identifying fields read off `ctx` are still folded in -- see
   "Route context is folded into the key" above.)
2. **Handle data captured on miss** -- side effects via `ctx.use(Handle)` are recorded:
   the function's own pushes (and those of cached functions it calls), not the
   handler's or loaders' pushes into the same request.
3. **Handle data replayed on hit** -- appended to the calling segment (for a
   loader ctx, the segment that declares the loader), after what the handler
   and loaders already pushed, as if the body had run (a layout and its page
   calling the same function each get their copy). A
   stale hit's background refresh records its pushes into the refreshed entry only.
4. **A loader the function reads shows its pushes once** -- pushes from a loader
   read with `ctx.use(Loader)` inside the function are recorded under that
   loader. Loaders stay live, so if the handler or a DSL loader also reads it,
   that live run's pushes are the ones on the page: a live run before the hit
   makes the replay skip them, and one after it replaces the replayed values in
   place. A loader read only inside the function is replayed once, also when
   a layout and its page both call the function.

```typescript
export async function getProductData(ctx) {
  "use cache: short";
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Products", href: "/products" });
  return await db.query("SELECT * FROM products");
}
// On hit: return value restored, breadcrumb replayed.

export async function getProduct(ctx) {
  "use cache";
  const category = await ctx.use(CategoryLoader); // pushes a category crumb
  return db.product(ctx.params.id, category.id);
}
// Handler: `await getProduct(ctx); await ctx.use(CategoryLoader);`
// On hit: one category crumb, from the handler's live CategoryLoader run.

export const ProductLoader = createLoader(async (ctx) => getProduct(ctx));
// A loader ctx keys like the handler ctx: one entry per route, params and query.
```

## Request-Scoped Guards

### Read Guards

`cookies()` and `headers()` **throw** inside a `"use cache"` function because
per-request values (cookies, headers) are not reflected in the cache key. Without
this guard, one user's data would be served to another.

The raw reads throw the same way: `ctx.request.headers` on any `ctx` passed in
(handler, loader, middleware; it is one `Request` object, also
`getRequestContext().request`), and `getRequestContext().cookie()` /
`.cookies()`. A `ctx` or a `Request` argument keys the entry by its route and
URL only, never by its headers.

Extract the value before the cached function and pass it as an argument:

```typescript
const locale = cookies().get("locale")?.value ?? "en";
const data = await getCachedData(locale); // locale is now in the cache key

// the same for a header
const language = ctx.request.headers.get("accept-language") ?? "en";
const greeting = await getGreeting(language);
```

Building the key from a `Request` argument reads only its URL.
`ctx.request.clone()` is guarded like `ctx.request.headers`. One gap remains:
`fetch(ctx.request)` and `new Request(ctx.request)` don't throw, and the guard
can't see through them. The fetch forwards the visitor's `Cookie` and
`Authorization`, so its response is per visitor, and the copy's headers are
the visitor's; either one stored in the entry serves one visitor's data to
the next. Don't make them in a cached body: fetch outside and pass the
result in, or pass in the values the fetch depends on.

`ctx.get()` of a **non-cacheable variable** (`createVar({ cache: false })`, or
a value written with `ctx.set(key, value, { cache: false })`) throws the same
way, whether it goes through `getRequestContext().get()` or a `ctx` passed in
(handler, loader, middleware or response-route).
The key does not include the value, so the first caller's value would be
served to later callers. Read it before the call and pass it in:

```typescript
const Tenant = createVar<string>({ cache: false });

async function getNav(tenant: string) {
  "use cache";
  return loadNav(tenant); // tenant is part of the key
}

// in a handler or loader, outside the cached function
const nav = await getNav(ctx.get(Tenant)!);
```

Ordinary (cacheable) variables stay readable. Calling the cached function from
a loader does not exempt it: the loader re-runs on every request, but the
cached body does not.

A LOADER body consumed inside the cached function (`await ctx.use(loader)`)
is part of that body: its value is captured into the shared cache entry like
any other computed data, so a `{ cache: false }` variable read there throws,
exactly as `cookies()`, `headers()`, `ctx.request.headers` and a theme read do
(one guard follows the
cached body's whole async chain, loaders included). The order does not
matter: a loader something else in the request already started (a handler's
`ctx.use()`, the route's or a parent layout's `loader()`) returns its memoized
value, and `ctx.use()` (or `getRequestContext().use()`) inside the cached function rejects with the same error
when that run, or a loader it read, made such a read. A read the run makes
after its value settled (a nested promise in the value) fails the entry's
write instead: the caller gets its own value, nothing is stored, and `onError`
reports it. Read the value outside and pass it in as an argument. Handler/cached-scope consumption = baked copy,
client-side `useLoader` = live (the consumption-lane rule, `/rango` →
Invariants). Under a route `cache()` a loader body's reads stay allowed (the
route entry never stores a loader's value); during a PPR capture they refuse
the capture, a handler-consumed loader's included.

### Side-Effect Guards

These ctx methods **throw** inside a `"use cache"` function because their effects
are lost on cache hit (the function body is skipped):

- `ctx.set()` for passing values to children (handler and middleware ctx)
- `ctx.headers.set()` and the other mutating `Headers` methods (handler and
  middleware ctx), and a middleware's `ctx.header()`
- cookie writes and the request-context writers `header()`, `setCookie()`,
  `deleteCookie()`, `setStatus()`, `onResponse()`
- `ctx.setTheme()`
- `ctx.setLocationState()`

`ctx.get()` is a read, not a side effect: it stays allowed for ordinary
variables and throws only for a non-cacheable one (see "Read Guards" above).
The same non-cacheable read throws inside a route-level `cache()` boundary.

The error message recommends two alternatives:

1. Extract the data fetch into a separate cached function and call ctx methods outside it.
2. Use the route-level `cache()` DSL which caches all segments together.

**`ctx.use(Handle)` is NOT guarded** -- handle push is captured on miss and replayed
on hit. This is the correct way to pass data from cached functions.

### Pattern: Separate cached function from ctx side effects

```typescript
// Cached data fetch (pure)
async function getNavData() {
  "use cache: short"
  return await db.query('SELECT * FROM nav_items');
}

// Handler (uncached, calls ctx methods freely)
async function NavLayout(ctx) {
  const navData = await getNavData();
  ctx.set("navItems", navData);  // Works -- outside "use cache"
  return <Nav items={navData}><Outlet /></Nav>;
}
```

## Misuse Guards

### Cannot use as middleware

Cached functions cannot be passed to `middleware()`. Middleware runs on every
request (onion model) and must not be cached.

```typescript
// WRONG -- throws at boot time
middleware(cachedFn);

// RIGHT -- call cached function inside middleware
middleware(async (ctx, next) => {
  const data = await getCachedData();
  ctx.set("data", data);
  await next();
});
```

### Cannot use as Static() handler

Static handlers render once at build time. `"use cache"` is redundant.

```typescript
// WRONG -- throws at boot time
export const Page = Static(cachedFn);

// RIGHT -- remove "use cache", Static already caches
export const Page = Static(async (ctx) => {
  return <div>Built once</div>;
});
```

### Cannot use as Prerender() handler or getParams

Prerender handlers render at build time. `"use cache"` is redundant.

```typescript
// WRONG -- throws at boot time (handler)
export const Page = Prerender(getParams, cachedFn);

// WRONG -- throws at boot time (getParams)
export const Page = Prerender(cachedGetParams, handler);

// RIGHT -- remove "use cache"
export const Page = Prerender(
  async () => [{ slug: "a" }],
  async (ctx) => <Page slug={ctx.params.slug} />,
);
```

## Performance: waitUntil

On cache miss, the function executes and the result is serialized inline (blocking).
The cache **store write** (`setItem`) is deferred to `waitUntil` and does NOT block
the response.

On stale hit, stale data is returned immediately. Background revalidation
(re-execute + store write) runs entirely inside `waitUntil`.

| Phase                                | Blocks response? |
| ------------------------------------ | ---------------- |
| Function execution (miss)            | Yes              |
| Result serialization (miss)          | Yes              |
| Cache store write (miss)             | No (waitUntil)   |
| Stale value return (stale hit)       | No (immediate)   |
| Background revalidation (stale)      | No (waitUntil)   |
| Cache lookup + deserialization (hit) | Yes (fast)       |

## Using with Loaders

`"use cache"` works inside loaders. The loader runs every request, but the inner
cached function returns cached data:

```typescript
// Cached data function
export async function getProductData(slug: string) {
  "use cache";
  return await db.query("SELECT * FROM products WHERE slug = ?", [slug]);
}

// Loader runs every request, but inner call is cached
export const ProductLoader = createLoader(async (ctx) => {
  return getProductData(ctx.params.slug);
});
```

## Using with Intercepted Routes

Path handlers and intercept handlers have different `functionId` values from the
Vite transform, so they naturally get distinct cache entries even for the same URL:

```typescript
// Path handler -- cached separately
path("/product/:id", async (ctx) => {
  "use cache"
  return <FullProductPage id={ctx.params.id} />;
}),

// Intercept handler -- cached separately (different functionId)
intercept("@modal", ".product", async (ctx) => {
  "use cache"
  return <ProductModal id={ctx.params.id} />;
}),
```

## Embedding server actions in cached components

A cached function may return a component that creates an inline `"use server"`
action. The canonical case is a cached list whose items each carry an action --
e.g. a cached article list where every row has a like button:

```typescript
export async function ArticleList() {
  "use cache: articles";
  const articles = await db.query("SELECT id, title FROM articles");
  return (
    <ul>
      {articles.map((a) => {
        const articleId = a.id; // captured -> frozen with the cache entry
        async function like() {
          "use server";
          // runs live on click, in the CURRENT request scope
          const user = cookies().get("session")?.value;
          if (user) await db.like(articleId, user);
        }
        return <LikeButton key={a.id} title={a.title} action={like} />;
      })}
    </ul>
  );
}
```

Three behaviors, locked by `use-cache-inline-action.test.ts` (dev + prod):

| What                                            | Behavior                  | Why                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Values the action **closes over** (`articleId`) | **Frozen** at cache-write | The closure compiles to encrypted bound args, snapshotted when the entry is written and replayed verbatim on a hit. Correct for stable identities; wrong for volatile values. |
| The action **body**                             | **Runs live** every call  | Once invoked it is an ordinary server function: fresh computation and live request context. `cookies()` / `headers()` work here (the body executes in the live request).      |
| Invocability on a **cache hit**                 | **Works**                 | The action survives serialize -> cache -> deserialize and stays callable.                                                                                                     |

Rule of thumb: **capture stable identities, read volatile/request-scoped values
live in the body.** Do not close over a per-request token, the current user, or
the current time and expect freshness -- those are frozen at cache-write. The
`cookies()`/`headers()` read guard applies to the cached function body, NOT to an
inline action's body.

Deploy note: captured values are encrypted with a key that is generated per
build by default. Set a stable one in the plugin options:

```ts
rango({ encryptionKey: process.env.RANGO_ENCRYPTION_KEY });
```

The value is base64-encoded 32 bytes (`openssl rand -base64 32`), never a
literal, and is validated when `rango()` is called. `undefined` falls back to the
`RANGO_ENCRYPTION_KEY` environment variable, then to a key generated per build.
The key is part of the cache version of every router whose server code encrypts
inline server-action bound arguments, so without a stable key those routers get a
new version (and a cleared cache) on every build, and the build prints one note
when that applies. With a stable key, actions embedded in entries written by a
previous deploy still decrypt. A router that renders no inline action with bound
arguments keeps its cache without a stable key. See `/cache-guide`.

## Vite Transform

The `@rangojs/router:use-cache` Vite plugin (part of `rango()`) detects the directive and wraps each cached
function with `registerCachedFunction(fn, functionId, profileName)` from
`@rangojs/router/cache-runtime`. You never call it yourself. Simplified output:

```typescript
// Input (file-level directive)
"use cache";
export async function getProducts() { ... }

// Output (simplified)
import { registerCachedFunction } from "@rangojs/router/cache-runtime";
export const getProducts = registerCachedFunction(
  async function getProducts() { ... },
  "src/data/products.ts#getProducts", // a hash of this in production builds
  "default",
);
```

A function-level directive (`"use cache: short"` inside the body) is hoisted out
of the function and wrapped the same way, with the profile name from the
directive.

File-level rules:

- Only exports that are statically confirmed functions are wrapped
  (`export async function foo() {}`, `export const foo = async () => {}`). Any
  other export (a constant, or a factory call like `makeCached(fn)`) fails the
  build — move it to another module.
- The default export of a file named `layout.tsx` or `template.tsx` (any
  `.ts/.tsx/.js/.jsx` extension) is not wrapped: it receives `children`, which
  cannot be part of a cache key.
- Functions carrying their own `"use server"` directive are server actions, not
  cached functions, and are left alone.

## Backing Store

`"use cache"` reads and writes the app-level store from `createRouter({ cache })`
— the same store `cache()` boundaries and cached loaders use. One store, one
configuration. (`Static()`/`Prerender()` output is not in this store; it is
built into the server bundle, see `/prerender`.)

Entries are tagged by the profile's `tags` plus any runtime `cacheTag(...tags)`
calls in the function body. `cacheTag` has two forms: inside a `"use cache"`
function it tags that entry; called during a request render outside
`"use cache"` it tags what the render stores: the enclosing route `cache()`
entry, a cached loader's own entry when called in its body, and the `ppr`
shell or document-cache entry built from them (on a `ppr` route, only when
shell material calls it). See `/caching` → "Tag-Based Invalidation". All
built-in stores (`MemorySegmentCacheStore`, `CFCacheStore`,
`VercelCacheStore`) index by tag. Invalidate on demand with
`updateTag(...tags)` (awaitable; for server actions) or
`revalidateTag(...tags)` (background, non-blocking; for route
handlers/webhooks). Both evict rather than mark stale, and the request that
calls either reads its own writes; `updateTag()` also waits for the durable
write. PPR shell reads on `CFCacheStore`/`VercelCacheStore` go through
per-isolate memos, which the invalidating user skips via the fresh-reads
cookie. For `CFCacheStore`, cross-colo invalidation needs a `kv` namespace
(markers live in that same namespace) or `tagPurge`. The separate
`revalidate()` export is the client-update control (which segments re-render
on a navigation or action), not a cache bust.

A route `cache()` entry stores the tags of the `"use cache"` reads inside it,
so `updateTag()` of one evicts the enclosing entry and any `ppr` shell or
document built from it. A loader's own `cache()` entry does the same for the
reads in its body, and a `"use cache"` function for the `"use cache"`
functions it calls: the outer entry bakes the inner value, so it carries the
inner tags, whether the inner call ran, was a hit, or joined another call's execution. That includes calls made
by the server components a cached component returns, which render when the
value is stored.

```typescript
async function getStock(sku: string) {
  "use cache";
  cacheTag("stock");
  return db.stock(sku);
}

async function getProductCard(sku: string) {
  "use cache";
  return { sku, stock: await getStock(sku) };
}

// getProductCard's entry is tagged "stock": updateTag("stock") evicts both.
```

A call that started before `updateTag()`/`revalidateTag()` of one of its tags
returns what it read but does not store it, in any request: written after the
invalidation, the old value would be served as newer than it. The next call
runs the function again. The same holds for a stale entry's background
refresh, a loader's own `cache()`, route `cache()` entries and the document
cache. Another isolate's invalidation is caught through the store's markers:
`CFCacheStore` with KV, `VercelCacheStore`. On a KV-less `CFCacheStore` only
this isolate's invalidations are caught; ttl+swr bounds the rest.

## Interaction with Other Caching

| Mechanism        | Granularity        | When       | Use case                                              |
| ---------------- | ------------------ | ---------- | ----------------------------------------------------- |
| `"use cache"`    | Function/component | Runtime    | Cache individual data fetches or components           |
| loader `cache()` | One loader's data  | Runtime    | Cache a loader result while the page stays live       |
| `cache()` DSL    | Route segment tree | Runtime    | Cache entire route subtrees with children             |
| `ppr`            | HTML shell         | Runtime    | Serve a cached HTML shell, resume live holes (`/ppr`) |
| `Static()`       | One segment        | Build-time | Render once at build, no params                       |
| `Prerender()`    | Route segment tree | Build-time | Pre-render known params, optional live fallback       |

Inside a `ppr` shell, a `"use cache"` value that renders as shell material is
pinned at capture time for the life of that shell (see `/ppr` → Pitfalls). A
hole's own read (in a loader without `ssr: false` under `loading()` or an
inline `<Suspense>`) always returns the store's current entry, never the
shell's copy, even when a loader the capture ran read the same entry.

## Dev Mode and tests

The transform runs in dev exactly as in production, but caching only happens
when the router has a store: there is no implicit dev store. Configure one (a
`MemorySegmentCacheStore` is the usual dev/test choice) to see cache hits
locally.

With no item-capable store configured, a `"use cache"` function simply runs on
every call. The request-scoped guards (`cookies()`, `ctx.set()`, …) are not
active on that uncached path, so a guard violation only shows up once a store is
configured — test with a store. Under Vitest, `runLoader`, `renderHandler`, and
the other `@rangojs/router/testing` helpers take `{ cacheStore, cacheProfiles }`
and warn when a cached function ran without one (see `/testing`).
