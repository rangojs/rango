import { createRSCRouter } from "rsc-router/server";
import { homeRoutes, aboutRoutes, counterRoutes } from "./routes.js";
import { AppShell } from "./components/AppShell.js";
import type { AppEnv } from "./env.js";

// Create the router with document component
// AppShell wraps both route content and error boundaries,
// preventing the app shell from unmounting during errors (avoids FOUC)
export const router = createRSCRouter<AppEnv>({
  document: AppShell,
});

// Register routes with lazy-loaded handlers
router
  .routes(homeRoutes)
  .map(() => import("./handlers/home.js"))

  .routes(aboutRoutes)
  .map(() => import("./handlers/about.js"))

  .routes(counterRoutes)
  .map(() => import("./handlers/counter.js"));

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}
