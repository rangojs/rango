import { createRouter, type RouterEnv } from "@rangojs/router/server";
import { urlpatterns } from "./urls.js";

/**
 * App environment type
 */
export type AppEnv = RouterEnv<{}, {}>;

declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
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
export const router = createRouter<AppEnv>({})
  .routes(urlpatterns);

