/// <reference types="@cloudflare/workers-types" />
import { createHostRouter } from "@rangojs/router/host";
import type { AppBindings } from "./env.js";

// Dev and preview workflow: the `x-rango-host` cookie picks the app to serve
// from the one localhost origin (e.g. `admin.localhost` for the admin app).
// The request is forwarded unchanged, so the picked app answers under the
// same host and path as the site app.
const hostRouter = createHostRouter({
  hostOverride: { cookieName: "x-rango-host", allowedHosts: ["localhost"] },
});

// Admin sub-app on admin.localhost (must be registered before the catch-all)
hostRouter.host(["*.localhost"]).lazy(() => import("./apps/admin/handler.js"));

// Path-mounted sub-apps on localhost/app-a and localhost/app-b
hostRouter
  .host(["localhost/app-a"])
  .lazy(() => import("./apps/app-a/handler.js"));
hostRouter
  .host(["localhost/app-b"])
  .lazy(() => import("./apps/app-b/handler.js"));

// Site sub-app on localhost (catch-all for remaining paths)
hostRouter.host(["localhost"]).lazy(() => import("./apps/site/handler.js"));

// Fallback to site app for unmatched hosts
hostRouter.fallback().lazy(() => import("./apps/site/handler.js"));

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
