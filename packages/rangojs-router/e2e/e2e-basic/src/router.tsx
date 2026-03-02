import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const router = createRouter({}).routes(urlpatterns);
