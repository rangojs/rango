/// <reference types="@cloudflare/workers-types" />
import { createHostRouter } from "@rangojs/router/host";

// The e2e picks the app with the host-override cookie on one localhost origin.
const hostRouter = createHostRouter({
  hostOverride: { cookieName: "x-rango-host", allowedHosts: ["localhost"] },
});
hostRouter.host(["a.localhost"]).lazy(() => import("./apps/a/handler.js"));
hostRouter.host(["b.localhost"]).lazy(() => import("./apps/b/handler.js"));

export default {
  async fetch(request, env, ctx) {
    try {
      return await hostRouter.match(request, { env, ctx });
    } catch (error) {
      // No host cookie (a browser's favicon probe, the readiness poll's first
      // hit): nothing to route to.
      if ((error as Error)?.name === "NoRouteMatchError") {
        return new Response("Not Found", { status: 404 });
      }
      throw error;
    }
  },
} satisfies ExportedHandler<{ KV: KVNamespace }>;
