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
    // This enables SWR (stale-while-revalidate) at the edge
    const cacheStore = new CFCacheStore({
      namespace: "rsc-blog-cache",
      defaults: { ttl: 60, swr: 300 },
      waitUntil: (fn) => ctx.waitUntil(fn()),
    });

    // Create handler with CF cache store
    const handler = createRSCHandler({
      router,
      cache: { store: cacheStore },
    });

    return handler(request, { Bindings: env, Variables: {} });
  },
} satisfies ExportedHandler<AppBindings>;
