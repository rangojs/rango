/// <reference types="@cloudflare/workers-types" />
import { router } from "./router.js";
import type { AppBindings } from "./env.js";

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
