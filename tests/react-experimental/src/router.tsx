import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
import { Document } from "./components/Document.js";
import type { AppEnv } from "./env.js";

export const router = createRouter<AppEnv>({
  document: Document,
}).routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const reverse = router.reverse;
