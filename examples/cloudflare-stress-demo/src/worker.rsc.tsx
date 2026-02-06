/// <reference types="@cloudflare/workers-types" />
import { router } from "./router.js";
import type { AppBindings } from "./env.js";

// Pre-generated route manifest: eliminates ~98ms first-request cost of
// evaluating lazy includes. Generated at build time by the discovery plugin.
import "virtual:rsc-router/routes-manifest";

export default {
  async fetch(request, env, ctx) {
    const requestStart = performance.now();
    const dateStart = Date.now();
    const url = new URL(request.url);

    // Skip browser metadata requests
    if (
      url.pathname === "/favicon.ico" ||
      url.pathname.startsWith("/.well-known/")
    ) {
      return new Response(null, { status: 404 });
    }

    return router.fetch(request, {
      Bindings: env,
      Variables: { requestStart, dateStart },
      ctx,
    });
  },
} satisfies ExportedHandler<AppBindings>;
