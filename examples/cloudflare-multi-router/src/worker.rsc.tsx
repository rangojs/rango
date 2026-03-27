/// <reference types="@cloudflare/workers-types" />
import { createHostRouter } from "@rangojs/router/host";
import type { AppBindings } from "./env.js";

const hostRouter = createHostRouter();

// Admin sub-app on admin.localhost (must be registered before the catch-all)
hostRouter.host(["*.localhost"]).map(() => import("./apps/admin/handler.js"));

// Path-mounted sub-apps on localhost/app-a and localhost/app-b
hostRouter
  .host(["localhost/app-a"])
  .map(() => import("./apps/app-a/handler.js"));
hostRouter
  .host(["localhost/app-b"])
  .map(() => import("./apps/app-b/handler.js"));

// Site sub-app on localhost (catch-all for remaining paths)
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

    return hostRouter.match(request, { env, ctx });
  },
} satisfies ExportedHandler<AppBindings>;
