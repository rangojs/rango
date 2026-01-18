/// <reference types="@cloudflare/workers-types" />
import { createRSCHandler } from "rsc-router/rsc";
import { CFCacheStore } from "rsc-router/cache";
import { router } from "./router.js";
import type { AppBindings } from "./env.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Skip browser metadata requests
    if (
      url.pathname === "/favicon.ico" ||
      url.pathname.startsWith("/.well-known/")
    ) {
      return new Response(null, { status: 404 });
    }

    // Create CF cache store with waitUntil for non-blocking writes
    // Uses caches.default by default, SWR enabled at the edge
    // VERSION is auto-imported, changes on server restart to invalidate stale cache
    const cacheStore = new CFCacheStore({
      defaults: { ttl: 60, swr: 300 },
      waitUntil: (fn) => ctx.waitUntil(fn()),
    });

    // Create handler with CF cache store (version is auto-set from rsc-router:version)
    const handler = createRSCHandler({
      router,
      cache: { store: cacheStore },
    });

    return handler(request, { Bindings: env, Variables: {} });
  },
} satisfies ExportedHandler<AppBindings>;
