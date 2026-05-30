---
name: use-cache
description: Function-level caching with "use cache" directive for RSC data functions and components
argument-hint: [profile-name]
---

# "use cache" Directive

Function-level caching for async server functions and RSC components. Caches
return values with TTL + stale-while-revalidate. Complementary to the route-level
`cache()` DSL and build-time `Static()`/`Prerender()`.

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

## Named Cache Profiles

Define profiles in createRouter. Profile names map to `"use cache: <name>"` and
`cache('<name>')` in the DSL.

```typescript
createRouter({
  cacheProfiles: {
    default: { ttl: 900, swr: 1800 },
    short: { ttl: 60, swr: 120 },
    long: { ttl: 3600, swr: 7200 },
    products: { ttl: 300, swr: 600, tags: ["products"] },
  },
});
```

- `"use cache"` (no name) resolves to `default`.
- `"use cache: short"` resolves to the `short` profile.
- Unknown profile names throw at runtime, on the first invocation of the cached
  function (the Vite transform does not validate names at build/boot). The error
  is actionable -- it names the missing profile and shows the `createRouter({
cacheProfiles: { ... } })` entry to add.

## Cache Key

```
use-cache:{functionId}:{serializedArgs}
```

- `functionId` -- stable ID from Vite transform (module path + export name).
- `serializedArgs` -- key-generating arguments serialized via RSC `encodeReply()`.

When there are no key-generating arguments, the key has no trailing colon -- it is
just `use-cache:{functionId}`.

Different functions always produce different cache keys, even for the same route.
This is important for intercepted routes -- the path handler and intercept handler
each have their own `functionId` and therefore their own cache entries.

### Route context is folded into the key

The tainted `ctx` object is excluded from arg serialization (see below), but
route-identifying fields read off it are extracted into `serializedArgs`:
`url.host`, route name (`_routeName`), `pathname`, `params`, response type
(`_responseType`), and the user-facing sorted search params (internal `_rsc*`/`__`
params excluded). The same cached function called with `ctx` on different routes,
param combinations, hosts, response types, or query variants therefore produces
distinct cache entries -- not one shared entry.

## Tainted Arguments (ctx, env, req)

Request-scoped objects are branded with `Symbol.for('rango:nocache')` at creation.
When detected:

1. **Excluded from cache key** -- request-scoped, not meaningful for keying.
   (The route-identifying fields read off `ctx` are still folded in -- see
   "Route context is folded into the key" above.)
2. **Handle data captured on miss** -- side effects via `ctx.use(Handle)` are recorded.
3. **Handle data replayed on hit** -- restored into the current request's HandleStore.

```typescript
export async function getProductData(ctx) {
  "use cache: short";
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Products", href: "/products" });
  return await db.query("SELECT * FROM products");
}
// On hit: return value restored, breadcrumb replayed.
```

## Request-Scoped Guards

### Read Guards

`cookies()` and `headers()` **throw** inside a `"use cache"` function because
per-request values (cookies, headers) are not reflected in the cache key. Without
this guard, one user's data would be served to another.

Extract the value before the cached function and pass it as an argument:

```typescript
const locale = cookies().get("locale")?.value ?? "en";
const data = await getCachedData(locale); // locale is now in the cache key
```

### Side-Effect Guards

These ctx methods **throw** inside a `"use cache"` function because their effects
are lost on cache hit (the function body is skipped):

- `ctx.set()` for passing values to children
- `ctx.header()`
- `ctx.setTheme()`
- `ctx.setLocationState()`
- `ctx.onResponse()`

`ctx.get()` is **not** exec-guarded inside `"use cache"` -- it is a read, so it is
safe. (It only throws when reading a non-cacheable variable inside the separate
route-level `cache()` DSL boundary.)

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

On stale hit, stale data is returned immediately. Background revalidation (re-execute

- store) runs entirely inside `waitUntil`.

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

## Vite Transform

The `rango:use-cache` Vite plugin detects the directive and wraps exports with
`registerCachedFunction()`:

```typescript
// Input
"use cache"
export async function getProducts() { ... }

// Output
import { registerCachedFunction } from '@rangojs/router/cache-runtime';
export const getProducts = registerCachedFunction(
  async function getProducts() { ... },
  "src/data/products.ts#getProducts",
  "default"
);
```

Function-level directives are hoisted:

```typescript
// Input
export async function getProducts() {
  "use cache: short";
  return await db.query("...");
}

// Output
const __rango_cached_getProducts = registerCachedFunction(
  async function getProducts() {
    return await db.query("...");
  },
  "src/data/products.ts#getProducts",
  "short",
);
export async function getProducts() {
  return __rango_cached_getProducts();
}
```

## Backing Store

Writes to the same `SegmentCacheStore` as `cache()` DSL, `Static()`, and `Prerender()`.
One store, one configuration.

Cache entries (and `cacheProfiles`) accept an optional `tags` field, but the
built-in stores (`MemorySegmentCacheStore`, `CFCacheStore`) do not yet index or
invalidate by tag -- tags are passed through to the store and otherwise ignored.
Tag-based invalidation (`revalidateTag`) is a forward-looking API that requires a
custom store with secondary indices. Today entries expire by TTL/SWR. The separate
`revalidate()` export is the client-update axis (which segments re-render on a
navigation or action), not a cache bust.

## Interaction with Other Caching

| Mechanism          | Granularity        | When       | Use case                                        |
| ------------------ | ------------------ | ---------- | ----------------------------------------------- |
| `"use cache"`      | Function/component | Runtime    | Cache individual data fetches or components     |
| `cache()` DSL      | Route segment      | Runtime    | Cache entire route subtrees with children       |
| `cache('profile')` | Route segment      | Runtime    | Same as cache() with a named profile            |
| `Static()`         | Route segment      | Build-time | Render once, never re-render                    |
| `Prerender()`      | Route segment      | Build-time | Pre-render known params, optional live fallback |

## Dev Mode

In development, the Vite transform still wraps functions, but the cache store is
a `MemorySegmentCacheStore` that works locally. Functions cache normally in dev
for testing cache behavior.
