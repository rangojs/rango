# Pre-rendering Design

This is the canonical design for pre-rendering — read it before changing anything
in that area. There's one mental model to hold, and almost every "wait, how does
that work?" follows from it: there are no static files. Hold that and the rest of
the doc reads itself.

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
- **Render-error handling** - a build-time render throw surfaces to the build (fail
  by default, or `prerender.onError: "warn"` to skip the URL); `throw new Skip()`
  in a render fn skips one URL. See [Render Errors](#render-errors).
- **Build-time PPR shells (producer B, #699)** - a `Prerender` route that also
  declares the `ppr` path option gets its complete PPR shell entry (HTML prelude +
  postponed state) produced at `vite build` and served from the very first
  request. On-demand routes stay on the normal document lane because the
  writable segment overlay and shell store cannot be replaced atomically. See
  [Build-time PPR shells](#build-time-ppr-shells-producer-b).
- **ISR-style revalidation** - `Prerender(..., { onDemand })` plus
  `router.prerender()` refreshes a writable durable overlay without a deploy;
  `Passthrough` remains the live fallback until an entry exists.

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

Injected by the Vite `closeBundle` hook (in `src/vite/router-discovery.ts`,
with manifest staging + `__loadPrerenderManifestModule` injection in
`src/vite/discovery/bundle-postprocess.ts`). The RSC entry sets a lazy loader:

```javascript
globalThis.__loadPrerenderManifestModule = () =>
  import("./__prerender-manifest.js");
```

The manifest module (`__prerender-manifest.js`) exports:

```javascript
// Key→specifier map, parsed from JSON for fast startup
const m = JSON.parse('{"blog.post/a1b2c3":"./assets/__pr-7f3e0c91.js",...}');
// Asset loader anchored at manifest file location for correct relative resolution
export function loadPrerenderAsset(s) {
  return import(s);
}
export default m;
```

The two hashes are unrelated: the map key embeds the DJB2 param hash
(`hashParams`, `src/prerender/param-hash.ts`), while the asset filename is a
sha256 content hash of the serialized payload (`__pr-<sha256(exportValue)[0:8]>.js`),
so identical payloads dedupe to the same file.

The manifest is loaded lazily on first prerender store `get()`. Each asset
module default-exports a `PrerenderEntry`:

```typescript
interface PrerenderEntry {
  segments: SerializedSegmentData[];
  // RSC-encoded handle map ("" when none). Encoded via the Flight codec
  // (handle-snapshot.ts encodeHandles) so Promise/ReactNode handle values
  // survive the JSON-serialized build artifact / dev wire — the same codec the
  // runtime cache uses. The producer (matchForPrerender, in the RSC env) encodes;
  // the node-side build/dev sinks persist the string as-is; cache-lookup decodes.
  handles: string;
}
```

The store interface is:

```typescript
interface PrerenderStore {
  get(
    routeName: string,
    paramHash: string,
    meta?: { pathname: string; isPassthroughRoute?: boolean },
  ): PrerenderEntry | null | Promise<PrerenderEntry | null>;
}
```

`meta` is dev-required and production-ignored: the dev store reconstructs the
on-demand fetch URL from `meta.pathname` (returns `null` without it) and toggles
`passthrough=1` from `meta.isPassthroughRoute`, while the production store keys
solely off `routeName`/`paramHash`. This is a known leaky seam — the `get()`
type advertises a `meta` contract only the dev implementation honors.

### Dev Mode (`__PRERENDER_DEV_URL`)

Set by the Vite plugin for non-Node.js RSC runtimes (workerd, Deno). The
prerender store fetches on-demand from the Vite dev server:

```
GET /__rsc_prerender?pathname=/blog/hello-world&routeName=blog.post
GET /__rsc_prerender?pathname=/blog/hello-world&routeName=blog.post&intercept=1
GET /__rsc_prerender?pathname=/blog/hello-world&routeName=blog.post&passthrough=1
```

The endpoint calls `matchForPrerender()` in the Node.js dev environment where
`node:fs` and other Node APIs work. The dev store always sends `routeName`
(the endpoint rejects a match from the wrong router when multiple routers share
a pathname) and adds `passthrough=1` for `Passthrough()` routes so unknown
params defer to the live handler in dev, mirroring production. `intercept=1`
requests the intercept (modal slot) variant.

The Node preset sets `__PRERENDER_DEV_URL` too — both presets round-trip
through the endpoint (a loopback fetch in the Node preset), so prerender
rendering always happens Node-side with the build env available.

The endpoint memoizes rendered payloads between HMR edits (#654), keyed by
router-instance identity (`vite/discovery/dev-prerender-cache.ts`). It
re-imports the user's entry through a module runner on every request — the
Node preset on the main RSC environment, the Cloudflare preset on the shared
temp Node server — so an edit anywhere in the entry → router → urls → handler
chain re-runs `createRouter()`, registers a NEW router instance, and thereby
strands the old instance's cache bucket (a WeakMap: stale generations are
garbage-collected). A warm request is a module-cache hit plus a Map lookup;
one render warms both the main and `intercept=1` variant keys.
`x-rango-prerender-cache: HIT | MISS` reports the outcome per response.
Between edits the endpoint serves frozen results — matching production, where
artifacts freeze at build time — so `getParams()`/handler side effects (fs,
DB via buildEnv) run once per edit generation, not once per request. The
per-request re-import on the Cloudflare temp server is also the freshness
fix for handler-only edits (files without `urls()`/`createRouter()` that the
main watcher's route-file sniff ignores): the temp server's own watcher
invalidates its graph, and the re-import re-evaluates exactly the dirty
subgraph.

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

## Render Errors

If a `Prerender` route's render throws at build time, you want to hear about it —
not ship a frozen error page. This started as a bug (#587): the throw was caught by
the route's error boundary _inside_ segment resolution, turned into a normal
`type: "error"` segment, serialized, and baked as the artifact. The build logged
`OK`, exited 0, and at runtime the baked error page was served as a healthy 200.
Status/CI checks saw a valid 200, so a fully broken page looked fine.

The fix: pre-rendering resolves segments with a build-only `throwOnError` flag
(`matchForPrerender` → `resolveAllSegments` → `resolveWithErrorBoundary`, threaded
through `ResolveSegmentOptions`). With it set, a thrown render error is re-thrown
instead of converted into an error segment, so it reaches the build loop
(`expandPrerenderRoutes`). The live request path leaves the flag unset, so runtime
error boundaries are unchanged.

What the build then does is `prerender.onError` (a rango() plugin option):

| build handler outcome             | `"fail"` (default)                      | `"warn"`                  |
| --------------------------------- | --------------------------------------- | ------------------------- |
| render throws                     | build fails, names the URL + the error  | warn, skip baking the URL |
| `throw new Skip()` in the render  | URL skipped (logged `SKIP`)             | URL skipped               |
| `ctx.passthrough()` (Passthrough) | defer to the live handler (no artifact) | defer to the live handler |

`throw new Skip()` is the per-URL escape hatch: a render that knows it can't run at
build (needs request-time env, say) skips just that URL. This used to be broken too
— a `Skip` thrown in a _render fn_ was swallowed by the same error boundary; it now
propagates correctly (the `getParams()` Skip path always worked).

`"warn"` is a build-unblock, NOT a runtime contract for the skipped entry. At runtime
the route falls through to normal resolution, which may render live (its handler is
still bundled — e.g. when nothing else baked, so handler eviction never ran) or 404
(once eviction has run for other baked entries) — so the outcome depends on the rest
of the build, and a skipped `Static()` segment's evicted code can surface as an error.
For DEFINED runtime behavior use `Passthrough()` (a live fallback) or `throw new
Skip()` (an intentional skip); otherwise prefer the default `"fail"`.

Why no `"dynamic"` or `"bake"` option? `"bake"` is the bug. A clean `"dynamic"`
(always serve live) can't be offered for a plain `Prerender()` route because handler
eviction removes its code when other entries bake; `Passthrough()` is the explicit,
defined way to keep a live fallback. So a render error is either "fail" or "warn".

The same `matchForPrerender` powers the dev `/__rsc_prerender` endpoint, so a render
error in dev surfaces there too: the endpoint logs it and falls through to a live
render rather than serving a frozen error page.

---

## Build-time PPR shells (producer B)

Pre-rendering is caching at build time — and for a route that ALSO declares the
`ppr` path option, that now extends one layer up: the build additionally
produces the route's complete PPR shell entry (`ShellCacheEntry`: HTML prelude,
postponed resume state, snapshot, tag union), so the FIRST request after a
deploy serves `x-rango-shell: HIT` with zero runtime capture. One entry format,
two producers (runtime capture / build), one consumer — the worker cannot tell
where an entry came from. Design: `docs/design/shell-fast-path.md`.

### Build flow

1. `expandPrerenderRoutes` records each Prerender+ppr URL as a shell candidate
   (`matchForPrerender` now surfaces the matched route entry's `ppr` option)
   and retains the Flight payload JSON in memory.
2. The shell prerender phase (`vite/discovery/shell-prerender-phase.ts`, a
   `buildApp` post hook) runs AFTER every environment bundle is written — the
   prelude embeds the BUILT client bootstrap URL, which does not exist at
   buildStart. It reuses the buildStart temp server (kept alive on discovery
   state), seeds an in-realm prerender store from the retained payloads, then
   runs global and route middleware before producer A's capture core
   (`prerender/build-shell-capture.ts`, built on `deriveShellCaptureContext` +
   `captureAndStoreShell`) per URL. Middleware sees `ctx.build === true`;
   `ctx.waitUntil()` is inert so build capture cannot enqueue live response
   work, and `ctx.dynamic()` skips the shell for that URL. After middleware,
   the capture's `match()` HITs the prerender store and REPLAYS the build-time
   segments — no handler execution — with live-lane loaders masked into holes,
   identical to runtime capture. The fizz half runs in the temp server's SSR
   environment runner; production-hashed client references bridge to dev
   refKeys through a wrapped `__vite_rsc_client_require__` (same
   `computeProductionHash`).
3. Entries are stamped with the MAIN build's version (the version plugin's
   value folded into the shipped worker) and staged as `__ps-*.js` asset
   modules under `dist/rsc/assets/`, with a lazy `__shell-manifest.js` and a
   `globalThis.__loadShellManifestModule` injection into the RSC entry —
   mirroring the prerender payload manifest. No static file serving; the
   worker handles every request.
4. A capture that is refused (identity guard, rejected bake-lane loader),
   produces no shell, or never consulted the prerender store is SKIPPED with a
   loud `SHELL SKIP` build line — the route keeps runtime-capture semantics,
   never a wrong-lane bake. Manifest keys are pathname-only (router ids hash
   transformed source positions and differ across realms); pathname collisions
   across routers are declined at build.

### Runtime flow

On a runtime shell-store MISS, the serve path consults the build manifest
(`rsc/shell-build-manifest.ts` `lookupBuildShell`) and serves a valid entry
through the SAME `serveShellHit`. Gates: search-less requests only (the build
captured the bare pathname; a search-bearing URL has its own shell identity,
owned by runtime capture), `reactVersion`/`buildVersion` validity, payload
integrity, and tag markers (below). The runtime store is always read FIRST, so
a captured entry supersedes the baked one as soon as it lands.

`ctx.dynamic()` is the per-request opt-out. If middleware calls it, the PPR
commit point does not read stored shells and the request stays on axis 1. If a
handler calls it later during an axis-1 MISS render, the response is still axis 1
and no follow-up shell capture is scheduled. Build shell capture uses the same
flag: a build middleware call returns a `dynamic` shell outcome and the URL is
left for runtime.

### Lifecycle semantics

| Event                    | Effect on the baked entry                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy (new build)       | retired: buildVersion gate + a fresh manifest replace it                                                                                                               |
| `ppr.ttl` elapses        | STALENESS only: still serves, but a runtime recapture is scheduled — SWR is the upgrade path from baked entry to fresher runtime entry, never the bootstrap path       |
| `updateTag()` on its tag | evicted WITHOUT tombstones: the manifest is immutable, so `isTagsInvalidatedSince(tags, entry.createdAt)` (new optional store method) compares the store's tag markers |
| store lacks the method   | TAGGED baked entries are not served (warned once — updateTag could never evict them); untagged entries are unaffected                                                  |

`isTagsInvalidatedSince` implementations: CFCacheStore wraps its existing KV
tag-marker check; MemorySegmentCacheStore records per-tag invalidation
instants; VercelCacheStore writes its own `tm`-family markers on
`invalidateTags` (the platform's `expireTag` deletes entries and keeps no
queryable history).

### Dev mode

No build manifest exists in dev, so producer B runs ON DEMAND: the
read-through's dev branch fetches `/__rsc_shell` (a dev-server endpoint
mirroring `/__rsc_prerender`), which runs the same capture core in the dev
realms — main-server environments on the Node preset, the shared temp Node
server on Cloudflare (whose `virtual:entry-ssr` now resolves to the REAL
rango SSR entry, lazily) — memoized per router HMR generation and per caller
version. The endpoint is policy-free: the serve gate sends the resolved
`ttl`/`swr`/`tags`/version. Only trie `pr`-flagged routes arm the dev branch
(production's exact candidate set), and a `/__rsc_prerender` pre-flight
refuses non-prerenderable routes so a live-handler render can never be served
as a baked shell. First dev request: `x-rango-shell: HIT`, same as production.

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

`when` config conditions are not evaluated at build time (no `InterceptSelectorContext`
available). All intercepts are pre-rendered unconditionally. `when` is evaluated
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

### Tag invalidation (`cacheTag` / `updateTag` / `revalidateTag`)

Disjoint from pre-rendering. `updateTag()` / `revalidateTag()` invalidate
runtime cache entries (segment / `"use cache"` item / document caches) via the
store's tag markers; they do NOT refresh a pre-rendered (B-segment) route's
build-time Flight payload, because that payload is served from the prerender
store before the tag system is consulted. A `cacheTag()` call inside a
`"use cache"` function that runs during pre-rendering has no runtime effect (the
result is frozen into the prerendered payload, not stored as a tagged runtime
entry). To make a tag-invalidatable route, serve it from the runtime cache (a
`Passthrough()` route, or a non-prerendered route with `cache()` / `cacheTag`)
rather than pre-rendering it.

By the same rule the prerender serve path (`yieldFromStore`) records no
`cache({ tags })` into the request-scoped document tag union (`ctx._requestTags`)
on a hit — so if a pre-rendered route is also wrapped in document caching, its
document-cache entry carries an empty tag union and is not reached by
`updateTag` / `revalidateTag`. This is intentional, not a gap: the baked payload
is immutable until the next build, so invalidating the document-cache wrapper
would only re-serve the identical prerendered body. Tag-invalidate the document
by serving the route from the runtime cache instead of pre-rendering it.

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

| File                                                                                                                                                                 | Role                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/router/prerender-match.ts` (`matchForPrerender`, `renderStaticSegment`)                                                                                         | Build-time segment resolution + intercept resolution (`src/router.ts` re-exposes `matchForPrerender` as a router method)                                 |
| `src/router/match-middleware/cache-lookup.ts`                                                                                                                        | Runtime prerender store lookup                                                                                                                           |
| `src/prerender/store.ts`                                                                                                                                             | PrerenderStore interface + dev/prod implementations                                                                                                      |
| `src/prerender/param-hash.ts`                                                                                                                                        | Deterministic param hashing for store keys                                                                                                               |
| `src/cache/cache-scope.ts`                                                                                                                                           | RSC serialize/deserialize for segments                                                                                                                   |
| `src/vite/router-discovery.ts` (`closeBundle`) + `src/vite/discovery/prerender-collection.ts` (`expandPrerenderRoutes`) + `src/vite/discovery/bundle-postprocess.ts` | Collects prerender data, stages assets, writes manifest + injects `__loadPrerenderManifestModule` (`src/vite/index.ts` is only the public-API barrel)    |
| `src/router/match-middleware/intercept-resolution.ts`                                                                                                                | Runtime intercept handling (`handleCacheHitIntercept`)                                                                                                   |
| `src/vite/discovery/shell-prerender-phase.ts` (buildApp post) + `src/prerender/build-shell-capture.ts` (`captureShellForBuild`)                                      | Producer B: build-time PPR shell capture + `__ps` asset/manifest staging (#699); replays middleware with `ctx.build === true` and honors `ctx.dynamic()` |
| `src/rsc/shell-build-manifest.ts` (`lookupBuildShell`) + `src/prerender/shell-manifest-key.ts`                                                                       | Runtime read-through for baked shell entries (production manifest / dev `/__rsc_shell` on-demand)                                                        |
