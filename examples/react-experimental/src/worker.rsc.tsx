/// <reference types="@cloudflare/workers-types" />
import { router } from "./router.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Skip browser metadata requests
    if (
      url.pathname === "/favicon.ico" ||
      url.pathname.startsWith("/.well-known/")
    ) {
      return new Response(null, { status: 404 });
    }

    return router.fetch(request, { Bindings: {}, Variables: {} });
  },
} satisfies ExportedHandler;
