import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
import { Document } from "./components/Document.js";
import type { AppEnv } from "./env.js";

export const router = createRouter<AppEnv>({
  document: Document,
  // Test hook: the view-transition-optout e2e builds the app with
  // VITE_RANGO_VT=false to exercise the global createRouter({ viewTransition })
  // default end to end (createRouter -> segment resolution -> client gate).
  // Defaults to "auto" so every other test sees unchanged behavior.
  viewTransition: import.meta.env.VITE_RANGO_VT === "false" ? false : "auto",
}).routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const reverse = router.reverse;
