---
name: cloudflare
description: Deploy and operate @rangojs/router on Cloudflare Workers with the Cloudflare Vite plugin, typed D1/KV bindings, local migrations, secrets, streaming, preview parity, and built-worker deployment. Use when creating a Cloudflare Rango app, moving a Rango app to Workers, wiring D1 or KV, debugging dev/preview differences, or preparing a Worker deployment.
---

# Cloudflare Workers deployment

Use the Cloudflare Vite plugin as the runtime bridge. It runs the real Worker
entry in workerd during `vite dev` and `vite preview`, supplies bindings, and
emits the deployable Worker configuration during `vite build`.

## Install and configure

```bash
pnpm add @rangojs/router react react-dom
pnpm add -D vite @vitejs/plugin-react @cloudflare/vite-plugin \
  @cloudflare/workers-types wrangler typescript
```

Keep plugin order stable: React first, then Rango, then Cloudflare.

```typescript
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    rango({ preset: "cloudflare", buildEnv: "auto" }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
```

`buildEnv: "auto"` exposes build-safe bindings to static/prerender collection.
Omit it when build rendering must not access bindings.

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

## Preserve the response stream

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
in a custom Worker entry. That drains RSC/SSR streaming. Rewrap
`new Response(response.body, response)` when only headers must change.

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
import { CFCacheStore } from "@rangojs/router/cache";

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      ctx,
      kv: env.CACHE_KV,
      defaults: { ttl: 60, swr: 300 },
    }),
  }),
});
```

PPR shells use Cache API as the per-colo L1 and KV as the durable cross-colo
L2; a KV hit promotes the coupled shell envelope back into L1. KV is optional:
`CFCacheStore` without `kv` runs the shell family L1-only (edge-only ppr —
each colo captures and serves its own shell). Tag eviction then needs purge
mode (`tagPurge`); a tagged shell without either warns once and expires by
ttl+swr only.

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

Use `vite dev` and `vite preview` for local RSC work. Reserve Wrangler for
resource provisioning, migrations, secrets, and deployment.
