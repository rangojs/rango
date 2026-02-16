/// <reference types="@cloudflare/workers-types" />
import { createHostRouter } from "@rangojs/router/host";
import type { AppBindings } from "./env.js";

const hostRouter = createHostRouter();

// Admin sub-app on admin.localhost (must be registered before the catch-all)
hostRouter.host(["*.localhost"]).map(() => import("./apps/admin/handler.js"));

// Site sub-app on localhost
hostRouter.host(["localhost"]).map(() => import("./apps/site/handler.js"));

// Fallback to site app for unmatched hosts
hostRouter.fallback().map(() => import("./apps/site/handler.js"));

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

    return hostRouter.match(request, { Bindings: env, Variables: {}, ctx });
  },
} satisfies ExportedHandler<AppBindings>;
