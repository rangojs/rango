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
- Profiles are scoped per router: each `createRouter()` instance resolves profiles from its own `cacheProfiles` config via request context, with a global fallback for backwards compatibility.

## Cache Key

```
use-cache:{functionId}:{serializedArgs}
```

- `functionId` -- stable ID assigned at build time by the Vite transform (module path + export name).
- `serializedArgs` -- function arguments serialized via RSC `encodeReply()`. Falls back to stable JSON stringification when RSC APIs are unavailable.

### Tainted arguments

Request-scoped objects (`ctx`, `env`, `req`) are branded with a taint symbol (`Symbol.for('rango:nocache')`) at creation time in `createContext()`.

When `registerCachedFunction` detects a tainted argument:

1. **Extract route-scoping dimensions into the cache key** -- `pathname`, sorted `params`, `_responseType`, and normalized user-facing search params (excluding internal `_rsc*`/`__*` params) are included so different routes, param combinations, and query variants produce distinct cache entries.
2. **Cache handle data alongside the return value** -- on miss, capture side effects (breadcrumbs, metadata) via a reentrant save/restore capture on `HandleStore.push`. Nested cached function calls capture/restore correctly in LIFO order.
3. **Replay handle data on hit** -- restore via `restoreHandles()` into the current request's `HandleStore`.

This means handlers that call `ctx.breadcrumb()`, `ctx.set()`, etc. work correctly with `"use cache"`. Side effects are captured and replayed, same as the existing `cache()` DSL and `Static()` handler.

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

- Primary: RSC Flight protocol (`renderToReadableStream` / `createFromReadableStream`). Handles JSX, client references, Promises, plain data.
- Fallback: JSON (when RSC APIs unavailable, e.g. tests).
- Non-serializable results: skip caching, return uncached. No error.

### Dev mode

Shared cache is bypassed in development so HMR changes are immediately visible. Functions execute fresh every time. Cache-Control headers are still emitted for testing.

## Interaction with Existing Caching

| Mechanism                  | Granularity          | Side effects                     | When       |
| -------------------------- | -------------------- | -------------------------------- | ---------- |
| `cache()` DSL              | Route segment        | Captured via HandleStore         | Runtime    |
| `Static()` / `Prerender()` | Route segment        | Captured via HandleStore         | Build-time |
| `"use cache"`              | Function / component | Captured if tainted ctx detected | Runtime    |

All three write to the same `SegmentCacheStore`. Tag-based invalidation (`revalidateTag`) works across all mechanisms.

## Remaining / Future

- `"use cache: private"` variant for per-request in-memory caching (no shared store).
- Integration with tag-based invalidation API (`cacheTag()` inside `"use cache"` functions).
- Cache warming / pre-population strategies.
