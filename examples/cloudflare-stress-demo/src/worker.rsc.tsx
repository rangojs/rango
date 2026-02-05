/// <reference types="@cloudflare/workers-types" />
import { router } from "./router.js";
import type { AppBindings } from "./env.js";

// Route manifest is now loaded at runtime on first request (if urlpatterns provided)
// This app doesn't use href(), so no manifestCache option is needed

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
