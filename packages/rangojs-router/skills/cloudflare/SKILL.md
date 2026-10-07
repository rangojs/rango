---
name: cloudflare
description: Deploy and operate @rangojs/router on Cloudflare Workers with the Cloudflare Vite plugin, typed D1/KV bindings, local migrations, secrets, streaming, preview parity, and built-worker deployment. Use when creating a Cloudflare Rango app, moving a Rango app to Workers, wiring D1 or KV, debugging dev/preview differences, or preparing a Worker deployment.
---

# Cloudflare Workers deployment

This skill covers running a Rango app on Cloudflare Workers: Vite and Wrangler
config, the Worker entry, typed bindings, caching, and deployment. The
references cover D1/KV setup, streaming and deploy diagnostics, and webhooks.
For router options in general see `/router-setup`.

Use the Cloudflare Vite plugin as the runtime bridge. It runs the real Worker
entry in workerd during `vite dev` and `vite preview`, supplies bindings, and
emits the deployable Worker configuration during `vite build`. Unlike the Node
and Vercel presets, you own the Worker entry.

## Install and configure

```bash
pnpm add @rangojs/router react react-dom
pnpm add -D vite @cloudflare/vite-plugin @cloudflare/workers-types wrangler typescript
# optional: @vitejs/plugin-react (e.g. for the React Compiler, see /react-compiler)
```

Rango needs Node 24+ for the Vite toolchain. Keep plugin order stable:
`react()` first when you use it, then `rango()`, then `cloudflare()`.

```typescript
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { rango } from "@rangojs/router/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    // react(), // optional; first when used
    rango({ preset: "cloudflare", buildEnv: "auto" }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
```

`viteEnvironment` must name the `rsc` environment with `ssr` as a child: the
Worker runs the RSC entry and loads SSR inside the same isolate.

`buildEnv: "auto"` gives `Prerender` and `Static` handlers a real `ctx.env` at
build time through Wrangler's `getPlatformProxy()` (local bindings), reading
the wrangler config from the Vite root whatever the working directory. Omit it
(default `false`) when build-time rendering must not touch bindings; `ctx.env`
then throws during build rendering. See `/prerender`.

`wrangler.json` points `main` at the Worker entry and serves the client build
as static assets:

```json
{
  "name": "my-rango-app",
  "compatibility_date": "2025-10-01",
  "compatibility_flags": ["nodejs_compat", "nodejs_als"],
  "main": "./src/worker.rsc.tsx",
  "assets": { "directory": "./dist/client" }
}
```

## Type bindings once

```typescript
// src/env.ts
/// <reference types="@cloudflare/workers-types" />

export interface AppBindings {
  DB: D1Database;
  CACHE_KV: KVNamespace;
}

declare global {
  namespace Rango {
    interface Env extends AppBindings {}
  }
}
```

Rango's runtime entries stay as TypeScript source for Vite to bundle, while its
package `types` conditions point to emitted declarations. A Workers-only app
does not need `@types/node` just to type-check Rango:

```json
{
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "vite/client"]
  }
}
```

## Worker entry

Pass both `env` and `ctx` to `router.fetch`. Bindings reach handlers as
`ctx.env`; the `ExecutionContext` backs `waitUntil`, `CFCacheStore`, and
tracing. A bare `export default { fetch: router.fetch }` loses both, because
Workers call `fetch(request, env, ctx)` while `router.fetch` takes
`(request, { env, ctx })`.

```typescript
// src/worker.rsc.tsx
/// <reference types="@cloudflare/workers-types" />
import { router } from "./router.js";
import type { AppBindings } from "./env.js";

export default {
  fetch(request, env, ctx) {
    return router.fetch(request, { env, ctx });
  },
} satisfies ExportedHandler<AppBindings>;
```

Do not call `response.text()` or `response.arrayBuffer()` on the Rango response
in the Worker entry: that buffers the whole body and removes RSC/SSR streaming.
When only headers must change, rewrap the body stream instead
(`new Response(response.body, response)`); see
[references/streaming-and-deploy.md](references/streaming-and-deploy.md).

## Choose the next reference

- D1/KV setup, local migrations, `.dev.vars`, and parity tests: read
  [references/d1-and-local-dev.md](references/d1-and-local-dev.md).
- Streaming diagnostics, preview behavior, CORS, and deploy output: read
  [references/streaming-and-deploy.md](references/streaming-and-deploy.md).
- Raw-body webhooks, WebCrypto, and Stripe-on-Workers notes: read
  [references/webhooks-and-crypto.md](references/webhooks-and-crypto.md).

## Cache on Workers

Use the Cache API as L1 and KV as optional cross-colo L2:

```typescript
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      ctx: ctx!, // typed optional on the factory; always present on Workers
      kv: env.CACHE_KV,
      defaults: { ttl: 60, swr: 300 },
    }),
  }),
});
```

`ctx` is required: the store schedules non-blocking writes with
`ctx.waitUntil`, which is why the Worker entry must pass `{ env, ctx }` to
`router.fetch`.

Tag invalidation (`updateTag()` / `revalidateTag()`) stores its markers in the
same `kv` namespace. Without `kv`, configure purge mode instead:
`tagPurge: { zoneId, apiToken }` (an API token with `Zone.Cache Purge`, stored
as a Worker secret) evicts tagged Cache API entries through Cloudflare's
purge-by-tag API.

PPR shells use the Cache API as the per-colo L1 and KV as the durable
cross-colo L2; a KV hit promotes the shell back into L1. Without `kv` the shell
family runs L1-only (each colo captures and serves its own shell). A tagged
shell with neither `kv` nor `tagPurge` logs a warning once and expires only by
ttl+swr. See `/caching` and `/ppr`.

Shell reads are stale-while-revalidate through per-isolate memos: a warm
isolate serves a shell it read within `memo.shellMs` (default 2000) from
memory, and with `kv` it checks tag markers through a memo that is used as is
for `memo.markerFreshMs` (default 1000) and while it refreshes in the
background up to `memo.markerMaxStaleMs` (default 10000). After
`updateTag()`/`revalidateTag()` the response sets the fresh-reads cookie
(`rango-state-fresh` by default), so the mutating user's next requests skip
the memos. That makes them fresh in the colo that ran the mutation; other
colos converge once KV propagates the marker and their cached marker
(`tagCacheTtl`) expires. In purge mode without `kv`, another isolate's memo
keeps serving a purged shell until `memo.shellMs` passes. Set
`memo: { shellMs: 0, markerFreshMs: 0 }` to remove the memo delay for every
user's next request; cross-colo KV propagation (and `tagCacheTtl`) still
applies. Details: `/caching` → "The fresh-reads cookie".

## On-demand prerender on Workers

A `Prerender(..., { onDemand })` route (`/prerender` → "On-demand refresh")
needs a durable store for its refreshed entries. On Workers that is KV:

```typescript
import { createKVPrerenderStore } from "@rangojs/router/prerender/cloudflare";

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  prerender: (env) => ({
    store: createKVPrerenderStore(env.PRERENDER_KV),
    ttl: 3600, // soft: a stale entry still serves
    // Present = stale-while-revalidate: a stale hit schedules this via waitUntil.
    onRevalidate: (target, liveEnv) => liveEnv.PRERENDER_QUEUE.send({ target }),
  }),
});
```

Add the `PRERENDER_KV` namespace (and the queue, if you use one) to
`wrangler.jsonc` and to `AppBindings`. Refreshes run from the Worker's other
handlers, with the live `env`:

```typescript
export default {
  fetch: (request: Request, env: AppBindings, ctx: ExecutionContext) =>
    router.fetch(request, { env, ctx }),

  // Cron sweep: re-render only what went stale.
  async scheduled(
    _event: ScheduledEvent,
    env: AppBindings,
    ctx: ExecutionContext,
  ) {
    const ids = await env.CMS.listProductIds();
    const prerender = router.prerender({ env, ctx });
    ctx.waitUntil(
      prerender.many(
        ids.map((id) => ({ route: "products.detail", params: { id } })),
        { concurrency: 4, onlyIfStale: true },
      ),
    );
  },

  // Queue consumer: the queue owns dedup across isolates. onlyIfStale: a
  // message can run after another one refreshed the page, or after
  // prerender.remove() removed it; then it renders nothing.
  async queue(
    batch: MessageBatch<{ target: PrerenderTargetObject }>,
    env: AppBindings,
    ctx: ExecutionContext,
  ) {
    const targets = batch.messages.map((m) => m.body.target);
    ctx.waitUntil(
      router
        .prerender({ env, ctx })
        .many(targets, { concurrency: 8, onlyIfStale: true }),
    );
  },
};
```

`PrerenderTargetObject` comes from `@rangojs/router/prerender`. It is what
`onRevalidate` receives, and the `router.prerender({ env, ctx })` runner (and its
`.many()`) accepts it as is on a router typed with named routes. A queue hands it back as JSON, so type the
message body with it (as above) or assert it: `JSON.parse(raw) as
PrerenderTargetObject`.

The KV store writes no `expirationTtl` (entries never expire; `ttl` is soft)
and keys entries by router id and the router's data version, so a deploy that
changes server code starts from the build entries again.
`router.prerender({ env, ctx }).markStale(tags)` writes per-tag markers under
`__rango_pr_tag__/{encoded routerId}/`, a namespace separate from `updateTag()`'s and
scoped to the router that marked (routers sharing one KV namespace do not mark
each other's entries); a read checks one marker per tag on the entry,
uncached, so keep tag counts small. Markers have no expiry (`/prerender` ->
"KV tag markers"). Neither `updateTag()` nor `revalidateTag()` reaches this
store.

## Warm routes on Workers

`router.prerender()` also warms a route that is not on-demand: its `ppr`
shell, `cache()` records, `"use cache"` results and document cache entry are
rewritten before a visitor asks (`/prerender` → "Warm any route before
traffic"). On Workers:

- **`CFCacheStore` needs `kv`.** With KV the store is shared by every colo
  (`scope: "global"`) and a warm is allowed; without it entries live in one
  colo's Cache API and the call returns `skipped-store-not-shared`.
- **Give `scheduled` and `queue` an origin.** Cache keys carry the host, and
  those handlers have no request to take it from:

  ```typescript
  async scheduled(_event: ScheduledEvent, env: AppBindings, ctx: ExecutionContext) {
    const prerender = router.prerender({
      env,
      ctx,
      origin: "https://shop.example",
    });
    ctx.waitUntil(prerender.many(["/", "/products/1"], { onlyIfStale: true }));
  },
  ```

  A webhook route or a server action needs none: the warm uses the origin of
  the request it is called from.

- **A warm fills the colo it runs in, and KV.** Another colo that already
  holds its own Cache API copy keeps serving it until it expires; an L1 hit
  never consults KV. After a deploy no colo holds a copy, so the warm's KV
  entry is what each one reads next. For a content change, invalidate and then
  warm, in this order:

  ```typescript
  await updateTag(`product:${id}`); // no colo serves the old copy any more
  await router.prerender({ env, ctx })(`/products/${id}`); // writes the new one
  ```

  A colo with no copy of its own reads the warmed entry from KV. A colo that
  was still holding the old copy treats it as a miss and renders once for
  itself (it does not read the fresher KV entry). With `tagPurge` the purge
  evicts every colo's copy, so they all read the warmed entry.

- **Entries under 60 seconds stay in one colo.** KV's minimum `expirationTtl`
  is 60 s, so a segment, item or response entry whose `ttl + swr` is shorter
  is written to the Cache API only, and a warm of it reaches the calling colo
  alone. Shells always reach KV.
- **KV writes take time to spread.** Cloudflare documents up to 60 seconds or
  more before a write is visible in other locations; a visitor elsewhere in
  that window renders the page as before.

## Tracing on Workers

`createCloudflareTracing()` from `@rangojs/router/cloudflare` emits the
router's phases as native Workers custom spans next to the automatic KV/D1/fetch
spans. It reads the tracer from the `ctx` passed to `router.fetch`, and does
nothing when Workers tracing is not enabled for the Worker. See
`/observability`.

```typescript
import { createCloudflareTracing } from "@rangojs/router/cloudflare";

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  tracing: createCloudflareTracing(),
});
```

## Commands

```jsonc
{
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "deploy": "wrangler deploy -c dist/rsc/wrangler.json",
  },
}
```

Always deploy the output of `vite build` (`dist/rsc/wrangler.json`; a plain
`wrangler deploy` right after a build follows the plugin's redirect to it),
never the source config. Use `vite dev` and `vite preview` for local RSC work. Reserve
Wrangler for resource provisioning, migrations, secrets, and deployment.
