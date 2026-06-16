---
name: vercel
description: Deploy a Rango app to Vercel Functions (Build Output API v3)
argument-hint:
---

# Vercel deployment

The `vercel` preset builds like the `node` preset (Vercel runs Node Functions, not Workers): rango owns the RSC entry, folds `process.env.NODE_ENV` for the SSR/RSC build, and after `vite build` assembles a `.vercel/output` directory (Build Output API v3) from `dist/` — a single streaming Node Function plus the static client assets.

## Setup

```bash
npm install @vercel/functions
```

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [react(), rango({ preset: "vercel" })],
});
```

`@vercel/functions` is required: it backs the generated function launcher (`waitUntil`) and `VercelCacheStore`. The build fails with a clear error if it is missing.

`vite build` produces `.vercel/output`; deploy with the Vercel CLI (`vercel deploy --prebuilt`) or via Git integration.

## Function configuration

Per-function knobs go under `vercel` and are written into `.vc-config.json`:

```typescript
rango({
  preset: "vercel",
  vercel: {
    runtime: "nodejs22.x", // default
    maxDuration: 30, // seconds, default
    memory: 1024, // MB (platform default when omitted)
    regions: ["fra1"], // pin regions (platform default when omitted)
    functionName: "index", // the <name>.func dir + config.json route
  },
});
```

## Runtime Cache

`VercelCacheStore` wraps the Vercel Runtime Cache. Locally (no `process.env.VERCEL`) fall back to an in-memory store so dev/preview work without the platform:

```typescript
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

The cache factory receives `(env, ctx)`; on Vercel `env` is `process.env` and `ctx` is `{ waitUntil }`.

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

`{ env, ctx }` is threaded unchanged from the function to each matched sub-app's handler and its `cache(env, ctx)` factory. See the `host-router` skill for sub-app structure and routing patterns.

## Local validation without deploying

`vite preview` serves the node build for a quick check. For a faithful test of the assembled `.vercel/output` (isolated filesystem, ESM, self-contained bundle), import `functions/index.func/index.mjs` and serve it behind filesystem-then-function routing — see `examples/vercel-basic/scripts/smoke.mjs`.
