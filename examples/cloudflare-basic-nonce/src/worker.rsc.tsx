/// <reference types="@cloudflare/workers-types" />
import { fetch as rscFetch } from "./router.js";
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

    // Use the handler from router (nonce and CSP handled automatically)
    return rscFetch(request, { Bindings: env, Variables: {} });
  },
} satisfies ExportedHandler<AppBindings>;
