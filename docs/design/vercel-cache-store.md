# Vercel cache store and deployment

If you are about to add Vercel support to Rango — a production cache backend, a
deployment target, or both — start here. This doc explains why Vercel's Runtime
Cache is a near-perfect fit for the `SegmentCacheStore` contract, how
`VercelCacheStore` maps onto it, and what a Node-serverless deployment via the
Build Output API looks like. It is the sibling of [`caching.md`](./caching.md)
(the segment-cache design) and [`cache-tags-flow.md`](./cache-tags-flow.md) (the
tag-invalidation flow); read those first if you have not.

Status: the **store** (`VercelCacheStore`) is implemented and exported from
`@rangojs/router/cache`. The **deployment** (a rango `vercel` preset + example
app) is designed here but not yet built — see "What ships, what is deferred" at
the end.

## Why the Runtime Cache is the right backend, and why this store is small

A fair first reaction to "we need a Vercel store" is to expect another
`CFCacheStore` — three thousand lines of L1/L2 tiering, KV tag markers, marker
memoization, per-tier timeout budgets. It is not. `CFCacheStore` is large because
Cloudflare hands you raw primitives — a per-colo Cache API and a global KV — and
you build a distributed, tag-aware cache out of them yourself. Vercel's Runtime
Cache already *is* that cache.

`getCache()` from `@vercel/functions` returns a handle with exactly the four
operations the store needs:

```ts
interface RuntimeCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: { ttl?: number; tags?: string[]; name?: string }): Promise<void>;
  delete(key: string): Promise<void>;
  expireTag(tag: string | string[]): Promise<void>;
}
```

Storage is regional and ephemeral (each region keeps its own copy, LRU-evicted),
but `expireTag` propagates **globally within ~300ms**. That last fact is what
makes it a real production backend and not just a per-instance cache: a tag
invalidation issued in one region correctly clears the tagged entries
everywhere. So `VercelCacheStore` sits much closer to `MemorySegmentCacheStore`
in size than to `CFCacheStore` — the platform does the distribution and the tag
fan-out for us.

The store exists to supply the three things the raw primitive does *not* give us.
The rest of this doc is mostly those three.

## The store: `VercelCacheStore`

Source: `packages/rangojs-router/src/cache/vercel/vercel-cache-store.ts`. Public
import path: `@rangojs/router/cache` (no dedicated subpath — same as
`CFCacheStore`; the deep `@rangojs/router/cache/vercel` path is intentionally not
exported).

### What it implements

It implements the full `SegmentCacheStore` surface (`src/cache/types.ts`):

| Method | Backed by | Notes |
|---|---|---|
| `get` / `set` / `delete` | `getCache().get/set/delete` (family `s`) | Segment-tree cache, the `cache()` DSL. |
| `getItem` / `setItem` | same (family `i`) | `"use cache"` function results. |
| `getResponse` / `putResponse` | same (family `r`) | Whole-`Response` document cache; body base64-encoded. |
| `invalidateTags` | `getCache().expireTag` | One call per invalidation batch. |
| `defaults` / `keyGenerator` | config passthrough | ttl/swr inheritance and key segmentation. |

`clear()` is deliberately **not** implemented: `getCache` has no key enumeration,
so a wipe-all is impossible. `clear` is optional in the interface and only used by
test teardown, which uses `MemorySegmentCacheStore` anyway.

### Injection, not import: the store has no `@vercel/functions` dependency

This is the first rule worth internalizing, and it is the same rule
`CFCacheStore` follows. The router package imports **nothing** from
`@vercel/functions`. The store takes the cache handle (and `waitUntil`) through
its constructor, typed against a local structural shape:

```ts
export interface VercelRuntimeCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: { ttl?: number; tags?: string[]; name?: string }): Promise<void>;
  delete(key: string): Promise<void>;
  expireTag(tag: string | string[]): Promise<void>;
}
```

The consumer passes the real `getCache(...)` result, which satisfies this
structurally. Why bother? Because `@rangojs/router` ships to Cloudflare, Bun,
Node, and Vercel — a hard `@vercel/functions` dependency would land in every one
of those bundles. `CFCacheStore` takes its `kv` and `ctx` bindings by injection
for the same reason (it never imports a Cloudflare package). Mirror that: the
Vercel-specific import lives in the consumer's app, never in the router.

### One flat keyspace, three value families: the prefix rule

`MemorySegmentCacheStore` keeps three separate `Map`s — one for segments, one for
responses, one for items — so the same router key can live in all three without
colliding. `getCache` is **one flat keyspace**. If the store wrote a cached
`Response` and a cached segment under the same router-supplied key, the second
write would clobber the first.

So the store namespaces every key by family before it touches the cache:

```
[v/{version}/]rg:{s|i|r}:{routerKey}
```

`s` = segment, `i` = item, `r` = response. `rg:` namespaces all Rango entries
(so the project's Runtime Cache can hold non-Rango data too). The router's own
semantic prefixes (`doc:`, `partial:`, `intercept:`, `use-cache:`) ride along as
the `{routerKey}` suffix. This started as the obvious failure mode of a
single-keyspace backend; the prefix is what prevents it.

### Stale-while-revalidate, when the backend has none

`getCache` has no stale-but-serve. A TTL'd entry is fresh until it expires, then
it is simply gone — there is no window where you can serve the old value while
refreshing. Rango's SWR contract needs that window, and the `SegmentCacheStore`
contract makes the *store* responsible for it: `get` returns
`{ data, shouldRevalidate }`, and `shouldRevalidate: true` means "serve this, but
kick off a refresh."

The store reconstructs SWR with an envelope. Every write stores
`{ d, s, e }` — the data, a `staleAt`, and an `expiresAt` (computed by the shared
`computeExpiration` helper in `cache-policy.ts`) — and sets the **Vercel TTL to
`ttl + swr`** so the entry physically survives its whole SWR window. On read the
store compares `now` against the envelope's `s`/`e`:

- `now > e` → treat as a miss (and evict; Vercel should already have dropped it
  by TTL, but the guard covers clock skew).
- `now > s` → return `shouldRevalidate: true`.
- otherwise → fresh.

This is the same `{d,s,e}` envelope shape `CFCacheStore` uses for its KV tier, and
it reuses the same `resolveSwrWindow` / `computeExpiration` policy helpers — do
not reinvent the TTL math, it lives in `cache-policy.ts` for exactly this reason.

#### Herd dampening is best-effort here

When `get` returns a stale entry, the store pushes `staleAt` forward by 30s and
re-writes the envelope, so other readers in the same region briefly see it as
fresh while one of them revalidates. `CFCacheStore` does the same with its
`MAX_REVALIDATION_INTERVAL` re-arm, but it has the Cache API's atomicity to lean
on. `getCache` has no compare-and-set and storage is regional, so two readers can
still both read the stale value before either re-stamps and both trigger a
refresh. That is acceptable — the contract only asks that we *try* to prevent a
thundering herd, and a duplicated revalidation is a cost overrun, not a
correctness bug. The re-stamp runs through `waitUntil` (off the response path)
when one is provided, fire-and-forget otherwise.

### Tags: delete-via-`expireTag`, not marker comparison

`CFCacheStore` keeps a per-tag KV marker timestamp and, on every tagged read,
compares the entry's `taggedAt` against the marker — invalidation is lazy. Vercel
does it the other way: `set({ tags })` registers the tags, and `expireTag` physically
expires every entry carrying them, server-side and globally. So the Vercel store's
model is the **delete model**, the same as `MemorySegmentCacheStore`, not CF's
marker model:

- write path: pass the entry's tags straight to `cache.set(key, value, { tags })`.
- invalidate path: `invalidateTags(tags)` → `cache.expireTag(tags)`, one call for
  the whole batch.

There is no companion tag store, no `taggedAt` bookkeeping for invalidation
(we keep tags on the read-side result so a hit still contributes them to the
document tag union, but they are not used to *decide* invalidation — Vercel
already did). This is why the store is small.

`invalidateTags` is also the **one method that is allowed to throw**. Every other
read/write degrades silently-but-loudly (reported via `reportCacheError`, never
thrown — a cache is best-effort). But a failed `expireTag` must reject, so that an
awaited `updateTag()` in a server action surfaces the failure instead of
reporting a false success. That is the read-your-own-writes honesty rule from
`cache-error.ts`; honor it.

### The platform guardrails that bite

These are the limits that will silently cost you correctness or capacity if you
forget them. The store handles each; this is what it is doing and why.

| Limit | Value | What the store does |
|---|---|---|
| Max item size | **2 MB** (writes above silently no-op) | Measures the serialized envelope; skips + reports a `cache-write` error above `VERCEL_MAX_ITEM_BYTES`. Large Flight payloads simply go uncached rather than vanishing without a trace. |
| Tags per item | **64** (docs say 64 *or* 128; 64 is the floor) | Clamps to `VERCEL_MAX_TAGS_PER_ITEM` on write, with a warning. Does **not** clamp `invalidateTags` — an invalidation must reach every requested tag. |
| Tag length | **256 bytes**, no commas | Drops over-length or comma-bearing tags (commas are the header delimiter) on both write and invalidate, with a warning. |
| Cross-deploy reconciliation | **none** — TTL/tag updates are not reconciled between deployments | Fold a build id into the key. Use the `version` option (`v/{version}/...` prefix) or, better, the `getCache({ namespace })` argument. Without it, an entry written by a prior deploy with a now-changed shape can be served after a deploy. |
| Storage consistency | **regional** | A write in region A is not visible to a read in region B until B warms. Plan for per-region cold starts; every `get` is best-effort regardless. |

The 2 MB cap is the one most likely to surprise you. On Cloudflare an oversized
entry just fails the KV write; on Vercel the `set` resolves successfully and the
entry is simply never stored. If you see tagged routes that never seem to cache,
check the payload size first — the store will have logged a `cache-write` error,
but only if you wired `onError` or read the console.

### Wiring it into a router

The cache option is a factory so the store can be constructed per request with
the platform's `waitUntil` and a deploy-scoped namespace:

```ts
import { createRouter } from "@rangojs/router";
import { VercelCacheStore } from "@rangojs/router/cache";
import { getCache, waitUntil } from "@vercel/functions";

export const router = createRouter({
  document: Document,
  cache: () => ({
    store: new VercelCacheStore({
      // Bake the deployment id into the namespace so a deploy cannot serve
      // stale-shaped entries (Vercel does not reconcile across deploys).
      cache: getCache({ namespace: process.env.VERCEL_DEPLOYMENT_ID }),
      waitUntil,
      defaults: { ttl: 60, swr: 300 },
    }),
  }),
}).routes(urlpatterns);
```

Contrast with the Cloudflare wiring (`tests/cloudflare-basic/src/router.tsx`),
which threads `env.KV` and `ctx` from the worker `fetch(request, env, ctx)`
signature:

```ts
cache: (env, ctx) => ({
  store: new CFCacheStore({ defaults: { ttl: 60, swr: 300 }, ctx: ctx!, kv: env.KV }),
}),
```

The router-side contract is identical; only where the backend comes from differs.
On Vercel there is no per-request `env`/`ctx` argument — bindings are
`process.env` and `waitUntil` is a module import.

### Observability

Pass `debug: true` to log each read outcome, or `debug: (event) => …` to capture
the structured `VercelCacheReadDebugEvent` (`op`, `key`, `outcome`,
`staleAt`/`expiresAt`, `shouldRevalidate`, `readMs`). Outcomes are
`miss | fresh | stale-revalidate | expired | corrupt | error`. Write failures,
oversized skips, dropped tags, and corrupt-entry evictions all route through
`reportCacheError`, so they reach the router's `onError` as well as the console.

## Deployment: Node serverless via the Build Output API (planned)

The chosen target is a **Node serverless function with response streaming** — the
natural analogue to the Cloudflare worker, and the runtime where `getCache`, full
Node APIs, and `AsyncLocalStorage` (which the router's request context depends on)
all work without constraint. Edge is viable for a thin build but the RSC server
bundle is heavier to fit there and the runtime is constrained; it is a documented
follow-up, not the first target.

Rango apps deploy by writing the Build Output API v3 directory, `.vercel/output/`:

```
.vercel/output/
├── config.json                 # routing: serve static first, fall through to the function
├── static/                     # the Vite client build (browser JS/CSS/assets)
└── functions/
    └── render.func/
        ├── .vc-config.json      # runtime: nodejs, supportsResponseStreaming: true
        └── index.js + manifests # the bundled rsc (+ ssr) environment
```

`config.json` is the framework-less "static first, one function for the rest"
shape:

```json
{
  "version": 3,
  "routes": [
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/render" }
  ]
}
```

`{ "handle": "filesystem" }` serves the hashed client assets in `static/`
directly from the CDN; everything else rewrites to the single RSC/SSR function.

`.vc-config.json` for that function:

```json
{
  "runtime": "nodejs22.x",
  "handler": "index.js",
  "launcherType": "Nodejs",
  "supportsResponseStreaming": true
}
```

`supportsResponseStreaming: true` is non-negotiable for RSC — without it the
function buffers the whole Flight/HTML response instead of streaming it.

The function entry is a thin shim over `router.fetch`, sourcing bindings from the
Vercel runtime rather than a worker signature:

```ts
import { waitUntil } from "@vercel/functions";
import { router } from "./router.js";

export default {
  async fetch(request: Request): Promise<Response> {
    return router.fetch(request, {
      env: process.env as unknown as Env,
      ctx: { waitUntil },
    });
  },
};
```

### The `vercel` preset's job

A rango `preset: "vercel"` (in `packages/rangojs-router/src/vite/`) needs to do
what the Cloudflare preset + `@cloudflare/vite-plugin` do together, minus the
worker specifics:

1. Build the same three Vite environments — **client / ssr / rsc** — that every
   rango preset produces.
2. Emit the **client** build into `.vercel/output/static/`.
3. Bundle the **rsc** environment (with **ssr** as a child, plus the
   `__vite_rsc_assets_manifest`, `__static-manifest`, and `__prerender-manifest`
   modules) into `functions/render.func/` and wrap it in the entry shim above.
4. Write `config.json` and `.vc-config.json`.
5. **Set `define: { "process.env.NODE_ENV": JSON.stringify("production") }` for
   the SSR and RSC builds.** This is Bundle Hygiene rule #2 and it is easy to
   miss: the Cloudflare plugin folds `NODE_ENV` automatically, but vanilla
   `vite build` only folds it for the client environment. If the SSR/RSC builds
   do not fold it, React's CJS keeps *both* its dev and prod branches and the
   server bundle roughly doubles. The bundle guard in
   `e2e/build-test-app.setup.ts` catches a `react*.development*.js` chunk — wire
   the equivalent check for the Vercel output.

### What is *not* a static file

Carry over the prerender principle from [`prerender-api-design.md`](../../packages/rangojs-router/docs/prerender-api-design.md):
pre-rendering is a build-time cache, and the **function** serves every request.
There are no `.html`/`.rsc` files in `static/` that the CDN returns directly — the
prerender and static manifests are bundled *inside* the function, which looks up
the stored Flight payloads at runtime exactly as it would a cache hit. The browser
cannot tell a prerendered route from a cached one. (Vercel's own Prerender
Functions / ISR are a separate CDN-level mechanism; if we ever map Rango's
prerendered routes onto them, that is an additive optimization, not a replacement
for the runtime lookup.)

## Cache-tag mapping caveat (if both cache layers are ever used)

Vercel has two cache layers and they do **not** share tags. The Runtime Cache
(`getCache` / `expireTag`) is what `VercelCacheStore` uses. The CDN/ISR cache is a
separate thing with its own tag API (`addCacheTag` / `invalidateByTag`).
Per Vercel's docs: Runtime Cache tags do not apply to ISR pages, Runtime Cache
TTLs do not affect ISR revalidation, and `expireTag` does not touch the CDN cache.
If a future deployment caches at *both* layers, an invalidation has to fan out to
both APIs — using the same tag string for both does not unify them. For the store
as designed, this is not a concern: it lives entirely in the Runtime Cache layer.

## What ships, what is deferred

Shipped in this pass:

- `VercelCacheStore` + its types, exported from `@rangojs/router/cache`
  (`src/cache/vercel/`).
- This design doc.

Deferred (the follow-up — the "fully tested + shippable" and "deployment" tiers):

- **Userland test coverage** through the `@rangojs/router/testing` primitives
  (`renderHandler` / `dispatch` with a `VercelCacheStore` over a fake
  `VercelRuntimeCache`), plus a white-box unit suite mirroring
  `cf-cache-store.test.ts` — SWR transitions, the 2 MB skip, tag clamping, the
  `invalidateTags` throw-on-failure, corrupt-envelope self-heal.
- **Docs-surface registration**: add the store to
  `packages/rangojs-router/docs/internal/feature-map.md` and
  `feature-file-map.md`, and move "Vercel / other adapters" out of the *Planned*
  section of [`caching.md`](./caching.md).
- **Deployment**: the `vercel` preset, an `examples/vercel-basic` (+
  `tests/vercel-basic`) app, the Build Output emission, and dev+prod e2e coverage.

## Open questions to confirm against the installed `@vercel/functions`

The store was written from the published docs; confirm these against the actual
installed package at implementation time, as they affect edge-case behavior:

1. **`get` miss return type** — docs guard with `if (value)`; confirm a miss
   resolves to `undefined` (the store treats any nullish value as a miss).
2. **Exact tag-per-item limit** — 64 vs 128 across two doc pages; the store uses
   64. Raise `VERCEL_MAX_TAGS_PER_ITEM` if the installed package confirms 128.
3. **Value serialization** — `set` types `value: unknown`. The store's envelopes
   are JSON-safe (response bodies are base64), so this should be fine, but confirm
   the runtime does not require pre-stringified values.
4. **Edge support** — `getCache` is documented for Node and Edge; smoke-test on
   Edge before ever targeting that runtime.
