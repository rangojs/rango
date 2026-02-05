import { createRouter } from "@rangojs/router/server";
import { CFCacheStore } from "@rangojs/router/cache";
import { urlpatterns } from "./urls.js";
import { Document } from "./document.js";
import type { AppEnv } from "./env.js";

export const router = createRouter<AppEnv>({
  document: Document,
  debugPerformance: true, // Enable Server-Timing headers
  // CF cache store for segment caching
  cache: (env) => ({
    store: new CFCacheStore({ ctx: env.ctx! }),
  }),
  onError: (error) => {
    // Log errors to console (can be extended to use external logging services)
    console.error("Router error:", error);
  },
}).routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const href = router.href;
