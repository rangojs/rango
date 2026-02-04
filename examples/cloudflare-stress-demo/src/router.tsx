import { createRouter } from "@rangojs/router/server";
import { urlpatterns } from "./urls.js";
import { Document } from "./document.js";
import type { AppEnv } from "./env.js";

export const router = createRouter<AppEnv>({
  document: Document,
  debugPerformance: true, // Enable Server-Timing headers
}).routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const href = router.href;
