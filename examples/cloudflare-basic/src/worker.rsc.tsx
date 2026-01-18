/// <reference types="@cloudflare/workers-types" />
import { createRSCHandler } from "rsc-router/rsc";
import { CFCacheStore } from "rsc-router/cache";
import { VERSION } from "rsc-router:version";
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
    // VERSION from rsc-router:version changes on server restart, invalidating stale cache
    const cacheStore = new CFCacheStore({
      defaults: { ttl: 60, swr: 300 },
      waitUntil: (fn) => ctx.waitUntil(fn()),
      version: VERSION,
    });

    // Create handler with CF cache store and version for metadata
    const handler = createRSCHandler({
      router,
      cache: { store: cacheStore },
      version: VERSION,
    });

    return handler(request, { Bindings: env, Variables: {} });
  },
} satisfies ExportedHandler<AppBindings>;
