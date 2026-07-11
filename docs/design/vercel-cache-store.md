# Vercel cache store and deployment

If you are about to add Vercel support to Rango — a production cache backend, a
deployment target, or both — start here. This doc explains why Vercel's Runtime
Cache is a near-perfect fit for the `SegmentCacheStore` contract, how
`VercelCacheStore` maps onto it, and what a Node-serverless deployment via the
Build Output API looks like. It is the sibling of [`caching.md`](./caching.md)
(the segment-cache design) and [`cache-tags-flow.md`](./cache-tags-flow.md) (the
tag-invalidation flow); read those first if you have not.

Status: both shipped. The **store** (`VercelCacheStore`) is exported from
`@rangojs/router/cache`. The **deployment** is the first-class
**`rango({ preset: "vercel" })`** preset (`src/vite/rango.ts` +
`src/vite/plugins/vercel-output.ts`), used by `examples/vercel-basic` and locally
verified. See "What ships, what is deferred" at the end.

## Why the Runtime Cache is the right backend, and why this store is small

A fair first reaction to "we need a Vercel store" is to expect another
`CFCacheStore` — three thousand lines of L1/L2 tiering, KV tag markers, marker
memoization, per-tier timeout budgets. It is not. `CFCacheStore` is large because
Cloudflare hands you raw primitives — a per-colo Cache API and a global KV — and
you build a distributed, tag-aware cache out of them yourself. Vercel's Runtime
Cache already _is_ that cache.

`getCache()` from `@vercel/functions` returns a handle with exactly the four
operations the store needs:

```ts
interface RuntimeCache {
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: unknown,
    options?: { ttl?: number; tags?: string[]; name?: string },
  ): Promise<void>;
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

The store exists to supply the three things the raw primitive does _not_ give us.
The rest of this doc is mostly those three.

## The store: `VercelCacheStore`

Source: `packages/rangojs-router/src/cache/vercel/vercel-cache-store.ts`. Public
import path: `@rangojs/router/cache` (no dedicated subpath — same as
`CFCacheStore`; the deep `@rangojs/router/cache/vercel` path is intentionally not
exported).

### What it implements

It implements the full `SegmentCacheStore` surface (`src/cache/types.ts`):

| Method                        | Backed by                                | Notes                                                 |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `get` / `set` / `delete`      | `getCache().get/set/delete` (family `s`) | Segment-tree cache, the `cache()` DSL.                |
| `getItem` / `setItem`         | same (family `i`)                        | `"use cache"` function results.                       |
| `getResponse` / `putResponse` | same (family `r`)                        | Whole-`Response` document cache; body base64-encoded. |
| `invalidateTags`              | `getCache().expireTag`                   | One call per invalidation batch.                      |
| `defaults` / `keyGenerator`   | config passthrough                       | ttl/swr inheritance and key segmentation.             |

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
  set(
    key: string,
    value: unknown,
    options?: { ttl?: number; tags?: string[]; name?: string },
  ): Promise<void>;
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
contract makes the _store_ responsible for it: `get` returns
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

When `get` sees a stale entry, it tries to claim a short-lived companion key
(`{entryKey}:lock`). Only the claimant receives `shouldRevalidate: true`; other
readers keep serving the stale payload without scheduling duplicate work. The
payload envelope is never rewritten merely to dampen the herd, so a read cannot
push its hard expiry forward. `getCache` has no compare-and-set and storage is
regional, so two readers can still claim concurrently; duplicated revalidation
is a cost overrun, not a stale-serving correctness bug. Lock writes use
`waitUntil` when provided.

### Tags: `expireTag` plus generation markers

`set({ tags })` registers ordinary runtime entries and `expireTag` physically
expires them. PPR adds one case deletion alone cannot cover: a shell capture can
start before invalidation and finish after `expireTag`, and a build shell lives
outside Runtime Cache. The store therefore also writes a one-year `tm` marker
per invalidated tag and compares shell generations against it:

- write path: pass the entry's tags straight to `cache.set(key, value, { tags })`.
- invalidate path: write all `tm` markers first, then
  `invalidateTags(tags)` → `cache.expireTag(tags)`, one call for the batch.
- shell path: reject a write whose capture generation predates a marker, and
  repeat the marker check on read to cover the check-to-write race.

Markers use the same Runtime Cache handle, not a companion store. Tagged shell
retention is capped at the marker lifetime so an invalidated shell cannot become
visible after its marker expires. Tags still ride read results so a hit
contributes them to the document tag union.

One narrow race remains because Runtime Cache is regional, ephemeral, and
LRU-evicted: memory pressure can evict a tag marker before its one-year TTL while
a capture that started before invalidation is still running. If that capture
then writes, neither the write barrier nor the read check can observe the missing
marker. The retention clamp closes TTL expiry, not non-TTL platform eviction.
Runtime Cache exposes no durable marker tier or compare-and-set primitive, so
this seconds-wide window is a platform limit rather than something the store can
close locally.

`invalidateTags` is also the **one method that is allowed to throw**. Every other
read/write degrades silently-but-loudly (reported via `reportCacheError`, never
thrown — a cache is best-effort). But a failed `expireTag` must reject, so that an
awaited `updateTag()` in a server action surfaces the failure instead of
reporting a false success. That is the read-your-own-writes honesty rule from
`cache-error.ts`; honor it.

### The platform guardrails that bite

These are the limits that will silently cost you correctness or capacity if you
forget them. The store handles each; this is what it is doing and why.

| Limit                       | Value                                                             | What the store does                                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Max item size               | **2 MB** (writes above silently no-op)                            | Measures the serialized envelope; skips + reports a `cache-write` error above `VERCEL_MAX_ITEM_BYTES`. Large Flight payloads simply go uncached rather than vanishing without a trace.                                                      |
| Tags per item               | **128**                                                           | Clamps to `VERCEL_MAX_TAGS_PER_ITEM` on write, with a warning. Does **not** clamp `invalidateTags` — an invalidation must reach every requested tag.                                                                                        |
| Tag length                  | **256 bytes**, no commas                                          | Drops over-length or comma-bearing tags (commas are the header delimiter) on both write and invalidate, with a warning.                                                                                                                     |
| Cross-deploy reconciliation | **none** — TTL/tag updates are not reconciled between deployments | Fold a build id into the key. Use the `version` option (`v/{version}/...` prefix) or, better, the `getCache({ namespace })` argument. Without it, an entry written by a prior deploy with a now-changed shape can be served after a deploy. |
| Storage consistency         | **regional**                                                      | A write in region A is not visible to a read in region B until B warms. Plan for per-region cold starts; every `get` is best-effort regardless.                                                                                             |

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

## Deployment: Node serverless via the Build Output API (shipped)

This is implemented as `rango({ preset: "vercel" })`
(`src/vite/plugins/vercel-output.ts`): a plain `vite build` assembles the
`.vercel/output` described below. The rest of this section is the design it
realizes.

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
        └── index.js + manifests # bundled rsc/ssr, prerender, and PPR shell manifests
```

`config.json` is the framework-less "static first, one function for the rest"
shape:

```json
{
  "version": 3,
  "routes": [{ "handle": "filesystem" }, { "src": "/(.*)", "dest": "/render" }]
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
   do not fold it, React's CJS keeps _both_ its dev and prod branches and the
   server bundle roughly doubles. The bundle guard in
   `e2e/build-test-app.setup.ts` catches a `react*.development*.js` chunk — wire
   the equivalent check for the Vercel output.

### Two things that make the function actually run on Vercel (scar tissue)

Both of these were caught only by deploying (and then by the isolated smoke
test) — a local in-place run is masked by the app's own `package.json` and
`node_modules` up the directory tree, so it passes while the deployed,
filesystem-isolated function fails.

1. **The rsc/ssr builds must be fully bundled.** The node preset _externalizes_
   `node_modules` deps (the Vite SSR default), which is fine under `vite preview`
   where `node_modules` exists, but leaves bare imports (`@vercel/functions`,
   `react-dom/server.edge`, `@rangojs/router`, …) that a prebuilt function — which
   gets no `npm install` — cannot resolve. The vercel preset sets
   `resolve.noExternal: true` on the rsc and ssr environments so every dependency
   is inlined (the same self-containment the Cloudflare worker has). `node:`
   builtins stay external (available on Vercel); `ws`'s optional native deps
   (`bufferutil`/`utf-8-validate`) are guarded `require`s that fall back to pure
   JS and are never hit on the HTTP path.
2. **The function needs `package.json` `{ "type": "module" }`.** The rsc/ssr
   bundles are ESM but use a `.js` extension. The handler is `.mjs` (always ESM),
   but when it imports `./rsc/index.js`, Node decides that file's module type from
   the nearest `package.json` — and the deployed function has none in scope, so
   `.js` defaults to CommonJS and the first `import` throws
   `SyntaxError: Cannot use import statement outside a module`. The emitter writes
   a `package.json` `{ "type": "module" }` into the `.func` dir to mark the whole
   function ESM. (Nitro sidesteps this by bundling everything into one `index.mjs`;
   we keep the multi-file rsc/ssr layout, so the marker is required.)

The `examples/vercel-basic` smoke test (`scripts/smoke.mjs`) copies
`.vercel/output` to an OS temp dir **outside** the monorepo before serving it, so
it reproduces the isolated function filesystem and catches both regressions.

### What is _not_ a static file

Carry over the prerender principle from [`prerender-api-design.md`](../../packages/rangojs-router/docs/prerender-api-design.md):
pre-rendering is a build-time cache, and the **function** serves every request.
There are no `.html`/`.rsc` files in `static/` that the CDN returns directly — the
prerender and static manifests are bundled _inside_ the function, which looks up
the stored Flight payloads at runtime exactly as it would a cache hit. The browser
cannot tell a prerendered route from a cached one. (Vercel's own Prerender
Functions / ISR are a separate CDN-level mechanism.) `Prerender + ppr` build
shells follow the same rule: `__ps-*.js` assets and `__shell-manifest.js` live in
the function bundle, and the first function request serves them through the
normal middleware-before-shell path.

The preset does not map these entries onto Vercel's CDN-stitched response
`chain`. Although Vercel's open-source Build Output parser accepts generic
`chain` metadata, a CDN-first shell would be committed before Rango's global and
route middleware can authorize, redirect, set headers, or call `ctx.dynamic()`.
That violates the shipped request contract. See
`packages/rangojs-router/docs/design/vercel-chain-ppr.md` and
`packages/rangojs-router/skills/deployment-caching/SKILL.md`.

Fully public, completely shared responses can independently use HTTP
`s-maxage`/`stale-while-revalidate` at the Vercel CDN. That caches the completed
response, not only the PPR shell, and CDN hits bypass the function and every
Rango middleware.

## Cache-tag mapping caveat (if both cache layers are ever used)

Vercel has two cache layers and they do **not** share tags. The Runtime Cache
(`getCache` / `expireTag`) is what `VercelCacheStore` uses. The CDN/ISR cache is a
separate thing with its own tag API (`addCacheTag` / `invalidateByTag`).
Per Vercel's docs: Runtime Cache tags do not apply to ISR pages, Runtime Cache
TTLs do not affect ISR revalidation, and `expireTag` does not touch the CDN cache.
If a future deployment caches at _both_ layers, an invalidation has to fan out to
both APIs — using the same tag string for both does not unify them. For the store
as designed, this is not a concern: it lives entirely in the Runtime Cache layer.

## What ships, what is deferred

Shipped:

- `VercelCacheStore` + its types, exported from `@rangojs/router/cache`
  (`src/cache/vercel/`).
- A white-box unit suite (`src/cache/vercel/__tests__/vercel-cache-store.test.ts`)
  over a fake `VercelRuntimeCache`: SWR fresh/stale/expired transitions, the
  companion-lock herd dampening, tag invalidation + the `invalidateTags`
  throw-on-failure, comma/over-length tag drop, the 128-tag clamp, the 2 MB
  skip, Set-Cookie stripping, version keyspace isolation, family non-collision.
- The first-class **`rango({ preset: "vercel" })`** preset: `src/vite/rango.ts`
  (the `else`/node-like branch with NODE_ENV folding + banner) plus
  `src/vite/plugins/vercel-output.ts` (the `buildApp`-hook emitter — `buildApp`
  runs once after all environments build, unlike `closeBundle` which fires
  per-env and twice for ssr). `RangoVercelOptions` / `VercelPresetOptions` are
  exported from `@rangojs/router/vite`. `srvx` is a router dependency;
  `@vercel/functions` is an optional peer; esbuild is resolved from the app's
  Vite install (no new heavy router dep).
- **`examples/vercel-basic`**: a Rango app on `preset: "vercel"`;
  `scripts/smoke.mjs` serves the assembled function over `node:http` and asserts
  rendering + static serving + a segment-cache hit, without deploying.
- This design doc.

Deferred (the follow-up):

- **Real-Vercel e2e**: a `tests/vercel-basic` dev+prod suite, plus confirming
  `getCache`/`expireTag`/`waitUntil` runtime behavior and streaming under the
  actual Node launcher on a live deployment.

Already done (no longer deferred):

- **Userland test coverage** via `dispatch` + `VercelCacheStore`
  (`src/testing/__tests__/dispatch-vercel-cache-store.test.ts`).
- **Docs-surface registration**: `VercelCacheStore` is listed in
  `packages/rangojs-router/docs/internal/feature-map.md` (`./cache` row) and
  production backends are marked completed in [`caching.md`](./caching.md).

## Open questions to confirm against the installed `@vercel/functions`

The store was written from the published docs; confirm these against the actual
installed package at implementation time, as they affect edge-case behavior:

1. **`get` miss return type** — docs guard with `if (value)`; confirm a miss
   resolves to `undefined` (the store treats any nullish value as a miss).
2. **Exact tag-per-item limit** — 64 vs 128 across two doc pages; the store uses 64. Raise `VERCEL_MAX_TAGS_PER_ITEM` if the installed package confirms 128.
3. **Value serialization** — `set` types `value: unknown`. The store's envelopes
   are JSON-safe (response bodies are base64), so this should be fine, but confirm
   the runtime does not require pre-stringified values.
4. **Edge support** — `getCache` is documented for Node and Edge; smoke-test on
   Edge before ever targeting that runtime.
