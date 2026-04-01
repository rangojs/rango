# Pre-rendering Design

## Core Principle

Pre-rendering is **caching at build time**. The worker handles every request --
there are NO static .html or .rsc files served from assets. At runtime, the
worker looks up stored Flight payloads (serialized segments) and passes them to
the segment system, identical to a cache hit. The browser does not know if a
route was pre-rendered.

## Implementation Status

### Completed

- **Prerender handler** - `Prerender(getParams, handler, opts)` API
- **Build-time segment resolution** - `matchForPrerender()` resolves segments with BuildContext
- **Flight payload storage** - Serialized segments stored in lazily-loaded prerender manifest
- **Runtime cache-lookup** - Prerender store checked before segment resolution
- **Handler eviction** - All Prerender handlers stubbed in production bundles
- **Passthrough wrapper** - `Passthrough(prerenderDef, liveHandler)` provides a separate live handler for unknown params
- **ctx.passthrough()** - Build handler can skip a param set's artifact, deferring to the live handler
- **Sub-use semantics** - Child layouts, parallels inside path are pre-rendered
- **Handle data** - `ctx.use()` data baked into Flight payloads
- **Loader freshness** - Loaders always run at request time (never pre-rendered)
- **Dev mode** - On-demand rendering via `/__rsc_prerender` endpoint
- **Intercept pre-rendering** - Intercept variants stored under `/i` key

### Remaining

- **Revalidation with Passthrough** - Background re-render of stale prerender data
- **ISR-style revalidation** - Time-based or on-demand re-rendering without full rebuild

---

## Architecture

### Build Time

```
  Vite closeBundle
       |
       v
  For each Prerender route:
    1. Call getParams() -> param sets
    2. For each param set:
       a. Create BuildContext (synthetic URL, params, use())
       b. Resolve handler + child layouts/parallels
       c. Serialize segments via RSC Flight protocol
       d. Walk manifest for intercepts targeting this route
       e. If found: resolve intercept handler, serialize intercept segments
       f. Store entries in prerender manifest (lazy-loaded module):
          - "routeName/paramHash"     -> asset specifier (main segments + handles)
          - "routeName/paramHash/i"   -> asset specifier (main + intercept segments + handles)
```

### Runtime

```
  Request arrives
       |
       v
  cache-lookup middleware
       |
       v
  Is route marked pr: true?
       |
  +----+----+
  | no      | yes
  |         v
  |    Is ctx.isIntercept?
  |         |
  |    +----+----+
  |    | no      | yes
  |    |         v
  |    |    Lookup "routeName/paramHash/i"
  |    |         |
  |    |    +----+----+
  |    |    | miss    | hit
  |    |    |         v
  |    |    |    yieldFromStore (intercept variant)
  |    |    |    return
  |    |    |
  |    |    v
  |    |    Fall through to normal pipeline
  |    |    (intercept-resolution runs live)
  |    |
  |    v
  |    Lookup "routeName/paramHash"
  |         |
  |    +----+----+
  |    | miss    | hit
  |    |         v
  |    |    yieldFromStore (main variant)
  |    |    return
  |    |
  |    v
  |    Passthrough route? -> live handler runs
  |    No Passthrough? -> handler stubbed, no render
  |
  v
  Normal segment resolution
```

### yieldFromStore

When a prerender store entry is found:

1. Deserialize segments from serialized Flight payloads
2. Replay handle data into the request's HandleStore
3. Set `state.cacheHit = true` and `state.cachedMatchedIds`
4. For partial navigation: nullify components the client already has
5. Yield cached segments
6. Resolve loaders fresh (loaders are NEVER pre-rendered)
7. Yield loader segments

This is identical to the runtime cache hit path, which is the point: pre-rendering
IS caching, just at build time instead of runtime.

---

## Prerender Store

### Production (`__loadPrerenderManifestModule`)

Injected by the Vite `closeBundle` hook. The RSC entry sets a lazy loader:

```javascript
globalThis.__loadPrerenderManifestModule = () =>
  import("./__prerender-manifest.js");
```

The manifest module (`__prerender-manifest.js`) exports:

```javascript
// Key→specifier map, parsed from JSON for fast startup
const m = JSON.parse('{"blog.post/a1b2c3":"./assets/__pr-a1b2c3.js",...}');
// Asset loader anchored at manifest file location for correct relative resolution
export function loadPrerenderAsset(s) {
  return import(s);
}
export default m;
```

The manifest is loaded lazily on first prerender store `get()`. Each asset
module default-exports a `PrerenderEntry`:

```typescript
interface PrerenderEntry {
  segments: SerializedSegmentData[];
  handles: Record<string, SegmentHandleData>;
}
```

### Dev Mode (`__PRERENDER_DEV_URL`)

Set by the Vite plugin for non-Node.js RSC runtimes (workerd, Deno). The
prerender store fetches on-demand from the Vite dev server:

```
GET /__rsc_prerender?pathname=/blog/hello-world
GET /__rsc_prerender?pathname=/blog/hello-world&intercept=1
```

The endpoint calls `matchForPrerender()` in the Node.js dev environment where
`node:fs` and other Node APIs work.

In Node.js dev mode, `__PRERENDER_DEV_URL` is undefined and handlers run
in-process.

---

## BuildContext

Handlers receive `BuildContext` at build time. It is a subset of `HandlerContext`
with request-dependent fields replaced by descriptive error throwers:

```typescript
interface BuildContext<TParams> {
  params: TParams;
  build: true; // Always true at build time
  dev: boolean; // true in Vite dev mode, false during production build
  use: <T>(handle: Handle<T>) => (data: T) => void;
  url: URL; // Synthetic: pattern + params
  pathname: string;
  env: DefaultEnv; // Available when buildEnv is configured in rango() (throws otherwise)
  // These always throw descriptive errors:
  // request, headers, cookies, ctx.redirect, etc.
}
```

When `buildEnv` is configured in the rango() Vite plugin options, `ctx.env`
provides the build-time bindings (e.g., KV, D1). This is NOT the live request
env — it is shared across all prerender invocations for the build. Without
`buildEnv`, accessing `ctx.env` throws with a clear error message.

---

## Handler Eviction

In production builds, `Prerender` exports are replaced with stubs:

```typescript
// Original
export const BlogPost = Prerender(getParams, handler);

// Stubbed (all Prerender handlers are evicted)
export const BlogPost = {
  __brand: "prerenderHandler",
  $$id: "abc123#BlogPost",
};
```

All Prerender handlers are evicted in production. The live handler for
`Passthrough()` routes lives in the urls module and is not evicted.

Client and SSR environments always receive stubs.

---

## Passthrough Wrapper

`Passthrough(prerenderDef, liveHandler)` wraps a `Prerender` definition with
a separate handler for runtime fallback. The build handler runs at build time,
the live handler runs at request time for params not in the prerender cache.

```typescript
export const BlogPostDef = Prerender(
  async () => [{ slug: "a" }, { slug: "b" }],
  async (ctx) => {
    const post = await getPost(ctx.params.slug);
    if (!post) return ctx.passthrough();
    return <article>{post.content}</article>;
  },
);

// In route definition:
path("/blog/:slug", Passthrough(BlogPostDef, async (ctx) => {
  const post = await ctx.env.DB.getPost(ctx.params.slug);
  return <article>{post.content}</article>;
}));
```

### Semantics

- JSX or `null` from the build handler produces a normal prerender entry.
- `ctx.passthrough()` returns a frozen sentinel (`PRERENDER_PASSTHROUGH`).
  `matchForPrerender` detects it and returns `{ passthrough: true }` instead
  of serialized segments. The build skips the manifest entry for that param set.
- `ctx.passthrough()` on a route not wrapped with `Passthrough()` throws.
- `getParams()` still enumerates the param set; the build handler decides
  per-param whether to produce an artifact or defer to the live handler.

### Build-time flow

1. `getParams()` returns param sets (including ones that may passthrough).
2. For each param set, `matchForPrerender` creates a `BuildContext` with
   `passthrough()` wired (when `isPassthroughRoute` is true).
3. Build handler returns `ctx.passthrough()` for a given param set.
4. `matchForPrerender` detects the sentinel in resolved segments and returns
   `{ passthrough: true }`.
5. `expandPrerenderRoutes` logs `PASS` and skips `collectedData` insertion.

### Runtime flow

No stored entry exists for that param set. The runtime cache-lookup sees
`pr + pt + miss` and falls through to the Passthrough live handler, which
runs with full `HandlerContext` (`ctx.build === false`).

---

## Intercept Pre-rendering

### Problem

Without intercept pre-rendering, the prerender lookup in `cache-lookup.ts`
short-circuits before `intercept-resolution` middleware can add the modal slot
segments. Result: intercept navigations to pre-rendered routes serve the
full-page view instead of the intercepted modal.

### Solution

At build time, `matchForPrerender()` walks the manifest tree from the target
route upward, finds all intercepts targeting it, and resolves their handlers
with BuildContext. The resulting segments are stored alongside main segments
under an `/i`-suffixed key.

### Build-time intercept resolution

After main segment serialization in `matchForPrerender()`:

1. Walk manifest tree (`manifestEntry.parent` chain)
2. Check `entry.intercept[]` and `entry.layout[].intercept[]` for entries where
   `intercept.routeName` matches the target route
3. For each match: resolve handler and optional layout with BuildContext
4. Construct intercept segment: `id: "${parentEntry.shortCode}.${slotName}"`,
   `namespace: "intercept:${routeName}"`, `type: "parallel"`, `slot: slotName`
5. Serialize and return as `interceptSegments` + `interceptHandles`

`when()` conditions are not evaluated at build time (no `InterceptSelectorContext`
available). All intercepts are pre-rendered unconditionally. `when()` is evaluated
at runtime by the intercept-resolution middleware.

### Runtime intercept lookup

In `cache-lookup.ts`, when `ctx.isIntercept` is true:

1. Look up `paramHash + "/i"` from prerender store
2. If found: `yieldFromStore()` yields the combined entry. Downstream
   `handleCacheHitIntercept()` filters segments by `namespace?.startsWith("intercept:")`
   and sets up `state.slots[slotName]`
3. If not found: fall through to normal pipeline (skip non-intercept prerender
   to let intercept-resolution middleware run live)

### Storage keys

```
"blog.post/a1b2c3"      Main variant (full page segments)
"blog.post/a1b2c3/i"    Intercept variant (main + intercept segments)
```

The intercept variant includes ALL main segments plus the intercept parallel
segments. This is because `handleCacheHitIntercept()` expects to find both
in the cached data.

---

## Interaction with Other Systems

### Loaders

Loaders are NEVER pre-rendered. They run fresh at request time on every
request. The `resolveLoadersOnly` / `resolveLoadersOnlyWithRevalidation`
functions handle this after `yieldFromStore` yields cached segments.

### Runtime Cache (`cache()`)

Orthogonal to pre-rendering. Runtime cache operates on segments resolved at
request time. Pre-rendered segments bypass the runtime cache entirely (the
prerender lookup happens first in `cache-lookup.ts`).

### Middleware

Skipped during pre-rendering (no request object). Middleware runs at request
time for loader resolution and any live handler execution.

### Actions

Actions do not re-render pre-rendered segments. The frozen handler output
stays. Loaders can be revalidated by actions. With `Passthrough()` routes and
`revalidate()`, the live handler can re-render.

### Handle Data

Values pushed via `ctx.use()` during pre-rendering are baked into the Flight
payload. They are replayed into the HandleStore on cache hit via
`handleStore.replaySegmentData()`.

---

## Trie Flags

Pre-rendered routes set flags on the route trie leaf at build time:

- `pr: true` -- route has pre-rendered segment data
- `pt: true` -- route wrapped with `Passthrough()` (live handler available)

At runtime, the cache-lookup middleware uses these flags:

- `pr + hit` -- serve pre-rendered Flight payload
- `pr + pt + miss` -- fall through to live handler (handler kept in bundle)
- `pr + miss` (no pt) -- fall through (handler stubbed, no live render)

---

## Key Files

| File                                                  | Role                                                   |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `src/router.ts` (`matchForPrerender`)                 | Build-time segment resolution + intercept resolution   |
| `src/router/match-middleware/cache-lookup.ts`         | Runtime prerender store lookup                         |
| `src/prerender/store.ts`                              | PrerenderStore interface + dev/prod implementations    |
| `src/prerender/param-hash.ts`                         | Deterministic param hashing for store keys             |
| `src/cache/cache-scope.ts`                            | RSC serialize/deserialize for segments                 |
| `src/vite/index.ts` (`closeBundle`)                   | Collects prerender data + writes manifest              |
| `src/router/match-middleware/intercept-resolution.ts` | Runtime intercept handling (`handleCacheHitIntercept`) |
