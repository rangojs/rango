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
- **Flight payload storage** - Serialized segments stored in `__PRERENDER_MANIFEST`
- **Runtime cache-lookup** - Prerender store checked before segment resolution
- **Handler eviction** - Non-passthrough handlers stubbed in production bundles
- **Passthrough mode** - Handler kept in bundle for unknown params (live fallback)
- **Sub-use semantics** - Child layouts, parallels inside path are pre-rendered
- **Handle data** - `ctx.use()` data baked into Flight payloads
- **Loader freshness** - Loaders always run at request time (never pre-rendered)
- **Dev mode** - On-demand rendering via `/__rsc_prerender` endpoint
- **Intercept pre-rendering** - Intercept variants stored under `/i` key

### Remaining
- **Revalidation with passthrough** - Background re-render of stale prerender data
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
       f. Store entries in __PRERENDER_MANIFEST:
          - "routeName/paramHash"     -> main segments + handles
          - "routeName/paramHash/i"   -> main + intercept segments + handles  (if intercepts exist)
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
  |    Passthrough? -> handler runs live
  |    No passthrough? -> handler stubbed, no render
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

### Production (`__PRERENDER_MANIFEST`)

Injected by the Vite `closeBundle` hook. Map of string keys to dynamic imports:

```typescript
globalThis.__PRERENDER_MANIFEST = {
  "blog.post/a1b2c3": () => import("./assets/__pr-blog.post-a1b2c3.js"),
  "blog.post/a1b2c3/i": () => import("./assets/__pr-blog.post-a1b2c3-i.js"),
  "about/_": () => import("./assets/__pr-about-_.js"),
};
```

Each module default-exports a `PrerenderEntry`:

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
  use: <T>(handle: Handle<T>) => (data: T) => void;
  url: URL;           // Synthetic: pattern + params
  pathname: string;
  // These throw descriptive errors if accessed:
  // req, headers, cookies, env, request, ctx.redirect, etc.
}
```

---

## Handler Eviction

In production builds, `Prerender` exports are replaced with stubs:

```typescript
// Original
export const BlogPost = Prerender(getParams, handler);

// Stubbed (passthrough: false)
export const BlogPost = { __brand: "prerenderHandler", $$id: "abc123#BlogPost" };
```

The entire original module and its imports are excluded from the RSC server
bundle. With `passthrough: true`, handler code stays in the bundle.

Client and SSR environments always receive stubs regardless of passthrough mode.

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
stays. Loaders can be revalidated by actions. With `passthrough: true` and
`revalidate()`, the handler itself can re-render live.

### Handle Data
Values pushed via `ctx.use()` during pre-rendering are baked into the Flight
payload. They are replayed into the HandleStore on cache hit via
`handleStore.replaySegmentData()`.

---

## Trie Flags

Pre-rendered routes set flags on the route trie leaf at build time:

- `pr: true` -- route has pre-rendered segment data
- `pt: true` -- passthrough mode (handler available for live fallback)

At runtime, the cache-lookup middleware uses these flags:
- `pr + hit` -- serve pre-rendered Flight payload
- `pr + pt + miss` -- fall through to live handler (handler kept in bundle)
- `pr + miss` (no pt) -- fall through (handler stubbed, no live render)

---

## Key Files

| File | Role |
|------|------|
| `src/router.ts` (`matchForPrerender`) | Build-time segment resolution + intercept resolution |
| `src/router/match-middleware/cache-lookup.ts` | Runtime prerender store lookup |
| `src/prerender/store.ts` | PrerenderStore interface + dev/prod implementations |
| `src/prerender/param-hash.ts` | Deterministic param hashing for store keys |
| `src/cache/cache-scope.ts` | RSC serialize/deserialize for segments |
| `src/vite/index.ts` (`closeBundle`) | Collects prerender data + writes manifest |
| `src/router/match-middleware/intercept-resolution.ts` | Runtime intercept handling (`handleCacheHitIntercept`) |
