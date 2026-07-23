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

File-level `"use cache"` wraps **only exports the transform can statically confirm are functions** -- an `export async function` declaration, or `export const f = async () => {}`. Any export it cannot confirm is a function is rejected at build:

```ts
"use cache";

export const VERSION = 1; // rejected: confirmed non-function
export const getUser = withCache(fetchUser); // rejected: factory/HOF, result not statically a function
export async function getData() {} // wrapped
```

The factory/HOF case is rejected **even though it returns a function at runtime**. A call-expression initializer is statically indeterminate -- the transform cannot tell `withCache(fetchUser)` (a function) from `loadConfig()` (an object) apart -- so it fails loud at build rather than wrapping a value that might break at call time. The remedy is to declare the export directly, push `"use cache"` into the function body (function-level), or move non-function exports to a separate module:

```ts
"use cache";

export async function getUser(id: string) {
  // wrapped
  return fetchUser(id);
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
- Profiles are scoped per router: `registerCachedFunction` resolves the profile name at request-time from `requestCtx._cacheProfiles` (set per-request by the active router via `createRequestContext()`). There is no global fallback. The same `cacheProfiles` map set by `createRouter()` is also propagated through `RangoContext.run()` for DSL-time route-segment cache resolution.

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

The file-level filter wraps only exports `transformWrapExport` reports as `isFunction === true`. That field is `boolean | undefined`: `true` (confirmed function), `false` (confirmed non-function), `undefined` (cannot tell statically, e.g. a factory call). The guard is `isFunction !== true`, so both `false` and `undefined` are rejected -- this is the deliberate "statically-confirmed functions only" policy above, not an oversight. Guarding on `=== false` instead would let a statically-indeterminate export through to be wrapped once `@vitejs/plugin-rsc` [#1246](https://github.com/vitejs/vite-plugin-react/pull/1246) makes that case report `undefined` rather than `false`.

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

### Inline server actions in cached modules (server-references manifest)

An inline `"use server"` action defined inside a `"use cache"` function (or any
module without a file-level `"use server"` directive) must still appear in the
production `virtual:vite-rsc/server-references` manifest so it can be resolved on
a cache HIT -- when the cached value is deserialized without executing the body
that would otherwise register the action in React's runtime registry.

plugin-rsc's multi-pass build drops such modules from the shared
`serverReferenceMetaMap`: the ssr scan deletes any module lacking a file-level
`"use server"`, and the rsc build emits the manifest (eagerly imported by the rsc
runtime, so it snapshots the map early) before the lazily-loaded route module is
re-added. The entry never lands in the manifest, and the route 500s with `server
reference not found` on a hit (dev and the cache MISS hide it -- the body runs
and self-registers).

`exposeActionId` (`src/vite/plugins/expose-action-id.ts`) works around this:
during the rsc scan it captures inline-action entries from
`serverReferenceMetaMap`, and at the real rsc build's `buildStart` (before the
manifest virtual module loads) it re-asserts them. This also makes deterministic
the ordinary inline-action modules that previously survived only by load-order
luck. Remove once the upstream plugin-rsc race is fixed.

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

## Embedding server actions in cached components

A cached function can return a component that creates an inline `"use server"`
action -- e.g. a cached article list whose rows each have a like button. The
contract, locked by `e2e/use-cache-inline-action.test.ts` (dev + production):

| Aspect                                       | Behavior                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Values the action closes over (render scope) | Frozen at cache-WRITE. The closure compiles to encrypted bound args (`encryptActionBoundArgs`) captured when the entry is written, replayed verbatim on a hit. Correct for stable identities (an article id); a hazard for volatile/request-scoped values.               |
| The action body                              | Runs live on every invocation. It is an ordinary server function once called: fresh computation, live request context. `cookies()`/`headers()` work in the body (it executes in the live request, not the cached one) -- the read guard applies only to the cached body. |
| Cache hit                                    | The action survives serialize -> store -> deserialize and stays invocable (see the manifest re-assertion note under Build-Time).                                                                                                                                         |

The freeze of captured scope is not a bug -- it is what makes a cached list with
per-item actions work (the item identity is meant to be fixed). The hazard is
capturing a per-request value (token, session, time) and expecting freshness;
read those live in the action body instead.

**Same-process vs cross-process hits.** This round-trips on a hit served by the
same process that wrote the entry (node/memory store): the cache miss executed
the function, registering the action in React's runtime registry, so the hit
resolves a re-serializable reference. A hit served from an entry populated by a
_different_ process (e.g. Cloudflare `CFCacheStore` across workers, or the first
hit after a deploy) instead resolves via the build manifest to a raw function
React refuses to re-serialize to a Client Component. Closing that gap needs
plugin-rsc `serverReferences: "preserve"` (PR #1246) on the cache deserialize.
The same `preserve` path is what lets `Static()`/`Prerender()` embed
server-created actions -- see `prerender-api-design.md`.

## Interaction with Existing Caching

| Mechanism                  | Granularity          | Side effects                                                                | When       |
| -------------------------- | -------------------- | --------------------------------------------------------------------------- | ---------- |
| `cache()` DSL              | Route segment        | Captured via HandleStore                                                    | Runtime    |
| `Static()` / `Prerender()` | Route segment        | Captured via HandleStore                                                    | Build-time |
| `"use cache"`              | Function / component | Handle data captured/replayed; request-scoped reads and mutations forbidden | Runtime    |

All three write to the same `SegmentCacheStore`.

**Tags**: `CacheProfile.tags`, `CacheOptions.tags`, and runtime `cacheTag(...tags)` all tag the stored entry. `cacheTag()` has two forms depending on what is active when it runs:

- Inside a `"use cache"` function it tags that cache entry (the default).
- Render-callable (no `"use cache"` scope active, but a request render is in progress) it records the tags onto the request's DOCUMENT artifact (`_requestTags`) instead of throwing. The PPR shell capture and the document cache middleware both collect `_requestTags`, so a plain server component can call `cacheTag("campaign:spring")` — with zero `cache()`/`"use cache"` in its tree — and `revalidateTag("campaign:spring")` will drop the shell / document it rendered into. Inside a `cache()` DSL segment the render-callable form records at the DOCUMENT level (only the `"use cache"` runtime enters the tag scope). With neither a scope nor a request context, `cacheTag()` throws.

The built-in `MemorySegmentCacheStore` and `CFCacheStore` index by tag. Invalidate with `updateTag(...tags)` (awaitable, read-your-own-writes; server actions) or `revalidateTag(...tags)` (background, non-blocking; route handlers/webhooks). Both hard-purge — the only difference is awaitability; neither serves stale. For `CFCacheStore` the markers live in its own KV namespace.

## Remaining / Future

- `"use cache: private"` variant for per-request in-memory caching (no shared store).
- Cache warming / pre-population strategies.

Tag-based invalidation (`cacheTag`/`updateTag`/`revalidateTag`) is shipped — see
the **Tags** note above.
