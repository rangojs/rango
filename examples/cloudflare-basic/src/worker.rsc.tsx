/// <reference types="@cloudflare/workers-types" />
import { createRSCHandler } from "rsc-router/rsc";
import { router } from "./router.js";
import type { AppBindings } from "./env.js";

const handler = createRSCHandler({ router });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Skip browser metadata requests
    if (
      url.pathname === "/favicon.ico" ||
      url.pathname.startsWith("/.well-known/")
    ) {
      return new Response(null, { status: 404 });
    }

    return handler(request, { Bindings: env, Variables: {} });
  },
} satisfies ExportedHandler<AppBindings>;
