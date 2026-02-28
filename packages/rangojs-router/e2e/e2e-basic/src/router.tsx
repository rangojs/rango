import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

/**
 * Router instance - demonstrates single .routes() call
 *
 * Key changes from rsc-router:
 * - Single .routes(urlpatterns) instead of .routes().map() chain
 * - All route composition via include() in urlpatterns
 * - Route names are defined inline with path()
 */
export const router = createRouter({}).routes(urlpatterns);
