/// <reference types="@cloudflare/workers-types" />
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

    // Use router.fetch directly - cache is configured in router with ctx from env
    return router.fetch(request, { Bindings: env, Variables: {}, ctx });
  },
} satisfies ExportedHandler<AppBindings>;
