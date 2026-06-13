# `"use cache"` API Design

## Overview

`"use cache"` is a function/component-level caching directive for RSC. It caches the return value of async server functions and RSC components. The router does not need to understand `"use cache"` -- it operates below the router at the function/component level.

This is complementary to the existing `cache()` DSL (route-segment-level) and `Static()`/`Prerender()` (build-time caching). All three share the same backing `SegmentCacheStore`.

## Directive Syntax

### File-level (default profile, applies to all exports)

```ts
"use cache";

export async function getProducts() {
  return await db.query("SELECT * FROM products");
}

export async function getCategories() {
  return await db.query("SELECT * FROM categories");
}
```

### Function-level (named profile per function)

```ts
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

```ts
export async function ProductCard({ id }: { id: string }) {
  "use cache: products"
  const product = await db.query('SELECT * FROM products WHERE id = ?', [id]);
  return <div>{product.name}</div>;
}
```

## Named Cache Profiles

Profiles are defined centrally in the router config. A profile specifies TTL, SWR window, and optional default tags.

```ts
createRouter({
  cacheProfiles: {
    default: { ttl: 900, swr: 1800 },
    short: { ttl: 60, swr: 120 },
    long: { ttl: 3600, swr: 7200 },
    products: { ttl: 300, swr: 600, tags: ["products"] },
  },
});
```

- `"use cache"` (no name) resolves to the `default` profile.
- `"use cache: <name>"` resolves to the named profile. Names must match `[a-zA-Z0-9_-]+`.
- Unknown profile names throw at runtime with an actionable error message.
- Profiles are scoped per router: at DSL-time, `cache("profileName")` reads from `HelperContext.cacheProfiles` (set by `createRouter()` and propagated through `RangoContext.run()`). At request-time, `registerCachedFunction` resolves from `requestCtx._cacheProfiles` (set per-request by the active router). There is no global fallback.

## Cache Key

```
use-cache:{functionId}:{serializedArgs}
```

- `functionId` -- stable ID assigned at build time by the Vite transform (module path + export name).
- `serializedArgs` -- function arguments serialized via RSC `encodeReply()`. If the arguments cannot be encoded, the call runs uncached (no key is generated, the function still executes); there is no JSON fallback.

### Tainted arguments

Request-scoped objects (`ctx`, `env`, `req`) are branded with a taint symbol (`Symbol.for('rango:nocache')`) at creation time in `createRequestContext()` (and the analogous handler/response-route context constructors).

When `registerCachedFunction` detects a tainted argument:

1. **Extract route-scoping dimensions into the cache key** -- the url `host` (cross-host collision guard on shared stores), the route name (`_routeName`, cross-route reuse guard when the same cached function is reused across routes with identical pathname/params but a different `reverse()` scope), `pathname`, sorted `params`, `_responseType`, and normalized user-facing search params (excluding internal `_rsc*`/`__*` params) are included so different hosts, routes, param combinations, and query variants produce distinct cache entries.
2. **Cache handle data alongside the return value** -- on miss, capture side effects (breadcrumbs, metadata) via a single `HandleStore.push` interceptor installed once per store; each push fans out to a `Set` of active capture tokens. Overlapping/nested captures are independent and may stop in any order (no LIFO requirement).
3. **Replay handle data on hit** -- restore via `restoreHandles()` into the current request's `HandleStore`.

This means handle-style metadata side effects such as `ctx.breadcrumb()` work
correctly with `"use cache"` and are captured/replayed on cache hit.

Request-scoped reads and response/render mutations are different:

- `cookies()` and `headers()` are forbidden inside `"use cache"` because their
  values vary per request but are not reflected in the shared cache key.
- `ctx.set()`, `ctx.header()`, `ctx.setStatus()`, `ctx.setTheme()`,
  `ctx.setLocationState()`, and similar request/response mutations are
  forbidden inside `"use cache"`.

For caching full route behavior, including request-scoped rendering semantics,
use the route-level `cache()` DSL instead.

```ts
export const handle = createHandle(({ ctx }) => {
  "use cache: short";
  ctx.breadcrumb("Products");
  return await getExpensiveData();
});
// On cache hit: return value restored, breadcrumb replayed.
```

## Backing Store

`"use cache"` writes to the same `SegmentCacheStore` that `cache()` DSL, `Static()`, and `Prerender()` use. One store, one configuration, one invalidation API.

- Development: `MemorySegmentCacheStore`
- Production (Cloudflare): `CFCacheStore` (Cache API)
- Future: KV, Redis, etc.

## Build-Time: Vite Transform

A Vite plugin (`rango:use-cache`) detects the directive and wraps exports.

Uses existing helpers from `@vitejs/plugin-rsc/transforms`:

- `hasDirective()` / `findDirectives()` -- detect `"use cache"` in source
- `transformWrapExport()` -- wrap file-level exports
- `transformHoistInlineDirective()` -- hoist function-level directives

### File-level transform

```ts
// Input
"use cache"
export async function getProducts() { ... }

// Output
import { registerCachedFunction } from '@rangojs/router/cache-runtime';
/* "use cache" -- wrapped by rango */
export const getProducts = registerCachedFunction(
  async function getProducts() { ... },
  "src/data/products.ts#getProducts",
  "default"
);
```

### Function-level transform

```ts
// Input
export async function getProducts() {
  "use cache: short";
  return await db.query("...");
}

// Output (function hoisted and wrapped)
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

## Runtime: `registerCachedFunction`

```ts
registerCachedFunction(fn, id, profileName);
```

1. Receive call with `args`.
2. Check args for tainted objects. If found, strip from key, enable handle capture mode.
3. Generate cache key: `use-cache:{id}:{encodeReply(nonTaintedArgs)}`.
4. Look up in `SegmentCacheStore.get(key)`.
5. **Hit (fresh)**: deserialize value via `createFromReadableStream()`, replay handle data if present, return.
6. **Hit (stale)**: return stale value, trigger background revalidation via `waitUntil()`.
7. **Miss**: execute `fn(...args)`, serialize result via `renderToReadableStream()`, capture handles if tainted args present, store in cache, return.

### Serialization

- Serialization: RSC Flight protocol (`renderToReadableStream` / `createFromReadableStream`). Handles JSX, client references, Promises, plain data.
- Non-serializable results: skip caching, return uncached. No error. `serializeResult()` returns `null` and the caller gates the write on `serialized !== null`. There is no JSON fallback path.

### Dev mode

Caching is active in development (backed by `MemorySegmentCacheStore`). This matches production behavior and allows testing cache semantics locally. HMR invalidates the in-memory store so code changes take effect immediately.

## Interaction with Existing Caching

| Mechanism                  | Granularity          | Side effects                                                                | When       |
| -------------------------- | -------------------- | --------------------------------------------------------------------------- | ---------- |
| `cache()` DSL              | Route segment        | Captured via HandleStore                                                    | Runtime    |
| `Static()` / `Prerender()` | Route segment        | Captured via HandleStore                                                    | Build-time |
| `"use cache"`              | Function / component | Handle data captured/replayed; request-scoped reads and mutations forbidden | Runtime    |

All three write to the same `SegmentCacheStore`.

**Tags**: `CacheProfile.tags`, `CacheOptions.tags`, and runtime `cacheTag(...tags)` inside a `"use cache"` function all tag the stored entry. The built-in `MemorySegmentCacheStore` and `CFCacheStore` index by tag. Invalidate with `updateTag(...tags)` (awaitable, read-your-own-writes; server actions) or `revalidateTag(...tags)` (background, non-blocking; route handlers/webhooks). Both hard-purge — the only difference is awaitability; neither serves stale. For `CFCacheStore` the markers live in its own KV namespace.

## Remaining / Future

- `"use cache: private"` variant for per-request in-memory caching (no shared store).
- Cache warming / pre-population strategies.

Tag-based invalidation (`cacheTag`/`updateTag`/`revalidateTag`) is shipped — see
the **Tags** note above.
