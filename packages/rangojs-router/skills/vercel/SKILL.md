---
name: vercel
description: Deploy a Rango app to Vercel Functions (Build Output API v3). Use when deploying a Rango app to Vercel, or asking how the router works with Vercel Functions and the Build Output API.
argument-hint:
---

# Vercel deployment

This skill covers deploying a Rango app to Vercel Functions: the `vercel`
preset, function settings, the Runtime Cache store, host routers, tracing, and
local validation. For router options in general see `/router-setup`.

The `vercel` preset builds like the `node` preset (Vercel runs Node Functions, not Workers): rango owns the RSC entry (it imports the named `router` export of your `createRouter()` module), folds `process.env.NODE_ENV` for the SSR/RSC build, and after `vite build` assembles a `.vercel/output` directory (Build Output API v3) from `dist/`: a single streaming Node Function plus the static client assets.

## Deployment boundary

Only client JS, CSS, and public assets are emitted under
`.vercel/output/static`. HTML, Flight, prerender payloads, and PPR shells are
served from the streaming Node Function. `VercelCacheStore` is an in-function
Runtime Cache backend; it is separate from Vercel's CDN/ISR cache.

The preset does not emit `.prerender-config.json`, a response `chain`, or a
CDN-stitched PPR resume function. Rango PPR intentionally runs the whole global
and route middleware chain before committing shell bytes. A CDN-first shell
cannot preserve that contract because the resume function is invoked after the
shell starts streaming.

For fully public responses, HTTP `s-maxage`/`stale-while-revalidate` can cache
the completed response at Vercel's CDN and avoid the function on a hit. That is
whole-response caching: it freezes loader output and bypasses all Rango
middleware. Use `/deployment-caching` for the execution matrix and safety
checklist before adding shared-cache headers.

## Setup

```bash
pnpm add @vercel/functions
```

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [rango({ preset: "vercel" })], // add react() first if you use @vitejs/plugin-react
});
```

`@vercel/functions` is required: it backs the generated function launcher (`waitUntil`) and `VercelCacheStore`. The build fails with a clear error if it is missing.

`vite build` produces `.vercel/output`; deploy with the Vercel CLI (`vercel deploy --prebuilt`) or via Git integration. The generated routing serves files first (hashed assets under the assets directory get `Cache-Control: public, max-age=31536000, immutable`) and sends everything else to the function.

## Function configuration

Per-function knobs go under `vercel` and are written into `.vc-config.json`
(`functionName` also sets the `config.json` route):

```typescript
rango({
  preset: "vercel",
  vercel: {
    runtime: "nodejs24.x", // default
    maxDuration: 30, // seconds, default
    memory: 1024, // MB (platform default when omitted)
    regions: ["fra1"], // pin regions (platform default when omitted)
    functionName: "index", // the <name>.func dir + config.json route (default)
  },
});
```

`runtime` must be a `nodejs*` runtime. The preset emits a Node serverless
function, so the build fails on any other value; the Edge runtime is not
supported.

## Runtime Cache

`VercelCacheStore` wraps the Vercel Runtime Cache for segment, item, response,
and PPR shell families. Locally (no `process.env.VERCEL`) fall back to an
in-memory store so dev/preview work without the platform:

```typescript
import { createRouter } from "@rangojs/router";
import {
  MemorySegmentCacheStore,
  VercelCacheStore,
} from "@rangojs/router/cache";
import { getCache, waitUntil } from "@vercel/functions";

const defaults = { ttl: 60, swr: 300 };
const memoryStore = new MemorySegmentCacheStore({ defaults });

function resolveCache() {
  if (process.env.VERCEL) {
    return {
      store: new VercelCacheStore({
        cache: getCache({ namespace: process.env.VERCEL_DEPLOYMENT_ID }),
        waitUntil,
        defaults,
      }),
    };
  }
  return { store: memoryStore };
}

export const router = createRouter({ cache: resolveCache }).routes(/* ... */);
```

The cache factory receives `(env, ctx)`: on Vercel `env` is `process.env` and `ctx` is `{ waitUntil }`; off-platform `ctx` is `undefined`. Cache semantics and tag invalidation: `/caching`, `/cache-guide`.

## Host routers (multi-app)

A multi-app host router deploys as a **single function** running `hostRouter.match()` for every request (mirrors the Cloudflare single-worker model). Two requirements:

1. The host module exports the `HostRouter` **instance** (default export, or a named `hostRouter`/`router` export) — not a Cloudflare-style `{ fetch }` object, because rango owns the entry and calls `match()` for you.
2. Point at the host entry (a host app has several `createRouter()` sub-apps, so auto-discovery can't pick one). rango auto-detects a lone `createHostRouter()` file; set `hostRouter` to be explicit:

```typescript
rango({ preset: "vercel", hostRouter: "./src/worker.rsc.tsx" });
```

```typescript
// src/worker.rsc.tsx
import { createHostRouter } from "@rangojs/router/host";

export const hostRouter = createHostRouter();
hostRouter.host(["admin.*"]).lazy(() => import("./apps/admin/handler.js"));
hostRouter.host(["."]).lazy(() => import("./apps/site/handler.js"));

export default hostRouter; // the instance
```

`{ env, ctx }` is threaded unchanged from the function to each matched sub-app's handler and its `cache(env, ctx)` factory. See `/host-router` for sub-app structure and routing patterns.

## Tracing (custom spans)

Vercel exposes tracing through OpenTelemetry. `createVercelTracing()` (from `@rangojs/router/vercel`) emits the router's `rango.*` phase spans onto the global OTel tracer that `@vercel/otel`'s `registerOTel()` installs:

```typescript
// instrumentation.ts — install the provider, then export the tracing config so
// importing this module is what runs registerOTel(). A Rango/Vite app does NOT
// auto-load `instrumentation.ts` like Next.js does, so a standalone
// registerOTel() that nothing imports is a silent no-op.
import { registerOTel } from "@vercel/otel";
import { createVercelTracing } from "@rangojs/router/vercel";
registerOTel({ serviceName: "my-app" });
export const tracing = createVercelTracing();

// router.tsx — importing `tracing` runs instrumentation.ts (and registerOTel)
import { createRouter } from "@rangojs/router";
import { tracing } from "./instrumentation.js";
export const router = createRouter({ tracing }).routes(/* ... */);
```

`createVercelTracing(opts?)` takes `{ enabled, spans, tracerName, tracer }` (`tracerName` defaults to `"rango"`; `tracer` overrides the global tracer) and emits the same phases as `createCloudflareTracing`: `rango.request`, `rango.middleware`, `rango.action`, `rango.loader`, `rango.handler`, `rango.render`, `rango.ssr`, `rango.response`, and `rango.background`. Caveats: Node-runtime only (Vercel custom spans are unsupported on Edge); `registerOTel()` must run before the first request; `@vercel/otel` is what unlocks Vercel Session Tracing + Trace Drains. The deploy bundles `@vercel/otel` and its `@opentelemetry/*` peers into the function (no `node_modules` at runtime), so they must be installed. The Rango repository's `examples/vercel-basic` (not shipped in this package) has a worked setup; `/observability` covers the cross-platform tracing model.

## Local validation without deploying

`vite preview` does not run the assembled function. To exercise it locally, serve `.vercel/output` with filesystem-then-function routing (static files first, everything else to `functions/<name>.func/index.mjs`). The Rango repository's `examples/vercel-basic` (not shipped in this package) has two scripts for this: `scripts/preview.mjs` (`pnpm preview:vercel`) serves it in place, and `scripts/smoke.mjs` copies it to a temp dir outside the repo for a faithful deploy test (isolated filesystem, ESM, self-contained bundle). Both share `scripts/serve-vercel-output.mjs`.
